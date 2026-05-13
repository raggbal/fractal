// Turndown 投入前の HTML 前処理。
//
// ensureTableHeaders: turndown-plugin-gfm は isHeadingRow=true でないと <table> を raw HTML のまま保持する。
// GFM 仕様で header 行は必須なので、<th> を持たない <table> に空の <thead> を column 数分注入して
// markdown table 化を可能にする。元データはそのまま data row として保存。
//
// inlineSvgComputedStyles: <svg> 配下の要素に getComputedStyle の結果を style="" として焼き付ける。
// 呼び出し時点で root が live DOM に attach されている必要がある (computed style が取れる前提)。
// 焼き付け後は外部 <style>/<link>/class に依存しない self-contained な SVG になるので、
// Readability や cleanupSel で <style> が剥がれた後でも正常にレンダリングされる。
//
// 利用側: DOMParser が使える環境 (browser / Playwright eval) を前提。

// SVG 関連要素で style として意味があるプロパティ (全部 inline 化するとサイズが爆発するので絞る)。
// 参考: https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/Presentation
var SVG_STYLE_PROPS = [
    'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
    'opacity', 'visibility', 'display',
    'font-family', 'font-size', 'font-weight', 'font-style',
    'text-anchor', 'dominant-baseline', 'alignment-baseline',
    'color', 'background-color',
    'paint-order', 'mix-blend-mode',
    'marker-start', 'marker-mid', 'marker-end',
    // overflow: foreignObject は XML parser 直読みだと default overflow:hidden で
    // ラベル 2 行目がクリップされる。Mermaid の CSS に依存せず可視化するため入れる。
    'overflow'
];

// Mermaid / foreignObject で使われる HTML 要素の style も保持する。
var HTML_STYLE_PROPS_IN_SVG = [
    'color', 'background-color', 'font-family', 'font-size', 'font-weight',
    'font-style', 'text-align', 'line-height', 'padding', 'margin',
    'border', 'border-radius', 'display', 'white-space', 'text-decoration',
    'overflow'
];

