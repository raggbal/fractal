/**
 * Mindmap iteration 10 — A7 左側ノードは左へ伸びる (Wave 14 / FR-021-A7, TASK-38)
 * TC-W5 (load-bearing): layout='left' の左側ノードを編集して改行なし長文を入力すると、
 * foreignObject の左端 (rect.left) が編集前より小さくなり（左へ伸びる）、右端はほぼ不変。
 *
 * 根本原因: adjustEditWidth は foreignObject の width を増やすが x を固定するため常に右へ伸びる。
 * left 側ノード（レイアウト座標 x < 0）では右端が中心/親側へ食い込み不自然。
 * 修正: left 側は右端 (x + width) を固定して左へ伸ばす（width 増分だけ x を減らす）。
 *
 * テスト方針（generator_failures 2026-07-02 厳守）: 必ず page.locator(...).click()（実選択）
 * → page.keyboard.press()/type()（実キー）。el.focus() 直呼び禁止。
 * 幅は foreignObject(.mindmap-node[data-node-id]) の getBoundingClientRect で left/right/width を測る。
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}
function foRect(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
    }, id);
}

test('TC-W5 (#1 A7 load-bearing) layout=left の左側ノードは編集中に左へ伸びる（右端固定）', async ({ page }) => {
    await setup(page);
    // layout='left' で全子を左側に配置。root r の子 n1（短いテキスト）。n1 は x<0（中心より左）。
    // n2 も置いて確実に左側配置にする（複数子でも left なら全て左）。
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        mindmap: { layout: 'left' },
        nodes: {
            r: node('r', 'Root', ['n1', 'n2']),
            n1: node('n1', 'x', [], 'r'),
            n2: node('n2', 'y', [], 'r')
        }
    });
    // n1 box を click（実選択）→ Space（編集開始）
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    const before = await foRect(page, 'n1');
    // 改行なし・280px 上限には未達の長さ
    await page.keyboard.type('これは左へ折り返さずに伸びる一文です');
    await page.waitForTimeout(100);
    const after = await foRect(page, 'n1');

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // 幅が広がっている
    expect(after!.width).toBeGreaterThan(before!.width);
    // 左端が編集前より小さくなる（= 左へ伸びた）
    expect(after!.left).toBeLessThan(before!.left - 2);
    // 右端はほぼ不変（右端固定で左へ拡張）
    expect(Math.abs(after!.right - before!.right)).toBeLessThanOrEqual(6);
});
