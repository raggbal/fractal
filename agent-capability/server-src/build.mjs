#!/usr/bin/env node
/**
 * server-src/build.mjs — fractal MCP サーバーを 1 ファイルの bundle（agent-capability/plugin/server/server.mjs）にする（spec 20261027-1700-mcp-full-ops D1 / ADR-0012）。
 *
 * 出力先は plugin/server/（入る物。gitignore の生成物）。中間の dist/ は作らない。plugin/ は入れるときに丸ごと写されるので、
 * ソース・node_modules・build の道具（このフォルダ）は plugin/ の外に置く。
 *
 * - 入口: server-src/src/server.mjs（ソース）。SDK（@modelcontextprotocol/sdk）・zod・src/shared の正典・
 *   src/webview/outliner-model.js・plugin/skills/fractal/references/structure.md（text として埋め込む。原本はこの 1 か所）を全部含める
 * - ESM / platform node / target node18。CJS の正典（markdown-link-parser 等）が require を使うので、
 *   banner で createRequire の require を用意する
 * - 外す（bundle に入れない）もの:
 *     vscode … NotesFileManager が遅延 require する（MCP ではゴミ箱を注入するので呼ばれない）
 *     pdfjs-dist … 拡張機能の添付抽出（doc-text-extract）が遅延 require する。MCP の PDF 検索は
 *                  fractal-search.mjs が vendor/pdfjs-bundle.cjs を読む → build がそれを plugin/server/vendor/ へ複製する
 * - 前に `tsc -p server-src/tsconfig.json`（server-src/src の型チェック）と、fractal-search.mjs が読む
 *   out/shared/md-h1-utils.js（`tsc -p tsconfig.shared-emit.json`）が要る。npm run compile がその順で呼ぶ
 * - server-src/node_modules が無ければ server-src で npm ci する（lockfile どおり）
 *
 * 使い方: node agent-capability/server-src/build.mjs（npm run build:mcp）
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));   // agent-capability/server-src
const ROOT = path.resolve(MCP_DIR, '..', '..');
const PLUGIN_DIR = path.resolve(MCP_DIR, '..', 'plugin');
const OUT_DIR = path.join(PLUGIN_DIR, 'server');                  // 生成物（gitignore）
const OUT = path.join(OUT_DIR, 'server.mjs');
const require = createRequire(import.meta.url);

function log(msg) { console.log(`[mcp-build] ${msg}`); }

// 1. MCP の依存（SDK / zod）
if (!fs.existsSync(path.join(MCP_DIR, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    log('server-src/node_modules が無いので npm ci します');
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: MCP_DIR, stdio: 'inherit' });
}

// 2. 型チェック（server-src/src）
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc', { paths: [ROOT] }), '-p', path.join(MCP_DIR, 'tsconfig.json')], { stdio: 'inherit' });

// 3. fractal-search.mjs が読む正典の emit（npm run compile では先に作られている。単独実行のときだけ足りなければ作る）
if (!fs.existsSync(path.join(ROOT, 'out', 'shared', 'md-h1-utils.js'))) {
    log('out/shared が無いので tsc -p tsconfig.shared-emit.json を実行します');
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc', { paths: [ROOT] }), '-p', path.join(ROOT, 'tsconfig.shared-emit.json')], { stdio: 'inherit', cwd: ROOT });
}

// 4. bundle
const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
fs.rmSync(OUT_DIR, { recursive: true, force: true });   // 前の build の残り（消した vendor など）を持ち越さない
fs.mkdirSync(OUT_DIR, { recursive: true });
await esbuild.build({
    entryPoints: [path.join(MCP_DIR, 'src', 'server.mjs')],
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
            '// 生成物: node agent-capability/server-src/build.mjs（npm run compile）。直接編集しない。ソースは agent-capability/server-src と src/shared。',
            'import { createRequire as __fractalCreateRequire } from "node:module";',
            'const require = __fractalCreateRequire(import.meta.url);',
            'globalThis.__FRACTAL_MCP_BUNDLE__ = true;',
        ].join('\n'),
    },
    legalComments: 'none',
    logLevel: 'warning',
    charset: 'utf8',
});

// 5. pdfjs の vendor（PDF の中身検索）を plugin/server/vendor へ
const vendorSrc = path.join(MCP_DIR, 'vendor', 'pdfjs-bundle.cjs');
if (fs.existsSync(vendorSrc)) {
    fs.mkdirSync(path.join(OUT_DIR, 'vendor'), { recursive: true });
    fs.copyFileSync(vendorSrc, path.join(OUT_DIR, 'vendor', 'pdfjs-bundle.cjs'));
} else {
    log('warning: server-src/vendor/pdfjs-bundle.cjs が無いので PDF の中身検索は pdf_unavailable になります（npm run build:pdfjs-vendor）');
}
fs.chmodSync(OUT, 0o755);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
log(`plugin/server/server.mjs: ${kb} KB`);
