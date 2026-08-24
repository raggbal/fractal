/**
 * viewer-xlsx/sheet-parse.mjs — シート XML → SheetModel の 2 経路 + seam（ADRL-0095 / FR-XLV-07）
 *
 * DOMParser 経路（正確・小〜中ファイル）と文字列走査経路（大ファイル — DOM メモリ 4〜8 倍を回避）。
 * **両経路の出力 SheetModel は同一契約**（TC-XLV-08 の deep-equal が番人 — 無いと切替後だけ
 * 壊れるバグを素通しする）。選択は pure 関数 pickSheetParser(xmlByteLength)。
 *
 * 設計からの簡素化（generator 記録）: 文字列走査経路の「可視行のみ遅延フルパース」は初版では
 * eager（等値契約が単純になる）。行 DOM 化のコストは仮想グリッド側が可視域に絞る（NFR-VEX-03）。
 *
 * SheetModel = { rows: Map<rowIdx0, {cells: Map<colIdx0, Cell>, ht, hidden, styleIdx}>,
 *   merges: [{r1,c1,r2,c2}], cols: [{min,max,width,hidden,styleIdx}],
 *   defaultRowHeight, defaultColWidth, zeroHeight, dimension: {rows, cols} }
 * Cell = { v: string|null, t: 'n'|'s'|'str'|'b'|'e'|'inlineStr'|'d', s: styleIdx|null, f: 式|null }
 */
import { parseXml, element, elements, attr } from '../viewer-common/xml.mjs';

export const SHEET_PARSE_THRESHOLD = 8 * 1024 * 1024; // 8MB（ADRL-0095 — 変わりうる定数）

export function pickSheetParser(xmlByteLength) {
    return xmlByteLength > SHEET_PARSE_THRESHOLD ? 'stream' : 'dom';
}

/** 'C5' → {row0, col0} */
export function cellRef(ref) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
    if (!m) { return null; }
    let col = 0;
    for (const ch of m[1].toUpperCase()) { col = col * 26 + (ch.charCodeAt(0) - 64); }
    return { row0: parseInt(m[2], 10) - 1, col0: col - 1 };
}

function emptyModel() {
    return {
        rows: new Map(), merges: [], cols: [],
        defaultRowHeight: null, defaultColWidth: null, zeroHeight: false,
        dimension: { rows: 0, cols: 0 },
        hyperlinks: [],      // [{row0, col0, relId, location, display}]（TASK-16 で追加 — 両経路対称）
        autoFilterRef: null, // 'A1:C10'（漏斗アイコン表示用）
    };
}

function finalizeDimension(model) {
    let maxRow = -1, maxCol = -1;
    for (const [ri, row] of model.rows) {
        if (row.cells.size > 0 || row.ht != null || row.hidden) { maxRow = Math.max(maxRow, ri); }
        for (const ci of row.cells.keys()) { maxCol = Math.max(maxCol, ci); }
    }
    for (const m of model.merges) { maxRow = Math.max(maxRow, m.r2); maxCol = Math.max(maxCol, m.c2); }
    // dimension 要素は欠落・不正がありうるため常に実測補正（viewer-xlsx.md）
    model.dimension = { rows: maxRow + 1, cols: maxCol + 1 };
    return model;
}

function pushCellCommon(rowEntry, colIdx, t, v, s, f) {
    rowEntry.cells.set(colIdx, { v, t: t || 'n', s, f });
}

