// frame-boot.js — drawio の隔離 iframe（sandbox="allow-scripts"・opaque origin）の中で実行する起動コード
//
// sprint 20261009-130815-file-viewer-drawio / ADRL-0135 / design/system/drawio-viewer.md §6。
// build-viewer-modules.js が文字列として viewer-drawio.mjs に取り込み、frame-doc.mjs が nonce 付き inline script で
// draw.io 本体（viewer-static.min.js / stencils.min.js）の後に埋め込む。
//
// 通信は親が渡す MessagePort だけ（window.postMessage での返信は親の "null" origin 拒否で届かない — ADRL-0067）:
//   親 → {type:'drawioInit'} + port（window message・1 回だけ受ける）
//   親 → port {type:'load', format:'xml'|'svg'|'png', data: string|ArrayBuffer}
//   iframe → port {type:'rendered', pages:[{name}], page, layers:[{id,name,visible}]} / {type:'noDiagram'} / {type:'error', code}
(function () {
    'use strict';
    var MAX_XML_CHARS = 20 * 1024 * 1024; // NFR-DIO-07
    var port = null;
    var graph = null;
    var editor = null;
    var pages = [];   // [{ name, diagram?: Element, model?: Element }]
    var pageIndex = 0;
    var libOk = typeof Graph !== 'undefined' && typeof Editor !== 'undefined' && typeof mxUtils !== 'undefined';

    function post(m) { if (port) { port.postMessage(m); } }

    if (libOk) {
        // 図の形状 JS を取ってきて eval する経路を止める（'unsafe-eval' 不要 — INV-D4）
        mxStencilRegistry.allowEval = false;
        Editor.suppressNewWindows = true;
        // 図中リンクで遷移させない（sandbox でも iframe 自身の遷移はできてしまう — INV-D6）
        Graph.prototype.openLink = function () { return null; };
    }
    document.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (a) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    window.addEventListener('message', function (e) {
        if (port || !e.data || e.data.type !== 'drawioInit' || !e.ports || !e.ports[0]) { return; }
        port = e.ports[0];
        port.onmessage = function (ev) { onCommand(ev.data || {}); };
    });

    function onCommand(m) {
        if (m.type === 'load') { load(m); }
    }

    function fail(code) { post({ type: 'error', code: code }); }

    function load(m) {
        if (!libOk) { fail('lib'); return; }
        if (m.format === 'png') {
            var reader = new FileReader();
            reader.onload = function () {
                var xml = null;
                try { xml = Editor.extractGraphModelFromPng(String(reader.result)); } catch (e) { xml = null; }
                if (!xml) { post({ type: 'noDiagram' }); return; }
                fromXmlText(xml);
            };
            reader.onerror = function () { fail('parse'); };
            reader.readAsDataURL(new Blob([m.data], { type: 'image/png' }));
            return;
        }
        if (m.format === 'svg') {
            var node = null;
            try {
                var doc = mxUtils.parseXml(String(m.data || ''));
                // content 属性が無い（普通の SVG）は例外になる → 画像表示へ戻す
                node = Editor.extractGraphModel(doc.documentElement, true);
            } catch (e) { node = null; }
            if (!node) { post({ type: 'noDiagram' }); return; }
            if (mxUtils.getXml(node).length > MAX_XML_CHARS) { fail('tooLarge'); return; }
            fromNode(node);
            return;
        }
        fromXmlText(String(m.data || ''));
    }

    function fromXmlText(text) {
        text = text.trim();
        if (text.length > MAX_XML_CHARS) { fail('tooLarge'); return; }
        var doc = mxUtils.parseXml(text);
        if (doc.getElementsByTagName('parsererror').length) { fail('parse'); return; }
        fromNode(doc.documentElement);
    }

    function fromNode(root) {
        pages = [];
        if (root && root.nodeName === 'mxfile') {
            var ds = root.getElementsByTagName('diagram');
            for (var i = 0; i < ds.length; i++) {
                pages.push({ name: ds[i].getAttribute('name') || ('Page-' + (i + 1)), diagram: ds[i] });
            }
        } else if (root && root.nodeName === 'mxGraphModel') {
            pages.push({ name: 'Page-1', model: root });
        }
        if (!pages.length) { fail('parse'); return; }
        show(0);
    }

    function ensureGraph() {
        if (graph) { return; }
        var pane = document.getElementById('pane');
        graph = new Graph(pane);
        graph.setEnabled(false); // 読み取り専用
        editor = new Editor(true, null, null, graph);
    }

    // 全体表示（最大 100%・中央寄せ — howto §3）
    function fit(pad) {
        pad = pad == null ? 16 : pad;
        var pane = document.getElementById('pane');
        var b = graph.getGraphBounds(), s = graph.view.scale, t = graph.view.translate;
        var w = b.width / s, h = b.height / s, x = b.x / s - t.x, y = b.y / s - t.y;
        if (!(w > 0) || !(h > 0)) { return; }
        var z = Math.min(1, (pane.clientWidth - 2 * pad) / w, (pane.clientHeight - 2 * pad) / h);
        if (!(z > 0)) { z = 1; }
        graph.view.scaleAndTranslate(z, (pane.clientWidth / z - w) / 2 - x, (pane.clientHeight / z - h) / 2 - y);
    }

    function layers() {
        var model = graph.getModel();
        var root = model.getRoot();
        var out = [];
        for (var i = 0; i < model.getChildCount(root); i++) {
            var c = model.getChildAt(root, i);
            var v = c.value;
            var name = (typeof v === 'string' && v) ? v : (v && v.getAttribute ? (v.getAttribute('label') || '') : '');
            out.push({ id: String(c.id), name: name || ('Layer ' + (i + 1)), visible: model.isVisible(c) });
        }
        return out;
    }

    function show(i) {
        try {
            ensureGraph();
            var p = pages[i];
            var node = p.diagram ? Editor.parseDiagramNode(p.diagram) : p.model;
            if (!node) { fail('parse'); return; }
            graph.view.translate = new mxPoint();
            graph.view.scale = 1;
            var model = graph.getModel();
            model.beginUpdate();
            try { model.clear(); editor.setGraphXml(node); } finally { model.endUpdate(); }
            pageIndex = i;
            fit();
            post({
                type: 'rendered',
                pages: pages.map(function (pg) { return { name: pg.name }; }),
                page: pageIndex,
                layers: layers(),
            });
        } catch (e) {
            fail('parse');
        }
    }
})();
