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

    /** page MD 本文を組み立て (1 行目 H1 タイトル + 元 URL + 空行 + 本文) */
    function buildPageMd(options) {
        const lines = [];
        if (options.title) lines.push('# ' + options.title);
        if (options.url) lines.push('元ページ: [' + options.url + '](' + options.url + ')');
        if (options.byline) lines.push('著者: ' + options.byline);
        if (options.siteName) lines.push('サイト: ' + options.siteName);
        lines.push('');  // 区切り
        lines.push(options.markdown || '');
        return lines.join('\n\n');
    }

    /** pageDir 値の正規化: data.pageDir or default './pages'。先頭 ./ を除去して subdir 名に */
    function resolvePageDir(outData) {
        const raw = (outData && outData.pageDir) || './pages';
        // './foo' or 'foo/' → 'foo'
        return raw.replace(/^\.\//, '').replace(/\/$/, '');
    }

    global.FractalClipperCore = {
        generateNodeId: generateNodeId,
        generatePageId: generatePageId,
        parseTags: parseTags,
        prependClipNode: prependClipNode,
        buildPageMd: buildPageMd,
        resolvePageDir: resolvePageDir
    };
})(typeof window !== 'undefined' ? window : this);
