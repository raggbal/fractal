/**
 * Mindmap iteration 5 — #1 編集中重なり解消, #4 ズーム速度 (Wave 9)
 * TC-150d (編集中 Shift+Enter 再レイアウト), TC-210b (ズーム緩やか)
 * 実フロー (click→key / wheel dispatch)。
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

test('TC-210b (#4) Ctrl+wheel deltaY=10 のズームが緩やか (<5%)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['n1'], nodes: { n1: node('n1', 'Root', ['c1']), c1: node('c1', 'C1', [], 'n1') } });
    const scaleOf = () => page.evaluate(() => {
        const vp = document.querySelector('.mindmap-viewport') as HTMLElement;
        const m = (vp.style.transform || '').match(/scale\(([\d.]+)\)/);
        return m ? parseFloat(m[1]) : 1;
    });
    const before = await scaleOf();
    // 小さい deltaY を 1 発
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        tree.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(50);
    const after = await scaleOf();
    // iteration 27 (TASK-72, test_update): wheel ズームを速く (K=0.003, clamp 0.8〜1.25)。
    // 小さい deltaY=10 → factor=exp(-0.03)=0.9704 ≒ 3% 変化 (急激でない緩やかさは保つ)。
    expect(Math.abs(after - before) / before).toBeLessThan(0.08);
    expect(after).not.toBe(before); // でも変化はする
    // 大きい deltaY でも 1 発の変化は上限内（クランプ 0.8〜1.25 = 最大 ±25%）。
    const s2before = await scaleOf();
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        tree.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(50);
    const s2after = await scaleOf();
    expect(Math.abs(s2after - s2before) / s2before).toBeLessThanOrEqual(0.26);
});

test('TC-150d (#1) 編集中 Shift+Enter で下ノードと重ならない (再レイアウト)', async ({ page }) => {
    await setup(page);
    // 縦に並ぶ同側の兄弟 top/mid/bottom
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: node('r', 'Root', ['top', 'mid', 'bottom']),
            top: node('top', 'Top', [], 'r'),
            mid: node('mid', 'Mid', [], 'r'),
            bottom: node('bottom', 'Bottom', [], 'r')
        }
    });
    // mid を編集開始して複数行に
    await page.locator('.mindmap-node[data-node-id="mid"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(50);
    await page.keyboard.type('X');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Y');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Z');
    // debounce (350ms) 経過を待って再レイアウトさせる
    await page.waitForTimeout(600);
    const res = await page.evaluate(() => {
        function rect(id: string) { return (document.querySelector(`.mindmap-node[data-node-id="${id}"]`) as SVGGraphicsElement).getBoundingClientRect(); }
        const mid = rect('mid'), bottom = rect('bottom');
        const overlap = !(mid.right < bottom.left || bottom.right < mid.left || mid.bottom < bottom.top || bottom.bottom < mid.top);
        const editable = document.querySelector('.mindmap-node-text[data-node-id="mid"]')?.getAttribute('contenteditable');
        return { overlap, editable };
    });
    expect(res.overlap).toBe(false);       // mid が伸びても bottom と重ならない (再レイアウト)
    expect(res.editable).toBe('true');     // 編集は継続している
});
