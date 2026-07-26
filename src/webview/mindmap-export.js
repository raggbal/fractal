/**
 * MindmapExport — mindmap を OPML / Markdown / SVG / PNG に書き出す。
 *
 * OPML / Markdown は純関数 (Node 単体テスト可能)。
 * SVG / PNG は foreignObject taint を避けるため純 SVG プリミティブで再描画する
 * (#M3, session-log: decision-png-export)。SVG/PNG は DOM 依存のため webview 実行時のみ。
 *
 * 仕様の正典: design/system/api.md
 */

// eslint-disable-next-line no-unused-vars
var MindmapExport = (function() {
    'use strict';

    function escapeXml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * OPML エクスポート (純関数)。ツリー構造を <outline> のネストで表現。
     * @param {Object} model - OutlinerModel (rootIds, nodes, title?)
     * @returns {string} OPML XML
     */
    function toOpml(model) {
        var lines = [];
        lines.push('<?xml version="1.0" encoding="UTF-8"?>');
        lines.push('<opml version="2.0">');
        lines.push('  <head><title>' + escapeXml(model.title || 'Mindmap') + '</title></head>');
        lines.push('  <body>');

        function walk(id, depth) {
            var n = model.nodes[id];
            if (!n) { return; }
            var indent = new Array(depth + 3).join('  ');
            var kids = (n.children || []).filter(function(c) { return !!model.nodes[c]; });
            var attrs = 'text="' + escapeXml(n.text || '') + '"';
            if (n.isPage) { attrs += ' _page="true"'; }
            if (n.tags && n.tags.length) { attrs += ' _tags="' + escapeXml(n.tags.join(' ')) + '"'; }
            if (kids.length === 0) {
                lines.push(indent + '<outline ' + attrs + '/>');
            } else {
                lines.push(indent + '<outline ' + attrs + '>');
                for (var i = 0; i < kids.length; i++) { walk(kids[i], depth + 1); }
                lines.push(indent + '</outline>');
            }
        }

        var roots = (model.rootIds || []).filter(function(id) { return !!model.nodes[id]; });
        for (var r = 0; r < roots.length; r++) { walk(roots[r], 0); }
        lines.push('  </body>');
        lines.push('</opml>');
        return lines.join('\n');
    }

    /**
     * Markdown エクスポート (純関数)。親ノードを見出し、葉を箇条書きに。
     * 既存 llms-txt と整合する形式 (深い階層はネストした箇条書き)。
     * @param {Object} model
     * @returns {string} Markdown
     */
    function toMarkdown(model) {
        var out = [];
        var roots = (model.rootIds || []).filter(function(id) { return !!model.nodes[id]; });

        function walk(id, depth) {
            var n = model.nodes[id];
            if (!n) { return; }
            var kids = (n.children || []).filter(function(c) { return !!model.nodes[c]; });
            var text = (n.text || '').trim();
            if (depth < 6 && kids.length > 0) {
                // 見出し (H1..H6)
                out.push(new Array(depth + 2).join('#') + ' ' + text);
                out.push('');
                for (var i = 0; i < kids.length; i++) { walk(kids[i], depth + 1); }
            } else {
                // 箇条書き (深さに応じてインデント)
                var indentLevel = Math.max(0, depth - 5);
                out.push(new Array(indentLevel + 1).join('  ') + '- ' + text);
                for (var j = 0; j < kids.length; j++) { walk(kids[j], depth + 1); }
            }
        }

        for (var r = 0; r < roots.length; r++) {
            walk(roots[r], 0);
            out.push('');
        }
        return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + (out.length ? '\n' : '');
    }

    /**
     * エクスポート用の純 SVG を生成する (foreignObject を使わない → canvas taint 回避 #M3)。
     * ノードは <rect> + <text> + <image> のプリミティブで再描画する。
     * @param {Object} model
     * @param {Object} layoutResult - MindmapLayout.compute の戻り値
     * @param {Function} measure
     * @returns {string} 自己完結 SVG 文字列
     */
    function toExportSvg(model, layoutResult, measure) {
        measure = measure || function() { return { width: 120, height: 32 }; };
        var b = layoutResult.bounds;
        var pad = 40;
        var vbX = b.minX - pad, vbY = b.minY - pad;
        var vbW = (b.maxX - b.minX) + pad * 2, vbH = (b.maxY - b.minY) + pad * 2;
        var parts = [];
        parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
            vbX + ' ' + vbY + ' ' + Math.max(vbW, 100) + ' ' + Math.max(vbH, 100) +
            '" width="' + Math.max(vbW, 100) + '" height="' + Math.max(vbH, 100) + '">');
        parts.push('<rect x="' + vbX + '" y="' + vbY + '" width="' + Math.max(vbW, 100) +
            '" height="' + Math.max(vbH, 100) + '" fill="#ffffff"/>');

        // links
        for (var i = 0; i < layoutResult.links.length; i++) {
            var lk = layoutResult.links[i];
            parts.push('<path d="M' + lk.sx + ',' + lk.sy + ' C' + ((lk.sx + lk.tx) / 2) + ',' + lk.sy +
                ' ' + ((lk.sx + lk.tx) / 2) + ',' + lk.ty + ' ' + lk.tx + ',' + lk.ty +
                '" fill="none" stroke="#b0b0b0" stroke-width="2"/>');
        }
        // nodes (rect + text)
        var positions = layoutResult.positions;
        for (var id in positions) {
            if (!positions.hasOwnProperty(id) || !model.nodes[id]) { continue; }
            var p = positions[id];
            var m = measure(id);
            var n = model.nodes[id];
            var fill = (n.mindmap && n.mindmap.fill) || '#f7f7f7';
            var stroke = (n.mindmap && n.mindmap.stroke) || '#d0d0d0';
            parts.push('<rect x="' + (p.x - m.width / 2) + '" y="' + (p.y - m.height / 2) +
                '" width="' + m.width + '" height="' + m.height + '" rx="8" fill="' +
                escapeXml(fill) + '" stroke="' + escapeXml(stroke) + '" stroke-width="1.5"/>');
            parts.push('<text x="' + p.x + '" y="' + (p.y + 4) +
                '" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#222">' +
                escapeXml(n.text || '') + '</text>');
        }
        parts.push('</svg>');
        return parts.join('\n');
    }

    /**
     * SVG 文字列 → PNG dataURL (webview のみ、DOM/canvas 依存)。
     * foreignObject を含まない純 SVG を渡すこと (toExportSvg の出力)。
     * @returns {Promise<string>} data:image/png;base64,...  (失敗時 reject)
     */
    function toPng(svgString, width, height) {
        return new Promise(function(resolve, reject) {
            try {
                var img = new Image();
                var svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
                var url = URL.createObjectURL(svgBlob);
                img.onload = function() {
                    try {
                        var canvas = document.createElement('canvas');
                        canvas.width = width || img.width || 800;
                        canvas.height = height || img.height || 600;
                        var cctx = canvas.getContext('2d');
                        cctx.fillStyle = '#ffffff';
                        cctx.fillRect(0, 0, canvas.width, canvas.height);
                        cctx.drawImage(img, 0, 0);
                        URL.revokeObjectURL(url);
                        // taint していれば toDataURL が SecurityError を投げる
                        resolve(canvas.toDataURL('image/png'));
                    } catch (e) {
                        URL.revokeObjectURL(url);
                        reject(e);
                    }
                };
                img.onerror = function(e) { URL.revokeObjectURL(url); reject(e); };
                img.src = url;
            } catch (e) { reject(e); }
        });
    }

    return {
        toOpml: toOpml,
        toMarkdown: toMarkdown,
        toExportSvg: toExportSvg,
        toPng: toPng
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MindmapExport;
}
