/**
 * Bug: cmd+z / cmd+shift+z でカーソルが消える。
 *      undo/redo 後は、変更があったノードに自動でカーソルが入るべき。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner: undo/redo cursor focus', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('cmd+z で text 編集を undo → 編集ノードにカーソルが入る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [] }
                }
            });
        });

        // n2 にフォーカスして 'X' を入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n2"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('X');
        await page.waitForTimeout(700); // saveSnapshotDebounce 500ms 待ち

        // フォーカスを n1 に移す
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.focus();
        });
        await page.waitForTimeout(50);

        // cmd+z で undo
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        // フォーカスが n2 (= 編集元) に入っている
        const focusedNodeId = await page.evaluate(() => {
            const ae = document.activeElement;
            if (!ae) return null;
            const node = ae.closest('.outliner-node');
            return node?.getAttribute('data-id');
        });
        expect(focusedNodeId).toBe('n2');
    });

    test('cmd+shift+z で redo → 変更ノードにカーソルが入る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n2"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('X');
        await page.waitForTimeout(700);

        // フォーカスを n1 に移す
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.focus();
        });
        await page.waitForTimeout(50);

        // undo → redo
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);
        await page.keyboard.press('Meta+Shift+z');
        await page.waitForTimeout(200);

        // フォーカスが n2 (= 編集ノード) に入っている
        const focusedNodeId = await page.evaluate(() => {
            const ae = document.activeElement;
            if (!ae) return null;
            const node = ae.closest('.outliner-node');
            return node?.getAttribute('data-id');
        });
        expect(focusedNodeId).toBe('n2');
    });

    test('5 ノードある中で n3 (中間) を編集 → cmd+z でカーソルが n3 (= 編集ノード) に入る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3', 'n4', 'n5'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'one', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'two', tags: [] },
                    n3: { id: 'n3', parentId: null, children: [], text: 'three', tags: [] },
                    n4: { id: 'n4', parentId: null, children: [], text: 'four', tags: [] },
                    n5: { id: 'n5', parentId: null, children: [], text: 'five', tags: [] }
                }
            });
        });

        // n3 末尾にカーソルを置いて 'X' 入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n3"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('X');
        await page.waitForTimeout(700);

        // フォーカスを別の場所 (n5) に移して、cmd+z 時に focusedNodeId が n5 になる状態を作る
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n5"] .outliner-text') as HTMLElement;
            textEl.focus();
        });
        await page.waitForTimeout(50);

        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const focusedNodeId = await page.evaluate(() => {
            const ae = document.activeElement;
            if (!ae) return null;
            const node = ae.closest('.outliner-node');
            return node?.getAttribute('data-id');
        });
        // 編集元 n3 にフォーカスが入る (n5 や n1=first row ではない)
        expect(focusedNodeId).toBe('n3');
    });

    test('undo 後にカーソルが body や検索ボックスに残らない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'hello', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('!');
        await page.waitForTimeout(700);

        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const result = await page.evaluate(() => {
            const ae = document.activeElement;
            return {
                onNode: !!(ae && ae.closest && ae.closest('.outliner-node')),
                isBody: ae === document.body,
                isSearch: !!(ae && ae.classList && ae.classList.contains('outliner-search-input'))
            };
        });
        expect(result.onNode).toBe(true);
        expect(result.isBody).toBe(false);
        expect(result.isSearch).toBe(false);
    });
});
