/**
 * Mindmap iteration 22 — screen↔SVG 変換を pad 込みで是正 (Wave 27 / TASK-56)
 *   #5 fit で全ノードが可視領域に収まる / #4 minimap click でクリック位置が画面中心付近 /
 *   #2 mindmap を開いた時 title node を画面中心に出す。
 *
 * 根本原因 (session-log「iteration 22」): mindmap の SVG viewBox origin = bounds.min − pad
 *   (pad=120, mindmap-render.js:526)。.mindmap-viewport (treeEl 内 absolute; top/left:0;
 *   transform-origin:0 0) に transform:translate(tx,ty) scale(s) がかかるので、
 *   screen(P) = treeEl.left/top + viewport.translate + scale·(P − (bounds.min − pad))。
 *   旧 fit (interactions.js:890) は pad を 100 と誤り、旧 minimap click (:955-959) は viewBox
 *   origin 項 (b.min − pad) が抜けていて、どこをクリックしても同方向 (左上) へ飛んでいた。
 * 修正 (TASK-56): 共通ヘルパ placeSvgAtScreen(svgX,svgY,screenX,screenY) で
 *   translate = (screen − treeEl.left/top) − scale·(svg − (b.min − PAD=120)) を計算。
 *   fit = content bbox を可視領域 (treeEl ∩ window) に収める scale + bbox 中心を可視中心へ。
 *   minimap click = クリック割合 → SVG 座標 → 可視中心へ配置。
 *   開いた時 = 初回 attach で title node (__title__) を可視中心へ配置 (編集/追加では centering しない)。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   fit は toolbar ボタンを実クリック、minimap は実マウスクリック、開いた時は setViewMode。
 *   座標は実可視領域 (treeEl ∩ window) 基準 (iteration 21 の実可視端の教訓)。
 *
 * 標準ビューポートだと「画面外に広がる」を作りにくいので 800x600 に狭め、マップを大きくして
 *   bounds > 可視領域 を確実に作る (fit/minimap/中心化が「実際に viewport を動かす」状況で検証)。
 */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 800, height: 600 } });

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
    await page.waitForTimeout(250);
}

// 実可視領域 (treeEl ∩ window)。座標系は screen (getBoundingClientRect / window)。
function visFrame(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        const visLeft = Math.max(r.left, 0);
        const visRight = Math.min(r.right, window.innerWidth);
        const visTop = Math.max(r.top, 0);
        const visBottom = Math.min(r.bottom, window.innerHeight);
        return {
            left: visLeft, right: visRight, top: visTop, bottom: visBottom,
            cx: (visLeft + visRight) / 2, cy: (visTop + visBottom) / 2,
            w: visRight - visLeft, h: visBottom - visTop,
            treeLeft: r.left, treeTop: r.top
        };
    });
}
function nodeRect(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
    }, id);
}
function getViewport(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const vp = (window as any).MindmapRender.getViewport();
        return { translateX: vp.translateX, translateY: vp.translateY, scale: vp.scale };
    });
}
// layout の bounds を返す (fit/minimap の SVG 座標計算の参照)。
function bounds(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        // MindmapRender は layout を持たないので、attach に渡す runtime.layout の bounds を
        // 最新 render から拾う。ここでは全ノードの中心・端から代表を出す代わりに、
        // 「画面上でどのノードが最左/最右/最上/最下か」を測って四隅代表とする。
        const list = Array.from(document.querySelectorAll('.mindmap-node')).map((n: any) => {
            const r = n.getBoundingClientRect();
            return { id: n.getAttribute('data-node-id'), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        return list;
    });
}

// --- 横にも縦にも大きい balanced マップ (bounds >> 800x600 可視領域) ---
function bigBalancedMap(childCount = 18) {
    const children: string[] = [];
    const nodes: any = { r: node('r', 'ROOT NODE', [], null) };
    for (let i = 0; i < childCount; i++) {
        const id = 'c' + i;
        children.push(id);
        // 横に広げるため長めのラベル。
        nodes[id] = node(id, 'child number ' + i + ' with a fairly long label to widen the map', [], 'r');
    }
    nodes.r.children = children;
    return { version: 1, viewMode: 'mindmap', title: 'Center', rootIds: ['r'], mindmap: { layout: 'balanced' }, nodes };
}

// =====================================================================================
// TC-M1: fit で全ノード (bounds 四隅代表) が可視領域に収まる
// =====================================================================================
test('TC-M1 fit で bounds 四隅代表ノードが全て可視領域に収まる (左上に固まらない)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, bigBalancedMap());

    // 前提: fit 前は画面外にはみ出すノードがある (fit が実際に viewport を動かす状況)。
    const list0 = await bigMapCorners(page);
    const vis0 = await visFrame(page);
    const anyOutside0 = list0.some((n) => n.left < vis0.left - 2 || n.right > vis0.right + 2 || n.top < vis0.top - 2 || n.bottom > vis0.bottom + 2);
    expect(anyOutside0).toBe(true); // マップが可視領域より大きい (前提が崩れると偽陽性)

    // --- fit ボタンを実クリック ---
    await page.locator('.mindmap-toolbar button[data-mm-action="fit"]').click();
    await page.waitForTimeout(150);

    const vis = await visFrame(page);
    const corners = await bigMapCorners(page);
    const M = 4; // ±マージン (px)
    // 四隅代表ノード (最左/最右/最上/最下) が全て可視領域内に収まる。
    for (const n of corners) {
        expect(n.left).toBeGreaterThanOrEqual(vis.left - M);
        expect(n.right).toBeLessThanOrEqual(vis.right + M);
        expect(n.top).toBeGreaterThanOrEqual(vis.top - M);
        expect(n.bottom).toBeLessThanOrEqual(vis.bottom + M);
    }
    // 左上に固まっていない: ノードが可視領域に横にも縦にも分散している。
    const cxs = corners.map((n) => (n.left + n.right) / 2);
    const cys = corners.map((n) => (n.top + n.bottom) / 2);
    expect(Math.max(...cxs) - Math.min(...cxs)).toBeGreaterThan(vis.w * 0.2);
    expect(Math.max(...cys) - Math.min(...cys)).toBeGreaterThan(vis.h * 0.2);
});

