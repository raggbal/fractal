/**
 * Mindmap: a node's tags are drawn once — as the pills of its text (renderInlineText), not again as a separate
 * label (L-20261108-mindmap-tag-twice: the old .mindmap-node-tags repeated them at the node's top right).
 */
import { test, expect } from '@playwright/test';

test('TC-MMT-01 a tagged node shows each tag once (the pills in its text, no separate tag label)', async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({
            version: 1, viewMode: 'mindmap', rootIds: ['r'],
            nodes: {
                r: { id: 'r', parentId: null, children: ['t'], text: 'This week #TASK', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: ['#TASK'] },
                t: { id: 't', parentId: 'r', children: [], text: 'Review onboarding PR #frontend @ana', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: false, filePath: null, tags: ['#frontend', '@ana'] },
            },
        });
    });
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    const node = page.locator('.mindmap-node[data-node-id="t"]');
    await expect(node).toBeVisible();
    await expect(node.locator('.outliner-tag')).toHaveText(['#frontend', '@ana']);
    await expect(page.locator('.mindmap-node-tags')).toHaveCount(0);
    const text = await node.evaluate((el) => el.textContent || '');
    expect(text.split('#frontend').length - 1, text).toBe(1);
    expect(text.split('@ana').length - 1, text).toBe(1);
    await expect(page.locator('.mindmap-node[data-node-id="r"] .outliner-tag')).toHaveText(['#TASK']);
});
