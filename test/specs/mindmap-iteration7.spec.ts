/**
 * Mindmap iteration 7 — #B テキスト消失(blur commit), #A 編集中の線追従 (Wave 11)
 * TC-B1, TC-B2 (データ損失防止), TC-A1 (線追従)
 * 実クリック→実キー。
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
async function editAndType(page: import('@playwright/test').Page, id: string) {
    await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(50);
    await page.keyboard.type('abc');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('def');
}

test('TC-B1 (#B データ損失) 編集→改行→commitせず別ノードclick でテキスト保持', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1', 'n2']), n1: node('n1', '', [], 'r'), n2: node('n2', 'other', [], 'r') }
    });
    await editAndType(page, 'n1');
    // commit キーを押さず別ノード click（blur）
    await page.locator('.mindmap-node[data-node-id="n2"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    const text = (await page.evaluate(() => (window as any).Outliner.getModel().nodes.n1.text)).replace(/\r/g, '');
    expect(text).toBe('abc\ndef'); // 現状バグでは "" になる
});

test('TC-B2 (#B) blur commit 後 モード往復でも保持', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1', 'n2']), n1: node('n1', '', [], 'r'), n2: node('n2', 'other', [], 'r') }
    });
    await editAndType(page, 'n1');
    await page.locator('.mindmap-node[data-node-id="n2"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.evaluate(() => { (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap'); });
    await page.waitForTimeout(100);
    const text = (await page.evaluate(() => (window as any).Outliner.getModel().nodes.n1.text)).replace(/\r/g, '');
    expect(text).toBe('abc\ndef');
});

test('TC-A1 (#A 線追従) 編集中に下方ノードがずれたら link 端点も追従', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: node('r', 'Root', ['top', 'mid', 'bottom']),
            top: node('top', 'Top', [], 'r'), mid: node('mid', 'Mid', [], 'r'), bottom: node('bottom', 'Bottom', [], 'r')
        }
    });
    // mid を複数行に
    await page.locator('.mindmap-node[data-node-id="mid"] .mindmap-node-box').click();
    await page.keyboard.press('Space'); await page.waitForTimeout(50);
    await page.keyboard.type('X'); await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Y'); await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Z');
    await page.waitForTimeout(150);
    const res = await page.evaluate(() => {
        // bottom（下方でずれたノード）とそれへの link path の終点 y の差
        function rect(id: string) { return (document.querySelector(`.mindmap-node[data-node-id="${id}"]`) as SVGGraphicsElement).getBoundingClientRect(); }
        const bottomRect = rect('bottom');
        const bottomCy = bottomRect.top + bottomRect.height / 2;
        // bottom を target とする link path の描画上の終点 y（getBoundingClientRect の下端付近）
        const path = document.querySelector('.mindmap-link[data-target-id="bottom"]') as SVGGraphicsElement | null;
        if (!path) return { ok: false, reason: 'no path' };
        const pr = path.getBoundingClientRect();
        // path の y 範囲が bottom ノードの中心 y をカバーしている（線がノードに届いている）
        const reaches = bottomCy >= pr.top - 30 && bottomCy <= pr.bottom + 30;
        // sameSide 判定: bottom が動いていない（top と同じ側）なら pass 条件を緩める
        return { ok: reaches, bottomCy: Math.round(bottomCy), pathTop: Math.round(pr.top), pathBottom: Math.round(pr.bottom) };
    });
    // 線が bottom ノードに届いている（追従している）
    expect(res.ok).toBe(true);
});
