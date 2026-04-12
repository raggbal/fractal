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

    // 共通メソッド（サイドパネル・画像・リンク・フォーカス等）
    var shared = window.__createSidePanelBridgeMethods(postFn);

    window.outlinerHostBridge = Object.assign(shared, {
        // データ同期
        syncData: function(jsonString) {
            api.postMessage({ type: 'syncData', content: jsonString });
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
        copyPageFileCross: function(sourcePageId, newPageId, clipboardPlainText, targetNodeId, nodeImages) {
            api.postMessage({ type: 'copyPageFileCross', sourcePageId: sourcePageId, newPageId: newPageId, clipboardPlainText: clipboardPlainText, targetNodeId: targetNodeId, nodeImages: nodeImages || [] });
        },
        movePageFileCross: function(pageId, clipboardPlainText, targetNodeId, nodeImages) {
            api.postMessage({ type: 'movePageFileCross', pageId: pageId, clipboardPlainText: clipboardPlainText, targetNodeId: targetNodeId, nodeImages: nodeImages || [] });
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

        // ファイル添付操作
        openAttachedFile: function(nodeId) {
            api.postMessage({ type: 'openAttachedFile', nodeId: nodeId });
        },
        copyFileAsset: function(filePath, clipboardPlainText, nodeId) {
            api.postMessage({ type: 'copyFileAsset', filePath: filePath, clipboardPlainText: clipboardPlainText, nodeId: nodeId });
        },
        moveFileAssetCross: function(filePath, clipboardPlainText, nodeId) {
            api.postMessage({ type: 'moveFileAssetCross', filePath: filePath, clipboardPlainText: clipboardPlainText, nodeId: nodeId });
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
        }
    });
})();
