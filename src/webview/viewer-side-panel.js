/**
 * viewer-side-panel.js — file viewer の sidepanel 面（.viewer-side-panel ペイン管理）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-05 / ADRL-0066 決定 2。
 * 既存 md の .side-panel とは別 DOM。md sidepanel との排他表示（design §5 — SYS-2 裁定）:
 *   - viewer open 時の md close: DOM class の直接除去はせず、md 側が既に持つ close ボタンの
 *     click を経由（md 側コードへの直接参照ゼロ — NFR-FV-02）
 *   - md open 時の viewer close: md 側 open 処理の冒頭に window.__viewerSidePanel?.close() の
 *     1 行 hook（NFR-FV-02 許容 ②）
 *
 * 再オープン③（FR-FV-14 / design §15）: md .side-panel との**自己完結ミラー**パリティ —
 *   ジオメトリ（styles.css:1658-1694 と同値: position:absolute / top=タブバー変数 / width 50% /
 *   min 288px / max 70%）・⤢ expand（.expanded = 95%）・左端幅 D&D リサイズ
 *   （outliner.js setupSidePanelResize:7932-7991 と同値の clamp + 必須テク 5 点）。
 *   md の css/js への参照はゼロ（値の複製のみ）。幅の永続化はしない（md との差分受容 —
 *   generator-log 記録済み）。ヘッダは自前実装を廃し buildToolbar（file-viewer.js）に統合
 *   （opts.onExpand / opts.onClose — 1 実装 3 マウントの原則）。
 *
 * 表示実体は window.__fileViewer（file-viewer.js — 1 実装 3 マウント）。
 */
