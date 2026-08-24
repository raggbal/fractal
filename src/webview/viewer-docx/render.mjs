/**
 * viewer-docx/render.mjs — 紙面幅カード描画（MOD-DocxRenderer / FR-DXV-02/05..09 / ADRL-0096）
 *
 * DocModel → <section class="dxv-page">（pgSz 幅・pgMar padding・min-height 可変）。
 * 分割は明示 page break（w:br type="page" / pageBreakBefore）と sectPr 変化のみ（自動改ページなし）。
 * DOM は createElement + textContent のみ（INV-2）。画像は BlobRegistry（INV-3）。
 */
import { dxaToPx, halfPtToPt, emuToPx } from '../viewer-common/units.mjs';
import { emfToSvgDataUrl } from '../viewer-common/emf.mjs';   // 再オープン④ TASK-28（ADRL-0097）
import { resolveRunColor, fontFamilyCss } from './theme.mjs';

const HIGHLIGHT = new Map([
    ['yellow', '#FFFF00'], ['green', '#00FF00'], ['cyan', '#00FFFF'], ['magenta', '#FF00FF'],
    ['blue', '#0000FF'], ['red', '#FF0000'], ['darkBlue', '#00008B'], ['darkCyan', '#008B8B'],
    ['darkGreen', '#006400'], ['darkMagenta', '#8B008B'], ['darkRed', '#8B0000'], ['darkYellow', '#808000'],
    ['darkGray', '#A9A9A9'], ['lightGray', '#D3D3D3'], ['black', '#000000'], ['white', '#FFFFFF'],
]);

function ensureStyle(doc) {
    if (doc.getElementById('fv-docx-style')) { return; }
    const style = doc.createElement('style');
    style.id = 'fv-docx-style';
    style.textContent = [
        '.dxv-root { padding: 16px 0; }',
        '.dxv-note { text-align: center; font-size: 11px; opacity: 0.6; margin-bottom: 8px; }',
        '.dxv-banner { margin: 0 auto 8px; max-width: 640px; padding: 6px 10px; font-size: 12px;',
        '  background: rgba(255, 200, 60, 0.25); border: 1px solid rgba(200, 150, 0, 0.5); border-radius: 4px; }',
        '.dxv-page { position: relative; margin: 0 auto 16px; background: #fff; color: #1a1a1a;',
        '  box-shadow: 0 1px 4px rgba(0,0,0,0.25); box-sizing: border-box; overflow-wrap: break-word;',
        '  font-family: Calibri, "游明朝", "Yu Mincho", serif; transform-origin: top center; }',
        '.dxv-page p { margin: 0; min-height: 1em; white-space: pre-wrap; }',
        '.dxv-page table { border-collapse: collapse; }',
        '.dxv-page td { vertical-align: top; padding: 2px 6px; }',
        '.dxv-tbl-borders td { border: 1px solid #666; }',
        '.dxv-num { user-select: text; }',
        '.dxv-tab { display: inline-block; width: 3em; }',
        '.dxv-textbox { display: inline-block; border: 1px solid rgba(128,128,128,0.6); padding: 2px 6px; margin: 2px; }',
        '.dxv-math, .dxv-unsupported-img { display: inline-block; border: 1px dashed rgba(128,128,128,0.7);',
        '  padding: 1px 6px; color: #666; font-size: 0.9em; background: rgba(200,200,200,0.15); }',
        '.fv-find-hit { background: rgba(255, 213, 79, 0.6); }',
        '.fv-find-current { background: rgba(255, 150, 50, 0.95); }',
    ].join('\n');
    doc.head.appendChild(style);
}

function runCss(span, eff, theme, ctxShd) {
    if (eff.b) { span.style.fontWeight = 'bold'; }
    if (eff.i) { span.style.fontStyle = 'italic'; }
    const deco = [];
    if (eff.u && eff.u !== 'none') { deco.push('underline'); }
    if (eff.strike || eff.dstrike) { deco.push('line-through'); }
    if (deco.length) { span.style.textDecoration = deco.join(' '); }
    if (eff.szHalf) { span.style.fontSize = halfPtToPt(eff.szHalf) + 'pt'; }
    const color = resolveRunColor(eff, theme, { shdFill: eff.shdFill || ctxShd });
    if (color) { span.style.color = color; }
    if (eff.highlight && HIGHLIGHT.has(eff.highlight)) { span.style.backgroundColor = HIGHLIGHT.get(eff.highlight); }
    else if (eff.shdFill && eff.shdFill !== 'auto') { span.style.backgroundColor = '#' + eff.shdFill; }
    if (eff.vertAlign === 'superscript') { span.style.verticalAlign = 'super'; span.style.fontSize = 'smaller'; }
    if (eff.vertAlign === 'subscript') { span.style.verticalAlign = 'sub'; span.style.fontSize = 'smaller'; }
    if (eff.caps) { span.style.textTransform = 'uppercase'; }
    if (eff.smallCaps) { span.style.fontVariant = 'small-caps'; }
    if (eff.vanish) { span.style.display = 'none'; }
    if (eff.letterSpacing) { span.style.letterSpacing = dxaToPx(eff.letterSpacing) + 'px'; }
    const fam = fontFamilyCss(eff.fonts, theme);
    if (fam) { span.style.fontFamily = fam; }
}

