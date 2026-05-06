/**
 * Fractal HTML → Markdown 変換ロジック (Chrome ext 用に抽出)
 *
 * src/webview/editor.js の paste handler (16349 行〜) からコピー。
 * Turndown + GFM + Fractal 独自の追加 rule (table cell pipe escape, span cleanup,
 * style-based bold/italic/strike, fenced code with lang, normalized link, compact list,
 * post-process unescape & list compaction).
 *
 * Usage:
 *   const md = FractalMd.htmlToMarkdown(htmlString);
 *
 * 依存: turndown.js / turndown-plugin-gfm.js を先に load しておく
 */
(function (global) {
    'use strict';

    function htmlToMarkdown(html) {
        if (!html) return '';
        if (typeof TurndownService === 'undefined') {
            throw new Error('TurndownService not loaded');
        }
        const turndownService = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            emDelimiter: '*',
            bulletListMarker: '-'
        });
        if (typeof turndownPluginGfm !== 'undefined') {
            turndownService.use(turndownPluginGfm.gfm);
        }

        // table cell: pipe escape + newline → <br>
        turndownService.addRule('tableCellEscapePipe', {
            filter: ['th', 'td'],
            replacement: function (content, node) {
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

        // empty span / Apple-converted-space cleanup
        turndownService.addRule('cleanupSpans', {
            filter: function (node) {
                if (node.nodeName !== 'SPAN') return false;
                if (node.classList && node.classList.contains('Apple-converted-space')) return true;
                const hasOnlyStyleAttr = node.attributes.length === 1 && node.hasAttribute('style');
                const hasNoContent = !node.textContent || node.textContent.trim() === '';
                return hasOnlyStyleAttr && hasNoContent;
            },
            replacement: function (content, node) {
                if (node.classList && node.classList.contains('Apple-converted-space')) return ' ';
                return content;
            }
        });

        // CSS-style bold
        turndownService.addRule('styledBold', {
            filter: function (node) {
                if (node.nodeName !== 'SPAN') return false;
                const fw = node.style.fontWeight;
                return fw === 'bold' || fw === 'bolder' || (parseInt(fw) >= 700);
            },
            replacement: function (content) {
                content = content.trim();
                if (!content) return '';
                return '**' + content + '**';
            }
        });

        // CSS-style italic
        turndownService.addRule('styledItalic', {
            filter: function (node) {
                if (node.nodeName !== 'SPAN') return false;
                const fs = node.style.fontStyle;
                return fs === 'italic' || fs === 'oblique';
            },
            replacement: function (content) {
                content = content.trim();
                if (!content) return '';
                return '*' + content + '*';
            }
        });

        // CSS-style strikethrough
        turndownService.addRule('styledStrikethrough', {
            filter: function (node) {
                if (node.nodeName !== 'SPAN') return false;
                const td = node.style.textDecoration || node.style.textDecorationLine || '';
                return td.includes('line-through');
            },
            replacement: function (content) {
                content = content.trim();
                if (!content) return '';
                return '~~' + content + '~~';
            }
        });

        // fenced code with language extraction
        turndownService.addRule('fencedCodeWithLang', {
            filter: function (node) {
                return node.nodeName === 'PRE' && node.querySelector('code');
            },
            replacement: function (content, node) {
                var code = node.querySelector('code');
                var cls = code.className || '';
                var lang = (cls.match(/language-(\S+)/) || [null, ''])[1];
                if (!lang) lang = code.getAttribute('language') || node.getAttribute('language') || '';
                if (!lang) lang = node.getAttribute('data-lang') || '';
                lang = lang.split(/\s+/)[0] || '';
                if (['hljs', 'nohighlight', 'shiki'].indexOf(lang) !== -1) lang = '';
                var text = code.textContent || '';
                return '\n\n```' + lang + '\n' + text.replace(/\n$/, '') + '\n```\n\n';
            }
        });

        // normalize link content
        turndownService.addRule('normalizeLink', {
            filter: function (node) {
                return node.nodeName === 'A' && node.getAttribute('href');
            },
            replacement: function (content, node) {
                var href = node.getAttribute('href');
                if (href) href = href.replace(/([()])/g, '\\$1');
                var title = node.getAttribute('title');
                if (title) title = ' "' + title.replace(/"/g, '\\"') + '"';
                else title = '';
                // <a> がテキストを持たず <img> だけを wrap してる場合は、内側の image markdown
                // だけを返す。`[![alt](src)](href)` を `![alt](src)` に簡略化
                // (note.com 等の見出し画像 link を綺麗な image embed に)
                if ((node.textContent || '').trim() === '' && node.querySelector && node.querySelector('img')) {
                    return content;
                }
                content = content.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
                if (!content) return '';
                var bracketMatch = content.match(/^\\?\[(.+?)\\?\]$/);
                if (bracketMatch) {
                    return '[[' + bracketMatch[1] + '](' + href + title + ')]';
                }
                return '[' + content + '](' + href + title + ')';
            }
        });

        // compact list items
        turndownService.addRule('compactListItem', {
            filter: 'li',
            replacement: function (content, node, options) {
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

        let pastedMd = turndownService.turndown(html);

        // Post-process: unescape Markdown block-level syntax markers
        pastedMd = pastedMd.replace(/^\\([-+*]) /gm, '$1 ');
        pastedMd = pastedMd.replace(/^\\(#{1,6}) /gm, '$1 ');
        pastedMd = pastedMd.replace(/^\\(>) ?/gm, '$1 ');
        pastedMd = pastedMd.replace(/^(\d+)\\(\. )/gm, '$1$2');
        pastedMd = pastedMd.replace(/^\\(~~~)/gm, '$1');
        pastedMd = pastedMd.replace(/\\([*_`\[\]\\.])/g, '$1');

        // Post-process: collapse blank lines between consecutive list items
        let prev;
        do {
            prev = pastedMd;
            pastedMd = pastedMd.replace(
                /(^[ \t]*(?:[-*+]|\d+\.)\s+.*)\n{2,}([ \t]*(?:[-*+]|\d+\.)\s)/gm,
                '$1\n$2'
            );
        } while (pastedMd !== prev);

        return pastedMd;
    }

    /** Mozilla Readability で記事抽出 → Fractal HTML→MD 変換 */
    function articleToMarkdown(documentClone) {
        if (typeof Readability === 'undefined') {
            throw new Error('Readability not loaded');
        }
        const reader = new Readability(documentClone);
        const article = reader.parse();
        if (!article || !article.content) {
            return { title: '', markdown: '', byline: '', siteName: '' };
        }
        const md = htmlToMarkdown(article.content);
        return {
            title: article.title || '',
            markdown: md,
            byline: article.byline || '',
            siteName: article.siteName || '',
            length: article.length,
            excerpt: article.excerpt || ''
        };
    }

    global.FractalMd = {
        htmlToMarkdown: htmlToMarkdown,
        articleToMarkdown: articleToMarkdown
    };
})(typeof window !== 'undefined' ? window : this);
