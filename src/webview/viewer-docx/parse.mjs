/**
 * viewer-docx/parse.mjs — document.xml → DocModel（MOD-DocxParser / FR-DXV-01/09）
 *
 * 品質基準 = 「文字を 1 文字も落とさない」（FR-DXV-01）。DocModel はプレーンオブジェクト
 * （DOM 生成なし — INV-2 の描画側 createElement と分離）。
 *  - xml:space（trim 禁止 — textContent をそのまま保持）
 *  - w:sdt → sdtContent 透過（目次消失防止）
 *  - field 状態機械: begin→separate 間の instrText 破棄・separate→end のキャッシュ結果表示・
 *    fldSimple は子表示・ネストは depth カウンタ
 *  - w:ins 子展開 / w:del 破棄・w:sym 私用領域置換・noBreakHyphen/softHyphen
 *  - mc:AlternateContent → Fallback（+ v:textbox>w:txbxContent 再帰回収）
 *  - OMML（m:oMath/oMathPara）→ {t:'math'} プレースホルダ run（unknown skip と区別 — FR-DXV-09）
 *  - unknown 要素は default スキップ + 開発時ロガー（window.__docxUnknownLog）
 */
import { element, elements, attr, intAttr, boolAttr } from '../viewer-common/xml.mjs';

const SYM_MAP = new Map([
    [0xFC, '✓'], [0xFB, '✗'], [0xB7, '•'], [0xA7, '■'], [0xD8, '➢'], [0x6C, '●'], [0x6E, '■'], [0x75, '◆'],
]);

function logUnknown(name) {
    try {
        if (typeof window !== 'undefined') {
            (window.__docxUnknownLog = window.__docxUnknownLog || new Set()).add(name);
        }
    } catch (e) { /* node unit では無視 */ }
}

// OOXML の bool 系要素（w:b / w:i 等 — val 省略 = true）
function onOff(el) {
    if (!el) { return undefined; }
    return boolAttr(el, 'val', true);
}

export function parseRunProps(rPrEl) {
    if (!rPrEl) { return {}; }
    const rPr = {};
    for (const c of elements(rPrEl)) {
        switch (c.localName) {
            case 'b': rPr.b = onOff(c); break;
            case 'i': rPr.i = onOff(c); break;
            case 'strike': rPr.strike = onOff(c); break;
            case 'dstrike': rPr.dstrike = onOff(c); break;
            case 'caps': rPr.caps = onOff(c); break;
            case 'smallCaps': rPr.smallCaps = onOff(c); break;
            case 'vanish': rPr.vanish = onOff(c); break;
            case 'u': { const v = attr(c, 'val'); rPr.u = v === null ? 'single' : v; break; }
            case 'color': { rPr.color = attr(c, 'val'); rPr.themeColor = attr(c, 'themeColor'); rPr.themeTint = attr(c, 'themeTint'); rPr.themeShade = attr(c, 'themeShade'); break; }
            case 'sz': rPr.szHalf = intAttr(c, 'val'); break;
            case 'vertAlign': rPr.vertAlign = attr(c, 'val'); break;
            case 'highlight': rPr.highlight = attr(c, 'val'); break;
            case 'shd': rPr.shdFill = attr(c, 'fill'); break;
            case 'rFonts':
                rPr.fonts = {
                    ascii: attr(c, 'ascii'), ea: attr(c, 'eastAsia'),
                    asciiTheme: attr(c, 'asciiTheme'), eaTheme: attr(c, 'eastAsiaTheme'),
                };
                break;
            case 'rStyle': rPr.styleId = attr(c, 'val'); break;
            case 'spacing': rPr.letterSpacing = intAttr(c, 'val'); break;
            default: break; // rPr 内 unknown は無害
        }
    }
    return rPr;
}

