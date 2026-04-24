/**
 * Sprint: 20260424-135027-debug-banner-outliner-actions
 * FR-OL-COPYPATH-1: outliner 右クリックメニューに "Copy File Path" を追加
 *
 * 設計判断 (session-log 参照):
 *   - **file 添付ノード**には新規 "Copy File Path" を追加 (新規 host メッセージ
 *     `copyAttachedFilePath`)。本 sprint で実装される新機能。
 *   - **md page ノード**は既存の "Copy Page Path" メニューが既に同等機能を
 *     提供しているため、本 sprint では新規追加せず既存を活用 (重複回避)。
 *     → md page の Copy Page Path テストは別 spec
 *        (test/specs/outliner-copy-page-path.spec.ts) で既にカバー済み。
 *   - 添付なしノードには表示しない。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner Copy File Path (file 添付ノード)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    async function initWithMixedNodes(page: any) {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3'],
                nodes: {
                    // file 添付ノード
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'PDF attached',
                        tags: [],
                        filePath: 'files/test.pdf'
                    },
                    // md page ノード (既存 Copy Page Path 利用想定、本 spec の対象外)
                    n2: {
                        id: 'n2',
                        parentId: null,
                        children: [],
                        text: 'Page node',
                        tags: [],
                        isPage: true,
                        pageId: 'page-aaa'
                    },
                    // 添付なしノード
                    n3: {
                        id: 'n3',
                        parentId: null,
                        children: [],
                        text: 'Plain node',
                        tags: []
                    }
                }
            });
        });
    }

    function getMessages(page: any) {
        return page.evaluate(() => (window as any).__testApi.messages);
    }

    /**
     * TC-CP-1: file 添付ノード右クリック → "Copy File Path" 表示 + クリックで host.copyAttachedFilePath 呼出
     */
    test('TC-CP-1: file 添付ノードに Copy File Path 表示 + クリックで copyAttachedFilePath 送信', async ({ page }) => {
        await initWithMixedNodes(page);
        const fileNode = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await fileNode.click({ button: 'right' });

        const menuItems = page.locator('.outliner-context-menu-item .context-menu-label');
        const texts = await menuItems.allTextContents();
        expect(texts).toContain('Copy File Path');

        // クリック → host メッセージ確認
        const menuItem = page.locator('.outliner-context-menu-item .context-menu-label', { hasText: 'Copy File Path' });
        await menuItem.click();

        const messages = await getMessages(page);
        const copyMsgs = messages.filter((m: any) => m.type === 'copyAttachedFilePath');
        expect(copyMsgs).toHaveLength(1);
        expect(copyMsgs[0].nodeId).toBe('n1');
    });

    /**
     * TC-CP-3: 通常 (添付なし) ノード → "Copy File Path" 表示**されない**
     */
    test('TC-CP-3: 添付なしノードに Copy File Path 表示されない', async ({ page }) => {
        await initWithMixedNodes(page);
        const plainNode = page.locator('.outliner-node[data-id="n3"] .outliner-text');
        await plainNode.click({ button: 'right' });

        const menuItems = page.locator('.outliner-context-menu-item .context-menu-label');
        const texts = await menuItems.allTextContents();
        expect(texts).not.toContain('Copy File Path');
    });

    /**
     * TC-CP-2 (調整版): md page ノードは既存 "Copy Page Path" が機能的に等価
     *
     * 元の TC-CP-2 は「md page で新規 "Copy File Path" を表示」を想定したが、
     * 既存 outlinerCopyPagePath が同じ host メッセージ `copyPagePaths` を送る
     * ため重複となる。md page は既存 Copy Page Path で対応 (このテストでも確認)。
     */
    test('TC-CP-2 (調整): md page ノードに既存 Copy Page Path が表示される (本 sprint で重複追加なし)', async ({ page }) => {
        await initWithMixedNodes(page);
        const pageNode = page.locator('.outliner-node[data-id="n2"] .outliner-text');
        await pageNode.click({ button: 'right' });

        const menuItems = page.locator('.outliner-context-menu-item .context-menu-label');
        const texts = await menuItems.allTextContents();
        // 既存メニュー項目 (Copy Page Path) で機能カバー済み
        expect(texts).toContain('Copy Page Path');
        // 本 sprint では md page に "Copy File Path" を二重追加しない (重複回避)
        expect(texts).not.toContain('Copy File Path');
    });

    /**
     * TC-CP-4: i18n key `outlinerCopyFilePath` が menu label として使われる
     *
     * 注: standalone-outliner.html は i18n の en.ts を inline する。
     * 'Copy File Path' (英語) が表示されることを確認 = i18n key が読まれている。
     * 7 言語完全カバーの assertion は test/unit/i18n-copy-file-path.spec.ts で実施。
     */
    test('TC-CP-4: i18n.outlinerCopyFilePath ("Copy File Path") が表示される', async ({ page }) => {
        await initWithMixedNodes(page);
        const fileNode = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await fileNode.click({ button: 'right' });

        const menuItem = page.locator('.outliner-context-menu-item .context-menu-label', {
            hasText: 'Copy File Path'
        });
        await expect(menuItem).toBeVisible();
    });
});
