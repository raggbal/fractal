'use strict';
/**
 * Markdown link/image parser (balanced paren 対応)
 *
 * 半角 ( ) をネスト対応でバランスカウントし、全角括弧は文字として扱う。
 * 1 パス O(n)。CommonJS + global 両対応 (webview は global として読み込み)。
 *
 * NOTE: このファイルは webview / host 両方から使われる共通モジュール。
 * 同ロジックの inline 複製が .claude/skills/fractal-md/scripts/fractal-md.mjs
 * にも存在する。変更時は必ず両方同期すること。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.MarkdownLinkParser = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    /**
     * pos 位置の '(' に対応する ')' を探して index を返す。
     * 見つからなければ -1。半角のみカウント (全角 （） は通常文字)。
     */
    function findBalancedClose(text, openPos) {
        if (text.charAt(openPos) !== '(') return -1;
        var depth = 0;
        for (var i = openPos; i < text.length; i++) {
            var ch = text.charAt(i);
            if (ch === '(') depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    /**
     * text を走査して ![alt](url) / [text](url) を抽出。
     * Return: Array<{kind: 'image'|'link', alt, url, start, end}>
     *   start = 先頭 ('!' または '[') の index
     *   end   = ')' の次の index (exclusive)
     * ネストした [] は扱わない (現状 editor.js 相当)。
     */
    function parseMarkdownLinks(text) {
        var result = [];
        if (!text) return result;
        var len = text.length;
        var i = 0;
        while (i < len) {
            var isImage = false;
            var tokenStart = -1;
            var bracketOpen = -1;
            if (text.charAt(i) === '!' && text.charAt(i + 1) === '[') {
                isImage = true;
                tokenStart = i;
                bracketOpen = i + 1;
            } else if (text.charAt(i) === '[') {
                tokenStart = i;
                bracketOpen = i;
            } else {
                i++;
                continue;
            }
            var closeBracket = text.indexOf(']', bracketOpen + 1);
            if (closeBracket === -1 || text.charAt(closeBracket + 1) !== '(') {
                i++;
                continue;
            }
            var openParen = closeBracket + 1;
            var closeParen = findBalancedClose(text, openParen);
            if (closeParen === -1) {
                i++;
                continue;
            }
            var alt = text.slice(bracketOpen + 1, closeBracket);
            var url = text.slice(openParen + 1, closeParen);
            result.push({
                kind: isImage ? 'image' : 'link',
                alt: alt,
                url: url,
                start: tokenStart,
                end: closeParen + 1
            });
            i = closeParen + 1;
        }
        return result;
    }

    /**
     * .md 本文から参照される画像のローカル相対パスを抽出。
     * http/data/file/絶対パスを除外、クエリ/フラグメントを除去。
     * HTML <img src="..."> もサポート。
     */
    var HTML_IMG_RE = /<img\s+[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    function extractImagePaths(md) {
        var results = [];
        var seen = Object.create(null);
        function push(p) {
            if (!p) return;
            var trimmed = p.trim().replace(/^<|>$/g, '');
            if (!trimmed) return;
            if (/^(https?:|data:|file:)/i.test(trimmed)) return;
            if (trimmed.charAt(0) === '/') return;
            var cleaned = trimmed.split(/[?#]/)[0];
            if (!cleaned || seen[cleaned]) return;
            seen[cleaned] = true;
            results.push(cleaned);
        }
        var links = parseMarkdownLinks(md || '');
        for (var i = 0; i < links.length; i++) {
            if (links[i].kind === 'image') push(links[i].url);
        }
        HTML_IMG_RE.lastIndex = 0;
        var m;
        while ((m = HTML_IMG_RE.exec(md || '')) !== null) push(m[1]);
        return results;
    }

    /**
     * .md 本文から [📎 filename](path) 形式のファイルリンクを抽出。
     * alt text が 📎 で始まる link を対象とする。
     * http/data/file/絶対パスを除外、クエリ/フラグメントを除去。
     */
    function extractMarkdownFileLinks(md) {
        var results = [];
        var seen = Object.create(null);
        function push(p) {
            if (!p) return;
            var trimmed = p.trim().replace(/^<|>$/g, '');
            if (!trimmed) return;
            if (/^(https?:|data:|file:)/i.test(trimmed)) return;
            if (trimmed.charAt(0) === '/') return;
            var cleaned = trimmed.split(/[?#]/)[0];
            if (!cleaned || seen[cleaned]) return;
            seen[cleaned] = true;
            results.push(cleaned);
        }
        var links = parseMarkdownLinks(md || '');
        for (var i = 0; i < links.length; i++) {
            var link = links[i];
            // Check if it's a link (not image) and alt text contains 📎
            // 📎 is U+1F4CE, which is a surrogate pair: \uD83D\uDCCE
            if (link.kind === 'link' && link.alt) {
                var altTrimmed = link.alt.trim();
                // Check if alt starts with 📎 or contains it (flexible matching)
                if (altTrimmed.indexOf('\uD83D\uDCCE') === 0 ||
                    altTrimmed.indexOf('📎') === 0) {
                    push(link.url);
                }
            }
        }
        return results;
    }

    /**
     * text[startIndex] から始まる生 URL を balanced paren 対応で検出。
     * - プロトコルは http:// / https:// のみ
     * - 空白 / 改行 / タブ / < > " ' で停止
     * - URL 内で '(' が開いていれば対応する ')' まで含める
     * - 末尾の句読点 .,;:!? は URL に含めない (depth=0 の場合のみ)
     * Return: {url, endIndex} / 失敗時 null
     */
    var URL_STOP_RE = /[\s<>"']/;
    var TRAILING_PUNCT_RE = /[.,;:!?]/;
    function extractUrlWithBalancedParens(text, startIndex) {
        if (!text) return null;
        var head = text.slice(startIndex, startIndex + 8).toLowerCase();
        var proto = null;
        if (head.indexOf('https://') === 0) proto = 'https://';
        else if (head.indexOf('http://') === 0) proto = 'http://';
        if (!proto) return null;
        var i = startIndex + proto.length;
        var depth = 0;
        while (i < text.length) {
            var ch = text.charAt(i);
            if (URL_STOP_RE.test(ch)) break;
            if (ch === '(') { depth++; i++; continue; }
            if (ch === ')') {
                if (depth === 0) break;
                depth--; i++; continue;
            }
            i++;
        }
        var end = i;
        while (end > startIndex + proto.length && depth === 0) {
            var tail = text.charAt(end - 1);
            if (TRAILING_PUNCT_RE.test(tail)) { end--; } else break;
        }
        if (end <= startIndex + proto.length) return null;
        return { url: text.slice(startIndex, end), endIndex: end };
    }

    return {
        parseMarkdownLinks: parseMarkdownLinks,
        extractImagePaths: extractImagePaths,
        extractMarkdownFileLinks: extractMarkdownFileLinks,
        extractUrlWithBalancedParens: extractUrlWithBalancedParens,
        findBalancedClose: findBalancedClose
    };
}));
