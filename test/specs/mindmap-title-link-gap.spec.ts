/**
 * mindmap 中央 title node の接続線が box エッジから離れる隙間バグの修正検証。
 * sprint 20260721-134546。
 *
 * 真因: title box は .mindmap-title-box で font 15px bold で描画されるが、pass-1 estimateMeasure が
 * 既定 fontSize(13/14) で概算するため title 推定幅が過小 → link 始点 sx = cx ± 幅/2 が実 box エッジより
 * 内側 = 隙間。修正: title の measure を実描画 font(15px bold) 相当の TITLE_MEASURE_FONT_SIZE で概算。
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}
async function toMindmapWithTitle(page: import('@playwright/test').Page, data: any, title: string) {
    await page.evaluate(({ d, t }) => {
        const dd = Object.assign({}, d, { title: t });
        (window as any).__testApi.initOutliner(dd);
    }, { d: data, t: title });
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(200);
}

// 指定 source-id の link path の始点(M sx,sy)を screen 座標で返す。
async function linkStartScreen(page: import('@playwright/test').Page, sourceId: string) {
    return page.evaluate((sid) => {
        var paths = Array.from(document.querySelectorAll('.mindmap-link[data-source-id="' + sid + '"]')) as SVGPathElement[];
        if (!paths.length) { return null; }
        var svg = paths[0].ownerSVGElement as SVGSVGElement;
        var out: Array<{ x: number; y: number }> = [];
        for (const p of paths) {
            const pt = p.getPointAtLength(0);
            const m = p.getScreenCTM();
            if (!m) { continue; }
            const sp = svg.createSVGPoint(); sp.x = pt.x; sp.y = pt.y;
            const s = sp.matrixTransform(m);
            out.push({ x: s.x, y: s.y });
        }
        return out;
    }, sourceId);
}
function titleBoxRect(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="__title__"]') as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { left: r.left, right: r.right, cx: r.left + r.width / 2 };
    });
}

// TC-ML-01: title 接続線の始点が title box の実エッジと一致（隙間なし）
test('TC-ML-01 title の接続線が box エッジに繋がる（隙間なし）', async ({ page }) => {
    await setup(page);
    // title + 左右に子（root を 2 つ → title 中心の両側に振り分け）
    await toMindmapWithTitle(page, {
        version: 1,
        rootIds: ['a', 'b'],
        nodes: {
            a: node('a', 'bedrock全体像'),
            b: node('b', 'やりたいこと調査'),
        },
    }, '調査結果');

    const starts = await linkStartScreen(page, '__title__');
    const box = await titleBoxRect(page);
    expect(starts, 'title 発の link が存在').not.toBeNull();
    expect(box, 'title box が存在').not.toBeNull();
    expect(starts!.length).toBeGreaterThanOrEqual(2);   // 左右に子

    // 各 link 始点 x が title box の左右いずれかのエッジに一致（許容誤差 ≤ 4px）。
    // 修正前は estimate 幅過小で始点が box エッジより内側（cx 寄り）に数 px 入り込む = 隙間。
    for (const s of starts!) {
        const dLeft = Math.abs(s.x - box!.left);
        const dRight = Math.abs(s.x - box!.right);
        const nearestEdge = Math.min(dLeft, dRight);
        expect(nearestEdge, `link 始点 x=${s.x} が box エッジ(L=${box!.left},R=${box!.right}) に一致`).toBeLessThanOrEqual(4);
        // 中心には無い（エッジであって中央ではない）
        expect(Math.abs(s.x - box!.cx)).toBeGreaterThan(4);
    }
});

// TC-ML-02: 実 node（非 title）の接続線は従来通り box エッジに繋がる（回帰）
test('TC-ML-02 実 node の接続線は不変（title 修正が実 node を壊さない）', async ({ page }) => {
    await setup(page);
    // title 配下の実 node a に子 c を付ける
    await toMindmapWithTitle(page, {
        version: 1,
        rootIds: ['a'],
        nodes: {
            a: node('a', '親ノード', ['c']),
            c: node('c', '子ノード', [], 'a'),
        },
    }, '中央');

    const starts = await linkStartScreen(page, 'a');   // a → c の link 始点
    const aRect = await page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="a"]') as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { left: r.left, right: r.right };
    });
    expect(starts, 'a 発の link').not.toBeNull();
    expect(aRect).not.toBeNull();
    for (const s of starts!) {
        const nearest = Math.min(Math.abs(s.x - aRect!.left), Math.abs(s.x - aRect!.right));
        expect(nearest, `実 node a の link 始点が box エッジに一致`).toBeLessThanOrEqual(4);
    }
});
