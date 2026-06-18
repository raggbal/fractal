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

    // ─── Phase 4: image cell helpers ─────────────────────────────────────────
    // renderNodeImages takes a `host` object with the following methods:
    //   host.getImageBaseUri()         — returns webview-asset base URI (or null)
    //   host.getModel()                — returns model with moveImage(nodeId, from, to), getNode(id)
    //   host.saveSnapshot()            — push undo snapshot
    //   host.scheduleSyncToHost()      — debounced save
    //   host.getImageDragState()       — { nodeId, fromIndex } | null
    //   host.setImageDragState(s)      — setter
    //   host.getSelectedImageInfo()    — { nodeId, index, element } | null
    //   host.setSelectedImageInfo(s)   — setter
    //   host.isReadOnly()              — boolean (skips drag/click handlers when true)

    function resolveImageSrc(imagePath, baseUri) {
        if (!baseUri) {
            // browser: fall back to window.__outlinerImageBaseUri for back-compat
            if (typeof window !== 'undefined' && window.__outlinerImageBaseUri) {
                baseUri = window.__outlinerImageBaseUri;
            }
        }
        if (!baseUri) { return imagePath; }
        return baseUri + '/' + imagePath.replace(/^\.\//, '');
    }

    /** コンテナ内のマウス位置から最も近いドロップインデックスを算出 */
    function getImageDropIndex(container, clientX, clientY) {
        var thumbs = container.querySelectorAll('.outliner-image-thumb');
        if (thumbs.length === 0) { return 0; }
        var bestIdx = 0;
        var bestDist = Infinity;
        for (var i = 0; i < thumbs.length; i++) {
            var rect = thumbs[i].getBoundingClientRect();
            var leftEdge = rect.left;
            var rightEdge = rect.right;
            var centerY = rect.top + rect.height / 2;
            var dy = Math.abs(clientY - centerY);
            var dLeft = Math.sqrt(Math.pow(clientX - leftEdge, 2) + Math.pow(dy, 2));
            if (dLeft < bestDist) { bestDist = dLeft; bestIdx = i; }
            var dRight = Math.sqrt(Math.pow(clientX - rightEdge, 2) + Math.pow(dy, 2));
            if (dRight < bestDist) { bestDist = dRight; bestIdx = i + 1; }
        }
        return bestIdx;
    }

    /** ドロップインジケーターを表示（指定インデックスの左に青線） */
    function showImageDropIndicator(container, dropIdx) {
        var thumbs = container.querySelectorAll('.outliner-image-thumb');
        for (var t = 0; t < thumbs.length; t++) {
            thumbs[t].classList.remove('drop-before', 'drop-after');
        }
        if (dropIdx <= 0 && thumbs.length > 0) {
            thumbs[0].classList.add('drop-before');
        } else if (dropIdx >= thumbs.length && thumbs.length > 0) {
            thumbs[thumbs.length - 1].classList.add('drop-after');
        } else if (dropIdx > 0 && dropIdx < thumbs.length) {
            thumbs[dropIdx].classList.add('drop-before');
        }
    }

    function clearImageDropIndicators(container) {
        var thumbs = container.querySelectorAll('.outliner-image-thumb');
        for (var t = 0; t < thumbs.length; t++) {
            thumbs[t].classList.remove('drop-before', 'drop-after', 'is-dragging');
        }
    }

    function clearImageSelection(host) {
        if (!host || !host.getSelectedImageInfo) { return; }
        var sel = host.getSelectedImageInfo();
        if (sel) {
            if (sel.element) { sel.element.classList.remove('is-selected'); }
            host.setSelectedImageInfo(null);
        }
    }

    function showImageOverlay(src) {
        var overlay = document.createElement('div');
        overlay.className = 'outliner-image-overlay';

        var largeImg = document.createElement('img');
        largeImg.className = 'outliner-image-large';
        largeImg.src = src;

        overlay.appendChild(largeImg);

        var hint = document.createElement('div');
        hint.className = 'outliner-image-overlay-hint';
        hint.textContent = 'Pinch to zoom · Drag to pan · Double-click to reset · ESC to close';
        overlay.appendChild(hint);

        // 右上 toolbar: Copy Image / Open in New Tab / Copy Path
        var absPath = (src || '')
            .replace(/^https:\/\/file\+\.vscode-resource\.vscode-cdn\.net/, '')
            .replace(/^https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net/, '')
            .split('?')[0].split('#')[0];
        var hostBridge = (typeof window !== 'undefined') ? window.outlinerHostBridge : null;
        var toolbar = document.createElement('div');
        toolbar.className = 'image-overlay-toolbar';
        var btnCopyImg = document.createElement('button');
        btnCopyImg.type = 'button';
        btnCopyImg.textContent = 'Copy Image';
        btnCopyImg.title = 'Copy image to clipboard';
        var btnOpenTab = document.createElement('button');
        btnOpenTab.type = 'button';
        btnOpenTab.textContent = 'Open in New Tab';
        btnOpenTab.title = 'Open image in a new VS Code tab';
        var btnCopyPath = document.createElement('button');
        btnCopyPath.type = 'button';
        btnCopyPath.textContent = 'Copy Path';
        btnCopyPath.title = 'Copy absolute path to clipboard';
        toolbar.appendChild(btnCopyImg);
        toolbar.appendChild(btnOpenTab);
        toolbar.appendChild(btnCopyPath);
        overlay.appendChild(toolbar);
        function flash(btn, text) {
            var orig = btn.textContent;
            btn.textContent = text;
            setTimeout(function() { btn.textContent = orig; }, 900);
        }
        btnCopyImg.addEventListener('click', function(ev) {
            ev.stopPropagation();
            if (hostBridge && hostBridge.copyImageToClipboard) {
                hostBridge.copyImageToClipboard(absPath);
                flash(btnCopyImg, 'Copied!');
            }
        });
        btnOpenTab.addEventListener('click', function(ev) {
            ev.stopPropagation();
            if (hostBridge && hostBridge.openImageInNewTab) {
                hostBridge.openImageInNewTab(absPath);
            }
        });
        btnCopyPath.addEventListener('click', function(ev) {
            ev.stopPropagation();
            try {
                navigator.clipboard.writeText(absPath);
                flash(btnCopyPath, 'Copied!');
            } catch (_e) { /* noop */ }
        });

        document.body.appendChild(overlay);

        var scale = 1, tx = 0, ty = 0;
        var isDragging = false, dragStartX = 0, dragStartY = 0;
        var MIN_SCALE = 0.2, MAX_SCALE = 16;
        function apply() {
            largeImg.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
        }
        overlay.addEventListener('wheel', function(ev) {
            if (!ev.ctrlKey) return;
            ev.preventDefault();
            var delta = -ev.deltaY * 0.01;
            var newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * (1 + delta)));
            if (newScale === scale) return;
            var rect = largeImg.getBoundingClientRect();
            var ox = ev.clientX - rect.left;
            var oy = ev.clientY - rect.top;
            tx += ox * (1 - newScale / scale);
            ty += oy * (1 - newScale / scale);
            scale = newScale;
            apply();
        }, { passive: false });
        largeImg.addEventListener('mousedown', function(ev) {
            ev.preventDefault();
            isDragging = true;
            dragStartX = ev.clientX - tx;
            dragStartY = ev.clientY - ty;
            largeImg.style.cursor = 'grabbing';
        });
        var onMove = function(ev) {
            if (!isDragging) return;
            tx = ev.clientX - dragStartX;
            ty = ev.clientY - dragStartY;
            apply();
        };
        var onUp = function() {
            isDragging = false;
            largeImg.style.cursor = 'default';
        };
        overlay.addEventListener('mousemove', onMove);
        overlay.addEventListener('mouseup', onUp);
        overlay.addEventListener('mouseleave', onUp);
        largeImg.addEventListener('dblclick', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            scale = 1; tx = 0; ty = 0;
            apply();
        });

        overlay.addEventListener('click', function(ev) {
            if (ev.target === overlay) { overlay.remove(); }
        });
        var escHandler = function(ev) {
            if (ev.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Render <img.outliner-image-thumb> elements for node.images[] into container.
     * host: object with getImageBaseUri / getModel / saveSnapshot / scheduleSyncToHost /
     *       getImageDragState / setImageDragState / getSelectedImageInfo / setSelectedImageInfo
     */
    function renderNodeImages(container, node, host) {
        if (!container) { return; }
        container.innerHTML = '';
        if (!node || !node.images || node.images.length === 0) { return; }

        var baseUri = host && host.getImageBaseUri ? host.getImageBaseUri() : null;
        var isReadOnly = host && host.isReadOnly ? host.isReadOnly() : false;

        for (var i = 0; i < node.images.length; i++) {
            (function(idx) {
                var img = document.createElement('img');
                img.className = 'outliner-image-thumb';
                img.dataset.index = idx;
                img.dataset.nodeId = node.id;
                img.src = resolveImageSrc(node.images[idx], baseUri);
                img.draggable = !isReadOnly;
                img.alt = '';

                if (!isReadOnly && host) {
                    img.addEventListener('click', function(e) {
                        e.stopPropagation();
                        clearImageSelection(host);
                        img.classList.add('is-selected');
                        host.setSelectedImageInfo({ nodeId: node.id, index: idx, element: img });
                    });

                    img.addEventListener('dblclick', function(e) {
                        e.stopPropagation();
                        showImageOverlay(img.src);
                    });

                    img.addEventListener('dragstart', function(e) {
                        e.stopPropagation();
                        host.setImageDragState({ nodeId: node.id, fromIndex: idx });
                        img.classList.add('is-dragging');
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', 'outliner-image');
                    });

                    img.addEventListener('dragend', function() {
                        host.setImageDragState(null);
                        clearImageDropIndicators(container);
                    });
                }

                container.appendChild(img);
            })(i);
        }

        if (!isReadOnly && host) {
            container.addEventListener('dragover', function(e) {
                var st = host.getImageDragState();
                if (!st || st.nodeId !== node.id) { return; }
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                var dropIdx = getImageDropIndex(container, e.clientX, e.clientY);
                showImageDropIndicator(container, dropIdx);
            });

            container.addEventListener('dragleave', function(e) {
                if (container.contains(e.relatedTarget)) { return; }
                clearImageDropIndicators(container);
            });

            container.addEventListener('drop', function(e) {
                var st = host.getImageDragState();
                if (!st || st.nodeId !== node.id) { return; }
                e.preventDefault();
                e.stopPropagation();
                var toIdx = getImageDropIndex(container, e.clientX, e.clientY);
                if (st.fromIndex !== toIdx && st.fromIndex !== toIdx - 1) {
                    if (host.saveSnapshot) { host.saveSnapshot(); }
                    var model = host.getModel ? host.getModel() : null;
                    if (model && model.moveImage) {
                        model.moveImage(node.id, st.fromIndex, toIdx);
                        renderNodeImages(container, model.getNode(node.id), host);
                    }
                    if (host.scheduleSyncToHost) { host.scheduleSyncToHost(); }
                }
                host.setImageDragState(null);
                clearImageDropIndicators(container);
            });
        }
    }

    // ─── Phase 5: applyInlineFormat / subtext open/close (model + host inject) ───

    /**
     * インラインフォーマット適用 (Cmd+B/I/E, Cmd+Shift+S)
     * Args: { nodeId, textEl, marker, model, host, saveSnapshot }
     *   - model: outliner-model with getNode / updateText
     *   - host: { scheduleSyncToHost, setCursorAtOffset (optional override) }
     *   - saveSnapshot: optional snapshot fn (Phase 5 doesn't currently use,
     *     but exposed for caller-side undo support)
     */
    function applyInlineFormat(args) {
        if (!args) { return; }
        var nodeId = args.nodeId;
        var textEl = args.textEl;
        var marker = args.marker;
        var model = args.model;
        var host = args.host || {};
        if (!model || !textEl || !marker) { return; }
        var node = model.getNode(nodeId);
        if (!node) { return; }
        var text = node.text || '';
        var sel = window.getSelection();
        var off = getCursorOffset(textEl);

        if (sel && !sel.isCollapsed) {
            var range = sel.getRangeAt(0);
            var preRange = range.cloneRange();
            preRange.selectNodeContents(textEl);
            preRange.setEnd(range.startContainer, range.startOffset);
            var startOff = preRange.toString().length;
            var endOff = startOff + range.toString().length;

            var selected = text.slice(startOff, endOff);
            var before = text.slice(0, startOff);
            var after = text.slice(endOff);

            if (before.endsWith(marker) && after.startsWith(marker)) {
                var newText = before.slice(0, -marker.length) + selected + after.slice(marker.length);
                model.updateText(nodeId, newText);
                textEl.innerHTML = renderEditingText(newText);
                setCursorAtOffset(textEl, endOff - marker.length);
            } else if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > 2 * marker.length) {
                var stripped = selected.slice(marker.length, -marker.length);
                var newText1b = before + stripped + after;
                model.updateText(nodeId, newText1b);
                textEl.innerHTML = renderEditingText(newText1b);
                setCursorAtOffset(textEl, startOff + stripped.length);
            } else {
                var newText2 = before + marker + selected + marker + after;
                model.updateText(nodeId, newText2);
                textEl.innerHTML = renderEditingText(newText2);
                setCursorAtOffset(textEl, endOff + 2 * marker.length);
            }
        } else {
            var newText3 = text.slice(0, off) + marker + marker + text.slice(off);
            model.updateText(nodeId, newText3);
            textEl.innerHTML = renderEditingText(newText3);
            setCursorAtOffset(textEl, off + marker.length);
        }
        if (host.scheduleSyncToHost) { host.scheduleSyncToHost(); }
    }

    /**
     * Open subtext for editing.
     * Args: { nodeId, treeEl, model } — host: not needed (read-only DOM ops + model.getNode)
     */
    function openSubtext(args) {
        if (!args) { return; }
        var nodeId = args.nodeId;
        var treeEl = args.treeEl;
        var model = args.model;
        if (!treeEl || !model) { return; }
        var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"]');
        if (!nodeEl) { return; }
        var subtextEl = nodeEl.querySelector('.outliner-subtext');
        if (!subtextEl) { return; }
        var node = model.getNode(nodeId);
        if (!node) { return; }

        subtextEl.contentEditable = 'true';
        subtextEl.classList.add('is-editing');
        subtextEl.classList.add('has-content');
        subtextEl.textContent = node.subtext || '';
        subtextEl.focus();

        var range = document.createRange();
        var sel = window.getSelection();
        range.selectNodeContents(subtextEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /**
     * Close subtext (commit value).
     * Args: { nodeId, subtextEl, model, host: { scheduleSyncToHost, focusNode } }
     */
    function closeSubtext(args) {
        if (!args) { return; }
        var nodeId = args.nodeId;
        var subtextEl = args.subtextEl;
        var model = args.model;
        var host = args.host || {};
        if (!model || !subtextEl) { return; }
        var node = model.getNode(nodeId);
        if (!node) { return; }

        var raw = getSubtextPlainText(subtextEl);
        if (model.updateSubtext) { model.updateSubtext(nodeId, raw); }

        subtextEl.contentEditable = 'false';
        subtextEl.classList.remove('is-editing');
        if (raw) {
            subtextEl.classList.add('has-content');
            subtextEl.textContent = raw;
        } else {
            subtextEl.classList.remove('has-content');
            subtextEl.textContent = '';
        }
        if (host.scheduleSyncToHost) { host.scheduleSyncToHost(); }

        if (host.focusNode) { host.focusNode(nodeId); }
    }

    /**
     * Subtext keydown handler.
     * Args: { event, nodeId, subtextEl, model, host: { scheduleSyncToHost, focusNode, save, syncToHostImmediate } }
     */
    function handleSubtextKeydown(args) {
        if (!args) { return; }
        var e = args.event;
        var nodeId = args.nodeId;
        var subtextEl = args.subtextEl;
        var model = args.model;
        var host = args.host || {};
        if (!e || !model || !subtextEl) { return; }
        if (e.isComposing || e.keyCode === 229) { return; }

        if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            closeSubtext({ nodeId: nodeId, subtextEl: subtextEl, model: model, host: host });
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            closeSubtext({ nodeId: nodeId, subtextEl: subtextEl, model: model, host: host });
            return;
        }

        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            var raw = getSubtextPlainText(subtextEl);
            if (model.updateSubtext) { model.updateSubtext(nodeId, raw); }
            if (host.syncToHostImmediate) { host.syncToHostImmediate(); }
            if (host.save) { host.save(); }
        }
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
        getSubtextPreview: getSubtextPreview,
        // Phase 4 — image cell helpers (host inject pattern)
        resolveImageSrc: resolveImageSrc,
        getImageDropIndex: getImageDropIndex,
        showImageDropIndicator: showImageDropIndicator,
        clearImageDropIndicators: clearImageDropIndicators,
        clearImageSelection: clearImageSelection,
        showImageOverlay: showImageOverlay,
        renderNodeImages: renderNodeImages,
        // Phase 5 — applyInlineFormat / subtext open/close (model + host inject)
        applyInlineFormat: applyInlineFormat,
        openSubtext: openSubtext,
        closeSubtext: closeSubtext,
        handleSubtextKeydown: handleSubtextKeydown
    };
}));
