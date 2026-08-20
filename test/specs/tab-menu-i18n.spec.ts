/**
 * TC-MLG-05 (動的部) — notes タブ context menu が i18n（window.__outlinerMessages）を参照する
 * （sprint 20260818-183407 FR-MLG-03）
 * counterfactual: raw 英語直書きのままだと ja 注入後もメニューが英語 = RED。
 */
import { test, expect, Page } from '@playwright/test';

async function setupTabs(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        const w = window as any;
        w.__testApi.initTabManager();
        w.__outlinerMessages = Object.assign({}, w.__outlinerMessages, {
            tabOpenInStandalone: 'スタンドアロンで開く',
            tabOpenInOsDefaultApp: 'OS 既定アプリで開く',
            tabDuplicate: 'タブを複製',
            tabCloseOthers: '他のタブを閉じる',
            tabCloseAria: 'タブを閉じる',
            tabNewAria: '新しいタブ（現在を複製）',
            tabUntitled: '無題',
        });
        const tm = w.__notesTabManager;
        tm.initFirstTab('/note/a.out', 'out');
        tm.openInNewTab('/note/b.md', 'md');
    });
    await page.waitForTimeout(200);
}

test('TC-MLG-05c md タブ右クリック menu が ja 文言で表示される', async ({ page }) => {
    await setupTabs(page);
    const labels = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.notes-tab')) as HTMLElement[];
        const mdTab = tabs[tabs.length - 1];
        mdTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
        // tab context menu は file-panel-context-menu class を流用（notes-tab-manager.js :180）
        const menus = Array.from(document.querySelectorAll('.file-panel-context-menu'));
        const menu = menus[menus.length - 1];
        return menu ? (menu.textContent || '') : '(menu not found)';
    });
    expect(labels).toContain('タブを複製');
    expect(labels).toContain('他のタブを閉じる');
    expect(labels).toContain('スタンドアロンで開く');
    expect(labels).not.toContain('Duplicate Tab');
});
