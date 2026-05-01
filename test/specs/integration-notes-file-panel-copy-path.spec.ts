/**
 * Notes file panel: 右クリック → "Copy Path" で .out ファイルの絶対パスをコピー
 */

import { test, expect } from '@playwright/test';

test.describe('Notes file panel: Copy Path context menu', () => {
    test.beforeEach(async ({ page, context }) => {
        // clipboard API permission
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('file 右クリックメニューに "Copy Path" 項目がある', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initNotesPanel(
                [
                    { filePath: '/Users/test/notes/foo.out', title: 'foo', id: 'foo' },
                    { filePath: '/Users/test/notes/bar.out', title: 'bar', id: 'bar' }
                ],
                '/Users/test/notes/foo.out',
                { version: 1, rootIds: ['foo', 'bar'], items: {
                    foo: { type: 'file', id: 'foo', title: 'foo' },
                    bar: { type: 'file', id: 'bar', title: 'bar' }
                }}
            );
        });
        await page.waitForTimeout(150);

        // file item 右クリック
        const item = page.locator('.file-panel-item').first();
        await item.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        await expect(menu).toBeVisible();
        const items = await menu.locator('.file-panel-context-item').allTextContents();
        const matched = items.find(t => /Copy Path|パスをコピー|复制路径|複製路徑|경로 복사|Copiar ruta|Copier le chemin/.test(t));
        expect(matched).toBeTruthy();
    });

    test('"Copy Path" クリックで file.filePath が clipboard に書かれる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initNotesPanel(
                [
                    { filePath: '/Users/test/notes/foo.out', title: 'foo', id: 'foo' }
                ],
                '/Users/test/notes/foo.out',
                { version: 1, rootIds: ['foo'], items: {
                    foo: { type: 'file', id: 'foo', title: 'foo' }
                }}
            );
        });
        await page.waitForTimeout(150);

        const item = page.locator('.file-panel-item').first();
        await item.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        const copyItem = menu.locator('.file-panel-context-item').filter({ hasText: /Copy Path|パスをコピー/ });
        await copyItem.click();
        await page.waitForTimeout(150);

        const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
        expect(clipboardText).toBe('/Users/test/notes/foo.out');
    });
});