// ── 経路 1: DOMParser ───────────────────────────────────────────────────
export function parseSheetDom(xmlText) {
    const doc = parseXml(xmlText);
    const model = emptyModel();
    const ws = doc.documentElement;
    const fmt = element(ws, 'sheetFormatPr');
    if (fmt) {
        const drh = attr(fmt, 'defaultRowHeight');
        if (drh !== null) { model.defaultRowHeight = parseFloat(drh); }
        const dcw = attr(fmt, 'defaultColWidth');
        if (dcw !== null) { model.defaultColWidth = parseFloat(dcw); }
        model.zeroHeight = attr(fmt, 'zeroHeight') === '1' || attr(fmt, 'zeroHeight') === 'true';
    }
    const colsEl = element(ws, 'cols');
    if (colsEl) {
        for (const col of elements(colsEl, 'col')) {
            model.cols.push({
                min: parseInt(attr(col, 'min'), 10), max: parseInt(attr(col, 'max'), 10),
                width: attr(col, 'width') !== null ? parseFloat(attr(col, 'width')) : null,
                hidden: attr(col, 'hidden') === '1' || attr(col, 'hidden') === 'true' || attr(col, 'width') === '0',
                styleIdx: attr(col, 'style') !== null ? parseInt(attr(col, 'style'), 10) : null,
            });
        }
    }
    const sheetData = element(ws, 'sheetData');
    let prevRow = -1;
    if (sheetData) {
        for (const rowEl of elements(sheetData, 'row')) {
            const rAttr = attr(rowEl, 'r');
            const rowIdx = rAttr !== null ? parseInt(rAttr, 10) - 1 : prevRow + 1; // r 省略 = 直前 +1
            prevRow = rowIdx;
            const rowEntry = {
                cells: new Map(),
                ht: attr(rowEl, 'ht') !== null ? parseFloat(attr(rowEl, 'ht')) : null,
                hidden: attr(rowEl, 'hidden') === '1' || attr(rowEl, 'hidden') === 'true',
                styleIdx: (attr(rowEl, 'customFormat') === '1' && attr(rowEl, 's') !== null) ? parseInt(attr(rowEl, 's'), 10) : null,
            };
            let prevCol = -1;
            for (const cEl of elements(rowEl, 'c')) {
                const ref = attr(cEl, 'r');
                const parsed = ref !== null ? cellRef(ref) : null;
                const colIdx = parsed ? parsed.col0 : prevCol + 1; // r 省略 = 直前 +1
                prevCol = colIdx;
                const t = attr(cEl, 't') || 'n';
                const s = attr(cEl, 's') !== null ? parseInt(attr(cEl, 's'), 10) : null;
                const fEl = element(cEl, 'f');
                let v = null;
                if (t === 'inlineStr') {
                    const is = element(cEl, 'is');
                    v = is ? richText(is) : '';
                } else {
                    const vEl = element(cEl, 'v');
                    v = vEl ? vEl.textContent : null;
                }
                pushCellCommon(rowEntry, colIdx, t, v, s, fEl ? fEl.textContent : null);
            }
            model.rows.set(rowIdx, rowEntry);
        }
    }
    const mergesEl = element(ws, 'mergeCells');
    if (mergesEl) {
        for (const mc of elements(mergesEl, 'mergeCell')) {
            const ref = attr(mc, 'ref') || '';
            const [a, b] = ref.split(':');
            const p1 = cellRef(a); const p2 = b ? cellRef(b) : p1;
            if (p1 && p2) { model.merges.push({ r1: p1.row0, c1: p1.col0, r2: p2.row0, c2: p2.col0 }); }
        }
    }
    const hlsEl = element(ws, 'hyperlinks');
    if (hlsEl) {
        for (const hl of elements(hlsEl, 'hyperlink')) {
            const pos = cellRef(attr(hl, 'ref') || '');
            if (pos) {
                model.hyperlinks.push({ row0: pos.row0, col0: pos.col0, relId: attr(hl, 'id'), location: attr(hl, 'location'), display: attr(hl, 'display') });
            }
        }
    }
    const afEl = element(ws, 'autoFilter');
    if (afEl) { model.autoFilterRef = attr(afEl, 'ref'); }
    return finalizeDimension(model);
}

/** si / is 要素 → rich run 連結 + rPh（ふりがな）除去（正典 doc-text-extract と同方針） */
export function richText(siEl) {
    const direct = element(siEl, 't');
    if (direct && elements(siEl, 'r').length === 0) { return direct.textContent || ''; }
    let out = '';
    for (const r of elements(siEl, 'r')) { // rPh / phoneticPr は走査対象外（除去）
        const t = element(r, 't');
        if (t) { out += t.textContent || ''; }
    }
    return out;
}

// ── 経路 2: 文字列走査（大ファイル — DOM 非生成） ────────────────────────
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;

