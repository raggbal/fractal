/**
 * viewer-side-panel.js — file viewer の sidepanel 面（.viewer-side-panel ペイン管理）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-05 / ADRL-0066 決定 2。
 * 既存 md の .side-panel とは別 DOM。md sidepanel との排他表示（design §5 — SYS-2 裁定）:
 *   - viewer open 時の md close: host 経由でなく「md 側が既に webview 内に持つ close 経路」を
 *     呼ばず、DOM class の除去もしない — 代わりに host へ closeSidePanelRequest を送らず、
 *     md 側 open 冒頭の hook（window.__viewerSidePanel?.close()）と対称の
 *     window.__mdSidePanelClose?.()（md 側が任意で公開する optional hook）を試み、
 *     無ければ .side-panel の close ボタン相当の既存 message 経路に落とす。
 *     ※ md 側ファイルへの参照は optional（`?.`）のみ — import/直接参照ゼロ（NFR-FV-02）
 *   - md open 時の viewer close: md 側 open 処理の冒頭に window.__viewerSidePanel?.close() の
 *     1 行 hook（NFR-FV-02 許容 ②）
 *
 * 表示実体は window.__fileViewer（file-viewer.js — 1 実装 3 マウント）。
 */
(function () {
    'use strict';

    let panelEl = null;

    // スタイルは自己完結で注入（md 側 css ファイルを触らない — NFR-FV-02）
    function ensureStyle() {
        if (document.getElementById('viewer-side-panel-style')) { return; }
        const style = document.createElement('style');
        style.id = 'viewer-side-panel-style';
        style.textContent = [
            '.viewer-side-panel { display: none; position: fixed; top: 0; right: 0; bottom: 0; width: 45%;',
            '  background: var(--vscode-editor-background, #fff); border-left: 1px solid var(--vscode-panel-border, #ccc);',
            '  z-index: 90; flex-direction: column; }',
            '.viewer-side-panel.open { display: flex; }',
            '.viewer-side-panel-header { flex: 0 0 auto; display: flex; justify-content: space-between;',
            '  align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #ccc); }',
            '.viewer-side-panel-mount { flex: 1 1 auto; position: relative; overflow: auto;',
            '  display: flex; flex-direction: column; }',
            '.viewer-side-panel-mount .viewer-body { flex: 1 1 auto; position: relative; overflow: auto; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    function ensurePanel() {
        ensureStyle();
        if (panelEl && document.body.contains(panelEl)) { return panelEl; }
        panelEl = document.createElement('div');
        panelEl.className = 'viewer-side-panel';
        const header = document.createElement('div');
        header.className = 'viewer-side-panel-header';
        const title = document.createElement('span');
        title.className = 'viewer-side-panel-title';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'viewer-side-panel-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', close);
        header.appendChild(title);
        header.appendChild(closeBtn);
        const mount = document.createElement('div');
        mount.className = 'viewer-side-panel-mount';
        panelEl.appendChild(header);
        panelEl.appendChild(mount);
        document.body.appendChild(panelEl);
        return panelEl;
    }

    /** viewer サイドペインを開く（md sidepanel が開いていれば排他で閉じる） */
    function open(kind, fileUri, fileName, filePath) {
        // 排他: md sidepanel を閉じる（optional hook — md 側が公開していれば。無ければ DOM 直接では
        // なく既存 close ボタンの click で閉じる = md 側コードへの直接参照を持たない）
        try {
            const mdCloseBtn = document.querySelector('.side-panel.open .side-panel-close');
            if (mdCloseBtn) { mdCloseBtn.click(); }
        } catch { /* md sidepanel 不在は正常 */ }

        const panel = ensurePanel();
        panel.classList.add('open');
        const title = panel.querySelector('.viewer-side-panel-title');
        if (title) { title.textContent = fileName || ''; }
        const mount = panel.querySelector('.viewer-side-panel-mount');
        if (window.__fileViewer && mount) {
            window.__fileViewer.open(kind, fileUri, mount, filePath);
        }
    }

    /** viewer サイドペインを閉じる（md 側 open 冒頭 hook からも呼ばれる） */
    function close() {
        if (!panelEl) { return; }
        panelEl.classList.remove('open');
        const mount = panelEl.querySelector('.viewer-side-panel-mount');
        if (window.__fileViewer && mount) { window.__fileViewer.destroy(mount); }
    }

    function isOpen() {
        return !!(panelEl && panelEl.classList.contains('open'));
    }

    window.__viewerSidePanel = { open, close, isOpen };

    // host からの message（sidePanelManager.tryOpenViewerPanel が送る）
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'openViewerPanel') {
            open(msg.kind, msg.fileUri, msg.filePath ? msg.filePath.split('/').pop() : '', msg.filePath);
        } else if (msg && msg.type === 'closeViewerPanel') {
            close();
        }
    });
})();
