// build-pdfjs-viewer.js — file viewer（webview）用 pdfjs バンドル + 資産の生成
//
// sprint 20260815-075428-file-viewer-3panes / FR-FV-03 / ADRL-0065。
// 検索用 vendor（build-pdfjs-vendor.js = platform:'node'・CJS・抽出専用）とは別物:
// こちらは webview（ブラウザ）で canvas 実レンダするための platform:'browser' バンドル。
//
// 生成物 media/pdfjs-viewer/ は **commit しない**（.gitignore 対象 — SYS-3 裁定。
// node_modules の既存 pin 4.10.38 から毎ビルド生成可能で、vendor の「npm 外配布」条件が無い）。
// compile スクリプトが毎回実行する。
//
// 出力:
//   media/pdfjs-viewer/pdfjs-lib.mjs      — pdf.mjs + pdf_viewer.mjs の単一 ESM バンドル
//   media/pdfjs-viewer/pdf.worker.min.mjs — worker（そのままコピー）
//   media/pdfjs-viewer/pdf_viewer.css     — PDFViewer の既定スタイル
//   media/pdfjs-viewer/cmaps/             — 日本語 PDF 必須の CMap 群
//   media/pdfjs-viewer/standard_fonts/    — 標準フォント

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const OUT_DIR = path.join(ROOT, 'media', 'pdfjs-viewer');

// pdf.mjs（コア）と web/pdf_viewer.mjs（PDFViewer/EventBus）を 1 本の ESM に畳む
const ENTRY_SOURCE = `
export * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
export * as pdfjsViewer from 'pdfjs-dist/web/pdf_viewer.mjs';
`;

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) { copyDir(s, d); } else { fs.copyFileSync(s, d); }
    }
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const result = await esbuild.build({
        stdin: { contents: ENTRY_SOURCE, resolveDir: ROOT, loader: 'js' },
        outfile: path.join(OUT_DIR, 'pdfjs-lib.mjs'),
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        minify: true,
        logLevel: 'info',
    });
    if (result.errors.length > 0) { process.exit(1); }

    fs.copyFileSync(path.join(PDFJS, 'build', 'pdf.worker.min.mjs'), path.join(OUT_DIR, 'pdf.worker.min.mjs'));
    fs.copyFileSync(path.join(PDFJS, 'web', 'pdf_viewer.css'), path.join(OUT_DIR, 'pdf_viewer.css'));
    copyDir(path.join(PDFJS, 'cmaps'), path.join(OUT_DIR, 'cmaps'));
    copyDir(path.join(PDFJS, 'standard_fonts'), path.join(OUT_DIR, 'standard_fonts'));

    const size = fs.statSync(path.join(OUT_DIR, 'pdfjs-lib.mjs')).size;
    console.log(`[build-pdfjs-viewer] media/pdfjs-viewer/pdfjs-lib.mjs: ${(size / 1024 / 1024).toFixed(2)} MB (+ worker/css/cmaps/standard_fonts)`);
}

main().catch((err) => {
    console.error('[build-pdfjs-viewer] failed:', err);
    process.exit(1);
});
