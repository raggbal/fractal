import * as vscode from 'vscode';
import { getNonce } from './webviewContent';

/**
 * outlinerTableWebviewContent — fractal.outlinerTable view 用 (stub)
 *
 * TASK-A7 (Phase A 完了): customEditors[] 登録のための最低限 Provider + Webview。
 * 本実装 (列定義の load / save、cell render、search 等) は Phase B (TASK-B1〜B9) で行う。
 *
 * design: .harness/sprint/.../design/system.md §4.4 / §4.5
 */
export function getOutlinerTableWebviewContent(
    webview: vscode.Webview,
    _extensionUri: vscode.Uri
): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fractal Outliner Table (stub)</title>
    <style nonce="${nonce}">
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
        .otable-root { display: flex; flex-direction: column; gap: 8px; }
        .otable-stub-msg { font-size: 14px; }
        .otable-stub-hint { font-size: 12px; opacity: 0.7; }
    </style>
</head>
<body>
    <div class="otable-root">
        <div class="otable-stub-msg">Outliner Table Editor (stub)</div>
        <div class="otable-stub-hint">Phase A scaffolding. Full implementation: Phase B (TASK-B1+).</div>
    </div>
    <script nonce="${nonce}">
        (function() {
            var vscode = acquireVsCodeApi();
            window.addEventListener('message', function(e) {
                // Phase A: just record init for diagnostics
                if (e.data && e.data.type === 'init') {
                    // no-op stub
                }
            });
            // notify host that webview is ready (for Phase B init data send)
            vscode.postMessage({ type: 'ready' });
        })();
    </script>
</body>
</html>`;
}
