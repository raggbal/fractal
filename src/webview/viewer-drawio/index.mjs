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

function ensureStyle(doc) {
    if (doc.getElementById('fv-drawio-style')) { return; }
    const style = doc.createElement('style');
    style.id = 'fv-drawio-style';
    style.textContent = [
        '.viewer-drawio-page { max-width: 180px; font: inherit; font-size: 12px; }',
        '.viewer-drawio-layer-menu { position: fixed; z-index: 1000; min-width: 160px; max-height: 60vh; overflow: auto;',
        '  padding: 4px 0; background: var(--fv-bg-bar, #fff); border: 1px solid var(--fv-border, #ccc);',
        '  border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-size: 12px; }',
        '.viewer-drawio-layer-menu label { display: flex; align-items: center; gap: 6px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }',
        '.viewer-drawio-layer-menu label:hover { background: rgba(128,128,128,0.12); }',
    ].join('\n');
    doc.head.appendChild(style);
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

        ensureStyle(doc);
        const send = (m) => { if (channel) { channel.port1.postMessage(m); } };

        // ツールバー（DOM は file-viewer.js buildToolbar が生成 — ADRL-0137。ここは配線だけ）
        const bar = mount.querySelector('.viewer-toolbar');
        const q = (sel) => (bar ? bar.querySelector(sel) : null);
        const pageSel = q('.viewer-drawio-page');
        const layersBtn = q('.viewer-drawio-layers');
        const wire = (sel, fn) => { const b = q(sel); if (b) { b.addEventListener('click', fn); } };
        wire('.viewer-zoom-in', () => send({ type: 'zoom', dir: 'in' }));
        wire('.viewer-zoom-out', () => send({ type: 'zoom', dir: 'out' }));
        wire('.viewer-zoom-reset', () => send({ type: 'zoom', dir: 'fit' }));
        if (pageSel) {
            pageSel.addEventListener('change', () => send({ type: 'page', index: Number(pageSel.value) }));
        }
        let layerMenu = null;
        let layerState = [];
        function closeLayerMenu() {
            if (layerMenu) { layerMenu.remove(); layerMenu = null; }
            doc.removeEventListener('mousedown', onDocDown, true);
            doc.removeEventListener('keydown', onDocKey, true);
        }
        function onDocDown(e) {
            if (layerMenu && !layerMenu.contains(e.target) && e.target !== layersBtn && !(layersBtn && layersBtn.contains(e.target))) { closeLayerMenu(); }
        }
        function onDocKey(e) { if (e.key === 'Escape') { closeLayerMenu(); } }
        function openLayerMenu() {
            closeLayerMenu();
            layerMenu = doc.createElement('div');
            layerMenu.className = 'viewer-drawio-layer-menu';
            layerMenu.setAttribute('role', 'menu');
            for (const l of layerState) {
                const row = doc.createElement('label');
                const cb = doc.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!l.visible;
                cb.addEventListener('change', () => {
                    l.visible = cb.checked;
                    send({ type: 'layer', id: l.id, visible: cb.checked });
                });
                row.appendChild(cb);
                row.appendChild(doc.createTextNode(l.name));
                layerMenu.appendChild(row);
            }
            const r = layersBtn.getBoundingClientRect();
            layerMenu.style.left = Math.max(0, r.left) + 'px';
            layerMenu.style.top = r.bottom + 2 + 'px';
            mount.appendChild(layerMenu);
            doc.addEventListener('mousedown', onDocDown, true);
            doc.addEventListener('keydown', onDocKey, true);
        }
        if (layersBtn) {
            layersBtn.addEventListener('click', () => { if (layerMenu) { closeLayerMenu(); } else { openLayerMenu(); } });
        }
        function applyRendered(m) {
            const pages = m.pages || [];
            if (pageSel) {
                if (pageSel.options.length !== pages.length) {
                    pageSel.textContent = '';
                    pages.forEach((p, i) => {
                        const o = doc.createElement('option');
                        o.value = String(i);
                        o.textContent = p.name;
                        pageSel.appendChild(o);
                    });
                }
                pageSel.value = String(m.page || 0);
                pageSel.style.display = pages.length > 1 ? '' : 'none';
            }
            layerState = (m.layers || []).map((l) => ({ ...l }));
            if (layerMenu) { openLayerMenu(); } // ページ切替でレイヤー一覧が変わる
            if (layersBtn) { layersBtn.style.display = layerState.length > 1 ? '' : 'none'; }
        }

        const loading = doc.createElement('div');
        loading.className = 'viewer-loading fv-drawio-loading';
        loading.textContent = label('viewerDrawioLoading', 'Preparing diagram…');
        body.appendChild(loading);

        function teardownFrame() {
            closeLayerMenu();
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
                applyRendered(m);
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
