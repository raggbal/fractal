// build-viewer-modules.js — 新 viewer kind 用 ESM モジュールバンドルの生成（FR-FV-17 / ADRL-0092）
//
// sprint 20260823-165314-viewer-office-text-image / MOD-ViewerBuild。
// src/webview/viewer-<kind>/index.mjs（viewer-common を import する可読ソース）を esbuild
// （platform:'browser' / format:'esm' / bundle / minify）で out/webview/viewer-<kind>.mjs に畳む。
// file-viewer.js が __viewerConfig.viewerModuleUris[kind] を動的 import する（pdfjs-lib.mjs precedent）。
//
// 生成物は **commit しない**（build-pdfjs-viewer.js と同じ扱い — compile / test:build:all が毎回実行）。
// kind の index.mjs が未実装の段階ではスキップする（wave 実装中も gate を回せるように）。

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'webview');
const KINDS = ['text', 'image', 'docx', 'xlsx', 'pptx'];

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const built = [];
    for (const kind of KINDS) {
        const entry = path.join(ROOT, 'src', 'webview', `viewer-${kind}`, 'index.mjs');
        if (!fs.existsSync(entry)) {
            console.log(`  - viewer-${kind}: index.mjs 未実装のためスキップ`);
            continue;
        }
        await esbuild.build({
            entryPoints: [entry],
            outfile: path.join(OUT, `viewer-${kind}.mjs`),
            bundle: true,
            minify: true,
            format: 'esm',
            platform: 'browser',
            target: 'chrome114', // VS Code 1.85 = Electron 25+ 相当
            legalComments: 'inline', // 移植ファイルの MIT ヘッダをバンドルに保持（NFR-VEX-08）
        });
        built.push(kind);
    }
    console.log(`  ✓ viewer modules: ${built.length ? built.join(', ') : '(none yet)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
