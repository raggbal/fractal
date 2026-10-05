/**
 * viewer-common/font-fallback.mjs — 和文フォント別名フォールバック表（docx/pptx 共用）
 *
 * 文書指定フォントが閲覧 OS に無い場合の破綻を防ぐ: 指定名 → OS 別名列 + 総称で font-family を組む。
 * kind context 間依存を作らないため Common に置く（ddd/index.md）。
 */

const JA_ALIASES = new Map([
    ['游明朝', ['Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'MS Mincho']],
    ['Yu Mincho', ['游明朝', 'Hiragino Mincho ProN', 'MS Mincho']],
    ['游ゴシック', ['Yu Gothic', 'YuGothic', 'Hiragino Kaku Gothic ProN', 'Meiryo']],
    ['Yu Gothic', ['游ゴシック', 'Hiragino Kaku Gothic ProN', 'Meiryo']],
    ['ＭＳ 明朝', ['MS Mincho', 'Hiragino Mincho ProN', 'Yu Mincho']],
    ['MS Mincho', ['ＭＳ 明朝', 'Hiragino Mincho ProN']],
    ['ＭＳ ゴシック', ['MS Gothic', 'Hiragino Kaku Gothic ProN', 'Yu Gothic']],
    ['MS Gothic', ['ＭＳ ゴシック', 'Hiragino Kaku Gothic ProN']],
    ['ＭＳ Ｐ明朝', ['MS PMincho', 'Hiragino Mincho ProN']],
    ['ＭＳ Ｐゴシック', ['MS PGothic', 'Hiragino Kaku Gothic ProN', 'Meiryo']],
    ['メイリオ', ['Meiryo', 'Hiragino Kaku Gothic ProN', 'Yu Gothic']],
    ['Meiryo', ['メイリオ', 'Hiragino Kaku Gothic ProN']],
]);

const GENERIC_SERIF = /明朝|mincho|serif/i;

// 太さ・用途の接尾語（"Amazon Ember Display" / "Segoe UI Semibold" / "游ゴシック Light"）。
// 指定名が無い環境では同じファミリーの基本名に寄せる（字幅が近く、折り返し位置のずれが小さい）
const STYLE_SUFFIX = /^(.+?)\s+(?:Display|Text|Light|Semilight|Semibold|Medium|Bold|Black|Heavy|Thin|Condensed|ExtraLight|UltraLight|ExtraBold|Regular)$/i;
function withBaseNames(name) {
    const out = [name];
    let m;
    while ((m = STYLE_SUFFIX.exec(out[out.length - 1]))) { out.push(m[1]); }
    return out;
}

// 名前は文書由来の非信頼入力。" と \ をエスケープして引用の外へ出られないようにする
const quote = (name) => (/[^a-zA-Z0-9-]/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : name);

/**
 * families（文書指定のフォント名列。falsy は無視）→ CSS font-family 文字列。
 * 各名に（接尾語を外した基本名と）既知の別名列を展開し、末尾に総称（明朝系なら serif / 他は sans-serif）を付ける。
 */
export function withJaFallback(families) {
    const seen = new Set();
    const out = [];
    let serif = false;
    for (const f of families || []) {
        if (!f) { continue; }
        if (GENERIC_SERIF.test(f)) { serif = true; }
        for (const name of withBaseNames(f).flatMap((n) => [n, ...(JA_ALIASES.get(n) || [])])) {
            if (seen.has(name)) { continue; }
            seen.add(name);
            out.push(quote(name));
        }
    }
    out.push(serif ? 'serif' : 'sans-serif');
    return out.join(', ');
}
