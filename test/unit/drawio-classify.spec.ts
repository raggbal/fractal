/**
 * classifyDroppedFile 多重拡張子テスト (TC-13)
 *
 * editor.js / outliner.js の前置判定ロジックを 21 ケースで検証する。
 * webview build を必要とするため Playwright で standalone-editor.html をロードする。
 */

import { test, expect } from '@playwright/test';

// 21 ケース
// editor 用と outliner 用で戻り値が違う:
//   editor:   'drawio-file' | 'drawio-xml' | 'image' | 'file'
//   outliner: 'md' | 'image' | 'file'  (drawio は file に丸める)
const EDITOR_CASES: Array<{ name: string; expected: string }> = [
    { name: 'foo.drawio.svg', expected: 'drawio-file' },
    { name: 'FOO.DRAWIO.SVG', expected: 'drawio-file' },
    { name: 'foo.drawio.png', expected: 'drawio-file' },
    { name: 'FOO.DRAWIO.PNG', expected: 'drawio-file' },
    { name: 'sub/dir/diagram.drawio.svg', expected: 'drawio-file' },
    { name: 'a.b.drawio.svg', expected: 'drawio-file' },
    { name: 'foo.drawio', expected: 'drawio-xml' },
    { name: 'FOO.DRAWIO', expected: 'drawio-xml' },
    { name: 'a.b.drawio', expected: 'drawio-xml' },
    { name: 'plain.svg', expected: 'image' },
    { name: 'plain.png', expected: 'image' },
    { name: 'plain.jpg', expected: 'image' },
    { name: 'plain.JPG', expected: 'image' },
    { name: 'plain.webp', expected: 'image' },
    { name: 'plain.gif', expected: 'image' },
    { name: 'doc.pdf', expected: 'file' },
    { name: 'data.zip', expected: 'file' },
    { name: 'note.md', expected: 'file' },        // editor では md は file 扱い
    { name: 'plain', expected: 'file' },           // 拡張子なし
    { name: '', expected: 'file' },                 // 空ファイル名
    { name: '.drawio.svg', expected: 'drawio-file' } // 隠しファイル
];

test.describe('TC-13: editor.js classifyDroppedFile (21 ケース)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        // editor.js 側で window.__fractalClassifyDroppedFile を公開
        await page.waitForFunction(() => typeof (window as any).__fractalClassifyDroppedFile === 'function');
    });

    for (const c of EDITOR_CASES) {
        test(`${JSON.stringify(c.name)} → ${c.expected}`, async ({ page }) => {
            const got = await page.evaluate(({ name }) => {
                return (window as any).__fractalClassifyDroppedFile(name);
            }, { name: c.name });
            expect(got).toBe(c.expected);
        });
    }
});
