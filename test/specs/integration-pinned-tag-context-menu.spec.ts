/**
 * F1: ノード上の #tag を右クリック → 「Add to Pinned Tags」 メニュー項目
 *
 * - 右クリック対象が `.outliner-tag` span の時のみメニュー項目を出す
 * - 既に固定済タグなら disabled (greyed out) — トグル解除はしない
 * - クリックで pinnedTags に push、pinned bar に反映、syncData で .out に保存される
 */

import { test, expect } from '@playwright/test';

test.describe('F1: Pinned tag context menu', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO #task 終わらせる', tags: ['#task'] }
                }
            });
        });
        // wait until tag span renders
        await page.locator('.outliner-tag').waitFor({ state: 'visible' });
    });

    test('#tag 上の右クリックで "Add to Pinned Tags" 項目が出る', async ({ page }) => {
        const tagSpan = page.locator('.outliner-tag').first();
        await tagSpan.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.outliner-context-menu');
        await expect(menu).toBeVisible();

        const items = menu.locator('.outliner-context-menu-item');
        const labels = await items.locator('.context-menu-label').allTextContents();
        const matched = labels.find(l => /Add to Pinned Tags|固定タグに追加/.test(l) && /#task/.test(l));
        expect(matched).toBeTruthy();
    });

    test('クリックで pinnedTags に追加され、固定タグバーに表示される', async ({ page }) => {
        const tagSpan = page.locator('.outliner-tag').first();
        await tagSpan.click({ button: 'right' });
        await page.waitForTimeout(150);

        // 「Add to Pinned Tags」項目をクリック
        const menu = page.locator('.outliner-context-menu');
        const item = menu.locator('.outliner-context-menu-item').filter({ hasText: /Add to Pinned Tags|固定タグに追加/ });
        await item.click();
        await page.waitForTimeout(200);

        // 固定タグバーに #task が出る
        const pinnedBtn = page.locator('.outliner-pinned-tag-btn[data-tag="#task"]');
        await expect(pinnedBtn).toHaveCount(1);
    });

    test('既に pinned 済タグは disabled で表示される (トグル解除しない)', async ({ page }) => {
        // まず pinnedTags に追加
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO #task', tags: ['#task'] }
                },
                pinnedTags: ['#task']
            });
        });
        await page.locator('.outliner-tag').waitFor({ state: 'visible' });

        const tagSpan = page.locator('.outliner-tag').first();
        await tagSpan.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.outliner-context-menu');
        const item = menu.locator('.outliner-context-menu-item').filter({ hasText: /Add to Pinned Tags|固定タグに追加/ });

        // disabled クラスがついている
        await expect(item).toHaveClass(/disabled/);

        // クリックしても pinnedTags 数は変わらない (トグル解除されない)
        await item.click({ force: true });
        await page.waitForTimeout(200);

        const pinnedBtns = page.locator('.outliner-pinned-tag-btn[data-tag="#task"]');
        await expect(pinnedBtns).toHaveCount(1);
    });

    test('ノード本文 (タグ以外) を右クリックしてもタグ追加項目は出ない', async ({ page }) => {
        // ノード本文のタグ以外の部分を右クリック
        const nodeText = page.locator('.outliner-node .outliner-text').first();
        await nodeText.click({ button: 'right', position: { x: 5, y: 5 } });
        await page.waitForTimeout(150);

        const menu = page.locator('.outliner-context-menu');
        await expect(menu).toBeVisible();

        const labels = await menu.locator('.context-menu-label').allTextContents();
        const matched = labels.find(l => /Add to Pinned Tags|固定タグに追加/.test(l));
        expect(matched).toBeUndefined();
    });

    test('@tag (@mention) も同様に追加できる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: '担当 @alice', tags: ['@alice'] }
                }
            });
        });
        await page.locator('.outliner-tag').waitFor({ state: 'visible' });

        const tagSpan = page.locator('.outliner-tag').first();
        await tagSpan.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.outliner-context-menu');
        const item = menu.locator('.outliner-context-menu-item').filter({ hasText: /Add to Pinned Tags|固定タグに追加/ });
        await item.click();
        await page.waitForTimeout(200);

        const pinnedBtn = page.locator('.outliner-pinned-tag-btn[data-tag="@alice"]');
        await expect(pinnedBtn).toHaveCount(1);
    });
});
