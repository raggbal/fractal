import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getNonce } from './webviewContent';
import { getWebviewMessages } from './i18n/messages';

/**
 * outlinerTableWebviewContent — fractal.outlinerTable view 用 webview HTML
 *
 * TASK-B1: outliner-cell.js + outliner-model.js + outliner-search.js + outliner-table.js を
 * 注入し、Table editor 本体を bootstrap する。
 *
 * 既存 outlinerWebviewContent.ts と同じ流儀で:
 *   - markdown-link-parser → outliner-cell → outliner-model → outliner-search → outliner-table の順
 *   - CSP は default-src 'none' + nonce script + 必要 style-src
 *
 * design: design/system.md §4.5
 */
export function getOutlinerTableWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri
): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    // CSS
    const tableCssPath = path.join(__dirname, 'webview', 'outliner-table.css');
    const tableCss = fs.existsSync(tableCssPath) ? fs.readFileSync(tableCssPath, 'utf8') : '';
    const stylesPath = path.join(__dirname, 'webview', 'styles.css');
    const baseStyles = fs.existsSync(stylesPath)
        ? fs.readFileSync(stylesPath, 'utf8').replace('__FONT_SIZE__', '14')
        : '';

    // Scripts
    const linkParserPath = path.join(__dirname, 'shared', 'markdown-link-parser.js');
    const linkParserScript = fs.existsSync(linkParserPath) ? fs.readFileSync(linkParserPath, 'utf8') : '';

    const cellPath = path.join(__dirname, 'webview', 'outliner-cell.js');
    const cellScript = fs.existsSync(cellPath) ? fs.readFileSync(cellPath, 'utf8') : '';

    const modelPath = path.join(__dirname, 'webview', 'outliner-model.js');
    const modelScript = fs.existsSync(modelPath) ? fs.readFileSync(modelPath, 'utf8') : '';

    const searchPath = path.join(__dirname, 'webview', 'outliner-search.js');
    const searchScript = fs.existsSync(searchPath) ? fs.readFileSync(searchPath, 'utf8') : '';

    const tableJsPath = path.join(__dirname, 'webview', 'outliner-table.js');
    const tableScript = fs.existsSync(tableJsPath) ? fs.readFileSync(tableJsPath, 'utf8') : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fractal Outliner Table</title>
    <style nonce="${nonce}">${baseStyles}</style>
    <style nonce="${nonce}">${tableCss}</style>
</head>
<body>
    <div class="otable-root">
        <header class="otable-header">
            <span class="otable-title"></span>
        </header>
        <!-- .otable-body は OutlinerTable.init() で動的に生成される -->
    </div>

    <script nonce="${nonce}">
        // TASK-B9: i18n bridge — exposes per-locale strings to outliner-table.js
        // via window.__outlinerMessages (same global the Outliner editor uses).
        window.__outlinerMessages = ${JSON.stringify(getWebviewMessages() || {})};
    </script>
    <script nonce="${nonce}">${linkParserScript}</script>
    <script nonce="${nonce}">${cellScript}</script>
    <script nonce="${nonce}">${modelScript}</script>
    <script nonce="${nonce}">${searchScript}</script>
    <script nonce="${nonce}">
    (function() {
        var vscode = acquireVsCodeApi();
        var pendingInit = null;
        // Minimum host bridge for Phase B1: syncData / requestReopenAs。
        // Phase B 以降で page / image / file 系を追加。
        window.outlinerTableHostBridge = {
            syncData: function(jsonString) {
                vscode.postMessage({ type: 'syncData', payload: jsonString });
            },
            requestReopenAs: function(viewType) {
                vscode.postMessage({ type: 'requestReopenAs', viewType: viewType });
            }
        };

        window.addEventListener('message', function(e) {
            var data = e.data;
            if (!data || typeof data !== 'object') { return; }
            if (data.type === 'init') {
                if (window.OutlinerTable && window.OutlinerTable.init) {
                    window.OutlinerTable.init(data.data || {}, window.outlinerTableHostBridge);
                } else {
                    pendingInit = data.data || {};
                }
            } else if (data.type === 'externalUpdate') {
                if (window.OutlinerTable && window.OutlinerTable.applyExternalUpdate) {
                    window.OutlinerTable.applyExternalUpdate(data.data || {});
                }
            }
        });

        // ready 通知 (Provider が init message を返してくる)
        vscode.postMessage({ type: 'ready' });

        // OutlinerTable script 後置読み込みなので、reload 時 race を考慮
        window.__bootOutlinerTableIfPending = function() {
            if (pendingInit && window.OutlinerTable && window.OutlinerTable.init) {
                window.OutlinerTable.init(pendingInit, window.outlinerTableHostBridge);
                pendingInit = null;
            }
        };
    })();
    </script>
    <script nonce="${nonce}">${tableScript}</script>
    <script nonce="${nonce}">
    if (typeof window.__bootOutlinerTableIfPending === 'function') {
        window.__bootOutlinerTableIfPending();
    }
    </script>
</body>
</html>`;
}