function _inlineComputedStyleOn(el, propList) {
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (!win || typeof win.getComputedStyle !== 'function') return;
    var cs;
    try { cs = win.getComputedStyle(el); } catch (e) { return; }
    if (!cs) return;
    var existing = el.getAttribute('style') || '';
    var out = existing ? (existing.replace(/;?\s*$/, '') + ';') : '';
    for (var i = 0; i < propList.length; i++) {
        var p = propList[i];
        var v;
        try { v = cs.getPropertyValue(p); } catch (e) { continue; }
        if (!v) continue;
        v = v.trim();
        if (!v || v === 'none' && p !== 'marker-start' && p !== 'marker-mid' && p !== 'marker-end') continue;
        // すでに同じプロパティが style 文字列にあればスキップ (既存を尊重)
        var re = new RegExp('(?:^|;)\\s*' + p.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*:', 'i');
        if (re.test(existing)) continue;
        out += p + ':' + v + ';';
    }
    if (out && out !== existing) el.setAttribute('style', out);
}

function inlineSvgComputedStyles(root) {
    if (!root || !root.querySelectorAll) return;
    var svgs = root.querySelectorAll('svg');
    for (var s = 0; s < svgs.length; s++) {
        var svg = svgs[s];
        if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        // SVG 自身 + 配下の SVG-namespaced 要素
        _inlineComputedStyleOn(svg, SVG_STYLE_PROPS);
        var svgDescendants = svg.querySelectorAll('*');
        for (var d = 0; d < svgDescendants.length; d++) {
            var el = svgDescendants[d];
            // SVG namespace の要素は SVG props、foreignObject 配下は HTML props を使う
            var ns = el.namespaceURI || '';
            var propList = ns.indexOf('svg') >= 0 ? SVG_STYLE_PROPS : HTML_STYLE_PROPS_IN_SVG;
            _inlineComputedStyleOn(el, propList);
        }
        // foreignObject 直下の HTML 要素には xhtml namespace を付与
        // (standalone SVG として開いたときに renderer が HTML parser を呼ぶ条件)
        var foreignObjects = svg.querySelectorAll('foreignObject');
        for (var f = 0; f < foreignObjects.length; f++) {
            var fo = foreignObjects[f];
            // foreignObject の computed overflow は browser default で hidden。
            // standalone SVG として開くと SVG の幅/高さは親 <g> の transform で
            // 正しいが、foreignObject 内部の HTML レイアウトが browser と
            // standalone parser で微妙に違う（Amazon Ember font vs 代替 font 等）
            // ため、内容が foreignObject 幅を超えるとクリップされて右端が切れる。
            // 強制的に visible にしてクリップを無効化する (Mermaid もこの意図)。
            var foStyle = fo.getAttribute('style') || '';
            if (/(?:^|;)\s*overflow\s*:/i.test(foStyle)) {
                foStyle = foStyle.replace(/(?:^|;)\s*overflow\s*:[^;]*;?/i, ';overflow:visible;');
            } else {
                foStyle = (foStyle ? foStyle.replace(/;?\s*$/, '') + ';' : '') + 'overflow:visible;';
            }
            fo.setAttribute('style', foStyle);
            for (var k = 0; k < fo.children.length; k++) {
                var topChild = fo.children[k];
                // 既に xmlns があるならスキップ
                if (!topChild.hasAttribute || !topChild.hasAttribute('xmlns')) {
                    if (topChild.setAttribute) {
                        topChild.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
                    }
                }
                // 子の div も visible にする (white-space:nowrap + overflow:hidden で切られるケース)
                if (topChild.style) {
                    try { topChild.style.overflow = 'visible'; } catch(e) {}
                }
            }
        }
    }
}

// Readability は SVG の class / transform 等を落としてしまいレイアウトが崩れる。
// そうなる前に <svg> を "self-contained な data URL を持つ <img>" に差し替える。
// inlineSvgComputedStyles → preSerializeSvgsToImages → Readability の順で使う。
//
// 副次的メリット: Rule 8 (inlineSvg) を通さなくても同じ結果になるので、
// turndown が SVG 要素を消しても出力に画像が残る。
function preSerializeSvgsToImages(root) {
    if (!root || !root.querySelectorAll) return;
    var svgs = root.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
        var svg = svgs[i];
        if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        var xmlString = '';
        try {
            if (typeof XMLSerializer !== 'undefined') {
                xmlString = new XMLSerializer().serializeToString(svg);
            }
        } catch (e) { xmlString = ''; }
        if (!xmlString) xmlString = svg.outerHTML || '';
        if (!xmlString) continue;
        var b64 = '';
        try {
            if (typeof btoa !== 'undefined') {
                b64 = btoa(unescape(encodeURIComponent(xmlString)));
            } else if (typeof Buffer !== 'undefined') {
                b64 = Buffer.from(xmlString, 'utf8').toString('base64');
            }
        } catch (e) { b64 = ''; }
        if (!b64) continue;
        var doc = svg.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!doc) continue;
        var img = doc.createElement('img');
        img.setAttribute('src', 'data:image/svg+xml;base64,' + b64);
        var alt = (svg.getAttribute && (
            svg.getAttribute('aria-label') || svg.getAttribute('role') || ''
        )) || 'diagram';
        img.setAttribute('alt', alt);
        if (svg.parentNode) svg.parentNode.replaceChild(img, svg);
    }
}

