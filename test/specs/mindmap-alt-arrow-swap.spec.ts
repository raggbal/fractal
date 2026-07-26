/**
 * mindmap Alt(option)+↑/↓ で兄弟 node の位置入れ替え（機能②③）。
 * sprint 20260721-145658。model.moveUp/moveDown を Alt+Arrow で呼ぶ。端では no-op。
 * el.focus() 直呼び禁止（generator_failures 2026-07-02）: locator.click → keyboard.press。
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function n(id: string, text: string, extra: any = {}) {
    return Object.assign({ id, parentId: null, children: [], text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}
// model を読む共通手段: __testApi.messages の最新 syncData (JSON) から children を取る
async function orderFromSync(page: import('@playwright/test').Page, parentId: string) {
    return page.evaluate((pid) => {
        const msgs = ((window as any).__testApi.messages || []) as any[];
        let last: any = null;
        for (const m of msgs) { if (m.type === 'syncData' && m.content) last = m; }
        if (!last) return null;
        try {
            const d = JSON.parse(last.content);
            const node = d.nodes[pid];
            return node ? node.children.slice() : (pid === '__root__' ? d.rootIds.slice() : null);
        } catch { return null; }
    }, parentId);
}

async function selectAndKey(page: import('@playwright/test').Page, nodeId: string, key: string) {
    await page.locator(`.mindmap-node[data-node-id="${nodeId}"]`).click();
    await page.waitForTimeout(50);
    await page.keyboard.press(key);
    // scheduleSyncToHost は 1000ms debounce なので syncData 反映まで待つ
    await page.waitForTimeout(1200);
}

const TREE = () => ({ version: 1, viewMode: 'mindmap', rootIds: ['r'],
    nodes: { r: n('r', 'Root', { children: ['a', 'b', 'c'] }),
        a: n('a', 'A', { parentId: 'r' }), b: n('b', 'B', { parentId: 'r' }), c: n('c', 'C', { parentId: 'r' }) } });

test('TC-SW-01 Alt+↑ で上の兄弟と入れ替え', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await selectAndKey(page, 'b', 'Alt+ArrowUp');
    expect(await orderFromSync(page, 'r')).toEqual(['b', 'a', 'c']);
    // b が選択維持
    await expect(page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box')).toHaveClass(/is-focused/);
});

test('TC-SW-02 Alt+↓ で下の兄弟と入れ替え', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await selectAndKey(page, 'b', 'Alt+ArrowDown');
    expect(await orderFromSync(page, 'r')).toEqual(['a', 'c', 'b']);
});

test('TC-SW-03 一番上で Alt+↑ は no-op', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await selectAndKey(page, 'a', 'Alt+ArrowUp');
    const order = await orderFromSync(page, 'r');
    // no-op: syncData が来ない（順序不変）。来ていれば [a,b,c] のまま
    if (order) expect(order).toEqual(['a', 'b', 'c']);
});

test('TC-SW-04 一番下で Alt+↓ は no-op', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await selectAndKey(page, 'c', 'Alt+ArrowDown');
    const order = await orderFromSync(page, 'r');
    if (order) expect(order).toEqual(['a', 'b', 'c']);
});
