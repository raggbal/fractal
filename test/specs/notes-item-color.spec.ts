/**
 * FR-11-3: Notes アイテムアイコン色付けテスト
 * ファイル/フォルダアイコンの stroke を 20 色から選択して着色
 */

import { test, expect } from '@playwright/test';

test.describe('Notes アイテム色付け', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // DOD-11-3-3: Set Color → パレット → 色選択 → bridge.setItemColor 呼び出し
    test('Set Color → red swatch クリック → bridge.setItemColor(id, "red") が呼ばれる', async ({ page }) => {
        const fileList = [
            { filePath: '/test/file1.out', title: 'File1', id: 'file1' }
        ];
        const structure = {
            version: 1,
            rootIds: ['file1'],
            items: {
                file1: { type: 'file', id: 'file1', title: 'File1' }
            }
        };

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
            (window as any).__testApi.notesMessages.length = 0;
        }, { fileList, structure });

        // 右クリック → コンテキストメニュー表示
        const fileItem = page.locator('.file-panel-item[data-item-id="file1"]');
        await fileItem.click({ button: 'right' });
        await page.waitForTimeout(200);

        // Set Color をクリック
        const setColorItem = page.locator('.file-panel-context-item:has-text("Set Color")');
        await expect(setColorItem).toBeVisible();
        await setColorItem.click();
        await page.waitForTimeout(200);

        // パレット UI が表示される
        const colorGrid = page.locator('.file-panel-color-grid');
        await expect(colorGrid).toBeVisible();

        // 20 色の swatch が表示される
        const swatches = page.locator('.file-panel-color-swatch');
        await expect(swatches).toHaveCount(20);

        // None と Back ボタンが表示される
        await expect(page.locator('.file-panel-color-none')).toBeVisible();
        await expect(page.locator('.file-panel-color-back')).toBeVisible();

        // red swatch をクリック
        const redSwatch = page.locator('.file-panel-color-swatch[data-color="red"]');
        await redSwatch.click();
        await page.waitForTimeout(200);

        // bridge.setItemColor が呼ばれたことを確認
        const messages = await page.evaluate(() => (window as any).__testApi.notesMessages);
        const colorMsgs = messages.filter((m: any) => m.type === 'setItemColor');
        expect(colorMsgs.length).toBe(1);
        expect(colorMsgs[0].itemId).toBe('file1');
        expect(colorMsgs[0].color).toBe('red');
    });

    // DOD-11-3-4: 色付きファイルの class と SVG stroke 確認
    test('color: "blue" のファイルは notes-item-color-blue class を持ち SVG stroke が青', async ({ page }) => {
        const fileList = [
            { filePath: '/test/file1.out', title: 'BlueFile', id: 'file1' }
        ];
        const structure = {
            version: 1,
            rootIds: ['file1'],
            items: {
                file1: { type: 'file', id: 'file1', title: 'BlueFile', color: 'blue' }
            }
        };

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
        }, { fileList, structure });

        await page.waitForTimeout(200);

        // item に notes-item-color-blue class が付与されている
        const fileItem = page.locator('.file-panel-item[data-item-id="file1"]');
        await expect(fileItem).toHaveClass(/notes-item-color-blue/);

        // SVG の stroke が blue (#3b82f6 = rgb(59, 130, 246))
        const strokeColor = await page.evaluate(() => {
            const icon = document.querySelector('.file-panel-item[data-item-id="file1"] .file-panel-item-icon');
            if (!icon) return null;
            return window.getComputedStyle(icon).stroke;
        });

        // rgb(59, 130, 246) は #3b82f6
        expect(strokeColor).toBe('rgb(59, 130, 246)');
    });

    // DOD-11-3-5: None 選択で色クリア
    test('None クリック → bridge.setItemColor(id, null) が呼ばれ、色 class が消える', async ({ page }) => {
        const fileList = [
            { filePath: '/test/file1.out', title: 'RedFile', id: 'file1' }
        ];
        const structure = {
            version: 1,
            rootIds: ['file1'],
            items: {
                file1: { type: 'file', id: 'file1', title: 'RedFile', color: 'red' }
            }
        };

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
            (window as any).__testApi.notesMessages.length = 0;
        }, { fileList, structure });

        await page.waitForTimeout(200);

        // 初期状態で色付き
        const fileItem = page.locator('.file-panel-item[data-item-id="file1"]');
        await expect(fileItem).toHaveClass(/notes-item-color-red/);

        // 右クリック → Set Color → None
        await fileItem.click({ button: 'right' });
        await page.waitForTimeout(200);

        const setColorItem = page.locator('.file-panel-context-item:has-text("Set Color")');
        await setColorItem.click();
        await page.waitForTimeout(200);

        const noneBtn = page.locator('.file-panel-color-none');
        await noneBtn.click();
        await page.waitForTimeout(200);

        // bridge.setItemColor(id, null) が呼ばれたことを確認
        const messages = await page.evaluate(() => (window as any).__testApi.notesMessages);
        const colorMsgs = messages.filter((m: any) => m.type === 'setItemColor');
        expect(colorMsgs.length).toBe(1);
        expect(colorMsgs[0].itemId).toBe('file1');
        expect(colorMsgs[0].color).toBe(null);

        // 再描画後は色 class が消える（onFileListChanged をシミュレート）
        await page.evaluate(({ fileList }) => {
            const newStructure = {
                version: 1,
                rootIds: ['file1'],
                items: {
                    file1: { type: 'file', id: 'file1', title: 'RedFile' } // color なし
                }
            };
            (window as any).__notesFileListHandler(fileList, null, newStructure);
        }, { fileList });

        await page.waitForTimeout(200);

        // 色 class が消えている
        const fileItemAfter = page.locator('.file-panel-item[data-item-id="file1"]');
        const classes = await fileItemAfter.getAttribute('class');
        expect(classes).not.toContain('notes-item-color-');
    });

    // DOD-11-3-6: フォルダにも色付け可能
    test('folder header に green 色付け → header に class 付与、SVG stroke が緑', async ({ page }) => {
        const fileList: any[] = [];
        const structure = {
            version: 1,
            rootIds: ['f1'],
            items: {
                f1: { type: 'folder', id: 'f1', title: 'Folder1', childIds: [], collapsed: false }
            }
        };

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
            (window as any).__testApi.notesMessages.length = 0;
        }, { fileList, structure });

        await page.waitForTimeout(200);

        // フォルダ header を右クリック
        const folderHeader = page.locator('.file-panel-folder[data-folder-id="f1"] .file-panel-folder-header');
        await folderHeader.click({ button: 'right' });
        await page.waitForTimeout(200);

        // Set Color をクリック
        const setColorItem = page.locator('.file-panel-context-item:has-text("Set Color")');
        await setColorItem.click();
        await page.waitForTimeout(200);

        // green swatch をクリック
        const greenSwatch = page.locator('.file-panel-color-swatch[data-color="green"]');
        await greenSwatch.click();
        await page.waitForTimeout(200);

        // bridge.setItemColor が呼ばれたことを確認
        const messages = await page.evaluate(() => (window as any).__testApi.notesMessages);
        const colorMsgs = messages.filter((m: any) => m.type === 'setItemColor');
        expect(colorMsgs.length).toBe(1);
        expect(colorMsgs[0].itemId).toBe('f1');
        expect(colorMsgs[0].color).toBe('green');

        // 再描画をシミュレート（color 付きで）
        await page.evaluate(() => {
            const newStructure = {
                version: 1,
                rootIds: ['f1'],
                items: {
                    f1: { type: 'folder', id: 'f1', title: 'Folder1', childIds: [], collapsed: false, color: 'green' }
                }
            };
            (window as any).__notesFileListHandler([], null, newStructure);
        });

        await page.waitForTimeout(200);

        // folder header に notes-item-color-green class が付与されている
        const folderHeaderAfter = page.locator('.file-panel-folder[data-folder-id="f1"] .file-panel-folder-header');
        await expect(folderHeaderAfter).toHaveClass(/notes-item-color-green/);

        // SVG の stroke が green (#22c55e = rgb(34, 197, 94))
        const strokeColor = await page.evaluate(() => {
            const icon = document.querySelector('.file-panel-folder[data-folder-id="f1"] .file-panel-folder-header .file-panel-folder-icon');
            if (!icon) return null;
            return window.getComputedStyle(icon).stroke;
        });

        expect(strokeColor).toBe('rgb(34, 197, 94)');
    });
});
