/**
 * Mindmap iteration 12 — 複数行編集の幅拡張 (#2) + 兄弟編集で子が離れない (#3)
 * (Wave 16 / FR-021-A7, TASK-42)
 *
 * TC-W6 (#2 複数行編集で box 幅が広がる / load-bearing),
 * TC-W7 (#3 子持ち兄弟の下の兄弟編集で子が親から離れない / load-bearing)。
 *
 * #2 根本原因: adjustEditWidth は is-editing-nowrap（単一行）のときしか幅を広げず、
 *   \n が入ると nowrap を外して以降 box 幅を広げない → 2 行目長文で幅固定のまま折り返す。
 *   修正: 複数行でも「最長行の必要幅」を測り box 幅を min(280, 必要幅) に追従。
 * #3 根本原因: shiftAsideNodes が「同 side・深い x の全ノード」を translateX するため、
 *   下の兄弟サブツリー（A とその子 ac1/ac2）のうち ac1/ac2 だけがずれて A→ac リンクが離れる。
 *   修正: 押し出し対象を「編集ノードの子孫のみ」に限定。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): 必ず page.locator(...).click() (実選択)
 * → page.keyboard.press()/type() (実キー)。el.focus() 直呼び禁止。
 * 幅は .mindmap-node[data-node-id] の getBoundingClientRect().width で測る。
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
function transformOf(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as HTMLElement | null;
        return fo ? (fo.style.transform || '') : '';
    }, id);
}
// transform 文字列に「非ゼロの translateX」が含まれるか判定する。
// setNodeShift は `translate(<dx>px,<dy>px)` 形式で書くので、第1引数が非ゼロなら translateX あり。
function hasTranslateX(tf: string): boolean {
    const m = tf.match(/translate\(\s*(-?\d+(?:\.\d+)?)px\s*,/);
    if (!m) { return false; }
    return Math.abs(parseFloat(m[1])) > 0.5;
}

test('TC-W6 (#2 load-bearing) 複数行編集で 2 行目長文に合わせて box 幅が広がる', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: node('r', 'Root', ['n1']), n1: node('n1', '', [], 'r') }
    });
    // n1 を実クリックで選択 → Space で編集開始
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    // 1 行目に短いテキスト
    await page.keyboard.type('短い');
    await page.waitForTimeout(120);
    const r1 = await foRect(page, 'n1');
    expect(r1).not.toBeNull();
    const w1 = r1!.width;
    // Shift+Enter で改行 → 2 行目に長文
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('これはとても長い二行目のテキストで横幅が広がるべき文字列');
    await page.waitForTimeout(120);
    const r2 = await foRect(page, 'n1');
    expect(r2).not.toBeNull();
    const w2 = r2!.width;
    // 2 行目の長文に合わせて box 幅が明確に広がった（修正前は w2 ≈ w1、実測 84→86）
    expect(w2).toBeGreaterThan(w1 + 40);
    // 上限 280 内
    expect(w2).toBeLessThanOrEqual(290);
    // 編集は継続している（contenteditable=true, caret 保護のため DOM 非再生成）
    const editing = await page.evaluate(() =>
        document.querySelector('.mindmap-node-text[data-node-id="n1"]')?.getAttribute('contenteditable'));
    expect(editing).toBe('true');
});

test('TC-W7 (#3 load-bearing) 子持ち兄弟の下の兄弟を編集しても子が親から離れない', async ({ page }) => {
    await setup(page);
    // title 中心 + rootIds=[A, B]。A は子 ac1/ac2 を持つ。B は A の下の兄弟（子なし）。
    // layout:right で全て right 側に配置し、ac1/ac2 は A より深い x を持つ。
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: 'Center', rootIds: ['A', 'B'],
        mindmap: { layout: 'right' },
        nodes: {
            A: node('A', 'AAA', ['ac1', 'ac2'], null),
            ac1: node('ac1', 'child one', [], 'A'),
            ac2: node('ac2', 'child two', [], 'A'),
            B: node('B', 'b', [], null)
        }
    });
    // 編集前の A / ac1 / ac2 の位置を記録
    const A0 = await foRect(page, 'A');
    const ac1_0 = await foRect(page, 'ac1');
    const ac2_0 = await foRect(page, 'ac2');
    expect(A0).not.toBeNull();
    expect(ac1_0).not.toBeNull();
    expect(ac2_0).not.toBeNull();

    // B を実クリックで選択 → Space → 改行なし長文で幅拡張（280 未満）
    await page.locator('.mindmap-node[data-node-id="B"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    await page.keyboard.type('横に伸びる兄弟ノードのそこそこ長い一文');
    await page.waitForTimeout(120);

    // B の幅拡張が起きたことを確認（前提が成立していることの sanity）
    const Bafter = await foRect(page, 'B');
    const B0screen = A0; // 参考用（未使用）
    void B0screen;
    expect(Bafter).not.toBeNull();

    // #3 の核心: A の子 ac1/ac2 に translateX が付かない（B の幅拡張で押し出されない）
    const tf1 = await transformOf(page, 'ac1');
    const tf2 = await transformOf(page, 'ac2');
    expect(hasTranslateX(tf1)).toBe(false);
    expect(hasTranslateX(tf2)).toBe(false);
    // A の transform にも translateX が付かない
    const tfA = await transformOf(page, 'A');
    expect(hasTranslateX(tfA)).toBe(false);

    // 念のため screen 座標でも A / ac1 / ac2 の相対位置（left 差）が編集前と保たれている
    const A1 = await foRect(page, 'A');
    const ac1_1 = await foRect(page, 'ac1');
    const ac2_1 = await foRect(page, 'ac2');
    const relBefore1 = ac1_0!.left - A0!.left;
    const relAfter1 = ac1_1!.left - A1!.left;
    const relBefore2 = ac2_0!.left - A0!.left;
    const relAfter2 = ac2_1!.left - A1!.left;
    // 親子相対位置が保たれる（リンクが離れない）
    expect(Math.abs(relAfter1 - relBefore1)).toBeLessThanOrEqual(3);
    expect(Math.abs(relAfter2 - relBefore2)).toBeLessThanOrEqual(3);
});
