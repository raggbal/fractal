/**
 * spec 20261027-1142-recent-history-nav D6 — main md の outline（TOC サイドバー）は note ごとに
 * 「一度開いたら次の md でも開いたまま」。既定は閉。sidepanel を開くときの自動の閉じ / 復帰は記録しない。
 */
import { test, expect, Page } from '@playwright/test';

async function openMainMd(page: Page, filePath: string, body: string): Promise<void> {
    await page.evaluate(({ filePath, body }) => {
        (window as any).__hostMessageHandler({ type: 'updateData', kind: 'md', markdown: body, filePath, documentBaseUri: '' });
    }, { filePath, body });
    await page.waitForSelector('.markdown-container .editor', { timeout: 5000 });
}
const outlineShown = (page: Page) => page.evaluate(() => {
    const sb = document.querySelector('.markdown-container #sidebar, .markdown-container .sidebar');
    return !!sb && !sb.classList.contains('hidden');
});
const saved = (page: Page) => page.evaluate(() => (window as any).__testApi.notesMessages.filter((m: any) => m.type === 'saveMdOutlineOpen').map((m: any) => m.open));

test('AC-5 outline を開くと同じ note の次の md でも開いたまま、閉じれば次も閉。開閉は host に保存される', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__hostMessageHandler && (window as any).__testApi);
    await page.evaluate(() => {
        const fileList = [{ filePath: '/test/a.md', title: 'A', id: 'a' }, { filePath: '/test/b.md', title: 'B', id: 'b' }];
        const structure = { version: 1, rootIds: ['a', 'b'], items: { a: { type: 'file', id: 'a', title: 'A', ext: 'md' }, b: { type: 'file', id: 'b', title: 'B', ext: 'md' } } };
        (window as any).__testApi.initNotesPanel(fileList, '/test/a.md', structure);
        (window as any).__notesMdOutlineOpen = false;
    });

    await openMainMd(page, '/test/a.md', '# A\n\n## a1\n');
    expect(await outlineShown(page), '既定は閉').toBe(false);

    await page.locator('.markdown-container [data-action="openOutline"]').first().click();
    expect(await outlineShown(page)).toBe(true);
    await openMainMd(page, '/test/b.md', '# B\n\n## b1\n');
    expect(await outlineShown(page), '開いたら次の md でも開いたまま').toBe(true);

    await page.locator('.markdown-container .sidebar-toggle').first().click();
    expect(await outlineShown(page)).toBe(false);
    await openMainMd(page, '/test/a.md', '# A\n\n## a1\n');
    expect(await outlineShown(page), '閉じたら次の md でも閉').toBe(false);

    expect(await saved(page)).toEqual([true, false]);
});
