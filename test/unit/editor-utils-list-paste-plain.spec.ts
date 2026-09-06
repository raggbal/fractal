/**
 * 2026-09-04 ユーザー裁定 — リスト項目内の 1 行 paste は「普通のテキスト」（editor-utils の pure 関数）
 * TC-LPP-01: stripLeadingBlockMarker / TC-LPP-02: toPlainSingleLine
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const EDITOR_UTILS_JS = fs.readFileSync(path.join(__dirname, '../../src/webview/editor-utils.js'), 'utf8');
async function loadUtils(page: import('@playwright/test').Page) {
    await page.goto('about:blank');
    await page.addScriptTag({ content: EDITOR_UTILS_JS });
}

test('TC-LPP-01 stripLeadingBlockMarker: 先頭のブロックマーカーだけを剥がし inline 記法は触らない', async ({ page }) => {
    await loadUtils(page);
    const cases: [string, string][] = [
        ['- gamma', 'gamma'],
        ['-   gamma', 'gamma'],
        ['* gamma', 'gamma'],
        ['+ gamma', 'gamma'],
        ['  - nested', 'nested'],
        ['1. one', 'one'],
        ['12) twelve', 'twelve'],
        ['- [ ] task', 'task'],
        ['- [x] done', 'done'],
        ['# Title', 'Title'],
        ['### Title ###', 'Title'],
        ['> quote', 'quote'],
        ['> > deep', 'deep'],
        ['> - quoted item', 'quoted item'],
        ['plain text', 'plain text'],
        ['**bold** and `code` and [l](u)', '**bold** and `code` and [l](u)'],
        ['-not a bullet', '-not a bullet'],          // マーカーの後に空白が無い = 本文
        ['#hashtag', '#hashtag'],
        ['1.5 million', '1.5 million'],
        ['', ''],
    ];
    for (const [input, want] of cases) {
        const got = await page.evaluate((s) => (window as any).__editorUtils.stripLeadingBlockMarker(s), input);
        expect(got, `input=${JSON.stringify(input)}`).toBe(want);
    }
});

test('TC-LPP-02 toPlainSingleLine: 1 行（setext 見出し含む）は普通のテキスト、複数行は null', async ({ page }) => {
    await loadUtils(page);
    const cases: [string, string | null][] = [
        ['- gamma', 'gamma'],
        ['\n- gamma\n\n', 'gamma'],                 // 前後の空行は無視
        ['Title\n=====', 'Title'],                  // turndown の <h1> 既定出力
        ['Title\n-----', 'Title'],                  // <h2>
        ['# Title', 'Title'],
        ['- x\n- y', null],                         // 複数行 → 呼び出し側は従来経路
        ['para 1\n\npara 2', null],
        ['', ''],
    ];
    for (const [input, want] of cases) {
        const got = await page.evaluate((s) => (window as any).__editorUtils.toPlainSingleLine(s), input);
        expect(got, `input=${JSON.stringify(input)}`).toBe(want);
    }
});
