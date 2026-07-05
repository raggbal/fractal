/**
 * Mindmap iteration 14 — 2 パス確定幅を実 DOM 最長行実測にする (Wave 18 / FR-021-A6,A7, TASK-44)
 *
 * TC-U3 (★是正の核心): 全角中心・改行なしの 1 行ノードが確定後も折り返さない。
 *   iteration 13 (TASK-43) で 2 パス実測の幅を char 推定 (fs*0.6/文字) に置き換えた退化。
 *   全角 (CJK) は実字幅が fs*1.0 前後で char 推定が過小 → 確定 box が実テキストより狭く折り返す
 *   (Image #17)。編集中 (interactions.js measureLongestLineWidth) は実 DOM scrollWidth で正確なので、
 *   char 推定だと編集中と確定後で幅が食い違う。
 *   修正: 2 パス目の幅を実 DOM の最長行実測 (.mindmap-node-text を一時 nowrap → scrollWidth) にし、
 *   編集中と同じ測り方に統一する。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   実クリック (page.locator(...).click()) → 実キー (page.keyboard.press/type)。
 *   幅は .mindmap-node[data-node-id] の getBoundingClientRect().width、
 *   折り返し行数は .mindmap-node-text の getClientRects().length。
 *
 * 2 パス発火条件 (needsRealMeasure): いずれかのノードに \n / icon / images / tags があること。
 *   → n1 (全角・改行なし) が 2 パスの実測を受けるよう、兄弟 n2 に改行を持たせて 2 パスを強制する。
 *   これにより「n1 の確定幅が 2 パス実測で決まる」= TASK-44 の修正経路が実行される。
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
    await page.waitForTimeout(200);
}
function foWidth(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        return Math.round(fo.getBoundingClientRect().width);
    }, id);
}
// .mindmap-node-text の折り返し行数 (getClientRects().length)。1 = 折り返していない。
function textLineCount(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const t = document.querySelector(`.mindmap-node-text[data-node-id="${nid}"]`) as HTMLElement | null;
        if (!t) { return null; }
        return t.getClientRects().length;
    }, id);
}

// 全角中心・改行なし・280 未満に収まる長さのノード (testcases.md TC-U3 の例)。
const N1_TEXT = 'あsだだだだだだだあsだだd';

test('TC-U3 (★是正の核心) 全角中心の改行なし1行ノードが初期描画で折り返さない (実測幅)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: '', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['n1', 'n2'], null),
            n1: node('n1', N1_TEXT, [], 'r'),
            // n2 に改行を持たせて needsRealMeasure=true → 2 パス実測を強制する
            // (n1 の確定幅が 2 パスの実測で決まる = TASK-44 の修正経路を通す)。
            n2: node('n2', 'aa\nbb', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // 検証1: n1 は改行なしで 1 行に収まる (折り返さない)。
    const lines = await textLineCount(page, 'n1');
    expect(lines).not.toBeNull();
    expect(lines).toBe(1);

    // n1 の幅が char 推定の過小幅でなく実テキストを収める幅 (280 未満・実テキスト以上)。
    const w1 = await foWidth(page, 'n1');
    expect(w1).not.toBeNull();
    expect(w1!).toBeLessThanOrEqual(280);
    // 実測方式なら全角 15 文字分 (fs*1.0≈13px/字) で幅は 150px 以上になるはず。
    // char 推定 (fs*0.6≈8px/字) だと ~120px 台まで縮み、box が折り返す。
    expect(w1!).toBeGreaterThan(140);
});

test('TC-U3 (★是正の核心) 編集中と確定後の幅が一致し確定後も折り返さない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: '', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['n1', 'n2'], null),
            n1: node('n1', N1_TEXT, [], 'r'),
            n2: node('n2', 'aa\nbb', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // n1 box を実クリックで選択 → Space で編集開始
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    // 末尾に全角数文字を type して widen (改行なし = 横伸び)
    await page.keyboard.type('ええええ');
    await page.waitForTimeout(150);

    // 編集中の幅を記録
    const editW = await foWidth(page, 'n1');
    expect(editW).not.toBeNull();
    // 編集中は 1 行 (nowrap 横伸び)。
    const editLines = await textLineCount(page, 'n1');
    expect(editLines).toBe(1);

    // Enter で commit → fresh-ctx rerender で 2 パス実測が確定幅を決める
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const commitW = await foWidth(page, 'n1');
    expect(commitW).not.toBeNull();

    // 検証2a: 確定後も 1 行のまま (折り返さない)。char 推定退化だと全角過小で 2 行になる。
    const commitLines = await textLineCount(page, 'n1');
    expect(commitLines).toBe(1);

    // 検証2b: 編集中と確定後の幅が一致 (ガタつかない)。
    //   実測方式なら editW (adjustEditWidth の実測) == commitW (2 パス実測) で一致。
    //   char 推定に戻すと commitW が過小になり乖離 → red (load-bearing)。
    expect(Math.abs(editW! - commitW!)).toBeLessThanOrEqual(8);
});
