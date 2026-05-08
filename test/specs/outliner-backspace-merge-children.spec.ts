/**
 * Backspace でテキストマージ時に子ノードが保持されることを検証 (bug fix)
 * Backspace でチェックボックスが解除されることを検証 (新機能)
 */

import { test, expect } from '@playwright/test';

const HTML = '/standalone-outliner.html';

async function initOutliner(page, data: any) {
    await page.evaluate((d) => (window as any).__testApi.initOutliner(d), data);
    // initOutliner は auto-focus を内部でスケジュールするため、十分待つ
    await page.waitForTimeout(300);
}

test.describe('Outliner backspace at start', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(HTML);
        await page.waitForSelector('.outliner-tree');
    });

    test('子ノードを持つノードの先頭で backspace → 子ノード保持', async ({ page }) => {
        // d1, d2 (子: d3 (子: d4))
        await initOutliner(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: ['n2'], text: 'd1', tags: [] },
                n2: { id: 'n2', parentId: 'n1', children: ['n3'], text: 'd2', tags: [] },
                n3: { id: 'n3', parentId: 'n2', children: ['n4'], text: 'd3', tags: [] },
                n4: { id: 'n4', parentId: 'n3', children: [], text: 'd4', tags: [] },
            }
        });

        // d3 の先頭にカーソル
        await page.evaluate(() => {
            var el = document.querySelector('.outliner-node[data-id="n3"] .outliner-text') as HTMLElement;
            if (el) {
                el.focus();
                var range = document.createRange();
                range.setStart(el.firstChild || el, 0);
                range.collapse(true);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });
        await page.waitForTimeout(80);

        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150);

        // 期待: d2 と d3 がマージ → "d2d3", d4 は新親 (n2) の子として残る
        const result = await page.evaluate(() => (window as any).__testApi.getModel());
        const n2 = result.nodes.n2;
        expect(n2.text).toBe('d2d3');
        expect(n2.children).toContain('n4');  // d4 が n2 の子になる
        expect(result.nodes.n4).toBeTruthy();
        expect(result.nodes.n4.parentId).toBe('n2');
        expect(result.nodes.n3).toBeUndefined();  // n3 は削除
    });

    test('チェックボックス付きノードの先頭で backspace → チェックボックス解除', async ({ page }) => {
        await initOutliner(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'task1', tags: [], checked: false },
            }
        });

        await page.evaluate(() => {
            var el = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            if (el) {
                el.focus();
                var range = document.createRange();
                range.setStart(el.firstChild || el, 0);
                range.collapse(true);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });
        await page.waitForTimeout(80);

        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150);

        // 1 回目: checkbox 解除のみ、テキスト維持
        const after1 = await page.evaluate(() => (window as any).__testApi.getModel());
        expect(after1.nodes.n1.text).toBe('task1');
        expect(after1.nodes.n1.checked === null || after1.nodes.n1.checked === undefined).toBe(true);

        // 2 回目: 通常 backspace 挙動 (root のみ + 1 文字あり → 何も起きない or no-op)
        // ※ ルート 1 個 + テキストありのケースは前ノードがないので no-op
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150);
        const after2 = await page.evaluate(() => (window as any).__testApi.getModel());
        // テキストはそのまま (前 sibling なし、root のみ)
        expect(after2.nodes.n1.text).toBe('task1');
    });
});
