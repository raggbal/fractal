/**
 * Notes スタンドアロンテスト用HTMLを生成するビルドスクリプト
 *
 * 使用方法:
 *   node test/build-standalone-notes.js
 *
 * outliner.js + notes-file-panel.js を読み込んで
 * test/html/standalone-notes.html に出力
 */

const fs = require('fs');
const path = require('path');

// --- ソースファイルパス ---
const editorJsPath = path.join(__dirname, '../src/webview/editor.js');
const editorUtilsJsPath = path.join(__dirname, '../src/webview/editor-utils.js');
const outlinerJsPath = path.join(__dirname, '../src/webview/outliner.js');
const outlinerCellJsPath = path.join(__dirname, '../src/webview/outliner-cell.js');
const outlinerModelJsPath = path.join(__dirname, '../src/webview/outliner-model.js');
const outlinerSearchJsPath = path.join(__dirname, '../src/webview/outliner-search.js');
const outlinerCssPath = path.join(__dirname, '../src/webview/outliner.css');
const stylesPath = path.join(__dirname, '../src/webview/styles.css');
// sprint 20260509-185557-minimal-settings-foundation: tokens / fr-base / fr-components
const tokensCssPath = path.join(__dirname, '../src/webview/tokens.css');
const frBaseCssPath = path.join(__dirname, '../src/webview/fr-base.css');
const frComponentsCssPath = path.join(__dirname, '../src/webview/fr-components.css');
const sidePanelBridgePath = path.join(__dirname, '../src/shared/sidepanel-bridge-methods.js');
const linkParserPath = path.join(__dirname, '../src/shared/markdown-link-parser.js');
const clipSelectPath = path.join(__dirname, '../src/webview/outliner-clip-select.js');
const editorBodyHtmlPath = path.join(__dirname, '../src/shared/editor-body-html.js');
const notesBodyHtmlPath = path.join(__dirname, '../src/shared/notes-body-html.js');
const notesFilePanelJsPath = path.join(__dirname, '../src/shared/notes-file-panel.js');
const notesColorPaletteJsPath = path.join(__dirname, '../src/shared/notes-color-palette.js');
const outputPath = path.join(__dirname, 'html/standalone-notes.html');

// vendor/ → test/html/vendor/ にコピー（テストサーバー用）
const vendorSrc = path.join(__dirname, '../vendor');
const vendorDest = path.join(__dirname, 'html/vendor');
if (fs.existsSync(vendorSrc)) {
    fs.mkdirSync(vendorDest, { recursive: true });
    for (const file of fs.readdirSync(vendorSrc)) {
        const srcPath = path.join(vendorSrc, file);
        if (fs.statSync(srcPath).isDirectory()) {
            const destDir = path.join(vendorDest, file);
            fs.mkdirSync(destDir, { recursive: true });
            for (const f of fs.readdirSync(srcPath)) {
                fs.copyFileSync(path.join(srcPath, f), path.join(destDir, f));
            }
        } else {
            fs.copyFileSync(srcPath, path.join(vendorDest, file));
        }
    }
}

// --- CSS読み込み ---
const stylesContent = fs.readFileSync(stylesPath, 'utf-8')
    .replace('__FONT_SIZE__', '14');
const outlinerCss = fs.readFileSync(outlinerCssPath, 'utf-8')
    .replace('__FONT_SIZE__', '14');
const tokensCss = fs.existsSync(tokensCssPath) ? fs.readFileSync(tokensCssPath, 'utf-8') : '';
const frBaseCss = fs.existsSync(frBaseCssPath) ? fs.readFileSync(frBaseCssPath, 'utf-8') : '';
const frComponentsCss = fs.existsSync(frComponentsCssPath) ? fs.readFileSync(frComponentsCssPath, 'utf-8') : '';

// Notes左パネルCSS+HTML
const notesBodyHtml = require(notesBodyHtmlPath);
const { css: notesCss, html: notesHtml } = notesBodyHtml.generateNotesFilePanelHtml({
    collapsed: false,
    messages: {},
});

