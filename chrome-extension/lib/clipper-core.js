/** Clipper core — .out 操作 + page MD 書き込みの純粋ロジック (DOM 非依存)。
 *
 *  入力: 既存 .out JSON、page MD 内容、node text、ID 候補
 *  出力: 更新後 .out JSON
 *
 *  page id / node id 生成は OutlinerModel と同じスキーム:
 *    - nodeId: 'n' + base36(timestamp) + random
 *    - pageId: crypto.randomUUID()
 */
(function (global) {
    'use strict';

    function generateNodeId() {
        return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function generatePageId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            var v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /** text内の #tag / @tag を抽出 (parseTags のシンプル版) */
    function parseTags(text) {
        var tags = [];
        var cleaned = (text || '').replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '');
        var regex = /(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu;
        var match;
        while ((match = regex.exec(cleaned)) !== null) {
            tags.push(match[1]);
        }
        return tags;
    }

    /** 新しいページ node を .out 先頭に追加。返り値: { newOutData, pageId, pageMdContent } */
    function prependClipNode(outData, options) {
        const data = JSON.parse(JSON.stringify(outData || {}));  // deep clone
        if (!data.version) data.version = 1;
        if (!data.rootIds) data.rootIds = [];
        if (!data.nodes) data.nodes = {};

        const nodeId = generateNodeId();
        const pageId = generatePageId();
        const text = options.title || '(untitled)';

        const node = {
            id: nodeId,
            parentId: null,
            children: [],
            text: text,
            tags: parseTags(text),
            subtext: '',
            images: [],
            collapsed: false,
            isPage: true,
            pageId: pageId,
            checked: null
        };

        data.nodes[nodeId] = node;
        data.rootIds = [nodeId].concat(data.rootIds);

        return {
            outData: data,
            pageId: pageId,
            nodeId: nodeId
        };
    }

    /** page MD 本文を組み立て (1 行目 H1 タイトル + 元 URL + 空行 + 本文)。
     *  FR-CI-05: メタラベルは options.labels { source, author, site } で受ける
     *  (core は i18n 非依存の純ロジック。省略時は en 既定 = 後方互換)。 */
    function buildPageMd(options) {
        const L = options.labels || { source: 'Source', author: 'Author', site: 'Site' };
        const lines = [];
        if (options.title) lines.push('# ' + options.title);
        if (options.url) lines.push(L.source + ': [' + options.url + '](' + options.url + ')');
        if (options.byline) lines.push(L.author + ': ' + options.byline);
        if (options.siteName) lines.push(L.site + ': ' + options.siteName);
        lines.push('');  // 区切り
        lines.push(options.markdown || '');
        return lines.join('\n\n');
    }

    /** @deprecated 旧 './pages' デフォルトは廃止。flat-layout-mirror.js の resolvePageDirRel を使うこと（ADRL-0018） */
    function resolvePageDir(outData) {
        const raw = (outData && outData.pageDir) || './pages';
        // './foo' or 'foo/' → 'foo'
        return raw.replace(/^\.\//, '').replace(/\/$/, '');
    }

    /**
     * subpage リンクラベルのサニタイズ（FR-CL-05 / design-review MEDIUM⑤）。
     * fractal の markdown-link-parser は [[label]] のラベル内 `]` 単体で切れるため、
     * `]` を全数 全角 `］` に置換。`[` も対称に `［` へ。改行→空白。空 → '(untitled)'。
     */
    function sanitizeSubpageTitle(title) {
        const t = String(title || '').replace(/[\r\n]+/g, ' ').trim();
        if (!t) return '(untitled)';
        return t.replace(/\]/g, '］').replace(/\[/g, '［');
    }

    /**
     * md 取込（FR-CL-05）: 対象 md の末尾に subpage リンクを追記した本文を組み立てる（pure）。
     * - 新規 md 名 = `<uuid>.md`（★ADRL-0018 decision 4: 対象 md と同じディレクトリに置く。
     *   fractal の相対 .md リンク解決が dirname(現md) 基準のため、同 dir なら `<uuid>.md` で必ず届く）
     * - 追記形式 = fractal 本体の serialize 形式 `[[label]](url)`（editor.js:7042）
     * - 既存本文は不変（末尾空白のみ trimEnd で正規化）・空行 1 つ挟んで 1 行追記
     */
    function buildMdClipResult(options) {
        const uuid = options.uuid || generatePageId();
        const safeTitle = sanitizeSubpageTitle(options.title);
        const newMdName = uuid + '.md';
        const base = String(options.targetMdText || '').replace(/\s+$/, '');
        const link = '[[' + safeTitle + ']](' + newMdName + ')';
        const appendedTargetText = (base ? base + '\n\n' : '') + link + '\n';
        return { newMdName: newMdName, uuid: uuid, appendedTargetText: appendedTargetText };
    }

    const api = {
        generateNodeId: generateNodeId,
        generatePageId: generatePageId,
        parseTags: parseTags,
        prependClipNode: prependClipNode,
        buildPageMd: buildPageMd,
        resolvePageDir: resolvePageDir,
        sanitizeSubpageTitle: sanitizeSubpageTitle,
        buildMdClipResult: buildMdClipResult
    };

    global.FractalClipperCore = api;
    // node（unit テスト）から require できるように
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
