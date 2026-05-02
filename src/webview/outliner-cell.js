/**
 * OutlinerCell — single-cell rich-text rendering helpers
 *
 * Pure functions extracted from outliner.js for re-use across:
 *   - outliner editor (existing)
 *   - outliner-table editor (Notion / Coda style table view, new in this sprint)
 *
 * Public API (Phase 1):
 *   OutlinerCell.renderInlineText(text)
 *   OutlinerCell.classifyLinkHref(href)
 *
 * Phase 2〜5 will add: stripInlineMarkers, renderEditingText,
 * convertUrlsToMarkdownLinks, cursor / DOM helpers, image helpers,
 * applyInlineFormat / subtext open/close (host inject).
 *
 * Depends on global `MarkdownLinkParser` (loaded before this script).
 *
 * UMD pattern: works as `window.OutlinerCell` in webview / standalone HTML
 * AND as `module.exports` in Node.js (CommonJS) for unit tests.
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        // Node.js / CommonJS — accept MarkdownLinkParser via require if available
        var MarkdownLinkParserDep = null;
        try {
            // eslint-disable-next-line global-require
            MarkdownLinkParserDep = require('../shared/markdown-link-parser.js');
        } catch (_e) {
            // MarkdownLinkParser optional in pure unit tests
            MarkdownLinkParserDep = null;
        }
        module.exports = factory(MarkdownLinkParserDep);
    } else {
        // Browser global — read MarkdownLinkParser from window (loaded earlier)
        root.OutlinerCell = factory(typeof MarkdownLinkParser !== 'undefined' ? MarkdownLinkParser : null);
    }
}(typeof self !== 'undefined' ? self : this, function (MarkdownLinkParserParam) {
    'use strict';

    // Look up MarkdownLinkParser dynamically: in browser the global may be
    // defined after this UMD wrapper executes, in tests we may pass it in.
    function getMLP() {
        if (MarkdownLinkParserParam) { return MarkdownLinkParserParam; }
        if (typeof MarkdownLinkParser !== 'undefined') { return MarkdownLinkParser; }
        return null;
    }

    /** リンクhrefからリンク種別のCSSクラスを返す */
    function classifyLinkHref(href) {
        if (!href) { return ''; }
        if (href.startsWith('fractal://note/')) {
            return /\/page\/[^/?]+$/.test(href) ? 'link-fractal-page' : 'link-fractal-node';
        }
        if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('#') &&
            /\.(?:md|markdown)(?:[#?]|$)/i.test(href)) {
            return 'link-internal-md';
        }
        return '';
    }

    /** プレーンテキストからインラインMarkdownをHTMLに変換 */
    function renderInlineText(text) {
        if (!text) { return ''; }

        // エスケープ
        var html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // インラインコード (先に処理してコード内を保護)
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // 太字
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // 斜体 — **の一部である*にマッチしないよう lookbehind/lookahead を使用
        html = html.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '<em>$1</em>');

        // 取り消し線
        html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        // リンク — Markdownリンクと生URLを一時退避してからタグ変換（URL内の@をタグ化しない）
        var linkPlaceholders = [];
        var MLP = getMLP();
        // まず Markdown リンク [text](url) を balanced paren parser で退避
        if (MLP) {
            var inlineLinks = MLP.parseMarkdownLinks(html);
            // end 降順に置換 (index ズレ回避)
            var sortedInline = inlineLinks.slice().sort(function(a, b) { return b.end - a.end; });
            for (var ili = 0; ili < sortedInline.length; ili++) {
                var il = sortedInline[ili];
                if (il.kind === 'link' && il.alt.length > 0) {
                    var ilClass = classifyLinkHref(il.url);
                    var ilClassAttr = ilClass ? ' class="' + ilClass + '"' : '';
                    var ilTag = '<a href="' + il.url + '"' + ilClassAttr + ' title="' + il.url + '">' + il.alt + '</a>';
                    linkPlaceholders.push(ilTag);
                    html = html.slice(0, il.start) + '\x00LINK' + (linkPlaceholders.length - 1) + '\x00' + html.slice(il.end);
                } else if (il.kind === 'image') {
                    // image syntax in outliner は通常のテキストとして表示するので退避のみ
                    linkPlaceholders.push(html.slice(il.start, il.end));
                    html = html.slice(0, il.start) + '\x00LINK' + (linkPlaceholders.length - 1) + '\x00' + html.slice(il.end);
                }
            }
        }
        // 次に生 URL (https://...) も balanced paren 対応で退避
        var rawUrlOut = '';
        var rawUrlI = 0;
        while (rawUrlI < html.length) {
            var rawHead = html.slice(rawUrlI, rawUrlI + 8).toLowerCase();
            if ((rawHead.indexOf('http://') === 0 || rawHead.indexOf('https://') === 0) && MLP) {
                var rawFound = MLP.extractUrlWithBalancedParens(html, rawUrlI);
                if (rawFound) {
                    linkPlaceholders.push(rawFound.url);
                    rawUrlOut += '\x00LINK' + (linkPlaceholders.length - 1) + '\x00';
                    rawUrlI = rawFound.endIndex;
                    continue;
                }
            }
            rawUrlOut += html.charAt(rawUrlI);
            rawUrlI++;
        }
        html = rawUrlOut;

        // タグ (#tag / @tag) — \w では日本語にマッチしないため Unicode プロパティを使用
        html = html.replace(/(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu, '<span class="outliner-tag">$1</span>');
        html = html.replace(/\x00LINK(\d+)\x00/g, function(_, idx) {
            return linkPlaceholders[parseInt(idx, 10)];
        });

        // 末尾スペースをNBSPに変換 (contenteditableで末尾空白が描画されない問題を回避)
        html = html.replace(/ $/, ' ');

        return html;
    }

    return {
        renderInlineText: renderInlineText,
        classifyLinkHref: classifyLinkHref
    };
}));