/** run 列を host に描画（page break で分割が必要なら残り runs を返す） */
function renderRuns(doc, host, runs, ctx, paraShd) {
    for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        switch (run.t) {
            case 'text': {
                const span = doc.createElement('span');
                span.textContent = run.text;
                runCss(span, ctx.styles.effectiveRPr({
                    paraStyleId: ctx.curParaStyle, charStyleId: run.rPr && run.rPr.styleId, direct: run.rPr || {},
                }), ctx.theme, paraShd);
                host.appendChild(span);
                break;
            }
            case 'br':
                if (run.page) { return runs.slice(i + 1); } // 明示 page break → カード分割（ADRL-0096）
                host.appendChild(doc.createElement('br'));
                break;
            case 'tab': {
                const t = doc.createElement('span');
                t.className = 'dxv-tab';
                t.textContent = ' ';
                host.appendChild(t);
                break;
            }
            case 'link': {
                const a = doc.createElement('a');
                const target = run.relId ? ctx.pkg.relTarget(run.relId) : (run.anchor ? '#' + run.anchor : null);
                if (target) { a.title = target; }
                a.style.color = '#0563C1';
                a.style.textDecoration = 'underline';
                renderRuns(doc, a, run.runs, ctx, paraShd);
                host.appendChild(a);
                break;
            }
            case 'image': renderImage(doc, host, run, ctx); break;
            case 'ruby': {
                const ruby = doc.createElement('ruby');
                renderRuns(doc, ruby, run.base, ctx, paraShd);
                const rt = doc.createElement('rt');
                renderRuns(doc, rt, run.rt, ctx, paraShd);
                ruby.appendChild(rt);
                host.appendChild(ruby);
                break;
            }
            case 'textbox': {
                const box = doc.createElement('span');
                box.className = 'dxv-textbox';
                renderRuns(doc, box, run.runs, ctx, paraShd);
                host.appendChild(box);
                break;
            }
            case 'math': {
                const m = doc.createElement('span');
                m.className = 'dxv-math';
                m.textContent = ctx.label('viewerUnsupportedMath', '[equation]');
                host.appendChild(m);
                break;
            }
            default: break;
        }
    }
    return null;
}

const IMG_EXT_OK = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;

// 再オープン④（TASK-28 / TC-DXV-15・ADRL-0097）: renderImage は挙動テストの seam として export
export function renderImage(doc, host, run, ctx) {
    const target = ctx.pkg.relTarget(run.relId) || '';
    const w = run.cx ? emuToPx(run.cx) : null;
    const h = run.cy ? emuToPx(run.cy) : null;
    const toPlaceholder = (el) => {
        el.className = 'dxv-unsupported-img';
        if (w) { el.style.width = w + 'px'; }
        if (h) { el.style.height = h + 'px'; }
        el.textContent = ctx.label('viewerUnsupportedImageFmt', 'Image format not supported');
    };
    if (/\.emf$/i.test(target)) {
        // 再オープン④: ベクタ EMF は viewer-common/emf.mjs で SVG 実描画（pptx 配線と対 — 片肺禁止）。
        // 変換不能は従来の縮退枠。media 取得は非同期（初回表示をブロックしない — NFR-VEX-03）
        const holder = doc.createElement('span');
        host.appendChild(holder);
        ctx.pkg.media(run.relId).then((bytes) => {
            const url = bytes ? emfToSvgDataUrl(bytes) : null;
            if (url) {
                const img = doc.createElement('img');
                if (w) { img.style.width = w + 'px'; }
                if (h) { img.style.height = h + 'px'; }
                img.src = url;
                holder.replaceWith(img);
            } else { toPlaceholder(holder); }
        }).catch(() => { toPlaceholder(holder); });
        return;
    }
    if (!IMG_EXT_OK.test(target)) {
        // WMF 等 — サイズ枠 + プレースホルダ（FR-DXV-06）
        const ph = doc.createElement('span');
        toPlaceholder(ph);
        host.appendChild(ph);
        return;
    }
    const img = doc.createElement('img');
    if (w) { img.style.width = w + 'px'; }
    if (h) { img.style.height = h + 'px'; }
    if (run.anchor) {
        if (run.align === 'right') { img.style.float = 'right'; img.style.margin = '4px 0 4px 8px'; }
        else if (run.align === 'left') { img.style.float = 'left'; img.style.margin = '4px 8px 4px 0'; }
        // posOffset 等はインライン化縮退（調査 v2 §5）
    }
    host.appendChild(img);
    // media は非同期取得 → 到着次第 src 設定（初回表示をブロックしない — NFR-VEX-03）
    ctx.pkg.media(run.relId).then((bytes) => {
        if (!bytes) { return; }
        const blob = new Blob([bytes]);
        img.src = ctx.blobRegistry.url(blob); // 生成直後に登録（INV-3）
    }).catch(() => { /* 失敗は空 img（枠のみ） */ });
}