test('TC-M1 load-bearing: 旧 fit 式 (pad=100・単純 translate) だとノードが可視領域外/左上に固まる', async ({ page }) => {
    await setup(page);
    await toMindmap(page, bigBalancedMap());

    // ★ 旧 fitToScreen 式を counterfactual として手で適用する:
    //   scale = min(rect.width/(bw+240), rect.height/(bh+240), 2)、
    //   translateX = 20 − b.minX*scale + 100*scale (pad 不一致・全体を収める変換になっていない)。
    // 修正式と同じ fixture・同じ treeEl rect で「旧式なら可視領域外に出る」ことを実証する。
    // b.minX/minY/bw/bh は render の viewBox 属性 (vbX/vbY/vbW/vbH = b.min−120 / +240) から逆算する。
    await page.evaluate(() => {
        const MR = (window as any).MindmapRender;
        const svg = document.querySelector('.mindmap-svg') as SVGSVGElement;
        const vb = (svg.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
        const PAD = 120;
        const bMinX = vb[0] + PAD, bMinY = vb[1] + PAD;
        const bw = vb[2] - PAD * 2, bh = vb[3] - PAD * 2;
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const rect = t.getBoundingClientRect();
        let scale = Math.min(rect.width / (bw + 240), rect.height / (bh + 240), 2);
        scale = Math.max(0.2, Math.min(4, scale || 1));
        const vp = MR.getViewport();
        vp.scale = scale;
        vp.translateX = 20 - bMinX * scale + 100 * scale;
        vp.translateY = 20 - bMinY * scale + 100 * scale;
        MR.updateViewport(vp);
    });
    await page.waitForTimeout(120);

    const vis = await visFrame(page);
    const corners = await bigMapCorners(page);
    // 旧式では「全ノードが可視領域内」が成立しない (少なくとも 1 つが外)。
    const M = 4;
    const allInside = corners.every((n) => n.left >= vis.left - M && n.right <= vis.right + M && n.top >= vis.top - M && n.bottom <= vis.bottom + M);
    expect(allInside).toBe(false); // 旧式 = red 領域 (TC-M1 の「全て収まる」が満たせない)
});

// =====================================================================================
// TC-M2: minimap click でクリック位置が画面中心付近 (どこクリックしても左上、でない)
// 多方向に広がる spread マップ (複数 root × 子) で、特定ノードの minimap 上の位置をクリック
// → そのノードが画面中心付近に来ることを検証する。右側ノードと左側ノードで translate が異なる。
// =====================================================================================
test('TC-M2 minimap で特定ノードの位置をクリックするとそのノードが画面中心付近に来る (左上でない)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, spreadMap());

    // 画面上で最も右のノードと最も左のノードを選ぶ (異なる SVG 領域 = minimap の別位置)。
    const extremes = await extremeNodes(page);
    expect(extremes.rightId).not.toBeNull();
    expect(extremes.leftId).not.toBeNull();
    expect(extremes.rightId).not.toBe(extremes.leftId);

    // --- 右端ノードの minimap 上の位置をクリック → そのノードが可視中心付近に ---
    await clickNodeOnMinimap(page, extremes.rightId!);
    const vRight = await getViewport(page);
    let vis = await visFrame(page);
    let rRight = await nodeRect(page, extremes.rightId!);
    expect(rRight).not.toBeNull();
    expect(Math.abs(rRight!.cx - vis.cx)).toBeLessThanOrEqual(vis.w * 0.35);
    expect(Math.abs(rRight!.cy - vis.cy)).toBeLessThanOrEqual(vis.h * 0.35);

    // --- 左端ノードの minimap 上の位置をクリック → そのノードが可視中心付近に ---
    await clickNodeOnMinimap(page, extremes.leftId!);
    const vLeft = await getViewport(page);
    vis = await visFrame(page);
    let rLeft = await nodeRect(page, extremes.leftId!);
    expect(rLeft).not.toBeNull();
    expect(Math.abs(rLeft!.cx - vis.cx)).toBeLessThanOrEqual(vis.w * 0.35);
    expect(Math.abs(rLeft!.cy - vis.cy)).toBeLessThanOrEqual(vis.h * 0.35);

    // ★ 右端ノードと左端ノードの minimap クリックで viewport translate が異なる
    //   (どこクリックしても同方向=左上、ではない)。
    expect(Math.abs(vRight.translateX - vLeft.translateX)).toBeGreaterThan(30);
});

