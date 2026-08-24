/**
 * viewer-docx/theme.mjs — theme 色・フォント解決（MOD-DocxStyleEngine / FR-DXV-05）
 *
 * clrScheme 12 色 + themeColor 属性マッピング（dark1→dk1 / background1→lt1 等）+
 * themeTint/Shade（hex 0-FF: tint = 白方向補間 / shade = 乗算）。`val="auto"` は黒固定 +
 * 濃色 shd 上のみ白（調査 v2 §4）。フォントは fontScheme major/minor の latin + ea を
 * withJaFallback（viewer-common）でスタック化。
 */
import { element, elements, attr } from '../viewer-common/xml.mjs';
import { withJaFallback } from '../viewer-common/font-fallback.mjs';

const THEME_ATTR_MAP = new Map([
    ['dark1', 'dk1'], ['light1', 'lt1'], ['dark2', 'dk2'], ['light2', 'lt2'],
    ['text1', 'dk1'], ['background1', 'lt1'], ['text2', 'dk2'], ['background2', 'lt2'],
    ['accent1', 'accent1'], ['accent2', 'accent2'], ['accent3', 'accent3'], ['accent4', 'accent4'],
    ['accent5', 'accent5'], ['accent6', 'accent6'], ['hyperlink', 'hlink'], ['followedHyperlink', 'folHlink'],
]);

function findLocal(el, name) {
    for (const c of elements(el)) {
        if (c.localName === name) { return c; }
        const found = findLocal(c, name);
        if (found) { return found; }
    }
    return null;
}

export function parseTheme(themeDoc) {
    const theme = { colors: {}, fonts: { major: { latin: null, ea: null }, minor: { latin: null, ea: null } } };
    if (!themeDoc) { return theme; }
    const scheme = findLocal(themeDoc.documentElement, 'clrScheme');
    if (scheme) {
        for (const c of elements(scheme)) {
            const srgb = element(c, 'srgbClr');
            const sys = element(c, 'sysClr');
            const hex = srgb ? attr(srgb, 'val') : (sys ? attr(sys, 'lastClr') : null);
            if (hex) { theme.colors[c.localName] = hex.toUpperCase(); }
        }
    }
    const fontScheme = findLocal(themeDoc.documentElement, 'fontScheme');
    if (fontScheme) {
        for (const [slot, name] of [['major', 'majorFont'], ['minor', 'minorFont']]) {
            const fs = element(fontScheme, name);
            if (!fs) { continue; }
            const latin = element(fs, 'latin');
            const ea = element(fs, 'ea');
            theme.fonts[slot].latin = latin ? attr(latin, 'typeface') : null;
            theme.fonts[slot].ea = ea ? attr(ea, 'typeface') : null;
        }
    }
    return theme;
}

const clamp255 = (v) => Math.round(Math.min(255, Math.max(0, v)));
const hex2 = (v) => clamp255(v).toString(16).padStart(2, '0').toUpperCase();

/** themeTint / themeShade（hex 文字列 0-FF）を RGB に適用 */
function applyTintShade(hex, tintHex, shadeHex) {
    let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    if (tintHex) {
        const t = parseInt(tintHex, 16) / 255;
        r = r * t + 255 * (1 - t); g = g * t + 255 * (1 - t); b = b * t + 255 * (1 - t);
    }
    if (shadeHex) {
        const s = parseInt(shadeHex, 16) / 255;
        r *= s; g *= s; b *= s;
    }
    return hex2(r) + hex2(g) + hex2(b);
}

/** 濃色判定（auto 色の白抜き用 — 相対輝度の簡易しきい値） */
function isDarkFill(hex) {
    if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) { return false; }
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

/**
 * rPr の色指定 → CSS 色（'#RRGGBB'）| null。
 * ctx.shdFill = 実効の段落/ラン網掛け（auto の白抜き判定に使う）。
 */
export function resolveRunColor(rPr, theme, ctx) {
    if (rPr.themeColor) {
        const key = THEME_ATTR_MAP.get(rPr.themeColor) || rPr.themeColor;
        const base = theme.colors[key];
        if (base) { return '#' + applyTintShade(base, rPr.themeTint, rPr.themeShade); }
    }
    if (rPr.color && rPr.color !== 'auto') { return '#' + rPr.color.toUpperCase(); }
    if (rPr.color === 'auto') {
        return isDarkFill(ctx && ctx.shdFill) ? '#FFFFFF' : '#000000';
    }
    return null;
}

/** rFonts（ascii/ea/asciiTheme/eaTheme）→ font-family CSS（和文フォールバック込み） */
export function fontFamilyCss(fonts, theme) {
    if (!fonts) { return null; }
    const themeSlot = (name) => {
        if (!name) { return null; }
        const slot = name.startsWith('major') ? 'major' : 'minor';
        const kind = /EastAsia/i.test(name) ? 'ea' : 'latin';
        return theme.fonts[slot] ? theme.fonts[slot][kind] : null;
    };
    const ascii = fonts.ascii || themeSlot(fonts.asciiTheme);
    const ea = fonts.ea || themeSlot(fonts.eaTheme) || theme.fonts.minor.ea;
    const families = [];
    if (ascii) { families.push(ascii); }
    if (ea && ea !== ascii) { families.push(ea); }
    if (families.length === 0) { return null; }
    return withJaFallback(families);
}