// --- スクリプト読み込み ---
const editorUtilsScript = fs.readFileSync(editorUtilsJsPath, 'utf-8');
// harness gap fix (sprint 20260727-102631): production (webviewContent.ts:121-124) と同じく
// html-md-converter bundle (turndown + GFM + Fractal rule) を inline。旧 vendor/turndown*.js は
// bundle に含まれる (かつ test/html/vendor に実体が無く 404 だった) ため script src を置換。
const htmlMdConverterScript = fs.readFileSync(path.join(__dirname, '../src/webview/html-md-converter.js'), 'utf-8');

let editorScript = fs.readFileSync(editorJsPath, 'utf-8');
editorScript = editorScript
    .replace('__DEBUG_MODE__', 'false')
    .replace('__I18N__', '{}')
    .replace('__DOCUMENT_BASE_URI__', '')
    .replace('__IS_OUTLINER_PAGE__', 'true')
    .replace('__CONTENT__', `'(unused)'`);

const sidePanelBridgeScript = fs.readFileSync(sidePanelBridgePath, 'utf-8');
const linkParserScript = fs.readFileSync(linkParserPath, 'utf-8');
const clipSelectScript = fs.readFileSync(clipSelectPath, 'utf-8');
const outlinerCellScript = fs.readFileSync(outlinerCellJsPath, 'utf-8');
const outlinerModelScript = fs.readFileSync(outlinerModelJsPath, 'utf-8');
const outlinerSearchScript = fs.readFileSync(outlinerSearchJsPath, 'utf-8');
const outlinerScript = fs.readFileSync(outlinerJsPath, 'utf-8');
const notesColorPaletteScript = fs.readFileSync(notesColorPaletteJsPath, 'utf-8');
// sprint 20260724-160000: インライン文字色 共有 core + ピッカー
const inlineColorScript = fs.readFileSync(path.join(__dirname, '../src/shared/inline-color.js'), 'utf-8');
const inlineColorPickerScript = fs.readFileSync(path.join(__dirname, '../src/shared/inline-color-picker.js'), 'utf-8');
// FR-B04 / FR-B06: In-App link 生成の共有純関数（window.InAppLinkUtils）。notes-file-panel / editor / outliner が消費するため前に注入。
const inAppLinkUtilsScript = fs.readFileSync(path.join(__dirname, '../src/shared/inapp-link-utils.js'), 'utf-8');
const notesFilePanelScript = fs.readFileSync(notesFilePanelJsPath, 'utf-8');
// FR-LR-03: md メインペイン dispatcher（externalUpdate in-place）。本番 notesWebviewContent と同じ実体を inline
// （standalone build は body/script をハードコードするため src 変更だけでは反映されない — designer_failures 2026-07-12）
const notesMdDispatcherScript = fs.readFileSync(path.join(__dirname, '../src/shared/notes-md-dispatcher.js'), 'utf-8');
// FR-HP: 最近開いたファイル履歴パネル（本番 notesWebviewContent と同じ実体を inline）
const notesHistoryPanelScript = fs.readFileSync(path.join(__dirname, '../src/shared/notes-history-panel.js'), 'utf-8');
// sprint 20260723-233506: webview 内マルチタブ Tab Manager（本番 notesWebviewContent と同じ実体を inline）
const notesTabManagerScript = fs.readFileSync(path.join(__dirname, '../src/shared/notes-tab-manager.js'), 'utf-8');

// サイドパネルHTML生成
const { generateSidePanelHtml, generateEditorBodyHtml } = require(editorBodyHtmlPath);
const sidePanelHtml = generateSidePanelHtml({});
// TC-RR-46: notes md ペイン（EditorInstance を構築して editor.js の click listener を document に登録させ、
// cross-script 二重発火の load-bearing 条件を成立させるため）。production notesWebviewContent と同じ markdownPaneHtml。
const markdownPaneHtml = generateEditorBodyHtml({}, process.platform, { includeSidePanel: false });