test('TC-M2 load-bearing: viewBox origin 項 (b.min−pad) を除く旧式だとクリックしたノードが中心に来ない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, spreadMap());

    const extremes = await extremeNodes(page);
    expect(extremes.rightId).not.toBeNull();

    // ★ 旧 minimap click 式 (viewBox origin 項 (b.min−pad) が抜け):
    //   translate = (rect.w/2 − tx*s, rect.h/2 − ty*s)。同じノードの minimap 位置を「旧式」で
    //   クリックした場合の translate を手計算で適用し、そのノードが画面中心に来ないことを実証する。
    //   → 修正式 (origin 項あり) だけがクリックしたノードを中心に置ける = TC-M2 が偽陽性でない。
    const nid = extremes.rightId!;
    const frac = await nodeMinimapFraction(page, nid);
    expect(frac).not.toBeNull();
    await page.evaluate((f) => {
        const MR = (window as any).MindmapRender;
        const svg = document.querySelector('.mindmap-svg') as SVGSVGElement;
        const vb = (svg.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
        const PAD = 120;
        const bMinX = vb[0] + PAD, bMinY = vb[1] + PAD;
        const bw = vb[2] - PAD * 2, bh = vb[3] - PAD * 2;
        const tx = bMinX + f.fx * bw, ty = bMinY + f.fy * bh;
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const rect = t.getBoundingClientRect();
        const vp = MR.getViewport();
        // 旧式: viewBox origin 項なし (SVG 原点を 0 とみなす)
        vp.translateX = rect.width / 2 - tx * vp.scale;
        vp.translateY = rect.height / 2 - ty * vp.scale;
        MR.updateViewport(vp);
    }, frac!);
    await page.waitForTimeout(100);

    const vis = await visFrame(page);
    const rNode = await nodeRect(page, nid);
    expect(rNode).not.toBeNull();
    // 旧式ではクリックしたノードが中心に来ない (origin (b.min−pad)*s 分ずれる)。
    const off = Math.hypot(rNode!.cx - vis.cx, rNode!.cy - vis.cy);
    expect(off).toBeGreaterThan(Math.min(vis.w, vis.h) * 0.35);
});

// =====================================================================================
// TC-M3: mindmap を開いた時 title node が画面中心
// =====================================================================================
function titleMap() {
    return {
        version: 1, viewMode: 'mindmap', title: 'Center', rootIds: ['R0', 'R1', 'L0', 'L1'],
        mindmap: { layout: 'balanced' },
        nodes: {
            R0: node('R0', 'right node zero', [], null),
            R1: node('R1', 'right node one', [], null),
            L0: node('L0', 'left node zero', [], null),
            L1: node('L1', 'left node one', [], null),
        }
    };
}

