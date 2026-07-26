/**
 * FR-MM-DA: mindmap の node D&D 開始で掴んだ node を active（is-selected）にする（sprint 20260721-180905）。
 * drag 開始（閾値超え mousemove）で is-selected を付け、drop 後も維持。
 * 実マウス駆動（page.mouse）。前 sprint mindmap-dnd.spec と同パターン。
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
const TREE = () => ({ version: 1, viewMode: 'mindmap', rootIds: ['r'],
    nodes: { r: n('r', 'Root', { children: ['a', 'b'] }), a: n('a', 'AAA', { parentId: 'r' }), b: n('b', 'BBB', { parentId: 'r' }) } });

// TC-DA-01（load-bearing）: drag 開始で掴んだ node が is-selected
test('TC-DA-01 drag 開始で掴んだ node が is-selected', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    const src = await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').boundingBox();
    const tgt = await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').boundingBox();
    if (!src || !tgt) throw new Error('box not found');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    // 閾値超えの mousemove（b の方へ）。まだ mouseup しない = drag 中。
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * 0.5, { steps: 8 });
    // drag 中に掴んだ a が is-selected
    await expect(page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box')).toHaveClass(/is-selected/);
    await page.mouse.up();
    // counterfactual: drag 開始の paintSelection を外すと付かない
});

// TC-DA-02: drop 後も掴んだ node が active（is-selected 維持、rerender で焼失しない）
test('TC-DA-02 drop 後も掴んだ node が active', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    const src = await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').boundingBox();
    const tgt = await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').boundingBox();
    if (!src || !tgt) throw new Error('box not found');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * 0.9, { steps: 8 }); // 下端=弟
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * 0.9);
    await page.mouse.up();
    await page.waitForTimeout(300); // rerender 待ち
    // drop 後（rerender 後）も a が is-selected（active 維持）
    await expect(page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box')).toHaveClass(/is-selected/);
});
