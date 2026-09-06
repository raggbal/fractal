/**
 * outliner の複数選択色は他ビューと同じ water-blue (裁定 R35 / FR-OSC-01)
 *
 * 実機報告 (2026-09-05): 「outliner の複数選択の色ですが、黄色やめて。note filetree も青、
 *   linkedfd も青、mindmap も青。outliner だけ黄色になっており、逆に気持ち悪い」。
 * 旧値: --outliner-selection-bg: rgba(255, 165, 0, 0.15) (orange tint) を 3 箇所で定義。
 * 新値: var(--fr-bg-selection, rgba(125, 196, 223, 0.28))。トークン層で直すので
 *   tree / table / ::selection が一括で追随する。
 *
 * 検証は「実際に cmd+click で複数選択した行の**計算後 background**」を見る (変数を読むだけだと
 * 別レイヤの :root が勝っている場合に嘘をつく)。青系の判定は「B チャンネル > R チャンネル」。
 */
import { test, expect } from '@playwright/test';

const TREE = {
    version: 1,
    rootIds: ['n1', 'n2', 'n3'],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'alpha', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
        n2: { id: 'n2', parentId: null, children: [], text: 'bravo', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
        n3: { id: 'n3', parentId: null, children: [], text: 'charlie', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
    },
};

function rgb(s: string) {
    const m = s.match(/rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/);
    if (!m) { return null; }
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]) };
}

test('TC-OSC-01 複数選択した行の背景が water-blue (黄/橙でない)', async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, TREE);
    await page.waitForSelector('.outliner-node');

    await page.locator('.outliner-node[data-id="n1"] .outliner-text').click();
    for (const id of ['n1', 'n2']) {
        await page.locator(`.outliner-node[data-id="${id}"] .outliner-text`).click({ modifiers: ['Meta'] });
    }
    const sel = await page.evaluate(() => {
        const el = document.querySelector('.outliner-node.is-selected') as HTMLElement | null;
        if (!el) { return null; }
        return {
            id: el.getAttribute('data-id'),
            bg: getComputedStyle(el).backgroundColor,
            token: getComputedStyle(document.documentElement).getPropertyValue('--outliner-selection-bg').trim(),
            textToken: getComputedStyle(document.documentElement).getPropertyValue('--outliner-selection-text-bg').trim(),
        };
    });
    expect(sel, '複数選択した行 (.is-selected) が存在する').not.toBeNull();

    const c = rgb(sel!.bg);
    expect(c, `background=${sel!.bg}`).not.toBeNull();
    // 青系: B が R より明確に大きい。旧値 rgba(255,165,0,…) は R>B で red になる。
    expect(c!.b, `background=${sel!.bg}`).toBeGreaterThan(c!.r + 20);
    // mindmap / filetree / linkedfd と同じ water-blue の系統 (125,196,223)
    expect(c!.b).toBeGreaterThan(c!.g);

    // トークン自身も water-blue (::selection 用の濃い方も含む)
    expect(rgb(sel!.token)!.b).toBeGreaterThan(rgb(sel!.token)!.r);
    expect(rgb(sel!.textToken)!.b).toBeGreaterThan(rgb(sel!.textToken)!.r);

    // focus 行 (最も薄い塗り) と選択行は別色 = 区別が付く
    const focusBg = await page.evaluate(() => {
        const el = document.querySelector('.outliner-node.is-focused:not(.is-selected)') as HTMLElement | null;
        return el ? getComputedStyle(el).backgroundColor : null;
    });
    if (focusBg) { expect(focusBg).not.toBe(sel!.bg); }
});
