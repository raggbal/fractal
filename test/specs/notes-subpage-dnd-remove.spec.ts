/**
 * TASK-19 追補（2026-08-05 手動テスト第 3 陣）
 *
 * TC-B19-04  removeSubpageLink 受信 → 元 md のアンカー除去 + serialize から [[...]] が消える
 * TC-B19-05  subpage アンカーは draggable=true・通常リンクは非 draggable（掴んで D&D できる）
 */
import { test, expect } from '@playwright/test';

test('TC-B19-04 removeSubpageLink → アンカー除去 + sync 内容から [[Sub]] 消滅', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md', markdown: '# Cur\n\n[[Sub]](sub-x.md)\n',
            filePath: '/test/current.md', documentBaseUri: '',
        });
    });
    await page.waitForTimeout(300);
    expect(await page.locator('.markdown-container .editor a[data-subpage="true"]').count()).toBe(1);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'removeSubpageLink', href: 'sub-x.md', sourceMdPath: '/test/current.md',
        });
    });
    await page.waitForTimeout(1200); // debounced sync を待つ
    expect(await page.locator('.markdown-container .editor a[data-subpage="true"]').count()).toBe(0);
    const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
    const saves = msgs.filter((m: any) => m.type === 'notesSaveCurrentMd');
    expect(saves.length).toBeGreaterThan(0);
    expect(saves[saves.length - 1].content).not.toContain('[[Sub]]');
});

test('TC-B19-05 subpage アンカーは draggable / 通常リンクは非 draggable', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md',
            markdown: '# C\n\n[[Sub]](s.md)\n\n[plain](https://example.com)\n',
            filePath: '/test/c.md', documentBaseUri: '',
        });
    });
    await page.waitForTimeout(300);
    expect(await page.getAttribute('.markdown-container .editor a[data-subpage="true"]', 'draggable')).toBe('true');
    const normalDraggable = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('.markdown-container .editor a'));
        const a = links.find(l => !(l as HTMLElement).dataset.subpage) as HTMLElement;
        return a ? a.getAttribute('draggable') : 'missing';
    });
    expect(normalDraggable).toBeNull();
});
