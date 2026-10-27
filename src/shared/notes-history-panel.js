// notes-history-panel.js — note sidepanel 下部の「最近開いたファイル履歴」パネル（FR-HP-01/04/05/06/07）
//
// 描画（最新順リスト）・開閉トグル（collapsed 小バー）・縦 D&D resize・クリック開き分け（kind 別）を担う。
// spec 20261027-1142-recent-history-nav（D3-D5）: Back / Forward（Notes パネル最上段の右端のボタン）も担う。
//   現在位置（cursor = history 配列の index。0 = 先頭 = 最新）はこの webview のメモリにだけ持つ。
//   Back / Forward は entry の pane で開き直し、host には noHistory で頼む（移動は Recent に記録しない）。
// notesWebviewContent.ts（本番）と build-standalone-notes.js（standalone）の両方に inline される。
// 永続化は host（outline.note）が担い、本 JS は DOM 操作 + bridge 呼び出しのみ。
(function() {
    'use strict';

    var ICON = {
        'note-md': '<svg class="side-panel-history-item-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><text x="8" y="19" font-size="8" font-weight="700" stroke="none" fill="currentColor">M</text></svg>',
        'out': '<svg class="side-panel-history-item-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
        // ★reopen 2026-07-23: page-md kind 廃止（page md も note-md で記録）。legacy page-md entry は note-md icon にフォールバック。
        // FR-RCT（sprint 20260822-051129）: folder link（🔗 相当の link アイコン）/ file（📎 相当のクリップ）
        'folder': '<svg class="side-panel-history-item-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
        'file': '<svg class="side-panel-history-item-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    };

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * @param deps {
     *   panelEl, listEl, toggleEl, resizeHandleEl,  // DOM 要素
     *   backEl, forwardEl,                          // D3: Back / Forward ボタン（無ければ Back / Forward なし）
     *   bridge,                                     // { openFile(id, opts?), historyOpenFile(absPath, opts?),
     *                                               //   historyOpenInSidePanel(absPath),
     *                                               //   saveHistoryPanelCollapsed(bool), saveHistoryPanelHeight(px) }
     *                                               //   opts = { noHistory: true }（Back / Forward のときだけ）
     *   initialHistory, initialHeight, initialCollapsed,
     * }
     */
    window.__initNotesHistoryPanel = function(deps) {
        var panelEl = deps.panelEl;
        var listEl = deps.listEl;
        var toggleEl = deps.toggleEl;
        var resizeHandleEl = deps.resizeHandleEl;
        var bridge = deps.bridge || {};
        if (!panelEl || !listEl) return null;

        // 初期状態
        if (typeof deps.initialHeight === 'number' && deps.initialHeight > 0) {
            panelEl.style.height = deps.initialHeight + 'px';
        }
        if (deps.initialCollapsed) {
            panelEl.classList.add('collapsed');
        }

        var backEl = deps.backEl || null;
        var forwardEl = deps.forwardEl || null;

        // ── D3: 現在位置（webview メモリのみ） ──
        // items = 最後に描画した history。cursor = 現在位置の index（0 = 最新）。
        // lastSig = 先頭 entry と件数の署名。新しく開いた（host が記録した）ときだけ変わる → cursor を先頭に戻す。
        // Back / Forward の移動は記録されないので、その後に届く再描画では署名が変わらず cursor を保つ。
        var items = [];
        var cursor = 0;
        var lastSig = null;

        function sigOf(list) {
            var top = list[0];
            return list.length + '|' + (top ? (top.kind + '|' + top.id + '|' + top.ts + '|' + (top.pane || '')) : '');
        }

        // D5: step 方向（+1 = Back = 古い方 / -1 = Forward = 新しい方）で開ける entry の index。無ければ -1。
        // 開けない entry（host が missing を付けた = 消えたファイル等）は飛ばす。
        function findTarget(step) {
            for (var i = cursor + step; i >= 0 && i < items.length; i += step) {
                if (items[i] && !items[i].missing) return i;
            }
            return -1;
        }

        // D5: 端（開ける entry が無い方向）は押せない。現在位置を Recent で強調表示
        function updateNav() {
            if (backEl) backEl.disabled = findTarget(1) < 0;
            if (forwardEl) forwardEl.disabled = findTarget(-1) < 0;
            var els = listEl.querySelectorAll('.side-panel-history-item');
            for (var i = 0; i < els.length; i++) {
                var cur = i === cursor;
                els[i].classList.toggle('is-current', cur);
                if (cur) { els[i].setAttribute('aria-current', 'true'); } else { els[i].removeAttribute('aria-current'); }
            }
        }

        // D4: entry の pane で開き直す（side → sidepanel、main → メイン）。noHistory = 記録しない（D3）
        function openForNav(entry) {
            var noRec = { noHistory: true };
            if (entry.pane === 'side' && (entry.kind === 'note-md' || entry.kind === 'file')) {
                if (typeof bridge.historyOpenInSidePanel === 'function') bridge.historyOpenInSidePanel(entry.id);
                return;
            }
            if (entry.kind === 'folder') {
                // 一覧 click と同じ webview 内 dispatcher（opts.noHistory は host への folderViewOpened に載る）
                if (window.__folderViewDispatcher && typeof window.__folderViewDispatcher.showFolderView === 'function') {
                    window.__folderViewDispatcher.showFolderView(entry.id, entry.title || 'Folder', noRec);
                }
                return;
            }
            if (entry.kind === 'file') {
                if (typeof bridge.historyOpenFile === 'function') bridge.historyOpenFile(entry.id, noRec);
                return;
            }
            if (typeof bridge.openFile === 'function') bridge.openFile(entry.absPath || entry.id, noRec);
        }

        function navigate(step) {
            var target = findTarget(step);
            if (target < 0) return false;
            cursor = target;
            updateNav();
            openForNav(items[target]);
            return true;
        }
        function back() { return navigate(1); }
        function forward() { return navigate(-1); }
        if (backEl) backEl.addEventListener('click', function(e) { e.preventDefault(); back(); });
        if (forwardEl) forwardEl.addEventListener('click', function(e) { e.preventDefault(); forward(); });

        // ── 描画（最新順・FR-HP-04） ──
        function render(history) {
            listEl.innerHTML = '';
            items = Array.isArray(history) ? history : [];
            var sig = sigOf(items);
            // D3: 新しく開いた（先頭が変わった）→ 位置を先頭に戻す。先の履歴は消さない（host は積むだけ）
            if (lastSig !== null && sig !== lastSig) cursor = 0;
            lastSig = sig;
            // 50 件トリム等で cursor が範囲外になったら末尾に寄せる
            if (cursor > items.length - 1) cursor = Math.max(0, items.length - 1);
            for (var i = 0; i < items.length; i++) {
                (function(entry) {
                    var el = document.createElement('div');
                    el.className = 'side-panel-history-item';
                    el.dataset.kind = entry.kind;
                    el.dataset.id = entry.id;
                    el.dataset.pane = entry.pane === 'side' ? 'side' : 'main';
                    if (entry.missing) el.classList.add('is-missing');
                    el.innerHTML = (ICON[entry.kind] || ICON['note-md'])
                        + '<span class="side-panel-history-item-title">' + escapeHtml(entry.title || entry.id) + '</span>';
                    el.title = entry.id;
                    el.addEventListener('click', function() {
                        // D4: 一覧から選んだときは pane によらず常にメイン（従来どおり・記録する = 新しく開いた扱い）。
                        // FR-RCT: kind 分岐（folder = webview 内 dispatcher / file = host clamp 付き open）。
                        if (entry.kind === 'folder') {
                            if (window.__folderViewDispatcher && typeof window.__folderViewDispatcher.showFolderView === 'function') {
                                window.__folderViewDispatcher.showFolderView(entry.id, entry.title || 'Folder');
                            }
                            return;
                        }
                        if (entry.kind === 'file') {
                            if (typeof bridge.historyOpenFile === 'function') bridge.historyOpenFile(entry.id);
                            return;
                        }
                        // ★reopen 2026-07-23: FR-HP-05 全メインペイン統一。md/out は openFile（絶対パス）で
                        //   メインペインに開く（legacy page-md entry は absPath 優先 — HISTORY_MAX で流れる）。
                        if (typeof bridge.openFile === 'function') bridge.openFile(entry.absPath || entry.id);
                    });
                    listEl.appendChild(el);
                })(items[i]);
            }
            updateNav();
        }
        render(deps.initialHistory);

        // ── 開閉トグル（FR-HP-06） ──
        if (toggleEl) {
            toggleEl.addEventListener('click', function() {
                var collapsed = panelEl.classList.toggle('collapsed');
                if (typeof bridge.saveHistoryPanelCollapsed === 'function') bridge.saveHistoryPanelCollapsed(collapsed);
            });
        }

        // ── 縦 D&D resize（FR-HP-07・横 setupSidePanelResize を縦に転用） ──
        if (resizeHandleEl) {
            var resizing = false, startY = 0, startH = 0;
            resizeHandleEl.addEventListener('mousedown', function(e) {
                if (panelEl.classList.contains('collapsed')) return;
                e.preventDefault();
                e.stopPropagation();
                resizing = true;
                startY = e.clientY;
                startH = panelEl.offsetHeight;
                document.body.style.cursor = 'ns-resize';
                document.body.style.userSelect = 'none';
                // ドラッグ中は sidepanel の iframe/editor がマウスを吸わないように
                var container = panelEl.parentElement;
                var iframes = container ? container.querySelectorAll('iframe') : [];
                iframes.forEach(function(f) { f.style.pointerEvents = 'none'; });
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onEnd);
            });
            function onMove(e) {
                if (!resizing) return;
                // 上へドラッグ = history を高く（clientY が小さくなる → newH 増）
                var newH = startH + (startY - e.clientY);
                var container = panelEl.parentElement;
                var maxH = container ? container.offsetHeight * 0.6 : 600;
                newH = Math.max(80, Math.min(newH, maxH));
                panelEl.style.height = newH + 'px';
            }
            function onEnd() {
                if (!resizing) return;
                resizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                var container = panelEl.parentElement;
                var iframes = container ? container.querySelectorAll('iframe') : [];
                iframes.forEach(function(f) { f.style.pointerEvents = ''; });
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                if (typeof bridge.saveHistoryPanelHeight === 'function') bridge.saveHistoryPanelHeight(panelEl.offsetHeight);
            }
        }

        // structure 更新（notesFileListChanged）で history が来たら再描画するための外部 API
        return { render: render, back: back, forward: forward, getCursor: function() { return cursor; } };
    };
})();
