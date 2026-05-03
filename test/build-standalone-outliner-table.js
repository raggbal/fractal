/**
 * Outliner Table スタンドアロンテスト用 HTML を生成するビルドスクリプト
 *
 * 使用方法:
 *   node test/build-standalone-outliner-table.js
 *
 * outliner-cell.js + outliner-model.js + outliner-search.js + outliner-table.js を読み込んで
 * test/html/standalone-outliner-table.html に出力。
 *
 * design: design/system.md §4.5 / §4.6
 * test: TC-1101, TC-1102, TC-201, TC-202, TC-203, TC-204
 */

const fs = require('fs');
const path = require('path');

// --- ソースファイルパス ---
const outlinerCellJsPath = path.join(__dirname, '../src/webview/outliner-cell.js');
const outlinerModelJsPath = path.join(__dirname, '../src/webview/outliner-model.js');
const outlinerSearchJsPath = path.join(__dirname, '../src/webview/outliner-search.js');
const outlinerTableJsPath = path.join(__dirname, '../src/webview/outliner-table.js');
const outlinerTableCssPath = path.join(__dirname, '../src/webview/outliner-table.css');
const stylesPath = path.join(__dirname, '../src/webview/styles.css');
const linkParserPath = path.join(__dirname, '../src/shared/markdown-link-parser.js');
const outputPath = path.join(__dirname, 'html/standalone-outliner-table.html');

// vendor/ → test/html/vendor/ にコピー (既存 standalone-outliner と同じ)
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

// --- CSS 読み込み ---
const stylesContent = fs.readFileSync(stylesPath, 'utf-8')
    .replace('__FONT_SIZE__', '14');
const tableCss = fs.readFileSync(outlinerTableCssPath, 'utf-8');

// --- スクリプト読み込み ---
const linkParserScript = fs.readFileSync(linkParserPath, 'utf-8');
const outlinerCellScript = fs.readFileSync(outlinerCellJsPath, 'utf-8');
const outlinerModelScript = fs.readFileSync(outlinerModelJsPath, 'utf-8');
const outlinerSearchScript = fs.readFileSync(outlinerSearchJsPath, 'utf-8');
const outlinerTableScript = fs.readFileSync(outlinerTableJsPath, 'utf-8');

// --- テスト用 HostBridge モック (Table editor 用) ---
const testTableHostBridge = `
(function() {
    window.__testApi = {
        messages: [],
        ready: false,
        lastSyncData: null
    };

    var post = function(msg) { window.__testApi.messages.push(msg); };

    window.outlinerTableHostBridge = {
        syncData: function(jsonString) {
            window.__testApi.messages.push({ type: 'syncData', content: jsonString });
            window.__testApi.lastSyncData = jsonString;
        },
        requestReopenAs: function(viewType) {
            // Accept either a string or {viewType:string} payload
            var vt = (viewType && typeof viewType === 'object') ? viewType.viewType : viewType;
            post({ type: 'requestReopenAs', viewType: vt });
        },
        // TASK-B2: full host bridge for outliner cell operations
        openMdPage: function(payload) { post({ type: 'openMdPage', payload: payload }); },
        openAttachedFile: function(nodeId) { post({ type: 'openAttachedFile', nodeId: nodeId }); },
        openLink: function(href) { post({ type: 'openLink', href: href }); },
        copyPagePaths: function(pageIds) { post({ type: 'copyPagePaths', pageIds: pageIds }); },
        attachFile: function(payload) { post({ type: 'attachFile', payload: payload }); },
        imagePaste: function(payload) { post({ type: 'imagePaste', payload: payload }); },
        saveOutlinerClipboard: function(payload) {
            post({ type: 'saveOutlinerClipboard', isCut: payload.isCut, nodes: payload.nodes, plainText: payload.plainText });
        },
        handleClipboardPaste: function(payload) {
            post({ type: 'handleClipboardPaste', payload: payload });
        },
        save: function() { post({ type: 'save' }); },
        onMessage: function(handler) { window.__hostMessageHandler = handler; }
    };
})();
`;

// --- HTML テンプレート ---
const html = `<!DOCTYPE html>
<html lang="en" data-theme="github">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Standalone Outliner Table Test</title>
    <style>${stylesContent}</style>
    <style>${tableCss}</style>
</head>
<body>
    <div class="otable-root">
        <header class="otable-header">
            <span class="otable-title"></span>
        </header>
        <!-- .otable-body は OutlinerTable.init() で生成される -->
    </div>

    <script>
    __LINK_PARSER_SCRIPT__
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
    __TEST_HOST_BRIDGE__
    </script>
    <script>
    __OUTLINER_TABLE_SCRIPT__
    </script>
    <script>
    // テスト API 公開
    window.__testApi.ready = false;
    window.__testApi.initOutlinerTable = function(data) {
        var defaultData = { rootIds: [], nodes: {} };
        OutlinerTable.init(data || defaultData, window.outlinerTableHostBridge);
        window.__testApi.ready = true;
    };
    window.__testApi.flushSync = function() {
        if (window.OutlinerTable && window.OutlinerTable.syncToHostImmediate) {
            window.OutlinerTable.syncToHostImmediate();
        }
    };
    window.__testApi.getSerializedData = function() {
        if (window.__testApi.lastSyncData) {
            try { return JSON.parse(window.__testApi.lastSyncData); } catch (_) { return null; }
        }
        return null;
    };
    window.__testApi.applyExternalUpdate = function(data) {
        if (window.OutlinerTable && window.OutlinerTable.applyExternalUpdate) {
            window.OutlinerTable.applyExternalUpdate(data);
        }
    };
    // 空データで初期化
    window.__testApi.initOutlinerTable();
    </script>
</body>
</html>`;

const safeReplace = function(str, token, value) { return str.replace(token, function() { return value; }); };
let result = html;
result = safeReplace(result, '__LINK_PARSER_SCRIPT__', linkParserScript);
result = safeReplace(result, '__OUTLINER_CELL_SCRIPT__', outlinerCellScript);
result = safeReplace(result, '__OUTLINER_MODEL_SCRIPT__', outlinerModelScript);
result = safeReplace(result, '__OUTLINER_SEARCH_SCRIPT__', outlinerSearchScript);
result = safeReplace(result, '__TEST_HOST_BRIDGE__', testTableHostBridge);
result = safeReplace(result, '__OUTLINER_TABLE_SCRIPT__', outlinerTableScript);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, result);

console.log('Generated:', outputPath);
