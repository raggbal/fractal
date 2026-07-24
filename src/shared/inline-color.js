'use strict';

/**
 * inline-color.js — インライン文字色の共有 core（sprint 20260724-160000-inline-text-color）
 *
 * md editor（editor.js parseInline / collectCharStyles）と outliner（outliner-cell.js
 * renderInlineText）の 2 パーサが**同一の**色構文定義とサニタイズ検証を使うための共有モジュール。
 * 2 パーサでエンコードを割らない（ADRL-OUTLINER-COLOR-ENCODING-UNIFY）ため、色 span の
 * 認識・生成・検証をここ 1 箇所に集約する。
 *
 * 保存エンコード: `<span style="color:#hex">text</span>`（ADRL-INLINE-COLOR-ENCODING）。
 * サニタイズ: color の hex 値のみ許可する閉じた allowlist（ADRL-INLINE-HTML-SANITIZE）。
 *   名前色 / rgb() / 複合 style / 他属性 は通さない（保存は hex 直値のみのため不要 + XSS 面を最小化）。
 *
 * 参照元:
 *   - editor.js: parseInline（protect/restore）+ collectCharStyles（extractColorFromStyle）+ applyInlineStyles（wrapColorSpan）
 *   - outliner-cell.js: renderInlineText（protect/restore）
 *   - notes-file-panel.js / picker: パレット hex
 */

// 安全な色値 = #RGB / #RRGGBB の hex のみ（閉じた allowlist）。
// 名前色・rgb()・hsl() は保存しないので通さない。大文字は許可（内部で小文字化して判定）。
function isSafeColorValue(v) {
    if (typeof v !== 'string') { return false; }
    var s = v.trim().toLowerCase();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s);
}

// 色 span の認識正規表現（color:#hex のみ・他プロパティを許さない）。
// `<span style="color:#ef4444">x</span>` にマッチ。`color:#ef4444;background:...` のような
// 複合 style は `">` の直前に他プロパティが挟まるためマッチしない（＝ passthrough されずエスケープ）。
// style 属性値のクォートは " のみ（生成側も " で出す）。空白は color: の前後で許容。
// キャプチャ: [1]=hex, [2]=inner。inner は非貪欲で最初の </span> まで（ネストした span は非対応=単純運用）。
function makeColorSpanRe() {
    return /<span style="color:\s*(#[0-9a-fA-F]{3,6})\s*;?\s*">([\s\S]*?)<\/span>/g;
}
// 使い捨てでない共有インスタンスは lastIndex 状態を持つので、呼び出し側は都度 makeColorSpanRe() を使うこと。

// rgb(r,g,b) / rgba(r,g,b,a) を #rrggbb に変換（a は無視）。範囲外は null。
function rgbToHex(rgbStr) {
    var m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(rgbStr.trim());
    if (!m) { return null; }
    var parts = [m[1], m[2], m[3]].map(function (n) { return parseInt(n, 10); });
    for (var i = 0; i < 3; i++) { if (parts[i] < 0 || parts[i] > 255) { return null; } }
    return '#' + parts.map(function (n) {
        var h = n.toString(16);
        return h.length === 1 ? '0' + h : h;
    }).join('');
}

// style 属性文字列（DOM の element.style.cssText 等）から安全な hex color を抽出（無ければ null）。
// 単一 color プロパティのみを認める（複合 style は null = 着色しない）。
// ブラウザは execCommand('foreColor') で `color: rgb(...)` に正規化するため rgb() も受けて hex 化する
// （保存は常に #hex 直値。DOM 読み取り時の正規化差を吸収）。
function extractColorFromStyle(styleStr) {
    if (typeof styleStr !== 'string') { return null; }
    var s = styleStr.trim();
    // 末尾セミコロンを除去して 1 プロパティか判定
    var body = s.replace(/;\s*$/, '');
    var m = /^color:\s*(.+)$/.exec(body);
    if (!m) { return null; }
    var val = m[1].trim();
    // hex そのまま
    if (isSafeColorValue(val)) { return val.toLowerCase(); }
    // rgb()/rgba() → hex
    if (/^rgba?\(/.test(val)) {
        var hex = rgbToHex(val);
        return (hex && isSafeColorValue(hex)) ? hex : null;
    }
    return null; // 名前色・複合・危険値は着色しない
}

// text を色 span で包む（hex が安全でなければ text をそのまま返す = 無着色）。
function wrapColorSpan(text, hex) {
    if (!isSafeColorValue(hex)) { return text; }
    return '<span style="color:' + hex.trim().toLowerCase() + '">' + text + '</span>';
}

// html 文字列中の色 span を外して inner だけにする（1 段のみ）。
function stripColorSpan(html) {
    if (typeof html !== 'string') { return html; }
    return html.replace(makeColorSpanRe(), '$2');
}

var _api = {
    isSafeColorValue: isSafeColorValue,
    makeColorSpanRe: makeColorSpanRe,
    extractColorFromStyle: extractColorFromStyle,
    wrapColorSpan: wrapColorSpan,
    stripColorSpan: stripColorSpan,
};

// CommonJS + global 両対応（webview では window.InlineColor として使用）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.InlineColor = _api;
}
