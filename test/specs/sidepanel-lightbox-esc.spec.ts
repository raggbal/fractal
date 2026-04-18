/**
 * FR-11-1: Lightbox ESC 分離テスト
 * lightbox (image overlay) が開いている時は ESC で overlay のみ閉じ、side panel は開いたまま
 */

import { test, expect } from '@playwright/test';

test.describe('Sidepanel Lightbox ESC 分離', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // DOD-11-1-1: side panel 内で lightbox 表示時、ESC で lightbox のみ閉じ side panel は開いたまま
    test('lightbox 表示中に ESC → overlay 消え、side panel は open 維持', async ({ page }) => {
        // 1. Outliner にデータを初期化
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'テスト', tags: [] }
                }
            });
        });

        // 2. side panel を開く
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: '# Test\n\n![image](test.png)',
                filePath: '/test/pages/test.md',
                fileName: 'test.md',
                toc: [],
                documentBaseUri: ''
            });
        });
        await page.waitForTimeout(200);

        // side panel が open 状態
        const sidePanel = page.locator('.side-panel');
        await expect(sidePanel).toHaveClass(/open/);

        // 3. lightbox overlay をプログラムで作成（実際の dblclick の代わり）
        await page.evaluate(() => {
            const overlay = document.createElement('div');
            overlay.className = 'outliner-image-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999';
            const img = document.createElement('img');
            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            overlay.appendChild(img);
            document.body.appendChild(overlay);

            // lightbox の escHandler も登録（実際の lightbox と同じ挙動）
            const escHandler = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    overlay.remove();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        });

        // overlay が表示されていることを確認
        await expect(page.locator('.outliner-image-overlay')).toBeVisible();

        // 4. ESC を押す
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // 5. overlay は消えている
        await expect(page.locator('.outliner-image-overlay')).toHaveCount(0);

        // 6. side panel は open 維持
        await expect(sidePanel).toHaveClass(/open/);
    });

    // DOD-11-1-2: lightbox 未表示時の ESC は従来どおり side panel を閉じる
    test('lightbox 未表示時に ESC → side panel が閉じる（退行テスト）', async ({ page }) => {
        // 1. Outliner にデータを初期化
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'テスト', tags: [] }
                }
            });
        });

        // 2. side panel を開く
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: '# Test\n\nNo image here',
                filePath: '/test/pages/test.md',
                fileName: 'test.md',
                toc: [],
                documentBaseUri: ''
            });
        });
        await page.waitForTimeout(200);

        // side panel が open 状態
        const sidePanel = page.locator('.side-panel');
        await expect(sidePanel).toHaveClass(/open/);

        // lightbox overlay が存在しないことを確認
        await expect(page.locator('.outliner-image-overlay')).toHaveCount(0);

        // 3. side panel 外の要素にフォーカスを移す（検索バー）
        await page.locator('.outliner-search-input').click({ force: true });
        await page.waitForTimeout(100);

        // 4. ESC を押す
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        // 5. side panel は閉じている（open class がない）
        await expect(sidePanel).not.toHaveClass(/open/);
    });

    // DOD-11-1-4: standalone editor での lightbox ESC 挙動（side panel 無関係）
    test('overlay 表示中に ESC → overlay 消える（side panel は元から存在しない/非open）', async ({ page }) => {
        // standalone-notes.html では side panel は存在するが、初期状態では open でない

        // 1. overlay を作成
        await page.evaluate(() => {
            const overlay = document.createElement('div');
            overlay.className = 'outliner-image-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999';
            const img = document.createElement('img');
            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            overlay.appendChild(img);
            document.body.appendChild(overlay);

            const escHandler = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    overlay.remove();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        });

        // overlay が表示されていることを確認
        await expect(page.locator('.outliner-image-overlay')).toBeVisible();

        // side panel は open でない
        const sidePanel = page.locator('.side-panel');
        await expect(sidePanel).not.toHaveClass(/open/);

        // 2. ESC を押す
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // 3. overlay は消えている
        await expect(page.locator('.outliner-image-overlay')).toHaveCount(0);

        // side panel は元から open でないまま
        await expect(sidePanel).not.toHaveClass(/open/);
    });

    // DOD-11-1-5: outliner + side panel + lightbox のフルシナリオ
    test('outliner 経由で side panel MD 表示 → lightbox → ESC → overlay 消え、side panel 維持、outliner 操作可能', async ({ page }) => {
        // 1. Outliner にデータを初期化
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'ノード1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'ノード2', tags: [] }
                }
            });
        });

        // 2. side panel を開く
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: '# Page\n\n![img](test.png)',
                filePath: '/test/pages/page.md',
                fileName: 'page.md',
                toc: [],
                documentBaseUri: ''
            });
        });
        await page.waitForTimeout(200);

        const sidePanel = page.locator('.side-panel');
        await expect(sidePanel).toHaveClass(/open/);

        // 3. lightbox overlay を作成
        await page.evaluate(() => {
            const overlay = document.createElement('div');
            overlay.className = 'outliner-image-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999';
            const img = document.createElement('img');
            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            overlay.appendChild(img);
            document.body.appendChild(overlay);

            const escHandler = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    overlay.remove();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        });

        await expect(page.locator('.outliner-image-overlay')).toBeVisible();

        // 4. ESC を押す
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // 5. overlay は消えている
        await expect(page.locator('.outliner-image-overlay')).toHaveCount(0);

        // 6. side panel は open 維持
        await expect(sidePanel).toHaveClass(/open/);

        // 7. outliner の main エリアが操作可能（検索バーが visible で操作可能）
        const searchInput = page.locator('.outliner-search-input');
        await expect(searchInput).toBeVisible();
        await expect(searchInput).toBeEnabled();

        // outliner のノードも visible
        const firstNode = page.locator('.outliner-node').first();
        await expect(firstNode).toBeVisible();
    });
});
