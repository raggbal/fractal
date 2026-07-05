/**
 * Mindmap Mode — attachment inheritance (Wave 6, TASK-14)
 * TC-230 Page open via Cmd+Enter → openPageInSidePanel message
 * sprint 20260701-122355-outliner-mindmap-mode
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
async function init(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(120);
}
function pageTree() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['n1'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: ['p'], text: 'Root', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            p: { id: 'p', parentId: 'n1', children: [], text: 'PageNode', collapsed: false, subtext: '', images: [], isPage: true, pageId: 'uuid-p', checked: null, filePath: null, tags: [] }
        }
    };
}

test('TC-230 dblclick Page node opens side panel (openPageInSidePanel msg)', async ({ page }) => {
    await setup(page); await init(page, pageTree());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await page.locator('.mindmap-node[data-node-id="p"]').dblclick();
    await page.waitForTimeout(100);
    const opened = await page.evaluate(() =>
        (window as any).__testApi.messages.some((m: any) => m.type === 'openPageInSidePanel' && m.nodeId === 'p'));
    expect(opened).toBe(true);
});

test('TC-155b Page node shows page icon in mindmap', async ({ page }) => {
    await setup(page); await init(page, pageTree());
    await expect(page.locator('.mindmap-node[data-node-id="p"] .mindmap-node-icon')).toHaveCount(1);
});
