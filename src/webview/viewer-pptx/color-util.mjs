/*
 * fractal original（sprint 20260823-165314 / ADR-0010 — 依存置換）。
 * tinycolor2 の使用 API（本移植内の 26 呼び出しが使う範囲のみ）互換の最小実装:
 *   tinycolor(input).toHsl() / .toHex() / .toHex8() / .setAlpha(a)
 *   input: '#RGB' '#RRGGBB' '#RRGGBBAA' 'RRGGBB'（# なし可） / {h(0-360), s(0-1), l(0-1), a}
 * quirk 保持: toHex/toHex8 は **# なし**で返す（upstream 消費コードが '#'+hex を組む前提）。
 */

function hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
        r: hueToRgb(p, q, h + 1 / 3) * 255,
        g: hueToRgb(p, q, h) * 255,
        b: hueToRgb(p, q, h - 1 / 3) * 255,
    };
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4;
        }
        h *= 60;
    }
    return { h, s, l };
}

const hex2 = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

class TColor {
    constructor(input) {
        this.r = 0; this.g = 0; this.b = 0; this.a = 1;
        this.ok = false;
        if (typeof input === 'string') {
            let s = input.trim().replace(/^#/, '');
            if (/^[0-9a-fA-F]{3}$/.test(s)) { s = s.split('').map((c) => c + c).join(''); }
            if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
                this.r = parseInt(s.slice(0, 2), 16);
                this.g = parseInt(s.slice(2, 4), 16);
                this.b = parseInt(s.slice(4, 6), 16);
                if (s.length === 8) { this.a = parseInt(s.slice(6, 8), 16) / 255; }
                this.ok = true;
            }
        } else if (input && typeof input === 'object' && input.h !== undefined) {
            const { r, g, b } = hslToRgb(Number(input.h) || 0, Math.min(1, Math.max(0, Number(input.s) || 0)), Math.min(1, Math.max(0, Number(input.l) || 0)));
            this.r = r; this.g = g; this.b = b;
            this.a = input.a === undefined ? 1 : Number(input.a);
            this.ok = true;
        }
    }
    toHsl() {
        const { h, s, l } = rgbToHsl(this.r, this.g, this.b);
        return { h, s, l, a: this.a };
    }
    setAlpha(a) { this.a = Math.min(1, Math.max(0, Number(a))); return this; }
    toHex() { return hex2(this.r) + hex2(this.g) + hex2(this.b); }
    toHex8() { return this.toHex() + hex2(this.a * 255); }
}

export default function tinycolor(input) { return new TColor(input); }
