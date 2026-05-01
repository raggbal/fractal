/**
 * Bug: ノードのタグをダブルクリックして検索ボックスにタグが反映された時、
 *      検索ボックスのクリアボタン (×) が表示されない。
 *
 * 旧症状: dblclick 経路で `searchInput.value = tag.textContent` を直接代入していた
 *          ため input event が発火せず、`updateSearchClearButton()` が呼ばれない。
 *
 * 修正: dblclick handler で executeSearch 後に updateSearchClearButton() を明示呼び出し。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner: tag dblclick → search clear button visible', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('タグをダブルクリック → クリアボタン (×) が表示される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO #task 完了', tags: ['#task'] }
                }
            });
        });
        await page.locator('.outliner-tag').waitFor({ state: 'visible' });

        // 初期状態: クリアボタンは非表示 (display: none)
        const beforeDisplay = await page.evaluate(() => {
            const btn = document.querySelector('.outliner-search-clear-btn') as HTMLElement;
            return btn ? btn.style.display : null;
        });
        expect(beforeDisplay).toBe('none');

        // タグをダブルクリック
        const tagSpan = page.locator('.outliner-tag').first();
        await tagSpan.dblclick();
        await page.waitForTimeout(150);

        // search input にタグが入っている
        const searchValue = await page.evaluate(() => {
            const input = document.querySelector('.outliner-search-input') as HTMLInputElement;
            return input?.value;
        });
        expect(searchValue).toBe('#task');

        // クリアボタンが表示されている (display !== 'none')
        const afterDisplay = await page.evaluate(() => {
            const btn = document.querySelector('.outliner-search-clear-btn') as HTMLElement;
            return btn ? btn.style.display : null;
        });
        expect(afterDisplay).not.toBe('none');
    });

    test('タグダブルクリック後にクリアボタン (×) を押すと検索クリアされ、ボタンが再非表示になる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'task #foo', tags: ['#foo'] }
                }
            });
        });
        await page.locator('.outliner-tag').waitFor({ state: 'visible' });

        await page.locator('.outliner-tag').first().dblclick();
        await page.waitForTimeout(100);

        // クリアボタンクリック
        await page.locator('.outliner-search-clear-btn').click();
        await page.waitForTimeout(100);

        // 検索 input が空 + クリアボタン非表示
        const result = await page.evaluate(() => {
            const input = document.querySelector('.outliner-search-input') as HTMLInputElement;
            const btn = document.querySelector('.outliner-search-clear-btn') as HTMLElement;
            return { value: input?.value, display: btn?.style.display };
        });
        expect(result.value).toBe('');
        expect(result.display).toBe('none');
    });
});
