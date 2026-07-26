/**
 * Outliner スタンドアロンテスト用HTMLを生成するビルドスクリプト
 *
 * 使用方法:
 *   node test/build-standalone-outliner.js
 *
 * outliner.js + outliner-model.js + outliner-search.js を読み込んで
 * test/html/standalone-outliner.html に出力
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
// Mindmap Mode (sprint 20260701-122355)
const mindmapModelJsPath = path.join(__dirname, '../src/webview/mindmap-model.js');
const mindmapLayoutJsPath = path.join(__dirname, '../src/webview/mindmap-layout.js');
const mindmapRenderJsPath = path.join(__dirname, '../src/webview/mindmap-render.js');
const mindmapExportJsPath = path.join(__dirname, '../src/webview/mindmap-export.js');
const mindmapInteractionsJsPath = path.join(__dirname, '../src/webview/mindmap-interactions.js');
const mindmapCssPath = path.join(__dirname, '../src/webview/mindmap.css');
const outlinerCssPath = path.join(__dirname, '../src/webview/outliner.css');
const stylesPath = path.join(__dirname, '../src/webview/styles.css');
const tokensCssPath = path.join(__dirname, '../src/webview/tokens.css');
const frBaseCssPath = path.join(__dirname, '../src/webview/fr-base.css');
const frComponentsCssPath = path.join(__dirname, '../src/webview/fr-components.css');
const sidePanelBridgePath = path.join(__dirname, '../src/shared/sidepanel-bridge-methods.js');
const linkParserPath = path.join(__dirname, '../src/shared/markdown-link-parser.js');
const clipSelectPath = path.join(__dirname, '../src/webview/outliner-clip-select.js');
const editorBodyHtmlPath = path.join(__dirname, '../src/shared/editor-body-html.js');
const outputPath = path.join(__dirname, 'html/standalone-outliner.html');

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
const tokensCss = fs.existsSync(tokensCssPath) ? fs.readFileSync(tokensCssPath, 'utf-8') : '';
const frBaseCss = fs.existsSync(frBaseCssPath) ? fs.readFileSync(frBaseCssPath, 'utf-8') : '';
const frComponentsCss = fs.existsSync(frComponentsCssPath) ? fs.readFileSync(frComponentsCssPath, 'utf-8') : '';
const stylesContent = fs.readFileSync(stylesPath, 'utf-8')
    .replace('__FONT_SIZE__', '14');
const outlinerCss = fs.readFileSync(outlinerCssPath, 'utf-8')
    .replace('__FONT_SIZE__', '14');

// --- スクリプト読み込み ---
const editorUtilsScript = fs.readFileSync(editorUtilsJsPath, 'utf-8');
// sprint 20260724-160000: インライン文字色 共有 core + パレット + ピッカー
const inlineColorScript = fs.readFileSync(path.join(__dirname, '../src/shared/inline-color.js'), 'utf-8');
const colorPaletteScript = fs.readFileSync(path.join(__dirname, '../src/shared/notes-color-palette.js'), 'utf-8');
const inlineColorPickerScript = fs.readFileSync(path.join(__dirname, '../src/shared/inline-color-picker.js'), 'utf-8');

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
// Mindmap Mode scripts + css
const mindmapModelScript = fs.readFileSync(mindmapModelJsPath, 'utf-8');
const mindmapLayoutScript = fs.readFileSync(mindmapLayoutJsPath, 'utf-8');
const mindmapRenderScript = fs.readFileSync(mindmapRenderJsPath, 'utf-8');
const mindmapExportScript = fs.readFileSync(mindmapExportJsPath, 'utf-8');
const mindmapInteractionsScript = fs.readFileSync(mindmapInteractionsJsPath, 'utf-8');
const mindmapCss = fs.existsSync(mindmapCssPath) ? fs.readFileSync(mindmapCssPath, 'utf-8') : '';

// サイドパネルHTML生成
const { generateSidePanelHtml } = require(editorBodyHtmlPath);
const sidePanelHtml = generateSidePanelHtml({});

// --- テスト用 HostBridge モック ---
const testOutlinerHostBridge = `
(function() {
    window.__testApi = {
        messages: [],
        ready: false,
        lastSyncData: null,
        getModel: null,
        getTree: null
    };

    var postFn = function(msg) { window.__testApi.messages.push(msg); };

    // 共通メソッド
    var shared = window.__createSidePanelBridgeMethods(postFn);

    window.outlinerHostBridge = Object.assign(shared, {
        syncData: function(jsonString) {
            window.__testApi.messages.push({ type: 'syncData', content: jsonString });
            window.__testApi.lastSyncData = jsonString;
        },
        // Mindmap Mode (sprint 20260701-122355): export mock (#M1). TC-223/224/225 は
        // window.__testApi.messages にこの msg が積まれることで検証する。
        exportMindmap: function(format, payload, suggestedName) {
            window.__testApi.messages.push({ type: 'exportMindmap', format: format, payload: payload, suggestedName: suggestedName });
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
        handlePageAssetsCross: function(pageId, newPageId, clipboardPlainText, targetNodeId, nodeImages, isCut) {
            window.__testApi.messages.push({ type: 'handlePageAssetsCross', pageId: pageId, newPageId: newPageId, clipboardPlainText: clipboardPlainText, targetNodeId: targetNodeId, nodeImages: nodeImages || [], isCut: !!isCut });
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
        // FR-OL-COPYPATH-1: file 添付ノードの絶対 path コピー (テストモック)
        copyAttachedFilePath: function(nodeId) {
            window.__testApi.messages.push({ type: 'copyAttachedFilePath', nodeId: nodeId });
        },
        createPageAtPath: function() {},
        createPageAuto: function() {},
        updatePageH1: function() {},
        postDailyNotes: function() {},
        saveOutlinerImage: function(nodeId, dataUrl, fileName) {
            window.__testApi.messages.push({ type: 'saveOutlinerImage', nodeId: nodeId, dataUrl: dataUrl, fileName: fileName });
            // テスト用: 即座にモデルに追加して返す
            var mockPath = './images/' + (fileName || 'test_image.png');
            if (window.__hostMessageHandler) {
                window.__hostMessageHandler({
                    type: 'outlinerImageSaved',
                    nodeId: nodeId,
                    imagePath: mockPath,
                    displayUri: dataUrl
                });
            }
        },
        importMdFilesDialog: function(targetNodeId) {
            window.__testApi.messages.push({ type: 'importMdFilesDialog', targetNodeId: targetNodeId });
        },
        // FR-MM-FD: mindmap 外部ファイル D&D の E2E 用。本番 provider の代わりに messages に記録するだけ
        //   （targetNodeId + position の検証。これが無いと mindmap の drop リスナーが呼んでも undefined で hard error）。
        dropFilesImport: function(imports, targetNodeId, position) {
            window.__testApi.messages.push({ type: 'dropFilesImport', imports: imports, targetNodeId: targetNodeId, position: position });
        },
        dropVscodeUrisImport: function(uris, targetNodeId, position) {
            window.__testApi.messages.push({ type: 'dropVscodeUrisImport', uris: uris, targetNodeId: targetNodeId, position: position });
        },
        importFilesDialog: function(targetNodeId) {
            window.__testApi.messages.push({ type: 'importFilesDialog', targetNodeId: targetNodeId });
        },
        openAttachedFile: function(nodeId) {
            window.__testApi.messages.push({ type: 'openAttachedFile', nodeId: nodeId });
        },
        handleFileAssetCross: function(filePath, clipboardPlainText, nodeId, isCut) {
            window.__testApi.messages.push({ type: 'handleFileAssetCross', filePath: filePath, clipboardPlainText: clipboardPlainText, nodeId: nodeId, isCut: !!isCut });
        },
        setOutlinerImageDir: function() {
            window.__testApi.messages.push({ type: 'setOutlinerImageDir' });
        },
        getOutlinerImageDir: function() {
            window.__testApi.messages.push({ type: 'getOutlinerImageDir' });
        },
        showConfirm: function(id, message) {
            window.__testApi.messages.push({ type: 'showConfirm', id: id, message: message });
        },
        // TASK-B7: Switch view (Outliner ⇄ Table)
        requestReopenAs: function(viewType) {
            var vt = (viewType && typeof viewType === 'object') ? viewType.viewType : viewType;
            window.__testApi.messages.push({ type: 'requestReopenAs', viewType: vt });
        },
        onMessage: function(handler) {
            window.__hostMessageHandler = handler;
        }
    });
})();
`;

// --- HTMLテンプレート ---
const html = `<!DOCTYPE html>
<html lang="en" data-theme="github" data-fr-theme="auto">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Standalone Outliner Test</title>
    <style>${tokensCss}</style>
    <style>${frBaseCss}</style>
    <style>${frComponentsCss}</style>
    <style>${stylesContent}</style>
    <style>${outlinerCss}</style>
    <style>${mindmapCss}</style>
</head>
<body>
    <div class="outliner-container">
        <div class="outliner-page-title">
            <input type="text" class="outliner-page-title-input" placeholder="Untitled" />
        </div>
        <div class="outliner-scope-search-indicator" style="display:none"><span class="outliner-scope-search-tag"></span></div>
        <div class="outliner-search-bar">
            <button class="outliner-nav-back-btn" title="Back" disabled></button>
            <button class="outliner-nav-forward-btn" title="Forward" disabled></button>
            <button class="outliner-search-mode-toggle" title="Toggle search mode: Tree / Focus"></button>
            <div class="outliner-search-input-wrapper">
                <input type="text" class="outliner-search-input" placeholder="Search..." />
                <button class="outliner-search-clear-btn" style="display:none" title="Clear search"></button>
            </div>
            <button class="outliner-undo-btn" title="Undo" disabled></button>
            <button class="outliner-redo-btn" title="Redo" disabled></button>
            <button class="outliner-view-toggle-btn" title="Switch view"></button>
            <button class="outliner-task-mode-toggle-btn" title="Task Mode"></button>
            <button class="outliner-task-filter-toggle-btn" title="Filter"></button>
            <button class="outliner-archive-btn" title="Archive"></button>
            <button class="outliner-menu-btn" title="Menu"></button>
        </div>
        <div class="outliner-pinned-nav-bar">
            <div class="outliner-pinned-tags-area"></div>
            <div class="outliner-pinned-nav-spacer"></div>
            <button class="outliner-pinned-settings-btn" title="Pinned tag settings"></button>
        </div>
        <div class="outliner-breadcrumb"></div>
        <div class="outliner-tree" role="tree"></div>
        <div class="fractal-resource-footer" style="display:none" data-rrf-template="{count} image(s) are outside the allowed folders and cannot be shown (e.g. {sample}).">
            <span class="rrf-msg">Some images are outside the allowed folders and cannot be shown.</span>
            <button class="rrf-open-settings" data-action="openResourceRootsSettings">Change allowed folders</button>
        </div>
    </div>

    ${sidePanelHtml}

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

    <script src="vendor/turndown.js"></script>
    <script src="vendor/turndown-plugin-gfm.js"></script>
    <script src="vendor/mermaid.min.js"></script>
    <script src="vendor/d3-hierarchy.min.js"></script>
    <script src="vendor/d3-flextree.min.js"></script>

    <script>
    window.__SKIP_EDITOR_AUTO_INIT__ = true;
    window.__outlinerMessages = {};
    window.__outlinerImageBaseUri = '';
    </script>
    <script>
    __EDITOR_UTILS_SCRIPT__
    </script>
    <script>
    __COLOR_PALETTE_SCRIPT__
    </script>
    <script>
    __INLINE_COLOR_SCRIPT__
    </script>
    <script>
    __INLINE_COLOR_PICKER_SCRIPT__
    </script>
    <script>
    __EDITOR_SCRIPT__
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
    __OUTLINER_CELL_SCRIPT__
    </script>
    <script>
    __OUTLINER_MODEL_SCRIPT__
    </script>
    <script>
    __MINDMAP_MODEL_SCRIPT__
    </script>
    <script>
    __MINDMAP_LAYOUT_SCRIPT__
    </script>
    <script>
    __MINDMAP_RENDER_SCRIPT__
    </script>
    <script>
    __MINDMAP_EXPORT_SCRIPT__
    </script>
    <script>
    __MINDMAP_INTERACTIONS_SCRIPT__
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
    // テストAPI公開
    window.__testApi.ready = false;
    window.__testApi.initOutliner = function(data, outFileKey) {
        var defaultData = { version: 1, rootIds: [], nodes: {} };
        Outliner.init(data || defaultData, outFileKey);
        window.__testApi.ready = true;
    };
    window.__testApi.getSerializedData = function() {
        if (window.__testApi.lastSyncData) {
            return JSON.parse(window.__testApi.lastSyncData);
        }
        return null;
    };
    // Phase F: spec から Outliner.getModel() にアクセスするためのショートカット
    window.__testApi.getModel = function() { return Outliner.getModel(); };
    // FR-TH-05: sidepanel md 編集シミュレート（本番 syncContent 経路を通す）
    window.__testApi.editSidePanelMarkdown = function(md) {
        return Outliner.__editSidePanelMarkdownForTest ? Outliner.__editSidePanelMarkdownForTest(md) : false;
    };
    // 空データで初期化
    window.__testApi.initOutliner();
    </script>
</body>
</html>`;

// Use function-based replace to avoid $ patterns in JS content being interpreted
var safeReplace = function(str, token, value) { return str.replace(token, function() { return value; }); };
var result = html;
result = safeReplace(result, '__EDITOR_UTILS_SCRIPT__', editorUtilsScript);
result = safeReplace(result, '__COLOR_PALETTE_SCRIPT__', colorPaletteScript);
result = safeReplace(result, '__INLINE_COLOR_SCRIPT__', inlineColorScript);
result = safeReplace(result, '__INLINE_COLOR_PICKER_SCRIPT__', inlineColorPickerScript);
result = safeReplace(result, '__EDITOR_SCRIPT__', editorScript);
result = safeReplace(result, '__LINK_PARSER_SCRIPT__', linkParserScript);
result = safeReplace(result, '__SIDEPANEL_BRIDGE__', sidePanelBridgeScript);
result = safeReplace(result, '__TEST_HOST_BRIDGE__', testOutlinerHostBridge);
result = safeReplace(result, '__OUTLINER_CELL_SCRIPT__', outlinerCellScript);
result = safeReplace(result, '__OUTLINER_MODEL_SCRIPT__', outlinerModelScript);
result = safeReplace(result, '__MINDMAP_MODEL_SCRIPT__', mindmapModelScript);
result = safeReplace(result, '__MINDMAP_LAYOUT_SCRIPT__', mindmapLayoutScript);
result = safeReplace(result, '__MINDMAP_RENDER_SCRIPT__', mindmapRenderScript);
result = safeReplace(result, '__MINDMAP_EXPORT_SCRIPT__', mindmapExportScript);
result = safeReplace(result, '__MINDMAP_INTERACTIONS_SCRIPT__', mindmapInteractionsScript);
result = safeReplace(result, '__OUTLINER_SEARCH_SCRIPT__', outlinerSearchScript);
result = safeReplace(result, '__CLIP_SELECT_SCRIPT__', clipSelectScript);
result = safeReplace(result, '__OUTLINER_SCRIPT__', outlinerScript);
fs.writeFileSync(outputPath, result);

console.log('Generated:', outputPath);
