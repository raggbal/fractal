/**
 * Sprint: 20260424-135027-debug-banner-outliner-actions
 * FR-OL-CMDENTER-1: outliner ノードでの Cmd+Enter 動作
 *
 *   md page (isPage)  → openPage 既存挙動 (host.openPage 呼ばれる)
 *   file 添付 (filePath) → host.openAttachedFile 呼ばれる (本 sprint で新規)
 *   添付なし          → 何もしない (preventDefault のみ、新規動作なし)
 *
 * Mac/Win/Linux で metaKey / ctrlKey どちらでも発動する想定。
 * Playwright では Mac 設定で動かすので metaKey 経由でテスト。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner Cmd+Enter (FR-OL-CMDENTER-1)', () => {
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
                    // md page ノード
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
     * TC-CE-1: file 添付ノード Cmd+Enter → host.openAttachedFile が呼ばれる
     */
    test('TC-CE-1: file 添付ノード Cmd+Enter → openAttachedFile 送信', async ({ page }) => {
        await initWithMixedNodes(page);

        // n1 (file 添付) の text element に focus
        const fileText = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await fileText.click();

        // Meta+Enter 発火 (Mac 想定、Win/Linux でも ctrlKey で同等)
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(50);

        const messages = await getMessages(page);
        const openMsgs = messages.filter((m: any) => m.type === 'openAttachedFile');
        expect(openMsgs).toHaveLength(1);
        expect(openMsgs[0].nodeId).toBe('n1');
    });

    /**
     * TC-CE-2: md page ノード Cmd+Enter → 既存 openPage 挙動維持
     *
     * 注: outliner.js の `openPage(nodeId)` 関数 (L3116) は内部で
     *     `host.openPageInSidePanel(nodeId, pageId)` を呼ぶため、
     *     メッセージ type は 'openPageInSidePanel'
     */
    test('TC-CE-2: md page ノード Cmd+Enter → openPageInSidePanel 送信 (既存挙動)', async ({ page }) => {
        await initWithMixedNodes(page);

        const pageText = page.locator('.outliner-node[data-id="n2"] .outliner-text');
        await pageText.click();
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(50);

        const messages = await getMessages(page);
        const openMsgs = messages.filter((m: any) => m.type === 'openPageInSidePanel');
        expect(openMsgs.length).toBeGreaterThanOrEqual(1);
        expect(openMsgs[0].nodeId).toBe('n2');

        // openAttachedFile は呼ばれない (混入チェック)
        const openAttachedMsgs = messages.filter((m: any) => m.type === 'openAttachedFile');
        expect(openAttachedMsgs).toHaveLength(0);
    });

    /**
     * TC-CE-3: 添付なしノード Cmd+Enter → openPageInSidePanel / openAttachedFile 共に呼ばれない
     *          (preventDefault のみ、既存挙動維持)
     */
    test('TC-CE-3: 添付なしノード Cmd+Enter → 何もしない (preventDefault のみ)', async ({ page }) => {
        await initWithMixedNodes(page);

        const plainText = page.locator('.outliner-node[data-id="n3"] .outliner-text');
        await plainText.click();
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(50);

        const messages = await getMessages(page);
        const openMsgs = messages.filter((m: any) => m.type === 'openPageInSidePanel');
        const openAttachedMsgs = messages.filter((m: any) => m.type === 'openAttachedFile');

        expect(openMsgs).toHaveLength(0);
        expect(openAttachedMsgs).toHaveLength(0);
    });
});
