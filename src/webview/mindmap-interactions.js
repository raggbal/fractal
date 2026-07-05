/**
 * MindmapInteractions — mindmap のキーボード / D&D / 選択 / フォーカス。
 * 既存 model API (addNode/moveNode/removeNode) と undo(ctx.pushUndo)/scheduleSync に乗る。
 *
 * 仕様の正典: design/system/interactions.md
 * Wave 3 = TASK-07(キーボード) + TASK-08(D&D reparent + 選択)。
 * Wave 4-5 (スタイル/グループ/関連線/ズーム) は後続。
 */

// eslint-disable-next-line no-unused-vars
var MindmapInteractions = (function() {
    'use strict';

    var _treeEl = null;
    var _handlers = [];
    var _dragState = null; // { nodeId }
    var _contextMenuEl = null;
    var _selectedGroupId = null; // クリック選択中のグループ (G5/G6)

    // ensureNodeVisible の余白 (iteration 18 / TASK-52)。ユーザー報告バグ (#18/#19) は右側 (横方向)
    // の子持ちノードがギリギリで見づらい件。→ 横方向マージンを 16 → 32 に広げ、右はみ出し補正のみ
    // 折りたたみハンドルの右張り出し分 handlePad を加算する。
    // 縦方向マージンは 16 のまま据え置く: iteration 17 の TC-V6 (ArrowDown 連打で選択ノードが下へ
    // march する = 中央寄せしない invariant) が縦の最小パン量に依存しており、縦マージンを 32 に
    // 上げると march の後退が TC-V6 の許容 (-2px) を超えて既存テストを壊すため (バグは横方向のみ)。
    // テストが load-bearing 検証で横の旧値 (16, 0) に戻せるよう module 変数 + setter で公開する
    // (mindmap-render.js の _setStabilizeEnabled と同方針)。
    var _ensureMarginX = 32;     // 横方向 本番既定 (旧: 16)。左右対称の見やすい余白。
    var _ensureMarginY = 16;     // 縦方向 本番既定 (据え置き。TC-V6 の march invariant を保つ)。
    var _ensureHandlePad = 12;   // 本番既定 (旧: 0)。右のみ。ハンドル (~9px 右張り出し) + 余裕
    // ensureNodeVisible の発動トリガー (iteration 19 / TASK-53)。本番既定 'margin' =
    //   「マージン分の余白を確保して収まっているか」で判定 (端に密着=はみ出さないが余白 <marginX の
    //   ケースでもパンして隙間を作る)。iteration 18 のバグは 'overflow' =「はみ出したときだけ」で、
    //   端密着ノードに margin が効かなかった (Image #20)。テストが load-bearing 検証で旧 'overflow'
    //   トリガーに戻せるよう module 変数 + setter で公開する。
    var _ensureTrigger = 'margin'; // 'margin' (本番) | 'overflow' (旧・load-bearing 用)
    // ensureNodeVisible の可視端を実ウィンドウ (window.innerWidth/innerHeight) と交差させるか
    // (iteration 21 / TASK-54, decision-ensure-visible-clamp-to-window)。本番既定 true =
    //   `.outliner-tree` が実ウィンドウより外側にオーバーフローしていても、実際に見えている端
    //   (winW/winH) から余白を取る (実機の tree R716 > winW687 の 29px ズレで right-Tab だけ隙間が
    //   潰れた真因への対処)。false = 旧挙動 (treeEl 矩形をそのまま可視端に使う) で、tree はみ出し
    //   状況で window との隙間が marginX 未満になり red → load-bearing 検証に使う。
    var _ensureClampToWindow = true; // true (本番) | false (旧・load-bearing 用)

    function closeContextMenu() {
        if (_contextMenuEl && _contextMenuEl.parentNode) {
            _contextMenuEl.parentNode.removeChild(_contextMenuEl);
        }
        _contextMenuEl = null;
    }

    function on(el, type, fn, opts) {
        el.addEventListener(type, fn, opts);
        _handlers.push({ el: el, type: type, fn: fn, opts: opts });
    }

    function nodeElFromEvent(e) {
        var t = e.target;
        while (t && t !== _treeEl) {
            if (t.classList && t.classList.contains('mindmap-node')) { return t; }
            t = t.parentNode;
        }
        return null;
    }

    function boxOf(nodeId) {
        return _treeEl.querySelector('.mindmap-node[data-node-id="' + nodeId + '"] .mindmap-node-box');
    }

    function textElOf(nodeId) {
        return _treeEl.querySelector('.mindmap-node-text[data-node-id="' + nodeId + '"]');
    }

    /**
     * 描画後に呼ばれ、キャンバスにイベントを配線する。
     * @param {HTMLElement} treeEl
     * @param {Object} model
     * @param {Object} settings
     * @param {Object} host
     * @param {Object} ctx - { pushUndo, setFocusedNodeId, getFocusedNodeId, openPage, scheduleSync, selectedNodeIds, ... }
     * @param {Object} runtime - { layout, viewport, rerender }
     */
    function attach(treeEl, model, settings, host, ctx, runtime) {
        detach();
        _treeEl = treeEl;
        ctx = ctx || {};
        runtime = runtime || {};

        var rerender = runtime.rerender || function() {};
        var scheduleSync = ctx.scheduleSync || function() {};
        var pushUndo = ctx.pushUndo || function() {};
        var setFocused = ctx.setFocusedNodeId || function() {};
        var getFocused = ctx.getFocusedNodeId || function() { return null; };
        var selected = ctx.selectedNodeIds || (typeof Set !== 'undefined' ? new Set() : null);

        // startEdit=false: 選択のみ (contenteditable にしない、C10 — 空ノードでも編集開始しない)
        // startEdit=true : 編集開始 (Space/F2/dblclick 経由のみ)
        function focusNode(nodeId, startEdit) {
            setFocused(nodeId);
            var box = boxOf(nodeId);
            if (box) {
                var boxes = _treeEl.querySelectorAll('.mindmap-node-box.is-focused');
                for (var i = 0; i < boxes.length; i++) { boxes[i].classList.remove('is-focused'); }
                box.classList.add('is-focused');
            }
            var textEl = textElOf(nodeId);
            if (textEl) {
                if (startEdit) {
                    // 編集開始: 改行を含む生テキストを <br> 付きで編集用に流し込む
                    var node = (nodeId === '__title__')
                        ? { text: (ctx.titleText || '') } : model.getNode(nodeId);
                    var raw = (node && node.text) || '';
                    if (raw.indexOf('\n') >= 0) {
                        textEl.textContent = '';
                        var parts = raw.split('\n');
                        for (var p = 0; p < parts.length; p++) {
                            if (p > 0) { textEl.appendChild(document.createElement('br')); }
                            textEl.appendChild(document.createTextNode(parts[p]));
                        }
                    }
                    textEl.setAttribute('contenteditable', 'true');
                    // FR-021-A7: 編集開始時、テキストに \n が無ければ横伸びモード
                    // (is-editing-nowrap = white-space:nowrap) にして折り返しを止める。
                    // \n があれば従来 pre-wrap のまま (FR-021-A6 折り返し維持)。
                    if (raw.indexOf('\n') < 0) {
                        textEl.classList.add('is-editing-nowrap');
                    } else {
                        textEl.classList.remove('is-editing-nowrap');
                    }
                    // preventScroll: native focus scroll がコンテナ (.outliner-scroll-content)
                    // を動かして中央寄せするのを止める (iteration 17 / TASK-51)。
                    // 可視化は ensureNodeVisible (transform 最小パン) に一本化する。
                    // caret 設定 (下の range) は focus 後に行う既存順序を維持。
                    try { textEl.focus({ preventScroll: true }); }
                    catch (e) { textEl.focus(); }
                    // カーソルを末尾へ
                    if (typeof document !== 'undefined' && document.createRange) {
                        var range = document.createRange();
                        range.selectNodeContents(textEl);
                        range.collapse(false);
                        var sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                    // 編集開始時の box 高さを基準として記録（下方ノードずらしの基準, TASK-32）
                    if (_editBaseH) {
                        var eb = textEl.closest && textEl.closest('.mindmap-node-box');
                        if (eb) { _editBaseH[nodeId] = eb.getBoundingClientRect().height; }
                    }
                    // FR-021-A7: 横伸びモードの基準幅を記録（foreignObject の元 width）。
                    if (_editBaseW) {
                        var fo = boxOf(nodeId) && boxOf(nodeId).parentNode; // foreignObject
                        if (fo && fo.getAttribute) {
                            var w0 = parseFloat(fo.getAttribute('width')) || 0;
                            _editBaseW[nodeId] = w0;
                            // FR-021-A7 (TASK-38): left 側ノードは右端固定で左へ伸ばすため、
                            // 編集開始時の右端 (x + width) を基準として記録する。
                            var x0 = parseFloat(fo.getAttribute('x')) || 0;
                            _editRightEdge[nodeId] = x0 + w0;
                        }
                    }
                } else {
                    // 選択のみ: contenteditable にしない (tabindex フォーカスのみ)
                    textEl.setAttribute('contenteditable', 'false');
                    // preventScroll: 矢印移動・追加後・クリック選択の主経路。native focus
                    // scroll がコンテナ (.outliner-scroll-content) を動かして選択ノードを
                    // 中央寄せするのを止める (iteration 17 / TASK-51)。可視化は
                    // ensureNodeVisible (transform 最小パン) に一本化。
                    try { textEl.focus({ preventScroll: true }); }
                    catch (e) { textEl.focus(); }
                }
            }
        }

        // --- 移動・追加時の最小追従 (FR-021-J2, iteration 16 / TASK-50) ---
        // 対象ノードが画面外のときだけ最小量パンして見せる (中央には寄せない)。
        // 前提: viewport フレーム安定化 (mindmap-render.js, TASK-49) で「レイアウト起因の
        //   bounds シフト」は打ち消され、rerender で固定ノードの画面位置は不変。この関数は
        //   その上で「フォーカスが移る先が画面外なら最小パン」する。
        // 正典: design/system/interactions.md「移動・追加時の最小追従」。
        // 呼び出し元は各操作の rerender 後 (rerender は viewport を共有参照するため、この
        //   時点の getBoundingClientRect は安定化後の座標)。ユーザー明示 pan/zoom/fit/minimap
        //   と編集確定 (commitEdit) は呼ばない。
        function ensureNodeVisible(nodeId) {
            if (!nodeId || !_treeEl) { return; }
            var fo = _treeEl.querySelector('.mindmap-node[data-node-id="' + nodeId + '"]');
            if (!fo || !fo.getBoundingClientRect) { return; }
            var nr = fo.getBoundingClientRect();
            var vr = _treeEl.getBoundingClientRect();
            // 可視領域を treeEl 矩形そのままでなく **実ウィンドウと交差させた矩形**にする
            // (iteration 21 / TASK-54, decision-ensure-visible-clamp-to-window)。
            // 実機ログ (0.208.32): `.outliner-tree` の getBoundingClientRect().right=716 が
            // window.innerWidth=687 より 29px 外側にオーバーフローしていた (祖先 scroll-content
            // 以上は R687 で clip)。→ treeEl 基準で marginX=32 を確保しても、実際に見えている
            // 右端 (winW=687) との隙間は 3px でくっついて見えた (right-Tab だけ露呈)。
            // 可視端を Math.min(vr.right, winW) 等で実ウィンドウと交差させ、実可視端から余白を取る。
            // window が取れない環境 (テスト等) は vr フォールバック。treeEl と window が一致する
            // standalone 既存ケースでは Math.min/max が no-op で従来と同一 (TC-V1〜V9 不変)。
            var winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : vr.right;
            var winH = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : vr.bottom;
            // _ensureClampToWindow=false (load-bearing 用) では旧挙動 = treeEl 矩形をそのまま可視端に
            //   使う (Math.min/max なし)。true (本番) では実ウィンドウと交差させる。
            var visRight  = _ensureClampToWindow ? Math.min(vr.right, winW) : vr.right;
            var visLeft   = _ensureClampToWindow ? Math.max(vr.left, 0) : vr.left;
            var visTop    = _ensureClampToWindow ? Math.max(vr.top, 0) : vr.top;
            var visBottom = _ensureClampToWindow ? Math.min(vr.bottom, winH) : vr.bottom;
            // 横方向マージン (左右共通で _ensureMarginX=32px。iteration 18 / TASK-52: 左の見やすい
            // 余白に合わせて 16 → 32 に拡大) / 縦方向マージン (_ensureMarginY=16px 据え置き)。
            var marginX = _ensureMarginX;
            var marginY = _ensureMarginY;
            // 右はみ出し補正のみ、折りたたみハンドル (子持ちノードの `−`/`+`) の張り出し分を
            // 加算する。`.mindmap-collapse-handle` は position:absolute; right:-9px; width:16px で
            // box 右端を ~9px 右に張り出すが、fo.getBoundingClientRect() は absolute 子を含まない
            // ため nr.right に反映されない。→ ハンドルありノードは右余白がその分削られるので、
            // 右方向補正時だけ handlePad(=12, 実測 9px + 余裕) を上乗せする。ハンドルは右にしか
            // 出ないので左・上・下方向には加算しない (iteration 18 / TASK-52)。
            var handlePad = (fo.querySelector && fo.querySelector('.mindmap-collapse-handle')) ? _ensureHandlePad : 0;
            var dx = 0, dy = 0;
            if (_ensureTrigger === 'overflow') {
                // 旧トリガー (iteration 18・load-bearing 用): ノードが可視領域を「はみ出した」
                //   ときだけパン。端密着 (nr.right <= visRight だが余白 < marginX) では発動しない。
                if (nr.top < visTop) {
                    dy = (visTop - nr.top) + marginY;
                } else if (nr.bottom > visBottom) {
                    dy = -((nr.bottom - visBottom) + marginY);
                }
                if (nr.left < visLeft) {
                    dx = (visLeft - nr.left) + marginX;
                } else if (nr.right > visRight) {
                    dx = -((nr.right - visRight) + marginX + handlePad);
                }
            } else {
                // 本番トリガー (iteration 19 / TASK-53): 「マージン分の余白を確保して収まって
                //   いるか」で判定 (4 方向対称)。端にピッタリ収まる (はみ出さないが余白 < margin)
                //   ケースでも発動して隙間を作る。マージン分の余裕があれば全条件 false → dx=dy=0 →
                //   何もしない (「端に近いときだけマージン分の最小パン・十分内側なら不動」)。中央寄せ
                //   にはしない (マージン分だけ内側に入れる最小移動)。可視端は実ウィンドウとの交差
                //   (visTop/visBottom/visRight/visLeft) を使う (iteration 21 / TASK-54)。
                // 上: 上端がマージン込みで枠内に収まっていない → 下へずらす (translateY += ...)
                if (nr.top - marginY < visTop) {
                    dy = (visTop + marginY - nr.top);
                } else if (nr.bottom + marginY > visBottom) {
                    // 下: 下端がマージン込みで収まっていない → 上へずらす
                    dy = -(nr.bottom + marginY - visBottom);
                }
                // 右: 右端 (ハンドル張り出し分含む) がマージン込みで収まっていない → 左へずらす。
                //   右違反を優先し (else if 左)、通常ノードは同時発動しない。
                if (nr.right + marginX + handlePad > visRight) {
                    dx = -(nr.right + marginX + handlePad - visRight);
                } else if (nr.left - marginX < visLeft) {
                    // 左: 左端がマージン込みで収まっていない → 右へずらす
                    dx = (visLeft + marginX - nr.left);
                }
            }
            if (!dx && !dy) { return; } // マージン込みで完全に収まっている → 何もしない (viewport 不変)
            viewport.translateX += dx;
            viewport.translateY += dy;
            applyViewport(); // MindmapRender.updateViewport(viewport), transform のみ・再レイアウトなし
        }

        // contenteditable の DOM を改行付きプレーンテキストに正規化 (FR-021-C13)。
        // <br> と block要素(<div>/<p>)境界を \n にする。textContent は改行を落とすため使わない。
        function readEditableText(el) {
            var out = '';
            (function walk(node, isBlockStart) {
                for (var i = 0; i < node.childNodes.length; i++) {
                    var c = node.childNodes[i];
                    if (c.nodeType === 3) { // text
                        out += c.nodeValue;
                    } else if (c.nodeType === 1) { // element
                        var tag = c.tagName.toLowerCase();
                        if (tag === 'br') {
                            out += '\n';
                        } else {
                            var block = (tag === 'div' || tag === 'p');
                            // 先頭以外の block 要素は改行で区切る
                            if (block && out.length > 0 && out[out.length - 1] !== '\n') { out += '\n'; }
                            walk(c, block);
                            void isBlockStart;
                        }
                    }
                }
            })(el, true);
            return out.replace(/\n+$/, ''); // 末尾の余分な改行を除去
        }

        function commitEdit(nodeId) {
            var textEl = textElOf(nodeId);
            if (!textEl) { return; }
            var newText = readEditableText(textEl);
            textEl.setAttribute('contenteditable', 'false');
            // FR-021-A7: 横伸びモードのクラス/基準幅をクリア（commit の rerender で
            // 新規要素生成により消えるが、text 不変で rerender しない経路の保険）。
            textEl.classList.remove('is-editing-nowrap');
            if (_editBaseW) { delete _editBaseW[nodeId]; }
            if (_editRightEdge) { delete _editRightEdge[nodeId]; }
            // title 中心ノード: model.title を更新
            if (nodeId === '__title__') {
                if (ctx.setTitle && (ctx.titleText || '') !== newText) {
                    pushUndo();
                    ctx.setTitle(newText);
                    scheduleSync();
                    rerender();
                }
                return;
            }
            var node = model.getNode(nodeId);
            if (node && node.text !== newText) {
                pushUndo();
                model.updateText(nodeId, newText);
                scheduleSync();
                // commit 後に正式再レイアウト（編集中の translateY 応急ずらしを破棄し、
                // 伸びたノード込みの正しいレイアウトを再計算して確定させる, TASK-32）
                if (_editBaseH) { delete _editBaseH[nodeId]; }
                rerender();
            } else {
                // テキスト不変でも編集中に translateY をかけた可能性があるので、
                // 高さが変わっていれば（改行削除等）確定レイアウトに戻す
                if (_editBaseH) { delete _editBaseH[nodeId]; }
            }
        }

        // --- キーボード v2 (TASK-16, sync 2026-07-01) ---
        // 「カーソルあり」= contenteditable=true。追加系は追加後も非編集。Space で編集開始。
        // グループ削除は document レベルで捕捉 (グループ rect クリック後は focus が body に
        // 移り treeEl の keydown に届かないため)。ノード編集中でない時のみ。
        on(document, 'keydown', function(e) {
            if (e.isComposing || e.keyCode === 229) { return; }
            if (!_selectedGroupId) { return; }
            if (e.key !== 'Delete' && e.key !== 'Backspace') { return; }
            var activeEditing = document.activeElement &&
                document.activeElement.getAttribute &&
                document.activeElement.getAttribute('contenteditable') === 'true';
            if (activeEditing) { return; }
            e.preventDefault();
            pushUndo();
            if (typeof MindmapModel !== 'undefined') { MindmapModel.removeGroup(settings, _selectedGroupId); }
            markGroupSelected(null);
            scheduleSync(); rerender();
        });

        function handleKeydown(e) {
            if (e.isComposing || e.keyCode === 229) { return; }
            var nodeEl = nodeElFromEvent(e);
            var nodeId = nodeEl ? nodeEl.getAttribute('data-node-id') : getFocused();
            if (!nodeId) { return; }
            var isTitle = (nodeId === '__title__');
            var textEl = textElOf(nodeId);
            var isEditing = textEl && textEl.getAttribute('contenteditable') === 'true';

            // IME 変換中は無視
            if (e.isComposing || e.keyCode === 229) { return; }

            var mod = e.metaKey || e.ctrlKey;
            var node = isTitle ? null : model.getNode(nodeId);
            if (!isTitle && !node) { return; }

            // ===== カーソルあり (編集中) =====
            if (isEditing) {
                // Shift+Enter → 改行挿入 (C6): contenteditable のデフォルト(<div>/<br>)に委ねる
                if (e.key === 'Enter' && e.shiftKey) {
                    return; // preventDefault しない = ブラウザが改行挿入
                }
                // Enter / Tab / Esc → commit してカーソルを外す (C4/C5/C8)
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab' || e.key === 'Escape') {
                    e.preventDefault();
                    commitEdit(nodeId);
                    focusNode(nodeId, false); // 選択に戻す (非編集)
                    return;
                }
                return; // その他は contenteditable に委ねる
            }

            // ===== 非カーソル =====
            // undo/redo は outliner グローバルに委ねる
            if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) { return; }

            // Cmd+Enter → Page open
            if (mod && e.key === 'Enter') {
                e.preventDefault();
                if (node && node.isPage && ctx.openPage) { ctx.openPage(nodeId); }
                return;
            }
            // Cmd+A 全選択
            if (mod && (e.key === 'a' || e.key === 'A')) {
                e.preventDefault();
                if (selected && selected.clear) {
                    selected.clear();
                    for (var aid in model.nodes) { if (model.nodes.hasOwnProperty(aid)) { selected.add(aid); } }
                    rerender();
                }
                return;
            }
            // Cmd+Shift+L レイアウト方向切替
            if (mod && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
                e.preventDefault();
                var order = ['radial', 'right', 'left', 'balanced'];
                var cur = order.indexOf(settings.layout || 'right');
                settings.layout = order[(cur + 1) % order.length];
                pushUndo(); scheduleSync(); rerender();
                return;
            }

            switch (e.key) {
                case ' ': // Space → カーソルを入れる (C3)
                    e.preventDefault();
                    focusNode(nodeId, true);
                    return;
                case 'F2': // 補助: F2 でも編集開始
                    e.preventDefault();
                    focusNode(nodeId, true);
                    return;
                case 'Enter': { // 非カーソル Enter → 弟(次の兄弟)追加、非編集 (C1)
                    e.preventDefault();
                    if (isTitle) { return; } // title は構造編集不可
                    if (e.shiftKey) {
                        // Shift+Enter → 兄(現ノードの直前=上)追加 (C2)。
                        // addNode(parent, prev) は末尾/位置ズレの原因になるため addNodeBefore を使う (#4)。
                        pushUndo();
                        var bro = model.addNodeBefore(node.parentId, nodeId, '');
                        scheduleSync(); rerender(); focusNode(bro.id, false);
                        // 追加ノードの最小追従 (TASK-50): 画面内なら不変 (Shift+Enter の理想維持)、
                        // 画面外のみ最小パン。rerender 後 = 安定化後の座標で可視判定。
                        ensureNodeVisible(bro.id);
                    } else {
                        pushUndo();
                        var otouto = model.addNode(node.parentId, nodeId, '');
                        scheduleSync(); rerender(); focusNode(otouto.id, false);
                        ensureNodeVisible(otouto.id); // 追加ノードの最小追従 (TASK-50)
                    }
                    return;
                }
                case 'Tab': { // 非カーソル Tab → 子追加、非編集 (C7)
                    e.preventDefault();
                    if (isTitle) { return; }
                    pushUndo();
                    var child = model.addNode(nodeId, null, '');
                    if (node.collapsed) { node.collapsed = false; }
                    scheduleSync(); rerender(); focusNode(child.id, false);
                    ensureNodeVisible(child.id); // 追加ノードの最小追従 (TASK-50)
                    return;
                }
                case 'Delete':
                case 'Backspace':
                    e.preventDefault();
                    if (isTitle) { return; } // title は削除不可
                    // グループ選択中はグループ削除を優先 (G6) — group click ハンドラが設定
                    if (_selectedGroupId) {
                        pushUndo();
                        if (typeof MindmapModel !== 'undefined') { MindmapModel.removeGroup(settings, _selectedGroupId); }
                        _selectedGroupId = null;
                        scheduleSync(); rerender();
                        return;
                    }
                    pushUndo();
                    model.removeNode(nodeId);
                    if (typeof MindmapModel !== 'undefined') { MindmapModel.cleanupDanglingRefs(model, settings); }
                    scheduleSync(); rerender();
                    return;
                case 'ArrowUp':
                case 'ArrowDown':
                case 'ArrowLeft':
                case 'ArrowRight': {
                    e.preventDefault();
                    var dir = e.key.replace('Arrow', '').toLowerCase();
                    var adj = (typeof MindmapLayout !== 'undefined' && runtime.layout)
                        ? MindmapLayout.findAdjacent(runtime.layout.positions, nodeId, dir, settings.layout || 'right')
                        : null;
                    if (adj) {
                        focusNode(adj, false); // 選択のみ (編集開始しない, C10)
                        // 移動・追加時の最小追従 (TASK-50): 移動先が画面外なら最小パン。
                        // 上下左右すべて対称 (現状の「上は追従しない/下は中央」の非対称を解消)。
                        // 矢印移動は rerender せず選択のみ変わるので DOM は既存 → 直接可視判定。
                        ensureNodeVisible(adj);
                    }
                    return;
                }
            }
        }

        // treeEl レベルで keydown を捕捉 (mindmap-node-text からバブルアップ)
        on(treeEl, 'keydown', handleKeydown);

        // #1/#2 (TASK-32): 編集中の重なり解消。
        // decision-edit-relayout-no-dom-recreate: rerender は呼ばない（DOM 再生成は caret 飛び・
        // IME 中断の原因）。編集ノードの DOM は一切触らず、下方ノードの foreignObject を Δh 分
        // translateY でずらすだけ。commit 時に正式 rerender で最終形が正しくなる。
        var _editBaseH = {};      // nodeId -> 編集開始時の box 高さ
        var _editBaseW = {};      // nodeId -> 編集開始時の foreignObject 幅 (FR-021-A7 横伸び基準)
        var _editRightEdge = {};  // nodeId -> 編集開始時の foreignObject 右端 x+width (FR-021-A7 left側=右端固定で左へ伸ばす基準, TASK-38)
        var _isComposing = false; // IME 変換中フラグ

        // 編集中の応急ずらし transform を translateX/translateY 合成で設定する。
        // shiftBelowNodes(縦) と shiftAsideNodes(横) が同一要素に別軸をかけても互いを消さない。
        function setNodeShift(el, dx, dy) {
            if (dx != null) { el.__mmDx = dx; }
            if (dy != null) { el.__mmDy = dy; }
            var x = el.__mmDx || 0, y = el.__mmDy || 0;
            el.style.transform = (x || y) ? ('translate(' + x + 'px,' + y + 'px)') : '';
        }

        // 編集ノードより「下」にあるノードの foreignObject を dy だけ平行移動する。
        // 下判定: 同レイアウト座標 (runtime.layout.positions) で編集ノードより y が大きく、
        // かつ x の符号（左右 side）が同じノード。編集ノード自身は動かさない。
        function shiftBelowNodes(nid, dy) {
            var positions = runtime.layout && runtime.layout.positions;
            if (!positions || !positions[nid]) { return; }
            var editY = positions[nid].y;
            var editX = positions[nid].x;
            var editSideRight = editX >= 0;
            var shifted = {}; // 下方ずらししたノードID
            for (var id in positions) {
                if (!positions.hasOwnProperty(id) || id === nid) { continue; }
                var p = positions[id];
                var sameSide = (p.x >= 0) === editSideRight;
                if (!sameSide) { continue; }
                if (p.y <= editY) { continue; } // 上または同じ高さは動かさない
                var foEl = _treeEl.querySelector('.mindmap-node[data-node-id="' + id + '"]');
                if (foEl) { setNodeShift(foEl, null, dy); shifted[id] = true; }
            }
            // #A: ずらしたノードに接続する link path も追従させる（端点がノードに届くように）。
            // 編集中の応急追従（両端 translateY だが commit の rerender で正確な positions に戻る）。
            var paths = _treeEl.querySelectorAll('.mindmap-link[data-target-id]');
            for (var pi = 0; pi < paths.length; pi++) {
                var pth = paths[pi];
                var tid = pth.getAttribute('data-target-id');
                var sid = pth.getAttribute('data-source-id');
                // target が下方ずらしされたノード → その link を dy 追従
                if (shifted[tid]) { setNodeShift(pth, null, dy); }
                else if (!shifted[sid]) { setNodeShift(pth, null, 0); } // 縦だけ元に戻す
            }
        }

        // FR-021-A7: 編集ノードの横幅拡張 dw に対し、押し出す対象を「編集ノードの子孫のみ」に
        // 限定する（TASK-42 #3）。従来は「同 side・編集ノードより深い x の全ノード」を押し出したため、
        // 下の兄弟サブツリー（root A とその子 ac1/ac2）のうち A は深くない→不動、ac1/ac2 は深い→
        // translateX され、A→ac リンクが離れた。編集ノードの幅変化が押し出すのは self の子孫だけ。
        // 編集ノード自身・祖先・兄弟サブツリー・逆 side は動かさない。
        function shiftAsideNodes(nid, dw) {
            var positions = runtime.layout && runtime.layout.positions;
            if (!positions || !positions[nid]) { return; }
            var editX = positions[nid].x;
            var editSideRight = editX >= 0;
            var dir = editSideRight ? 1 : -1;   // 右 side は右へ、左 side は左へ押し出す
            var dx = dir * dw;
            // 子孫 ID の集合を作る（getDescendantIds があれば使う、無ければ children 再帰）。
            var descSet = {};
            var descIds = (model.getDescendantIds ? model.getDescendantIds(nid) : null);
            if (!descIds) {
                descIds = [];
                var stack = [];
                var n0 = model.getNode ? model.getNode(nid) : (model.nodes && model.nodes[nid]);
                if (n0 && n0.children) { stack = n0.children.slice(); }
                while (stack.length) {
                    var cid = stack.pop();
                    descIds.push(cid);
                    var cn = model.getNode ? model.getNode(cid) : (model.nodes && model.nodes[cid]);
                    if (cn && cn.children) { for (var ci = 0; ci < cn.children.length; ci++) { stack.push(cn.children[ci]); } }
                }
            }
            for (var di = 0; di < descIds.length; di++) { descSet[descIds[di]] = true; }
            var shifted = {};
            for (var id in positions) {
                if (!positions.hasOwnProperty(id) || id === nid) { continue; }
                if (!descSet[id]) { continue; } // 編集ノードの子孫のみ押し出す（兄弟サブツリーは動かさない）
                var foEl = _treeEl.querySelector('.mindmap-node[data-node-id="' + id + '"]');
                if (foEl) { setNodeShift(foEl, dx, null); shifted[id] = true; }
            }
            var paths = _treeEl.querySelectorAll('.mindmap-link[data-target-id]');
            for (var pi = 0; pi < paths.length; pi++) {
                var pth = paths[pi];
                var tid = pth.getAttribute('data-target-id');
                var sid = pth.getAttribute('data-source-id');
                if (shifted[tid]) { setNodeShift(pth, dx, null); }
                else if (!shifted[sid]) { setNodeShift(pth, 0, null); } // 横だけ元に戻す
            }
        }

        // FR-021-A7: 編集中に横幅をリアルタイム拡張する。
        // 上限 280px（decision-a7-width-cap-280。commit の estimateMeasure と一致）。
        // 単一行（\n なし）: is-editing-nowrap で折り返さず横へ伸ばし t.scrollWidth で測る。
        // 複数行（\n あり, TASK-42 #2）: pre-wrap のまま（折り返し表示・caret/IME 無傷）だが、
        //   box 幅を「最長行の必要幅」に合わせて広げる（測定は offscreen clone を nowrap で測る）。
        var A7_MAX_W = 280;

        // 編集中の text 要素の「最長行の必要幅（画面座標 px）」を測る。
        // 編集ノードの live DOM は書き換えない（generator_failures 2026-07-02 原則）。
        // clone を offscreen に置き nowrap にして各行の scrollWidth 最大を得る。
        function measureLongestLineWidth(t, raw) {
            var clone = t.cloneNode(false); // 属性のみコピー（子は入れ直す）
            clone.removeAttribute('contenteditable');
            clone.removeAttribute('data-node-id');
            clone.classList.add('is-editing-nowrap'); // 折り返し禁止で自然幅を測る
            clone.style.position = 'absolute';
            clone.style.left = '-99999px';
            clone.style.top = '0';
            clone.style.width = 'auto';
            clone.style.maxWidth = 'none';
            clone.style.whiteSpace = 'nowrap';
            clone.style.visibility = 'hidden';
            var lines = (raw || '').split('\n');
            var parent = t.parentNode || document.body;
            parent.appendChild(clone);
            var maxW = 0;
            for (var li = 0; li < lines.length; li++) {
                clone.textContent = (lines[li] === '' ? '​' : lines[li]);
                var w = clone.scrollWidth;
                if (w > maxW) { maxW = w; }
            }
            if (clone.parentNode) { clone.parentNode.removeChild(clone); }
            return maxW;
        }

        function adjustEditWidth(nid) {
            if (_isComposing) { return; }
            var t = textElOf(nid);
            if (!t || t.getAttribute('contenteditable') !== 'true') { return; }
            var fo = boxOf(nid) && boxOf(nid).parentNode; // foreignObject
            if (!fo || !fo.getAttribute) { return; }
            var scale = (runtime.viewport && runtime.viewport.scale) || 1;
            var box = t.closest && t.closest('.mindmap-node-box');
            if (!box) { return; }
            var raw = readEditableText(t);
            var isMultiline = raw.indexOf('\n') >= 0;
            // TASK-42 #2: 改行が入ったら nowrap（横伸びモード）を抜け pre-wrap（折り返し表示）へ。
            // ただし box 幅の追従は継続する（従来はここで return して幅固定 → バグ）。
            if (isMultiline && t.classList.contains('is-editing-nowrap')) {
                t.classList.remove('is-editing-nowrap');
            }
            // 必要幅（画面座標）を測る。単一行は live 要素の scrollWidth（nowrap）で足りるが、
            // 複数行は pre-wrap で折り返し済みのため clone を nowrap にして最長行を測る。
            var needScreen = isMultiline
                ? measureLongestLineWidth(t, raw)
                : t.scrollWidth;
            // + パディング/アイコン余白（estimateMeasure の +24+iconPad に整合）。
            var icon = box.querySelector('.mindmap-node-icon');
            var iconPad = icon ? 24 : 0;
            var needInner = needScreen / scale + 24 + iconPad;
            var baseW = _editBaseW[nid] || parseFloat(fo.getAttribute('width')) || 80;
            var targetW = Math.max(baseW, Math.min(A7_MAX_W, needInner));
            var curW = parseFloat(fo.getAttribute('width')) || baseW;
            if (targetW >= A7_MAX_W) {
                // 上限到達: 280 でクランプし、以降は折り返して縦伸び
                targetW = A7_MAX_W;
                t.classList.remove('is-editing-nowrap');
            }
            if (Math.abs(targetW - curW) < 1) { return; }
            fo.setAttribute('width', targetW);
            // FR-021-A7 (TASK-38): 伸長方向を side 別にする。
            // right 側 (x >= 0): 左端 x 固定で右へ伸ばす（x はいじらない, 従来）。
            // left 側 (x < 0) : 右端固定で左へ伸ばす（右端 = x + width を不変に保つよう x を更新）。
            var positions = runtime.layout && runtime.layout.positions;
            var editX = (positions && positions[nid]) ? positions[nid].x : 0;
            if (editX < 0) {
                var rightEdge = _editRightEdge[nid];
                if (rightEdge == null) {
                    rightEdge = (parseFloat(fo.getAttribute('x')) || 0) + curW;
                    _editRightEdge[nid] = rightEdge;
                }
                fo.setAttribute('x', rightEdge - targetW);
            }
            // 横方向の追従（子孫ノード・線を押し出す）。基準幅からの増分で計算。
            var dw = targetW - baseW;
            shiftAsideNodes(nid, dw);
        }

        function adjustEditOverlap(nid) {
            if (_isComposing) { return; } // IME 変換中はスキップ（compositionend でまとめて）
            var t = textElOf(nid);
            if (!t || t.getAttribute('contenteditable') !== 'true') { return; }
            var box = t.closest && t.closest('.mindmap-node-box');
            if (!box) { return; }
            var h = box.getBoundingClientRect().height;
            if (_editBaseH[nid] == null) { _editBaseH[nid] = h; return; }
            var dy = h - _editBaseH[nid];
            if (Math.abs(dy) <= 2) { return; }
            // DOM 再生成せず、下方ノードだけ translateY でずらす（caret/IME 無傷）
            shiftBelowNodes(nid, dy);
        }

        on(treeEl, 'compositionstart', function(e) {
            var t = e.target;
            if (t && t.classList && t.classList.contains('mindmap-node-text')) { _isComposing = true; }
        });
        on(treeEl, 'compositionend', function(e) {
            var t = e.target;
            if (!t || !t.classList || !t.classList.contains('mindmap-node-text')) { return; }
            _isComposing = false;
            // 変換確定後にまとめて調整（横幅 → 縦重なりの順。横伸びで高さも変わるため幅を先に）
            adjustEditWidth(t.getAttribute('data-node-id'));
            adjustEditOverlap(t.getAttribute('data-node-id'));
        });
        on(treeEl, 'input', function(e) {
            var t = e.target;
            if (!t || !t.classList || !t.classList.contains('mindmap-node-text')) { return; }
            if (t.getAttribute('contenteditable') !== 'true') { return; }
            if (e.isComposing || _isComposing) { return; } // IME 中は skip
            // FR-021-A7: 先に横幅を調整（横伸び or 上限到達で pre-wrap 遷移）→ その後に縦の重なり調整。
            adjustEditWidth(t.getAttribute('data-node-id'));
            adjustEditOverlap(t.getAttribute('data-node-id'));
        });

        // #B (TASK-33): blur/focusout で commit してテキスト消失を防ぐ（データ損失防止）。
        // commit キー(Enter/Tab/Esc)を押さずに別ノードクリック等でフォーカスが外れても、
        // 編集中テキストを model に保存する。commitEdit→rerender の再入を _committing でガード。
        var _committing = false;
        on(treeEl, 'focusout', function(e) {
            var t = e.target;
            if (!t || !t.classList || !t.classList.contains('mindmap-node-text')) { return; }
            if (t.getAttribute('contenteditable') !== 'true') { return; }
            if (_committing) { return; }
            if (_isComposing) { return; } // IME 変換中の blur は compositionend 後に任せる
            var nid = t.getAttribute('data-node-id');
            _committing = true;
            try { commitEdit(nid); } finally { _committing = false; }
        });

        function markGroupSelected(gid) {
            _selectedGroupId = gid;
            ctx.selectedGroupId = gid; // rerender で render に伝える
        }

        // 現在編集中の別ノードがあれば commit する（#B 保険: focusout が先行しない環境用）。
        function commitEditingExcept(exceptId) {
            if (_committing) { return; }
            var editing = _treeEl.querySelector('.mindmap-node-text[contenteditable="true"]');
            if (!editing) { return; }
            var eid = editing.getAttribute('data-node-id');
            if (eid === exceptId) { return; }
            _committing = true;
            try { commitEdit(eid); } finally { _committing = false; }
        }

        // --- クリックでフォーカス/選択 + ダブルクリックで編集 (TASK-08 選択) ---
        on(treeEl, 'click', function(e) {
            // クリック処理の前に、編集中の別ノードを commit（テキスト消失防止 #B）
            var clickedNodeEl = nodeElFromEvent(e);
            commitEditingExcept(clickedNodeEl ? clickedNodeEl.getAttribute('data-node-id') : null);
            // 折りたたみハンドル
            var handle = e.target.closest ? e.target.closest('.mindmap-collapse-handle') : null;
            if (handle) {
                var hid = handle.getAttribute('data-node-id');
                var hn = model.getNode(hid);
                if (hn) { pushUndo(); hn.collapsed = !hn.collapsed; scheduleSync(); rerender(); }
                return;
            }
            var nodeEl = nodeElFromEvent(e);
            if (!nodeEl) {
                // グループ枠クリック (G5): メンバー(+子孫)を選択、グループを選択状態に
                var groupG = e.target.closest ? e.target.closest('.mindmap-group') : null;
                if (groupG) {
                    var gid = groupG.getAttribute('data-group-id');
                    var grp = (settings.groups || []).filter(function(x) { return x.id === gid; })[0];
                    if (grp && selected && selected.clear) {
                        selected.clear();
                        for (var gi = 0; gi < grp.nodeIds.length; gi++) {
                            selected.add(grp.nodeIds[gi]);
                            var desc = model.getDescendantIds ? (model.getDescendantIds(grp.nodeIds[gi]) || []) : [];
                            for (var di = 0; di < desc.length; di++) { selected.add(desc[di]); }
                        }
                        markGroupSelected(gid);
                        rerender();
                    }
                    return;
                }
                return;
            }
            // ノードクリック → グループ選択解除
            markGroupSelected(null);
            var nid = nodeEl.getAttribute('data-node-id');
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                if (selected) {
                    if (selected.has(nid)) { selected.delete(nid); } else { selected.add(nid); }
                    rerender();
                }
            } else {
                if (selected && selected.clear) { selected.clear(); }
                focusNode(nid, false);
            }
        });

        on(treeEl, 'dblclick', function(e) {
            var nodeEl = nodeElFromEvent(e);
            if (!nodeEl) { return; }
            var nid = nodeEl.getAttribute('data-node-id');
            if (nid === '__title__') { focusNode(nid, true); return; } // title 編集
            var node = model.getNode(nid);
            if (node && node.isPage && ctx.openPage) { ctx.openPage(nid); return; }
            focusNode(nid, true);
        });

        // --- D&D reparent (TASK-08) ---
        // ノードを draggable にする (title 中心ノードは D&D 対象外)
        var nodeEls = treeEl.querySelectorAll('.mindmap-node:not(.mindmap-title-node)');
        for (var ni = 0; ni < nodeEls.length; ni++) {
            (function(nodeEl) {
                nodeEl.setAttribute('draggable', 'true');
                on(nodeEl, 'dragstart', function(e) {
                    _dragState = { nodeId: nodeEl.getAttribute('data-node-id') };
                    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; }
                });
                on(nodeEl, 'dragover', function(e) {
                    if (!_dragState) { return; }
                    var targetId = nodeEl.getAttribute('data-node-id');
                    // 循環防止: 自分自身 or 子孫へは不可
                    if (targetId === _dragState.nodeId || model.isDescendant(targetId, _dragState.nodeId)) {
                        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'none'; }
                        return;
                    }
                    e.preventDefault(); // drop 許可
                    if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
                    nodeEl.querySelector('.mindmap-node-box').classList.add('mm-drop-target');
                });
                on(nodeEl, 'dragleave', function() {
                    var box = nodeEl.querySelector('.mindmap-node-box');
                    if (box) { box.classList.remove('mm-drop-target'); }
                });
                on(nodeEl, 'drop', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var box = nodeEl.querySelector('.mindmap-node-box');
                    if (box) { box.classList.remove('mm-drop-target'); }
                    if (!_dragState) { return; }
                    var draggedId = _dragState.nodeId;
                    var targetId = nodeEl.getAttribute('data-node-id');
                    _dragState = null;
                    if (draggedId === targetId || model.isDescendant(targetId, draggedId)) { return; }
                    // ノードの上下 1/3 は兄弟順序、中央は子として reparent
                    var rect = nodeEl.getBoundingClientRect();
                    var frac = (e.clientY - rect.top) / (rect.height || 1);
                    var targetNode = model.getNode(targetId);
                    pushUndo();
                    if (frac < 0.33 || frac > 0.67) {
                        // 兄弟として (target の親の子に)
                        var parentId = targetNode.parentId;
                        var afterId = (frac > 0.67) ? targetId : prevSiblingId(model, targetId);
                        model.moveNode(draggedId, parentId, afterId);
                    } else {
                        // 子として (中央)
                        if (targetNode.collapsed) { targetNode.collapsed = false; }
                        model.moveNode(draggedId, targetId, null);
                    }
                    scheduleSync();
                    rerender();
                    // reparent 移動の最小追従 (TASK-50): 移動ノードが画面外なら最小パン。
                    ensureNodeVisible(draggedId);
                });
            })(nodeEls[ni]);
        }

        // 空白へ drop → Floating Topic 化 (TASK-08, J5)
        on(treeEl, 'dragover', function(e) {
            if (_dragState) { e.preventDefault(); }
        });
        on(treeEl, 'drop', function(e) {
            if (!_dragState) { return; }
            // ノード上の drop は上で stopPropagation 済み。ここに来たら空白 drop。
            var draggedId = _dragState.nodeId;
            _dragState = null;
            if (typeof MindmapModel === 'undefined' || !MindmapModel.detachToFloating) { return; }
            // treeEl 座標系 → SVG 内部座標への簡易変換 (viewport 無視の近似)
            var rect = treeEl.getBoundingClientRect();
            var x = e.clientX - rect.left;
            var y = e.clientY - rect.top;
            pushUndo();
            MindmapModel.detachToFloating(model, draggedId, x, y);
            scheduleSync();
            rerender();
            // floating 移動の最小追従 (TASK-50): 移動ノードが画面外なら最小パン。
            ensureNodeVisible(draggedId);
        });

        // ================= Wave 4-5: toolbar / zoom-pan / context menu / export =================

        var viewport = (runtime.viewport) || { scale: 1, translateX: 0, translateY: 0 };

        function applyViewport() {
            if (typeof MindmapRender !== 'undefined' && MindmapRender.updateViewport) {
                MindmapRender.updateViewport(viewport);
            }
        }
        function fitToScreen() {
            var b = runtime.layout && runtime.layout.bounds;
            if (!b) { return; }
            var rect = treeEl.getBoundingClientRect();
            var bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
            var scale = Math.min(rect.width / (bw + 240), rect.height / (bh + 240), 2);
            scale = Math.max(0.2, Math.min(4, scale || 1));
            viewport.scale = scale;
            viewport.translateX = 20 - b.minX * scale + 100 * scale;
            viewport.translateY = 20 - b.minY * scale + 100 * scale;
            applyViewport();
        }

        // --- toolbar ---
        var toolbar = treeEl.querySelector('.mindmap-toolbar');
        if (toolbar) {
            on(toolbar, 'change', function(e) {
                var t = e.target;
                if (t && t.getAttribute && t.getAttribute('data-mm-action') === 'layout') {
                    pushUndo();
                    settings.layout = t.value;
                    scheduleSync();
                    rerender();
                }
            });
            on(toolbar, 'click', function(e) {
                var t = e.target;
                var action = t && t.getAttribute && t.getAttribute('data-mm-action');
                if (!action) { return; }
                if (action === 'zoom-in') { viewport.scale = Math.min(4, viewport.scale * 1.2); applyViewport(); }
                else if (action === 'zoom-out') { viewport.scale = Math.max(0.2, viewport.scale / 1.2); applyViewport(); }
                else if (action === 'fit') { fitToScreen(); }
                else if (action === 'export') { doExport(t.getAttribute('data-mm-value')); }
            });
        }

        // --- zoom (Ctrl/Cmd + wheel) + pan (空白ドラッグ) ---
        on(treeEl, 'wheel', function(e) {
            if (!(e.ctrlKey || e.metaKey)) { return; }
            e.preventDefault();
            // #4: deltaY に比例した滑らかな係数。Mac トラックパッドのピンチは wheel を高頻度
            // 発火するため、固定 1.1 倍だと一気にズームしてしまう。exp(-deltaY*K) で連続的にし、
            // 1 イベントあたりの変化を 0.9〜1.1 にクランプして緩やかにする。
            var K = 0.0015;
            var factor = Math.exp(-e.deltaY * K);
            factor = Math.max(0.9, Math.min(1.1, factor));
            viewport.scale = Math.max(0.2, Math.min(4, viewport.scale * factor));
            applyViewport();
        }, { passive: false });

        var panning = null;
        on(treeEl, 'mousedown', function(e) {
            // 空白部 (ノードでない) のみパン
            if (nodeElFromEvent(e) || (e.target.closest && (e.target.closest('.mindmap-toolbar') || e.target.closest('.mindmap-minimap')))) { return; }
            panning = { x: e.clientX, y: e.clientY, tx: viewport.translateX, ty: viewport.translateY };
        });
        on(document, 'mousemove', function(e) {
            if (!panning) { return; }
            viewport.translateX = panning.tx + (e.clientX - panning.x);
            viewport.translateY = panning.ty + (e.clientY - panning.y);
            applyViewport();
        });
        on(document, 'mouseup', function() { panning = null; });

        // --- minimap click → move viewport ---
        var minimap = treeEl.querySelector('.mindmap-minimap');
        if (minimap) {
            on(minimap, 'click', function(e) {
                var b = runtime.layout && runtime.layout.bounds;
                if (!b) { return; }
                var r = minimap.getBoundingClientRect();
                var fx = (e.clientX - r.left) / (r.width || 1);
                var fy = (e.clientY - r.top) / (r.height || 1);
                var tx = b.minX + fx * (b.maxX - b.minX);
                var ty = b.minY + fy * (b.maxY - b.minY);
                var rect = treeEl.getBoundingClientRect();
                viewport.translateX = rect.width / 2 - tx * viewport.scale;
                viewport.translateY = rect.height / 2 - ty * viewport.scale;
                applyViewport();
            });
        }

        // --- context menu (style / group / relationship / floating) ---
        on(treeEl, 'contextmenu', function(e) {
            var nodeEl = nodeElFromEvent(e);
            e.preventDefault();
            closeContextMenu();
            var menu = buildContextMenu(nodeEl ? nodeEl.getAttribute('data-node-id') : null, e.clientX, e.clientY);
            document.body.appendChild(menu);
            if (typeof MindmapRender !== 'undefined' && MindmapRender._trackBodyEl) {
                MindmapRender._trackBodyEl(menu);
            }
            _contextMenuEl = menu;
        });
        // 外クリックで閉じる
        on(document, 'mousedown', function(e) {
            if (_contextMenuEl && !_contextMenuEl.contains(e.target)) { closeContextMenu(); }
        });

        function buildContextMenu(nodeId, x, y) {
            var menu = document.createElement('div');
            menu.className = 'mindmap-context-menu';
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            function item(label, fn) {
                var it = document.createElement('div');
                it.className = 'mindmap-ctx-item';
                it.textContent = label;
                it.addEventListener('click', function() { fn(); closeContextMenu(); });
                menu.appendChild(it);
            }
            var selectedIds = selected ? Array.from(selected) : [];
            if (nodeId) {
                // スタイル: 色プリセット
                var palette = ['#ffd1d1', '#ffe8c2', '#fff7b2', '#d7f5c2', '#c2e8ff', '#e0d1ff', '#ffd1f0', null];
                var colorRow = document.createElement('div');
                colorRow.className = 'mindmap-ctx-colors';
                palette.forEach(function(c) {
                    var sw = document.createElement('button');
                    sw.className = 'mindmap-ctx-swatch';
                    sw.style.background = c || 'transparent';
                    if (!c) { sw.textContent = '×'; sw.title = 'Clear'; }
                    sw.addEventListener('click', function() {
                        pushUndo();
                        var targets = selectedIds.length ? selectedIds : [nodeId];
                        targets.forEach(function(id) {
                            var n = model.getNode(id);
                            if (!n) { return; }
                            MindmapModel.ensureNodeMindmap(n).fill = c;
                            MindmapModel.normalizeNodeMindmap(n);
                        });
                        scheduleSync(); rerender(); closeContextMenu();
                    });
                    colorRow.appendChild(sw);
                });
                menu.appendChild(colorRow);
                // 枠形状
                ['rounded', 'rectangle', 'capsule', 'none'].forEach(function(shape) {
                    item('Shape: ' + shape, function() {
                        pushUndo();
                        var targets = selectedIds.length ? selectedIds : [nodeId];
                        targets.forEach(function(id) {
                            var n = model.getNode(id);
                            if (n) { MindmapModel.ensureNodeMindmap(n).shape = shape; }
                        });
                        scheduleSync(); rerender();
                    });
                });
                // グループ作成 (複数選択時)
                if (selectedIds.length >= 2) {
                    item('Create Group (' + selectedIds.length + ')', function() {
                        pushUndo();
                        MindmapModel.createGroup(settings, selectedIds, '', null);
                        scheduleSync(); rerender();
                    });
                }
                // 関連線 (選択が1つ + nodeId が別)
                if (selectedIds.length === 1 && selectedIds[0] !== nodeId) {
                    item('Link ' + selectedIds[0] + ' → ' + nodeId, function() {
                        pushUndo();
                        MindmapModel.createRelationship(settings, selectedIds[0], nodeId, '', null);
                        scheduleSync(); rerender();
                    });
                }
            } else {
                // 空白: グループ/関連線の全解除などは今は無し。フィット。
                item('Fit to screen', function() { fitToScreen(); });
            }
            return menu;
        }

        // --- export ---
        function doExport(format) {
            var suggested = (model.title || 'mindmap');
            if (format === 'opml' && typeof MindmapExport !== 'undefined') {
                host.exportMindmap('opml', MindmapExport.toOpml(model), suggested);
            } else if (format === 'markdown' && typeof MindmapExport !== 'undefined') {
                host.exportMindmap('markdown', MindmapExport.toMarkdown(model), suggested);
            } else if ((format === 'svg' || format === 'png') && typeof MindmapExport !== 'undefined') {
                var measure = function(nodeId) {
                    return (typeof MindmapRender !== 'undefined' && MindmapRender._estimateMeasure)
                        ? MindmapRender._estimateMeasure(model.nodes[nodeId], ctx.fontSize)
                        : { width: 120, height: 32 };
                };
                var exportSvg = MindmapExport.toExportSvg(model, runtime.layout, measure);
                if (format === 'svg') {
                    host.exportMindmap('svg', exportSvg, suggested);
                } else {
                    // PNG: 純 SVG を canvas 化 (foreignObject taint 回避)。失敗時は握って通知。
                    MindmapExport.toPng(exportSvg).then(function(dataUrl) {
                        host.exportMindmap('png', dataUrl, suggested);
                    }).catch(function() {
                        // taint 等で失敗 → SVG で代替を促す (ホストへは送らない)
                        if (typeof host.showInfoMessage === 'function') {
                            host.showInfoMessage('PNG export failed; use SVG export instead.');
                        }
                    });
                }
            }
        }
    }

    function prevSiblingId(model, nodeId) {
        var node = model.getNode(nodeId);
        var sibs = node.parentId ? model.getNode(node.parentId).children : model.rootIds;
        var idx = sibs.indexOf(nodeId);
        return idx > 0 ? sibs[idx - 1] : null;
    }

    function detach() {
        for (var i = 0; i < _handlers.length; i++) {
            var h = _handlers[i];
            h.el.removeEventListener(h.type, h.fn, h.opts);
        }
        _handlers = [];
        _treeEl = null;
        _dragState = null;
        closeContextMenu();
    }

    return {
        attach: attach,
        detach: detach,
        _prevSiblingId: prevSiblingId,
        // テスト用 (iteration 18 / TASK-52 の load-bearing): ensureNodeVisible の横マージンと
        // ハンドル張り出し加算を旧値 (16, 0) に戻して「右のギリギリ (ハンドルが画面端に接近)」を
        // 再現し、修正が効いていることを実証するためのフック。本番コードは既定 (32, 12) を使う。
        // 縦マージン (_ensureMarginY) はこのフックでは変えない (TC-V6 の march invariant を保つ)。
        _setEnsureVisibleParams: function(marginX, handlePad) {
            _ensureMarginX = (typeof marginX === 'number') ? marginX : 32;
            _ensureHandlePad = (typeof handlePad === 'number') ? handlePad : 12;
        },
        // テスト用 (iteration 19 / TASK-53 の load-bearing): ensureNodeVisible の発動トリガーを
        // 旧 'overflow' (はみ出し時のみ) に戻して「端密着ノードでパンせず隙間 0」を再現し、本番の
        // 'margin' (マージン込み収まりで判定) が効いていることを実証するためのフック。本番は 'margin'。
        _setEnsureVisibleTrigger: function(mode) {
            _ensureTrigger = (mode === 'overflow') ? 'overflow' : 'margin';
        },
        // テスト用 (iteration 21 / TASK-54 の load-bearing): ensureNodeVisible の可視端を実ウィンドウ
        // と交差させるか。false に戻すと treeEl 矩形をそのまま可視端に使う (旧挙動) → tree が実ウィンドウ
        // より外側にはみ出す状況で、window との隙間が marginX 未満になり red。本番は既定 true。
        _setEnsureVisibleClampToWindow: function(on) {
            _ensureClampToWindow = (on !== false);
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MindmapInteractions;
}
