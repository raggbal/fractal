/**
 * FR-TH-04: outliner の page node text 確定 → 添付 page md の先頭 H1 を text に同期。
 * standalone は実 fs 書換不可なので、host への syncNodeTextToPageH1 メッセージ送出で検証。
 * host 側の実 H1 書換は unit（notes-file-manager-title-h1 の setFirstH1/writeFileIfChanged）で担保。
 */
import { test, expect } from '@playwright/test';

test.describe('FR-TH-04 node text → page md H1 (standalone-outliner)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // TC-TH-05: page node の text を実キー編集して確定 → syncNodeTextToPageH1 送出
    test('TC-TH-05 page node text 確定で syncNodeTextToPageH1 送出', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Old', tags: [], isPage: true, pageId: 'pg-th05' }
                }
            });
            (window as any).__testApi.messages = [];
        });

        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.keyboard.press('End');
        await page.keyboard.type('X'); // "Old" → "OldX"
        // 確定（blur）— 別要素をクリックしてフォーカスを外す
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(150);

        const msgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'syncNodeTextToPageH1'));
        expect(msgs.length, 'syncNodeTextToPageH1 が送出される').toBeGreaterThanOrEqual(1);
        const last = msgs[msgs.length - 1];
        expect(last.pageId).toBe('pg-th05');
        expect(last.text).toBe('OldX');
    });

    // TC-TH-05b: page でない通常 node の編集では送らない（counterfactual）
    test('TC-TH-05b 通常 node（非 page）の編集では送出しない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Plain', tags: [] } // isPage なし
                }
            });
            (window as any).__testApi.messages = [];
        });

        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.keyboard.press('End');
        await page.keyboard.type('Y');
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(150);

        const msgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'syncNodeTextToPageH1'));
        expect(msgs.length, '非 page node では送らない').toBe(0);
    });

    // TC-TH-13: 未編集 page node の blur では送出しない（★手動テスト起因バグの番人・load-bearing）
    // page md を単独編集後 → outliner で該当 node を編集せず Cmd+Enter/blur しただけで
    // node の古い text が H1 を上書きしてしまう回帰を防ぐ。
    test('TC-TH-13 未編集 page node の blur では syncNodeTextToPageH1 を送らない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Old', tags: [], isPage: true, pageId: 'pg-th13' }
                }
            });
            (window as any).__testApi.messages = [];
        });

        // node に focus するが text は一切編集しない → blur（別要素クリック = Cmd+Enter で開くのと同じく focus が外れる）
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(50);
        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(150);

        const msgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'syncNodeTextToPageH1'));
        expect(msgs.length, '未編集 blur では送出しない（H1 を上書きしない）').toBe(0);
    });
});
