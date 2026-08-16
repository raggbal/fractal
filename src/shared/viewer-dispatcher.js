/**
 * viewer-dispatcher.js — file viewer の note 面（Notes メインペインの viewer 表示切替）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-06 / ADRL-0066 決定 3。
 * notes-md-dispatcher の第 3 状態ではなく**並列の新設モジュール**（md 分離制約）。
 * 双方向連携（design §6 — SYS-1 裁定）:
 *   viewer→他: showViewer が outliner/md コンテナを隠す
 *   他→viewer: notes-md-dispatcher の showOutliner/showMarkdown 冒頭の
 *              window.__viewerDispatcher?.hideViewer() hook（md 側 1 行 × 2）
 * stale 対策: hideViewer は viewer DOM を破棄する（display:none だけにしない —
 * notes-md-dispatcher の「innerHTML 非クリア」既知性質を踏襲しない。TC-FV-22 counterfactual）。
 *
 * 表示実体は window.__fileViewer（file-viewer.js — 1 実装 3 マウント）。
 */
(function () {
    'use strict';

    let viewerContainer = null;

    function ensureContainer() {
        if (viewerContainer && document.body.contains(viewerContainer)) { return viewerContainer; }
        viewerContainer = document.createElement('div');
        viewerContainer.id = 'viewerContainer';
        viewerContainer.style.cssText = 'display:none; position:absolute; inset:0; z-index:50; ' +
            'background: var(--vscode-editor-background, #fff); flex-direction: column;';
        // メインペイン内（outliner/markdown コンテナの兄弟）にマウントする — body 直下だと
        // タブバー・ファイルパネルまで覆う全画面被りになる（実機検収 2026-08-15）。
        // .notes-main-wrapper は position:relative（notes-body-html.js:215）なので inset:0 が
        // メインペインにだけ効く。wrapper が無いハーネス等では body に縮退
        const wrapper = document.querySelector('.notes-main-wrapper')
            || document.querySelector('.outliner-container')?.parentElement
            || document.body;
        wrapper.appendChild(viewerContainer);
        return viewerContainer;
    }

    function setPaneDisplay(id, value) {
        const el = document.getElementById(id);
        if (el) { el.style.display = value; }
    }

    // file panel 折り畳み時の再表示ボタン（≡）を viewer ツールバーにも置く。
    // 既存の #notesPanelToggleBtn は outliner pane 内にあり viewer 表示中は隠れるため、
    // panel を閉じると二度と開けなくなる（実機検収 2026-08-15）。クリック処理は
    // notes-file-panel.js の document delegation（.notes-panel-toggle-btn を closest 判定）に相乗り
    function ensureToggleStyle() {
        if (document.getElementById('viewer-panel-toggle-style')) { return; }
        const style = document.createElement('style');
        style.id = 'viewer-panel-toggle-style';
        style.textContent = [
            '.viewer-toolbar .notes-panel-toggle-btn { display: none; background: transparent; border: none;',
            '  cursor: pointer; padding: 4px 5px; font-size: 15px; opacity: 0.7; order: -1; }',
            '.viewer-toolbar .notes-panel-toggle-btn:hover { opacity: 1; }',
            '.notes-file-panel.collapsed ~ .notes-main-wrapper .viewer-toolbar .notes-panel-toggle-btn { display: flex; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    /** note 面に viewer を表示（outliner/md を隠す） */
    function showViewer(kind, fileUri, fileName, filePath, opts) {
        // md sidepanel（.side-panel.open = z-index:100）が開いていると viewer（z-index:50）に被さるため
        // 排他で閉じる。DOM 直参照でなく既存 close ボタンの click = md 側コードへの直接依存を持たない
        // 弱結合（viewer-side-panel.js:72-79 の既存 precedent と同型）。全 note 面 viewer 表示経路
        // （In-App file link / file panel クリック / 検索ヒット）が showViewer を通るのでここ 1 箇所で効く。
        try {
            const mdCloseBtn = document.querySelector('.side-panel.open .side-panel-close');
            if (mdCloseBtn) { mdCloseBtn.click(); }
        } catch { /* md sidepanel 不在は正常 */ }
        const container = ensureContainer();
        ensureToggleStyle();
        // 表示前に必ず再構築（stale 表示の構造的防止 — 前回の内容を持ち越さない）
        container.textContent = '';
        setPaneDisplay('outlinerContainer', 'none');
        setPaneDisplay('markdownContainer', 'none');
        container.style.display = 'flex';
        if (window.__fileViewer) {
            // FR-FV-13: opts.inTab（file タブ経由の表示 — loadTab が渡す）を buildToolbar の
            // 面別出し分けへ伝搬。overlay（showNoteViewer message / 既存呼び出し）は opts なし
            window.__fileViewer.open(kind, fileUri, container, filePath, { inTab: !!(opts && opts.inTab) });
            // open は toolbar を同期構築する（最初の await より前）— ≡ ボタンを先頭に追加
            const bar = container.querySelector('.viewer-toolbar');
            if (bar && !bar.querySelector('.notes-panel-toggle-btn')) {
                const toggle = document.createElement('button');
                toggle.className = 'notes-panel-toggle-btn';
                toggle.title = 'Show file panel (Cmd+\\)';
                toggle.innerHTML = '&#9776;';
                bar.insertBefore(toggle, bar.firstChild);
            }
        }
    }

    /** viewer を隠し DOM を破棄（既存タブ切替の hook からも呼ばれる — 復帰は呼び出し側の責務） */
    function hideViewer() {
        if (!viewerContainer) { return; }
        viewerContainer.style.display = 'none';
        // stale 対策の核: iframe/canvas を DOM から破棄（counterfactual: 破棄しないと TC-FV-22 RED）
        if (window.__fileViewer) { window.__fileViewer.destroy(viewerContainer); }
        viewerContainer.textContent = '';
    }

    function isViewerShown() {
        return !!(viewerContainer && viewerContainer.style.display !== 'none');
    }

    window.__viewerDispatcher = { showViewer, hideViewer, isViewerShown };

    // host からの message（notesEditorProvider の sink 分岐が送る）
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'showNoteViewer') {
            showViewer(msg.kind, msg.fileUri, msg.fileName, msg.filePath);
        } else if (msg && msg.type === 'hideNoteViewer') {
            hideViewer();
        }
    });
})();
