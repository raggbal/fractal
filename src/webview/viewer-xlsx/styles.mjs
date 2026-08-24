/**
 * viewer-xlsx/styles.mjs — cellXfs 解決・色 4 形態・寸法（MOD-XlsxStyles / FR-XLV-04/05）
 *
 * 罠の pin（調査 v2 §3）: solid fill は **fgColor が塗り色** / numFmtId 164+ は **ID 検索** /
 * theme 属性 index は workbook 側でスワップ済み配列（0=lt1, 1=dk1, ...）を引く /
 * tint は MS-OI29500 の HLS（HLSMAX=255）。apply フラグ・cellStyleXfs は実務上無視（主要リーダ同等）。
 */
import { parseXml, element, elements, attr, intAttr } from '../viewer-common/xml.mjs';

// BIFF8 レガシー 64 色パレット（styles.xml の indexedColors override があればそちら優先）
export const INDEXED_64 = [
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
    '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
    '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
    '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
    '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
    '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
    '000000', 'FFFFFF', // 64/65 = システム前景/背景
];

// ── HLS tint（MS-OI29500 — 整数 HLS・HLSMAX=255） ──
function rgbToHls(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = Math.floor((max + min) * 255 / (2 * 255) + 0.5) / 255 * 255; // (max+min)/2 の 0..255
    let h = 0, s = 0;
    const L = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = L <= 127.5 ? (d * 255) / (max + min) : (d * 255) / (510 - max - min);
        const rNorm = (max - r) / d, gNorm = (max - g) / d, bNorm = (max - b) / d;
        let hh;
        if (max === r) { hh = bNorm - gNorm; }
        else if (max === g) { hh = 2 + rNorm - bNorm; }
        else { hh = 4 + gNorm - rNorm; }
        h = ((hh * 42.5) + 255) % 255;
    }
    return { h, l: (max + min) / 2, s };
}
function hueToRgbInt(m1, m2, h) {
    h = (h + 255) % 255;
    if (h < 42.5) { return m1 + (m2 - m1) * h / 42.5; }
    if (h < 127.5) { return m2; }
    if (h < 170) { return m1 + (m2 - m1) * (170 - h) / 42.5; }
    return m1;
}
function hlsToRgb(h, l, s) {
    if (s === 0) { return { r: l, g: l, b: l }; }
    const m2 = l <= 127.5 ? l * (255 + s) / 255 : l + s - l * s / 255;
    const m1 = 2 * l - m2;
    return {
        r: hueToRgbInt(m1, m2, h + 85),
        g: hueToRgbInt(m1, m2, h),
        b: hueToRgbInt(m1, m2, h - 85),
    };
}
const hex2 = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0').toUpperCase();

/** hex（# なし）に xlsx tint を適用 → hex（# なし・大文字） */
export function tintColor(hex, tint) {
    if (!tint) { return hex.toUpperCase(); }
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const { h, l, s } = rgbToHls(r, g, b);
    const l2 = tint < 0 ? l * (1 + tint) : l * (1 - tint) + 255 * tint;
    const { r: r2, g: g2, b: b2 } = hlsToRgb(h, l2, s);
    return hex2(r2) + hex2(g2) + hex2(b2);
}

/** color 要素（rgb / theme+tint / indexed / auto）→ '#RRGGBB' | null */
export function resolveColor(colorEl, themeColors, indexedOverride) {
    if (!colorEl) { return null; }
    const rgb = attr(colorEl, 'rgb');
    if (rgb) { return '#' + rgb.slice(-6).toUpperCase(); }
    const themeIdx = intAttr(colorEl, 'theme');
    if (themeIdx !== null) {
        const base = (themeColors || [])[themeIdx];
        if (base) {
            const tint = attr(colorEl, 'tint');
            return '#' + tintColor(base, tint !== null ? parseFloat(tint) : 0);
        }
    }
    const indexed = intAttr(colorEl, 'indexed');
    if (indexed !== null) {
        const palette = indexedOverride || INDEXED_64;
        const hex = palette[indexed];
        return hex ? '#' + hex.toUpperCase() : null;
    }
    if (attr(colorEl, 'auto') === '1') { return '#000000'; }
    return null;
}

