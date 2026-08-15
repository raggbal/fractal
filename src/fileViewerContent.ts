/**
 * fileViewerContent.ts — file viewer webview の HTML 生成
 *
 * sprint 20260815-075428-file-viewer-3panes / design §1。
 * CSP は design 確定形: form-action 'none'（ARCH-1）+ worker-src cspSource blob:（ARCH-2）。
 * md 系モジュール（editor.js 等）は一切読み込まない（NFR-FV-02）。
 */
import * as vscode from 'vscode';
import { ViewerKind } from './shared/viewer-target';
import { getNonce } from './webviewContent';

export function getFileViewerHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    fileUri: vscode.Uri,
    kind: ViewerKind
): string {
    const pdfjsDir = vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs-viewer');
    const asUri = (u: vscode.Uri): string => webview.asWebviewUri(u).toString();
    const viewerJs = asUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'file-viewer.js'));
    const viewerCss = asUri(vscode.Uri.joinPath(pdfjsDir, 'pdf_viewer.css'));
    // SEC-1（reviewer iter1）: inline script（__viewerConfig 注入）には nonce が必須 —
    // script-src に nonce/'unsafe-inline' が無いと本番 CSP でブロックされ standalone 面が空白になる
    // （既存 3 provider = webviewContent.ts:152 等と同じ nonce パターン）
    const nonce = getNonce();
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}' ${webview.cspSource}`,
        `frame-src ${webview.cspSource} blob:`,
        `worker-src ${webview.cspSource} blob:`,
        `connect-src ${webview.cspSource}`,
        `form-action 'none'`,
    ].join('; ');
    const config = {
        pdfjsLibUri: asUri(vscode.Uri.joinPath(pdfjsDir, 'pdfjs-lib.mjs')),
        workerUri: asUri(vscode.Uri.joinPath(pdfjsDir, 'pdf.worker.min.mjs')),
        cMapUrl: `${asUri(pdfjsDir)}/cmaps/`,
        standardFontDataUrl: `${asUri(pdfjsDir)}/standard_fonts/`,
        kind,
        fileUri: asUri(fileUri),
        // ADRL-0067: html 面の copy ヘルパー注入とオプトイン rewrite が使う nonce。
        // blob iframe は生成時の policy container（= この CSP）を継承するため、
        // この nonce を持つ script だけが blob 内で実行できる（防御の実体）。
        nonce,
    };
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${viewerCss}">
<style>
html, body { margin: 0; height: 100%; }
#viewer-root { height: 100%; display: flex; flex-direction: column; }
.viewer-toolbar { flex: 0 0 auto; padding: 4px; border-bottom: 1px solid var(--vscode-panel-border, #ccc); }
.viewer-body { flex: 1 1 auto; position: relative; overflow: auto; }
.viewer-error { padding: 16px; color: var(--vscode-errorForeground, #b00); }
</style>
</head>
<body>
<div id="viewer-root"></div>
<script nonce="${nonce}">
// sprint 20260815 TASK-13（ADRL-0067 決定4② / 不変条件7）: viewer iframe（opaque origin）発の
// postMessage 偽装を capture-phase で一括遮断（bootstrap 最初期 = 他の全 listener 登録より前）。
window.addEventListener('message', function (e) {
    if (e.origin === 'null') { e.stopImmediatePropagation(); }
}, true);
window.__viewerConfig = ${JSON.stringify(config)};</script>
<script type="module" nonce="${nonce}" src="${viewerJs}"></script>
</body>
</html>`;
}
