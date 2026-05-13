// HTML → Markdown 変換用 Turndown 独自 rule (8 個)
// fractal editor.js paste handler (v0.207.49) から抽出。
//
// 利用側: addCustomRules(turndownService) を呼ぶと 8 rule が登録される。
// 前提: turndownService が turndown-plugin-gfm を use() 済み。

function addCustomRules(turndownService) {
    // Rule 1: Table cell の pipe escape + cell 内改行を <br> に変換
    turndownService.addRule('tableCellEscapePipe', {
        filter: ['th', 'td'],
        replacement: function(content, node) {
            var index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
            var prefix = ' ';
            if (index === 0) prefix = '| ';
            content = content.replace(/\n/g, '<br>');
            content = content.replace(/(<br>)+/g, '<br>');
            content = content.replace(/^(<br>)+/, '').replace(/(<br>)+$/, '');
            content = content.replace(/\|/g, '\\|');
            return prefix + content + ' |';
        }
    });

    // Rule 2: 空 span / Apple-converted-space 削除
    turndownService.addRule('cleanupSpans', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            if (node.classList && node.classList.contains('Apple-converted-space')) return true;
            var hasOnlyStyleAttr = node.attributes.length === 1 && node.hasAttribute('style');
            var hasNoContent = !node.textContent || node.textContent.trim() === '';
            return hasOnlyStyleAttr && hasNoContent;
        },
        replacement: function(content, node) {
            if (node.classList && node.classList.contains('Apple-converted-space')) return ' ';
            return content;
        }
    });

    // Rule 3: CSS style-based bold (Google Docs / 一部 web page)
    turndownService.addRule('styledBold', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            var fw = node.style.fontWeight;
            return fw === 'bold' || fw === 'bolder' || (parseInt(fw) >= 700);
        },
        replacement: function(content) {
            content = content.trim();
            if (!content) return '';
            return '**' + content + '**';
        }
    });

    // Rule 4: CSS style-based italic
    turndownService.addRule('styledItalic', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            var fs = node.style.fontStyle;
            return fs === 'italic' || fs === 'oblique';
        },
        replacement: function(content) {
            content = content.trim();
            if (!content) return '';
            return '*' + content + '*';
        }
    });

    // Rule 5: CSS style-based strikethrough
    turndownService.addRule('styledStrikethrough', {
        filter: function(node) {
            if (node.nodeName !== 'SPAN') return false;
            var td = node.style.textDecoration || node.style.textDecorationLine || '';
            return td.indexOf('line-through') !== -1;
        },
        replacement: function(content) {
            content = content.trim();
            if (!content) return '';
            return '~~' + content + '~~';
        }
    });

    // <pre> 配下を再帰 walk して text 抽出 (<br> → \n)
    function preToText(n) {
        var out = '';
        var child = n.firstChild;
        while (child) {
            if (child.nodeType === 3) {
                out += child.nodeValue || '';
            } else if (child.nodeName === 'BR') {
                out += '\n';
            } else if (child.nodeType === 1) {
                out += preToText(child);
            }
            child = child.nextSibling;
        }
        return out;
    }

    // Rule 6: fenced code block + 言語抽出
    // 通常: <pre><code class="language-xxx">...</code></pre>
    // Medium 等: <pre><span class="hljs-keyword">def</span>...<br>...</pre> (code 要素なし、改行 <br>)
    turndownService.addRule('fencedCodeWithLang', {
        filter: function(node) {
            if (node.nodeName !== 'PRE') return false;
            if (node.querySelector('code')) return true;
            if (node.querySelector('[class*="hljs-"]')) return true;
            if (node.querySelector('br')) return true;
            return false;
        },
        replacement: function(content, node) {
            var code = node.querySelector('code');
            var lang = '';
            var text = '';
            try {
                if (code) {
                    var cls = code.className || '';
                    lang = (cls.match(/language-(\S+)/) || [null, ''])[1];
                    if (!lang) lang = code.getAttribute('language') || node.getAttribute('language') || '';
                    if (!lang) lang = node.getAttribute('data-lang') || '';
                    text = code.textContent || '';
                } else {
                    text = preToText(node);
                    var langEl = node.querySelector('[class*="language-"]');
                    if (langEl) lang = (langEl.className.match(/language-(\S+)/) || [null, ''])[1];
                }
            } catch (e) {
                text = '';
            }
            if (!text) text = node.textContent || content || '';
            lang = (lang || '').split(/\s+/)[0] || '';
            if (['hljs', 'nohighlight', 'shiki'].indexOf(lang) !== -1) lang = '';
            return '\n\n```' + lang + '\n' + text.replace(/\n$/, '') + '\n```\n\n';
        }
    });

    // Rule 7: link content normalization (multi-line link, bracket citation, image-wrap simplify)
    turndownService.addRule('normalizeLink', {
        filter: function(node) {
            return node.nodeName === 'A' && node.getAttribute('href');
        },
        replacement: function(content, node) {
            var href = node.getAttribute('href');
            if (href) href = href.replace(/([()])/g, '\\$1');
            var title = node.getAttribute('title');
            if (title) title = ' "' + title.replace(/"/g, '\\"') + '"';
            else title = '';
            // <a> が heading (h1-h6) を wrap している場合は heading markdown のみ返す
            // (AWS docs 等の heading anchor link パターン)
            if (node.querySelector && node.querySelector('h1, h2, h3, h4, h5, h6')) {
                return content;
            }
            // <a> がテキストを持たず <img> だけを wrap してる場合は内側の image markdown だけ返す
            if ((node.textContent || '').trim() === '' && node.querySelector && node.querySelector('img')) {
                return content;
            }
            // multi-line link text を 1 行にまとめる
            content = content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
            if (!content) return '';
            // Wikipedia-style citation: [40] のように [..] で囲まれた link text は外側を残して中身を link 化
            var bracketMatch = content.match(/^\\?\[(.+?)\\?\]$/);
            if (bracketMatch) {
                return '[[' + bracketMatch[1] + '](' + href + title + ')]';
            }
            return '[' + content + '](' + href + title + ')';
        }
    });

    // Rule 8: inline SVG (mermaid / 図表) を data:image/svg+xml;base64 の
    // markdown image に変換する。
    //
    // なぜ outerHTML をそのまま埋め込まないか:
    // - DOM 由来の SVG は <style> が外出し + class 依存で描画されているものが多く
    //   (mermaid 等)、切り出した瞬間に style / class が効かず色・枠が消える
    // - Markdown エディタ側が inline <svg> を sanitize で落とすケースもある (GitHub 等)
    //
    // なぜ base64 data URL か:
    // - Fractal の data-url-image-extractor が `data:image/svg+xml;base64,...` を
    //   自動で .svg ファイル化 + 相対パス置換してくれる既存パスに乗せられる
    // - 単体 SVG ファイルとして完結するので、style/foreignObject も保持できる
    //
    // 注意: 中のテキスト content はそのまま別途垂れ流されないように、
    // turndown のデフォルト挙動を上書きする (filter: 'svg' で子孫を飲み込む)。
    turndownService.addRule('inlineSvg', {
        filter: 'svg',
        replacement: function(content, node) {
            // HTML の outerHTML だと <br> などの void 要素が閉じず、
            // standalone SVG (XML) として開いたときに parse error になる。
            // XMLSerializer が使えるなら XML として serialize し well-formed にする。
            var html = '';
            try {
                if (typeof XMLSerializer !== 'undefined') {
                    html = new XMLSerializer().serializeToString(node);
                }
            } catch (e) { html = ''; }
            if (!html) html = (node.outerHTML || '').trim();
            html = html.trim();
            if (!html) return '';
            // xmlns が無い場合は付与 (単体 SVG として成立させる)
            if (!/\sxmlns\s*=/.test(html)) {
                html = html.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
            }
            // base64 encode (browser: btoa, Node test: Buffer)
            var b64;
            try {
                if (typeof btoa !== 'undefined') {
                    // btoa は Latin1 のみ受け付けるので UTF-8 を経由
                    b64 = btoa(unescape(encodeURIComponent(html)));
                } else if (typeof Buffer !== 'undefined') {
                    b64 = Buffer.from(html, 'utf8').toString('base64');
                } else {
                    return '\n\n' + html + '\n\n';
                }
            } catch (e) {
                return '\n\n' + html + '\n\n';
            }
            var alt = (node.getAttribute && (
                node.getAttribute('aria-label')
                || node.getAttribute('role')
                || ''
            )) || 'diagram';
            return '\n\n![' + alt + '](data:image/svg+xml;base64,' + b64 + ')\n\n';
        }
    });

    // Rule 9: tight list item (Turndown default の loose list を抑止)
    turndownService.addRule('compactListItem', {
        filter: 'li',
        replacement: function(content, node, options) {
            content = content.replace(/^\n+/, '').replace(/\n+$/, '');
            content = content.replace(/\n/gm, '\n    ');
            var prefix = options.bulletListMarker + ' ';
            var parent = node.parentNode;
            if (parent.nodeName === 'OL') {
                var start = parent.getAttribute('start');
                var index = Array.prototype.indexOf.call(parent.children, node);
                prefix = (start ? Number(start) + index : index + 1) + '. ';
            }
            return prefix + content + (node.nextSibling ? '\n' : '');
        }
    });
}
