// build-pdfjs-viewer.js — file viewer（webview）用 pdfjs バンドル + 資産の生成
//
// sprint 20260815-075428-file-viewer-3panes / FR-FV-03 / ADRL-0065。
// 検索用 vendor（build-pdfjs-vendor.js = platform:'node'・CJS・抽出専用）とは別物:
// こちらは webview（ブラウザ）で canvas 実レンダするための platform:'browser' バンドル。
//
// 生成物 media/pdfjs-viewer/ は **commit しない**（.gitignore 対象 — SYS-3 裁定。
// node_modules から毎ビルド生成可能で、vendor の「npm 外配布」条件が無い）。
// compile スクリプトが毎回実行する。
//
// 再オープン③（ADRL-0070 / FR-FV-15）: 生成元を alias パッケージ **pdfjs-viewer-dist
// （npm:pdfjs-dist@^5.4.530）** に切替。tagged PDF の選択フリッカー修正（PR #19785 =
// 5.2.133+ / #20492 = 5.4.530+）が 4.10.38 に存在しないため viewer だけ版を上げる。
// 検索用 vendor（build-pdfjs-vendor.js = pdfjs-dist@4.10.38 pin）は不変（ADRL-0057）。
//
// 出力:
//   media/pdfjs-viewer/pdfjs-lib.mjs      — pdf.mjs + pdf_viewer.mjs の単一 ESM バンドル
//   media/pdfjs-viewer/pdf.worker.min.mjs — worker（そのままコピー）
//   media/pdfjs-viewer/pdf_viewer.css     — PDFViewer の既定スタイル
//   media/pdfjs-viewer/cmaps/             — 日本語 PDF 必須の CMap 群
//   media/pdfjs-viewer/standard_fonts/    — 標準フォント
//   media/pdfjs-viewer/wasm/              — 5.x: JPX/JBIG2/ICC デコーダ（nowasm fallback JS 同梱）
//   media/pdfjs-viewer/iccs/              — 5.x: ICC プロファイル

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-viewer-dist');
const OUT_DIR = path.join(ROOT, 'media', 'pdfjs-viewer');

// pdf.mjs（コア）と web/pdf_viewer.mjs（PDFViewer/EventBus）を 1 本の ESM に畳む。
//
// 再オープン②（sprint 20260823-165314 TASK-21 / TC-FV-79）: 生成元を **legacy ビルド**に切替。
// modern ビルドは Map.prototype.getOrInsertComputed 等 Chrome 140 相当の API を polyfill なしで
// 呼ぶため、Chromium<140 の webview（Kiro 等の VS Code フォーク）で全 PDF が
// 「this[#e].getOrInsertComputed is not a function」で即死する。legacy は core-js polyfill 同梱。
// 版は 5.5.207 のまま（CVE 範囲外 pin + 選択フリッカー修正 — ADRL-0070 / TC-FV-70b 不変）。
const ENTRY_SOURCE = `
export * as pdfjsLib from 'pdfjs-viewer-dist/legacy/build/pdf.mjs';
export * as pdfjsViewer from 'pdfjs-viewer-dist/legacy/web/pdf_viewer.mjs';
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

    // worker / css も legacy 側から（TC-FV-79 が worker の生成元同一バイトを pin）
    fs.copyFileSync(path.join(PDFJS, 'legacy', 'build', 'pdf.worker.min.mjs'), path.join(OUT_DIR, 'pdf.worker.min.mjs'));
    fs.copyFileSync(path.join(PDFJS, 'legacy', 'web', 'pdf_viewer.css'), path.join(OUT_DIR, 'pdf_viewer.css'));
    copyDir(path.join(PDFJS, 'cmaps'), path.join(OUT_DIR, 'cmaps'));
    copyDir(path.join(PDFJS, 'standard_fonts'), path.join(OUT_DIR, 'standard_fonts'));
    // 5.x: JPX/JBIG2/ICC の wasm デコーダ + ICC プロファイル（file-viewer.js が
    // cMapUrl と同じ base から wasmUrl/iccUrl を導出して getDocument に渡す）
    copyDir(path.join(PDFJS, 'wasm'), path.join(OUT_DIR, 'wasm'));
    copyDir(path.join(PDFJS, 'iccs'), path.join(OUT_DIR, 'iccs'));

    const size = fs.statSync(path.join(OUT_DIR, 'pdfjs-lib.mjs')).size;
    console.log(`[build-pdfjs-viewer] media/pdfjs-viewer/pdfjs-lib.mjs: ${(size / 1024 / 1024).toFixed(2)} MB (+ worker/css/cmaps/standard_fonts/wasm/iccs)`);
}

main().catch((err) => {
    console.error('[build-pdfjs-viewer] failed:', err);
    process.exit(1);
});
