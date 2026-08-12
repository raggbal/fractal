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

        // md → PDF export (FR-PDF-08)。共有 factory 既定は sidepanel-md（sidepanel header 経路）。
        // main pane 側 bridge は main-md に override する（design §8.2）。呼び出し側が明示 targetHint
        // を渡した場合はそれを優先（sidepanel header は host.exportPdf('sidepanel-md') で明示）。
        exportPdf: function(targetHint) {
            postFn({ type: 'exportPdf', targetHint: targetHint || 'sidepanel-md' });
        },

        // page アイコン cmd+click → page md を新規タブで開く (FR-CT-03)。パス解決は host
        openPageInTab: function(nodeId, pageId) {
            postFn({ type: 'openPageInTab', nodeId: nodeId, pageId: pageId });
        },

        // outliner node subtree の Export bundle (FR-EB)。dialog/出力は host
        exportOutlinerNodesBundle: function(nodeId, nodes) {
            postFn({ type: 'exportOutlinerNodesBundle', nodeId: nodeId, nodes: nodes });
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

        // FR-B07 (sprint 20260804-145603): .md D&D の subpage 登録（添付でなく同階層コピー + [[title]](file.md)）
        saveMdAsSubpage: function(dataUrl, fileName, sidePanelFilePath) {
            postFn({ type: 'saveMdAsSubpage', dataUrl: dataUrl, fileName: fileName, sidePanelFilePath: sidePanelFilePath });
        },
        readAndInsertMdAsSubpage: function(filePath, sidePanelFilePath) {
            postFn({ type: 'readAndInsertMdAsSubpage', filePath: filePath, sidePanelFilePath: sidePanelFilePath });
        },

        // MD-45/46/47: drawio.svg / drawio.png / drawio (XML) 経路
        saveDrawioAndInsert: function(dataUrl, fileName, sidePanelFilePath) {
            postFn({ type: 'saveDrawioAndInsert', dataUrl: dataUrl, fileName: fileName, sidePanelFilePath: sidePanelFilePath });
        },
        readAndInsertDrawio: function(filePath, sidePanelFilePath) {
            postFn({ type: 'readAndInsertDrawio', filePath: filePath, sidePanelFilePath: sidePanelFilePath });
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
            // destination (sprint 20260808-000219): 結果 (pasteWithAssetCopyResult) の宛先識別。
            // sidePanelFilePath を畳むのは SidePanelHostBridge の中継だけなので、その有無で
            // sidepanel / main-md を確定できる。host は echo back するだけ（解釈しない）。
            postFn({
                type: 'pasteWithAssetCopy',
                markdown: markdown,
                sourceContext: sourceContext,
                sidePanelFilePath: sidePanelFilePath,
                destination: sidePanelFilePath ? 'sidepanel' : 'main-md'
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
        // FR-OIP-01 (sprint 20260812-110538): 旧実装は onMessage を呼ぶたびに window
        // listener を新規登録し、onMessage(...) の再呼び出し(init 再実行等)で listener が
        // 累積 → 1 broadcast を N ハンドラが受信し同一処理が N 回走る(画像 paste 二重貼付の
        // standalone 面の機序)。notes-host-bridge.js の v0.207.81 正典と同型の
        // 「単一 window listener + 最新 handler のみ保持」に是正。
        // ★ dispatcher は window グローバル 1 個(この factory 自体が bridge ごとに複数回
        //   呼ばれるため、per-factory の IIFE では listener が factory 数ぶん残る)。
        // ★ handler は bridge インスタンスごとに保持(editor 用と outliner 用の別 bridge が
        //   同居する webview で互いの handler を上書きしないため)。
        onMessage: (function() {
            if (!window.__spBridgeMsgHandlers) {
                window.__spBridgeMsgHandlers = new Map();
                window.addEventListener('message', function(e) {
                    window.__spBridgeMsgHandlers.forEach(function(h) {
                        try { h(e.data); } catch (err) { /* handler 間の隔離 */ }
                    });
                });
            }
            var key = {}; // この bridge インスタンス固有のキー
            return function(handler) { window.__spBridgeMsgHandlers.set(key, handler); };
        })()
    };
};
