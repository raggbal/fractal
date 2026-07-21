/**
 * mindmap D&D: 空白（node 以外）への drop を無効化（sprint 20260721-173037）。
 * 以前は空白 drop で Floating Topic 化（parentId=null + rootIds 外 + mindmap.x/y）していたが、
 * outliner モード（rootIds 起点描画）で見えなくなり「消えた」ように見えるため廃止。
 * 空白 drop = キャンセル（元の親/順序のまま）。node 上 drop は不変。
 * 既存 floating を node に戻すと構造復帰 + 座標クリア（迷子ノードの回収経路）。
 *
 * 実マウス駆動（synthetic DragEvent は SVG foreignObject で native drag が不発の罠を回避。
 * 前 sprint mindmap-dnd.spec と同パターン）。
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
// live model を直接読む（syncData 非依存。no-op で syncData が飛ばなくても検証できる）。
// nodes を id→node の plain object にして serialize 形と同じ shape で返す。
async function liveModel(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const api = (window as any).__testApi;
        const model = api && api.getModel ? api.getModel() : null;
        if (!model) return null;
        return { rootIds: (model.rootIds || []).slice(), nodes: model.nodes };
    });
}

const TREE = () => ({ version: 1, viewMode: 'mindmap', rootIds: ['r'],
    nodes: { r: n('r', 'Root', { children: ['a', 'b'] }), a: n('a', 'AAA', { parentId: 'r' }), b: n('b', 'BBB', { parentId: 'r' }) } });

// TC-ED-01（load-bearing）: 空白へ drop → node は不変（floating 化しない）
test('TC-ED-01 空白へ drop → node 不変（floating 化しない）', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

    const src = await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').boundingBox();
    // 全 .mindmap-node の bounding box の外にある「確実に空白」の座標を計算する
    const empty = await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree[data-view-mode="mindmap"]') as HTMLElement;
        const tr = tree.getBoundingClientRect();
        // どの node box にも当たらない点を探す（tree 内を粗くスキャン）
        for (let gy = 0.95; gy > 0.4; gy -= 0.05) {
            for (let gx = 0.95; gx > 0.4; gx -= 0.05) {
                const x = tr.left + tr.width * gx;
                const y = tr.top + tr.height * gy;
                const el = document.elementFromPoint(x, y);
                if (!el || !el.closest('.mindmap-node')) { return { x, y }; }
            }
        }
        return null;
    });
    if (!src || !empty) throw new Error('src or empty point not found');

    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(empty.x, empty.y, { steps: 8 });
    await page.mouse.move(empty.x, empty.y);
    // drop 直前: 空白なので drop マークが付いていない（node 上でない）ことを確認
    await page.mouse.up();
    await page.waitForTimeout(1200);

    // ★ live model を直接読む（no-op で syncData が飛ばなくても検証可能 = vacuous でない）。
    const m = await liveModel(page);
    expect(m).not.toBeNull();
    expect(m!.nodes['a'].parentId).toBe('r');            // 親不変
    expect(m!.rootIds).not.toContain('a');               // root に昇格していない
    expect(m!.nodes['r'].children).toContain('a');       // 親 children に残っている
    const mm = m!.nodes['a'].mindmap;
    // floating 座標が付いていない（mindmap 無し or x/y が null）
    if (mm) { expect(mm.x == null).toBeTruthy(); expect(mm.y == null).toBeTruthy(); }
    // counterfactual: else を旧 detachToFloating に戻すと a.parentId===null で本 assert が RED
});

// TC-ED-02: node 上 drop（下端=弟）は従来どおり動く（回帰）
test('TC-ED-02 node 上 drop（下端=弟）は不変', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    const src = await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').boundingBox();
    const tgt = await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').boundingBox();
    if (!src || !tgt) throw new Error('box not found');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * 0.9, { steps: 8 });
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * 0.9);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const m = await liveModel(page);
    expect(m.nodes['r'].children).toEqual(['b', 'a']);  // a が b の弟に
});

// TC-ED-03: 既存 Floating Topic を node へ drag し戻すと構造復帰 + 座標クリア
test('TC-ED-03 既存 floating を node に戻すと構造復帰 + 座標クリア', async ({ page }) => {
    await setup(page);
    // f を floating 状態で仕込む（parentId=null, rootIds に含めない, mindmap.x/y あり）
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: n('r', 'Root', { children: ['b'] }),
            b: n('b', 'BBB', { parentId: 'r' }),
            f: n('f', 'Floating', { parentId: null, mindmap: { fill: null, stroke: null, shape: null, x: 400, y: 300 } }),
        } });
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

    const src = await page.locator('.mindmap-node[data-node-id="f"] .mindmap-node-box').boundingBox();
    const tgt = await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').boundingBox();
    if (!src || !tgt) throw new Error('box not found (f が floating で描画されているか確認)');
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * 0.5, { steps: 8 }); // 中央 = child
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height * 0.5);
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const m = await liveModel(page);
    expect(m.nodes['f'].parentId).toBe('b');            // 構造ノードに復帰（b の子）
    const mm = m.nodes['f'].mindmap;
    // ★ stale 座標がクリアされている（counterfactual: 座標クリア無しだと x===400 が残る）
    if (mm) { expect(mm.x == null).toBeTruthy(); expect(mm.y == null).toBeTruthy(); }
});
