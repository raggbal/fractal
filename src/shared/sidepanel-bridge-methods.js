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

        // FR-TH-04: outliner の page node text 確定 → 添付 page md の先頭 H1 を text に同期。
        // 共通ファクトリに置くことで notes/standalone 両 outlinerHostBridge + standalone test bridge に伝播。
        syncNodeTextToPageH1: function(pageId, text) {
            postFn({ type: 'syncNodeTextToPageH1', pageId: pageId, text: text });
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

        // リソースアクセス範囲設定 (FR-RR-06)
        openResourceRootsSettings: function() {
            postFn({ type: 'openResourceRootsSettings' });
        },

        // 保存先変更 (FR-MD-03, standalone md 限定)。kind='image'|'file'
        setSaveDir: function(kind) {
            postFn({ type: 'setSaveDir', kind: kind });
        },

        // md export bundle (FR-EX-01)。sidePanelFilePath があれば sidepanel の md を root にする
        exportBundle: function(options, sidePanelFilePath) {
            postFn({ type: 'exportBundle', options: options, sidePanelFilePath: sidePanelFilePath });
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
        // v15+: cmd+/ Add Page (simple flow) — sidepanel が outliner pageDir 直下に新規 .md を作る
        createPageAutoForSidePanel: function(sidePanelFilePath) {
            postFn({ type: 'createPageAutoForSidePanel', sidePanelFilePath: sidePanelFilePath });
        },
        // v15+: side panel navigation (back/forward stack)
        sidePanelNavigateBack: function(sidePanelFilePath) {
            postFn({ type: 'sidePanelNavigateBack', sidePanelFilePath: sidePanelFilePath });
        },
        sidePanelNavigateForward: function(sidePanelFilePath) {
            postFn({ type: 'sidePanelNavigateForward', sidePanelFilePath: sidePanelFilePath });
        },

        // sendToChat
        sendToChat: function(startLine, endLine, selectedMarkdown, sidePanelFilePath) {
            postFn({ type: 'sendToChat', startLine: startLine, endLine: endLine, selectedMarkdown: selectedMarkdown, sidePanelFilePath: sidePanelFilePath });
        },

        // MD paste asset copy (v9)
        // outliner node リスト paste の添付複製 (sprint 20260727-124904 / ADRL-0001)。
        // nodes は検知用。真実 (ソース dir 込み) は host の OutlinerClipboardStore が
        // plainText キーで持つ (NFR-NP-03)。結果は pasteWithAssetCopyResult で返る。
        pasteOutlinerNodesWithAssets: function(plainText, nodes, sidePanelFilePath) {
            postFn({
                type: 'pasteOutlinerNodesWithAssets',
                plainText: plainText,
                nodes: nodes,
                sidePanelFilePath: sidePanelFilePath
            });
        },
        pasteWithAssetCopy: function(markdown, sourceContext, sidePanelFilePath) {
            postFn({
                type: 'pasteWithAssetCopy',
                markdown: markdown,
                sourceContext: sourceContext,
                sidePanelFilePath: sidePanelFilePath
            });
        },

        // HTML paste で MD 内に残った data:image/... を images/ に実体化し相対 path 化
        extractDataUrlsInPastedMd: function(markdown, sidePanelFilePath) {
            postFn({
                type: 'extractDataUrlsInPastedMd',
                markdown: markdown,
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
        // v0.207.24: popup から source/target lang を選んだ時 settings に永続化
        saveTranslateLangs: function(sourceLang, targetLang) {
            postFn({
                type: 'saveTranslateLangs',
                sourceLang: sourceLang,
                targetLang: targetLang
            });
        },
        // v0.207.24: sidepanel での「翻訳結果を保存」 button 押下時、親 outliner node に子 page として attach
        saveTranslationToOutlinerNode: function(sidePanelFilePath, translatedMarkdown, h1Title, sourceLang, targetLang) {
            postFn({
                type: 'saveTranslationToOutlinerNode',
                sidePanelFilePath: sidePanelFilePath,
                translatedMarkdown: translatedMarkdown,
                h1Title: h1Title,
                sourceLang: sourceLang,
                targetLang: targetLang
            });
        },

        // 画像 fullscreen overlay の 3 ボタン用
        copyImageToClipboard: function(absPath) {
            postFn({ type: 'copyImageToClipboard', absPath: absPath });
        },
        openImageInNewTab: function(absPath) {
            postFn({ type: 'openImageInNewTab', absPath: absPath });
        },
        openDrawioExternal: function(absPath) {
            // .drawio.svg/.png を外部アプリで開く（mac: draw.io Desktop 優先 → OS デフォルト fallback）
            postFn({ type: 'openDrawioExternal', absPath: absPath });
        },

        // メッセージ受信
        onMessage: function(handler) {
            window.addEventListener('message', function(e) {
                handler(e.data);
            });
        }
    };
};
