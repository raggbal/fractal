/**
 * folder-view-dispatcher.js — folder link の note 面（Notes メインペインのフォルダビュー表示切替）
 *
 * sprint 20260817-053313-notetree-local-folder-view / FR-FLV-10（viewer-dispatcher.js の 1:1 並列モジュール）。
 * notes-md-dispatcher の第 4 状態ではなく**並列の新設モジュール**（NFR-FLV-07 実装分離）。
 *
 * 排他マトリクス（design/system/folder-view.md §2 — 全セル）:
 *   showFolderView → outliner/md コンテナ hide + viewer hide + md sidepanel close + viewer sidepanel close
 *   showOutliner / showMarkdown / showViewer → hideFolderView（各 dispatcher 冒頭の 1 行 hook）
 * stale 対策: hideFolderView は DOM を破棄する（viewer-dispatcher の hideViewer 同型）。
 *
 * 表示実体は window.__folderView（notes-folder-view.js）。
 */
(function () {
    'use strict';

    let folderViewContainer = null;
    // showFolderView が隠す直前の pane display 値（one-shot: show で保存 → hide で復元 + null 化。
    // 連続 show では最初の保存を保持 — 2 回目は既に 'none' なので上書きすると復元先が失われる）
    let savedPaneDisplay = null;
    // FR-FLV-33: 表示中の folder link id（host の watcher dispose 契機 = folderViewClosed 通知に使う）
    let shownLinkId = null;

    function notifyClosed(linkId) {
        try {
            if (linkId && window.notesHostBridge && typeof window.notesHostBridge.folderViewClosed === 'function') {
                window.notesHostBridge.folderViewClosed(linkId);
            }
        } catch (e) { /* bridge 不在（standalone 等）は正常 */ }
    }

    function ensureContainer() {
        if (folderViewContainer && document.body.contains(folderViewContainer)) { return folderViewContainer; }
        folderViewContainer = document.createElement('div');
        folderViewContainer.id = 'folderViewContainer';
        // inset:0 はタブ strip ごと覆う既知罠（TC-FV-73）— top はタブバー変数
        // NFR-FLV-08（再オープン①）: 背景は outliner/md 面と同一トークン（#fff 直書き fallback 廃止 —
        // 「folder view だけ白い」の実体はここだった）
        folderViewContainer.style.cssText = 'display:none; position:absolute; ' +
            'top: var(--notes-tab-bar-height, 0px); left:0; right:0; bottom:0; z-index:50; ' +
            'background: var(--outliner-bg); flex-direction: column;';
        const wrapper = document.querySelector('.notes-main-wrapper')
            || (document.querySelector('.outliner-container') && document.querySelector('.outliner-container').parentElement)
            || document.body;
        wrapper.appendChild(folderViewContainer);
        return folderViewContainer;
    }

    // 本番 markup（notesWebviewContent.ts:238/281）は id を持たず class のみ —
    // id 参照だけだと本番で silent no-op になる（viewer-dispatcher の同型に既存バグあり）
    function paneEl(id, cls) {
        return document.getElementById(id) || document.querySelector(cls);
    }

    function setPaneDisplay(id, cls, value) {
        const el = paneEl(id, cls);
        if (el) { el.style.display = value; }
    }

    /** note 面にフォルダビューを表示（outliner/md/viewer を隠し sidepanel 2 種を閉じる） */
    function showFolderView(folderLinkId, title, opts) {
        // ④ md sidepanel（z-index:100）排他 close — 既存 close ボタン click の弱結合（viewer-dispatcher 同型）
        try {
            const mdCloseBtn = document.querySelector('.side-panel.open .side-panel-close');
            if (mdCloseBtn) { mdCloseBtn.click(); }
        } catch (e) { /* md sidepanel 不在は正常 */ }
        // ⑤ viewer sidepanel 排他 close
        try {
            if (window.__viewerSidePanel && typeof window.__viewerSidePanel.close === 'function') {
                window.__viewerSidePanel.close();
            }
        } catch (e) { /* viewer sidepanel 不在は正常 */ }
        // ③ note 面 viewer 排他
        try {
            if (window.__viewerDispatcher && typeof window.__viewerDispatcher.hideViewer === 'function') {
                window.__viewerDispatcher.hideViewer();
            }
        } catch (e) { /* viewer dispatcher 不在は正常 */ }
        // FR-FLV-33: 別 link への切替は旧 link の監視を止める（host へ closed 通知）
        if (shownLinkId && shownLinkId !== folderLinkId) { notifyClosed(shownLinkId); }
        shownLinkId = folderLinkId;
        const container = ensureContainer();
        // 表示前に必ず再構築（stale 防止 — 前回の内容を持ち越さない）
        container.textContent = '';
        // ①② outliner / md 面 hide（隠す前の値を保存 — hideFolderView で復元）
        if (savedPaneDisplay === null) {
            const o = paneEl('outlinerContainer', '.outliner-container');
            const m = paneEl('markdownContainer', '.markdown-container');
            savedPaneDisplay = {
                outliner: o ? o.style.display : null,
                markdown: m ? m.style.display : null,
            };
        }
        setPaneDisplay('outlinerContainer', '.outliner-container', 'none');
        setPaneDisplay('markdownContainer', '.markdown-container', 'none');
        container.style.display = 'flex';
        if (window.__folderView) {
            window.__folderView.open(folderLinkId, title, container, { inTab: !!(opts && opts.inTab) });
        }
        // FR-FLV-25（folder-view.md §4 通常 click）: タブを増やさずアクティブタブを folder に差し替える
        //（kind='folder' 明示 = syncActiveFile の推定式に流さない）。loadTab 経由（opts.inTab）は
        // タブ状態を loadTab 側が管理済みのためスキップ（re-entrancy 回避）
        if (!(opts && opts.inTab) && window.__notesTabManager
            && typeof window.__notesTabManager.syncActiveFile === 'function') {
            window.__notesTabManager.syncActiveFile(folderLinkId, 'folder', title);
        }
    }

    /** フォルダビューを隠し DOM を破棄（showOutliner/showMarkdown/showViewer の hook から呼ばれる） */
    function hideFolderView() {
        if (!folderViewContainer) { return; }
        // FR-FLV-33: fv を隠す = 監視停止（host が watcher を dispose。再表示時の root list で再 ensure される）
        if (shownLinkId) { notifyClosed(shownLinkId); shownLinkId = null; }
        folderViewContainer.style.display = 'none';
        if (window.__folderView) { window.__folderView.destroy(); }
        folderViewContainer.textContent = '';
        // showFolderView が実際に display:none にした分を保存値へ復元（viewer は覆うだけで隠さないため、
        // 復元しないと viewer 遷移 → hideNoteViewer で両ペイン不可視のブランクになる）。
        // showOutliner/showMarkdown の hook 経由では直後に各 dispatcher が正しい値を上書きする
        if (savedPaneDisplay) {
            if (savedPaneDisplay.outliner !== null) {
                setPaneDisplay('outlinerContainer', '.outliner-container', savedPaneDisplay.outliner);
            }
            if (savedPaneDisplay.markdown !== null) {
                setPaneDisplay('markdownContainer', '.markdown-container', savedPaneDisplay.markdown);
            }
            savedPaneDisplay = null;
        }
    }

    function isFolderViewShown() {
        return !!(folderViewContainer && folderViewContainer.style.display !== 'none');
    }

    window.__folderViewDispatcher = { showFolderView, hideFolderView, isFolderViewShown };

    // host からの message（relink 成功時の showFolderView 指示 — notes-message-handler folderLinkRelink）
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'showFolderView' && msg.folderLinkId) {
            showFolderView(msg.folderLinkId, msg.title || 'Folder');
        }
    });

    // FR-FLV-27（再オープン①）: esc で sidepanel（md / viewer）を閉じたらフォルダビューへフォーカス復帰。
    // dispatcher 内完結（outliner.js = NFR-FLV-07 変更 0 / editor.js = W4 1 点制約 — どちらにも触れない方式）。
    // viewer-side-panel.js 第 8 ラウンド③④⑤の縮約同型: 閉じたことの確認 + stole 判定 + preventScroll。
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !isFolderViewShown()) { return; }
        // esc 時点で sidepanel（md .side-panel.open / viewer .viewer-side-panel.open）が開いていた場合のみ対象
        const wasOpen = !!document.querySelector('.side-panel.open, .viewer-side-panel.open');
        if (!wasOpen) { return; }
        // sidepanel 側の esc ハンドラが close を終えるのを待ってから確認（.open 除去は同期・保険で 2 段待ち）
        setTimeout(() => {
            if (!isFolderViewShown()) { return; }
            const stillOpen = !!document.querySelector('.side-panel.open, .viewer-side-panel.open');
            if (stillOpen) { return; } // 閉じていない（esc がモーダル等に消費された）
            // stole 判定: ユーザーが既に他所へフォーカスしていたら奪い返さない
            const active = document.activeElement;
            const stole = active && active !== document.body &&
                !(active.closest && (active.closest('.side-panel') || active.closest('.viewer-side-panel')));
            if (stole) { return; }
            const tree = folderViewContainer && folderViewContainer.querySelector('.fv-tree');
            if (tree && typeof tree.focus === 'function') {
                try { tree.focus({ preventScroll: true }); } catch (err) { tree.focus(); }
            }
        }, 150);
    }, true);
})();
