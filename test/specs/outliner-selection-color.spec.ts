/**
 * outliner の複数選択色は **amber（黄色系）**（FR-OSC-01 rev2 / ADRL-0115。裁定 R35 を supersede）
 *
 * ## 経緯（3 回転している）
 * - 裁定 R16（2026-09-01）: 3 面を outliner の orange tint に統一
 * - 裁定 R16 rev2（2026-09-04）: 「ツリーで黄色はうざい」→ note tree / linkedfd は青。**outliner は黄色のまま**
 * - 裁定 R35（2026-09-05）: 「outliner だけ黄色になっており逆に気持ち悪い」→ outliner も water-blue に統一
 * - **FR-OSC-01 rev2（2026-09-06・本 sprint）**: 「選択モードの選択色はやはり黄色に戻してください」
 *   → **outliner だけ黄色**（他 3 面は青のまま = R16 rev2 の状態へ復帰）
 *
 * ## なぜ今回は黄色が正しいのか（前回と前提が違う）
 * 本 sprint で outliner に**モードの二態化**が入り（ADRL-0114）、**編集モードの Cmd+A で
 * text 範囲選択が初めて主役になる**（FR-MSEL-06 rev3 の 1 段目）。outliner の focus 行は青なので
 * node 選択も青にすると focus / node 選択 / text 範囲の 3 つが同系色になり、
 * 「モードを明確にする」という本 sprint の目的が色で崩れる。
 * → node 選択 = amber / `::selection` = 青系 の **色相分離**が要件から要求される。
 *
 * 検証は「実際に cmd+click で複数選択した行の**計算後 background**」を見る (変数を読むだけだと
 * 別レイヤの :root が勝っている場合に嘘をつく)。amber の判定は「R > B かつ G > B」。
 * 3 定義ブロックすべてが揃っているかの構造検査は `test/unit/outliner-selection-color-tokens.spec.ts`。
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

test('TC-OSC-01 rev2 複数選択した行の背景が amber（青系でない）', async ({ page }) => {
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
    // amber: R / G が B より大きい。旧値 rgba(125,196,223,…) は B>R で blue になる。
    // 色相で判定し literal 一致では見ない（具体値の微調整が test_update を伴わないようにする）
    expect(c!.r, `background=${sel!.bg}`).toBeGreaterThan(c!.b);
    expect(c!.g, `background=${sel!.bg}`).toBeGreaterThan(c!.b);

    // node 選択のトークンは amber
    expect(rgb(sel!.token)!.r, `--outliner-selection-bg=${sel!.token}`).toBeGreaterThan(rgb(sel!.token)!.b);
    // 🔴 ::selection のトークンは **青系のまま**（色相分離 = ADRL-0115 Decision 2）。
    //    単純 revert（2 トークンを同系色に戻す）をするとここが落ちる — Cmd+A の
    //    1 段目（text 全選択）と 2 段目（全 node 選択）が同色で見分けられなくなる。
    expect(rgb(sel!.textToken)!.b, `--outliner-selection-text-bg=${sel!.textToken}`).toBeGreaterThan(rgb(sel!.textToken)!.r);

    // focus 行 (最も薄い塗り) と選択行は別色 = 区別が付く
    const focusBg = await page.evaluate(() => {
        const el = document.querySelector('.outliner-node.is-focused:not(.is-selected)') as HTMLElement | null;
        return el ? getComputedStyle(el).backgroundColor : null;
    });
    if (focusBg) { expect(focusBg).not.toBe(sel!.bg); }
});
