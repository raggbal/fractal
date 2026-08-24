/**
 * viewer-image/index.mjs — image viewer（MOD-ImageViewer / FR-IMV-01..03）
 *
 * `<img>` + CSS transform の自前実装（ADRL-0090）。svg も同一の `<img src=blobURL>` 経路
 * （inline `<svg>` 注入は禁止 — ADRL-0091 / INV-7。`<img>` 内では script 不実行・外部 fetch 不発生）。
 * wheel = カーソル位置不動点ズーム / drag = パン / [−][+] / [フィット] / [等倍]（1/devicePixelRatio）。
 * EXIF orientation はブラウザ自動適用（追加実装なし）。find 非対応（🔍 非表示は core 側）。
 */
import { createBlobRegistry } from '../viewer-common/blob-registry.mjs';

const ZOOM_MAX = 32;
const WHEEL_BASE = 1.1;

function ensureStyle(doc) {
    if (doc.getElementById('fv-image-style')) { return; }
    const style = doc.createElement('style');
    style.id = 'fv-image-style';
    style.textContent = [
        // 市松背景（透過画像確認用 — CSS のみ・テーマ非依存の中間トーン）
        '.fv-image-stage { position: absolute; inset: 0; overflow: hidden; cursor: grab;',
        '  background-image: linear-gradient(45deg, rgba(128,128,128,0.18) 25%, transparent 25%),',
        '    linear-gradient(-45deg, rgba(128,128,128,0.18) 25%, transparent 25%),',
        '    linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.18) 75%),',
        '    linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.18) 75%);',
        '  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }',
        '.fv-image-stage.fv-panning { cursor: grabbing; }',
        '.fv-image-stage img { position: absolute; left: 0; top: 0; transform-origin: 0 0;',
        '  max-width: none; max-height: none; user-select: none; -webkit-user-drag: none; }',
        '.fv-image-stage img.fv-pixelated { image-rendering: pixelated; }',
        '.fv-image-zoom-label { margin-left: 6px; font-size: 11px; opacity: 0.7; }',
    ].join('\n');
    doc.head.appendChild(style);
}

const EXT_MIME = new Map([
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'],
    ['webp', 'image/webp'], ['avif', 'image/avif'], ['bmp', 'image/bmp'], ['ico', 'image/x-icon'],
    ['svg', 'image/svg+xml'],
]);

export default {
    async mount(ctx) {
        const { body, mount, state } = ctx;
        const doc = body.ownerDocument;
        const win = doc.defaultView || window;
        ensureStyle(doc);

        const registry = createBlobRegistry();
        const resp = await win.fetch(ctx.fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        const raw = await resp.blob();
        // svg は MIME 明示（fetch の blob が octet-stream になる面でも `<img>` が SVG として描画できるように）
        const ext = String(ctx.filePath || ctx.fileUri).split('.').pop().toLowerCase();
        const mime = EXT_MIME.get(ext) || raw.type || 'application/octet-stream';
        const blob = raw.type === mime ? raw : new Blob([raw], { type: mime });
        const url = registry.url(blob); // 生成直後に登録（INV-3）

        const stage = doc.createElement('div');
        stage.className = 'fv-image-stage';
        const img = doc.createElement('img');
        img.alt = '';
        stage.appendChild(img);
        body.appendChild(stage);

        // ImageStage 状態（DOM-ImageStage）
        const st = { scale: 1, tx: 0, ty: 0, fitScale: 1, natW: 1, natH: 1 };
        const dpr = win.devicePixelRatio || 1;
        const zoomLabel = doc.createElement('span');
        zoomLabel.className = 'fv-image-zoom-label';
        const title = mount.querySelector('.viewer-title');
        if (title) { title.appendChild(zoomLabel); }

        function apply() {
            img.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
            img.classList.toggle('fv-pixelated', st.scale * dpr >= 4);
            zoomLabel.textContent = Math.round(st.scale * dpr * 100) + '%';
            win.__fvImageState = { scale: st.scale, tx: st.tx, ty: st.ty }; // テスト観測用
        }
        function clampScale(s) {
            return Math.min(ZOOM_MAX, Math.max(st.fitScale / 4, s));
        }
        function center(scale) {
            st.scale = scale;
            st.tx = (stage.clientWidth - st.natW * scale) / 2;
            st.ty = (stage.clientHeight - st.natH * scale) / 2;
            apply();
        }
        function fit() {
            const s = Math.min(stage.clientWidth / st.natW, stage.clientHeight / st.natH);
            st.fitScale = Math.min(1, s) || 1; // 小画像は拡大しない（FR-IMV-01）
            center(st.fitScale);
        }
        function actualSize() { center(1 / dpr); }
        /** カーソル位置 (cx, cy) を不動点にスケール変更 */
        function zoomAt(cx, cy, next) {
            const s2 = clampScale(next);
            const k = s2 / st.scale;
            st.tx = cx - (cx - st.tx) * k;
            st.ty = cy - (cy - st.ty) * k;
            st.scale = s2;
            apply();
        }

        img.src = url;
        try { await img.decode(); } catch (e) { throw new Error('image decode failed'); }
        st.natW = img.naturalWidth || 1;
        st.natH = img.naturalHeight || 1;
        fit();

        // wheel: カーソル不動点ズーム
        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = stage.getBoundingClientRect();
            const next = st.scale * Math.pow(WHEEL_BASE, -e.deltaY / 100);
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, next);
        }, { passive: false });
        // pointer drag: パン
        let panning = null;
        stage.addEventListener('pointerdown', (e) => {
            panning = { x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty };
            stage.classList.add('fv-panning');
            try { stage.setPointerCapture(e.pointerId); } catch (e2) { /* noop */ }
        });
        stage.addEventListener('pointermove', (e) => {
            if (!panning) { return; }
            st.tx = panning.tx + (e.clientX - panning.x);
            st.ty = panning.ty + (e.clientY - panning.y);
            apply();
        });
        const endPan = () => { panning = null; stage.classList.remove('fv-panning'); };
        stage.addEventListener('pointerup', endPan);
        stage.addEventListener('pointercancel', endPan);

        // toolbar 配線（buildToolbar は DOM 生成のみ — click は kind 側が配線する規約）
        const bar = mount.querySelector('.viewer-toolbar');
        const wire = (sel, fn) => { const b = bar && bar.querySelector(sel); if (b) { b.addEventListener('click', fn); } };
        const centerZoom = (mul) => {
            zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, st.scale * mul);
        };
        wire('.viewer-zoom-in', () => centerZoom(1.25));
        wire('.viewer-zoom-out', () => centerZoom(1 / 1.25));
        wire('.viewer-fit', fit);
        wire('.viewer-actual-size', actualSize);

        // resize: フィット状態なら再フィット
        let ro = null;
        if (win.ResizeObserver) {
            ro = new win.ResizeObserver(() => {
                if (Math.abs(st.scale - st.fitScale) < 1e-6) { fit(); }
            });
            ro.observe(stage);
        }

        // find 非対応（FR-FV-21 — 🔍 は core 側で非表示。契約関数は設置しない）
        state.findExec = null; state.findStep = null; state.findClear = null;

        return {
            destroy() {
                if (ro) { try { ro.disconnect(); } catch (e) { /* noop */ } }
                try { zoomLabel.remove(); } catch (e) { /* noop */ }
                registry.revokeAll();
            },
        };
    },
};