(function () {
    'use strict';

    let panelEl = null;

    // スタイルは自己完結で注入（md 側 css ファイルを触らない — NFR-FV-02。
    // 値は md .side-panel（styles.css:1658-1694）/ .side-panel-resize-handle（:1697-1713）の複製）
    function ensureStyle() {
        if (document.getElementById('viewer-side-panel-style')) { return; }
        const style = document.createElement('style');
        style.id = 'viewer-side-panel-style';
        style.textContent = [
            // ジオメトリ: md .side-panel と同値（タブバー下端に収める = タブ被り解消・FR-FV-14-1）
            '.viewer-side-panel { display: none; position: absolute;',
            '  top: var(--notes-tab-bar-height, 0px); right: 0; bottom: 0;',
            '  width: 50%; min-width: min(288px, 95vw); max-width: 70%;',
            '  background: var(--fr-color-bg-panel, var(--vscode-editorWidget-background, #f7f7f5));',
            '  border-left: 1px solid var(--fr-color-border, var(--vscode-panel-border, #ddd));',
            '  box-shadow: -4px 0 12px rgba(0,0,0,0.08);',
            '  z-index: 90; flex-direction: column; }',
            '.viewer-side-panel.open { display: flex; }',
            // ⤢ expand（md .expanded :1692-1694 と同値）
            '.viewer-side-panel.expanded { width: 95%; max-width: 95%; }',
            // 左端リサイズハンドル（md .side-panel-resize-handle :1697-1713 と同値）
            '.viewer-side-panel-resize-handle { position: absolute; top: 0; left: -3px; width: 5px;',
            '  height: 100%; cursor: col-resize; z-index: 101; background: transparent; }',
            '.viewer-side-panel-resize-handle:hover, .viewer-side-panel-resize-handle.active {',
            '  background: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));',
            '  width: 2px; left: -1px; }',
            '.viewer-side-panel-mount { flex: 1 1 auto; position: relative; overflow: auto;',
            '  display: flex; flex-direction: column; min-height: 0; }',
            '.viewer-side-panel-mount .viewer-body { flex: 1 1 auto; position: relative; overflow: auto; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    /** 幅 D&D リサイズ（outliner.js setupSidePanelResize と同値の自己完結ミラー — 必須テク 5 点） */
    function setupResize(panel, handle) {
        let startX = 0;
        let startWidth = 0;
        const frames = () => panel.querySelectorAll('iframe');
        function clampWidth(w) {
            const maxW = (panel.parentElement || document.body).offsetWidth * 0.95;
            return Math.max(320, Math.min(w, maxW));
        }
        function onMove(e) {
            const w = clampWidth(startWidth + (startX - e.clientX));
            panel.style.width = w + 'px';
            panel.style.maxWidth = w + 'px';
        }
        function onUp() {
            // ③ 掃除は 4 点対（listener ×2 + body カーソル/選択 + iframe pointerEvents 復元）
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            handle.classList.remove('active');
            frames().forEach((f) => { f.style.pointerEvents = ''; });
        }
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            // ② resize 開始で最大化を解除（md と同挙動）
            panel.classList.remove('expanded');
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            handle.classList.add('active');
            // ① drag 中は viewer 内 iframe（html 面）に mousemove を食わせない（既知問題の回避）
            frames().forEach((f) => { f.style.pointerEvents = 'none'; });
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        // ⑤ window resize で表示中パネルを親 95% 内へ再クランプ（md の再クランプと同値。
        //    ResizeObserver は省略 — 差分受容・generator-log 記録）
        window.addEventListener('resize', () => {
            if (!panel.classList.contains('open') || panel.classList.contains('expanded')) { return; }
            const maxW = (panel.parentElement || document.body).offsetWidth * 0.95;
            if (panel.offsetWidth > maxW) {
                const w = Math.max(320, maxW);
                panel.style.width = w + 'px';
                panel.style.maxWidth = w + 'px';
            }
        });
    }

    function ensurePanel() {
        ensureStyle();
        if (panelEl && document.body.contains(panelEl)) { return panelEl; }
        panelEl = document.createElement('div');
        panelEl.className = 'viewer-side-panel';
        const handle = document.createElement('div');
        handle.className = 'viewer-side-panel-resize-handle';
        const mount = document.createElement('div');
        mount.className = 'viewer-side-panel-mount';
        panelEl.appendChild(handle);
        panelEl.appendChild(mount);
        // mount 先は md .side-panel と同じ containing block（notes 面 = .notes-main-wrapper。
        // outliner 単独面は従来どおり body — タブバー変数未定義 → top 0px で全高）
        const parent = document.querySelector('.notes-main-wrapper') || document.body;
        parent.appendChild(panelEl);
        setupResize(panelEl, handle);
        return panelEl;
    }

    /** ⤢ expand toggle（md .expanded と同値。inline 幅は expand 中は class が勝つよう退避） */
    function toggleExpand() {
        if (!panelEl) { return; }
        if (panelEl.classList.contains('expanded')) {
            panelEl.classList.remove('expanded');
            // 退避した手動リサイズ幅を復元
            if (panelEl.dataset.prevWidth) {
                panelEl.style.width = panelEl.dataset.prevWidth;
                panelEl.style.maxWidth = panelEl.dataset.prevWidth;
                delete panelEl.dataset.prevWidth;
            }
        } else {
            // inline width があると .expanded(95%) より優先されるため退避してクリア
            if (panelEl.style.width) {
                panelEl.dataset.prevWidth = panelEl.style.width;
                panelEl.style.width = '';
                panelEl.style.maxWidth = '';
            }
            panelEl.classList.add('expanded');
        }
    }

    /** viewer サイドペインを開く（md sidepanel が開いていれば排他で閉じる） */
    function open(kind, fileUri, fileName, filePath) {
        // 排他: md sidepanel を閉じる（DOM 直接ではなく既存 close ボタンの click で閉じる =
        // md 側コードへの直接参照を持たない）
        try {
            const mdCloseBtn = document.querySelector('.side-panel.open .side-panel-close');
            if (mdCloseBtn) { mdCloseBtn.click(); }
        } catch { /* md sidepanel 不在は正常 */ }

        const panel = ensurePanel();
        panel.classList.add('open');
        const mount = panel.querySelector('.viewer-side-panel-mount');
        if (window.__fileViewer && mount) {
            // ヘッダは buildToolbar（file-viewer.js）が兼ねる: filename 表示 + ⤢ 先頭 + × 最右端
            //（md 正典順 — FR-FV-14-2。1 実装 3 マウントの原則で sidepanel 専用ヘッダを持たない）
            window.__fileViewer.open(kind, fileUri, mount, filePath, {
                onExpand: toggleExpand,
                onClose: close,
            });
        }
    }

    /** viewer サイドペインを閉じる（md 側 open 冒頭 hook からも呼ばれる） */
    function close() {
        if (!panelEl) { return; }
        panelEl.classList.remove('open');
        // ④ close 時に最大化をリセット（md と同挙動 — 次回 open は非 expand から）
        panelEl.classList.remove('expanded');
        delete panelEl.dataset.prevWidth;
        const mount = panelEl.querySelector('.viewer-side-panel-mount');
        if (window.__fileViewer && mount) { window.__fileViewer.destroy(mount); }
    }

    function isOpen() {
        return !!(panelEl && panelEl.classList.contains('open'));
    }

    // Esc で閉じる（第 8 ラウンド③ — md sidepanel の precedent = editor.js:19625-19634 と同型。
    // lightbox が開いている間はそちらの ESC を優先）
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panelEl && panelEl.classList.contains('open')) {
            if (document.querySelector('.outliner-image-overlay')) { return; }
            close();
            e.preventDefault();
        }
    });

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
