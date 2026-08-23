/**
 * 横断検索の ext: クエリ構文（FR-SEF-01 / sprint 20260822-203347・ADRL-ext-query-syntax）
 *
 * 規則:
 *  1. クエリ**先頭のトークンのみ** `ext:<非空白値>` をフィルタとして認識し body から strip する。
 *     キーワード自体は大文字小文字を無視し全角形（ｅｘｔ：）も文字クラスで直接マッチ
 *     （クエリ全体を NFKC しない — 既存 3 段の生テキスト regex 対称性 = FR-DS-07 裁定を不変に保つ）。
 *     先頭以外の `ext:` はリテラル検索語（「ext:」自体を検索する逃げ道）。
 *  2. 値のみ NFKC → 小文字化 → カンマ分割 → 先頭 `.` strip → 空要素除去。
 *     有効値 0 個（`ext:.` 等）はフィルタとして認識せずリテラル縮退（silent 全件非表示を作らない）。
 *  3. body は strip 後の残りを trim するだけ（一切の正規化をしない）。
 *
 * 単一真実の共有方式（whole-word.js / ADRL-0080 precedent）:
 *  - host ts: require('./search-ext-filter')（notes-file-manager.ts の 4 段ゲート）
 *  - webview: 本番 inline（notesWebviewContent.ts）+ ハーネス（build-standalone-notes.js）で
 *    window.SearchExtFilter として notes-file-panel.js より前にロード
 *  - CLI: ai_skills/fractal-search/scripts/fractal-search.mjs はゼロ install 配布のため
 *    ミラー実装（extension⇄CLI 一致 TC = TC-SEF-06 が番人・ADRL-0059 同型）
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.SearchExtFilter = api;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    /** 先頭トークン: ext:<非空白値> + (空白 or 終端)。キーワードは大小文字/全角を文字クラスで許容 */
    var HEAD_RE = /^\s*[eｅ][xｘ][tｔ][:：](\S+)(\s+|$)/iu;

    /**
     * 生クエリ → { body, exts }。exts === null はフィルタなし（リテラル/縮退含む）。
     * body は strip 後を trim するのみ（NFKC しない）。
     */
    function parseExtQuery(raw) {
        var q = String(raw == null ? '' : raw);
        var m = q.match(HEAD_RE);
        if (!m) {
            return { body: q.trim(), exts: null };
        }
        var exts = m[1].normalize('NFKC').toLowerCase()
            .split(',')
            .map(function (s) { return s.replace(/^\./, '').trim(); })
            .filter(function (s) { return s.length > 0; });
        if (exts.length === 0) {
            // 縮退: 有効値 0 個はリテラル扱い（トークンを body に残す — FR-SEF-01）
            return { body: q.trim(), exts: null };
        }
        return { body: q.slice(m[0].length).trim(), exts: exts };
    }

    /** 拡張子（. なし）が exts にマッチするか。exts == null は常に true（フィルタなし） */
    function matchesExt(ext, exts) {
        if (exts == null) { return true; }
        var e = String(ext == null ? '' : ext).toLowerCase();
        if (e.length === 0) { return false; }   // 拡張子なしはどの指定にも不一致（スコープ境界）
        return exts.indexOf(e) !== -1;
    }

    /**
     * パス/ファイル名 → . なし小文字拡張子（'' = 拡張子なし）。
     * webview に path モジュールが無いため自前実装。dotfile（.gitignore）は '' 扱い。
     */
    function extOfName(name) {
        var s = String(name == null ? '' : name);
        var slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        var base = slash >= 0 ? s.slice(slash + 1) : s;
        var dot = base.lastIndexOf('.');
        if (dot <= 0) { return ''; }            // 先頭 . のみ（dotfile）/ . なし
        return base.slice(dot + 1).toLowerCase();
    }

    return {
        parseExtQuery: parseExtQuery,
        matchesExt: matchesExt,
        extOfName: extOfName,
    };
});
