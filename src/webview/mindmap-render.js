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
    // --- toolbar / minimap の可視枠固定 (FR-021-J1/J3, iteration 22 / TASK-58) ---
    // toolbar(top:12) / minimap(bottom:12) は treeEl の absolute 子。treeEl は
    // min-height:400px を持つため、可視領域 (scroll ancestor ∩ window) が 400px 未満の窓では
    // treeEl が可視領域より高くなり、minimap(bottom) が可視枠外にアンカーされてクリップされる
    // (= ミニマップが消える/ずれる, ユーザー #1)。逆に scroll ancestor が縦スクロールする場合は
    // treeEl 全体が上へ流れ toolbar(top) が画面上に消える。→ toolbar/minimap を「treeEl の box」
    // ではなく「実際に見えている可視クリップ矩形」に追従させる chrome overlay に入れて固定する。
    // treeEl の高さ (min-height:400) は TC-V6 等の scroll テストのため変えない (decoupling)。
    var _chromeReposition = null; // scroll/resize で chrome を再配置するハンドラ (detach で解除)
    var _chromeResizeObs = null;  // treeEl / scroll 祖先のサイズ変化を監視 (detach で解除)
    // --- viewport フレーム安定化 (FR-021-J2, iteration 16 / TASK-49) ---
    // SVG viewBox origin = layout.bounds.min を毎 render 再計算するため、編集/追加/移動で
    // bounds 原点が動くと viewport.translate 不変でも座標フレーム全体が画面上シフトする。
    // 前回 render の bounds 原点を保持し、今回との差 Δ を viewport.translate に +Δ·scale
    // 補正して「固定ノードの画面位置が rerender 前後で不変」にする。
    var _prevBoundsMin = null;      // 前回 (非 secondPass) render の bounds 原点 {x, y}。初回は null。
    var _skipStabilizeOnce = false; // updateViewport (ユーザー明示 pan/zoom/fit/minimap) 直後の
                                    // 次 render は安定化補正をスキップ (基準だけ更新)。
    var _stabilizeEnabled = true;   // テスト用: false にすると bounds シフト補償を無効化 (load-bearing 検証)。

    // #10 (iteration 23 / TASK-64, generator_failures 2026-07-04): ノード幅 = テキスト実幅 +
    // 水平 padding。実 CSS は .mindmap-node-box { padding: 6px 10px } = 水平 20px。従来の +24 は
    // 実 padding 20px より 4px 過大で右空白の一因だった。編集 (interactions.js adjustEditWidth) と
    // 確定 (measureRealWidth / estimateMeasure) で同じ定数を使い editW == commitW を保つ。
    // interactions.js の A7_PAD_H と同値であること (両ファイルで 20 に統一)。
    var PAD_H = 20;
    // iteration 30/32: .mindmap-node-box は box-sizing:border-box + border:1.5px (水平 3px)。
    // PAD_H(padding) しか勘定しないと content 領域が border 分狭く短文が折り返す (Image #3/#4)。
    // iteration 30 は border 3px + 1px = 4 にしたが、実質スラック 1px しかなく、実機 (Electron) の
    // フォントメトリクスが clone 実測より数 px 広いため「必ず 1 文字折り返す」が継続した (Image #6)。
    // → border 3px + 1 文字分 (~15px) の余裕 = 18 に拡大。全ノード (icon 有無問わず) に効かせる。
    // 上限 280 クランプがあるので副作用は sub-280 ノードが ~1 文字分広がるだけ (ユーザー要望「広げて」)。
    // interactions.js A7_BORDER_W と同値 (両ファイルで統一 → editW == commitW)。
    var BORDER_W = 18;
    // iteration 31: .mindmap-node-box は flex gap: 4px 6px。アイコン (📄/📎) と text が同じ行に
    // 並ぶとき列 gap 6px を消費する。iconPad を「アイコン実測幅 + ICON_GAP」で計算する
    // (推定 PAD_H では実機 Electron の emoji 幅で不足しアイコン付き短文が折り返した)。
    var ICON_GAP = 6;

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

    // 画像がある node は画像を横に並べられる最小幅を返す（text と同様に node を広げる。max 280）。
    // text 無し node で画像が縦積みになる問題の対策 — node 幅を text 依存から解放する。
    // .mindmap-node-images img は max-width:60px + コンテナ gap:4px（mindmap.css:171-183）。
    function imageMinWidth(node) {
        if (!node || !node.images || !node.images.length) { return 0; }
        var IMG_W = 60, IMG_GAP = 4;
        // 280(=maxW) 内に何枚横並びできるか。超過分は 280 で折り返す（= text の 280 クランプと同じ挙動）。
        var maxPerRow = Math.max(1, Math.floor((280 - PAD_H - BORDER_W + IMG_GAP) / (IMG_W + IMG_GAP))); // = 3
        var k = Math.min(node.images.length, maxPerRow);
        return k * IMG_W + (k - 1) * IMG_GAP + PAD_H + BORDER_W;
    }

    // --- ノード実寸の概算 (#M4: 1 パス目。実寸は 2 パス目 getBoundingClientRect で補正) ---
    function estimateMeasure(node, fontSize) {
        var fs = fontSize || 14;
        var text = (node && node.text) || '';
        // 明示改行 (\n) で行数を分けてから、各行の折り返しを加算 (FR-021-A6)
        var explicitLines = String(text).split('\n');
        var charW = fs * 0.6;
        // アイコン(📄/📎)があるノードは幅に余白を足す (アイコン分 + gap)。
        // iteration 31: pass-1 は live DOM が無く実測できないため、emoji 実幅を font-size で概算し
        // ICON_GAP を足す (fs*1.2 ≒ emoji グリフ幅の余裕込み)。text ノードは pass-2 measureRealWidth が
        // 実測で上書きするので、ここは初期 bounds 用の概算。
        var iconPad = (node && (node.isPage || node.filePath)) ? (fs * 1.2 + ICON_GAP) : 0;
        var longest = 0;
        for (var i = 0; i < explicitLines.length; i++) {
            if (explicitLines[i].length > longest) { longest = explicitLines[i].length; }
        }
        var maxW = 280;
        // 自然幅 (折り返し前にテキストを 1 行で収めるのに必要な幅)。padding(PAD_H) + border(BORDER_W)。
        // SAFETY はアイコン付きの iconPad にのみ含める (アイコン無しは iter30 の BORDER_W だけで #10 維持)。
        var naturalW = longest * charW + PAD_H + BORDER_W + iconPad;
        // 画像がある node は text 幅 と 画像最小幅 の大きい方を採る（text 無しでも横に広がる）。max 280 は据え置き。
        var w = Math.max(80, Math.min(maxW, Math.max(naturalW, imageMinWidth(node))));
        var wrapCount = 0;
        for (var j = 0; j < explicitLines.length; j++) {
            wrapCount += Math.max(1, Math.ceil((explicitLines[j].length * charW) / (w - PAD_H - BORDER_W - iconPad || 1)));
        }
        var lines = Math.max(explicitLines.length, wrapCount);
        // #改 (iteration 13, TASK-43): ノード幅 = 最長行の自然幅にフィット・上限 280。
        // 改行数・折り返し有無で 280 に固定しない (decision-a6-fit-longest-line-cap-280)。
        //   naturalW <= 280 → 最長行フィット (短い行の複数行ノードは 280 未満)。
        //   naturalW > 280  → 280 でクランプ (長い行は 280 で折り返して縦伸び)。
        // w は既に上で Math.max(80, Math.min(maxW, naturalW)) で確定済み。
        // 高さ (lines) は明示改行 + 折り返しで計算するので縦は従来どおり変わらない。
        var h = lines * (fs + 6) + 12;
        // FR-MM-IP: 複数画像は .mindmap-node-images（flex-wrap, img max 60x48, gap4）で折り返して並ぶ。
        //   枚数に応じて行数分の高さを確保する（従来の固定 +60 は複数行ではみ出すため動的化）。
        if (node && node.images && node.images.length) {
            var perRow = Math.max(1, Math.floor((w - 20) / 64)); // box padding/gap を考慮した 1 行あたり枚数（img64px）
            var imgRows = Math.ceil(node.images.length / perRow);
            h += imgRows * 52 + 8; // 1 行 = img48 + gap4 相当
        }
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
        // iteration 27 (TASK-71): 編集中の判定は is-editing クラス (committed active も
        // contenteditable=true になったため contenteditable では区別できない)。
        if (text.classList && text.classList.contains('is-editing')) { return estW; }
        var raw = (node && node.text) || '';
        var lines = String(raw).split('\n');
        var scale = viewport.scale || 1;
        // #10 (iteration 23 / TASK-64): .mindmap-node-text は flex: 1 1 0 で box を埋めるまで
        // 伸長する。単に white-space:nowrap にして scrollWidth を読むと「伸長後の clientWidth」
        // (= 1 パス目の過大な box 幅) が返り、実グリフより広い確定幅 → 右空白になる。
        // 逆に live 要素を flex:0 0 auto; width:auto にして測っても、text は依然 .mindmap-node-box
        // (max-width:280; flex-wrap:wrap; foreignObject 幅で制約) の中にあるため、box の現在幅で
        // 折り返されて scrollWidth が **過小**になることがある (実測: intrinsic 151 なのに live 測定は
        // 141 → realW=161 で確定 box が折り返し = TC-U4 の 2 行高さバグ)。
        // → **document.body 直下の offscreen 分離 clone** を nowrap で測る (親制約を受けない真の
        //   intrinsic 幅)。interactions.js の measureLongestLineWidth と同方式。live DOM は触らない
        //   (caret/IME・レイアウト無傷、generator_failures 2026-07-02 原則)。
        var maxScreen = 0;
        var clone = text.cloneNode(false); // 属性のみ (子は行ごとに入れ直す)
        clone.removeAttribute('contenteditable');
        clone.removeAttribute('data-node-id');
        clone.style.position = 'absolute';
        clone.style.left = '-99999px';
        clone.style.top = '0';
        clone.style.whiteSpace = 'nowrap';
        clone.style.flex = '0 0 auto';
        clone.style.width = 'auto';
        clone.style.maxWidth = 'none';
        clone.style.visibility = 'hidden';
        var host = (text.ownerDocument && text.ownerDocument.body) || document.body;
        host.appendChild(clone);
        for (var li = 0; li < lines.length; li++) {
            clone.textContent = (lines[li] === '' ? '​' : lines[li]);
            var w2 = clone.scrollWidth;
            if (w2 > maxScreen) { maxScreen = w2; }
        }
        if (clone.parentNode) { clone.parentNode.removeChild(clone); }
        if (maxScreen <= 0) { return estW; }
        // iconPad: アイコン (📄/📎) 付きは同じ flex 行に icon + gap(6px) が並ぶ分 text 幅が減る。
        // アイコン要素の実 DOM 幅を実測し + gap を足す (推定でなく実測。全 emoji 幅・環境に頑健)。
        // 一般の安全余白は BORDER_W(=18, border + 1 文字分) が全ノードに効くのでここでは足さない。
        var iconEl = box.querySelector('.mindmap-node-icon');
        var iconPad = 0;
        if (iconEl) {
            var iconW = iconEl.getBoundingClientRect().width / scale;
            if (!(iconW > 0)) { iconW = PAD_H; } // 実測できない場合の保険 (旧推定値)
            iconPad = iconW + ICON_GAP; // アイコン実幅 + flex gap
        }
        // PAD_H(padding) + BORDER_W(border + 1 文字分の余裕) + iconPad で content 領域を確保。
        var needInner = maxScreen / scale + PAD_H + BORDER_W + iconPad;
        // pass-1 と同様、画像がある node は text 実測幅 と 画像最小幅 の大きい方を採る
        // （★両パス修正 = これが無いと pass-2 が幅を text 幅へ縮め戻し縦積みが再発する）。
        return Math.max(80, Math.min(280, Math.max(needInner, imageMinWidth(node))));
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
        // iteration 27 (TASK-71): 編集中判定は is-editing クラス。
        if (text && text.classList && text.classList.contains('is-editing')) {
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
                // FR-MM-IP: 画像 dblclick で lightbox プレビュー（outliner パリティ、既存 overlay を再利用）。
                //   stopPropagation で node の dblclick（focusNode/openPage）に伝播させない。
                img.addEventListener('dblclick', function(ev) {
                    ev.stopPropagation();
                    if (typeof OutlinerCell !== 'undefined' && OutlinerCell.showImageOverlay) {
                        OutlinerCell.showImageOverlay(this.src);
                    }
                });
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
        // #7 (iteration 23 / TASK-62): mindmap の tree コンテナは overflow:clip で
        // programmatic スクロールが止まる想定だが、clip を honor しない環境の保険として
        // scrollLeft/Top を 0 に固定する。focus/click 由来のドリフトで map がずれるのを防ぐ
        // (viewport.transform のみが map の画面位置を決める = group 作成でも不動)。
        keepTreeUnscrolled(treeEl);

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

        // --- viewport フレーム安定化 (FR-021-J2, TASK-49): bounds シフト補償 ---
        // 固定ノード画面位置 ≈ translate + scale·(nodeX − minX)。minX が Δ 動いても画面位置を
        // 不変に保つには translate を +Δ·scale する。
        // ★ 安定化補正は「最終表示に使う bounds」を持つ pass で行う。この render で 2 パス目
        //   (実測 realDims 再レイアウト) が走るなら、1 パス目 (estimate bounds) では補正せず、
        //   2 パス目 (real bounds) で補正する。理由: CJK 等では estimate 幅 (charW=fs*0.6) と実測幅が
        //   大きく食い違い、1 パス estimate delta で補正すると実際の表示シフト (real delta) に届かず
        //   その差分だけ固定ノードがずれる (TC-V1 の anchor 50px ずれ)。real bounds で補正すれば一致する。
        //   2 パス目が走らない (単一行等) 通常マップは 1 パス目で補正 (従来どおり)。
        //   基準 (_prevBoundsMin) は常に最終表示 bounds で更新し、次回 delta を real→real に閉じる。
        var willSecondPass = !ctx._secondPass && needsRealMeasure(model, positions);
        var _isFinalFrame = ctx._secondPass || !willSecondPass; // このパスの bounds が最終表示になるか
        if (_isFinalFrame) {
            var bMin = { x: layout.bounds.minX, y: layout.bounds.minY };
            if (_prevBoundsMin && !_skipStabilizeOnce && _stabilizeEnabled) {
                var dbx = bMin.x - _prevBoundsMin.x;
                var dby = bMin.y - _prevBoundsMin.y;
                if (dbx || dby) {
                    viewport.translateX += dbx * (viewport.scale || 1);
                    viewport.translateY += dby * (viewport.scale || 1);
                }
            }
            // updateViewport 由来のユーザー明示 viewport 変更は安定化で上書きしない (基準のみ更新)。
            _skipStabilizeOnce = false;
            _prevBoundsMin = bMin;
        }
        // 1 パス目で 2 パスが走る場合は補正も基準更新もしない (2 パス目 = 最終 frame で行う)。

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

        // 安全網: willSecondPass=true と予測して 1 パス目で安定化を deferred したが、実際には
        // 2 パス目が走らなかった (box 幅 0 等で realDims が空) 場合、この 1 パス目が最終 frame に
        // なるのでここで安定化を適用する (deferred のまま drift させない)。通常は上の 2 パス目で
        // 補正済みなのでここは到達しない (return するため)。
        if (willSecondPass && !_isFinalFrame) {
            var bMinF = { x: layout.bounds.minX, y: layout.bounds.minY };
            if (_prevBoundsMin && !_skipStabilizeOnce && _stabilizeEnabled) {
                var dbxF = bMinF.x - _prevBoundsMin.x;
                var dbyF = bMinF.y - _prevBoundsMin.y;
                if (dbxF || dbyF) {
                    viewport.translateX += dbxF * (viewport.scale || 1);
                    viewport.translateY += dbyF * (viewport.scale || 1);
                    vp.style.transform = 'translate(' + viewport.translateX + 'px,' + viewport.translateY + 'px) scale(' + viewport.scale + ')';
                }
            }
            _skipStabilizeOnce = false;
            _prevBoundsMin = bMinF;
        }

        // ツールバー (左上) / ミニマップ (右下) を可視枠固定 chrome に入れる (TASK-58)。
        // treeEl 直下に absolute 子として置くと、treeEl が可視領域より高い/スクロールで流れる
        // 場合に可視枠外へ出てしまう (ユーザー #1)。chrome overlay は「実際に見えている可視
        // クリップ矩形」に追従するので、rerender・スクロール・小さい窓でも常に可視枠の
        // 左上/右下に固定される。
        var chrome = document.createElement('div');
        chrome.className = 'mindmap-chrome';
        chrome.appendChild(buildToolbar(settings));
        chrome.appendChild(buildMinimap(positions, layout.bounds));
        treeEl.appendChild(chrome);
        positionChrome(treeEl);
        // 初回 render / モード切替直後は祖先 (scroll-content / container) の高さ変化がまだ
        // レイアウトに反映されておらず、可視クリップ矩形が確定していないことがある。
        // 二重 rAF (ブラウザのレイアウト+ペイント後) でもう一度確定して、settle 後の正しい
        // 可視枠に合わせる (単発 rAF ではまだ祖先 flex が再計算されていない場合がある)。
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function() {
                positionChrome(treeEl);
                requestAnimationFrame(function() { positionChrome(treeEl); });
            });
        }
        // scroll / resize でも可視枠に追従させる (前回のハンドラは解除して二重登録を防ぐ)。
        bindChromeReposition(treeEl);

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
            // #10 (iteration 23 / TASK-64): 単一行の素テキストノードも 2 パス実測する。
            // 従来は \n/icon/image/tag が無いと char 推定 (fs*0.6/字) のみで確定していたが、
            // char 推定は proportional フォントで実グリフより過大 (実測: "Hello World Foo" 15字で
            // 幅 150px vs 実グリフ 96px = 右に ~45px の空白) → ユーザー報告 #10「右側に空白が多い」。
            // 非空テキストがあれば measureRealWidth (intrinsic 実測) を走らせて右空白を padding のみに。
            if ((n.text && n.text.length > 0) ||
                n.isPage || n.filePath ||
                (n.images && n.images.length) ||
                (n.tags && n.tags.length)) {
                return true;
            }
        }
        return false;
    }

    // --- chrome overlay を「可視クリップ矩形」に配置する (TASK-58) ---
    // 可視クリップ = treeEl の rect を、overflow を持つ祖先すべて + window で交差クランプした矩形。
    // chrome は treeEl の absolute 子なので、位置は treeEl rect からの相対オフセットで与える。
    // これで treeEl が可視領域より高い (min-height:400 で overflow) / スクロールで流れても、
    // chrome (と中の toolbar 左上・minimap 右下) は常に見えている枠にぴったり載る。
    // #7 (TASK-62): tree コンテナが programmatic/focus スクロールでドリフトしないよう
    // scrollLeft/Top を 0 に固定する。overflow:clip の保険 (clip 非対応環境向け) +
    // scroll イベントで即時リセットして map の画面位置を viewport.transform のみに委ねる。
    var _treeScrollGuard = null;
    var _treeScrollGuardEl = null;
    function keepTreeUnscrolled(treeEl) {
        if (!treeEl) { return; }
        if (treeEl.scrollLeft) { treeEl.scrollLeft = 0; }
        if (treeEl.scrollTop) { treeEl.scrollTop = 0; }
        // scroll ハンドラを (最新 treeEl に) 1 つだけ張り、ドリフトを即座に戻す。
        if (_treeScrollGuardEl === treeEl && _treeScrollGuard) { return; }
        if (_treeScrollGuardEl && _treeScrollGuard && _treeScrollGuardEl.removeEventListener) {
            _treeScrollGuardEl.removeEventListener('scroll', _treeScrollGuard, true);
        }
        _treeScrollGuardEl = treeEl;
        _treeScrollGuard = function() {
            if (treeEl.scrollLeft) { treeEl.scrollLeft = 0; }
            if (treeEl.scrollTop) { treeEl.scrollTop = 0; }
        };
        if (treeEl.addEventListener) { treeEl.addEventListener('scroll', _treeScrollGuard, true); }
    }

    function positionChrome(treeEl) {
        var chrome = treeEl.querySelector && treeEl.querySelector('.mindmap-chrome');
        if (!chrome || !treeEl.getBoundingClientRect) { return; }
        var tr = treeEl.getBoundingClientRect();
        var top = tr.top, left = tr.left, right = tr.right, bottom = tr.bottom;
        // overflow を持つ祖先で交差クランプ (scroll-content の overflow:hidden/auto 等)。
        var anc = treeEl.parentElement;
        var guard = 0;
        while (anc && guard++ < 100) {
            var cs = null;
            try { cs = window.getComputedStyle(anc); } catch (e) { cs = null; }
            if (cs) {
                var ox = cs.overflowX, oy = cs.overflowY;
                var clips = /(auto|scroll|hidden|clip)/;
                if (clips.test(ox) || clips.test(oy)) {
                    var ar = anc.getBoundingClientRect();
                    if (ar.top > top) { top = ar.top; }
                    if (ar.left > left) { left = ar.left; }
                    if (ar.right < right) { right = ar.right; }
                    if (ar.bottom < bottom) { bottom = ar.bottom; }
                }
            }
            anc = anc.parentElement;
        }
        // 実ウィンドウとも交差 (iteration 21: treeEl が window より外にはみ出すことがある)。
        var winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : right;
        var winH = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : bottom;
        if (top < 0) { top = 0; }
        if (left < 0) { left = 0; }
        if (right > winW) { right = winW; }
        if (bottom > winH) { bottom = winH; }
        var w = Math.max(0, right - left), h = Math.max(0, bottom - top);
        // treeEl rect からの相対オフセットで chrome を配置 (chrome は treeEl の absolute 子)。
        chrome.style.left = (left - tr.left) + 'px';
        chrome.style.top = (top - tr.top) + 'px';
        chrome.style.width = w + 'px';
        chrome.style.height = h + 'px';
    }

    // scroll / resize / (祖先の) サイズ変化でも chrome を可視枠へ追従させる。render 毎に呼び、
    // 前回ハンドラを解除して二重登録を防ぐ (最新の treeEl を対象にする)。detach でも解除する。
    // ResizeObserver は「祖先 flex の高さ確定が非同期に起きる」場合 (モード切替直後・窓リサイズ・
    // 分割ペインのドラッグ等) に、rAF/タイマーに頼らず確定タイミングで再配置できるので堅牢。
    function bindChromeReposition(treeEl) {
        unbindChromeReposition();
        if (typeof window === 'undefined' || !window.addEventListener) { return; }
        _chromeReposition = function() { positionChrome(treeEl); };
        // scroll は capture (祖先 scroll-content のスクロールも拾う)。
        window.addEventListener('scroll', _chromeReposition, true);
        window.addEventListener('resize', _chromeReposition);
        // treeEl と overflow を持つ祖先 (scroll-content 等) のサイズ変化を監視して再配置。
        if (typeof ResizeObserver === 'function') {
            try {
                _chromeResizeObs = new ResizeObserver(function() { positionChrome(treeEl); });
                _chromeResizeObs.observe(treeEl);
                var anc = treeEl.parentElement;
                var guard = 0;
                while (anc && guard++ < 100) {
                    var cs = null;
                    try { cs = window.getComputedStyle(anc); } catch (e) { cs = null; }
                    if (cs && /(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) {
                        _chromeResizeObs.observe(anc);
                    }
                    anc = anc.parentElement;
                }
            } catch (e) { _chromeResizeObs = null; }
        }
    }

    function unbindChromeReposition() {
        if (_chromeReposition && typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('scroll', _chromeReposition, true);
            window.removeEventListener('resize', _chromeReposition);
        }
        _chromeReposition = null;
        if (_chromeResizeObs) {
            try { _chromeResizeObs.disconnect(); } catch (e) { /* noop */ }
            _chromeResizeObs = null;
        }
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
        // [H] (iteration 29 / TASK-74): PNG/SVG/OPML/MD エクスポートボタンは削除 (まだ不要)。
        // doExport ハンドラ (interactions) は残置 (無害・将来復活用)。
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
        // ユーザー明示の pan/zoom/fit/minimap 由来の viewport 変更は、次 render の
        // フレーム安定化補正で上書きしない (TASK-49)。次 render は基準 (_prevBoundsMin)
        // だけ更新し、その次の render から通常どおり安定化する。
        _skipStabilizeOnce = true;
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
        // chrome overlay の scroll/resize ハンドラを解除 (TASK-58, リーク防止)。
        unbindChromeReposition();
        // tree scroll guard を解除 (TASK-62, リーク防止)。
        if (_treeScrollGuardEl && _treeScrollGuard && _treeScrollGuardEl.removeEventListener) {
            _treeScrollGuardEl.removeEventListener('scroll', _treeScrollGuard, true);
        }
        _treeScrollGuard = null;
        _treeScrollGuardEl = null;
        if (typeof MindmapInteractions !== 'undefined' && MindmapInteractions.detach) {
            MindmapInteractions.detach();
        }
        _lastCtx = null;
        // フレーム安定化の基準もリセット (次回 mindmap を開いた初回 render を補正しない, TASK-49)。
        _prevBoundsMin = null;
        _skipStabilizeOnce = false;
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
        _trackBodyEl: function(e) { _bodyEls.push(e); },
        // テスト用 (TASK-49 load-bearing): フレーム安定化補正の有効/無効を切り替える。
        _setStabilizeEnabled: function(v) { _stabilizeEnabled = !!v; },
        _getPrevBoundsMin: function() { return _prevBoundsMin ? { x: _prevBoundsMin.x, y: _prevBoundsMin.y } : null; }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MindmapRender;
}
