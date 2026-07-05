/**
 * MindmapRender — レイアウト計算結果を SVG に描画する。
 *
 * レイヤ: groups(背面) < links < relationships < nodes(前面)。
 * ノードは foreignObject に既存 OutlinerCell.renderInlineText を使ったリッチ HTML。
 * 接続線 path は自前計算 (d3.linkRadial は vendor に無いため — session-log: finding-no-linkRadial)。
 *
 * 型・描画仕様の正典: design/system/rendering.md, data-model.md
 */

// eslint-disable-next-line no-unused-vars
var MindmapRender = (function() {
    'use strict';

    var SVGNS = 'http://www.w3.org/2000/svg';
    var XHTMLNS = 'http://www.w3.org/1999/xhtml';

    // 現在の viewport (ズーム/パン)。揮発 (保存しない)。
    var viewport = { scale: 1, translateX: 0, translateY: 0 };
    var _bodyEls = [];   // body 直下に付けた要素 (destroy で除去)
    var _lastCtx = null; // 再描画用に render の引数を保持

    function el(tag, attrs) {
        var e = document.createElementNS(SVGNS, tag);
        if (attrs) {
            for (var k in attrs) {
                if (attrs.hasOwnProperty(k) && attrs[k] != null) {
                    e.setAttribute(k, attrs[k]);
                }
            }
        }
        return e;
    }

    // --- ノード実寸の概算 (#M4: 1 パス目。実寸は 2 パス目 getBoundingClientRect で補正) ---
    function estimateMeasure(node, fontSize) {
        var fs = fontSize || 14;
        var text = (node && node.text) || '';
        // 明示改行 (\n) で行数を分けてから、各行の折り返しを加算 (FR-021-A6)
        var explicitLines = String(text).split('\n');
        var charW = fs * 0.6;
        // アイコン(📄/📎)があるノードは幅に余白を足す (アイコン分)
        var iconPad = (node && (node.isPage || node.filePath)) ? 20 : 0;
        var longest = 0;
        for (var i = 0; i < explicitLines.length; i++) {
            if (explicitLines[i].length > longest) { longest = explicitLines[i].length; }
        }
        var maxW = 280;
        // 自然幅 (折り返し前にテキストを 1 行で収めるのに必要な幅)
        var naturalW = longest * charW + 24 + iconPad;
        var w = Math.max(80, Math.min(maxW, naturalW));
        var wrapCount = 0;
        for (var j = 0; j < explicitLines.length; j++) {
            wrapCount += Math.max(1, Math.ceil((explicitLines[j].length * charW) / (w - 24 - iconPad || 1)));
        }
        var lines = Math.max(explicitLines.length, wrapCount);
        // #改 (iteration 13, TASK-43): ノード幅 = 最長行の自然幅にフィット・上限 280。
        // 改行数・折り返し有無で 280 に固定しない (decision-a6-fit-longest-line-cap-280)。
        //   naturalW <= 280 → 最長行フィット (短い行の複数行ノードは 280 未満)。
        //   naturalW > 280  → 280 でクランプ (長い行は 280 で折り返して縦伸び)。
        // w は既に上で Math.max(80, Math.min(maxW, naturalW)) で確定済み。
        // 高さ (lines) は明示改行 + 折り返しで計算するので縦は従来どおり変わらない。
        var h = lines * (fs + 6) + 12;
        if (node && node.images && node.images.length) { h += 60; }
        if (node && (node.tags && node.tags.length)) { h += 4; }
        return { width: w, height: h };
    }

    // --- 2 パス目の確定幅を実 DOM の最長行から実測 (iteration 14, TASK-44) ---
    // interactions.js の measureLongestLineWidth / adjustEditWidth と同方式で測り、
    // 「編集中の幅」と「commit 後の確定幅」を一致させる。char 推定 (全角過小) の是正。
    //  - box 内の .mindmap-node-text を一時 nowrap にして各行の scrollWidth 最大 (画面座標) を得る。
    //  - viewport.scale で割り SVG 内部座標へ換算、padding(24) + iconPad を足す。
    //  - Math.min(280, ...) で上限クランプ、Math.max(80, ...) で下限確保 (estimateMeasure と整合)。
    //  - 編集中ノード (contenteditable=true) は A7 が管理中なので概算 (estimateMeasure) を返す
    //    (live DOM の white-space を触らない = caret/IME 無傷、generator_failures 2026-07-02 原則)。
    function measureRealWidth(box, node, fontSize) {
        var estW = estimateMeasure(node, fontSize).width;
        if (!box || !box.querySelector) { return estW; }
        var text = box.querySelector('.mindmap-node-text');
        if (!text) { return estW; }
        // 編集中ノードは触らない (A7 管理中)。概算で返す。
        if (text.getAttribute && text.getAttribute('contenteditable') === 'true') { return estW; }
        var raw = (node && node.text) || '';
        var lines = String(raw).split('\n');
        var scale = viewport.scale || 1;
        // 一時 nowrap にして最長行の scrollWidth を測り、必ず元に戻す (DOM 破壊しない)。
        var hadNowrap = text.classList && text.classList.contains('is-editing-nowrap');
        var prevWhiteSpace = text.style ? text.style.whiteSpace : '';
        if (text.style) { text.style.whiteSpace = 'nowrap'; }
        var savedHTML = null;
        var maxScreen = 0;
        if (lines.length <= 1) {
            // 単一行: そのまま nowrap の scrollWidth。
            maxScreen = text.scrollWidth;
        } else {
            // 複数行: 各行を個別に測って最大を取る (renderInlineText で改行が <br> になっていても
            //  行ごとの生テキストで測る = measureLongestLineWidth と同方式)。測定後 innerHTML を復元。
            savedHTML = text.innerHTML;
            for (var li = 0; li < lines.length; li++) {
                text.textContent = (lines[li] === '' ? '​' : lines[li]);
                var w2 = text.scrollWidth;
                if (w2 > maxScreen) { maxScreen = w2; }
            }
            text.innerHTML = savedHTML;
        }
        // 元の white-space / nowrap クラス状態に戻す。
        if (text.style) { text.style.whiteSpace = prevWhiteSpace; }
        if (!hadNowrap && text.classList) { text.classList.remove('is-editing-nowrap'); }
        if (maxScreen <= 0) { return estW; }
        var fs = fontSize || 14;
        // iconPad: box 内にアイコン要素があれば余白 (adjustEditWidth と同じ 24)。
        var iconPad = (box.querySelector('.mindmap-node-icon')) ? 24 : 0;
        var needInner = maxScreen / scale + 24 + iconPad;
        return Math.max(80, Math.min(280, needInner));
    }

    // --- 2 パス目の確定高さを「補正後の幅 (realW)」で実測 (iteration 15, TASK-47) ---
    // #17 の高さ版: 従来は box の高さを pass-1 の狭い幅 (char 推定, 全角過小) で測っていたため、
    // 全角中心の 1 行ノードが pass-1 で 2 行に折り返し、その 2 行分の高さが frozen されていた
    // (幅は measureRealWidth で正しく広がるのに高さは 2 行分 = 2 行目が空白)。
    // 対策: foreignObject の width 属性を realW (SVG 内部座標) に一時セットして box をリフローさせ、
    //   その状態の box の実高さ (getBoundingClientRect().height / scale) を測る。
    //   realW は「最長行フィット・上限 280」なので、realW 幅では単一行ノードは折り返さず 1 行高さになり、
    //   280 クランプの長行のみ折り返して複数行高さ (正しい) になる。
    //   これで幅・高さとも同じ realW 基準になり整合する (decision-a6-measure-height-at-corrected-width)。
    //   fo は測定後に元幅へ戻す必要はない (pass-2 の再 render が realDims.width で正式上書きするため)。
    //   ただし戻り値は SVG 内部座標の高さ。box=null / DOM 無しなら fallbackHeight を返す。
    // 編集中ノード (contenteditable=true) は A7 が管理中なので触らず fallbackHeight を返す。
    function measureBoxHeightAtWidth(box, fo, realW, fallbackHeight) {
        if (!box || !fo || !fo.setAttribute) { return fallbackHeight; }
        var text = box.querySelector && box.querySelector('.mindmap-node-text');
        if (text && text.getAttribute && text.getAttribute('contenteditable') === 'true') {
            return fallbackHeight;
        }
        var scale = viewport.scale || 1;
        // foreignObject の width を realW (SVG 座標) にセット → box は自然に追従してリフロー。
        fo.setAttribute('width', realW);
        var h = box.getBoundingClientRect().height;
        if (!(h > 0)) { return fallbackHeight; }
        return h / scale; // 画面座標 → SVG 内部座標
    }

    // --- ノード枠形状 → border-radius ---
    function shapeToRadius(shape) {
        switch (shape) {
            case 'rectangle': return '0';
            case 'capsule': return '999px';
            case 'none': return '0';
            default: return 'var(--fr-radius-md, 8px)'; // 'rounded' or null
        }
    }

    // --- 祖先を辿って fill を継承 (FR-021-E7) ---
    function inheritedFill(model, nodeId) {
        var cur = nodeId;
        var guard = 0;
        while (cur && guard++ < 1000) {
            var n = model.nodes[cur];
            if (!n) { break; }
            if (n.mindmap && n.mindmap.fill) { return n.mindmap.fill; }
            cur = n.parentId;
        }
        return null;
    }

    // --- 接続線 path (LinkStyle 別、自前計算) ---
    function linkPath(link, style) {
        var sx = link.sx, sy = link.sy, tx = link.tx, ty = link.ty;
        if (style === 'straight') {
            return 'M' + sx + ',' + sy + ' L' + tx + ',' + ty;
        }
        if (style === 'elbow') {
            var midX = (sx + tx) / 2;
            return 'M' + sx + ',' + sy + ' L' + midX + ',' + sy + ' L' + midX + ',' + ty + ' L' + tx + ',' + ty;
        }
        if (style === 'rounded-elbow') {
            var mx = (sx + tx) / 2;
            var r = Math.min(12, Math.abs(ty - sy) / 2, Math.abs(mx - sx));
            var dirY = ty >= sy ? 1 : -1;
            var dirX = tx >= mx ? 1 : -1;
            return 'M' + sx + ',' + sy +
                ' L' + (mx - dirX * r) + ',' + sy +
                ' Q' + mx + ',' + sy + ' ' + mx + ',' + (sy + dirY * r) +
                ' L' + mx + ',' + (ty - dirY * r) +
                ' Q' + mx + ',' + ty + ' ' + (mx + dirX * r) + ',' + ty +
                ' L' + tx + ',' + ty;
        }
        // 'curved' (default): 水平方向の cubic bezier / radial は 2 点間の緩い曲線
        var cx1, cx2;
        if (link.side === 'radial') {
            // 中点を制御点にした緩い曲線
            var mxr = (sx + tx) / 2, myr = (sy + ty) / 2;
            return 'M' + sx + ',' + sy + ' Q' + mxr + ',' + myr + ' ' + tx + ',' + ty;
        }
        cx1 = (sx + tx) / 2;
        cx2 = (sx + tx) / 2;
        return 'M' + sx + ',' + sy + ' C' + cx1 + ',' + sy + ' ' + cx2 + ',' + ty + ' ' + tx + ',' + ty;
    }

    // --- ノード要素 (foreignObject) ---
    function buildTitleNodeEl(pos, measure, ctx) {
        var titleText = (ctx.titleText != null) ? ctx.titleText : '';
        var m = measure('__title__');
        // FR-021-A8: title 中心ノードは両側に子を出すハブなので、従来どおり「中心合わせ」を維持する
        // (子ノードのみ内側エッジ合わせ)。
        var fo = el('foreignObject', {
            x: pos.x - m.width / 2, y: pos.y - m.height / 2,
            width: m.width, height: m.height,
            'class': 'mindmap-node mindmap-title-node',
            'data-node-id': '__title__',
            'data-mm-title': '1'
        });
        var box = document.createElementNS(XHTMLNS, 'div');
        box.setAttribute('class', 'mindmap-node-box mindmap-title-box');
        if (ctx.focusedNodeId === '__title__') { box.classList.add('is-focused'); }
        var textDiv = document.createElementNS(XHTMLNS, 'div');
        textDiv.setAttribute('class', 'mindmap-node-text');
        textDiv.setAttribute('data-node-id', '__title__');
        textDiv.setAttribute('tabindex', '0');
        textDiv.textContent = titleText;
        box.appendChild(textDiv);
        fo.appendChild(box);
        return fo;
    }

    function buildNodeEl(model, nodeId, pos, measure, ctx) {
        if (nodeId === '__title__') { return buildTitleNodeEl(pos, measure, ctx); }
        var node = model.nodes[nodeId];
        var m = measure(nodeId);
        // FR-021-A8 (内側エッジ合わせ配置, iteration 11): pos.x はノードの「内側エッジ x」。
        // right 側 (pos.x >= 0, 中心より右): 左端=内側エッジを pos.x に固定し右へ伸ばす → fo.x = pos.x。
        // left 側 (pos.x < 0, 中心より左): 右端=内側エッジを pos.x に固定し左へ伸ばす → fo.x = pos.x - width。
        // これで幅が変わっても内側エッジ (子の親側の端) が揃い、A7 の編集中伸長と commit 後が一致する。
        var foX = (pos.x < 0) ? (pos.x - m.width) : pos.x;
        var fo = el('foreignObject', {
            x: foX,
            y: pos.y - m.height / 2,
            width: m.width,
            height: m.height,
            'class': 'mindmap-node',
            'data-node-id': nodeId
        });
        var box = document.createElementNS(XHTMLNS, 'div');
        box.setAttribute('class', 'mindmap-node-box');
        var mm = node.mindmap || {};
        var fill = mm.fill || inheritedFill(model, node.parentId) || '';
        var styleParts = ['border-radius:' + shapeToRadius(mm.shape)];
        if (fill) { styleParts.push('background:' + fill); }
        if (mm.stroke) { styleParts.push('border-color:' + mm.stroke); }
        if (mm.shape === 'none') { styleParts.push('border:none'); }
        box.setAttribute('style', styleParts.join(';'));
        if (ctx.selectedNodeIds && ctx.selectedNodeIds.has && ctx.selectedNodeIds.has(nodeId)) {
            box.classList.add('is-selected');
        }
        if (ctx.focusedNodeId === nodeId) { box.classList.add('is-focused'); }

        // アイコン (Page / File)
        if (node.isPage) {
            var pi = document.createElementNS(XHTMLNS, 'span');
            pi.setAttribute('class', 'mindmap-node-icon');
            pi.textContent = '📄'; // 📄
            box.appendChild(pi);
        } else if (node.filePath) {
            var fi = document.createElementNS(XHTMLNS, 'span');
            fi.setAttribute('class', 'mindmap-node-icon');
            fi.textContent = '📎'; // 📎
            box.appendChild(fi);
        }

        // テキスト (既存 OutlinerCell.renderInlineText 流用)
        var textDiv = document.createElementNS(XHTMLNS, 'div');
        textDiv.setAttribute('class', 'mindmap-node-text');
        textDiv.setAttribute('data-node-id', nodeId);
        // 非編集時もフォーカス可能にする (キーボード操作の受け口)。
        // contenteditable=false の div は tabindex なしだと focus できないため。
        textDiv.setAttribute('tabindex', '0');
        if (typeof OutlinerCell !== 'undefined' && OutlinerCell.renderInlineText) {
            textDiv.innerHTML = OutlinerCell.renderInlineText(node.text || '');
        } else {
            textDiv.textContent = node.text || '';
        }
        box.appendChild(textDiv);

        // 画像サムネ
        if (node.images && node.images.length) {
            var imgWrap = document.createElementNS(XHTMLNS, 'div');
            imgWrap.setAttribute('class', 'mindmap-node-images');
            for (var ii = 0; ii < node.images.length; ii++) {
                var img = document.createElementNS(XHTMLNS, 'img');
                var src = (typeof OutlinerCell !== 'undefined' && OutlinerCell.resolveImageSrc)
                    ? OutlinerCell.resolveImageSrc(node.images[ii], ctx.imageBaseUri)
                    : node.images[ii];
                img.setAttribute('src', src);
                img.setAttribute('data-img-index', ii);
                imgWrap.appendChild(img);
            }
            box.appendChild(imgWrap);
        }

        // タグ
        if (node.tags && node.tags.length) {
            var tagWrap = document.createElementNS(XHTMLNS, 'span');
            tagWrap.setAttribute('class', 'mindmap-node-tags');
            tagWrap.textContent = node.tags.join(' ');
            box.appendChild(tagWrap);
        }

        // チェックボックス (Task Mode)
        if (node.checked !== null && node.checked !== undefined) {
            var cb = document.createElementNS(XHTMLNS, 'input');
            cb.setAttribute('type', 'checkbox');
            cb.setAttribute('class', 'mindmap-node-checkbox');
            if (node.checked) { cb.setAttribute('checked', 'checked'); }
            box.insertBefore(cb, box.firstChild);
        }

        // 折りたたみハンドル (子ありのとき)
        var hasChildren = node.children && node.children.filter(function(c) { return !!model.nodes[c]; }).length > 0;
        if (hasChildren) {
            var handle = document.createElementNS(XHTMLNS, 'button');
            handle.setAttribute('class', 'mindmap-collapse-handle');
            handle.setAttribute('data-node-id', nodeId);
            handle.textContent = node.collapsed ? '+' : '−'; // − (minus)
            box.appendChild(handle);
        }

        fo.appendChild(box);
        return fo;
    }

    // --- Boundary (グループ枠) ---
    // FR-021-G3 (sync 2026-07-01): nodeIds の各ノード + その子孫すべてを囲む。
    function buildGroupEls(model, settings, positions, measure, selectedGroupId) {
        var g = el('g', { 'class': 'mindmap-layer-groups' });
        var groups = (settings && settings.groups) || [];
        for (var i = 0; i < groups.length; i++) {
            var grp = groups[i];
            // メンバー = nodeIds ∪ 各 nodeId の子孫 (getDescendantIds)。折畳で positions に無い子孫はスキップ。
            var memberIds = {};
            for (var k = 0; k < grp.nodeIds.length; k++) {
                var topId = grp.nodeIds[k];
                memberIds[topId] = true;
                if (model.getDescendantIds) {
                    var desc = model.getDescendantIds(topId) || [];
                    for (var d = 0; d < desc.length; d++) { memberIds[desc[d]] = true; }
                }
            }
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            var count = 0;
            for (var mid in memberIds) {
                if (!memberIds.hasOwnProperty(mid)) { continue; }
                var p = positions[mid];
                if (!p) { continue; } // 存在しない/折畳で非表示の nodeId はスキップ
                count++;
                var m = measure(mid);
                // FR-021-A8: buildNodeEl と同じ内側エッジ基準でノード外接を取る
                // (right: [x, x+w] / left: [x-w, x] / title: [x±w/2])。group 枠が実描画に一致するように。
                var gLoX, gHiX;
                if (mid === '__title__') { gLoX = p.x - m.width / 2; gHiX = p.x + m.width / 2; }
                else if (p.x < 0) { gLoX = p.x - m.width; gHiX = p.x; }
                else { gLoX = p.x; gHiX = p.x + m.width; }
                minX = Math.min(minX, gLoX);
                minY = Math.min(minY, p.y - m.height / 2);
                maxX = Math.max(maxX, gHiX);
                maxY = Math.max(maxY, p.y + m.height / 2);
            }
            if (count === 0) { continue; } // member 0 は描画しない
            var pad = 14;
            var groupCls = 'mindmap-group' + (grp.id === selectedGroupId ? ' is-selected' : '');
            var gEl = el('g', { 'class': groupCls, 'data-group-id': grp.id });
            var rect = el('rect', {
                x: minX - pad, y: minY - pad,
                width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2,
                rx: 10, 'class': 'mindmap-group-rect'
            });
            if (grp.color) {
                rect.setAttribute('style', 'stroke:' + grp.color + ';fill:' + grp.color + '22');
            }
            gEl.appendChild(rect);
            if (grp.label) {
                var lbl = el('text', { x: minX - pad + 6, y: minY - pad - 4, 'class': 'mindmap-group-label' });
                lbl.textContent = grp.label;
                gEl.appendChild(lbl);
            }
            g.appendChild(gEl);
        }
        return g;
    }

    // --- Relationship (関連線) ---
    function buildRelationshipEls(settings, positions) {
        var g = el('g', { 'class': 'mindmap-layer-relationships' });
        var rels = (settings && settings.relationships) || [];
        for (var i = 0; i < rels.length; i++) {
            var r = rels[i];
            var from = positions[r.fromNodeId], to = positions[r.toNodeId];
            if (!from || !to) { continue; } // 端点欠損はスキップ
            var relG = el('g', { 'class': 'mindmap-relationship', 'data-rel-id': r.id });
            var mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2 - 30;
            var path = el('path', {
                d: 'M' + from.x + ',' + from.y + ' Q' + mx + ',' + my + ' ' + to.x + ',' + to.y,
                'class': 'mindmap-rel-path',
                'marker-end': 'url(#mm-arrow)'
            });
            if (r.color) { path.setAttribute('style', 'stroke:' + r.color); }
            relG.appendChild(path);
            if (r.label) {
                var t = el('text', { x: mx, y: my, 'class': 'mindmap-rel-label' });
                t.textContent = r.label;
                relG.appendChild(t);
            }
            g.appendChild(relG);
        }
        return g;
    }

    function arrowMarkerDefs() {
        var defs = el('defs');
        var marker = el('marker', {
            id: 'mm-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
            markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse'
        });
        var p = el('path', { d: 'M0,0 L10,5 L0,10 z', 'class': 'mindmap-arrow-head' });
        marker.appendChild(p);
        defs.appendChild(marker);
        return defs;
    }

    /**
     * メイン描画。treeEl 内に SVG を全再描画する。
     * @param {Object} model
     * @param {Object} settings - MindmapSettings
     * @param {HTMLElement} treeEl - .outliner-tree
     * @param {Object} host - outlinerHostBridge
     * @param {Object} ctx - { i18n, imageBaseUri, scheduleSync, focusedNodeId, selectedNodeIds, fontSize }
     */
    function render(model, settings, treeEl, host, ctx) {
        ctx = ctx || {};
        settings = settings || {};
        _lastCtx = { model: model, settings: settings, treeEl: treeEl, host: host, ctx: ctx };
        treeEl.innerHTML = '';
        treeEl.dataset.viewMode = 'mindmap';

        // title 中心ノード (FR-021-B6): ctx.titleText か model.title を使う
        var titleText = (ctx.titleText != null) ? ctx.titleText : (model.title || '');
        var realDims = ctx._realDims || null;
        var measure = function(nodeId) {
            // 2 パス目: 実 DOM 計測値があればそれを使う (FR-021-A6)
            if (realDims && realDims[nodeId]) { return realDims[nodeId]; }
            if (nodeId === '__title__') {
                return estimateMeasure({ text: titleText }, ctx.fontSize);
            }
            return estimateMeasure(model.nodes[nodeId], ctx.fontSize);
        };

        // レイアウト計算
        var layout = (typeof MindmapLayout !== 'undefined')
            ? MindmapLayout.compute(model, settings, measure, titleText)
            : { positions: {}, links: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
        var positions = layout.positions;

        // 空状態
        var hasNodes = Object.keys(positions).length > 0;
        if (!hasNodes) {
            var empty = document.createElement('div');
            empty.className = 'mindmap-empty';
            var hint = document.createElement('div');
            hint.className = 'mindmap-empty-hint';
            hint.textContent = (ctx.i18n && ctx.i18n.outlinerNoItems) || 'No items yet';
            var addBtn = document.createElement('button');
            addBtn.className = 'mindmap-empty-add';
            addBtn.textContent = '+ Add';
            // FR-021-A4: クリック/Enter で最初の root を作成する affordance を配線
            // (空状態分岐は attach を通らないため、ここで直接ハンドラを付ける)
            var addRoot = function() {
                if (typeof ctx.addRootAndEdit === 'function') {
                    ctx.addRootAndEdit();
                }
            };
            addBtn.addEventListener('click', addRoot);
            addBtn.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addRoot(); }
            });
            empty.appendChild(hint);
            empty.appendChild(addBtn);
            treeEl.appendChild(empty);
            return { layout: layout };
        }

        // viewport コンテナ + SVG
        var vp = document.createElement('div');
        vp.className = 'mindmap-viewport';
        vp.style.transform = 'translate(' + viewport.translateX + 'px,' + viewport.translateY + 'px) scale(' + viewport.scale + ')';

        var b = layout.bounds;
        var pad = 120;
        var vbX = b.minX - pad, vbY = b.minY - pad;
        var vbW = (b.maxX - b.minX) + pad * 2, vbH = (b.maxY - b.minY) + pad * 2;
        var svg = el('svg', {
            'class': 'mindmap-svg',
            width: Math.max(vbW, 100),
            height: Math.max(vbH, 100),
            viewBox: vbX + ' ' + vbY + ' ' + Math.max(vbW, 100) + ' ' + Math.max(vbH, 100)
        });
        svg.appendChild(arrowMarkerDefs());

        // レイヤ: groups(背面) < links < relationships < nodes(前面)
        svg.appendChild(buildGroupEls(model, settings, positions, measure, ctx.selectedGroupId));

        var linksLayer = el('g', { 'class': 'mindmap-layer-links' });
        var linkStyle = settings.linkStyle || 'curved';
        for (var li = 0; li < layout.links.length; li++) {
            var lk = layout.links[li];
            var path = el('path', {
                d: linkPath(lk, linkStyle),
                'class': 'mindmap-link',
                fill: 'none',
                // #A: 編集中の下方ずらしで link 端点を追従させるため source/target を記録
                'data-source-id': lk.sourceId,
                'data-target-id': lk.targetId
            });
            var lstyle = [];
            if (settings.linkColor) { lstyle.push('stroke:' + settings.linkColor); }
            if (settings.linkWidth) { lstyle.push('stroke-width:' + settings.linkWidth + 'px'); }
            if (lstyle.length) { path.setAttribute('style', lstyle.join(';')); }
            linksLayer.appendChild(path);
        }
        svg.appendChild(linksLayer);

        svg.appendChild(buildRelationshipEls(settings, positions));

        var nodesLayer = el('g', { 'class': 'mindmap-layer-nodes' });
        for (var id in positions) {
            if (!positions.hasOwnProperty(id)) { continue; }
            // __title__ は仮想中心ノード (model.nodes に無い)。それ以外は実 node 必須。
            if (id !== '__title__' && !model.nodes[id]) { continue; }
            nodesLayer.appendChild(buildNodeEl(model, id, positions[id], measure, ctx));
        }
        svg.appendChild(nodesLayer);

        vp.appendChild(svg);
        treeEl.appendChild(vp);

        // 2 パス描画 (FR-021-A6): 改行/アイコン/画像/タグ を持つノードがあれば、
        // 実 DOM 寸法で measure を作り直して 1 回だけ再レイアウト → 枠と間隔を実寸に一致させる。
        // (無限ループ防止のため opts._secondPass 済みなら再測定しない)
        if (!ctx._secondPass && needsRealMeasure(model, positions)) {
            var realDims = {};
            var boxes = nodesLayer.querySelectorAll('.mindmap-node-box');
            // --- 2 段測定で layout thrash を軽減 ---
            // ① 全 box の realW (measureRealWidth) を先に一括算出。
            // ② 各 box を realW 幅にリフローさせ、その幅での実高さを測る (iteration 15, TASK-47)。
            //    高さを pass-1 の狭い幅で測ると全角 1 行ノードが 2 行に折り返した高さが frozen される
            //    (#17 の高さ版) ため、幅と同じ realW 基準で測って整合させる。
            var measured = []; // { nid, box, fo, realW, fallbackH }
            for (var bi = 0; bi < boxes.length; bi++) {
                var host2 = boxes[bi].parentNode; // foreignObject
                var nid = host2 && host2.getAttribute('data-node-id');
                if (!nid) { continue; }
                var r = boxes[bi].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    // iteration 14 (TASK-44): 幅は「最長行フィット・上限 280」だが、
                    // 測り方を char 推定 → 実 DOM の最長行実測にする (char 推定は全角過小 = Image #17)。
                    var realW = measureRealWidth(boxes[bi], model.nodes[nid], ctx.fontSize);
                    // fallback は従来どおり pass-1 幅での高さ (realW リフローが測れない場合の保険)。
                    measured.push({ nid: nid, box: boxes[bi], fo: host2, realW: realW, fallbackH: r.height / viewport.scale });
                }
            }
            // ② realW 幅での高さを測る。fo.width を realW にセット → box リフロー → 実高さ。
            //    幅・高さとも realW 基準になり、単一行ノードは realW 幅で 1 行高さになる (TASK-47)。
            for (var mi = 0; mi < measured.length; mi++) {
                var m2 = measured[mi];
                var realH = measureBoxHeightAtWidth(m2.box, m2.fo, m2.realW, m2.fallbackH);
                realDims[m2.nid] = { width: m2.realW, height: realH };
            }
            if (Object.keys(realDims).length) {
                var ctx2 = {};
                for (var kk in ctx) { if (ctx.hasOwnProperty(kk)) { ctx2[kk] = ctx[kk]; } }
                ctx2._secondPass = true;
                ctx2._realDims = realDims;
                return render(model, settings, treeEl, host, ctx2);
            }
        }

        // ツールバー (レイアウト切替 / エクスポート / ズーム / フィット)
        treeEl.appendChild(buildToolbar(settings));

        // ミニマップ (簡易: bounds を縮小した点群)
        treeEl.appendChild(buildMinimap(positions, layout.bounds));

        // interactions を配線 (存在すれば)
        if (typeof MindmapInteractions !== 'undefined' && MindmapInteractions.attach) {
            MindmapInteractions.attach(treeEl, model, settings, host, ctx, {
                layout: layout, viewport: viewport, rerender: function() {
                    // 2 パス由来の凍結値を持ち越さない（毎回 fresh に再計測させる, TASK-35）
                    // これがないと 2 パス目の render 内で capture された ctx が
                    // _secondPass=true + 編集前の _realDims を持ち、commit 時の rerender で
                    // 2 パス再計測がスキップされ、伸びたノードで下方ノードが重なる。
                    var freshCtx = {};
                    for (var k in ctx) { if (ctx.hasOwnProperty(k) && k !== '_secondPass' && k !== '_realDims') { freshCtx[k] = ctx[k]; } }
                    render(model, settings, treeEl, host, freshCtx);
                }
            });
        }

        return { layout: layout, svg: svg };
    }

    /** 2 パス目が要るか: 改行/アイコン/画像/タグ を持つノードが 1 つでもあれば true */
    function needsRealMeasure(model, positions) {
        for (var id in positions) {
            if (!positions.hasOwnProperty(id)) { continue; }
            if (id === '__title__') { continue; }
            var n = model.nodes[id];
            if (!n) { continue; }
            if ((n.text && n.text.indexOf('\n') >= 0) ||
                n.isPage || n.filePath ||
                (n.images && n.images.length) ||
                (n.tags && n.tags.length)) {
                return true;
            }
        }
        return false;
    }

    function buildToolbar(settings) {
        var bar = document.createElement('div');
        bar.className = 'mindmap-toolbar';
        function btn(action, label, title, value) {
            var b = document.createElement('button');
            b.className = 'mindmap-tb-btn';
            b.setAttribute('data-mm-action', action);
            if (value) { b.setAttribute('data-mm-value', value); }
            b.title = title || label;
            b.textContent = label;
            return b;
        }
        // レイアウト select
        var sel = document.createElement('select');
        sel.className = 'mindmap-tb-layout';
        sel.setAttribute('data-mm-action', 'layout');
        ['radial', 'right', 'left', 'balanced'].forEach(function(v) {
            var o = document.createElement('option');
            o.value = v; o.textContent = v;
            if ((settings.layout || 'right') === v) { o.selected = true; }
            sel.appendChild(o);
        });
        bar.appendChild(sel);
        bar.appendChild(btn('zoom-in', '＋', 'Zoom in'));
        bar.appendChild(btn('zoom-out', '－', 'Zoom out'));
        bar.appendChild(btn('fit', 'Fit', 'Fit to screen'));
        bar.appendChild(btn('export', '⬇ PNG', 'Export PNG', 'png'));
        bar.appendChild(btn('export', 'SVG', 'Export SVG', 'svg'));
        bar.appendChild(btn('export', 'OPML', 'Export OPML', 'opml'));
        bar.appendChild(btn('export', 'MD', 'Export Markdown', 'markdown'));
        return bar;
    }

    function buildMinimap(positions, bounds) {
        var mini = document.createElement('div');
        mini.className = 'mindmap-minimap';
        var w = 160, h = 120;
        var bw = Math.max(bounds.maxX - bounds.minX, 1), bh = Math.max(bounds.maxY - bounds.minY, 1);
        var scale = Math.min(w / bw, h / bh) * 0.8;
        var svg = el('svg', { width: w, height: h, 'class': 'mindmap-minimap-svg' });
        for (var id in positions) {
            if (!positions.hasOwnProperty(id)) { continue; }
            var p = positions[id];
            var dot = el('circle', {
                cx: (p.x - bounds.minX) * scale + 8,
                cy: (p.y - bounds.minY) * scale + 8,
                r: 2, 'class': 'mindmap-minimap-dot'
            });
            svg.appendChild(dot);
        }
        mini.appendChild(svg);
        return mini;
    }

    function updateViewport(vp) {
        viewport = vp || viewport;
        if (_lastCtx && _lastCtx.treeEl) {
            var vpEl = _lastCtx.treeEl.querySelector('.mindmap-viewport');
            if (vpEl) {
                vpEl.style.transform = 'translate(' + viewport.translateX + 'px,' + viewport.translateY + 'px) scale(' + viewport.scale + ')';
            }
        }
    }

    function getViewport() { return viewport; }
    function setViewport(vp) { viewport = vp; }

    function destroy() {
        for (var i = 0; i < _bodyEls.length; i++) {
            if (_bodyEls[i] && _bodyEls[i].parentNode) {
                _bodyEls[i].parentNode.removeChild(_bodyEls[i]);
            }
        }
        _bodyEls = [];
        if (typeof MindmapInteractions !== 'undefined' && MindmapInteractions.detach) {
            MindmapInteractions.detach();
        }
        _lastCtx = null;
    }

    return {
        render: render,
        updateViewport: updateViewport,
        getViewport: getViewport,
        setViewport: setViewport,
        destroy: destroy,
        // テスト/エクスポート用に公開
        _linkPath: linkPath,
        _estimateMeasure: estimateMeasure,
        _measureRealWidth: measureRealWidth,
        _measureBoxHeightAtWidth: measureBoxHeightAtWidth,
        _shapeToRadius: shapeToRadius,
        _trackBodyEl: function(e) { _bodyEls.push(e); }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MindmapRender;
}