function renderParagraph(doc, host, para, ctx) {
    const p = doc.createElement('p');
    const pPr = ctx.styles.effectivePPr({ paraStyleId: para.pPr.styleId, direct: para.pPr });
    ctx.curParaStyle = para.pPr.styleId || null;
    if (pPr.jc) { p.style.textAlign = pPr.jc === 'both' ? 'justify' : pPr.jc; }
    if (pPr.indLeft) { p.style.marginLeft = dxaToPx(pPr.indLeft) + 'px'; }
    if (pPr.indRight) { p.style.marginRight = dxaToPx(pPr.indRight) + 'px'; }
    if (pPr.indFirst) { p.style.textIndent = dxaToPx(pPr.indFirst) + 'px'; }
    if (pPr.hanging) { p.style.textIndent = (-dxaToPx(pPr.hanging)) + 'px'; p.style.paddingLeft = dxaToPx(pPr.hanging) + 'px'; }
    if (pPr.spaceBefore) { p.style.marginTop = dxaToPx(pPr.spaceBefore) + 'px'; }
    if (pPr.spaceAfter) { p.style.marginBottom = dxaToPx(pPr.spaceAfter) + 'px'; }
    if (pPr.line) {
        // lineRule auto = 240 分率 / exact・atLeast = dxa（FR-DXV-01 — 分岐 10 行）
        if (!pPr.lineRule || pPr.lineRule === 'auto') { p.style.lineHeight = String(pPr.line / 240); }
        else { p.style.lineHeight = dxaToPx(pPr.line) + 'px'; }
    }
    if (pPr.shdFill && pPr.shdFill !== 'auto') { p.style.backgroundColor = '#' + pPr.shdFill; }
    if (pPr.hasBorder) { p.style.border = '1px solid #999'; p.style.padding = '2px 6px'; }
    // numbering（自前カウンタで番号焼き込み — FR-DXV-04）
    const numPr = para.pPr.numPr || (pPr.numPr && para.pPr.numPr === undefined ? pPr.numPr : null);
    if (numPr && numPr.numId != null && ctx.counter) {
        const label = ctx.counter.next(numPr.numId, numPr.ilvl || 0);
        if (label && label.text) {
            if (label.indLeft) { p.style.marginLeft = dxaToPx(label.indLeft) + 'px'; }
            const num = doc.createElement('span');
            num.className = 'dxv-num';
            num.textContent = label.text + (label.suff === 'nothing' ? '' : label.suff === 'space' ? ' ' : '  ');
            p.appendChild(num);
        }
    }
    const rest = renderRuns(doc, p, para.runs, ctx, pPr.shdFill);
    host.appendChild(p);
    return rest; // page break の残り runs（呼び出し元が新カードで続きを描く）
}

