/**
 * 左ファイルツリー右クリック「Open in new tab」（sprint 20260725-120000-sidepanel-width-note-restore / TASK-04）。
 *
 * md / .out（outliner）の両方で、右クリックメニューに「Open in new tab」が出て、
 * 押すと bridge.openFileInTab(file.filePath) が呼ばれる（standalone スタブは notesMessages に記録）。
 * webview 内タブで開く経路（VS Code タブではない）。
 */
import { test, expect } from '@playwright/test';

const fileList = [
    { filePath: '/test/note-a.md', title: 'NoteA', id: 'note-a' },
    { filePath: '/test/outline-b.out', title: 'OutlineB', id: 'outline-b' },
];

const structure = {
    version: 1,
    rootIds: ['note-a', 'outline-b'],
    items: {
        'note-a': { type: 'file', id: 'note-a', title: 'NoteA', ext: 'md' },
        'outline-b': { type: 'file', id: 'outline-b', title: 'OutlineB', ext: 'out' },
    },
};

test.describe('左ツリー右クリック Open in new tab', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate((s) => {
            (window as any).__testApi.initNotesPanel(s.fileList, '/test/note-a.md', s.structure);
            (window as any).__testApi.notesMessages.length = 0;
        }, { fileList, structure });
    });

    // TC-OT-01: md ファイル右クリック → Open in new tab → bridge.openFileInTab(md path)
    test('TC-OT-01 md 右クリックで Open in new tab → openFileInTab(md)', async ({ page }) => {
        const mdItem = page.locator('.file-panel-item').first();
        await mdItem.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        await expect(menu).toBeVisible();
        const openTab = menu.locator('.file-panel-context-item', { hasText: 'Open in new tab' });
        await expect(openTab, 'メニューに Open in new tab が出る').toHaveCount(1);

        await openTab.click();
        await page.waitForTimeout(100);

        const messages = await page.evaluate(() => (window as any).__testApi.notesMessages);
        const hit = messages.find((m: any) => m.type === 'openFileInTab');
        expect(hit, 'openFileInTab が呼ばれた').toBeTruthy();
        expect(hit.filePath).toBe('/test/note-a.md');
    });

    // TC-OT-02: .out（outliner）ファイル右クリックでも同メニュー・同 bridge 呼び出し
    test('TC-OT-02 .out 右クリックで Open in new tab → openFileInTab(.out)', async ({ page }) => {
        const outItem = page.locator('.file-panel-item').nth(1);
        await outItem.click({ button: 'right' });
        await page.waitForTimeout(150);

        const menu = page.locator('.file-panel-context-menu');
        await expect(menu).toBeVisible();
        const openTab = menu.locator('.file-panel-context-item', { hasText: 'Open in new tab' });
        await expect(openTab, '.out でもメニューに Open in new tab が出る').toHaveCount(1);

        await openTab.click();
        await page.waitForTimeout(100);

        const messages = await page.evaluate(() => (window as any).__testApi.notesMessages);
        const hit = messages.find((m: any) => m.type === 'openFileInTab');
        expect(hit, '.out でも openFileInTab が呼ばれた').toBeTruthy();
        expect(hit.filePath).toBe('/test/outline-b.out');
    });
});
