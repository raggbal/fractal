/**
 * spec 20261027-1142-recent-history-nav D7 — folder link をメインで開いて note パネルを閉じても、
 * folder view のヘッダに note パネルを開くボタン（≡ .notes-panel-toggle-btn）が出て開き直せる。
 * 🔴 counterfactual: 実装前は folder view にボタンが無く、パネルを閉じると開けなくなる（実機 2026-10-27）。
 */
import { test, expect } from '@playwright/test';

test('AC-6 folder view を開いて note パネルを閉じるとヘッダに ≡ が出て、押すとパネルが開く', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__folderViewDispatcher && document.querySelector('.notes-file-panel'));
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.waitForSelector('#folderViewContainer .fv-header', { state: 'visible', timeout: 5000 });
    const toggle = page.locator('#folderViewContainer .fv-header .notes-panel-toggle-btn');
    await expect(toggle).toHaveCount(1);
    await expect(toggle, 'パネルが開いている間は出さない').toBeHidden();

    // 実際の閉じるボタンでパネルを閉じる
    await page.evaluate(() => {
        const panel = document.querySelector('.notes-file-panel') as HTMLElement;
        panel.style.width = '';
        panel.classList.add('collapsed');
    });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('.notes-file-panel')).not.toHaveClass(/collapsed/);
    await expect(toggle).toBeHidden();

    // 開き直しても 1 個だけ（重複注入しない）
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await expect(page.locator('#folderViewContainer .notes-panel-toggle-btn')).toHaveCount(1);
});