function renderTable(doc, host, tbl, ctx) {
    const table = doc.createElement('table');
    if (tbl.tblPr.hasBorders) { table.className = 'dxv-tbl-borders'; }
    if (tbl.tblPr.fixed) { table.style.tableLayout = 'fixed'; }
    if (tbl.grid.length) {
        const colgroup = doc.createElement('colgroup');
        for (const w of tbl.grid) {
            const col = doc.createElement('col');
            if (w) { col.style.width = dxaToPx(w) + 'px'; }
            colgroup.appendChild(col);
        }
        table.appendChild(colgroup);
    }
    // vMerge の rowspan 解決（列位置追跡 — FR-DXV-02 / TC-DXV-05）
    const anchors = new Map(); // gridCol → 開始 td
    for (const row of tbl.rows) {
        const tr = doc.createElement('tr');
        let gridCol = 0;
        for (const cell of row.cells) {
            if (cell.vMerge === 'continue') {
                const anchor = anchors.get(gridCol);
                if (anchor) { anchor.rowSpan += 1; }
                gridCol += cell.gridSpan;
                continue; // 被覆セルは出力しない
            }
            const td = doc.createElement('td');
            if (cell.gridSpan > 1) { td.colSpan = cell.gridSpan; }
            if (cell.vMerge === 'restart') { anchors.set(gridCol, td); }
            if (cell.shdFill && cell.shdFill !== 'auto') { td.style.backgroundColor = '#' + cell.shdFill; }
            if (cell.vAlign) { td.style.verticalAlign = cell.vAlign === 'center' ? 'middle' : cell.vAlign; }
            for (const block of cell.blocks) {
                if (block.t === 'p') { renderParagraph(doc, td, block, ctx); }
                else if (block.t === 'tbl') { renderTable(doc, td, block, ctx); }
            }
            tr.appendChild(td);
            gridCol += cell.gridSpan;
        }
        table.appendChild(tr);
    }
    host.appendChild(table);
}

/** DocModel 全体を紙面幅カード列として描画 */
export function renderDoc(container, model, ctx) {
    const doc = container.ownerDocument;
    ensureStyle(doc);
    const root = doc.createElement('div');
    root.className = 'dxv-root';
    container.appendChild(root);
    // 常設注記（FR-DXV-07）
    const note = doc.createElement('div');
    note.className = 'dxv-note';
    note.textContent = ctx.label('viewerLayoutApprox', 'Approximate layout');
    root.appendChild(note);
    // 縦書き検出 → 警告バナー + 横書き縮退（FR-DXV-08 / TC-DXV-14）
    if (model.sections.some((s) => s.props.textDirection && /^(tbRl|tb)/i.test(s.props.textDirection))) {
        const banner = doc.createElement('div');
        banner.className = 'dxv-banner';
        banner.textContent = ctx.label('viewerVerticalTextApprox', 'Vertical text shown horizontally (approximation)');
        root.appendChild(banner);
    }
    const pages = [];
    for (const section of model.sections) {
        const props = section.props;
        const pgW = props.pgW ? dxaToPx(props.pgW) : 794; // 既定 A4 幅
        let page = null;
        const newPage = () => {
            page = doc.createElement('section');
            page.className = 'dxv-page';
            page.style.width = pgW + 'px';
            if (props.pgH) { page.style.minHeight = dxaToPx(props.pgH) + 'px'; }
            page.style.padding = [props.marT, props.marR, props.marB, props.marL]
                .map((m) => (m ? dxaToPx(m) : 48) + 'px').join(' ');
            root.appendChild(page);
            pages.push({ el: page, width: pgW });
            return page;
        };
        newPage();
        for (const block of section.blocks) {
            if (block.t === 'tbl') { renderTable(doc, page, block, ctx); continue; }
            if (block.pPr && (block.pPr.pageBreakBefore) && page.childNodes.length > 0) { newPage(); }
            let para = block;
            for (; ;) {
                const rest = renderParagraph(doc, page, para, ctx);
                if (!rest) { break; }
                newPage(); // 段落内 page break → 残り runs を新カードで
                para = { t: 'p', pPr: para.pPr, runs: rest };
            }
        }
    }
    // 狭幅 mount では scale（FR-DXV-07 — 調査 v2 §6）
    const fit = () => {
        const avail = container.clientWidth - 24;
        for (const { el, width } of pages) {
            if (avail > 0 && avail < width) {
                const s = avail / width;
                el.style.transform = `scale(${s})`;
                el.style.marginBottom = (16 - (1 - s) * el.offsetHeight) + 'px';
            } else {
                el.style.transform = '';
                el.style.marginBottom = '';
            }
        }
    };
    fit();
    const win = doc.defaultView;
    let ro = null;
    if (win && win.ResizeObserver) {
        ro = new win.ResizeObserver(fit);
        ro.observe(container);
    }
    return { root, destroy() { if (ro) { try { ro.disconnect(); } catch (e) { /* noop */ } } } };
}
