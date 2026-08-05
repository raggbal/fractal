/**
 * Notes VSCode HostBridge — acquireVsCodeApi() をラップし、
 * outliner.js が使う window.outlinerHostBridge と
 * notes-file-panel.js が使う window.notesHostBridge の両方を提供する。
 *
 * notesWebviewContent.ts により outliner.js の前に注入される。
 * 共通メソッドは sidepanel-bridge-methods.js の __createSidePanelBridgeMethods() から取得。
 */
(function() {
    var api = acquireVsCodeApi();
    var postFn = function(msg) { api.postMessage(msg); };
    window.__pdfExportPost = postFn;   // pdf-export-webview.js が pdfHtmlResult 返信に使う

    // ファイル切替カウンター: stale syncData を防止
    var currentFileChangeId = window.__initialFileChangeId || 0;
    window.addEventListener('message', function(e) {
        if (e.data && e.data.type === 'updateData' && e.data.fileChangeId !== undefined) {
            currentFileChangeId = e.data.fileChangeId;
        }
    });

    // 共通メソッド（サイドパネル・画像・リンク・フォーカス等）
    var shared = window.__createSidePanelBridgeMethods(postFn);

    // ── outliner.js 用ブリッジ (既存 outliner-host-bridge.js と同一インターフェース) ──
    window.outlinerHostBridge = Object.assign(shared, {
        // TASK-17: ツリー md → sidepanel md D&D（SidePanelHostBridge.linkMdAsSubpage の _mainHost 経由）
        linkMdAsSubpageForSidePanel: function(filePath, mdFileId, sidePanelFilePath) {
            api.postMessage({ type: 'linkMdAsSubpage', filePath: filePath, mdFileId: mdFileId || null, sidePanelFilePath: sidePanelFilePath });
        },
        // データ同期
        syncData: function(jsonString) {
            api.postMessage({ type: 'syncData', content: jsonString, fileChangeId: currentFileChangeId });
        },

        // ページ操作
        makePage: function(nodeId, pageId, title) {
            api.postMessage({ type: 'makePage', nodeId: nodeId, pageId: pageId, title: title });
        },
        openPage: function(nodeId, pageId) {
            api.postMessage({ type: 'openPage', nodeId: nodeId, pageId: pageId });
        },
        removePage: function(nodeId, pageId) {
            api.postMessage({ type: 'removePage', nodeId: nodeId, pageId: pageId });
        },
        handlePageAssetsCross: function(pageId, newPageId, clipboardPlainText, targetNodeId, nodeImages, isCut) {
            api.postMessage({ type: 'handlePageAssetsCross', pageId: pageId, newPageId: newPageId, clipboardPlainText: clipboardPlainText, targetNodeId: targetNodeId, nodeImages: nodeImages || [], isCut: !!isCut });
        },
        copyImagesCross: function(images, clipboardPlainText, targetNodeId, isCut) {
            api.postMessage({ type: 'copyImagesCross', images: images, clipboardPlainText: clipboardPlainText, targetNodeId: targetNodeId, isCut: !!isCut });
        },
        saveOutlinerClipboard: function(plainText, isCut, nodes) {
            api.postMessage({ type: 'saveOutlinerClipboard', plainText: plainText, isCut: isCut, nodes: nodes });
        },
        setPageDir: function() {
            api.postMessage({ type: 'setPageDir' });
        },

        requestInsertLink: function(text) {
            api.postMessage({ type: 'insertLink', text: text });
        },

        // サイドパネル (ページ表示用)
        openPageInSidePanel: function(nodeId, pageId) {
            api.postMessage({ type: 'openPageInSidePanel', nodeId: nodeId, pageId: pageId });
        },

        // ページ管理 (サイドパネル内EditorInstanceから呼ばれる — outlinerでは未使用)
        createPageAtPath: function() { /* no-op in outliner */ },
        createPageAuto: function() { /* no-op in outliner */ },
        updatePageH1: function() { /* no-op in outliner */ },

        // .mdファイルインポート（ファイルピッカー）
        importMdFilesDialog: function(targetNodeId) {
            api.postMessage({ type: 'importMdFilesDialog', targetNodeId: targetNodeId });
        },

        // 任意ファイルインポート（ファイルピッカー）
        importFilesDialog: function(targetNodeId) {
            api.postMessage({ type: 'importFilesDialog', targetNodeId: targetNodeId });
        },

        // D&D ファイルインポート
        dropFilesImport: function(items, targetNodeId, position) {
            api.postMessage({ type: 'dropFilesImport', items: items, targetNodeId: targetNodeId, position: position });
        },
        // v12 拡張: VSCode Explorer D&D
        dropVscodeUrisImport: function(uris, targetNodeId, position) {
            api.postMessage({ type: 'dropVscodeUrisImport', uris: uris, targetNodeId: targetNodeId, position: position });
        },
        notifyDropFolderRejected: function(folders) {
            api.postMessage({ type: 'notifyDropFolderRejected', folders: folders });
        },
        notifyDropFileTooLarge: function(fileName) {
            api.postMessage({ type: 'notifyDropFileTooLarge', fileName: fileName });
        },
        // v0.207.96: Streaming D&D for files > 50MB.
        dropStreamBegin: function(payload) {
            api.postMessage(Object.assign({ type: 'dropStreamBegin' }, payload));
        },
        dropStreamChunk: function(payload) {
            api.postMessage(Object.assign({ type: 'dropStreamChunk' }, payload));
        },
        dropStreamFileEnd: function(payload) {
            api.postMessage(Object.assign({ type: 'dropStreamFileEnd' }, payload));
        },
        dropStreamSessionEnd: function(payload) {
            api.postMessage(Object.assign({ type: 'dropStreamSessionEnd' }, payload));
        },
        dropStreamCancel: function(payload) {
            api.postMessage(Object.assign({ type: 'dropStreamCancel' }, payload));
        },

        // ファイル添付操作
        openAttachedFile: function(nodeId) {
            api.postMessage({ type: 'openAttachedFile', nodeId: nodeId });
        },
        // FR-FR-01/02: Finder (OS ファイラ) で選択状態表示
        revealAttachedFileInOS: function(nodeId) {
            api.postMessage({ type: 'revealAttachedFileInOS', nodeId: nodeId });
        },
        revealPageInOS: function(nodeId) {
            api.postMessage({ type: 'revealPageInOS', nodeId: nodeId });
        },
        handleFileAssetCross: function(filePath, clipboardPlainText, nodeId, isCut) {
            api.postMessage({ type: 'handleFileAssetCross', filePath: filePath, clipboardPlainText: clipboardPlainText, nodeId: nodeId, isCut: !!isCut });
        },

        // Outlinerノード画像操作
        saveOutlinerImage: function(nodeId, dataUrl, fileName) {
            api.postMessage({ type: 'saveOutlinerImage', nodeId: nodeId, dataUrl: dataUrl, fileName: fileName });
        },
        setOutlinerImageDir: function() { /* no-op in notes — auto-managed */ },
        getOutlinerImageDir: function() { /* no-op in notes — auto-managed */ },

        // Daily Notes ナビゲーション（outliner.jsから呼び出し）
        // .outファイル操作
        openInTextEditor: function() {
            api.postMessage({ type: 'openInTextEditor' });
        },
        copyFilePath: function() {
            api.postMessage({ type: 'copyFilePath' });
        },
        copyPagePaths: function(pageIds) {
            api.postMessage({ type: 'copyPagePaths', pageIds: pageIds });
        },
        // FR-OL-COPYPATH-1: file 添付ノードの絶対 path を OS clipboard にコピー (Notes mode)
        copyAttachedFilePath: function(nodeId) {
            api.postMessage({ type: 'copyAttachedFilePath', nodeId: nodeId });
        },
        // v0.207.48: 複数ノードの添付ファイル絶対 path を改行区切りでコピー (Notes mode)
        copyAttachedFilePaths: function(nodeIds) {
            api.postMessage({ type: 'copyAttachedFilePaths', nodeIds: nodeIds });
        },
        // llms.txt 風 subtree コピー (MD pages)
        copyLlmsTxtMdTree: function(tree) {
            api.postMessage({ type: 'copyLlmsTxtMdTree', tree: tree });
        },
        // llms.txt 風 subtree コピー (file attachments)
        copyLlmsTxtFileTree: function(tree) {
            api.postMessage({ type: 'copyLlmsTxtFileTree', tree: tree });
        },
        // llms.txt 風 subtree コピー (MD pages + file attachments)
        copyLlmsTxtBothTree: function(tree) {
            api.postMessage({ type: 'copyLlmsTxtBothTree', tree: tree });
        },

        // Note-level sidepanel md width / TOC width 永続化 (outline.note 共通)
        notesSaveSidePanelWidth: function(width) {
            api.postMessage({ type: 'notesSetSidePanelWidth', width: width });
        },
        notesSaveSidePanelOutlineWidth: function(width) {
            api.postMessage({ type: 'notesSetSidePanelOutlineWidth', width: width });
        },

        // タスクモード: 完了タスクを Daily Notes へ archive (今日の date node 配下に追加)
        archiveTasks: function(subtrees) {
            flushOutlinerSync();
            api.postMessage({ type: 'notesArchiveTasks', subtrees: subtrees });
        },

        showInfoMessage: function(text) {
            api.postMessage({ type: 'showInfoMessage', text: text });
        },

        postDailyNotes: function(type, dayOffset, currentDate) {
            if (window.Outliner && window.Outliner.flushSync) {
                window.Outliner.flushSync();
            }
            if (type === 'notesNavigateToDate') {
                api.postMessage({ type: 'notesNavigateToDate', targetDate: dayOffset }); // dayOffset = date string
            } else {
                api.postMessage({ type: type, dayOffset: dayOffset || 0, currentDate: currentDate || null });
            }
        }
    });

    // ── Outliner即時同期ヘルパー ──
    // ファイル切替前に未保存のoutlinerデータを即座にsyncする
    function flushOutlinerSync() {
        if (window.Outliner && window.Outliner.flushSync) {
            window.Outliner.flushSync();
        }
    }

    // ── ADR-008: Notes メインペイン Markdown 用ブリッジ ──
    // editor.js (EditorInstance) と互換のインターフェース。
    // 既存の outliner / sidepanel 経路には触らない。
    // 画像/ファイル保存先は _notes_md/{images,files}/ で共通管理。
    window.notesMarkdownHostBridge = Object.assign({}, shared, {
        // Markdown 編集の auto-save: outline.note 構造内の現在の .md ファイルへ書き込み
        syncContent: function(markdown) {
            api.postMessage({
                type: 'notesSaveCurrentMd',
                content: markdown,
                fileChangeId: currentFileChangeId,
            });
        },
        save: function() {
            api.postMessage({ type: 'save' });
        },
        reportEditingState: function(editing) {
            api.postMessage({ type: 'editingStateChanged', editing: editing });
        },
        requestInsertLink: function(text) {
            api.postMessage({ type: 'insertLink', text: text });
        },
        openInTextEditor: function() {
            api.postMessage({ type: 'openInTextEditor' });
        },
        copyFilePath: function() {
            api.postMessage({ type: 'copyFilePath' });
        },
        // FR-PDF-08: Notes メインペイン md の PDF export。既定 targetHint 'main-md'（shared factory の
        // 'sidepanel-md' を override）。sidepanel header 経路は host.exportPdf('sidepanel-md') で明示上書き。
        exportPdf: function(targetHint) {
            api.postMessage({ type: 'exportPdf', targetHint: targetHint || 'main-md' });
        },
        // v0.207.86: cmd+/ → Add Page を Notes 内 .md でも有効化。
        // standalone editor の createPageAuto と同じ semantics で
        // <_notes_md>/pages/<unique>.md を作成して相対 path を返す。
        createPageAtPath: function() { /* no-op (legacy action panel flow) */ },
        createPageAuto: function() {
            api.postMessage({
                type: 'notesMdCreatePageAuto',
                filePath: window.notesMarkdownHostBridge.filePath || '',
            });
        },
        updatePageH1: function(relativePath, h1Text) {
            api.postMessage({
                type: 'notesMdUpdatePageH1',
                filePath: window.notesMarkdownHostBridge.filePath || '',
                relativePath: relativePath,
                h1Text: h1Text,
            });
        },

        // v0.207.86: Notes 内 .md からのリンククリック動作を override。
        // shared.openLink (= openExternalLink → vscode.env.openExternal) は相対 path を URL として
        // 解釈しようとして「No application found to open URL」になるため、
        // notes md 専用のメッセージで filePath コンテキストを backend に渡し、
        // - plain click  → sidepanel で開く
        // - cmd/ctrl+click → 新タブ standalone editor で開く
        // で route する。http / fractal:// / # anchor 等の特殊 href は backend で個別処理。
        // outliner node paste の添付複製 (sprint 20260727-124904 TASK-B5): factory shared 版は
        // sidePanelFilePath 引数前提で、note md メインペインでは undefined になり
        // notes-message-handler の guard で silent no-op だった (paste 不能バグ)。
        // note md では自分の filePath を宛先として畳む (openLink 等と同型の override)。
        pasteOutlinerNodesWithAssets: function(plainText, nodes) {
            api.postMessage({
                type: 'pasteOutlinerNodesWithAssets',
                plainText: plainText,
                nodes: nodes,
                sidePanelFilePath: window.notesMarkdownHostBridge.filePath || '',
            });
        },
        openLink: function(href) {
            api.postMessage({
                type: 'notesMdOpenLink',
                filePath: window.notesMarkdownHostBridge.filePath || '',
                href: href,
            });
        },
        openLinkInTab: function(href) {
            api.postMessage({
                type: 'notesMdOpenLinkInTab',
                filePath: window.notesMarkdownHostBridge.filePath || '',
                href: href,
            });
        },
        // v0.207.88: notes md ヘッダーの「新タブで開く」ボタン → 現在編集中の .md を
        // standalone customEditor で開き直す。sidepanel の side-panel-open-tab と同じ semantics。
        openInNewTab: function() {
            api.postMessage({
                type: 'notesMdOpenSelfInNewTab',
                filePath: window.notesMarkdownHostBridge.filePath || '',
            });
        },

        // 画像保存: _notes_md/images/ に保存する (v0.207.82: md ファイルは _notes_md/ 直下にあるため
        // 相対パスは images/<fileName>)
        // v0.207.80: editor.js は cmd+v / D&D 等で host.saveImageAndInsert(dataUrl[, fileName])
        // を呼ぶため、これも notesMd 経路へ転送する (sidepanel 共通版は sidePanelFilePath
        // 必須で undefined だと message-handler が silent no-op になっていた)。
        saveImage: function(dataUrl, fileName) {
            api.postMessage({ type: 'notesMdSaveImage', dataUrl: dataUrl, fileName: fileName });
        },
        saveImageAndInsert: function(dataUrl, fileName) {
            api.postMessage({ type: 'notesMdSaveImage', dataUrl: dataUrl, fileName: fileName });
        },
        readAndInsertImage: function(filePath) {
            api.postMessage({ type: 'notesMdReadAndInsertImage', filePath: filePath });
        },
        saveFileToDir: function(dataUrl, fileName) {
            api.postMessage({ type: 'notesMdSaveFile', dataUrl: dataUrl, fileName: fileName });
        },
        saveFileAndInsert: function(dataUrl, fileName) {
            api.postMessage({ type: 'notesMdSaveFile', dataUrl: dataUrl, fileName: fileName });
        },
        readAndInsertFile: function(filePath) {
            api.postMessage({ type: 'notesMdReadAndInsertFile', filePath: filePath });
        },
        // FR-B07: Notes md メインペインの .md D&D → subpage 登録（files/ 添付にしない）
        saveMdAsSubpage: function(dataUrl, fileName) {
            api.postMessage({ type: 'notesMdSaveMdAsSubpage', dataUrl: dataUrl, fileName: fileName });
        },
        readAndInsertMdAsSubpage: function(filePath) {
            api.postMessage({ type: 'notesMdReadMdAsSubpage', filePath: filePath });
        },
        // FR-B09 (TASK-08): ファイルツリー md item → md editor D&D。既存 md へコピーせずリンクのみ。
        // US-09: mdFileId も渡し、host がツリーから md エントリを除去（真の subpage 化・ファイル実体不変）
        linkMdAsSubpage: function(filePath, mdFileId) {
            api.postMessage({ type: 'notesMdLinkMdAsSubpage', filePath: filePath, mdFileId: mdFileId || null });
        },
        // v0.207.81: 画像 cmd+v が複数枚同時挿入されるバグの修正。
        // sidepanel-bridge-methods.js の onMessage は呼ばれるたびに
        // window.addEventListener('message') を新規登録する。Notes は .md ファイルを切替えるたび
        // EditorInstance を destroy → new EditorInstance するため、_legacyInit() 内の
        // host.onMessage(...) で listener が累積し、insertImageHtml broadcast を N 個のハンドラが
        // 同時受信して同じ画像を N 回挿入してしまう。
        // 解決: onMessage は単一 window listener + 最新 handler だけを保持する形に上書き。
        onMessage: (function() {
            var current = null;
            window.addEventListener('message', function(e) {
                if (current) current(e.data);
            });
            return function(handler) { current = handler; };
        })(),
    });

    // ── notes-file-panel.js 用ブリッジ ──
    window.notesHostBridge = {
        // ファイル操作
        openFile: function(filePath, searchQuery, searchOccurrence) {
            flushOutlinerSync();
            api.postMessage({
                type: 'notesOpenFile',
                filePath: filePath,
                searchQuery: searchQuery || null,
                searchOccurrence: typeof searchOccurrence === 'number' ? searchOccurrence : null,
            });
        },
        // sprint 20260725: 左ツリー右クリック「Open in new tab」→ webview 内タブで開く（md/.out 両対応）
        openFileInTab: function(filePath) {
            api.postMessage({ type: 'notesOpenFileInTab', filePath: filePath });
        },
        // sprint 20260724-063158 (FR-TP-06): タブ右クリック「Open in VS Code Tab」→ standalone で開く
        openInVscodeTab: function(filePath) {
            api.postMessage({ type: 'notesOpenInVscodeTab', filePath: filePath });
        },
        // sprint 20260723-233506: webview 内マルチタブの host 協調（named bridge・NFR-TAB-04）
        flushActive: function() {
            api.postMessage({ type: 'notesFlushActive' });
        },
        restoreSidePanel: function(filePath) {
            api.postMessage({ type: 'notesRestoreSidePanel', filePath: filePath });
        },
        closeSidePanelForTab: function() {
            api.postMessage({ type: 'sidePanelClosed' });
        },
        createFile: function(title, parentId, afterId) {
            api.postMessage({ type: 'notesCreateFile', title: title, parentId: parentId || null, afterId: afterId || null });
        },
        // ADR-008: 新規 Markdown ファイル作成
        createMarkdownFile: function(title, parentId, afterId) {
            api.postMessage({ type: 'notesCreateMarkdownFile', title: title, parentId: parentId || null, afterId: afterId || null });
        },
        deleteFile: function(filePath) {
            api.postMessage({ type: 'notesDeleteFile', filePath: filePath });
        },
        renameTitle: function(filePath, newTitle) {
            api.postMessage({ type: 'notesRenameTitle', filePath: filePath, newTitle: newTitle });
        },
        // FR-NT-02: note フォルダ全体のタイトルを保存
        setNoteTitle: function(title) {
            api.postMessage({ type: 'notesSetNoteTitle', title: title });
        },
        // FR-MV-01: Notes タブの項目を別 Note へ移動 (QuickPick は host 側)
        moveToOtherNote: function(itemId) {
            api.postMessage({ type: 'notesMoveToOtherNote', itemId: itemId });
        },
        togglePanel: function(collapsed) {
            api.postMessage({ type: 'notesTogglePanel', collapsed: collapsed });
        },

        // フォルダ操作
        createFolder: function(title, parentId, afterId) {
            api.postMessage({ type: 'notesCreateFolder', title: title, parentId: parentId || null, afterId: afterId || null });
        },
        deleteFolder: function(folderId) {
            api.postMessage({ type: 'notesDeleteFolder', folderId: folderId });
        },
        renameFolder: function(folderId, newTitle) {
            api.postMessage({ type: 'notesRenameFolder', folderId: folderId, newTitle: newTitle });
        },
        toggleFolder: function(folderId) {
            api.postMessage({ type: 'notesToggleFolder', folderId: folderId });
        },

        // D&D 移動
        moveItem: function(itemId, targetParentId, index) {
            api.postMessage({ type: 'notesMoveItem', itemId: itemId, targetParentId: targetParentId, index: index });
        },

        // v11: アイテム色設定
        setItemColor: function(itemId, color) {
            api.postMessage({ type: 'notesSetItemColor', itemId: itemId, color: color });
        },

        // v0.207.36: お気に入り toggle
        toggleFavorite: function(fileId) {
            api.postMessage({ type: 'notesToggleFavorite', fileId: fileId });
        },

        // v0.207.77: D&D — Notes 内 .md を .out item にドロップして import
        notesImportMdIntoOut: function(mdFileId, targetOutId) {
            api.postMessage({ type: 'notesImportMdIntoOut', mdFileId: mdFileId, targetOutId: targetOutId });
        },

        // TASK-19: md editor 内 subpage リンク → ツリー D&D（host が href を sourceMd 基準で解決）
        notesRegisterSubpageFromMd: function(payload, parentId, index) {
            api.postMessage({ type: 'notesRegisterSubpageFromMd', payload: payload, parentId: parentId, index: index });
        },

        // FR-T01: Finder / VS Code Explorer から .md をツリーに D&D → 新 id で複製登録。
        // items = 種別付き配列 [{kind:'md', name, content}]（webview が FileReader で読み込み済み）。
        notesRegisterExternalMd: function(items, parentId, index) {
            api.postMessage({ type: 'notesRegisterExternalMd', items: items, parentId: parentId || null, index: index || 0 });
        },

        // v0.207.77: D&D — outliner page-node を Notes panel にドロップして .md として登録
        notesImportOutPageNodeAsMd: function(payload, parentId, index) {
            flushOutlinerSync();
            api.postMessage({
                type: 'notesImportOutPageNodeAsMd',
                payload: payload,
                parentId: parentId || null,
                index: index || 0,
            });
        },

        // node-move-to-other-outliner: outliner node（サブツリー）を別 .out に move。
        // flushOutlinerSync で src .out の disk を最新化してから host に依頼（host は disk を権威に解決）。
        notesMoveOutNodeSubtreeIntoOut: function(payload, targetOutFilePath) {
            flushOutlinerSync();
            api.postMessage({
                type: 'notesMoveOutNodeSubtreeIntoOut',
                payload: payload,
                targetOutFilePath: targetOutFilePath,
            });
        },

        // Daily Notes
        openDailyNotes: function() {
            flushOutlinerSync();
            api.postMessage({ type: 'notesOpenDailyNotes' });
        },
        navigateDailyNotes: function(dayOffset, currentDate) {
            flushOutlinerSync();
            api.postMessage({ type: 'notesNavigateDailyNotes', dayOffset: dayOffset, currentDate: currentDate || null });
        },

        // パネル幅保存
        savePanelWidth: function(width) {
            api.postMessage({ type: 'notesSavePanelWidth', width: width });
        },

        // FR-HP: 最近開いたファイル履歴パネル（★reopen 2026-07-23: openPageFromHistory 廃止・クリックは openFile に統一）
        saveHistoryPanelCollapsed: function(collapsed) {
            api.postMessage({ type: 'notesSaveHistoryPanelCollapsed', collapsed: !!collapsed });
        },
        saveHistoryPanelHeight: function(height) {
            api.postMessage({ type: 'notesSaveHistoryPanelHeight', height: height });
        },

        // 検索
        search: function(query, options) {
            flushOutlinerSync();
            // outlinerの検索・スコープをリセット (RQ-1-2)
            if (window.Outliner && window.Outliner.resetSearchAndScope) {
                window.Outliner.resetSearchAndScope();
            }
            api.postMessage({
                type: 'notesSearch',
                query: query,
                caseSensitive: options.caseSensitive,
                wholeWord: options.wholeWord,
                useRegex: options.useRegex,
            });
        },
        jumpToNode: function(fileId, nodeId) {
            flushOutlinerSync();
            api.postMessage({ type: 'notesJumpToNode', fileId: fileId, nodeId: nodeId });
        },
        jumpToMdPage: function(outFileId, pageId, lineNumber, query, occurrence) {
            flushOutlinerSync();
            api.postMessage({
                type: 'notesJumpToMdPage',
                outFileId: outFileId,
                pageId: pageId,
                lineNumber: lineNumber,
                query: query,
                occurrence: occurrence,
            });
        },
        openMdFileExternal: function(filePath) {
            api.postMessage({ type: 'notesOpenMdExternal', filePath: filePath });
        },
        onSearchStart: function(handler) {
            window.addEventListener('message', function(e) {
                if (e.data && e.data.type === 'notesSearchStart') {
                    handler(e.data.searchId, e.data.query);
                }
            });
        },
        onSearchPartial: function(handler) {
            window.addEventListener('message', function(e) {
                if (e.data && e.data.type === 'notesSearchPartial') {
                    handler(e.data.searchId, e.data.result);
                }
            });
        },
        onSearchEnd: function(handler) {
            window.addEventListener('message', function(e) {
                if (e.data && e.data.type === 'notesSearchEnd') {
                    handler(e.data.searchId);
                }
            });
        },

        // イベントリスナー
        onFileListChanged: function(handler) {
            window.addEventListener('message', function(e) {
                if (e.data && e.data.type === 'notesFileListChanged') {
                    // FR-NT-01: noteFolderName を第4引数で渡す (noteTitle 未設定時の既定表示)
                    handler(e.data.fileList, e.data.currentFile, e.data.structure, e.data.noteFolderName);
                }
            });
        },

        // ── S3 Sync ──

        s3Sync: function(bucketPath) {
            flushOutlinerSync();
            api.postMessage({ type: 'notesS3Sync', bucketPath: bucketPath });
        },
        s3RemoteDeleteAndUpload: function(bucketPath) {
            flushOutlinerSync();
            api.postMessage({ type: 'notesS3RemoteDeleteUpload', bucketPath: bucketPath });
        },
        s3LocalDeleteAndDownload: function(bucketPath) {
            flushOutlinerSync();
            api.postMessage({ type: 'notesS3LocalDeleteDownload', bucketPath: bucketPath });
        },
        s3SaveBucketPath: function(bucketPath) {
            api.postMessage({ type: 'notesS3SaveBucketPath', bucketPath: bucketPath });
        },
        s3GetStatus: function() {
            api.postMessage({ type: 'notesS3GetStatus' });
        },
        onS3Progress: function(handler) {
            window.addEventListener('message', function(e) {
                if (e.data && e.data.type === 'notesS3Progress') {
                    handler(e.data);
                }
            });
        },
        onS3Status: function(handler) {
            window.addEventListener('message', function(e) {
                if (e.data && e.data.type === 'notesS3Status') {
                    handler(e.data);
                }
            });
        },

        // ── Cleanup ──

        cleanupUnusedFilesAllNotes: function() {
            flushOutlinerSync();
            api.postMessage({ type: 'cleanupUnusedFilesAllNotes' });
        },

        cleanupUnusedFilesCurrentNote: function() {
            flushOutlinerSync();
            api.postMessage({ type: 'cleanupUnusedFilesCurrentNote' });
        },

        // v0.207.25: Custom Terminology を Amazon Translate に upload
        updateTranslateTerminology: function() {
            api.postMessage({ type: 'updateTranslateTerminology' });
        }
    };
})();