test('TC-M3 mindmap を開いた時 title node が可視領域中心に近い', async ({ page }) => {
    await setup(page);
    await toMindmap(page, titleMap());
    await page.waitForTimeout(120);

    const vis = await visFrame(page);
    const rTitle = await nodeRect(page, '__title__');
    expect(rTitle).not.toBeNull();

    // ★ title node の画面中心が可視領域中心に近い (|Δ| <= 可視幅/高さ*0.2)。
    expect(Math.abs(rTitle!.cx - vis.cx)).toBeLessThanOrEqual(vis.w * 0.2);
    expect(Math.abs(rTitle!.cy - vis.cy)).toBeLessThanOrEqual(vis.h * 0.2);
});

test('TC-M3 load-bearing: centering を無効化すると title の中心からのズレが有意に大きくなる', async ({ page }) => {
    // ★ centering ON と OFF で同じ titleMap を開き、title の可視中心からのズレを比較する。
    //   ON: placeSvgAtScreen で title を可視中心へ → ズレほぼ 0。
    //   OFF: 初期 viewport のままなので title は中心に置かれない → ズレが有意に大きい。
    //   「OFF の方が大きくずれる (offDisabled >> offEnabled)」で centering が実効している = 偽陽性でない。

    // --- (a) centering OFF で開く ---
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => { (window as any).MindmapInteractions._setOpenCenterEnabled(false); });
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, titleMap());
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
    let vis = await visFrame(page);
    let rTitle = await nodeRect(page, '__title__');
    expect(rTitle).not.toBeNull();
    const offDisabled = Math.hypot(rTitle!.cx - vis.cx, rTitle!.cy - vis.cy);

    // --- (b) centering ON で開き直す (destroy → 再 attach で開いた時中心化が発火) ---
    await page.evaluate(() => { (window as any).MindmapInteractions._setOpenCenterEnabled(true); });
    await page.evaluate(() => (window as any).Outliner.setViewMode('outliner'));
    await page.waitForTimeout(80);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
    vis = await visFrame(page);
    rTitle = await nodeRect(page, '__title__');
    expect(rTitle).not.toBeNull();
    const offEnabled = Math.hypot(rTitle!.cx - vis.cx, rTitle!.cy - vis.cy);

    // ON では title が可視中心付近 (TC-M3 の許容内)。
    expect(offEnabled).toBeLessThanOrEqual(Math.min(vis.w, vis.h) * 0.2);
    // ★ OFF の方が有意に大きくずれる (centering が実際に title を中心へ動かしている)。
    expect(offDisabled).toBeGreaterThan(offEnabled + 40);
});