// --- テスト用 HostBridge モック (notes-host-bridge.js 相当) ---
const testNotesHostBridge = `
(function() {
    window.__testApi = {
        messages: [],
        ready: false,
        lastSyncData: null,
        notesMessages: []
    };

    var currentFileChangeId = 0;

    var postFn = function(msg) { window.__testApi.messages.push(msg); };

    // 共通メソッド
    var shared = window.__createSidePanelBridgeMethods(postFn);

    // outliner.js 用ブリッジ
    window.outlinerHostBridge = Object.assign(shared, {
        syncData: function(jsonString) {
            var msg = { type: 'syncData', content: jsonString, fileChangeId: currentFileChangeId };
            window.__testApi.messages.push(msg);
            window.__testApi.lastSyncData = jsonString;
        },
        makePage: function(nodeId, pageId, title) {
            window.__testApi.messages.push({ type: 'makePage', nodeId: nodeId, pageId: pageId, title: title });
        },
        openPage: function(nodeId, pageId) {
            window.__testApi.messages.push({ type: 'openPage', nodeId: nodeId, pageId: pageId });
        },
        removePage: function(nodeId, pageId) {
            window.__testApi.messages.push({ type: 'removePage', nodeId: nodeId, pageId: pageId });
        },
        copyPageFile: function(sourcePageId, newPageId) {
            window.__testApi.messages.push({ type: 'copyPageFile', sourcePageId: sourcePageId, newPageId: newPageId });
        },
        copyPageFileCross: function(sourcePageId, newPageId, clipboardPlainText) {
            window.__testApi.messages.push({ type: 'copyPageFileCross', sourcePageId: sourcePageId, newPageId: newPageId, clipboardPlainText: clipboardPlainText });
        },
        movePageFileCross: function(pageId, clipboardPlainText) {
            window.__testApi.messages.push({ type: 'movePageFileCross', pageId: pageId, clipboardPlainText: clipboardPlainText });
        },
        copyImagesCross: function(images, clipboardPlainText) {
            window.__testApi.messages.push({ type: 'copyImagesCross', images: images, clipboardPlainText: clipboardPlainText });
        },
        saveOutlinerClipboard: function(plainText, isCut, nodes) {
            window.__testApi.messages.push({ type: 'saveOutlinerClipboard', plainText: plainText, isCut: isCut, nodes: nodes });
        },
        setPageDir: function() {
            window.__testApi.messages.push({ type: 'setPageDir' });
        },
        openPageInSidePanel: function(nodeId, pageId) {
            window.__testApi.messages.push({ type: 'openPageInSidePanel', nodeId: nodeId, pageId: pageId });
        },
        openInTextEditor: function() {
            window.__testApi.messages.push({ type: 'openInTextEditor' });
        },
        copyFilePath: function() {
            window.__testApi.messages.push({ type: 'copyFilePath' });
        },
        copyPagePaths: function(pageIds) {
            window.__testApi.messages.push({ type: 'copyPagePaths', pageIds: pageIds });
        },
        createPageAtPath: function() {},
        createPageAuto: function() {},
        updatePageH1: function() {},
        postDailyNotes: function(type, dayOffset, currentDate) {
            window.__testApi.messages.push({ type: 'postDailyNotes', subType: type, dayOffset: dayOffset, currentDate: currentDate });
        },
        importMdFilesDialog: function(targetNodeId) {
            window.__testApi.messages.push({ type: 'importMdFilesDialog', targetNodeId: targetNodeId });
        },
        showConfirm: function(id, message) {
            window.__testApi.messages.push({ type: 'showConfirm', id: id, message: message });
        },
        onMessage: function(handler) {
            // FR (cross-instance E2E): 本番は複数 instance（md pane + outliner/sidepanel）が各々 window message を
            // 受信する（2 系統受信）。singleton だと後勝ちで 1 本しか残らず 2 系統受信を再現できない（tautology）。
            // → 配列に push して全 handler へ配送する。後方互換: 既存 25+ spec が window.__hostMessageHandler(msg) を
            // callable として直接呼ぶため、__hostMessageHandler は「全 handler へ配送する関数」として残す（undefined にしない）。
            window.__hostMessageHandlers = window.__hostMessageHandlers || [];
            window.__hostMessageHandlers.push(handler);
            window.__hostMessageHandler = function(msg) {
                if (msg && msg.type === 'updateData' && msg.fileChangeId !== undefined) {
                    currentFileChangeId = msg.fileChangeId;
                }
                window.__hostMessageHandlers.forEach(function(h) { h(msg); });
            };
        }
    });

    // notes-file-panel.js 用ブリッジ
    window.notesHostBridge = {
        openFile: function(filePath) {
            if (window.Outliner && window.Outliner.flushSync) {
                window.Outliner.flushSync();
            }
            window.__testApi.notesMessages.push({ type: 'openFile', filePath: filePath });
        },
        // sprint 20260725: 左ツリー右クリック「Open in new tab」用モック
        openFileInTab: function(filePath) {
            window.__testApi.notesMessages.push({ type: 'openFileInTab', filePath: filePath });
        },
        createFile: function(title, parentId) {
            window.__testApi.notesMessages.push({ type: 'createFile', title: title, parentId: parentId });
        },
        deleteFile: function(filePath) {
            window.__testApi.notesMessages.push({ type: 'deleteFile', filePath: filePath });
        },
        renameTitle: function(filePath, newTitle) {
            window.__testApi.notesMessages.push({ type: 'renameTitle', filePath: filePath, newTitle: newTitle });
        },
        togglePanel: function(collapsed) {
            window.__testApi.notesMessages.push({ type: 'togglePanel', collapsed: collapsed });
        },
        createFolder: function(title, parentId) {
            window.__testApi.notesMessages.push({ type: 'createFolder', title: title, parentId: parentId });
        },
        deleteFolder: function(folderId) {
            window.__testApi.notesMessages.push({ type: 'deleteFolder', folderId: folderId });
        },
        renameFolder: function(folderId, newTitle) {
            window.__testApi.notesMessages.push({ type: 'renameFolder', folderId: folderId, newTitle: newTitle });
        },
        toggleFolder: function(folderId) {
            window.__testApi.notesMessages.push({ type: 'toggleFolder', folderId: folderId });
        },
        moveItem: function(itemId, targetParentId, index) {
            window.__testApi.notesMessages.push({ type: 'moveItem', itemId: itemId, targetParentId: targetParentId, index: index });
        },
        // node-move-to-other-outliner: E2E 用モック（file-panel drop が呼ぶ）
        notesImportOutPageNodeAsMd: function(payload, parentId, index) {
            window.__testApi.notesMessages.push({ type: 'notesImportOutPageNodeAsMd', payload: payload, parentId: parentId, index: index });
        },
        notesImportMdIntoOut: function(mdFileId, targetOutId) {
            window.__testApi.notesMessages.push({ type: 'notesImportMdIntoOut', mdFileId: mdFileId, targetOutId: targetOutId });
        },
        notesMoveOutNodeSubtreeIntoOut: function(payload, targetOutFilePath) {
            window.__testApi.notesMessages.push({ type: 'notesMoveOutNodeSubtreeIntoOut', payload: payload, targetOutFilePath: targetOutFilePath });
        },
        openDailyNotes: function() {
            window.__testApi.notesMessages.push({ type: 'openDailyNotes' });
        },
        navigateDailyNotes: function(dayOffset, currentDate) {
            window.__testApi.notesMessages.push({ type: 'navigateDailyNotes', dayOffset: dayOffset, currentDate: currentDate });
        },
        savePanelWidth: function(width) {
            window.__testApi.notesMessages.push({ type: 'savePanelWidth', width: width });
        },
        setItemColor: function(itemId, color) {
            window.__testApi.notesMessages.push({ type: 'setItemColor', itemId: itemId, color: color });
        },
        search: function() {},
        jumpToNode: function() {},
        jumpToMdPage: function() {},
        openMdFileExternal: function() {},
        onSearchStart: function() {},
        onSearchPartial: function() {},
        onSearchEnd: function() {},
        onFileListChanged: function(handler) {
            window.__notesFileListHandler = handler;
        },
        s3Sync: function() {},
        s3RemoteDeleteAndUpload: function() {},
        s3LocalDeleteAndDownload: function() {},
        s3SaveBucketPath: function() {},
        s3GetStatus: function() {},
        onS3Progress: function() {},
        onS3Status: function() {}
    };

    // テスト用ヘルパー: fileChangeId更新シミュレーション
    window.__testApi.setFileChangeId = function(id) {
        currentFileChangeId = id;
    };
})();
`;

