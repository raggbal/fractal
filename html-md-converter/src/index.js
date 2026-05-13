// HTML → Markdown 変換のエントリーポイント。
//
// 利用側 (browser / Playwright eval):
//   HtmlMdConverter.htmlToMarkdown(html) → string
//
// 内部:
//   1. ensureTableHeaders で <th> 不在 table に空 header 注入 (GFM table 化)
//   2. Turndown + GFM plugin + 独自 8 rule で変換
//   3. postprocess で unescape + tight list

function htmlToMarkdown(html) {
    if (!html) return '';
    if (typeof TurndownService === 'undefined') {
        throw new Error('TurndownService not loaded');
    }
    var preprocessed = ensureTableHeaders(html);

    var turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        bulletListMarker: '-'
    });
    if (typeof turndownPluginGfm !== 'undefined') {
        turndownService.use(turndownPluginGfm.gfm);
    }
    addCustomRules(turndownService);

    var md = turndownService.turndown(preprocessed);
    return postprocess(md);
}

/**
 * Mozilla Readability で記事抽出 → htmlToMarkdown で変換。
 * Chrome extension / web clipper 向け。Readability lib を呼び出し側で別途 load 必須。
 *
 * @param {Document} documentClone — document.cloneNode(true) の結果を渡す
 * @returns {{ title, markdown, byline, siteName, length, excerpt }}
 */
function articleToMarkdown(documentClone) {
    if (typeof Readability === 'undefined') {
        throw new Error('Readability not loaded — load it before calling articleToMarkdown');
    }
    // <a><hN>…</hN></a> の anchor を unwrap してから Readability に渡す。
    // そうしないと link-density 100% のノードとして heading ごと削除される。
    try { unwrapHeadingAnchors(documentClone); } catch (e) {}
    var reader = new Readability(documentClone);
    var article = reader.parse();
    if (!article || !article.content) {
        return { title: '', markdown: '', byline: '', siteName: '' };
    }
    return {
        title: article.title || '',
        markdown: htmlToMarkdown(article.content),
        byline: article.byline || '',
        siteName: article.siteName || '',
        length: article.length,
        excerpt: article.excerpt || ''
    };
}