function parseAttrs(tag) {
    const out = {};
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(tag)) !== null) {
        const name = m[1];
        const local = name.indexOf(':') === -1 ? name : name.slice(name.indexOf(':') + 1);
        out[local] = decodeEntities(m[2]);
    }
    return out;
}

function decodeEntities(s) {
    if (s.indexOf('&') === -1) { return s; }
    return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
        if (body[0] === '#') {
            const cp = (body[1] === 'x' || body[1] === 'X') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
        }
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body] || whole;
    });
}

/** `<name ...>`（prefix 許容）の開始タグを src[from] 以降で探す → {start, tagEnd, selfClose, attrs} */
function findTag(src, name, from, until) {
    const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?=[\\s/>])`, 'g');
    re.lastIndex = from;
    const m = re.exec(src);
    if (!m || (until !== undefined && m.index >= until)) { return null; }
    const tagEnd = src.indexOf('>', m.index);
    const selfClose = src[tagEnd - 1] === '/';
    return { start: m.index, tagEnd, selfClose, attrs: parseAttrs(src.slice(m.index, tagEnd)) };
}
/** 対応する閉じタグ位置（prefix 許容・ネスト無し前提の要素用） */
function closeOf(src, name, from) {
    const re = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`, 'g');
    re.lastIndex = from;
    const m = re.exec(src);
    return m ? { start: m.index, end: re.lastIndex } : null;
}
function innerText(src, name, from, until) {
    const t = findTag(src, name, from, until);
    if (!t || t.selfClose) { return null; }
    const close = closeOf(src, name, t.tagEnd);
    if (!close || (until !== undefined && close.start > until)) { return null; }
    return decodeEntities(src.slice(t.tagEnd + 1, close.start));
}