// --- HTMLテンプレート ---
const html = `<!DOCTYPE html>
<html lang="en" data-theme="github" data-fr-theme="auto">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Standalone Notes Test</title>
    <style>${tokensCss}</style>
    <style>${frBaseCss}</style>
    <style>${frComponentsCss}</style>
    <style>${stylesContent}</style>
    <style>${outlinerCss}</style>
    <style>${notesCss}</style>
</head>
<body>
    <div class="notes-layout" data-note-folder-name="">
        ${notesHtml}
        <div class="notes-main-wrapper">
            <!-- sprint 20260723-233506: webview 内タブ bar（本番 notesWebviewContent.ts:193 と同位置。tabs>=2 で表示） -->
            <div class="notes-tab-bar" id="notesTabBar" style="display:none;"></div>
            <div class="outliner-container">
                <!-- ★本番と同じ 3 段（container > scroll-content > tree）。scroll owner = .outliner-scroll-content -->
                <div class="outliner-scroll-content">
                    <div class="outliner-page-title">
                        <input type="text" class="outliner-page-title-input" placeholder="Untitled" />
                    </div>
                    <div class="outliner-scope-search-indicator" style="display:none"><span class="outliner-scope-search-tag"></span></div>
                    <div class="outliner-search-bar">
                        <button class="notes-panel-toggle-btn" id="notesPanelToggleBtn" title="Show file panel"></button>
                        <button class="outliner-nav-back-btn" title="Back" disabled></button>
                        <button class="outliner-nav-forward-btn" title="Forward" disabled></button>
                        <button class="outliner-search-mode-toggle" title="Toggle search mode: Tree / Focus"></button>
                        <div class="outliner-search-input-wrapper">
                            <input type="text" class="outliner-search-input" placeholder="Search..." />
                            <button class="outliner-search-clear-btn" style="display:none" title="Clear search"></button>
                        </div>
                        <button class="outliner-undo-btn" title="Undo" disabled></button>
                        <button class="outliner-redo-btn" title="Redo" disabled></button>
                        <button class="outliner-menu-btn" title="Menu"></button>
                    </div>
                    <div class="outliner-pinned-nav-bar">
                        <div class="outliner-daily-nav-area" style="display:none">
                            <button class="outliner-daily-btn" id="dailyNavToday">Today</button>
                            <button class="outliner-daily-btn outliner-daily-btn-sm" id="dailyNavPrev">&lt;</button>
                            <button class="outliner-daily-btn outliner-daily-btn-sm" id="dailyNavNext">&gt;</button>
                            <button class="outliner-daily-btn outliner-daily-btn-sm" id="dailyNavCalendar"></button>
                            <div class="outliner-daily-picker" id="dailyNavPicker" style="display:none">
                                <div class="outliner-daily-picker-header">
                                    <button class="outliner-daily-picker-nav" id="dailyPickerPrevMonth">&lt;</button>
                                    <span class="outliner-daily-picker-title" id="dailyPickerTitle"></span>
                                    <button class="outliner-daily-picker-nav" id="dailyPickerNextMonth">&gt;</button>
                                </div>
                                <div class="outliner-daily-picker-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
                                <div class="outliner-daily-picker-grid" id="dailyPickerGrid"></div>
                            </div>
                        </div>
                        <div class="outliner-pinned-tags-area"></div>
                        <div class="outliner-pinned-nav-spacer"></div>
                        <button class="outliner-pinned-settings-btn" title="Pinned tag settings"></button>
                    </div>
                    <div class="outliner-breadcrumb"></div>
                    <div class="outliner-tree" role="tree"></div>
                </div>
                <div class="fractal-resource-footer" style="display:none" data-rrf-template="{count} image(s) are outside the allowed folders and cannot be shown (e.g. {sample}).">
                    <span class="rrf-msg">Some images are outside the allowed folders and cannot be shown.</span>
                    <button class="rrf-open-settings" data-action="openResourceRootsSettings">Change allowed folders</button>
                </div>
            </div>
            <div class="markdown-container" style="display:none">
                ${markdownPaneHtml}
            </div>
            <!-- sprint 20260724-042927 (FR-SPC-01): サイドパネルを .notes-main-wrapper 内に配置（本番と同位置） -->
            ${sidePanelHtml}
        </div>
    </div>

    <!-- editor.js のサイドパネル用に必要な隠しDOM要素 -->
    <div class="sidebar" id="sidebar" style="display:none;"><div class="outline" id="outline"></div></div>
    <div class="sidebar-resizer" id="sidebarResizer" style="display:none;"></div>
    <div class="toolbar" id="toolbar" style="display:none;"></div>
    <div id="statusLeft" style="display:none;"></div>
    <div class="sidebar-status-imagedir" id="statusImageDir" style="display:none;"></div>
    <div class="word-count" id="wordCount" style="display:none;"></div>
    <div class="source-editor" id="sourceEditor" style="display:none;"></div>
    <button class="sidebar-toggle" id="closeSidebar" style="display:none;"></button>
    <button data-action="openOutline" id="openSidebarBtn" style="display:none;"></button>
    <div class="search-replace-box" id="searchReplaceBox" style="display:none;">
        <input class="search-input" id="searchInput" type="text">
        <input class="replace-input" id="replaceInput" type="text">
        <span class="search-count" id="searchCount"></span>
        <button class="search-prev" id="searchPrev"></button>
        <button class="search-next" id="searchNext"></button>
        <button class="toggle-replace" id="toggleReplace"></button>
        <button class="close-search" id="closeSearch"></button>
        <div class="replace-row" id="replaceRow">
            <button class="replace-one" id="replaceOne"></button>
            <button class="replace-all" id="replaceAll"></button>
        </div>
        <input class="search-case-sensitive" id="searchCaseSensitive" type="checkbox">
        <input class="search-whole-word" id="searchWholeWord" type="checkbox">
        <input class="search-regex" id="searchRegex" type="checkbox">
    </div>
    <div class="editor" id="editor" contenteditable="true" spellcheck="false" style="display:none;"></div>

    <script>
    __HTML_MD_CONVERTER_SCRIPT__
    </script>
    <script src="vendor/mermaid.min.js"></script>

    <script>
    window.__SKIP_EDITOR_AUTO_INIT__ = true;
    window.__outlinerMessages = {};
    window.__initialFileChangeId = 0;
    </script>
    <script>
    __LINK_PARSER_SCRIPT__
    </script>
    <script>
    __SIDEPANEL_BRIDGE__
    </script>
    <script>
    __TEST_HOST_BRIDGE__
    </script>
    <script>
    __EDITOR_UTILS_SCRIPT__
    </script>
    <script>
    __NOTES_COLOR_PALETTE_SCRIPT__
    </script>
    <script>
    __INLINE_COLOR_SCRIPT__
    </script>
    <script>
    __INLINE_COLOR_PICKER_SCRIPT__
    </script>
    <script>
    __INAPP_LINK_UTILS_SCRIPT__
    </script>
    <script>
    __EDITOR_SCRIPT__
    </script>
    <script>
    __OUTLINER_CELL_SCRIPT__
    </script>
    <script>
    __OUTLINER_MODEL_SCRIPT__
    </script>
    <script>
    __OUTLINER_SEARCH_SCRIPT__
    </script>
    <script>
    __CLIP_SELECT_SCRIPT__
    </script>
    <script>
    __OUTLINER_SCRIPT__
    </script>
    <script>
    __NOTES_FILE_PANEL_SCRIPT__
    </script>
    <script>
    __NOTES_MD_DISPATCHER_SCRIPT__
    </script>
    <script>
    __NOTES_HISTORY_PANEL_SCRIPT__
    </script>
    <script>
    __NOTES_TAB_MANAGER_SCRIPT__
    </script>
    <script>
    // テストAPI公開
    window.__testApi.ready = false;
    window.__testApi.initOutliner = function(data) {
        var defaultData = { version: 1, rootIds: [], nodes: {} };
        Outliner.init(data || defaultData);
        window.__testApi.ready = true;
    };
    window.__testApi.initNotesPanel = function(fileList, currentFile, structure, panelWidth, noteFolderName) {
        // FR-B04/FR-B06: 本番 notesWebviewContent と同じく noteFolderName を file-panel と
        // .notes-layout dataset の双方へ渡す（両者とも path.basename(folderPath) = 同値）。
        var folderName = noteFolderName || '';
        var layoutEl = document.querySelector('.notes-layout');
        if (layoutEl) layoutEl.dataset.noteFolderName = folderName;
        notesFilePanel.init(
            window.notesHostBridge,
            fileList || [],
            currentFile || null,
            structure || null,
            panelWidth || null,
            folderName
        );
    };
    window.__testApi.getSerializedData = function() {
        if (window.__testApi.lastSyncData) {
            return JSON.parse(window.__testApi.lastSyncData);
        }
        return null;
    };
    // TC-RR-46: md ペインの EditorInstance を構築して editor.js の document click listener を
    // 登録させる（production notes モードと同じ「outliner.js + editor.js を同一 document に両ロード」状態を
    // 再現）。これで .rrf-open-settings の cross-script 二重発火の load-bearing 条件が成立する。
    window.__testApi.loadMarkdownPane = function(text) {
        var mc = document.querySelector('.markdown-container');
        if (!mc || !window.EditorInstance) return;
        mc.style.display = '';
        new window.EditorInstance(mc, window.outlinerHostBridge, {
            initialContent: text || '',
            filePath: null,
            documentBaseUri: '',
            sidebarHidden: true,
        });
    };
    // FR-LR-03: production notesWebviewContent と同じ md dispatcher を初期化。
    // bridge は production の notesMarkdownHostBridge 相当（onMessage は test bridge の配列登録を共有）。
    // standalone の message 配送は window event 非経由（__hostMessageHandler → handlers 配列直呼び）のため、
    // subscribe / deliverUpdate とも配列経由を注入する（本番は既定の window listener / window.postMessage）。
    window.notesMarkdownHostBridge = Object.assign({}, window.outlinerHostBridge, {
        // 本番 notes-host-bridge.js の notesMarkdownHostBridge 相当（editor.js の編集/idle 経路が呼ぶ）
        syncContent: function(markdown) {
            // fileChangeId は test bridge IIFE のクロージャ内なのでここでは 0 固定（テストで参照しない）
            window.__testApi.messages.push({ type: 'notesSaveCurrentMd', content: markdown, fileChangeId: 0 });
        },
        save: function() { window.__testApi.messages.push({ type: 'save' }); },
        reportEditingState: function(editing) {
            window.__testApi.messages.push({ type: 'editingStateChanged', editing: editing });
        },
    });
    window.__testApi.mdDispatcher = window.__initNotesMdDispatcher({
        outlinerContainer: document.querySelector('.outliner-container'),
        markdownContainer: document.querySelector('.markdown-container'),
        bridge: window.notesMarkdownHostBridge,
        subscribe: function(handler) {
            window.__hostMessageHandlers = window.__hostMessageHandlers || [];
            window.__hostMessageHandlers.push(handler);
        },
        deliverUpdate: function(msg) { window.__hostMessageHandler(msg); },
    });
    // FR-HP: 最近開いたファイル履歴パネル（test bridge は messages 記録）。
    // 履歴データは __testApi.loadHistory で注入可能。
    window.__testApi.initHistoryPanel = function(history, height, collapsed) {
        window.__notesHistoryPanel = window.__initNotesHistoryPanel({
            panelEl: document.getElementById('sidePanelHistory'),
            listEl: document.getElementById('sidePanelHistoryList'),
            toggleEl: document.getElementById('sidePanelHistoryToggle'),
            resizeHandleEl: document.getElementById('sidePanelHistoryResizeHandle'),
            bridge: {
                openFile: function(id) { window.__testApi.messages.push({ type: 'notesOpenFile', filePath: id }); },
                saveHistoryPanelCollapsed: function(c) { window.__testApi.messages.push({ type: 'notesSaveHistoryPanelCollapsed', collapsed: c }); },
                saveHistoryPanelHeight: function(h) { window.__testApi.messages.push({ type: 'notesSaveHistoryPanelHeight', height: h }); },
            },
            initialHistory: history || [],
            initialHeight: (typeof height === 'number' ? height : null),
            initialCollapsed: !!collapsed,
        });
        return window.__notesHistoryPanel;
    };
    // sprint 20260723-233506: Tab Manager（webview 内マルチタブ）。E2E から driveできるよう __testApi に露出。
    // scroll owner は本番同様 kind で .outliner-scroll-content / .editor-wrapper を返す。
    window.__testApi.initTabManager = function() {
        function activeKind() {
            var oc = document.querySelector('.outliner-container');
            return (oc && oc.style.display !== 'none') ? 'out' : 'md';
        }
        window.__testApi.tabManager = window.__initNotesTabManager({
            tabBarEl: document.getElementById('notesTabBar'),
            getActiveMainScrollEl: function() {
                return activeKind() === 'out'
                    ? document.querySelector('.outliner-scroll-content')
                    : document.querySelector('.markdown-container .editor-wrapper');
            },
            bridge: {
                openFile: function(fp) { window.__testApi.messages.push({ type: 'notesOpenFile', filePath: fp }); },
                flushActive: function() { window.__testApi.messages.push({ type: 'notesFlushActive' }); },
                restoreSidePanel: function(fp) { window.__testApi.messages.push({ type: 'notesRestoreSidePanel', filePath: fp }); },
                closeSidePanel: function() { window.__testApi.messages.push({ type: 'sidePanelClosed' }); },
                openInVscodeTab: function(fp) { window.__testApi.messages.push({ type: 'notesOpenInVscodeTab', filePath: fp }); },
            },
            flushActiveWebview: function() { window.__testApi.messages.push({ type: 'flushActiveWebview' }); },
            captureOutlinerView: function() {
                return (window.Outliner && window.Outliner.captureView) ? window.Outliner.captureView() : null;
            },
            applyOutlinerView: function(v) {
                if (window.Outliner && window.Outliner.applyView) window.Outliner.applyView(v);
            },
            captureSidePanel: function() {
                return window.__testApi.sidePanelState || { open: false, filePath: null, scrollTop: 0 };
            },
            getSidePanelScrollEl: function() { return document.querySelector('.side-panel .editor-wrapper'); },
            closeSidePanelInWebview: function() { window.__testApi.messages.push({ type: 'closeSidePanelInWebview' }); },
        });
        return window.__testApi.tabManager;
    };
    // 空データで初期化
    window.__testApi.initOutliner();
    window.__testApi.initNotesPanel();
    </script>
</body>
</html>`;

