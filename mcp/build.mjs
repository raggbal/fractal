#!/usr/bin/env node
/**
 * mcp/build.mjs — fractal MCP サーバーを 1 ファイルの bundle（mcp/dist/server.mjs）にする（spec 20261027-1700-mcp-full-ops D1 / ADR-0012）。
 *
 * - 入口: mcp/server.mjs（ソース）。SDK（@modelcontextprotocol/sdk）・zod・src/shared の正典・
 *   src/webview/outliner-model.js・structure.md（text として埋め込む）を全部含める
 * - ESM / platform node / target node18。CJS の正典（markdown-link-parser 等）が require を使うので、
 *   banner で createRequire の require を用意する
 * - 外す（bundle に入れない）もの:
 *     vscode … NotesFileManager が遅延 require する（MCP ではゴミ箱を注入するので呼ばれない）
 *     pdfjs-dist … 拡張機能の添付抽出（doc-text-extract）が遅延 require する。MCP の PDF 検索は
 *                  fractal-search.mjs が vendor/pdfjs-bundle.cjs を読む → build がそれを dist/vendor/ へ複製する
 * - 前に `tsc -p mcp/tsconfig.json`（mcp/src の型チェック）と、fractal-search.mjs が読む
 *   out/shared/md-h1-utils.js（`tsc -p tsconfig.shared-emit.json`）が要る。npm run compile がその順で呼ぶ
 * - mcp/node_modules が無ければ mcp で npm ci する（lockfile どおり）
 *
 * 使い方: node mcp/build.mjs
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MCP_DIR, '..');
const DIST = path.join(MCP_DIR, 'dist');
const OUT = path.join(DIST, 'server.mjs');
const require = createRequire(import.meta.url);

function log(msg) { console.log(`[mcp-build] ${msg}`); }

// 1. MCP の依存（SDK / zod）
if (!fs.existsSync(path.join(MCP_DIR, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    log('mcp/node_modules が無いので npm ci します');
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: MCP_DIR, stdio: 'inherit' });
}

// 2. 型チェック（mcp/src）
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc', { paths: [ROOT] }), '-p', path.join(MCP_DIR, 'tsconfig.json')], { stdio: 'inherit' });

// 3. fractal-search.mjs が読む正典の emit（npm run compile では先に作られている。単独実行のときだけ足りなければ作る）
if (!fs.existsSync(path.join(ROOT, 'out', 'shared', 'md-h1-utils.js'))) {
    log('out/shared が無いので tsc -p tsconfig.shared-emit.json を実行します');
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc', { paths: [ROOT] }), '-p', path.join(ROOT, 'tsconfig.shared-emit.json')], { stdio: 'inherit', cwd: ROOT });
}

// 4. bundle
const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
fs.mkdirSync(DIST, { recursive: true });
await esbuild.build({
    entryPoints: [path.join(MCP_DIR, 'server.mjs')],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['vscode', 'pdfjs-dist', 'pdfjs-dist/*'],
    loader: { '.md': 'text' },
    nodePaths: [path.join(MCP_DIR, 'node_modules')],
    banner: {
        js: [
            '// 生成物: node mcp/build.mjs（npm run compile）。直接編集しない。ソースは mcp/server.mjs・mcp/src・src/shared。',
            'import { createRequire as __fractalCreateRequire } from "node:module";',
            'const require = __fractalCreateRequire(import.meta.url);',
            'globalThis.__FRACTAL_MCP_BUNDLE__ = true;',
        ].join('\n'),
    },
    legalComments: 'none',
    logLevel: 'warning',
    charset: 'utf8',
});

// 5. pdfjs の vendor（PDF の中身検索）を dist/vendor へ
const vendorSrc = path.join(MCP_DIR, 'vendor', 'pdfjs-bundle.cjs');
if (fs.existsSync(vendorSrc)) {
    fs.mkdirSync(path.join(DIST, 'vendor'), { recursive: true });
    fs.copyFileSync(vendorSrc, path.join(DIST, 'vendor', 'pdfjs-bundle.cjs'));
} else {
    log('warning: mcp/vendor/pdfjs-bundle.cjs が無いので PDF の中身検索は pdf_unavailable になります（npm run build:pdfjs-vendor）');
}
// 6. 使い方の skill（skills/fractal）の参照 md はデータモデルの原本（mcp/structure.md）の写し — 二重に書かない
const skillRef = path.join(ROOT, 'skills', 'fractal', 'references', 'structure.md');
fs.mkdirSync(path.dirname(skillRef), { recursive: true });
fs.copyFileSync(path.join(MCP_DIR, 'structure.md'), skillRef);
fs.chmodSync(OUT, 0o755);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
log(`mcp/dist/server.mjs: ${kb} KB`);