export function parseParaProps(pPrEl) {
    if (!pPrEl) { return {}; }
    const pPr = {};
    for (const c of elements(pPrEl)) {
        switch (c.localName) {
            case 'pStyle': pPr.styleId = attr(c, 'val'); break;
            case 'jc': pPr.jc = attr(c, 'val'); break;
            case 'ind':
                pPr.indLeft = intAttr(c, 'left') ?? intAttr(c, 'start');
                pPr.indRight = intAttr(c, 'right') ?? intAttr(c, 'end');
                pPr.indFirst = intAttr(c, 'firstLine');
                pPr.hanging = intAttr(c, 'hanging');
                break;
            case 'spacing':
                pPr.spaceBefore = intAttr(c, 'before');
                pPr.spaceAfter = intAttr(c, 'after');
                pPr.line = intAttr(c, 'line');
                pPr.lineRule = attr(c, 'lineRule');
                break;
            case 'numPr': {
                const ilvl = element(c, 'ilvl');
                const numId = element(c, 'numId');
                pPr.numPr = { ilvl: ilvl ? intAttr(ilvl, 'val') : 0, numId: numId ? intAttr(numId, 'val') : null };
                break;
            }
            case 'pBdr': pPr.hasBorder = true; break;
            case 'shd': pPr.shdFill = attr(c, 'fill'); break;
            case 'pageBreakBefore': pPr.pageBreakBefore = onOff(c); break;
            case 'contextualSpacing': pPr.contextualSpacing = onOff(c); break;
            case 'textDirection': pPr.textDirection = attr(c, 'val'); break;
            case 'rPr': pPr.markRPr = parseRunProps(c); break; // 段落マーク書式（ラン非継承 — FR-DXV-03）
            default: break;
        }
    }
    return pPr;
}

/** mc:AlternateContent → Fallback（無ければ Choice を最後の望みで）を返す */
function resolveAlternateContent(el) {
    const fallback = element(el, 'Fallback');
    if (fallback) { return fallback; }
    return element(el, 'Choice');
}

/**
 * run コンテナ（w:p 直下 / w:hyperlink / w:ins / w:sdtContent 等）を走査して Run[] に積む。
 * fieldCtx = { depth, shown }（begin→separate 間は非表示・separate→end は表示）。
 */
function collectRuns(container, runs, fieldCtx, rPrInherit) {
    for (const c of elements(container)) {
        switch (c.localName) {
            case 'r': parseRun(c, runs, fieldCtx, rPrInherit); break;
            case 'hyperlink': {
                const linkRuns = [];
                collectRuns(c, linkRuns, fieldCtx, rPrInherit);
                runs.push({ t: 'link', relId: attr(c, 'id'), anchor: attr(c, 'anchor'), runs: linkRuns });
                break;
            }
            case 'ins': collectRuns(c, runs, fieldCtx, rPrInherit); break;   // 挿入 = 表示
            case 'del': break;                                                // 削除 = 非表示
            case 'moveTo': collectRuns(c, runs, fieldCtx, rPrInherit); break;
            case 'moveFrom': break;
            case 'sdt': {
                const content = element(c, 'sdtContent');
                if (content) { collectRuns(content, runs, fieldCtx, rPrInherit); } // 透過（FR-DXV-01）
                break;
            }
            case 'fldSimple': collectRuns(c, runs, fieldCtx, rPrInherit); break;  // 子 = キャッシュ結果
            case 'smartTag': collectRuns(c, runs, fieldCtx, rPrInherit); break;
            case 'oMath': case 'oMathPara':
                runs.push({ t: 'math' });                                     // FR-DXV-09（REQFIT-2）
                break;
            case 'bookmarkStart': case 'bookmarkEnd': case 'proofErr': case 'commentRangeStart':
            case 'commentRangeEnd': case 'pPr': break;
            default: logUnknown(c.localName); break;
        }
    }
}

