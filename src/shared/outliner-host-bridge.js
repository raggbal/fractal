/**
 * Outliner VSCode HostBridge — acquireVsCodeApi() をラップし、
 * outliner.js が使う window.outlinerHostBridge インターフェースを提供する。
 *
 * outlinerWebviewContent.ts により outliner.js の前に注入される。
 * 共通メソッドは sidepanel-bridge-methods.js の __createSidePanelBridgeMethods() から取得。
 */
(function() {
    var api = acquireVsCodeApi();
    var postFn = function(msg) { api.postMessage(msg); };
    window.__pdfExportPost = postFn;   // pdf-export-webview.js が pdfHtmlResult 返信に使う

    // 共通メソッド（サイドパネル・画像・リンク・フォーカス等）
    var shared = window.__createSidePanelBridgeMethods(postFn);

    window.outlinerHostBridge = Object.assign(shared, {
        // データ同期
        syncData: function(jsonString) {
            api.postMessage({ type: 'syncData', content: jsonString });
        },

        // Mindmap Mode (sprint 20260701-122355): PNG/SVG/OPML/MD エクスポート
        exportMindmap: function(format, payload, suggestedName) {
            api.postMessage({ type: 'exportMindmap', format: format, payload: payload, suggestedName: suggestedName });
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
        showInfoMessage: function(text) {
            api.postMessage({ type: 'showInfoMessage', text: text });
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
        // FR-OL-COPYPATH-1: file 添付ノードの絶対 path を OS clipboard にコピー
        copyAttachedFilePath: function(nodeId) {
            api.postMessage({ type: 'copyAttachedFilePath', nodeId: nodeId });
        },
        // v0.207.48: 複数ノードの添付ファイル絶対 path を改行区切りでコピー
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
        // v0.207.96: Streaming D&D for files > 50MB. The outliner.js sender awaits
        // dropStreamReady before pumping chunks and dropStreamAck between chunks
        // to maintain back-pressure with the host-side fs.WriteStream.
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
        setOutlinerImageDir: function() {
            api.postMessage({ type: 'setOutlinerImageDir' });
        },
        getOutlinerImageDir: function() {
            api.postMessage({ type: 'getOutlinerImageDir' });
        },
        setFileDir: function() {
            api.postMessage({ type: 'setOutlinerFileDir' });
        },
        // standalone outliner: note-level methods are no-ops (width is per-.out via syncData)
        notesSaveSidePanelWidth: function() { /* no-op for standalone */ },
        notesSaveSidePanelOutlineWidth: function() { /* no-op for standalone */ },

    });
})();
