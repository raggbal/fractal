/**
 * wholeWord 検索の多言語境界（FR-MLG-02 / ADRL-0080・sprint 20260818-183407）
 *
 * 規則:
 *  1. クエリが CJK 文字（Han / Hiragana / Katakana / Hangul script）を含む
 *     → wholeWord 指定を無視して部分一致（CJK に語境界は存在しない — VS Code 検索と同等の実用挙動）。
 *  2. それ以外 → Unicode property lookaround（(?<![\p{L}\p{N}_]) / (?![\p{L}\p{N}_])・u フラグ）で
 *     境界判定（旧 \b は ASCII \w 基準で é 末尾等が false negative）。
 *  3. u フラグで不正になる pattern（useRegex のユーザー正規表現の \- 等）は throw させず
 *     従来の \b 形へ fallback（既存検索をクラッシュさせない — TC-MLG-06）。
 *
 * 単一真実の共有方式（inapp-link-utils.js precedent）:
 *  - host ts: require('./whole-word')（notes-file-manager.ts buildSearchRegex）
 *  - webview: 本番 inline（notesWebviewContent.ts）+ ハーネス（build-standalone-notes.js）で
 *    window.WholeWord として先行ロード（notes-file-panel.js の 2 サイトが参照）
 *  - CLI: ai_skills/fractal-search/scripts/fractal-search.mjs はゼロ install 配布のため
 *    ミラー実装（extension⇄CLI 一致 TC = TC-MLG-04b が番人・ADRL-0059 同型）
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.WholeWord = api;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    /** クエリに CJK（語境界の無い script）が含まれるか */
    function hasCjkQuery(query) {
        try {
            return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query || '');
        } catch (e) {
            return false;
        }
    }

    /**
     * wholeWord 用 RegExp を構築する（wholeWord ON の時だけ呼ぶ）。
     * @param {string} pattern escape 済み（または useRegex の生）パターン。capture group を含んでよい
     * @param {string} query   ユーザーの生クエリ（CJK 判定用 — pattern でなく query で判定する）
     * @param {string} baseFlags 'g' / 'gi' / 'i' / '' 等（u は付けずに渡す）
     * @returns {RegExp}
     */
    function buildWholeWordRegex(pattern, query, baseFlags) {
        if (hasCjkQuery(query)) {
            // CJK 含みは素通し（部分一致）— 境界を付けると CJK 連続文中で一切ヒットしなくなる
            return new RegExp(pattern, baseFlags);
        }
        try {
            return new RegExp(
                '(?<![\\p{L}\\p{N}_])' + pattern + '(?![\\p{L}\\p{N}_])',
                (baseFlags || '') + 'u'
            );
        } catch (e) {
            // u-mode で不正な pattern（useRegex の \- 等）は従来 \b へ fallback
            return new RegExp('\\b' + pattern + '\\b', baseFlags);
        }
    }

    return { hasCjkQuery: hasCjkQuery, buildWholeWordRegex: buildWholeWordRegex };
});
