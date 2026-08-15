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
        document.body.appendChild(viewerContainer);
        return viewerContainer;
    }

    function setPaneDisplay(id, value) {
        const el = document.getElementById(id);
        if (el) { el.style.display = value; }
    }

    /** note 面に viewer を表示（outliner/md を隠す） */
    function showViewer(kind, fileUri, fileName, filePath) {
        const container = ensureContainer();
        // 表示前に必ず再構築（stale 表示の構造的防止 — 前回の内容を持ち越さない）
        container.textContent = '';
        setPaneDisplay('outlinerContainer', 'none');
        setPaneDisplay('markdownContainer', 'none');
        container.style.display = 'flex';
        if (window.__fileViewer) {
            window.__fileViewer.open(kind, fileUri, container, filePath);
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