function parseRun(rEl, runs, fieldCtx, rPrInherit) {
    const rPr = parseRunProps(element(rEl, 'rPr'));
    const hidden = fieldCtx.depth > 0 && !fieldCtx.shown[fieldCtx.depth - 1];
    for (const c of elements(rEl)) {
        switch (c.localName) {
            case 'rPr': break;
            case 't': {
                if (hidden) { break; }
                runs.push({ t: 'text', text: c.textContent || '', rPr }); // trim 禁止（xml:space）
                break;
            }
            case 'delText': case 'delInstrText': break;
            case 'instrText': break; // field の呪文は常に非表示
            case 'br': {
                if (hidden) { break; }
                runs.push({ t: 'br', page: attr(c, 'type') === 'page' });
                break;
            }
            case 'cr': if (!hidden) { runs.push({ t: 'br', page: false }); } break;
            case 'tab': if (!hidden) { runs.push({ t: 'tab' }); } break;
            case 'noBreakHyphen': if (!hidden) { runs.push({ t: 'text', text: '‑', rPr }); } break;
            case 'softHyphen': if (!hidden) { runs.push({ t: 'text', text: '­', rPr }); } break;
            case 'sym': {
                if (hidden) { break; }
                const code = parseInt(attr(c, 'char') || '0', 16);
                const base = code >= 0xF000 ? code - 0xF000 : code;
                runs.push({ t: 'text', text: SYM_MAP.get(base) || '•', rPr });
                break;
            }
            case 'fldChar': {
                const type = attr(c, 'fldCharType');
                if (type === 'begin') { fieldCtx.depth++; fieldCtx.shown[fieldCtx.depth - 1] = false; }
                else if (type === 'separate') { if (fieldCtx.depth > 0) { fieldCtx.shown[fieldCtx.depth - 1] = true; } }
                else if (type === 'end') { if (fieldCtx.depth > 0) { fieldCtx.depth--; } }
                break;
            }
            case 'drawing': {
                if (hidden) { break; }
                const img = parseDrawing(c);
                if (img) { runs.push(img); }
                break;
            }
            case 'pict': { // VML fallback: v:textbox > w:txbxContent の本文だけ回収（FR-DXV-09）
                if (hidden) { break; }
                collectTxbx(c, runs, fieldCtx, rPrInherit);
                break;
            }
            case 'AlternateContent': {
                const chosen = resolveAlternateContent(c);
                if (chosen) {
                    // Fallback 直下は w:pict / w:drawing 等 — run 相当として再帰
                    parseRun(chosen, runs, fieldCtx, rPrInherit);
                }
                break;
            }
            case 'ruby': {
                if (hidden) { break; }
                const rt = element(c, 'rt');
                const base = element(c, 'rubyBase');
                const rtRuns = []; const baseRuns = [];
                if (rt) { collectRuns(rt, rtRuns, fieldCtx, rPr); }
                if (base) { collectRuns(base, baseRuns, fieldCtx, rPr); }
                runs.push({ t: 'ruby', base: baseRuns, rt: rtRuns });
                break;
            }
            case 'oMath': case 'oMathPara': runs.push({ t: 'math' }); break;
            case 'lastRenderedPageBreak': break; // 無視（ADRL-0096）
            case 't-': break;
            default: logUnknown(c.localName); break;
        }
    }
}

/** v:textbox > w:txbxContent を再帰で探し、その中の段落テキストを回収 */
function collectTxbx(el, runs, fieldCtx, rPrInherit) {
    for (const c of elements(el)) {
        if (c.localName === 'txbxContent') {
            for (const p of elements(c, 'p')) {
                const inner = [];
                collectRuns(p, inner, { depth: 0, shown: [] }, rPrInherit);
                runs.push({ t: 'textbox', runs: inner });
            }
            continue;
        }
        collectTxbx(c, runs, fieldCtx, rPrInherit);
    }
}

/** w:drawing → image run（inline / anchor）。blip の relId と EMU 寸法 */
function parseDrawing(drawingEl) {
    const inline = element(drawingEl, 'inline');
    const anchorEl = element(drawingEl, 'anchor');
    const holder = inline || anchorEl;
    if (!holder) { return null; }
    const extent = element(holder, 'extent');
    let relId = null;
    (function findBlip(el) {
        for (const c of elements(el)) {
            if (c.localName === 'blip') { relId = attr(c, 'embed'); return; }
            findBlip(c);
            if (relId) { return; }
        }
    })(holder);
    if (!relId) { return null; }
    let align = null;
    if (anchorEl) {
        const posH = element(anchorEl, 'positionH');
        const alignEl = posH && element(posH, 'align');
        align = alignEl ? alignEl.textContent : null;
    }
    return {
        t: 'image', relId,
        cx: extent ? intAttr(extent, 'cx') : null,
        cy: extent ? intAttr(extent, 'cy') : null,
        anchor: !!anchorEl, align,
    };
}

function parseParagraph(pEl) {
    const pPr = parseParaProps(element(pEl, 'pPr'));
    const runs = [];
    collectRuns(pEl, runs, { depth: 0, shown: [] }, null);
    return { t: 'p', pPr, runs };
}

