/**
 * mindmap editor の cmd+enter で md 未添付 node → md 作成+添付+sidepanel オープン。
 * sprint 20260721-134546 TASK-A2（outliner の TASK-A を mindmap にも反映）。
 *
 * el.focus() 直呼び禁止（generator_failures 2026-07-02）: locator.click()（実選択）→ keyboard.press。
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
async function init(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}
function n(id: string, text: string, extra: any = {}) {
    return Object.assign({ id, parentId: null, children: [], text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
}
function msgs(page: import('@playwright/test').Page) {
    return page.evaluate(() => (window as any).__testApi.messages);
}

// TC-CE-M1: mindmap で md 未添付 node の cmd+enter → makePage + openPageInSidePanel
test('TC-CE-M1 mindmap cmd+enter で空 node が makePage + openPageInSidePanel', async ({ page }) => {
    await setup(page);
    await init(page, { version: 1, viewMode: 'mindmap', rootIds: ['r', 'plain'],
        nodes: { r: n('r', 'Root', { children: ['plain'] }), plain: n('plain', 'Plain', { parentId: 'r' }) } });
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

    // 実選択（click）→ 実キー（Meta+Enter）
    await page.locator('.mindmap-node[data-node-id="plain"]').click();
    await page.waitForTimeout(50);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(80);

    const m = await msgs(page);
    const make = m.filter((x: any) => x.type === 'makePage' && x.nodeId === 'plain');
    const open = m.filter((x: any) => x.type === 'openPageInSidePanel' && x.nodeId === 'plain');
    expect(make.length, 'makePage 発火').toBe(1);
    expect(open.length, 'openPageInSidePanel 発火').toBe(1);
    expect(m.indexOf(make[0])).toBeLessThan(m.indexOf(open[0]));   // makePage が先
});

// TC-CE-M2: 既存 isPage node の cmd+enter は openPage のみ（makePage 発火せず・回帰）
test('TC-CE-M2 mindmap cmd+enter で isPage node は openPage のみ（回帰）', async ({ page }) => {
    await setup(page);
    await init(page, { version: 1, viewMode: 'mindmap', rootIds: ['r', 'pg'],
        nodes: { r: n('r', 'Root', { children: ['pg'] }), pg: n('pg', 'Page', { parentId: 'r', isPage: true, pageId: 'uuid-pg' }) } });
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

    await page.locator('.mindmap-node[data-node-id="pg"]').click();
    await page.waitForTimeout(50);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(80);

    const m = await msgs(page);
    expect(m.filter((x: any) => x.type === 'openPageInSidePanel' && x.nodeId === 'pg').length).toBe(1);
    expect(m.filter((x: any) => x.type === 'makePage').length, 'isPage node では makePage 発火しない').toBe(0);
});
