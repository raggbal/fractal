/**
 * Mindmap iteration 16 — 移動・追加の最小追従 (画面外のときだけ最小パン) (Wave 22 / FR-021-J2, TASK-50)
 *
 * 前提: viewport フレーム安定化 (mindmap-render.js, TASK-49) で「レイアウト起因の bounds
 *   シフト」は打ち消され、rerender で固定ノードの画面位置は不変。その上で、フォーカスが移る先の
 *   ノードが画面外なら最小量だけパンして見せる (中央には寄せない)。
 * 実装: mindmap-interactions.js に共通関数 ensureNodeVisible(nodeId) を追加。
 *   - 対象ノードの screen rect と treeEl 可視 rect を比較。完全に画面内 → 何もしない (viewport 不変)。
 *   - いずれかの辺が画面外 → その辺が見えるまで最小量パン (はみ出し量 + 余白マージン)。中央寄せしない。
 *   - 呼び出し: 矢印移動 (findAdjacent 後) / D&D drop 後 / 追加 (Enter/Shift+Enter/Tab) の rerender 後。
 *   - 編集確定 (commitEdit) では呼ばない (フレーム安定化のみ)。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   実クリック (page.locator(...).click()) → 実キー (page.keyboard.press/type)。
 *   screen 位置は .mindmap-node[data-node-id] の getBoundingClientRect。
 *   viewport は MindmapRender.getViewport()。画面外は updateViewport で pan して作る。
 *
 * 座標系の注意: ここで測る「viewport が動いたか」は translate 値そのもの (MindmapRender の
 *   viewport module 変数)。「ノードが可視領域内か」は screen rect (getBoundingClientRect) を
 *   treeEl の可視 rect と比較する — この可視判定は ensureNodeVisible と同じ座標系なので妥当。
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
// MindmapRender.getViewport() の translate をコピーで返す (参照リークを避ける)。
function getViewport(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const vp = (window as any).MindmapRender.getViewport();
        return { translateX: vp.translateX, translateY: vp.translateY, scale: vp.scale };
    });
}
// 対象ノードの screen rect (getBoundingClientRect) を返す。
function nodeRect(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
    }, id);
}
// treeEl (.outliner-tree) の可視 rect。
function treeRect(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, w: r.width, h: r.height };
    });
}

// 縦に大きいツリー (root r + 多数の子)。端の子は初期または pan で画面外にできる。
function tallTree(childCount: number, layout: string = 'right') {
    const children: string[] = [];
    const nodes: any = { r: node('r', 'root', [], null) };
    for (let i = 0; i < childCount; i++) {
        const id = 'c' + i;
        children.push(id);
        nodes[id] = node(id, 'child-' + i, [], 'r');
    }
    nodes.r.children = children;
    return { version: 1, viewMode: 'mindmap', rootIds: ['r'], mindmap: { layout }, nodes };
}

test('TC-V2 移動先ノードが画面内なら矢印移動で viewport 不変', async ({ page }) => {
    await setup(page);
    // 画面内に収まる小さいツリー。root r の子 2 つ (a, b) は上下に並び両方画面内。
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['a', 'b'], null),
            a: node('a', 'alpha', [], 'r'),
            b: node('b', 'beta', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // a, b が共に画面内であることを前提確認
    const tr = await treeRect(page);
    const ra = await nodeRect(page, 'a');
    const rb = await nodeRect(page, 'b');
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    const inView = (r: any) => r.left >= tr.left - 1 && r.right <= tr.right + 1 && r.top >= tr.top - 1 && r.bottom <= tr.bottom + 1;
    expect(inView(ra)).toBe(true);
    expect(inView(rb)).toBe(true);

    const v0 = await getViewport(page);

    // a を実クリックで選択 → ArrowDown で b へ移動 (b は画面内)
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);

    const v1 = await getViewport(page);

    // ★ 移動先が画面内なので viewport translate は不変 (動かさない)。
    expect(Math.abs(v1.translateX - v0.translateX)).toBeLessThanOrEqual(1);
    expect(Math.abs(v1.translateY - v0.translateY)).toBeLessThanOrEqual(1);
});

const TALL = 24; // 子数。span が treeEl 高さ (~667px) を超え、末尾の子が確実に画面外になる。

test('TC-V3 移動先ノードが画面外なら最小パンで可視化・中央でない', async ({ page }) => {
    await setup(page);
    // 縦に多数の子 → span が可視領域を超え、末尾の子は下方の画面外にある。
    await toMindmap(page, tallTree(TALL, 'right'));
    await page.waitForTimeout(150);

    const tr = await treeRect(page);
    const lastId = 'c' + (TALL - 1);

    // 末尾の子が初期状態で画面外 (下端より下) であることを前提確認。
    const rLastInit = await nodeRect(page, lastId);
    expect(rLastInit).not.toBeNull();
    expect(rLastInit!.top > tr.bottom).toBe(true);

    // c0 (画面内上部) を選択 → ArrowDown 連打で末尾まで移動。各移動で最小追従が働く。
    await page.locator('.mindmap-node[data-node-id="c0"] .mindmap-node-box').click();
    await page.waitForTimeout(50);
    for (let i = 0; i < TALL - 1; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(40);
    }
    await page.waitForTimeout(150);

    const trAfter = await treeRect(page);
    const rLast = await nodeRect(page, lastId);
    expect(rLast).not.toBeNull();

    // (a) 移動先 (末尾) が可視領域内に入った
    const inView = rLast!.left >= trAfter.left - 2 && rLast!.right <= trAfter.right + 2 &&
        rLast!.top >= trAfter.top - 2 && rLast!.bottom <= trAfter.bottom + 2;
    expect(inView).toBe(true);

    // (b) 中央でない (最小パン): 末尾ノードの中心が treeEl の縦中心から十分外れている。
    //     下から入ってきたので下端付近に留まるはず。中央寄せ実装なら |cy - treeCy| ≈ 0 で red。
    expect(Math.abs(rLast!.cy - trAfter.cy)).toBeGreaterThan(trAfter.h * 0.2);
});

test('TC-V3 load-bearing: ensureNodeVisible を「中央寄せ」に差し替えると中央 assert が red', async ({ page }) => {
    await setup(page);
    await toMindmap(page, tallTree(TALL, 'right'));
    await page.waitForTimeout(150);
    const lastId = 'c' + (TALL - 1);

    // ★ 各 ArrowDown 後に「選択中ノードを treeEl 中心に持っていく」処理を capture keydown で仕込む。
    //   これは ensureNodeVisible を「中央寄せ」実装に差し替えたのと同等 (実装本体を戻さず monkey-patch)。
    //   本来の最小パン実装なら末尾ノードは下端付近に留まる (中央でない) が、中央寄せだと中心に来る。
    //   → 「中央でない」assert (>h*0.2) が満たせず、この test では逆の「中央付近 (<=h*0.2)」が成立する
    //   ことを確認して、本来の TC-V3 の「中央でない」判定が偽陽性でない (中央寄せなら別結果になる) を担保。
    await page.evaluate(() => {
        const MR = (window as any).MindmapRender;
        (window as any).__centerHook = (ev: KeyboardEvent) => {
            if (ev.key !== 'ArrowDown') { return; }
            setTimeout(() => {
                const focused = document.querySelector('.mindmap-node-box.is-focused');
                const foEl = focused ? focused.closest('.mindmap-node') : null;
                if (!foEl) { return; }
                const nr = foEl.getBoundingClientRect();
                const t = document.querySelector('.outliner-tree') as HTMLElement;
                const trr = t.getBoundingClientRect();
                const vp = MR.getViewport();
                const ncy = (nr.top + nr.bottom) / 2;
                const tcy = (trr.top + trr.bottom) / 2;
                MR.updateViewport({ translateX: vp.translateX, translateY: vp.translateY + (tcy - ncy), scale: vp.scale });
            }, 15);
        };
        document.addEventListener('keydown', (window as any).__centerHook, true);
    });

    await page.locator('.mindmap-node[data-node-id="c0"] .mindmap-node-box').click();
    await page.waitForTimeout(50);
    for (let i = 0; i < TALL - 1; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(60);
    }
    await page.waitForTimeout(200);

    const trAfter = await treeRect(page);
    const rLast = await nodeRect(page, lastId);
    expect(rLast).not.toBeNull();

    // 中央寄せ (patch) では末尾ノードの中心が treeEl 中心にほぼ一致 → 「中央でない」条件は成立しない。
    expect(Math.abs(rLast!.cy - trAfter.cy)).toBeLessThanOrEqual(trAfter.h * 0.2);

    // 後始末
    await page.evaluate(() => {
        document.removeEventListener('keydown', (window as any).__centerHook, true);
    });
});

test('TC-V4a 追加ノードが画面内なら Enter/Tab/Shift+Enter で viewport 不変', async ({ page }) => {
    await setup(page);
    // 画面内に余裕のある小さいツリー。
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        mindmap: { layout: 'right' },
        nodes: {
            r: node('r', 'root', ['a'], null),
            a: node('a', 'alpha', [], 'r')
        }
    });
    await page.waitForTimeout(150);

    // Enter (弟追加) → viewport 不変
    let v0 = await getViewport(page);
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    let v1 = await getViewport(page);
    expect(Math.abs(v1.translateX - v0.translateX)).toBeLessThanOrEqual(2);
    expect(Math.abs(v1.translateY - v0.translateY)).toBeLessThanOrEqual(2);

    // Tab (子追加) → viewport 不変
    v0 = await getViewport(page);
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    v1 = await getViewport(page);
    expect(Math.abs(v1.translateX - v0.translateX)).toBeLessThanOrEqual(2);
    expect(Math.abs(v1.translateY - v0.translateY)).toBeLessThanOrEqual(2);

    // Shift+Enter (兄追加) → viewport 不変 (Shift+Enter の理想「動かない」維持)
    v0 = await getViewport(page);
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(150);
    v1 = await getViewport(page);
    expect(Math.abs(v1.translateX - v0.translateX)).toBeLessThanOrEqual(2);
    expect(Math.abs(v1.translateY - v0.translateY)).toBeLessThanOrEqual(2);
});

test('TC-V4b 端で追加して新ノードが画面外なら最小パンで可視化・中央でない', async ({ page }) => {
    await setup(page);
    // 縦に多数の子。画面内の最下段付近の子を選択して Enter (弟追加) すると、
    // 新ノードはその下 = 画面外に生成される。
    await toMindmap(page, tallTree(TALL, 'right'));
    await page.waitForTimeout(150);

    const tr = await treeRect(page);
    // 画面内に完全に収まっている「最も下」の子を探す (その弟が画面外に落ちる)。
    const anchor = await page.evaluate((tb) => {
        let best: string | null = null;
        let bestBottom = -Infinity;
        for (let i = 0; i < 24; i++) {
            const fo = document.querySelector(`.mindmap-node[data-node-id="c${i}"]`);
            if (!fo) { continue; }
            const r = (fo as any).getBoundingClientRect();
            if (r.top >= tb.top && r.bottom <= tb.bottom && r.bottom > bestBottom) { bestBottom = r.bottom; best = 'c' + i; }
        }
        return best;
    }, { top: tr.top, bottom: tr.bottom });
    expect(anchor).not.toBeNull();

    // anchor を選択 → Enter で弟追加 (新ノードが anchor の下 = 画面外)
    await page.locator(`.mindmap-node[data-node-id="${anchor}"] .mindmap-node-box`).click();
    await page.waitForTimeout(50);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    // 新ノード = model 上で anchor の直後の子 (自動生成 id)。
    const newId = await page.evaluate((a) => {
        const m = (window as any).Outliner.getModel();
        const kids: string[] = m.nodes.r.children;
        const idx = kids.indexOf(a);
        return (idx >= 0 && idx + 1 < kids.length) ? kids[idx + 1] : null;
    }, anchor);
    expect(newId).not.toBeNull();

    const trAfter = await treeRect(page);
    const rNew = await nodeRect(page, newId!);
    expect(rNew).not.toBeNull();

    // (a) 新ノードが可視領域内に入った
    const inView = rNew!.left >= trAfter.left - 2 && rNew!.right <= trAfter.right + 2 &&
        rNew!.top >= trAfter.top - 2 && rNew!.bottom <= trAfter.bottom + 2;
    expect(inView).toBe(true);

    // (b) 中央でない (最小パン): 新ノードの中心が treeEl 縦中心から十分外れている。
    expect(Math.abs(rNew!.cy - trAfter.cy)).toBeGreaterThan(trAfter.h * 0.2);
});