var safeReplace = function(str, token, value) { return str.replace(token, function() { return value; }); };
var result = html;
result = safeReplace(result, '__HTML_MD_CONVERTER_SCRIPT__', htmlMdConverterScript);
result = safeReplace(result, '__LINK_PARSER_SCRIPT__', linkParserScript);
result = safeReplace(result, '__SIDEPANEL_BRIDGE__', sidePanelBridgeScript);
result = safeReplace(result, '__TEST_HOST_BRIDGE__', testNotesHostBridge);
result = safeReplace(result, '__EDITOR_UTILS_SCRIPT__', editorUtilsScript);
result = safeReplace(result, '__EDITOR_SCRIPT__', editorScript);
result = safeReplace(result, '__OUTLINER_CELL_SCRIPT__', outlinerCellScript);
result = safeReplace(result, '__OUTLINER_MODEL_SCRIPT__', outlinerModelScript);
result = safeReplace(result, '__OUTLINER_SEARCH_SCRIPT__', outlinerSearchScript);
result = safeReplace(result, '__CLIP_SELECT_SCRIPT__', clipSelectScript);
result = safeReplace(result, '__OUTLINER_SCRIPT__', outlinerScript);
result = safeReplace(result, '__NOTES_COLOR_PALETTE_SCRIPT__', notesColorPaletteScript);
result = safeReplace(result, '__INLINE_COLOR_SCRIPT__', inlineColorScript);
result = safeReplace(result, '__INLINE_COLOR_PICKER_SCRIPT__', inlineColorPickerScript);
result = safeReplace(result, '__INAPP_LINK_UTILS_SCRIPT__', inAppLinkUtilsScript);
result = safeReplace(result, '__NOTES_FILE_PANEL_SCRIPT__', notesFilePanelScript);
result = safeReplace(result, '__NOTES_MD_DISPATCHER_SCRIPT__', notesMdDispatcherScript);
result = safeReplace(result, '__NOTES_HISTORY_PANEL_SCRIPT__', notesHistoryPanelScript);
result = safeReplace(result, '__NOTES_TAB_MANAGER_SCRIPT__', notesTabManagerScript);
fs.writeFileSync(outputPath, result);

console.log('Generated:', outputPath);
