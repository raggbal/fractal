/**
 * mindmap node の D&D（機能④）。mouse(pointer) ベース実装の検証。
 * sprint 20260721-145658 TASK-3（再実装）。
 *
 * ★重要: HTML5 DragEvent の synthetic dispatch は SVG foreignObject で native drag が起動しない
 * 現実を隠す（tautology）。ここでは **実 mouse イベント**（mousedown→mousemove×N→mouseup）で
 * ドラッグを駆動し、閾値超え検出 → elementFromPoint での drop 解決 → model 変化を検証する。
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
async function orderFromSync(page: import('@playwright/test').Page, parentId: string) {
    return page.evaluate((pid) => {
        const msgs = ((window as any).__testApi.messages || []) as any[];
        let last: any = null;
        for (const m of msgs) { if (m.type === 'syncData' && m.content) last = m; }
        if (!last) return null;
        try { const d = JSON.parse(last.content); return d.nodes[pid] ? d.nodes[pid].children.slice() : d.rootIds.slice(); }
        catch { return null; }
    }, parentId);
}
async function parentFromSync(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const msgs = ((window as any).__testApi.messages || []) as any[];
        let last: any = null;
        for (const m of msgs) { if (m.type === 'syncData' && m.content) last = m; }
        if (!last) return undefined;
        try { const d = JSON.parse(last.content); return d.nodes[nid] ? d.nodes[nid].parentId : undefined; }
        catch { return undefined; }
    }, id);
}

// 実 mouse ドラッグ: source box の中心で mousedown → target box の指定 fracY へ段階的に mousemove → mouseup。
// Playwright の page.mouse を使う（実 DOM イベントを発火 = native mouse。閾値超えで drag 開始する実装を通る）。
async function mouseDrag(page: import('@playwright/test').Page, draggedId: string, targetId: string, fracY: number) {
    const src = await page.locator(`.mindmap-node[data-node-id="${draggedId}"] .mindmap-node-box`).boundingBox();
    const tgt = await page.locator(`.mindmap-node[data-node-id="${targetId}"] .mindmap-node-box`).boundingBox();
    if (!src || !tgt) throw new Error('box not found');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    const ty = tgt.y + tgt.height * fracY;
    const tx = tgt.x + tgt.width / 2;
    // 閾値超えのため複数ステップで移動
    await page.mouse.move(tx, ty, { steps: 8 });
    await page.mouse.move(tx, ty); // 最終位置確定
    await page.mouse.up();
    await page.waitForTimeout(1200); // syncData debounce
}

// TC-DND-01: 下端へ drop で兄弟順序変更
test('TC-DND-01 mouse drag→下端 drop で兄弟順序変更', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: n('r', 'Root', { children: ['a', 'b'] }), a: n('a', 'AAA', { parentId: 'r' }), b: n('b', 'BBB', { parentId: 'r' }) } });
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await mouseDrag(page, 'a', 'b', 0.9);  // a を b の下端 → a が b の後ろ
    expect(await orderFromSync(page, 'r')).toEqual(['b', 'a']);
});

// TC-DND-02: 中央へ drop で reparent
test('TC-DND-02 mouse drag→中央 drop で reparent', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: n('r', 'Root', { children: ['a', 'b'] }), a: n('a', 'AAA', { parentId: 'r' }), b: n('b', 'BBB', { parentId: 'r' }) } });
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await mouseDrag(page, 'a', 'b', 0.5);  // a を b の中央 → a が b の子
    expect(await parentFromSync(page, 'a')).toBe('b');
});

// TC-DND-03: title node は mousedown で drag 開始しない（中央 title は D&D 不可）
test('TC-DND-03 title node は drag 不可', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, viewMode: 'mindmap', title: '中央', rootIds: ['a', 'b'],
            nodes: { a: { id: 'a', parentId: null, children: [], text: 'AAA', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                     b: { id: 'b', parentId: null, children: [], text: 'BBB', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } } });
        (window as any).Outliner.setViewMode('mindmap');
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    // title を掴んで a の上へドラッグ → 何も起きない（title は D&D 対象外）
    const titleBox = await page.locator('.mindmap-node.mindmap-title-node .mindmap-node-box').boundingBox();
    const aBox = await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').boundingBox();
    if (!titleBox || !aBox) throw new Error('box not found');
    await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    // rootIds / 構造は不変（title の drag は起きない）
    const order = await orderFromSync(page, 'r');
    if (order) expect(order).toEqual(['a', 'b']);
    // title はそもそも model node でないので reparent もされない
});