function parseTable(tblEl) {
    const tbl = { t: 'tbl', grid: [], rows: [], tblPr: {} };
    const tblPr = element(tblEl, 'tblPr');
    if (tblPr) {
        tbl.tblPr.hasBorders = !!element(tblPr, 'tblBorders');
        const layout = element(tblPr, 'tblLayout');
        tbl.tblPr.fixed = layout ? attr(layout, 'type') === 'fixed' : false;
    }
    const grid = element(tblEl, 'tblGrid');
    if (grid) { for (const col of elements(grid, 'gridCol')) { tbl.grid.push(intAttr(col, 'w') || 0); } }
    for (const tr of elements(tblEl, 'tr')) {
        const row = { cells: [] };
        for (const tc of elements(tr, 'tc')) {
            const tcPr = element(tc, 'tcPr');
            const cell = { blocks: parseBlocks(tc), gridSpan: 1, vMerge: null, shdFill: null, vAlign: null };
            if (tcPr) {
                const span = element(tcPr, 'gridSpan');
                if (span) { cell.gridSpan = intAttr(span, 'val') || 1; }
                const vm = element(tcPr, 'vMerge');
                if (vm) { cell.vMerge = attr(vm, 'val') || 'continue'; }
                const shd = element(tcPr, 'shd');
                if (shd) { cell.shdFill = attr(shd, 'fill'); }
                const va = element(tcPr, 'vAlign');
                if (va) { cell.vAlign = attr(va, 'val'); }
            }
            row.cells.push(cell);
        }
        tbl.rows.push(row);
    }
    return tbl;
}

/** ブロックコンテナ（body / tc / sdtContent）→ Block[] */
function parseBlocks(container) {
    const blocks = [];
    for (const c of elements(container)) {
        switch (c.localName) {
            case 'p': blocks.push(parseParagraph(c)); break;
            case 'tbl': blocks.push(parseTable(c)); break;
            case 'sdt': {
                const content = element(c, 'sdtContent');
                if (content) { blocks.push(...parseBlocks(content)); } // ブロックレベル sdt も透過
                break;
            }
            case 'sectPr': break; // body 末尾 — parseDocumentXml が扱う
            case 'tcPr': case 'tblPr': case 'tblGrid': case 'bookmarkStart': case 'bookmarkEnd': break;
            default: logUnknown(c.localName); break;
        }
    }
    return blocks;
}

function parseSectPr(sectPrEl) {
    const props = {};
    if (!sectPrEl) { return props; }
    const pgSz = element(sectPrEl, 'pgSz');
    if (pgSz) { props.pgW = intAttr(pgSz, 'w'); props.pgH = intAttr(pgSz, 'h'); }
    const pgMar = element(sectPrEl, 'pgMar');
    if (pgMar) {
        props.marL = intAttr(pgMar, 'left'); props.marR = intAttr(pgMar, 'right');
        props.marT = intAttr(pgMar, 'top'); props.marB = intAttr(pgMar, 'bottom');
    }
    const textDir = element(sectPrEl, 'textDirection');
    if (textDir) { props.textDirection = attr(textDir, 'val'); }
    return props;
}

/**
 * document.xml（parseXml 済み Document）→ DocModel { sections: [{props, blocks}] }。
 * sectPr 分割: pPr 内 sectPr = その段落までが前セクション / body 末尾 = 最終セクション（ADRL-0096）。
 */
export function parseDocumentXml(doc) {
    const root = doc.documentElement; // w:document
    const body = elements(root).find((e) => e.localName === 'body');
    if (!body) { throw new Error('w:body not found'); }
    const sections = [];
    let cur = [];
    for (const c of elements(body)) {
        if (c.localName === 'sectPr') {
            sections.push({ props: parseSectPr(c), blocks: cur });
            cur = [];
            continue;
        }
        if (c.localName === 'p') {
            const p = parseParagraph(c);
            cur.push(p);
            // pPr 内 sectPr = この段落までが前セクション
            const pPrEl = element(c, 'pPr');
            const sect = pPrEl && element(pPrEl, 'sectPr');
            if (sect) {
                sections.push({ props: parseSectPr(sect), blocks: cur });
                cur = [];
            }
            continue;
        }
        if (c.localName === 'tbl') { cur.push(parseTable(c)); continue; }
        if (c.localName === 'sdt') {
            const content = element(c, 'sdtContent');
            if (content) { cur.push(...parseBlocks(content)); }
            continue;
        }
        logUnknown(c.localName);
    }
    if (cur.length > 0) { sections.push({ props: {}, blocks: cur }); }
    if (sections.length === 0) { sections.push({ props: {}, blocks: [] }); }
    return { sections };
}
