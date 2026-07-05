/**
 * Mindmap iteration 16 — viewport フレーム安定化 (bounds シフト補償) (Wave 22 / FR-021-J2, TASK-49)
 *
 * 根本原因: SVG viewBox origin = layout.bounds.minX/minY を毎 render 再計算する。
 *   固定ノードの画面位置 ≈ viewport.translate + scale·(nodeX − bounds.minX)。
 *   編集/追加/移動で bounds 原点が動くと viewport.translate 不変でも座標フレーム全体が
 *   画面上でシフトする (編集確定で右にずれる / 追加で中央寄り の正体)。
 * 修正: render に前回 render の bounds 原点 _prevBoundsMin を保持し、今回との差
 *   Δ = boundsNow.min − boundsPrev.min を viewport.translate に +Δ·scale 補正して
 *   「固定ノードの画面位置が rerender 前後で不変」にする。ユーザー明示 pan/zoom/fit/minimap
 *   (updateViewport 経由) 直後は _skipStabilizeOnce で二重補正を回避する。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   実クリック (page.locator(...).click()) → 実キー (page.keyboard.press/type)。
 *   screen 位置は .mindmap-node[data-node-id] の getBoundingClientRect().left。
 *
 * 座標系の注意 (generator_failures 2026-07-03 iteration 11): 「編集していない anchor の
 *   screen 位置が commit 前後で不変」を測るのが目的そのもの (フレーム安定化 = screen 座標の
 *   不変化)。ここは screen 座標 (getBoundingClientRect) で測るのが正しい (SVG 属性ではない)。
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
// .mindmap-node[data-node-id] の screen left (getBoundingClientRect().left)。
function screenLeft(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        return fo.getBoundingClientRect().left;
    }, id);
}
function screenTop(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        return fo.getBoundingClientRect().top;
    }, id);
}

// 全角長文。編集で widen して bounds 原点を動かすため。
const LONG = 'あああああああああああああ';

test('TC-V1 (★フレーム安定化の核心) 左側ノード編集確定で bounds 原点が動いても anchor の画面位置が不変', async ({ page }) => {
    await setup(page);
    // layout='left': 全子が中心より左。左側ノードが widen すると左へ伸び bounds.minX が減る。
    // n1 = 編集対象 (widen して bounds を動かす)。anchor = 編集で動かない別ノード (同 side の兄弟)。
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: 'center', rootIds: ['r'],
        mindmap: { layout: 'left' },
        nodes: {
            r: node('r', 'root', ['n1', 'anchor'], null),
            n1: node('n1', 'edit', [], 'r'),
            anchor: node('anchor', 'fixed', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // anchor の初期 screen left を記録
    const a0 = await screenLeft(page, 'anchor');
    expect(a0).not.toBeNull();

    // n1 を実クリックで選択 → Space で編集開始 → 全角長文 type で widen (bounds.minX を動かす)
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    await page.keyboard.type(LONG);
    await page.waitForTimeout(150);

    // Enter で commit → fresh-ctx rerender → 2 パス実測 → bounds.minX が動く
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const a1 = await screenLeft(page, 'anchor');
    expect(a1).not.toBeNull();

    // ★ 編集していない anchor の画面位置が commit 前後で不変 (フレーム安定化)。
    expect(Math.abs(a1! - a0!)).toBeLessThanOrEqual(3);
});

test('TC-V1 load-bearing: 安定化補正を無効化すると commit 後に anchor が bounds シフト分ずれる', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: 'center', rootIds: ['r'],
        mindmap: { layout: 'left' },
        nodes: {
            r: node('r', 'root', ['n1', 'anchor'], null),
            n1: node('n1', 'edit', [], 'r'),
            anchor: node('anchor', 'fixed', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    const a0 = await screenLeft(page, 'anchor');
    expect(a0).not.toBeNull();

    // 安定化補正を無効化 (Δx=Δy=0 相当 = 補正なし)。これが「修正を戻した」状態。
    await page.evaluate(() => { (window as any).MindmapRender._setStabilizeEnabled(false); });

    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    await page.keyboard.type(LONG);
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const a1 = await screenLeft(page, 'anchor');
    expect(a1).not.toBeNull();

    // ★ 補正なしだと bounds.minX シフト分だけ anchor が横にずれる (>3px)。
    //   これが red = TC-V1 が偽陽性でない (補正が実際に効いている) ことの担保。
    expect(Math.abs(a1! - a0!)).toBeGreaterThan(3);

    // 後始末: 補正を元に戻す (同一ページ内の状態リークを防ぐ)。
    await page.evaluate(() => { (window as any).MindmapRender._setStabilizeEnabled(true); });
});

test('TC-V5 (回帰基準) Shift+Enter で前方兄弟追加してもフレーム (中心ノード) が動かない', async ({ page }) => {
    await setup(page);
    // 画面内に収まる小さいツリー。追加される兄弟の再スタックは避けられないが、
    // フレーム (title 中心ノード __title__ = 座標フレームのアンカー) が動かないことを検証する。
    // Shift+Enter が「完璧＝動かない」の正体は「bounds 原点をほとんど動かさない」= フレーム不変。
    // 安定化補正がなければ、兄弟追加で bounds が広がりフレーム全体が画面上でシフトする (load-bearing)。
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: 'root', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['a', 'b'], null),
            a: node('a', 'alpha', [], 'r'),
            b: node('b', 'beta', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // フレームアンカー = title 中心ノード。安定化が「rerender 前後で screen 不変」に保つ対象。
    const l0 = await screenLeft(page, '__title__');
    const t0 = await screenTop(page, '__title__');
    expect(l0).not.toBeNull();
    expect(t0).not.toBeNull();

    // b を実クリックで選択 → Shift+Enter で前方兄弟を追加 (非編集で選択のまま)
    await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').click();
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(200);

    const l1 = await screenLeft(page, '__title__');
    const t1 = await screenTop(page, '__title__');
    expect(l1).not.toBeNull();
    expect(t1).not.toBeNull();

    // ★ フレーム (中心ノード) の screen 位置がほぼ不変 (安定化で「動かない」理想が保たれる)。
    expect(Math.abs(l1! - l0!)).toBeLessThanOrEqual(6);
    expect(Math.abs(t1! - t0!)).toBeLessThanOrEqual(6);
});
