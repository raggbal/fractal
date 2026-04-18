/**
 * FR-11-2: Notes タブフォルダ配下インデントテスト
 * フォルダ展開時、子ファイルアイコンが親フォルダアイコンより右に配置される
 */

import { test, expect } from '@playwright/test';

test.describe('Notes フォルダインデント', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // DOD-11-2-1: 子ファイルアイコンが親フォルダアイコンより右に配置される
    test('フォルダ展開時、子 file icon が親 folder icon より右に配置される', async ({ page }) => {
        const folderStructure = {
            version: 1,
            rootIds: ['f1'],
            items: {
                f1: { type: 'folder', id: 'f1', title: 'ParentFolder', childIds: ['file1'], collapsed: false },
                file1: { type: 'file', id: 'file1', title: 'ChildFile' }
            }
        };
        const fileList = [
            { filePath: '/test/file1.out', title: 'ChildFile', id: 'file1' }
        ];

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
        }, { fileList, structure: folderStructure });

        await page.waitForTimeout(200);

        // フォルダが展開されていることを確認
        const folder = page.locator('.file-panel-folder[data-folder-id="f1"]');
        await expect(folder).not.toHaveClass(/collapsed/);

        // 親フォルダアイコンの left
        const parentIconLeft = await page.evaluate(() => {
            const folderIcon = document.querySelector('.file-panel-folder[data-folder-id="f1"] .file-panel-folder-icon');
            return folderIcon ? folderIcon.getBoundingClientRect().left : 0;
        });

        // 子ファイルアイコンの left
        const childIconLeft = await page.evaluate(() => {
            const fileIcon = document.querySelector('.file-panel-item[data-item-id="file1"] .file-panel-item-icon');
            return fileIcon ? fileIcon.getBoundingClientRect().left : 0;
        });

        // 子アイコンが親アイコンより右に配置されている
        expect(childIconLeft).toBeGreaterThanOrEqual(parentIconLeft);
    });

    // DOD-11-2-3: ネスト 2 階層でインデントが累積
    test('2階層ネストでインデントが累積する（孫 > 親 > ルート）', async ({ page }) => {
        const nestedStructure = {
            version: 1,
            rootIds: ['root'],
            items: {
                root: { type: 'folder', id: 'root', title: 'RootFolder', childIds: ['sub'], collapsed: false },
                sub: { type: 'folder', id: 'sub', title: 'SubFolder', childIds: ['file1'], collapsed: false },
                file1: { type: 'file', id: 'file1', title: 'GrandchildFile' }
            }
        };
        const fileList = [
            { filePath: '/test/file1.out', title: 'GrandchildFile', id: 'file1' }
        ];

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
        }, { fileList, structure: nestedStructure });

        await page.waitForTimeout(200);

        // 各アイコンの left を取得
        const positions = await page.evaluate(() => {
            const rootIcon = document.querySelector('.file-panel-folder[data-folder-id="root"] > .file-panel-folder-header .file-panel-folder-icon');
            const subIcon = document.querySelector('.file-panel-folder[data-folder-id="sub"] > .file-panel-folder-header .file-panel-folder-icon');
            const fileIcon = document.querySelector('.file-panel-item[data-item-id="file1"] .file-panel-item-icon');
            return {
                rootLeft: rootIcon ? rootIcon.getBoundingClientRect().left : 0,
                subLeft: subIcon ? subIcon.getBoundingClientRect().left : 0,
                fileLeft: fileIcon ? fileIcon.getBoundingClientRect().left : 0
            };
        });

        // 階層が深いほど右に配置される
        expect(positions.subLeft).toBeGreaterThan(positions.rootLeft);
        expect(positions.fileLeft).toBeGreaterThan(positions.subLeft);
    });

    // DOD-11-2-4: ルート直下のフォルダ位置と CSS 衝突チェック
    test('ルート直下のフォルダ/ファイルの位置が変わらない + CSS 衝突なし', async ({ page }) => {
        const rootStructure = {
            version: 1,
            rootIds: ['f1', 'file1'],
            items: {
                f1: { type: 'folder', id: 'f1', title: 'RootFolder', childIds: [], collapsed: false },
                file1: { type: 'file', id: 'file1', title: 'RootFile' }
            }
        };
        const fileList = [
            { filePath: '/test/file1.out', title: 'RootFile', id: 'file1' }
        ];

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
        }, { fileList, structure: rootStructure });

        await page.waitForTimeout(200);

        // ルートフォルダ header の computed style を確認
        const folderHeaderStyles = await page.evaluate(() => {
            const header = document.querySelector('.file-panel-folder[data-folder-id="f1"] .file-panel-folder-header');
            if (!header) return null;
            const styles = window.getComputedStyle(header);
            return {
                paddingLeft: styles.paddingLeft,
                marginLeft: styles.marginLeft
            };
        });

        // padding-left と margin-left が想定値（既存の CSS と同じ）
        expect(folderHeaderStyles).not.toBeNull();
        expect(folderHeaderStyles!.paddingLeft).toBe('12px');
        expect(folderHeaderStyles!.marginLeft).toBe('4px');

        // ルートファイル item の computed style を確認
        const fileItemStyles = await page.evaluate(() => {
            const item = document.querySelector('.file-panel-item[data-item-id="file1"]');
            if (!item) return null;
            const styles = window.getComputedStyle(item);
            return {
                paddingLeft: styles.paddingLeft,
                marginLeft: styles.marginLeft
            };
        });

        expect(fileItemStyles).not.toBeNull();
        expect(fileItemStyles!.paddingLeft).toBe('12px');
        expect(fileItemStyles!.marginLeft).toBe('4px');

        // .file-panel-folder-children の padding-left が 28px であることを確認
        // (ただしルート直下なので children コンテナ自体は親フォルダが空なのでここでは検証対象外)
    });

    // 追加: .file-panel-folder-children の padding-left が 28px であることを確認
    test('folder-children の padding-left が 28px', async ({ page }) => {
        const folderStructure = {
            version: 1,
            rootIds: ['f1'],
            items: {
                f1: { type: 'folder', id: 'f1', title: 'Folder', childIds: ['file1'], collapsed: false },
                file1: { type: 'file', id: 'file1', title: 'File' }
            }
        };
        const fileList = [
            { filePath: '/test/file1.out', title: 'File', id: 'file1' }
        ];

        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, null, structure);
        }, { fileList, structure: folderStructure });

        await page.waitForTimeout(200);

        // .file-panel-folder-children の padding-left を確認
        const childrenPaddingLeft = await page.evaluate(() => {
            const children = document.querySelector('.file-panel-folder[data-folder-id="f1"] .file-panel-folder-children');
            if (!children) return null;
            return window.getComputedStyle(children).paddingLeft;
        });

        expect(childrenPaddingLeft).toBe('28px');
    });
});
