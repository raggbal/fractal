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

// 新 viewer kind の ESM モジュール（build-viewer-modules.js の生成物）をテストサーバー配下へ供給
// （sprint 20260823-165314 / FR-FV-17。未ビルド kind はスキップ — wave 実装中も動く）
const VIEWER_MODULES_SRC = path.join(ROOT, 'out', 'webview');
const VIEWER_MODULES_DEST = path.join(__dirname, 'html', 'viewer-modules');
fs.mkdirSync(VIEWER_MODULES_DEST, { recursive: true });
for (const kind of ['text', 'image', 'docx', 'xlsx', 'pptx']) {
    const f = path.join(VIEWER_MODULES_SRC, `viewer-${kind}.mjs`);
    if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(VIEWER_MODULES_DEST, `viewer-${kind}.mjs`)); }
}

const viewerJsPath = path.join(ROOT, 'src', 'webview', 'file-viewer.js');
const viewerJs = fs.existsSync(viewerJsPath) ? fs.readFileSync(viewerJsPath, 'utf-8') : '/* file-viewer.js not yet implemented (TASK-02) */';
const viewerCss = fs.readFileSync(path.join(PDFJS_SRC, 'pdf_viewer.css'), 'utf-8');

// TASK-11（TDD-RO-3）: CSP を本番 fileViewerContent.ts 相当に再現（cspSource → 'self' 読み替え）。
// script-src 'nonce-…' が無いと TC-FV-41/43/46 の counterfactual（ユーザー script の nonce 有無で
// 実行可否が変わる / 外部 fetch が connect-src で落ちる）が成立しない — review-report iter1 SEC-1 の
// 「ハーネス CSP が本番より緩く番人が検出できない」構造の再発防止。
const crypto = require('crypto');
const nonce = crypto.randomBytes(16).toString('base64');
const csp = [
    `default-src 'none'`,
    // sprint 20260823-165314 / FR-FV-18: 本番 fileViewerContent.ts と同期（blob: / font-src — TC-VEX-11 が番人）
    `img-src 'self' data: blob:`,
    `style-src 'self' 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'self'`,
    `frame-src 'self' blob:`,
    `worker-src 'self' blob:`,
    `connect-src 'self'`,
    `font-src 'self' blob: data:`,
    `form-action 'none'`,
].join('; ');

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<!-- 本番 fileViewerContent.ts の CSP を忠実に再現（cspSource → 'self'）。blob iframe はこの CSP を
     policy container 継承する — ユーザー script 抑止の実体（script-src nonce）・外部送信遮断
     （connect-src）・外部 URL への iframe 遷移抑止（frame-src — TC-FV-03）が全てここに依存する -->
<meta http-equiv="Content-Security-Policy" content="${csp}">
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
<script nonce="${nonce}">
// TASK-13（不変条件7）: 本番 fileViewerContent.ts と同じ "null" origin capture 遮断を
// bootstrap 最初期（全 message listener 登録より前）に再現 — TC-FV-47/48 の検証対象
window.addEventListener('message', function (e) {
    if (e.origin === 'null') { e.stopImmediatePropagation(); }
}, true);
</script>
<script type="module" nonce="${nonce}">
// テストハーネス: vscode webview API のスタブ + postMessage 記録
// （ハーネス bootstrap 自身も nonce 必須 — script-src に 'self'/'unsafe-inline' だけでは inline module が動かない）
window.__postedMessages = [];
window.acquireVsCodeApi = () => ({
    postMessage: (m) => { window.__postedMessages.push(m); },
    getState: () => null,
    setState: () => {},
});
// pdfjs 資産の場所（test serve 相対）+ nonce（本番は fileViewerContent.ts が注入 — TASK-12 が消費）
window.__viewerConfig = {
    pdfjsLibUri: './pdfjs-viewer/pdfjs-lib.mjs',
    workerUri: './pdfjs-viewer/pdf.worker.min.mjs',
    cMapUrl: './pdfjs-viewer/cmaps/',
    standardFontDataUrl: './pdfjs-viewer/standard_fonts/',
    // sprint 20260823-165314 / FR-FV-17: kind 別モジュール（build-viewer-modules.js → 本ビルドが供給）
    viewerModuleUris: {
        text: './viewer-modules/viewer-text.mjs',
        image: './viewer-modules/viewer-image.mjs',
        docx: './viewer-modules/viewer-docx.mjs',
        xlsx: './viewer-modules/viewer-xlsx.mjs',
        pptx: './viewer-modules/viewer-pptx.mjs',
    },
    nonce: '${nonce}',
};
${viewerJs}
</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
fs.writeFileSync(OUT_HTML, html);
console.log(`[build-standalone-viewer] ${path.relative(ROOT, OUT_HTML)} generated`);