export function parseSheetStream(xmlText) {
    const src = String(xmlText);
    const model = emptyModel();
    const fmt = findTag(src, 'sheetFormatPr', 0);
    if (fmt) {
        if (fmt.attrs.defaultRowHeight !== undefined) { model.defaultRowHeight = parseFloat(fmt.attrs.defaultRowHeight); }
        if (fmt.attrs.defaultColWidth !== undefined) { model.defaultColWidth = parseFloat(fmt.attrs.defaultColWidth); }
        model.zeroHeight = fmt.attrs.zeroHeight === '1' || fmt.attrs.zeroHeight === 'true';
    }
    // cols
    const colsTag = findTag(src, 'cols', 0);
    if (colsTag && !colsTag.selfClose) {
        const colsClose = closeOf(src, 'cols', colsTag.tagEnd);
        let p = colsTag.tagEnd;
        for (; ;) {
            const col = findTag(src, 'col', p, colsClose ? colsClose.start : undefined);
            if (!col) { break; }
            model.cols.push({
                min: parseInt(col.attrs.min, 10), max: parseInt(col.attrs.max, 10),
                width: col.attrs.width !== undefined ? parseFloat(col.attrs.width) : null,
                hidden: col.attrs.hidden === '1' || col.attrs.hidden === 'true' || col.attrs.width === '0',
                styleIdx: col.attrs.style !== undefined ? parseInt(col.attrs.style, 10) : null,
            });
            p = col.tagEnd + 1;
        }
    }
    // sheetData 内の row 走査
    const sd = findTag(src, 'sheetData', 0);
    if (sd && !sd.selfClose) {
        const sdClose = closeOf(src, 'sheetData', sd.tagEnd);
        const sdEnd = sdClose ? sdClose.start : src.length;
        let p = sd.tagEnd;
        let prevRow = -1;
        for (; ;) {
            const row = findTag(src, 'row', p, sdEnd);
            if (!row) { break; }
            const rowIdx = row.attrs.r !== undefined ? parseInt(row.attrs.r, 10) - 1 : prevRow + 1;
            prevRow = rowIdx;
            const rowEntry = {
                cells: new Map(),
                ht: row.attrs.ht !== undefined ? parseFloat(row.attrs.ht) : null,
                hidden: row.attrs.hidden === '1' || row.attrs.hidden === 'true',
                styleIdx: (row.attrs.customFormat === '1' && row.attrs.s !== undefined) ? parseInt(row.attrs.s, 10) : null,
            };
            let rowBodyEnd = row.tagEnd + 1;
            if (!row.selfClose) {
                const rc = closeOf(src, 'row', row.tagEnd);
                rowBodyEnd = rc ? rc.start : sdEnd;
                let cp = row.tagEnd;
                let prevCol = -1;
                for (; ;) {
                    const c = findTag(src, 'c', cp, rowBodyEnd);
                    if (!c) { break; }
                    const parsed = c.attrs.r !== undefined ? cellRef(c.attrs.r) : null;
                    const colIdx = parsed ? parsed.col0 : prevCol + 1;
                    prevCol = colIdx;
                    const t = c.attrs.t || 'n';
                    const s = c.attrs.s !== undefined ? parseInt(c.attrs.s, 10) : null;
                    let cellEnd = c.tagEnd + 1;
                    let v = null; let f = null;
                    if (!c.selfClose) {
                        const cc = closeOf(src, 'c', c.tagEnd);
                        cellEnd = cc ? cc.end : cellEnd;
                        const bodyEnd = cc ? cc.start : cellEnd;
                        f = innerText(src, 'f', c.tagEnd, bodyEnd);
                        if (t === 'inlineStr') {
                            // is 内の全 <t>（rPh は除外 — rPh 内の t を拾わないため rPh ブロックを除去してから）
                            const isBody = src.slice(c.tagEnd, bodyEnd).replace(/<(?:[\w.-]*:)?rPh[\s\S]*?<\/(?:[\w.-]*:)?rPh>/g, '');
                            let tt = '';
                            const tRe = /<(?:[\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]*:)?t>/g;
                            let tm;
                            while ((tm = tRe.exec(isBody)) !== null) { tt += decodeEntities(tm[1]); }
                            v = tt;
                        } else {
                            v = innerText(src, 'v', c.tagEnd, bodyEnd);
                        }
                    }
                    pushCellCommon(rowEntry, colIdx, t, v, s, f);
                    cp = cellEnd;
                }
            }
            model.rows.set(rowIdx, rowEntry);
            p = rowBodyEnd;
        }
    }
    // merges
    const mcTag = findTag(src, 'mergeCells', 0);
    if (mcTag && !mcTag.selfClose) {
        const mcClose = closeOf(src, 'mergeCells', mcTag.tagEnd);
        let p = mcTag.tagEnd;
        for (; ;) {
            const mc = findTag(src, 'mergeCell', p, mcClose ? mcClose.start : undefined);
            if (!mc) { break; }
            const [a, b] = String(mc.attrs.ref || '').split(':');
            const p1 = cellRef(a); const p2 = b ? cellRef(b) : p1;
            if (p1 && p2) { model.merges.push({ r1: p1.row0, c1: p1.col0, r2: p2.row0, c2: p2.col0 }); }
            p = mc.tagEnd + 1;
        }
    }
    const hlsTag = findTag(src, 'hyperlinks', 0);
    if (hlsTag && !hlsTag.selfClose) {
        const hlsClose = closeOf(src, 'hyperlinks', hlsTag.tagEnd);
        let p = hlsTag.tagEnd;
        for (; ;) {
            const hl = findTag(src, 'hyperlink', p, hlsClose ? hlsClose.start : undefined);
            if (!hl) { break; }
            const pos = cellRef(hl.attrs.ref || '');
            if (pos) {
                model.hyperlinks.push({ row0: pos.row0, col0: pos.col0, relId: hl.attrs.id, location: hl.attrs.location, display: hl.attrs.display });
            }
            p = hl.tagEnd + 1;
        }
    }
    const afTag = findTag(src, 'autoFilter', 0);
    if (afTag) { model.autoFilterRef = afTag.attrs.ref || null; }
    return finalizeDimension(model);
}

/** バイト長で経路を選ぶ統合入口 */
export function parseSheet(xmlText) {
    // TextEncoder は重いので長さ近似（UTF-8 で ASCII 主体の XML — 2 倍係数で安全側）
    const approxBytes = xmlText.length;
    return pickSheetParser(approxBytes) === 'dom' ? parseSheetDom(xmlText) : parseSheetStream(xmlText);
}
