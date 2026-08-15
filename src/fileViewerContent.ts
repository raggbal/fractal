/**
 * fileViewerContent.ts — file viewer webview の HTML 生成
 *
 * sprint 20260815-075428-file-viewer-3panes / design §1。
 * CSP は design 確定形: form-action 'none'（ARCH-1）+ worker-src cspSource blob:（ARCH-2）。
 * md 系モジュール（editor.js 等）は一切読み込まない（NFR-FV-02）。
 */
import * as vscode from 'vscode';
import { ViewerKind } from './shared/viewer-target';

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
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src ${webview.cspSource}`,
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
<script>window.__viewerConfig = ${JSON.stringify(config)};</script>
<script type="module" src="${viewerJs}"></script>
</body>
</html>`;
}
