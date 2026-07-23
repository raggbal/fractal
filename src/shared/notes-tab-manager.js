// notes-tab-manager.js — Notes webview 内マルチタブ（sprint 20260723-233506-notes-webview-tabs）
//
// unload/load 方式（ADRL-TABS-UNLOAD-LOAD）: アクティブタブのみ実 DOM を持ち、非アクティブタブは
// 軽量 Tab State（filePath/scrollTop/outlinerView/sidePanel）のみ保持する。切替時に flush（webview 二段）→
// 既存 openFile 経路で load → 受信ハンドラ末尾で scroll を同期復元（ADRL-TABS-SCROLL）。
//
// 純 DOM + bridge 呼び出しのみ（vscode 非依存 = Electron 前方互換 / testable）。
// 本番 notesWebviewContent.ts と standalone build 両方から window.__initNotesTabManager(deps) で初期化。
// （standalone build は body/script をハードコードするため build-standalone-notes.js にも 4 点登録が要る）
(function() {
    'use strict';

    var _tabSeq = 0;
    function nextTabId() { _tabSeq += 1; return 'tab-' + _tabSeq; }

    /**
     * @param deps {
     *   tabBarEl,                // #notesTabBar（container。中に .notes-tab-bar-scroll と ＋ ボタン）
     *   getActiveMainScrollEl,   // () => アクティブ main の scroll owner（kind で .outliner-scroll-content / .editor-wrapper）
     *   bridge,                  // { openFile(fp), flushActive(), restoreSidePanel(fp), closeSidePanel() }
     *   flushActiveWebview,      // () => void（webview 側強制 flush。syncToHostImmediate/notifyChangeImmediate。§3a）
     *   captureOutlinerView,     // () => {focusedNodeId,currentScope}|null（アクティブが outliner のとき）
     *   applyOutlinerView,       // (view) => void（load 後・focusNode は preventScroll）
     *   captureSidePanel,        // () => {open,filePath,scrollTop}（現アクティブのサイドパネル状態）
     *   getSidePanelScrollEl,    // () => サイドパネルの scroll owner|null
     * }
     * @returns { openInNewTab, activateTab, closeTab, openInActiveTab, getTabs, getActiveId,
     *            consumePendingMainRestore, consumePendingSidePanelRestore, updateActiveSidePanel }
     */
    window.__initNotesTabManager = function(deps) {
        deps = deps || {};
        var tabBarEl = deps.tabBarEl || null;
        var getActiveMainScrollEl = deps.getActiveMainScrollEl || function() { return null; };
        var bridge = deps.bridge || {};
        var flushActiveWebview = deps.flushActiveWebview || function() {};
        var captureOutlinerView = deps.captureOutlinerView || function() { return null; };
        var applyOutlinerView = deps.applyOutlinerView || function() {};
        var captureSidePanel = deps.captureSidePanel || function() { return { open: false, filePath: null, scrollTop: 0 }; };
        var getSidePanelScrollEl = deps.getSidePanelScrollEl || function() { return null; };

        var tabs = [];              // TabState[]（順序 = タブバー並び）
        var activeId = null;
        // load は非同期（bridge.openFile → host → updateData message）なので、受信ハンドラ末尾で
        // 復元する内容をここに予約しておく（§3b）。scroll 代入はハンドラ側が consume で取り出して同期実行。
        var pendingMainRestore = null;   // { mainScrollTop, outlinerView, kind }
        var pendingSidePanelRestore = null; // { filePath, scrollTop }

        function findIndex(id) {
            for (var i = 0; i < tabs.length; i++) { if (tabs[i].id === id) return i; }
            return -1;
        }
        function getActive() { var i = findIndex(activeId); return i >= 0 ? tabs[i] : null; }

        function makeTabState(filePath, kind, title) {
            return {
                id: nextTabId(),
                filePath: filePath,
                kind: kind || (/\.out$/i.test(filePath || '') ? 'out' : 'md'),
                title: title || basenameNoExt(filePath),
                mainScrollTop: 0,
                outlinerView: null,
                sidePanel: { open: false, filePath: null, scrollTop: 0 },
            };
        }
        function basenameNoExt(fp) {
            if (!fp) return 'Untitled';
            var base = String(fp).replace(/^.*[\/\\]/, '');
            return base.replace(/\.(md|out)$/i, '');
        }

        // ── capture: 現アクティブタブの画面状態を Tab State に退避 ──
        function captureActive() {
            var cur = getActive();
            if (!cur) return;
            var el = getActiveMainScrollEl();
            cur.mainScrollTop = (el && typeof el.scrollTop === 'number') ? el.scrollTop : cur.mainScrollTop;
            if (cur.kind === 'out') {
                cur.outlinerView = captureOutlinerView() || cur.outlinerView;
            }
            cur.sidePanel = captureSidePanel() || cur.sidePanel;
        }

        // ── flush 二段（NFR-TAB-03・§3a）: unload/destroy の前に必ず ──
        function flushBeforeUnload() {
            // 1. webview 側強制 flush（debounce 未送信を即送信。destroy の前に同期実行）
            try { flushActiveWebview(); } catch (e) { /* ignore */ }
            // 2. host 側 flushSave
            if (typeof bridge.flushActive === 'function') { try { bridge.flushActive(); } catch (e) {} }
        }

        // ── load: host に openFile を依頼（既存経路）。scroll 復元は受信ハンドラ末尾で consume ──
        function loadTab(tab) {
            pendingMainRestore = { mainScrollTop: tab.mainScrollTop, outlinerView: tab.outlinerView, kind: tab.kind };
            // サイドパネル復元/クローズの予約
            if (tab.sidePanel && tab.sidePanel.open && tab.sidePanel.filePath) {
                pendingSidePanelRestore = { filePath: tab.sidePanel.filePath, scrollTop: tab.sidePanel.scrollTop || 0 };
                if (typeof bridge.restoreSidePanel === 'function') bridge.restoreSidePanel(tab.sidePanel.filePath);
            } else {
                pendingSidePanelRestore = null;
                if (typeof bridge.closeSidePanel === 'function') bridge.closeSidePanel();
            }
            if (typeof bridge.openFile === 'function') bridge.openFile(tab.filePath);
        }

        // ── tab bar 描画（tabs>=2 で表示・FR-TAB-01/05） ──
        function renderTabBar() {
            if (!tabBarEl) return;
            var show = tabs.length >= 2;
            tabBarEl.style.display = show ? 'flex' : 'none';
            if (!show) { return; }
            var scrollEl = tabBarEl.querySelector('.notes-tab-bar-scroll');
            if (!scrollEl) {
                scrollEl = document.createElement('div');
                scrollEl.className = 'notes-tab-bar-scroll';
                tabBarEl.insertBefore(scrollEl, tabBarEl.firstChild);
            }
            scrollEl.innerHTML = '';
            for (var i = 0; i < tabs.length; i++) {
                (function(tab) {
                    var el = document.createElement('div');
                    el.className = 'notes-tab';
                    el.dataset.tabId = tab.id;
                    el.dataset.id = tab.filePath || '';
                    if (tab.id === activeId) el.dataset.active = 'true';
                    var titleEl = document.createElement('span');
                    titleEl.className = 'notes-tab-title';
                    titleEl.textContent = tab.title || basenameNoExt(tab.filePath);
                    titleEl.title = tab.filePath || '';
                    el.appendChild(titleEl);
                    var closeBtn = document.createElement('button');
                    closeBtn.className = 'notes-tab-close';
                    closeBtn.type = 'button';
                    closeBtn.innerHTML = '&times;';
                    closeBtn.setAttribute('aria-label', 'Close tab');
                    el.appendChild(closeBtn);
                    titleEl.addEventListener('click', function() { activateTab(tab.id); });
                    el.addEventListener('click', function(ev) {
                        if (ev.target === closeBtn) return;
                        activateTab(tab.id);
                    });
                    closeBtn.addEventListener('click', function(ev) {
                        ev.stopPropagation();
                        closeTab(tab.id);
                    });
                    scrollEl.appendChild(el);
                })(tabs[i]);
            }
            // ＋ ボタン（scroll の外・右端）
            var addBtn = tabBarEl.querySelector('.notes-tab-add');
            if (!addBtn) {
                addBtn = document.createElement('button');
                addBtn.className = 'notes-tab-add';
                addBtn.type = 'button';
                addBtn.innerHTML = '+';
                addBtn.setAttribute('aria-label', 'New tab (duplicate current)');
                addBtn.addEventListener('click', function() {
                    var cur = getActive();
                    if (cur) openInNewTab(cur.filePath, cur.kind);
                });
                tabBarEl.appendChild(addBtn);
            }
            // アクティブタブを可視域へ（FR-TAB-05）
            var activeEl = scrollEl.querySelector('.notes-tab[data-active="true"]');
            if (activeEl && typeof activeEl.scrollIntoView === 'function') {
                try { activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) {}
            }
        }

        // ── 公開: 新タブを開く（FR-TAB-02） ──
        function openInNewTab(filePath, kind, title) {
            if (!filePath) return null;
            // 現アクティブの状態を退避 + flush（unload 前）
            if (getActive()) { captureActive(); flushBeforeUnload(); }
            var tab = makeTabState(filePath, kind, title);
            tabs.push(tab);
            activeId = tab.id;
            loadTab(tab);
            renderTabBar();
            return tab.id;
        }

        // ── 公開: タブ切替（FR-TAB-03） ──
        function activateTab(id) {
            if (id === activeId) return;
            var idx = findIndex(id);
            if (idx < 0) return;
            captureActive();          // 1. 現アクティブを退避
            flushBeforeUnload();      // 2. flush 二段
            activeId = id;            // 3. load 予約 → openFile（updateData は非同期で返る）
            loadTab(tabs[idx]);
            renderTabBar();
            // ★ scroll 復元は activateTab では行わない（DOM 未到達）。受信ハンドラ末尾で consume（§3b）。
        }

        // ── 公開: タブを閉じる（FR-TAB-04・最後の 1 タブは閉じない） ──
        function closeTab(id) {
            if (tabs.length <= 1) return; // 最後の 1 タブは閉じない
            var idx = findIndex(id);
            if (idx < 0) return;
            var wasActive = (id === activeId);
            if (wasActive) { captureActive(); flushBeforeUnload(); }
            else {
                // 非アクティブを閉じる: そのタブ自体に未送信編集は無い（アクティブのみ DOM）。flush 不要。
            }
            tabs.splice(idx, 1);
            if (wasActive) {
                // 隣（右優先・無ければ左）をアクティブ化
                var nextIdx = idx < tabs.length ? idx : tabs.length - 1;
                activeId = tabs[nextIdx].id;
                loadTab(tabs[nextIdx]);
            }
            renderTabBar();
        }

        // ── 公開: 現タブで開く（Recent・FR-TAB-07。新タブを増やさない） ──
        function openInActiveTab(filePath, kind) {
            if (!filePath) return;
            var cur = getActive();
            if (!cur) { openInNewTab(filePath, kind); return; }
            // 現アクティブを flush（内容差し替え前）
            flushBeforeUnload();
            cur.filePath = filePath;
            cur.kind = kind || (/\.out$/i.test(filePath) ? 'out' : 'md');
            cur.title = basenameNoExt(filePath);
            cur.mainScrollTop = 0;         // 別ファイルに切替＝スクロールは先頭
            cur.outlinerView = null;
            // サイドパネルは現タブのものを維持（Recent はメインペインのみ差し替え）
            pendingMainRestore = { mainScrollTop: 0, outlinerView: null, kind: cur.kind };
            pendingSidePanelRestore = null;
            if (typeof bridge.openFile === 'function') bridge.openFile(filePath);
            renderTabBar();
        }

        // ── 受信ハンドラが末尾で呼ぶ: main scroll/outlinerView を同期復元して pending を消費（§3b） ──
        function consumePendingMainRestore() {
            var p = pendingMainRestore;
            pendingMainRestore = null;
            if (!p) return;
            if (p.kind === 'out' && p.outlinerView) {
                try { applyOutlinerView(p.outlinerView); } catch (e) {}
            }
            var el = getActiveMainScrollEl();
            if (el && typeof p.mainScrollTop === 'number') {
                el.scrollTop = p.mainScrollTop;   // 同期代入（paint 前確定・ADRL-SCROLL）
            }
        }

        // ── サイドパネル描画完了時に呼ぶ: scroll 同期復元（§5） ──
        function consumePendingSidePanelRestore() {
            var p = pendingSidePanelRestore;
            pendingSidePanelRestore = null;
            if (!p) return;
            var el = getSidePanelScrollEl();
            if (el && typeof p.scrollTop === 'number') { el.scrollTop = p.scrollTop; }
        }

        // ── node クリック等で現アクティブタブのサイドパネル状態を追随（§5） ──
        function updateActiveSidePanel(state) {
            var cur = getActive();
            if (cur) cur.sidePanel = state || cur.sidePanel;
        }

        // ── TASK-12（バグ修正）: メインペインの実ファイルが tab manager 非経由で変わった時
        //   （左ファイルパネル click / 検索ジャンプ等 → bridge.openFile → updateData）、アクティブタブの
        //   filePath/kind/title を実ファイルと同期する。これが無いと tab.filePath が stale のままになり、
        //   タブ再アクティブ化で loadTab→bridge.openFile(stale) が「1つ前のページ」を再オープンする。
        //   ★ bridge.openFile は呼ばない（re-entrancy 回避）。同一 filePath は no-op（scroll/view 温存）。
        function syncActiveFile(filePath, kind) {
            var cur = getActive();
            if (!cur || !filePath) return;
            if (cur.filePath === filePath) return;   // 同一ファイルの再 render → scroll/outlinerView を温存
            cur.filePath = filePath;
            cur.kind = kind || (/\.out$/i.test(filePath) ? 'out' : 'md');
            cur.title = basenameNoExt(filePath);
            cur.mainScrollTop = 0;                    // 別ファイルに変わった → scroll は先頭
            cur.outlinerView = null;
            renderTabBar();
        }

        // ── 初期化: 初期タブ（開いているファイル）を登録 ──
        function initFirstTab(filePath, kind, title) {
            _tabSeq = 0;
            tabs = [];
            var tab = makeTabState(filePath, kind, title);
            tabs.push(tab);
            activeId = tab.id;
            renderTabBar(); // 1 タブなので display:none
            return tab.id;
        }

        var api = {
            openInNewTab: openInNewTab,
            activateTab: activateTab,
            closeTab: closeTab,
            openInActiveTab: openInActiveTab,
            initFirstTab: initFirstTab,
            getTabs: function() { return tabs.slice(); },
            getActiveId: function() { return activeId; },
            consumePendingMainRestore: consumePendingMainRestore,
            consumePendingSidePanelRestore: consumePendingSidePanelRestore,
            updateActiveSidePanel: updateActiveSidePanel,
            syncActiveFile: syncActiveFile,
        };
        window.__notesTabManager = api;
        return api;
    };
})();
