/**
 * VSCode HostBridge — acquireVsCodeApi() をラップし、
 * editor.js が使う window.hostBridge インターフェースを提供する。
 *
 * webviewContent.ts により editor.js の前に注入される。
 * 共通メソッドは sidepanel-bridge-methods.js の __createSidePanelBridgeMethods() から取得。
 */
(function() {
    const api = acquireVsCodeApi();
    var postFn = function(msg) { api.postMessage(msg); };
    window.__pdfExportPost = postFn;   // pdf-export-webview.js が pdfHtmlResult 返信に使う

    // 共通メソッド（サイドパネル・画像・リンク・フォーカス等）
    var shared = window.__createSidePanelBridgeMethods(postFn);

    window.hostBridge = Object.assign(shared, {
        // ドキュメント操作
        syncContent: function(markdown) {
            api.postMessage({ type: 'edit', content: markdown });
        },

        // フォーカス/編集状態
        reportEditingState: function(editing) {
            api.postMessage({ type: 'editingStateChanged', editing: editing });
        },

        // ホスト側 UI が必要な操作
        requestInsertLink: function(text) {
            api.postMessage({ type: 'insertLink', text: text });
        },
        openInTextEditor: function() {
            api.postMessage({ type: 'openInTextEditor' });
        },
        copyFilePath: function() {
            api.postMessage({ type: 'copyFilePath' });
        },

        // FR-PDF-08: main md pane の PDF export。既定 targetHint 'main-md'（shared factory の
        // 'sidepanel-md' を override）。sidepanel header 経路は host.exportPdf('sidepanel-md') で
        // 明示上書きするため、引数があればそれを優先（design §8.2）。
        exportPdf: function(targetHint) {
            api.postMessage({ type: 'exportPdf', targetHint: targetHint || 'main-md' });
        },

        // ページ管理
        createPageAtPath: function(relativePath) {
            api.postMessage({ type: 'createPageAtPath', relativePath: relativePath });
        },
        createPageAuto: function() {
            api.postMessage({ type: 'createPageAuto' });
        },
        updatePageH1: function(relativePath, h1Text) {
            api.postMessage({ type: 'updatePageH1', relativePath: relativePath, h1Text: h1Text });
        },

        // v10: Translation
        translateContent: function(markdown, sourceLang, targetLang, sidePanelFilePath) {
            api.postMessage({
                type: 'translateContent',
                markdown: markdown,
                sourceLang: sourceLang,
                targetLang: targetLang,
                sidePanelFilePath: sidePanelFilePath
            });
        },
        translateSelectLang: function(currentSource, currentTarget, sidePanelFilePath) {
            api.postMessage({
                type: 'translateSelectLang',
                currentSource: currentSource,
                currentTarget: currentTarget,
                sidePanelFilePath: sidePanelFilePath
            });
        },
        // v0.207.24: popup から source/target lang を選んだ時 settings に永続化
        saveTranslateLangs: function(sourceLang, targetLang) {
            api.postMessage({
                type: 'saveTranslateLangs',
                sourceLang: sourceLang,
                targetLang: targetLang
            });
        },
        // v0.207.24: sidepanel での「翻訳結果を保存」 button 押下時、親 outliner node に子 page として attach
        saveTranslationToOutlinerNode: function(sidePanelFilePath, translatedMarkdown, h1Title, sourceLang, targetLang) {
            api.postMessage({
                type: 'saveTranslationToOutlinerNode',
                sidePanelFilePath: sidePanelFilePath,
                translatedMarkdown: translatedMarkdown,
                h1Title: h1Title,
                sourceLang: sourceLang,
                targetLang: targetLang
            });
        }
    });
})();
