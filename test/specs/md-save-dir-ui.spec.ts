/**
 * 保存先変更 UI（standalone md 限定）— FR-MD-02/03, NFR-MD-01。
 *
 * sidebar-footer の「画像保存先/ファイル保存先」表示は、imageDirStatus/fileDirStatus の
 * editable:true のとき is-editable クラスが付きクリックで host.setSaveDir(kind) を送る。
 * editable:false では is-editable が付かずクリックしても飛ばない（counterfactual）。
 * メッセージ注入は window.__hostMessageHandler、送信検証は window.__testApi.messages。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}

test.describe('保存先変更 UI (standalone-editor)', () => {
    test.beforeEach(async ({ page }) => { await boot(page); });

    // TC-UI-01: editable:true → is-editable クラス付与
    test('TC-UI-01 imageDirStatus{editable:true} で is-editable が付く', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'imageDirStatus', displayPath: 'images', source: 'default', locked: false, editable: true });
        });
        await page.waitForTimeout(50);
        const cls = await page.evaluate(() => document.querySelector('.sidebar-status-imagedir')?.className || '');
        expect(cls).toContain('is-editable');
    });

    // TC-UI-02: is-editable なクリック → setSaveDir メッセージ（image/file）
    test('TC-UI-02 クリックで setSaveDir が飛ぶ（image / file）', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'imageDirStatus', displayPath: 'images', source: 'default', locked: false, editable: true });
            (window as any).__hostMessageHandler({ type: 'fileDirStatus', displayPath: 'files', source: 'default', locked: false, editable: true });
        });
        await page.waitForTimeout(50);
        await page.click('.sidebar-status-imagedir');
        await page.click('.sidebar-status-filedir');
        await page.waitForTimeout(50);
        const msgs = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => m.type === 'setSaveDir'));
        const kinds = msgs.map((m: any) => m.kind).sort();
        expect(kinds).toEqual(['file', 'image']);
    });

    // TC-UI-03（★load-bearing・counterfactual）: editable:false → is-editable 付かず・クリックで飛ばない
    test('TC-UI-03 editable:false ではクリックしても setSaveDir が飛ばない', async ({ page }) => {
        // まず TC-UI-02 相当が動くこと（editable:true で 1 件飛ぶ）を確認
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'imageDirStatus', displayPath: 'images', source: 'default', locked: false, editable: true });
        });
        await page.waitForTimeout(30);
        await page.click('.sidebar-status-imagedir');
        await page.waitForTimeout(30);
        let n = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => m.type === 'setSaveDir').length);
        expect(n).toBe(1); // 前提: editable:true では飛ぶ（番人が空振りでない）

        // editable:false に更新 → is-editable が外れ、クリックしても増えない
        await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            (window as any).__hostMessageHandler({ type: 'imageDirStatus', displayPath: 'images', source: 'default', locked: false, editable: false });
        });
        await page.waitForTimeout(30);
        const cls = await page.evaluate(() => document.querySelector('.sidebar-status-imagedir')?.className || '');
        expect(cls).not.toContain('is-editable');
        await page.click('.sidebar-status-imagedir');
        await page.waitForTimeout(30);
        n = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => m.type === 'setSaveDir').length);
        expect(n).toBe(0); // ★counterfactual: is-editable ガードが番人（外すと飛んで RED）
    });

    // TC-UI-04: page-title は常時表示（設定トグル削除・DOM 保持）— standalone-outliner で確認
    test('TC-UI-04 outliner の page-title 入力が存在し可視（常時表示）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        const info = await page.evaluate(() => {
            const el = document.querySelector('.outliner-page-title') as HTMLElement | null;
            const input = document.querySelector('.outliner-page-title-input') as HTMLElement | null;
            if (!el || !input) return { exists: false, visible: false };
            const style = getComputedStyle(el);
            return { exists: true, visible: style.display !== 'none' };
        });
        expect(info.exists).toBe(true);
        expect(info.visible).toBe(true);
    });
});
