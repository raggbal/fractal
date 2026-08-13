// build-pdfjs-vendor.js — CLI（fractal-search.mjs）用 pdfjs 単一ファイルバンドル生成
//
// sprint 20260813-133248-search-doc-content / FR-DS-06 / ADRL-0057。
// poc bh-02（.harness/poc/20260813-094552-docsearch-pdf-ooxml/v1/bh-02/build.js）と同構成:
//   pdfjs-dist@4.10.38 legacy build + fake worker（pdf.worker.mjs を同一バンドルに畳み
//   globalThis.pdfjsWorker 代入）を CJS 単一ファイルに落とす。
//
// 生成物 ai_skills/fractal-search/vendor/pdfjs-bundle.cjs は**リポジトリに commit する**
// （ゼロ install 配布 = install.sh の symlink 先で npm install 不要）。
// pdfjs-dist を更新したときのみ手動で再実行: npm run build:pdfjs-vendor

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ai_skills', 'fractal-search', 'vendor', 'pdfjs-bundle.cjs');

// entry: worker を先に畳んで fake worker 登録 → main を export
const ENTRY_SOURCE = `
const worker = require('pdfjs-dist/legacy/build/pdf.worker.mjs');
globalThis.pdfjsWorker = worker;
module.exports = require('pdfjs-dist/legacy/build/pdf.mjs');
`;

async function main() {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const result = await esbuild.build({
        stdin: {
            contents: ENTRY_SOURCE,
            resolveDir: ROOT,
            loader: 'js',
        },
        outfile: OUT,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        minify: true,
        logLevel: 'info',
    });
    if (result.errors.length > 0) { process.exit(1); }
    const stat = fs.statSync(OUT);
    console.log(`[build-pdfjs-vendor] ${path.relative(ROOT, OUT)}: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
    console.error('[build-pdfjs-vendor] failed:', err);
    process.exit(1);
});
