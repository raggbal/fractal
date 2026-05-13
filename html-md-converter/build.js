#!/usr/bin/env node
// Simple bundler: concat vendor + src into a single IIFE that exposes window.HtmlMdConverter.
// No TypeScript / no transpiler / no rollup — Node fs だけで完結。
//
// 出力: dist/html-md-converter.js (UMD-ish: browser / Playwright eval で動作)

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

function read(p) {
    return fs.readFileSync(p, 'utf-8');
}

// 順序が重要:
//   1. turndown.js — TurndownService をローカル定義
//   2. turndown-plugin-gfm.js — turndownPluginGfm をローカル定義 (TurndownService を参照する rule もある)
//   3. preprocess.js — ensureTableHeaders 定義
//   4. rules.js — addCustomRules 定義
//   5. postprocess.js — postprocess 定義
//   6. index.js — htmlToMarkdown 定義 (上記全てを参照)
const parts = [
    read(path.join(VENDOR, 'turndown.js')),
    read(path.join(VENDOR, 'turndown-plugin-gfm.js')),
    read(path.join(SRC, 'preprocess.js')),
    read(path.join(SRC, 'rules.js')),
    read(path.join(SRC, 'postprocess.js')),
    read(path.join(SRC, 'index.js')),
];

const banner = `/*!
 * html-md-converter v${pkg.version}
 * (c) ${new Date().getFullYear()} ${pkg.author || ''}
 * https://github.com/raggbal/html-md-converter
 *
 * Bundles: turndown + turndown-plugin-gfm + html-md-converter rules
 * Usage (browser / Playwright eval):
 *   const md = HtmlMdConverter.htmlToMarkdown(htmlString);
 */`;

const bundle = [
    banner,
    '(function (global) {',
    '    "use strict";',
    parts.join('\n\n'),
    '    // 公開 API',
    '    global.HtmlMdConverter = {',
    `        version: "${pkg.version}",`,
    '        htmlToMarkdown: htmlToMarkdown,',
    '        articleToMarkdown: articleToMarkdown,',
    '        // 個別関数 (テスト / カスタマイズ用)',
    '        ensureTableHeaders: ensureTableHeaders,',
    '        inlineSvgComputedStyles: inlineSvgComputedStyles,',
    '        preSerializeSvgsToImages: preSerializeSvgsToImages,',
    '        unwrapHeadingAnchors: unwrapHeadingAnchors,',
    '        addCustomRules: addCustomRules,',
    '        postprocess: postprocess,',
    '        // bundled vendors (consumer 側で他用途に使う場合)',
    '        TurndownService: TurndownService,',
    '        turndownPluginGfm: turndownPluginGfm,',
    '    };',
    '})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));',
    ''
].join('\n');

const outFile = path.join(DIST, 'html-md-converter.js');
fs.writeFileSync(outFile, bundle);

const sizeKb = (bundle.length / 1024).toFixed(1);
console.log(`✓ Bundled ${outFile} (${sizeKb} KB)`);
