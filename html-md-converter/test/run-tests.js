#!/usr/bin/env node
// Test runner: Node + jsdom で dist/html-md-converter.js を読み込み、
// fixtures/*.html を htmlToMarkdown() に通して期待値と比較。
//
// 期待値が無い場合は ".expected.md" が無いので diff を出して fail させず、
// 出力を表示するだけ (初回 fixture 整備用)。

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FIXTURES = path.join(__dirname, 'fixtures');
const BUNDLE = path.join(__dirname, '..', 'dist', 'html-md-converter.js');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const window = dom.window;

// グローバル prep
global.window = window;
global.document = window.document;
global.DOMParser = window.DOMParser;
global.Node = window.Node;
global.HTMLElement = window.HTMLElement;
global.NodeList = window.NodeList;

// bundle を eval (window.HtmlMdConverter 経由でロード)
const bundleSrc = fs.readFileSync(BUNDLE, 'utf-8');
// CJS context だと `this` が window ではなくなるので、明示的に window.eval する
window.eval(bundleSrc);
const HtmlMdConverter = window.HtmlMdConverter;

if (!HtmlMdConverter) {
    console.error('FAIL: HtmlMdConverter not defined after eval');
    process.exit(1);
}
console.log(`Loaded html-md-converter v${HtmlMdConverter.version}\n`);

const files = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.html'));
let pass = 0, fail = 0;

for (const f of files) {
    const html = fs.readFileSync(path.join(FIXTURES, f), 'utf-8');
    const expectedPath = path.join(FIXTURES, f.replace(/\.html$/, '.expected.md'));
    let md;
    try {
        md = HtmlMdConverter.htmlToMarkdown(html);
    } catch (e) {
        console.error(`✗ ${f}: throws ${e.message}`);
        fail++;
        continue;
    }
    if (!fs.existsSync(expectedPath)) {
        console.log(`?  ${f}: no expected file, output:`);
        console.log('---');
        console.log(md);
        console.log('---');
        continue;
    }
    const expected = fs.readFileSync(expectedPath, 'utf-8').replace(/\n$/, '');
    const actual = md.replace(/\n$/, '');
    if (expected === actual) {
        console.log(`✓ ${f}`);
        pass++;
    } else {
        console.error(`✗ ${f}`);
        console.error('  EXPECTED:');
        console.error('    ' + expected.split('\n').join('\n    '));
        console.error('  ACTUAL:');
        console.error('    ' + actual.split('\n').join('\n    '));
        fail++;
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
