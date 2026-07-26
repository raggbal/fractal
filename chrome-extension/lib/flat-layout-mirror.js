/**
 * flat-layout-mirror — Fractal 本体のフラットレイアウト解決のミラー（chrome-extension 用）
 *
 * 正典: fractal/src/shared/flat-layout.ts（ADRL-0018: import できないため解決順を 1:1 転記）。
 * 正典が変わったらここも更新すること（相互参照コメント）。
 *
 * フラット規約（sprint 20260707-124018 以降）:
 *   - page md = <note>/<pageId>.md（note 直下）
 *   - 画像/添付 = <note>/images・<note>/files（共有）
 *   - .out ヒント: FLAT_OUT_HINTS = { pageDir: '.', imageDir: './images', fileDir: './files' }
 *
 * すべて pure（FileSystemDirectoryHandle 非依存）。handle の走査（legacy md の実在判定）は
 * 呼び出し側が行い、結果の bool をここに渡す。node からも require 可能（unit 用）。
 */
(function (global) {
    'use strict';

    /**
     * .out の pageDir ヒントがフラット規約（basedir 直下 = "." or "" or "./"）かを判定。
     * 正典: flat-layout.ts:56 isFlatOut（正規化 = 先頭 ./ 除去 + 末尾 / 除去）
     */
    function isFlatOut(pageDir) {
        if (typeof pageDir !== 'string') return false;
        const norm = pageDir.replace(/^\.\//, '').replace(/\/+$/, '');
        return norm === '' || norm === '.';
    }

    /** ヒント文字列を folder-root 相対の subdir 名に正規化（'./sub/' → 'sub'）。'' = root 直下 */
    function normalizeRel(hint) {
        return String(hint).replace(/^\.\//, '').replace(/\/+$/, '');
    }

    /**
     * page md の保存 dir（folder root 相対。'' = root 直下 = フラット）を .out ヒントから決める。
     * - ヒント有り: isFlatOut → ''（フラット）/ 非フラット相対 → そのまま尊重
     * - ヒント無し: ''（フラット新デフォルト。旧 <outId>/ デフォルトは廃止 = FR-CL-01）
     * - 絶対パスヒントは FS Access API で扱えないため '' + 呼び出し側で警告
     * 正典: flat-layout.ts:65 resolvePagesDir（hint 分岐部）
     */
    function resolvePageDirRel(outHints, outId) {
        void outId; // 署名互換（旧デフォルト <outId> は廃止）
        const pd = outHints && typeof outHints.pageDir === 'string' ? outHints.pageDir : undefined;
        if (pd === undefined) return '';
        if (isFlatOut(pd)) return '';
        if (pd.startsWith('/')) return ''; // 絶対パスは扱えない → フラット扱い（呼び出し側で警告）
        return normalizeRel(pd);
    }

    /**
     * .out への書き込み先を決める。**新フラットレイアウト前提**（ユーザー決定 2026-07-26:
     * legacy fallback は持たない。全 note は移行済み or 新規とみなす）:
     *   ① ヒント有り → resolvePageDirRel に従属（移行済み .out は pageDir:'.' = flat）
     *   ② ヒント無し → ''（flat = note 直下）
     * 正典: flat-layout.ts の FLAT_OUT_HINTS（pageDir:'.'）/ 新 default = basedir 直下
     */
    function chooseWriteDirRel(outHints, outId) {
        const pd = outHints && typeof outHints.pageDir === 'string' ? outHints.pageDir : undefined;
        if (pd !== undefined) return resolvePageDirRel(outHints, outId);
        return '';
    }

    /**
     * 画像 dir（folder root 相対）。imageDir ヒント優先、無ければ共有 'images'（FR-CL-02）。
     * 正典: flat-layout.ts:95 resolveImagesDir / :104 resolveSharedSub（hint 優先 → 新 default）
     * ※ 読み取り fallback（legacy <basename>/images・_notes_md/images）は本体の役目。
     *   clipper は書き込み側なので「page md の隣の images/」に書く（chooseWriteDirRel の結果 dir + '/images'
     *   相当）。この関数はヒント解決のみを担い、実書き込み先は呼び出し側が pageDirRel と組み合わせる。
     */
    function resolveImagesDirRel(outHints) {
        const hint = outHints && typeof outHints.imageDir === 'string' ? outHints.imageDir : undefined;
        if (hint !== undefined && hint !== '' && !hint.startsWith('/')) return normalizeRel(hint);
        return 'images';
    }

    const api = {
        isFlatOut: isFlatOut,
        resolvePageDirRel: resolvePageDirRel,
        chooseWriteDirRel: chooseWriteDirRel,
        resolveImagesDirRel: resolveImagesDirRel
    };

    global.FractalFlatLayout = api;
    // node（unit テスト）から require できるように
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
