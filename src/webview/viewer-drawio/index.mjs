/**
 * viewer-drawio/index.mjs — drawio viewer（MOD-DrawioModule / FR-DIO-01..09）
 *
 * sprint 20261009-130815-file-viewer-drawio / ADRL-0135 / design/system/drawio-viewer.md §4・§7。
 * draw.io 公式の描画ライブラリを隔離 iframe（blob 文書・sandbox="allow-scripts" のみ）の中で実行する。
 * - ライブラリ 2 本は親が fetch して nonce 付き inline script として埋め込む（S2。webview 寿命内で 1 回だけ取得）
 * - 通信は MessageChannel のみ（iframe → 親 window の postMessage は "null" origin 拒否で届かない — ADRL-0067）
 * - mxfile を持たない .svg / .png は image モジュールで表示する（FR-DIO-02）
 */
import BOOT from './frame-boot.js';
import { buildFrameDoc } from './frame-doc.mjs';
import { createBlobRegistry } from '../viewer-common/blob-registry.mjs';

const DEFAULT_TIMEOUT_MS = 15000; // NFR-DIO-07

// ライブラリ本文の取得（drawio を初めて開いたときだけ。失敗したら捨てて次回やり直す — howto §1）
let libPromise = null;
function loadLib(win, uris) {
    if (!libPromise) {
        if (!uris || !uris.viewerStatic || !uris.stencils) { return Promise.reject(new Error('drawio library uri not configured')); }
        libPromise = Promise.all([uris.viewerStatic, uris.stencils].map((u) => win.fetch(u).then((r) => {
            if (!r.ok) { throw new Error(`drawio library fetch failed: ${r.status}`); }
            return r.text();
        }))).catch((e) => { libPromise = null; throw e; });
    }
    return libPromise;
}

function formatOf(p) {
    const name = String(p || '').toLowerCase();
    if (name.endsWith('.svg')) { return 'svg'; }
    if (name.endsWith('.png')) { return 'png'; }
    return 'xml';
}

export default {
    async mount(ctx) {
        const { body, mount, state, config, label } = ctx;
        const doc = body.ownerDocument;
        const win = doc.defaultView || window;
        const timings = { start: win.performance.now(), rendered: null };
        if (state) { state.drawioTimings = timings; }

        const format = formatOf(ctx.filePath || ctx.fileUri);
        const registry = createBlobRegistry();
        let destroyed = false;
        let iframe = null;
        let channel = null;
        let timer = null;
        let fallback = null;

        const loading = doc.createElement('div');
        loading.className = 'viewer-loading fv-drawio-loading';
        loading.textContent = label('viewerDrawioLoading', 'Preparing diagram…');
        body.appendChild(loading);

        function teardownFrame() {
            if (timer) { win.clearTimeout(timer); timer = null; }
            if (channel) { try { channel.port1.close(); } catch (e) { /* noop */ } channel = null; }
            if (iframe) { try { iframe.remove(); } catch (e) { /* noop */ } iframe = null; }
            registry.revokeAll();
        }
        function showFailure(message) {
            teardownFrame();
            try { loading.remove(); } catch (e) { /* noop */ }
            const err = doc.createElement('div');
            err.className = 'viewer-error';
            err.textContent = message;
            body.appendChild(err);
        }
        function failed(code) {
            showFailure(code === 'tooLarge'
                ? label('viewerTooLargeToRender', 'This file is too large to display')
                : label('viewerDrawioRenderFailed', 'Could not display this diagram'));
        }
        async function fallbackToImage() {
            teardownFrame();
            for (const sel of ['.viewer-drawio-page', '.viewer-drawio-layers', '.viewer-zoom-reset']) {
                const el = mount.querySelector(sel);
                if (el) { el.style.display = 'none'; } // hidden 属性はツールバー CSS の display に負ける
            }
            try {
                const uri = config && config.viewerModuleUris && config.viewerModuleUris.image;
                // 相対 URI（ハーネス）は文書基準で解決する（ESM の import() は本モジュール基準で解決するため）
                const mod = await import(new URL(uri, doc.baseURI).href);
                if (destroyed) { return; }
                try { loading.remove(); } catch (e) { /* noop */ }
                fallback = await mod.default.mount(ctx);
                if (destroyed && fallback && fallback.destroy) { fallback.destroy(); }
            } catch (e) {
                if (!destroyed) { failed('lib'); }
            }
        }
        function onReply(m) {
            if (destroyed || !m) { return; }
            if (m.type === 'rendered') {
                if (timer) { win.clearTimeout(timer); timer = null; }
                if (timings.rendered == null) { timings.rendered = win.performance.now(); }
                try { loading.remove(); } catch (e) { /* noop */ }
                if (state) { state.drawio = { pages: m.pages || [], page: m.page || 0, layers: m.layers || [] }; }
            } else if (m.type === 'noDiagram') {
                if (format === 'xml') { failed('parse'); } else { fallbackToImage(); }
            } else if (m.type === 'error') {
                failed(m.code);
            }
        }

        const [buf, libs] = await Promise.all([
            win.fetch(ctx.fileUri).then((r) => {
                if (!r.ok) { throw new Error(`fetch failed: ${r.status}`); }
                return r.arrayBuffer();
            }),
            loadLib(win, config && config.drawioAssetUris),
        ]);
        if (destroyed) { return { destroy() {} }; }
        const data = format === 'png' ? buf : new TextDecoder('utf-8').decode(buf);
        const nonce = (config && config.nonce) || win.__webviewNonce;
        const html = buildFrameDoc({ nonce, viewerStatic: libs[0], stencils: libs[1], boot: BOOT });

        iframe = doc.createElement('iframe');
        // ADRL-0067 不変条件 6: allow-scripts のみ（allow-same-origin を付けると隔離がなくなる）
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.className = 'fv-drawio-frame';
        iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
        channel = new win.MessageChannel();
        channel.port1.onmessage = (e) => onReply(e.data);
        const ch = channel;
        iframe.addEventListener('load', () => {
            if (destroyed || channel !== ch || !iframe || !iframe.contentWindow) { return; }
            iframe.contentWindow.postMessage({ type: 'drawioInit' }, '*', [ch.port2]);
            ch.port1.postMessage({ type: 'load', format, data }, format === 'png' ? [data] : []);
        }, { once: true });
        iframe.src = registry.url(new Blob([html], { type: 'text/html' }));
        body.appendChild(iframe);
        timer = win.setTimeout(() => { timer = null; if (!destroyed) { failed('timeout'); } },
            (config && config.drawioRenderTimeoutMs) || DEFAULT_TIMEOUT_MS);

        return {
            destroy() {
                destroyed = true;
                teardownFrame();
                if (fallback && typeof fallback.destroy === 'function') {
                    try { fallback.destroy(); } catch (e) { /* best-effort */ }
                }
            },
        };
    },
};