// heading (h1-h6) が <a> で wrap / heading-only の div で wrap されているケースを
// heading 単体に promote する。
//
// 例:
//   <a href="#id"><h2>Title</h2></a>                          → <h2>Title</h2>
//   <div class="heading-wrapper"><h2>Title</h2><span>◆</span></div> → <h2>Title</h2>
//   <div><a href="#id"><h2>Title</h2></a><span>◆</span></div>  → <h2>Title</h2>
//
// なぜ必要か:
//   1. Readability は <a> で heading を wrap すると link density = 100% として削除する。
//   2. Readability の _cleanConditionally は "img=0 && textDensity=0" な <div> を
//      削除するため、「<h2> + 装飾 <span><svg>」という heading-only wrapper も丸ごと消える
//      (例: AWS Workshop Studio の SectionHeading-module_headingLinkContainer)。
//   Readability に渡す前にこれらを解除しておけば heading は block-level ノードとして残る。
//
// Turndown の Rule 7 (normalizeLink) でも同様の unwrap はしているが、そちらは
// Readability 通過後の HTML に対する処理であり、すでに heading が削除された後では
// 効かない。ここでは live DOM (またはその clone) に対して Readability より前に適用する。
function unwrapHeadingAnchors(root) {
    if (!root || !root.querySelectorAll) return;

    // Step 1: <a><hN>…</hN></a> → <hN>…</hN>
    var anchors = root.querySelectorAll('a');
    for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        if (!a || !a.parentNode) continue;
        var heading = null;
        for (var j = 0; j < a.children.length; j++) {
            var c = a.children[j];
            if (/^H[1-6]$/.test(c.tagName)) { heading = c; break; }
        }
        if (!heading) continue;
        var hasOtherText = false;
        for (var k = 0; k < a.childNodes.length; k++) {
            var n = a.childNodes[k];
            if (n === heading) continue;
            if (n.nodeType === 3 && (n.nodeValue || '').trim() !== '') { hasOtherText = true; break; }
            if (n.nodeType === 1 && /^H[1-6]$/.test(n.tagName) === false && (n.textContent || '').trim() !== '') {
                hasOtherText = true; break;
            }
        }
        if (hasOtherText) continue;
        var href = a.getAttribute && a.getAttribute('href');
        if (href && href.charAt(0) === '#' && !heading.getAttribute('id')) {
            heading.setAttribute('id', href.slice(1));
        }
        a.parentNode.replaceChild(heading, a);
    }

    // Step 2: heading-only wrapper div を heading に置き換え
    //   条件: <div> 配下に heading が 1 つあり、かつ他の要素は装飾 (anchor アイコン
    //   span + 小 svg) のみでテキストを持たないケースを対象にする。
    //   判定は「div の textContent の trim 後が heading.textContent に一致」で十分。
    //   DOM live list を後ろから処理することでイテレーション中の replace も安全。
    var divs = root.querySelectorAll('div');
    for (var d = divs.length - 1; d >= 0; d--) {
        var div = divs[d];
        if (!div || !div.parentNode) continue;
        var hs = div.querySelectorAll('h1, h2, h3, h4, h5, h6');
        if (hs.length !== 1) continue;
        var h = hs[0];
        // heading の parent chain が同じ div の外に出ないことを確認 (直系子孫のみ扱う)
        // e.g. div > span > h2 も対象とする
        var divText = (div.textContent || '').replace(/\s+/g, ' ').trim();
        var hText = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (!hText) continue;
        if (divText !== hText) continue;
        // heading を取り外して div と差し替え
        if (h.parentNode) h.parentNode.removeChild(h);
        div.parentNode.replaceChild(h, div);
    }
}

function ensureTableHeaders(htmlString) {
    try {
        if (typeof DOMParser === 'undefined') return htmlString;
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlString, 'text/html');
        var tables = doc.querySelectorAll('table');
        for (var ti = 0; ti < tables.length; ti++) {
            var table = tables[ti];
            if (table.querySelector('th')) continue;
            var existingThead = table.querySelector('thead');
            if (existingThead && existingThead.textContent.trim()) continue;
            var firstRow = table.querySelector('tr');
            if (!firstRow) continue;
            var colCount = firstRow.children.length;
            if (colCount === 0) continue;
            // 空 thead があれば削除して入れ直す
            if (existingThead) existingThead.parentNode.removeChild(existingThead);
            var thead = doc.createElement('thead');
            var tr = doc.createElement('tr');
            for (var ci = 0; ci < colCount; ci++) {
                tr.appendChild(doc.createElement('th'));
            }
            thead.appendChild(tr);
            table.insertBefore(thead, table.firstChild);
        }
        return doc.body.innerHTML;
    } catch (e) {
        return htmlString;
    }
}
