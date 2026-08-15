/**
 * file viewer のスタンドアロンテスト用 HTML を生成するビルドスクリプト
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-01（スケルトン）→ TASK-02（拡充）。
 * 使用方法: node test/build-standalone-viewer.js
 *
 * src/webview/file-viewer.js + media/pdfjs-viewer/（build-pdfjs-viewer.js の生成物）を
 * test/html/ に組み込み、実 Chromium で PDF レンダ / HTML iframe sandbox を検証できる
 * ページを出力する。TC 実行前に test:build:all で再ビルド必須（stale ビルド事故防止）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_HTML = path.join(__dirname, 'html', 'standalone-viewer.html');
const PDFJS_SRC = path.join(ROOT, 'media', 'pdfjs-viewer');
const PDFJS_DEST = path.join(__dirname, 'html', 'pdfjs-viewer');

// pdfjs viewer 資産をテストサーバー配下へコピー（無ければ生成を促す）
if (!fs.existsSync(path.join(PDFJS_SRC, 'pdfjs-lib.mjs'))) {
    console.error('[build-standalone-viewer] media/pdfjs-viewer/ がありません。先に: node scripts/build-pdfjs-viewer.js');
    process.exit(1);
}
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) { copyDir(s, d); } else { fs.copyFileSync(s, d); }
    }
}
copyDir(PDFJS_SRC, PDFJS_DEST);

const viewerJsPath = path.join(ROOT, 'src', 'webview', 'file-viewer.js');
const viewerJs = fs.existsSync(viewerJsPath) ? fs.readFileSync(viewerJsPath, 'utf-8') : '/* file-viewer.js not yet implemented (TASK-02) */';
const viewerCss = fs.readFileSync(path.join(PDFJS_SRC, 'pdf_viewer.css'), 'utf-8');

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<!-- 本番 fileViewerContent.ts の CSP frame-src を忠実に再現（外部 URL への iframe 遷移を止める実体は
     sandbox でなく親 CSP — TC-FV-03 の検証面。他 directive はハーネス都合で緩和） -->
<meta http-equiv="Content-Security-Policy" content="frame-src 'self' blob:">
<title>Standalone File Viewer Test</title>
<style>
${viewerCss}
html, body { margin: 0; height: 100%; }
#viewer-root { height: 100%; display: flex; flex-direction: column; }
.viewer-toolbar { flex: 0 0 auto; padding: 4px; border-bottom: 1px solid #ccc; }
.viewer-body { flex: 1 1 auto; position: relative; overflow: auto; }
.viewer-error { padding: 16px; color: #b00; }
</style>
</head>
<body>
<div id="viewer-root"></div>
<script type="module">
// テストハーネス: vscode webview API のスタブ + postMessage 記録
window.__postedMessages = [];
window.acquireVsCodeApi = () => ({
    postMessage: (m) => { window.__postedMessages.push(m); },
    getState: () => null,
    setState: () => {},
});
// pdfjs 資産の場所（test serve 相対）
window.__viewerConfig = {
    pdfjsLibUri: './pdfjs-viewer/pdfjs-lib.mjs',
    workerUri: './pdfjs-viewer/pdf.worker.min.mjs',
    cMapUrl: './pdfjs-viewer/cmaps/',
    standardFontDataUrl: './pdfjs-viewer/standard_fonts/',
};
${viewerJs}
</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
fs.writeFileSync(OUT_HTML, html);
console.log(`[build-standalone-viewer] ${path.relative(ROOT, OUT_HTML)} generated`);
