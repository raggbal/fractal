/**
 * MindmapLayout — d3-hierarchy / d3-flextree でレイアウト座標を計算する純関数。
 *
 * 同じ model + settings + measure → 同じ座標 (決定論的)。
 * 描画は行わない (mindmap-render.js が担当)。
 *
 * 型・フィールドの正典: design/system/data-model.md, layout-engine.md
 */

// eslint-disable-next-line no-unused-vars
var MindmapLayout = (function() {
    'use strict';

    // d3 の解決: webview では window.d3、Node (テスト) では require。
    function resolveD3() {
        if (typeof window !== 'undefined' && window.d3 && window.d3.hierarchy) {
            return window.d3;
        }
        if (typeof globalThis !== 'undefined' && globalThis.d3 && globalThis.d3.hierarchy) {
            return globalThis.d3;
        }
        if (typeof require !== 'undefined') {
            try {
                var h = require('../../vendor/d3-hierarchy.min.js');
                var f = require('../../vendor/d3-flextree.min.js');
                return { hierarchy: h.hierarchy, tree: h.tree, cluster: h.cluster, flextree: f.flextree };
            } catch (e) { /* テスト側が inject する */ }
        }
        return null;
    }

    /**
     * 折りたたみを考慮した children accessor を作る。
     * collapsed ノードの子は辿らない (描画されないため)。
     * hidden(id)=true の子も辿らない (FR-MT-04: task filter 等の除外述語。ADRL-0002)。
     */
    function makeChildrenAccessor(model, hidden) {
        return function(id) {
            var n = model.nodes[id];
            if (!n || n.collapsed) { return null; }
            var kids = n.children || [];
            // 存在する子のみ (壊れた参照を除外) + hidden 除外 (subtree ごと消える)
            return kids.filter(function(cid) { return !!model.nodes[cid] && !hidden(cid); });
        };
    }

    /** hideNode 引数を正規化する (省略時は「隠さない」= 後方互換)。 */
    function normalizeHidden(hideNode) {
        return (typeof hideNode === 'function') ? hideNode : function() { return false; };
    }

    /**
     * 1 つの root サブツリーを flextree で計算する。
     * 戻り値: d3.hierarchy の root ノード (各 node に x/y が入る)。
     * axis: x = 兄弟方向, y = 深さ方向 (flextree の nodeSize=[height,width])。
     */
    function computeSubtree(d3, model, rootId, settings, measure, hidden) {
        var childrenOf = makeChildrenAccessor(model, hidden);
        var root = d3.hierarchy(rootId, childrenOf);

        var useFlex = typeof d3.flextree === 'function';
        if (useFlex) {
            var ft = d3.flextree();
            ft.nodeSize(function(node) {
                var m = measure(node.data);
                // [兄弟方向サイズ, 深さ方向サイズ]
                return [m.height + settings.siblingSpacing, m.width + settings.levelSpacing];
            });
            ft(root);
        } else {
            // フォールバック: 固定 nodeSize の d3.tree
            var maxW = 0, maxH = 0;
            root.each(function(node) {
                var m = measure(node.data);
                if (m.width > maxW) { maxW = m.width; }
                if (m.height > maxH) { maxH = m.height; }
            });
            var t = d3.tree().nodeSize([maxH + settings.siblingSpacing, maxW + settings.levelSpacing]);
            t(root);
        }
        return root;
    }

    /**
     * root サブツリーの計算結果を positions/links に変換 (方向適用)。
     * dir: +1 = 右 (深さ→+X), -1 = 左 (深さ→-X)
     * originX/originY: この root を配置するオフセット
     */
    function emitLinear(root, positions, links, dir, originX, originY, measure) {
        root.each(function(node) {
            // flextree: node.x = 兄弟軸, node.y = 深さ軸
            var px = originX + dir * node.y;   // 深さ → X (FR-021-A8: この x は「ノードの内側エッジ x」)
            var py = originY + node.x;          // 兄弟 → Y
            positions[node.data] = { x: px, y: py };
        });
        root.each(function(node) {
            if (node.parent) {
                links.push(makeLink(node.parent.data, node.data, positions, dir, measure));
            }
        });
    }

    /**
     * FR-021-A8: 親子リンクの端点を「ノードのエッジ」に合わせて生成する。
     * - 子側 tx = 子の内側エッジ = positions[child].x (内側エッジ再定義後はそのまま)。
     * - 親側 sx = 親の子がある側の外側エッジ。
     *     right 側 (dir>0): 親右端 = positions[parent].x + measure(parent).width。
     *     left 側  (dir<0): 親左端 = positions[parent].x - measure(parent).width。
     *   (親の内側エッジ = positions[parent].x なので、外側エッジは ±幅ぶん離す)
     * sy/ty はノードの縦中心 (positions.y)。measure が無ければ従来どおり中心 x を使う(保険)。
     */
    function makeLink(parentId, childId, positions, dir, measure) {
        var pp = positions[parentId], cp = positions[childId];
        var sx = pp.x;
        if (typeof measure === 'function') {
            var pw = (measure(parentId) || {}).width || 0;
            sx = pp.x + dir * pw;
        }
        return {
            sourceId: parentId,
            targetId: childId,
            sx: sx,
            sy: pp.y,
            tx: cp.x,
            ty: cp.y,
            side: dir > 0 ? 'right' : 'left'
        };
    }

    /**
     * メインエントリ。
     * @param {Object} model - OutlinerModel (rootIds, nodes)
     * @param {Object} settings - MindmapSettings (data-model.md §2)
     * @param {Function} measure - (nodeId) => {width, height}
     * @returns {Object} { positions: {id:{x,y,angle?}}, links: [...], bounds: {minX,minY,maxX,maxY} }
     */
    // 予約 ID: title 中心ノード (実 node ID は 'n' 始まりなので衝突しない)
    var TITLE_ID = '__title__';

    function compute(model, settings, measure, titleText, hideNode) {
        var d3 = resolveD3();
        var positions = {};
        var links = [];

        measure = measure || function() { return { width: 120, height: 32 }; };
        settings = settings || {};
        if (typeof settings.siblingSpacing !== 'number') { settings.siblingSpacing = 16; }
        if (typeof settings.levelSpacing !== 'number') { settings.levelSpacing = 80; }
        var layout = settings.layout || 'right';
        // FR-MT-04 (ADRL-0002): 除外述語。true のノードは subtree ごと positions に入らない
        // (collapsed と同強度・AND 併存)。layout は述語の意味論 (task filter 等) を知らない。
        var hidden = normalizeHidden(hideNode);

        var rootIds = (model.rootIds || []).filter(function(id) { return !!model.nodes[id] && !hidden(id); });

        // title 中心ノード (FR-021-B6): title が非空なら __title__ を中心に、rootIds をその子として
        // 左右両側に展開する。model を汚さない一時ラッパで children accessor を拡張。
        // layout → sideMode: right=全子右 / left=全子左 / balanced,radial=両側 (#3 TASK-28)
        var sideMode = (layout === 'right') ? 'right' : (layout === 'left') ? 'left' : 'both';

        var hasTitle = titleText != null && String(titleText).trim() !== '';
        if (d3 && hasTitle && rootIds.length) {
            // title 中心ノードでも settings.layout を尊重 (#3)。両側固定を廃止。
            var wrapModel = makeTitleWrapModel(model, rootIds, titleText);
            // ★接続線の隙間バグ修正 (sprint 20260721-134546): title の measure は render 側が使う
            // measure(TITLE_ID) をそのまま使う。従来は独自ヒューリスティック measureTitle
            // (width=max(100,...)) を使っていたため、実描画の title box 幅（measure(TITLE_ID)）と
            // 食い違い、link 始点 (sx = cx ± 幅/2) が box エッジからズレて中央 title だけ線が離れた。
            // render 側 buildTitleNodeEl も measure(TITLE_ID) で box を描くので、両者を揃えれば一致する。
            emitBalanced(d3, wrapModel, TITLE_ID, settings, measure,
                positions, links, 0, 0, sideMode, hidden);
            // Floating Topic を追加してリターン
            addFloatingTopics(model, rootIds, positions, hidden);
            return { positions: positions, links: links, bounds: computeBounds(positions, measure) };
        }

        if (d3 && rootIds.length) {
            var stackY = 0;
            for (var i = 0; i < rootIds.length; i++) {
                var rid = rootIds[i];
                if (layout === 'radial' || layout === 'balanced') {
                    // radial/balanced は「左右両側」。ブロック分割で安定化 (#2)。
                    // 視覚差 (radial=曲線/中心強調, balanced=直線寄り) は描画層 (linkStyle) で表現。
                    emitBalanced(d3, model, rid, settings, measure, positions, links, 0, stackY, 'both', hidden);
                    stackY += subtreeHeight(model, rid, measure, settings, hidden) + 60;
                } else {
                    var dir = (layout === 'left') ? -1 : 1;
                    var rootL = computeSubtree(d3, model, rid, settings, measure, hidden);
                    // 各 root サブツリーの縦オフセット (重ならないよう積む)
                    var minX = Infinity;
                    rootL.each(function(n) { if (n.x < minX) { minX = n.x; } });
                    emitLinear(rootL, positions, links, dir, 0, stackY - (isFinite(minX) ? minX : 0), measure);
                    stackY += subtreeSpan(rootL) + 60;
                }
            }
        }

        addFloatingTopics(model, rootIds, positions, hidden);

        return { positions: positions, links: links, bounds: computeBounds(positions, measure) };
    }

    /** Floating Topic: mindmap.x/y をそのまま positions に入れる (レイアウト対象外)。hidden は除外 */
    function addFloatingTopics(model, rootIds, positions, hidden) {
        for (var id in model.nodes) {
            if (!model.nodes.hasOwnProperty(id)) { continue; }
            if (hidden(id)) { continue; }
            var n = model.nodes[id];
            if (n.parentId == null && rootIds.indexOf(id) < 0 &&
                n.mindmap && n.mindmap.x != null && n.mindmap.y != null) {
                positions[id] = { x: n.mindmap.x, y: n.mindmap.y };
            }
        }
    }

    /**
     * __title__ を root、rootIds をその子とする「読み取り専用ラッパ model」を作る。
     * children accessor / getNode / nodes を emitBalanced が使う形で提供し、元 model は汚さない。
     */
    function makeTitleWrapModel(model, rootIds, titleText) {
        var titleNode = { id: TITLE_ID, parentId: null, children: rootIds.slice(), collapsed: false, text: String(titleText || '') };
        return {
            rootIds: [TITLE_ID],
            nodes: (function() {
                // Proxy 相当: TITLE_ID だけ差し込み、他は元 model.nodes を参照
                var wrap = Object.create(model.nodes);
                wrap[TITLE_ID] = titleNode;
                return wrap;
            })(),
            getNode: function(id) { return id === TITLE_ID ? titleNode : model.getNode(id); },
            getDescendantIds: model.getDescendantIds ? model.getDescendantIds.bind(model) : null
        };
    }

    /**
     * 中心ノードの子を左右に配置する。
     * @param sideMode 'both'（両側, balanced/radial）| 'right'（全子右）| 'left'（全子左）
     *
     * #2 安定化 (TASK-29): 両側時は index 偶奇でなく**連続ブロック分割**
     * (前半 ceil(n/2) を右・後半を左)。子を末尾に追加しても既存子の side がほぼ保たれる
     * (parity 方式だと 1 個追加で全子の side が入れ替わり左右に飛ぶ)。
     */
    function emitBalanced(d3, model, rootId, settings, measure, positions, links, centerX, centerY, sideMode, hidden) {
        sideMode = sideMode || 'both';
        hidden = normalizeHidden(hidden);
        // FR-MT-04: hidden root は positions に一切入れない (代入 :positions[rootId] より前に弾く)。
        // __title__ は実 node でないため述語対象外 (isHiddenByTaskFilter は未知 id に false を返す)。
        if (rootId !== TITLE_ID && hidden(rootId)) { return; }
        var rootNode = model.nodes[rootId];
        positions[rootId] = { x: centerX, y: centerY };
        if (!rootNode || rootNode.collapsed) { return; }
        var kids = (rootNode.children || []).filter(function(c) { return !!model.nodes[c] && !hidden(c); });
        var rightKids = [], leftKids = [];
        if (sideMode === 'right') {
            rightKids = kids.slice();
        } else if (sideMode === 'left') {
            leftKids = kids.slice();
        } else {
            // both: 連続ブロック分割 (前半右・後半左)
            var rightCount = Math.ceil(kids.length / 2);
            rightKids = kids.slice(0, rightCount);
            leftKids = kids.slice(rightCount);
        }
        // 中心ノードの半幅を子の起点オフセットに加味する (#1 title 中心ノードが子と重ならないように)
        var centerHalfW = (measure(rootId).width || 0) / 2;
        if (rightKids.length) {
            emitBalancedSide(d3, model, rootId, rightKids, settings, measure, positions, links, +1, centerX, centerY, centerHalfW, hidden);
        }
        if (leftKids.length) {
            emitBalancedSide(d3, model, rootId, leftKids, settings, measure, positions, links, -1, centerX, centerY, centerHalfW, hidden);
        }
    }

    function emitBalancedSide(d3, model, rootId, kids, settings, measure, positions, links, dir, cx, cy, centerHalfW, hidden) {
        centerHalfW = centerHalfW || 0;
        // 各子サブツリーを個別に配置し、実 measure 高さベースで縦に積む (#3 sync 2026-07-02)。
        // 固定 30/40px ではなく、各サブツリーの実 Y 範囲 + siblingSpacing で間隔を保つ。
        var sibSpacing = settings.siblingSpacing || 16;

        // まず各サブツリーの高さ(実 Y 範囲)を測り、合計 + 間隔から開始 Y を中央寄せで算出
        var subs = [];
        var totalH = 0;
        for (var i = 0; i < kids.length; i++) {
            var sub = computeSubtree(d3, model, kids[i], settings, measure, hidden);
            var ext = subtreeYExtent(sub, measure); // {min,max,height} (screen-Y = flextree x 軸)
            subs.push({ root: sub, kid: kids[i], ext: ext });
            totalH += ext.height;
        }
        totalH += sibSpacing * Math.max(0, kids.length - 1);

        var cursor = cy - totalH / 2; // 上端から中央寄せで積む
        for (var j = 0; j < subs.length; j++) {
            var s = subs[j];
            // FR-021-A8 (内側エッジ合わせ): 子 root の起点 X = 子の「内側エッジ」。
            // 中心/親ノードの外側エッジ (centerHalfW) から levelSpacing だけ離した位置に固定する。
            // 子自身の半幅 (childHalfW) は originX に含めない — 含めると幅が変わるたびに内側エッジが
            // 動いてしまい、A8 の「内側エッジ揃え」が崩れる (幅拡張ノードが中央寄りに戻る #1/#2)。
            var originX = dir * (centerHalfW + settings.levelSpacing);
            // このサブツリーの上端(cursor)に min を合わせるオフセット。
            // emitLinear は originY に node.x(兄弟軸) を足して screen-Y にする → originY = cursor - ext.min
            emitLinear(s.root, positions, links, dir, originX, cursor - s.ext.min, measure);
            // FR-021-A8: 中心/root ノード → 子 root のリンク端点をエッジに合わせる。
            // 親側 sx: __title__ は中心合わせ (外側エッジ = cx ± 半幅)、実 root は内側エッジ合わせ
            // (positions.x = 内側エッジ、外側エッジ = cx + dir * 全幅)。
            var parentW = (measure(rootId) || {}).width || 0;
            var sx = (rootId === TITLE_ID)
                ? cx + dir * (parentW / 2)   // 中心合わせ: 外側エッジ = 中心 ± 半幅
                : cx + dir * parentW;        // 内側エッジ合わせ: 外側エッジ = 内側エッジ + dir*全幅
            links.push({
                sourceId: rootId, targetId: s.kid,
                sx: sx, sy: cy,
                tx: positions[s.kid].x, ty: positions[s.kid].y,
                side: dir > 0 ? 'right' : 'left'
            });
            cursor += s.ext.height + sibSpacing;
        }
    }

    /**
     * サブツリーの screen-Y 範囲を実 measure 高さ込みで算出。
     * emitLinear は screen-Y = node.x(兄弟軸)。各ノードの実高さの半分を上下に加味する。
     */
    function subtreeYExtent(root, measure) {
        var min = Infinity, max = -Infinity;
        root.each(function(n) {
            var h = measure(n.data).height;
            var top = n.x - h / 2, bot = n.x + h / 2;
            if (top < min) { min = top; }
            if (bot > max) { max = bot; }
        });
        if (!isFinite(min)) { return { min: 0, max: 0, height: 0 }; }
        return { min: min, max: max, height: max - min };
    }

    function subtreeSpan(root) {
        var minX = Infinity, maxX = -Infinity;
        root.each(function(n) { if (n.x < minX) { minX = n.x; } if (n.x > maxX) { maxX = n.x; } });
        if (!isFinite(minX)) { return 0; }
        return maxX - minX;
    }

    function subtreeHeight(model, rootId, measure, settings, hidden) {
        hidden = normalizeHidden(hidden);
        // 概算: leaf 数 × (nodeH + spacing)。hidden subtree は数えない (FR-MT-04)
        var count = 0;
        (function walk(id) {
            if (hidden(id)) { return; }
            var n = model.nodes[id];
            if (!n) { return; }
            var kids = n.collapsed ? [] : (n.children || []).filter(function(c) { return !hidden(c); });
            if (!kids.length) { count++; return; }
            kids.forEach(walk);
        })(rootId);
        return Math.max(count, 1) * (measure(rootId).height + settings.siblingSpacing);
    }

    function computeBounds(positions, measure) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        var any = false;
        for (var id in positions) {
            if (!positions.hasOwnProperty(id)) { continue; }
            any = true;
            var p = positions[id];
            var m = measure(id);
            // FR-021-A8 (内側エッジ合わせ): render の buildNodeEl と同じ x 基準でノード外接を取る。
            // right 側 (pos.x >= 0): [pos.x, pos.x + width] (左端=内側エッジ)。
            // left 側  (pos.x < 0) : [pos.x - width, pos.x] (右端=内側エッジ)。
            // title 中心ノード (__title__): 従来どおり中心合わせ [pos.x ± width/2]。
            var loX, hiX;
            if (id === TITLE_ID) {
                loX = p.x - m.width / 2; hiX = p.x + m.width / 2;
            } else if (p.x < 0) {
                loX = p.x - m.width; hiX = p.x;
            } else {
                loX = p.x; hiX = p.x + m.width;
            }
            if (loX < minX) { minX = loX; }
            if (hiX > maxX) { maxX = hiX; }
            if (p.y - m.height / 2 < minY) { minY = p.y - m.height / 2; }
            if (p.y + m.height / 2 > maxY) { maxY = p.y + m.height / 2; }
        }
        if (!any) { return { minX: 0, minY: 0, maxX: 0, maxY: 0 }; }
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    /**
     * 空間フォーカス移動: 現在ノードから direction 方向の隣接ノードを返す。
     * @param {Object} positions - compute の結果
     * @param {string} currentId
     * @param {string} direction - 'up'|'down'|'left'|'right'
     * @param {string} layout
     * @returns {string|null} 隣接ノードID
     */
    function findAdjacent(positions, currentId, direction, layout) {
        var cur = positions[currentId];
        if (!cur) { return null; }
        var best = null, bestScore = Infinity;
        for (var id in positions) {
            if (!positions.hasOwnProperty(id) || id === currentId) { continue; }
            var p = positions[id];
            var dx = p.x - cur.x, dy = p.y - cur.y;
            var okDir = false;
            if (direction === 'right') { okDir = dx > 1; }
            else if (direction === 'left') { okDir = dx < -1; }
            else if (direction === 'down') { okDir = dy > 1; }
            else if (direction === 'up') { okDir = dy < -1; }
            if (!okDir) { continue; }
            // 主方向の距離を優先し、副方向のズレをペナルティ
            var primary, secondary;
            if (direction === 'right' || direction === 'left') {
                primary = Math.abs(dx); secondary = Math.abs(dy);
            } else {
                primary = Math.abs(dy); secondary = Math.abs(dx);
            }
            var score = primary + secondary * 2;
            if (score < bestScore) { bestScore = score; best = id; }
        }
        return best;
    }

    return {
        compute: compute,
        findAdjacent: findAdjacent,
        _resolveD3: resolveD3   // テスト用
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MindmapLayout;
}