export function parseStyles(stylesXml) {
    const out = { numFmts: new Map(), fonts: [], fills: [], borders: [], cellXfs: [], indexedOverride: null };
    if (!stylesXml) { return out; }
    const doc = typeof stylesXml === 'string' ? parseXml(stylesXml) : stylesXml;
    const root = doc.documentElement;
    const numFmts = element(root, 'numFmts');
    if (numFmts) {
        for (const nf of elements(numFmts, 'numFmt')) {
            out.numFmts.set(intAttr(nf, 'numFmtId'), attr(nf, 'formatCode') || 'General');
        }
    }
    const fonts = element(root, 'fonts');
    if (fonts) {
        for (const f of elements(fonts, 'font')) {
            const szEl = element(f, 'sz');
            const nameEl = element(f, 'name');
            out.fonts.push({
                bold: !!element(f, 'b'), italic: !!element(f, 'i'),
                underline: !!element(f, 'u'), strike: !!element(f, 'strike'),
                sizePt: szEl ? parseFloat(attr(szEl, 'val')) : 11,
                colorEl: element(f, 'color'),
                name: nameEl ? attr(nameEl, 'val') : null,
            });
        }
    }
    const fills = element(root, 'fills');
    if (fills) {
        for (const f of elements(fills, 'fill')) {
            const pf = element(f, 'patternFill');
            const type = pf ? attr(pf, 'patternType') : null;
            // solid は **fgColor**（bgColor でない — 定番の罠）
            out.fills.push({ type, fgColorEl: pf ? element(pf, 'fgColor') : null });
        }
    }
    const borders = element(root, 'borders');
    if (borders) {
        for (const b of elements(borders, 'border')) {
            const side = (name) => {
                const el = element(b, name);
                if (!el) { return null; }
                const style = attr(el, 'style');
                if (!style) { return null; }
                return { style, colorEl: element(el, 'color') };
            };
            out.borders.push({ left: side('left'), right: side('right'), top: side('top'), bottom: side('bottom') });
        }
    }
    const cellXfs = element(root, 'cellXfs');
    if (cellXfs) {
        for (const xf of elements(cellXfs, 'xf')) {
            const alignEl = element(xf, 'alignment');
            out.cellXfs.push({
                numFmtId: intAttr(xf, 'numFmtId') ?? 0,
                fontId: intAttr(xf, 'fontId') ?? 0,
                fillId: intAttr(xf, 'fillId') ?? 0,
                borderId: intAttr(xf, 'borderId') ?? 0,
                alignment: alignEl ? {
                    horizontal: attr(alignEl, 'horizontal'),
                    vertical: attr(alignEl, 'vertical'),
                    wrapText: attr(alignEl, 'wrapText') === '1' || attr(alignEl, 'wrapText') === 'true',
                    indent: intAttr(alignEl, 'indent'),
                } : null,
            });
        }
    }
    const colors = element(root, 'colors');
    const indexedColors = colors && element(colors, 'indexedColors');
    if (indexedColors) {
        out.indexedOverride = elements(indexedColors, 'rgbColor').map((c) => (attr(c, 'rgb') || '').slice(-6));
    }
    return out;
}

/** styleIdx（cellXfs index）→ 実効セルスタイル */
export function resolveCellStyle(styleIdx, styles, themeColors) {
    const xf = styles.cellXfs[styleIdx];
    if (!xf) { return { numFmt: 0, font: {}, fill: null, border: {}, alignment: null }; }
    // numFmtId 164+ は **ID 検索**（インデックスでない）・163 以下はビルトイン ID をそのまま返す
    const numFmt = xf.numFmtId >= 164 ? (styles.numFmts.get(xf.numFmtId) || 'General') : xf.numFmtId;
    const fontDef = styles.fonts[xf.fontId] || {};
    const font = {
        bold: !!fontDef.bold, italic: !!fontDef.italic, underline: !!fontDef.underline, strike: !!fontDef.strike,
        sizePt: fontDef.sizePt || 11, name: fontDef.name,
        color: resolveColor(fontDef.colorEl, themeColors, styles.indexedOverride),
    };
    const fillDef = styles.fills[xf.fillId];
    const fill = (fillDef && fillDef.type === 'solid')
        ? resolveColor(fillDef.fgColorEl, themeColors, styles.indexedOverride)
        : null;
    const borderDef = styles.borders[xf.borderId] || {};
    const border = {};
    for (const sideName of ['left', 'right', 'top', 'bottom']) {
        const s = borderDef[sideName];
        if (s) { border[sideName] = { style: s.style, color: resolveColor(s.colorEl, themeColors, styles.indexedOverride) || '#000000' }; }
    }
    return { numFmt, font, fill, border, alignment: xf.alignment };
}

/** セル > 行 > 列 の既定スタイル連鎖（FR-XLV-04） */
export function effectiveStyleIdx(cellS, rowS, colS) {
    if (cellS !== null && cellS !== undefined) { return cellS; }
    if (rowS !== null && rowS !== undefined) { return rowS; }
    if (colS !== null && colS !== undefined) { return colS; }
    return null;
}

// ── 寸法（FR-XLV-05） ──
/** ECMA-376 §18.3.1.13 の読み取り式 + パディング 5px（8.43 @ MDW7 → 64px の既知ペア） */
export function colWidthPx(width, mdw) {
    if (!width) { return 0; }
    const charPx = Math.trunc(((256 * width + Math.trunc(128 / mdw)) / 256) * mdw);
    return charPx + 5;
}
export function rowHeightPx(pt) {
    return Math.round(pt * 4 / 3);
}
/** MDW を実測（measure(text)→px の注入 seam。失敗時は Calibri 11 相当の 7px fallback） */
export function measureMdw(measure) {
    try {
        let max = 0;
        for (const d of '0123456789') { max = Math.max(max, measure(d)); }
        return max > 0 ? Math.ceil(max) : 7;
    } catch {
        return 7;
    }
}
