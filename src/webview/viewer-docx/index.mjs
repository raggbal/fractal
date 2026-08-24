/**
 * viewer-docx/index.mjs — docx viewer の mount(ctx) 契約実装（MOD-DocxRenderer）
 *
 * fetch → openDocxPackage（zip 三重ガード）→ parseDocumentXml → styles/numbering/theme →
 * renderDoc（紙面幅カード）→ find-highlight（findQuery one-shot — docx は locHint なし）。
 */
import { openDocxPackage } from './package.mjs';
import { parseDocumentXml } from './parse.mjs';
import { buildStyleResolver } from './styles.mjs';
import { buildNumbering, createCounter } from './numbering.mjs';
import { parseTheme } from './theme.mjs';
import { renderDoc } from './render.mjs';
import { createBlobRegistry } from '../viewer-common/blob-registry.mjs';
import { execFind, clearFind } from '../viewer-common/find-highlight.mjs';

export default {
    async mount(ctx) {
        const { body, state, label } = ctx;
        const doc = body.ownerDocument;
        const win = doc.defaultView || window;

        const resp = await win.fetch(ctx.fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        const buf = new Uint8Array(await resp.arrayBuffer());
        let pkg;
        try {
            pkg = await openDocxPackage(buf);
        } catch (e) {
            if (e && e.code === 'NOT_ZIP') { throw new Error(label('viewerProtectedFile', 'Password-protected files cannot be displayed')); }
            if (e && (e.code === 'ENTRY_TOO_LARGE' || e.code === 'ZIP_BUDGET_EXCEEDED')) {
                throw new Error(label('viewerTooLargeToRender', 'This file is too large to display'));
            }
            throw e;
        }
        const blobRegistry = createBlobRegistry();
        let view;
        try {
            const model = parseDocumentXml(pkg.documentXml);
            const renderCtx = {
                pkg, blobRegistry, label,
                styles: buildStyleResolver(pkg.styles),
                counter: createCounter(buildNumbering(pkg.numbering)),
                theme: parseTheme(pkg.theme),
                curParaStyle: null,
            };
            view = renderDoc(body, model, renderCtx);
        } catch (e) {
            blobRegistry.revokeAll(); // パース/描画途中の失敗でも登録済み + 遅延分を漏らさない（TC-VEX-13 / INV-3）
            throw e;
        }

        // find（FR-FV-21 — DOM 走査 + span ラップ。docx は locHint なし = findQuery のみ）
        let result = null;
        let current = -1;
        state.findExec = (q) => {
            clearFind(view.root);
            result = null; current = -1;
            const query = String(q || '');
            if (!query) { if (state.findUi) { state.findUi.onCount(0, 0); } return; }
            result = execFind(view.root, query);
            if (result.count > 0) { current = 0; result.jumpTo(0); }
            if (state.findUi) { state.findUi.onCount(result.count ? 1 : 0, result.count); }
        };
        state.findStep = (dir) => {
            if (!result || !result.count) { return; }
            current = (current + dir + result.count) % result.count;
            result.jumpTo(current);
            if (state.findUi) { state.findUi.onCount(current + 1, result.count); }
        };
        state.findClear = () => { clearFind(view.root); result = null; current = -1; };

        if (ctx.findQuery && state.findUi) {
            const fq = ctx.findQuery;
            ctx.findQuery = null; // one-shot（TC-DXV-12 counterfactual）
            state.findUi.openWith(fq);
        }

        return {
            destroy() {
                view.destroy();
                blobRegistry.revokeAll();
            },
        };
    },
};
