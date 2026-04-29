/**
 * サイドパネル共通ブリッジメソッド
 *
 * 全エディタ（Markdown / Outliner / Notes）のホストブリッジで共通のメソッドを生成する。
 * 各ブリッジの IIFE 内で Object.assign() により統合する。
 *
 * 使い方:
 *   var _sp = window.__createSidePanelBridgeMethods(function(msg) { api.postMessage(msg); });
 *   window.outlinerHostBridge = Object.assign({ ...固有メソッド... }, _sp);
 */
window.__createSidePanelBridgeMethods = function(postFn) {
    return {
        // 保存
        save: function() {
            postFn({ type: 'save' });
        },

        // リンク
        openLink: function(href) {
            postFn({ type: 'openLink', href: href });
        },
        openLinkInTab: function(href) {
            postFn({ type: 'openLinkInTab', href: href });
        },
        requestInsertLink: function(text) {
            postFn({ type: 'insertLink', text: text });
        },

        // フォーカス
        reportFocus: function() {
            postFn({ type: 'webviewFocus' });
        },
        reportBlur: function() {
            postFn({ type: 'webviewBlur' });
        },

        // 検索
        searchFiles: function(query) {
            postFn({ type: 'searchFiles', query: query });
        },

        // サイドパネル操作
        saveSidePanelFile: function(filePath, content) {
            postFn({ type: 'saveSidePanelFile', filePath: filePath, content: content });
        },
        sidePanelOpenLink: function(href, sidePanelFilePath) {
            postFn({ type: 'sidePanelOpenLink', href: href, sidePanelFilePath: sidePanelFilePath });
        },
        notifySidePanelClosed: function() {
            postFn({ type: 'sidePanelClosed' });
        },
        sidePanelOpenInTextEditor: function(sidePanelFilePath) {
            postFn({ type: 'sidePanelOpenInTextEditor', sidePanelFilePath: sidePanelFilePath });
        },
        getSidePanelImageDir: function(sidePanelFilePath) {
            postFn({ type: 'getSidePanelImageDir', sidePanelFilePath: sidePanelFilePath });
        },

        // 画像
        requestInsertImage: function(sidePanelFilePath) {
            postFn({ type: 'insertImage', position: 0, sidePanelFilePath: sidePanelFilePath });
        },
        saveImageAndInsert: function(dataUrl, fileName, sidePanelFilePath) {
            postFn({ type: 'saveImageAndInsert', dataUrl: dataUrl, fileName: fileName, sidePanelFilePath: sidePanelFilePath });
        },
        readAndInsertImage: function(filePath, sidePanelFilePath) {
            postFn({ type: 'readAndInsertImage', filePath: filePath, sidePanelFilePath: sidePanelFilePath });
        },

        // ファイル添付
        saveFileAndInsert: function(dataUrl, fileName, sidePanelFilePath) {
            postFn({ type: 'saveFileAndInsert', dataUrl: dataUrl, fileName: fileName, sidePanelFilePath: sidePanelFilePath });
        },
        readAndInsertFile: function(filePath, sidePanelFilePath) {
            postFn({ type: 'readAndInsertFile', filePath: filePath, sidePanelFilePath: sidePanelFilePath });
        },

        // MD-45/46/47: drawio.svg / drawio.png / drawio (XML) 経路
        saveDrawioAndInsert: function(dataUrl, fileName, sidePanelFilePath) {
            postFn({ type: 'saveDrawioAndInsert', dataUrl: dataUrl, fileName: fileName, sidePanelFilePath: sidePanelFilePath });
        },
        readAndInsertDrawio: function(filePath, sidePanelFilePath) {
            postFn({ type: 'readAndInsertDrawio', filePath: filePath, sidePanelFilePath: sidePanelFilePath });
        },
        notifyUnsupportedDrawioXml: function(droppedPath, fileName, sidePanelFilePath) {
            postFn({ type: 'notifyUnsupportedDrawioXml', droppedPath: droppedPath, fileName: fileName, sidePanelFilePath: sidePanelFilePath });
        },
        requestCreateDrawio: function(sidePanelFilePath) {
            postFn({ type: 'requestCreateDrawio', sidePanelFilePath: sidePanelFilePath });
        },

        // sendToChat
        sendToChat: function(startLine, endLine, selectedMarkdown, sidePanelFilePath) {
            postFn({ type: 'sendToChat', startLine: startLine, endLine: endLine, selectedMarkdown: selectedMarkdown, sidePanelFilePath: sidePanelFilePath });
        },

        // MD paste asset copy (v9)
        pasteWithAssetCopy: function(markdown, sourceContext, sidePanelFilePath) {
            postFn({
                type: 'pasteWithAssetCopy',
                markdown: markdown,
                sourceContext: sourceContext,
                sidePanelFilePath: sidePanelFilePath
            });
        },

        // v10: Translation
        translateContent: function(markdown, sourceLang, targetLang, sidePanelFilePath) {
            postFn({
                type: 'translateContent',
                markdown: markdown,
                sourceLang: sourceLang,
                targetLang: targetLang,
                sidePanelFilePath: sidePanelFilePath
            });
        },
        translateSelectLang: function(currentSource, currentTarget, sidePanelFilePath) {
            postFn({
                type: 'translateSelectLang',
                currentSource: currentSource,
                currentTarget: currentTarget,
                sidePanelFilePath: sidePanelFilePath
            });
        },

        // メッセージ受信
        onMessage: function(handler) {
            window.addEventListener('message', function(e) {
                handler(e.data);
            });
        }
    };
};
