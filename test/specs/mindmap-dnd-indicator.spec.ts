/**
 * mindmap D&D の drop 位置フィードバック（sprint 20260721-170755）。
 * マウス位置（対象ノードの上端1/3=兄 / 下端1/3=弟 / 中央=子）で mm-drop-above/below/child を切替。
 * マーク位置＝実際の落下先（dropZoneAt を mousemove/mouseup で共有）。
 * 実マウス駆動（前 sprint mindmap-dnd.spec と同パターン）。
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

const TREE = () => ({ version: 1, viewMode: 'mindmap', rootIds: ['r'],
    nodes: { r: n('r', 'Root', { children: ['a', 'b'] }), a: n('a', 'AAA', { parentId: 'r' }), b: n('b', 'BBB', { parentId: 'r' }) } });

// a を掴んで b の指定 fracY へ move（mouseup しない）。移動後の b box のクラスを返す。
async function dragOver(page: import('@playwright/test').Page, draggedId: string, targetId: string, fracY: number) {
    const src = await page.locator(`.mindmap-node[data-node-id="${draggedId}"] .mindmap-node-box`).boundingBox();
    const tgt = await page.locator(`.mindmap-node[data-node-id="${targetId}"] .mindmap-node-box`).boundingBox();
    if (!src || !tgt) throw new Error('box not found');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * fracY, { steps: 8 });
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * fracY);
    return page.evaluate((tid) => {
        const box = document.querySelector(`.mindmap-node[data-node-id="${tid}"] .mindmap-node-box`);
        return box ? Array.from(box.classList).filter(c => c.indexOf('mm-drop') === 0) : [];
    }, targetId);
}

test('TC-DZ-01 上端1/3ホバー → mm-drop-above', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    const cls = await dragOver(page, 'a', 'b', 0.15);
    await page.mouse.up();
    expect(cls).toContain('mm-drop-above');
});

test('TC-DZ-02 下端1/3ホバー → mm-drop-below', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    const cls = await dragOver(page, 'a', 'b', 0.85);
    await page.mouse.up();
    expect(cls).toContain('mm-drop-below');
});

test('TC-DZ-03 中央ホバー → mm-drop-child', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    const cls = await dragOver(page, 'a', 'b', 0.5);
    await page.mouse.up();
    expect(cls).toContain('mm-drop-child');
});

test('TC-DZ-04 マーク位置＝落下先 + drop 後クリア', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    // 下端で mm-drop-below → mouseup で a が b の弟（[b,a]）
    const cls = await dragOver(page, 'a', 'b', 0.85);
    expect(cls).toContain('mm-drop-below');
    await page.mouse.up();
    await page.waitForTimeout(1200);
    // マーク zone(below=弟) と一致した落下先
    expect(await orderFromSync(page, 'r')).toEqual(['b', 'a']);
    // drop 後は全マーク消滅
    const remaining = await page.evaluate(() =>
        document.querySelectorAll('.mm-drop-above, .mm-drop-below, .mm-drop-child, .mm-drop-target').length);
    expect(remaining).toBe(0);
});
