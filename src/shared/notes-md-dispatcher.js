// notes-md-dispatcher.js — Notes 内 .md ファイル用のメインペイン dispatcher（ADR-008 / FR-LR-03）
//
// updateData (kind='md') を受けて outliner-container と markdown-container の表示を切替え、
// 必要なら EditorInstance を生成/再生成する。
// notesWebviewContent.ts の inline script から抽出（sprint 20260716 live-reload）。
// 本番 webview と standalone-notes build の両方から __initNotesMdDispatcher(deps) で初期化する
// （standalone build は body/script をハードコードするため、src 抽出だけでは反映されない。
//   build-standalone-notes.js にも明示 inline すること）。
//
// FR-LR-03: externalUpdate:true（NotesMdMainManager の外部変更検知）は EditorInstance を
// 破棄→再生成せず、standalone md と同じ標準 `update` メッセージ経路（editor.js の
// message.type === 'update' ハンドラ = in-place・カーソル保持・編集中は queue → idle 適用）に変換する。
(function() {
    'use strict';

    /**
     * @param deps {
     *   outlinerContainer: Element|null,
     *   markdownContainer: Element|null,
     *   bridge: object,            // md pane EditorInstance に渡す host bridge（本番: notesMarkdownHostBridge）
     *   deliverUpdate?: (msg) => void,
     *     // FR-LR-03 の in-place 配送。省略時は window.postMessage（本番: notesMarkdownHostBridge.onMessage の
     *     // 単一 window listener が拾って md pane EditorInstance の標準 update ハンドラに届く）。
     *     // standalone build は test bridge が onMessage を window 非経由（配列登録）に置き換えているため、
     *     // __hostMessageHandler 経由の配送関数を注入する。
     *   subscribe?: (handler) => void,
     *     // dispatcher 自身の受信経路。省略時は window 'message' listener（本番 = extension の
     *     // panel.webview.postMessage が window message event として届く）。
     *     // standalone build は __hostMessageHandler が handler 配列を直接呼ぶ方式（window event 非経由）
     *     // のため、__hostMessageHandlers.push を注入する。
     * }
     * @returns { getMdInstance, loadMarkdown }  // テスト用の内部照会 API
     */
    window.__initNotesMdDispatcher = function(deps) {
        var outlinerContainer = deps.outlinerContainer;
        var markdownContainer = deps.markdownContainer;
        var bridge = deps.bridge;
        var deliverUpdate = deps.deliverUpdate || function(msg) { window.postMessage(msg, '*'); };
        var subscribe = deps.subscribe || function(handler) {
            window.addEventListener('message', function(e) { handler(e.data); });
        };
        // 初期 markdown pane の HTML テンプレートを保持。EditorInstance を再生成する際は
        // この HTML を毎回 markdownContainer に書き戻して .editor を新規生成し、
        // 旧インスタンスが addEventListener('paste'/...) で残した DOM listener を確実に切る。
        // (destroy() は instances 配列から外すだけで DOM listener は剥がさないため、
        //  同じ .editor を使い回すと paste handler が累積し cmd+v で N 枚画像が貼られる)
        var markdownPaneTemplate = markdownContainer ? markdownContainer.innerHTML : '';
        var mdInstance = null;

        function showOutliner() {
            if (window.__viewerDispatcher) window.__viewerDispatcher.hideViewer();   // viewer と排他（FR-FV-06 / sprint 20260815-075428）
            if (window.__folderViewDispatcher) window.__folderViewDispatcher.hideFolderView();   // folder view と排他（FR-FLV-10 / sprint 20260817-053313）
            if (markdownContainer) markdownContainer.style.display = 'none';
            if (outlinerContainer) outlinerContainer.style.display = '';
        }
        function showMarkdown() {
            if (window.__viewerDispatcher) window.__viewerDispatcher.hideViewer();   // viewer と排他（同上）
            if (window.__folderViewDispatcher) window.__folderViewDispatcher.hideFolderView();   // folder view と排他（同上）
            if (outlinerContainer) outlinerContainer.style.display = 'none';
            if (markdownContainer) markdownContainer.style.display = '';
        }

        function loadMarkdown(text, filePath, documentBaseUri) {
            showMarkdown();
            // 既存の EditorInstance があれば破棄して作り直す
            if (mdInstance) {
                try { mdInstance.destroy(); } catch(e) { console.error(e); }
                mdInstance = null;
            }
            if (!markdownContainer) return;
            // .editor 等の子要素を初期テンプレートで置換し、旧 instance が残した
            // paste / keydown 等の listener を完全に剥がす。
            markdownContainer.innerHTML = markdownPaneTemplate;
            if (bridge) {
                bridge.filePath = filePath || null;
            }
            mdInstance = new window.EditorInstance(
                markdownContainer,
                bridge,
                {
                    initialContent: text || '',
                    filePath: filePath || null,
                    documentBaseUri: documentBaseUri || '',
                    sidebarHidden: true,
                }
            );
            // sprint 20260723-233506: タブ復帰の main scroll 復元（§3b・ADRL-TABS-SCROLL）。
            // EditorInstance は innerHTML を同期設定するので、この末尾（同一同期タスク）で scrollTop を
            // 代入すれば paint 前に確定＝チラつき無し。
            if (window.__notesTabManager && typeof window.__notesTabManager.consumePendingMainRestore === 'function') {
                window.__notesTabManager.consumePendingMainRestore();
            }
        }

        subscribe(function(msg) {
            if (!msg || msg.type !== 'updateData') return;
            if (msg.kind === 'md') {
                // FR-LR-03: 外部編集（AI CLI 等）の反映は in-place。
                // 破棄→再生成だとカーソル・スクロール・編集中テキストが消えるため、
                // standalone md と同じ標準 `update` 経路（in-place・編集中は queue）へ変換する。
                if (msg.externalUpdate) {
                    var bridgeFp = bridge && bridge.filePath;
                    if (mdInstance && bridgeFp && msg.filePath && bridgeFp === msg.filePath) {
                        // 本番: bridge.onMessage は「単一 window listener + 最新 handler」
                        // （notes-host-bridge.js の v0.207.81 fix）なので、既定の deliverUpdate =
                        // window.postMessage で md pane EditorInstance の標準 update ハンドラに届く。
                        // outliner.js の top-level switch に case 'update' は無く、sidepanel の
                        // SidePanelHostBridge は _messageHandler 直結（window listener でない）ため誤配しない。
                        deliverUpdate({ type: 'update', content: msg.markdown || '' });
                    }
                    // mdInstance 無し / filePath 不一致（stale・outliner 表示中）→ drop
                    // （外部編集をトリガに md pane を勝手に開かない）
                    return;
                }
                loadMarkdown(msg.markdown || '', msg.filePath || null, msg.documentBaseUri || '');
            } else {
                // outliner data — markdown container は隠して outliner を見せる
                if (mdInstance) {
                    try { mdInstance.destroy(); } catch(err) { console.error(err); }
                    mdInstance = null;
                }
                showOutliner();
            }
        });

        // 初期状態は outliner 表示 (initData は .out を前提に渡されている)
        showOutliner();

        // sprint 20260802-075012: PDF export の対象解決に Notes アクティブタブ md instance を権威登録。
        // getter は closure の mdInstance / bridge.filePath を都度参照する。
        // md ペイン表示中のみ mdInstance が非 null → getEditorEl が .editor を返す。
        // outliner タブ表示中は mdInstance=null → null を返す（.out は PDF 対象外・stale 回避）。
        if (typeof window !== 'undefined') {
            window.__pdfExportSources = window.__pdfExportSources || {};
            window.__pdfExportSources.mainMd = {
                getEditorEl: function() {
                    if (!mdInstance || !markdownContainer) { return null; }
                    // md ペインが表示中（display!=='none'）かつ .editor が存在するときのみ返す
                    if (markdownContainer.style && markdownContainer.style.display === 'none') { return null; }
                    return markdownContainer.querySelector('.editor');
                },
                getFilePath: function() {
                    return (bridge && bridge.filePath) || null;
                }
            };
        }

        return {
            getMdInstance: function() { return mdInstance; },
            loadMarkdown: loadMarkdown,
        };
    };
})();