// --- helpers (四隅代表ノード / minimap rect / 中心最近ノード) ---
async function bigMapCorners(page: import('@playwright/test').Page) {
    // 現在の DOM から「最左/最右/最上/最下」の代表ノードを 4 つ抽出する (bounds 四隅代表)。
    const list = await bounds(page);
    if (!list.length) { return []; }
    const byLeft = [...list].sort((a, b) => a.left - b.left)[0];
    const byRight = [...list].sort((a, b) => b.right - a.right)[0];
    const byTop = [...list].sort((a, b) => a.top - b.top)[0];
    const byBottom = [...list].sort((a, b) => b.bottom - a.bottom)[0];
    const ids = new Set([byLeft.id, byRight.id, byTop.id, byBottom.id]);
    return list.filter((n) => ids.has(n.id));
}
function minimapRect(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const m = document.querySelector('.mindmap-minimap') as HTMLElement;
        const r = m.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    });
}
function nearestToCenter(page: import('@playwright/test').Page, cx: number, cy: number) {
    return page.evaluate((c: any) => {
        const nodes = Array.from(document.querySelectorAll('.mindmap-node')).map((n: any) => {
            const r = n.getBoundingClientRect();
            return { id: n.getAttribute('data-node-id'), cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
        });
        if (!nodes.length) { return null; }
        nodes.sort((a, b) => Math.hypot(a.cx - c.x, a.cy - c.y) - Math.hypot(b.cx - c.x, b.cy - c.y));
        return nodes[0];
    }, { x: cx, y: cy });
}

// --- TC-M2 用: 多方向に広がる spread マップ (複数 root × 子で minimap 全域にノードが分布) ---
function spreadMap() {
    const nodes: any = {};
    const rootIds: string[] = [];
    for (let r = 0; r < 8; r++) {
        const rid = 'R' + r; rootIds.push(rid);
        const kids: string[] = [];
        for (let k = 0; k < 4; k++) {
            const kid = 'R' + r + 'k' + k; kids.push(kid);
            nodes[kid] = node(kid, 'root ' + r + ' kid ' + k + ' longer label', [], rid);
        }
        nodes[rid] = node(rid, 'ROOT ' + r + ' with a long label here', kids, null);
    }
    return { version: 1, viewMode: 'mindmap', title: 'Center', rootIds, mindmap: { layout: 'balanced' }, nodes };
}

// 右側 / 左側にあり、かつ minimap 上のクリック点が実可視領域 (minimap ∩ window) 内に収まる
// ノードの id を返す (minimap が window より外にはみ出す端のノードは選ばない)。
// 「異なる SVG 領域 = minimap の別位置」であることは fx が十分離れていることで担保する。
function extremeNodes(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const PAD = 120;
        const svg = document.querySelector('.mindmap-svg') as SVGSVGElement;
        const vb = (svg.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
        const bMinX = vb[0] + PAD, bMinY = vb[1] + PAD, bw = vb[2] - PAD * 2, bh = vb[3] - PAD * 2;
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const tr = t.getBoundingClientRect();
        const m = document.querySelector('.mindmap-minimap') as HTMLElement;
        const mmr = m.getBoundingClientRect();
        const vp = (window as any).MindmapRender.getViewport();
        // minimap クリック可能領域 (minimap ∩ window)。この内側に収まる click 点を持つノードのみ。
        const mmLeft = Math.max(mmr.left, 0), mmRight = Math.min(mmr.right, window.innerWidth);
        const mmTop = Math.max(mmr.top, 0), mmBottom = Math.min(mmr.bottom, window.innerHeight);
        const cand: { id: string; fx: number; clickX: number }[] = [];
        Array.from(document.querySelectorAll('.mindmap-node')).forEach((n: any) => {
            const id = n.getAttribute('data-node-id');
            if (id === '__title__') { return; }
            const r = n.getBoundingClientRect();
            const sc = (r.left + r.right) / 2, scy = (r.top + r.bottom) / 2;
            const svgX = (sc - tr.left - vp.translateX) / vp.scale + (bMinX - PAD);
            const svgY = (scy - tr.top - vp.translateY) / vp.scale + (bMinY - PAD);
            const fx = (svgX - bMinX) / bw, fy = (svgY - bMinY) / bh;
            const clickX = mmr.left + fx * mmr.width, clickY = mmr.top + fy * mmr.height;
            // クリック点が minimap ∩ window に収まる (端にはみ出したノードは除外)。
            if (clickX >= mmLeft + 3 && clickX <= mmRight - 3 && clickY >= mmTop + 3 && clickY <= mmBottom - 3) {
                cand.push({ id, fx, clickX });
            }
        });
        if (cand.length < 2) { return { rightId: null, leftId: null }; }
        cand.sort((a, b) => a.fx - b.fx);
        return { leftId: cand[0].id, rightId: cand[cand.length - 1].id };
    });
}

// 対象ノードの SVG 座標 (現在の viewport から逆算) → minimap 上の割合 fx/fy を返す。
//   screenCx = treeLeft + translateX + scale·(svgX − (b.minX − PAD))
//   ⇒ svgX = (screenCx − treeLeft − translateX)/scale + (b.minX − PAD)
//   fx = (svgX − b.minX)/(b.maxX − b.minX)  (minimap dot は (p − b.min)·miniScale で描画されるため)
function nodeMinimapFraction(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        const screenCx = (r.left + r.right) / 2, screenCy = (r.top + r.bottom) / 2;
        const svg = document.querySelector('.mindmap-svg') as SVGSVGElement;
        const vb = (svg.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
        const PAD = 120;
        const bMinX = vb[0] + PAD, bMinY = vb[1] + PAD;
        const bw = vb[2] - PAD * 2, bh = vb[3] - PAD * 2;
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const tr = t.getBoundingClientRect();
        const vp = (window as any).MindmapRender.getViewport();
        const svgX = (screenCx - tr.left - vp.translateX) / vp.scale + (bMinX - PAD);
        const svgY = (screenCy - tr.top - vp.translateY) / vp.scale + (bMinY - PAD);
        return { fx: (svgX - bMinX) / bw, fy: (svgY - bMinY) / bh };
    }, id);
}

// 対象ノードの minimap 上の位置を実マウスクリックする。
async function clickNodeOnMinimap(page: import('@playwright/test').Page, id: string) {
    const frac = await nodeMinimapFraction(page, id);
    if (!frac) { throw new Error('node not found: ' + id); }
    const mr = await minimapRect(page);
    // 割合を minimap rect 内にクランプ (端の外に出ないように)。実クリック。
    const fx = Math.max(0.02, Math.min(0.98, frac.fx));
    const fy = Math.max(0.02, Math.min(0.98, frac.fy));
    await page.mouse.click(mr.left + mr.w * fx, mr.top + mr.h * fy);
    await page.waitForTimeout(120);
}
