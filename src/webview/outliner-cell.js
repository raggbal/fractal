/**
 * OutlinerCell — single-cell rich-text rendering helpers
 *
 * Pure functions extracted from outliner.js for re-use across:
 *   - outliner editor (existing)
 *   - outliner-table editor (Notion / Coda style table view, new in this sprint)
 *
 * Public API (Phase 1+2):
 *   OutlinerCell.renderInlineText(text)
 *   OutlinerCell.classifyLinkHref(href)
 *   OutlinerCell.stripInlineMarkers(text)
 *   OutlinerCell.renderEditingText(text)
 *   OutlinerCell.convertUrlsToMarkdownLinks(text)
 *   OutlinerCell.renderedOffsetToSource(sourceText, renderedOffset)
 *   OutlinerCell.sourceOffsetToRendered(sourceText, sourceOffset)
 *   OutlinerCell.buildRenderedToSourceMap(sourceText, renderedText)
 *
 * Phase 3〜5 will add: cursor / DOM helpers, image helpers,
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

    /**
     * ソーステキスト（マーカー付き）からマーカーを除去してレンダリング後テキストを返す。
     * renderInlineText と同じ正規表現順序で処理する。
     */
    function stripInlineMarkers(text) {
        if (!text) { return ''; }
        text = text.replace(/`([^`]+)`/g, '$1');
        text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
        text = text.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '$1');
        text = text.replace(/~~([^~]+)~~/g, '$1');
        return text;
    }

    /**
     * 編集モード用のテキストレンダリング。
     * マーカー(*、**、~~、`)はそのまま表示し、タグのみハイライトする。
     * textContent がソーステキストと一致するため、オフセット計算が安全。
     */
    function renderEditingText(text) {
        if (!text) { return ''; }
        var html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        // タグのみハイライト (テキスト内容を変えないのでオフセットに影響なし)
        // URL内の@をタグ化しないよう、URLを一時退避してからタグ変換
        var urlPlaceholders = [];
        html = html.replace(/https?:\/\/\S+/g, function(match) {
            urlPlaceholders.push(match);
            return '\x00URL' + (urlPlaceholders.length - 1) + '\x00';
        });
        html = html.replace(/(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu, '<span class="outliner-tag">$1</span>');
        html = html.replace(/\x00URL(\d+)\x00/g, function(_, idx) {
            return urlPlaceholders[parseInt(idx, 10)];
        });
        // 末尾スペースをNBSPに変換
        html = html.replace(/ $/, ' ');
        return html;
    }

    /**
     * テキスト中のURLをMarkdownリンク形式 [URL](URL) に変換する。
     * 既にMarkdownリンク内にあるURL（[text](url) の url 部分）は変換しない。
     */
    function convertUrlsToMarkdownLinks(text) {
        if (!text) { return text; }
        var MLP = getMLP();
        if (!MLP) { return text; }
        // balanced paren 対応で 1 パス走査: URL 内の () をネスト追跡、末尾句読点を除外。
        // 既に Markdown link 内 ([ の直後 or ]( の直後) にある URL はスキップする。
        var out = '';
        var i = 0;
        var len = text.length;
        while (i < len) {
            var head = text.slice(i, i + 8).toLowerCase();
            if (head.indexOf('http://') === 0 || head.indexOf('https://') === 0) {
                var prevCh = i > 0 ? text.charAt(i - 1) : '';
                var prev2 = i > 1 ? text.slice(i - 2, i) : '';
                var inLink = prevCh === '[' || prev2 === '](';
                if (!inLink) {
                    var found = MLP.extractUrlWithBalancedParens(text, i);
                    if (found) {
                        out += '[' + found.url + '](' + found.url + ')';
                        i = found.endIndex;
                        continue;
                    }
                }
            }
            out += text.charAt(i);
            i++;
        }
        return out;
    }

    /**
     * レンダリング後テキストの各位置がソーステキストのどの位置に対応するかのマップを構築。
     * map[renderedPos] = sourcePos
     */
    function buildRenderedToSourceMap(sourceText, renderedText) {
        var map = [];
        var si = 0;
        for (var ri = 0; ri < renderedText.length; ri++) {
            while (si < sourceText.length && sourceText[si] !== renderedText[ri]) {
                si++;
            }
            map.push(si);
            si++;
        }
        // 末尾位置
        map.push(sourceText.length);
        return map;
    }

    /**
     * レンダリング後テキストのオフセットをソーステキストのオフセットに変換する。
     * sourceText: マーカー付きテキスト, renderedOffset: マーカー除去後のオフセット
     */
    function renderedOffsetToSource(sourceText, renderedOffset) {
        var rendered = stripInlineMarkers(sourceText);
        var map = buildRenderedToSourceMap(sourceText, rendered);
        if (renderedOffset >= map.length) { return sourceText.length; }
        return map[renderedOffset];
    }

    /**
     * ソーステキストのオフセットをレンダリング後テキストのオフセットに変換する。
     */
    function sourceOffsetToRendered(sourceText, sourceOffset) {
        var rendered = stripInlineMarkers(sourceText);
        var map = buildRenderedToSourceMap(sourceText, rendered);
        // mapの中からsourceOffset以上の最初のエントリのインデックスを返す
        for (var i = 0; i < map.length; i++) {
            if (map[i] >= sourceOffset) { return i; }
        }
        return rendered.length;
    }

    // ─── Phase 3: cursor / DOM helpers ───────────────────────────────────────
    // These touch document.createRange / window.getSelection. They are DOM-pure
    // (no model / host dependency) and re-used by Outliner editor + Outliner
    // Table editor.

    function setCursorToEnd(el) {
        if (typeof document === 'undefined') { return; }
        var range = document.createRange();
        var sel = window.getSelection();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setCursorToStart(el) {
        if (typeof document === 'undefined') { return; }
        var range = document.createRange();
        var sel = window.getSelection();
        range.selectNodeContents(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setCursorAtOffset(el, offset) {
        if (typeof document === 'undefined') { return; }
        var range = document.createRange();
        var sel = window.getSelection();
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var textNode = walker.nextNode();
        if (!textNode) {
            range.selectNodeContents(el);
            range.collapse(true);
        } else {
            var pos = 0;
            do {
                var len = textNode.textContent.length;
                if (pos + len >= offset) {
                    range.setStart(textNode, offset - pos);
                    range.collapse(true);
                    break;
                }
                pos += len;
            } while ((textNode = walker.nextNode()));
            if (!textNode) {
                range.selectNodeContents(el);
                range.collapse(false);
            }
        }
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function getCursorOffset(el) {
        if (typeof window === 'undefined') { return 0; }
        var sel = window.getSelection();
        if (!sel.rangeCount) { return 0; }
        var range = sel.getRangeAt(0);
        var preRange = range.cloneRange();
        preRange.selectNodeContents(el);
        preRange.setEnd(range.startContainer, range.startOffset);
        return preRange.toString().length;
    }

    /**
     * el (contenteditable) 内の現在の Selection の範囲を { start, end } で返す。
     * Selection が el 外なら null。
     */
    function getCursorRange(el) {
        if (typeof window === 'undefined') { return null; }
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) { return null; }
        var range = sel.getRangeAt(0);
        if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
            return null;
        }
        var preStart = range.cloneRange();
        preStart.selectNodeContents(el);
        preStart.setEnd(range.startContainer, range.startOffset);
        var start = preStart.toString().length;
        var preEnd = range.cloneRange();
        preEnd.selectNodeContents(el);
        preEnd.setEnd(range.endContainer, range.endOffset);
        var end = preEnd.toString().length;
        if (end < start) { var t = start; start = end; end = t; }
        return { start: start, end: end };
    }

    /** contenteditable からプレーンテキストを取得 (NBSPは通常スペースに正規化) */
    function getPlainText(el) {
        return (el.textContent || '').replace(/\u00A0/g, ' ');
    }

    /** contenteditable要素から改行を正規化してプレーンテキストを取得 (subtext用) */
    function getSubtextPlainText(element) {
        var result = '';
        var children = element.childNodes;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 1 && child.tagName === 'BR') {
                result += '\n';
            } else if (child.nodeType === 3) {
                result += child.textContent;
            } else if (child.nodeType === 1) {
                if (result.length > 0 && result[result.length - 1] !== '\n') {
                    result += '\n';
                }
                result += getSubtextPlainText(child);
            }
        }
        return result;
    }

    /** サブテキストの省略表示テキストを生成 */
    function getSubtextPreview(subtext) {
        if (!subtext) { return ''; }
        var firstLine = subtext.split('\n')[0];
        var hasMore = subtext.indexOf('\n') >= 0;
        return hasMore ? firstLine + ' ...' : firstLine;
    }

    return {
        renderInlineText: renderInlineText,
        classifyLinkHref: classifyLinkHref,
        stripInlineMarkers: stripInlineMarkers,
        renderEditingText: renderEditingText,
        convertUrlsToMarkdownLinks: convertUrlsToMarkdownLinks,
        buildRenderedToSourceMap: buildRenderedToSourceMap,
        renderedOffsetToSource: renderedOffsetToSource,
        sourceOffsetToRendered: sourceOffsetToRendered,
        // Phase 3 — cursor / DOM helpers
        // namespaced API (per tasks.md TASK-A3)
        setCursor: {
            toEnd: setCursorToEnd,
            toStart: setCursorToStart,
            atOffset: setCursorAtOffset
        },
        getCursor: {
            offset: getCursorOffset,
            range: getCursorRange
        },
        // flat aliases for direct callsite compatibility
        setCursorToEnd: setCursorToEnd,
        setCursorToStart: setCursorToStart,
        setCursorAtOffset: setCursorAtOffset,
        getCursorOffset: getCursorOffset,
        getCursorRange: getCursorRange,
        getPlainText: getPlainText,
        getSubtextPlainText: getSubtextPlainText,
        getSubtextPreview: getSubtextPreview
    };
}));
