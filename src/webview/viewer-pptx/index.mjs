/*
 * fractal original（sprint 20260823-165314 / MOD-PptxRenderer — mount(ctx) 契約実装）。
 * fetch → parse（移植パーサ・imageMode:'base64' = data URL。CSP img-src data: 許可済み・
 * revoke 不要で INV-3 を単純化）→ renderSlides（windowed）。
 * find = スライドモデルの runs テキスト走査（描画状態非依存）→ 該当スライド先行描画 + span 強調。
 * locHint {slide:N} → 先行描画 + scroll → findQuery（one-shot — FR-FV-22）。
 */
import { parse } from './pptxtojson.mjs';
import { renderSlides } from './render.mjs';
import { execFind, clearFind } from '../viewer-common/find-highlight.mjs';

function collectSlideText(slide) {
    const texts = [];
    const walkContent = (content) => {
        if (!content || !content.paragraphs) { return; }
        for (const p of content.paragraphs) {
            for (const r of p.runs || []) { if (typeof r.text === 'string') { texts.push(r.text); } }
        }
    };
    const walkEls = (els) => {
        for (const el of els || []) {
            if (el.content) { walkContent(el.content); }
            if (el.type === 'table') {
                for (const row of el.data || []) { for (const cell of row || []) { walkContent(cell.text); } }
            }
            if (el.elements) { walkEls(el.elements); }
        }
    };
    walkEls(slide.elements);
    walkEls(slide.layoutElements);
    return texts.join('\n');
}

export default {
    async mount(ctx) {
        const { body, state } = ctx;
        const doc = body.ownerDocument;
        const win = doc.defaultView || window;

        const resp = await win.fetch(ctx.fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        const buf = await resp.arrayBuffer();
        let parsed;
        try {
            parsed = await parse(buf, { imageMode: 'base64' });
        } catch (e) {
            // zip 三重ガードのエラーを友好的文言へ（docx/xlsx と同一パターン — TC-PPV-12）
            if (e && e.code === 'NOT_ZIP') { throw new Error(ctx.label('viewerProtectedFile', 'Password-protected files cannot be displayed')); }
            if (e && (e.code === 'ENTRY_TOO_LARGE' || e.code === 'ZIP_BUDGET_EXCEEDED')) {
                throw new Error(ctx.label('viewerTooLargeToRender', 'This file is too large to display'));
            }
            throw e;
        }
        if (!parsed || !parsed.slides || parsed.slides.length === 0) { throw new Error('no slides'); }

        // 初期倍率 = mount 幅 fit（0.25..4 — FR-PPV-02）
        const wPx = parsed.size.width * (4 / 3);
        const fitScale = Math.min(1, Math.max(0.25, (body.clientWidth - 32) / wPx || 1));
        const view = renderSlides(body, parsed, { label: ctx.label, initialScale: fitScale });

        // toolbar [−][+]（DOM 生成は core・click 配線は kind 側の規約）
        const bar = ctx.mount.querySelector('.viewer-toolbar');
        const clampScale = (s) => Math.min(4, Math.max(0.25, s));
        const wire = (sel, mul) => {
            const b = bar && bar.querySelector(sel);
            if (b) { b.addEventListener('click', () => view.setScale(clampScale(view.getScale() * mul))); }
        };
        wire('.viewer-zoom-in', 1.25);
        wire('.viewer-zoom-out', 1 / 1.25);

        // ── find（FR-FV-21）: モデル走査で対象スライドを特定 → 先行描画 + DOM ハイライト ──
        const slideTexts = parsed.slides.map(collectSlideText);
        let hits = [];      // [{slide}] — スライド単位で走査し、DOM 側で run ハイライト
        let domFinds = [];  // スライドごとの execFind 結果
        let flatIndex = []; // {slideIdx, localIdx}
        let current = -1;
        let lastQuery = '';
        function scrollToSlide(i) {
            view.ensureRendered(i);
            const el = view.slideEls[i];
            if (el && typeof el.scrollIntoView === 'function') { el.scrollIntoView({ block: 'start' }); }
        }
        function rebuildDomFinds(query) {
            domFinds = [];
            flatIndex = [];
            for (let i = 0; i < parsed.slides.length; i++) {
                if (slideTexts[i].toLowerCase().indexOf(query) === -1) { domFinds.push(null); continue; }
                view.ensureRendered(i); // ヒットのあるスライドだけ先行描画
                const r = execFind(view.slideEls[i], query);
                domFinds.push(r);
                for (let k = 0; k < r.count; k++) { flatIndex.push({ slideIdx: i, localIdx: k }); }
            }
        }
        function jumpTo(n) {
            const target = flatIndex[n];
            if (!target) { return; }
            scrollToSlide(target.slideIdx);
            const r = domFinds[target.slideIdx];
            if (r) { r.jumpTo(target.localIdx); }
        }
        state.findExec = (q) => {
            for (const el of view.slideEls) { clearFind(el); }
            hits = [];
            current = -1;
            lastQuery = String(q || '').toLowerCase();
            if (!lastQuery) { if (state.findUi) { state.findUi.onCount(0, 0); } return; }
            rebuildDomFinds(lastQuery);
            if (flatIndex.length > 0) { current = 0; jumpTo(0); }
            if (state.findUi) { state.findUi.onCount(flatIndex.length ? 1 : 0, flatIndex.length); }
        };
        state.findStep = (dir) => {
            if (!flatIndex.length) { return; }
            current = (current + dir + flatIndex.length) % flatIndex.length;
            jumpTo(current);
            if (state.findUi) { state.findUi.onCount(current + 1, flatIndex.length); }
        };
        state.findClear = () => {
            for (const el of view.slideEls) { clearFind(el); }
            flatIndex = []; domFinds = []; current = -1; lastQuery = '';
        };

        // ── locHint {slide:N} + findQuery の one-shot 消費（FR-FV-22 / TC-PPV-10） ──
        if (ctx.locHint && ctx.locHint.slide) {
            const idx = Math.min(parsed.slides.length, Math.max(1, ctx.locHint.slide)) - 1;
            ctx.locHint = null; // one-shot
            scrollToSlide(idx);
        }
        if (ctx.findQuery && state.findUi) {
            const fq = ctx.findQuery;
            ctx.findQuery = null; // one-shot — 消費後の再 find はユーザー操作のみ
            state.findUi.openWith(fq);
        }

        return {
            destroy() { view.destroy(); },
        };
    },
};
