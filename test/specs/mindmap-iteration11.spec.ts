/**
 * Mindmap iteration 11 — ノードの内側エッジ合わせ配置 + リンクのエッジ接続 (Wave 15 / FR-021-A8, TASK-40)
 * TC-A8-1 (right 側: 内側エッジ=左端が commit 後も不変 / load-bearing),
 * TC-A8-2 (left 側: 内側エッジ=右端が commit 後も不変),
 * TC-A8-3 (リンクがノードの内側エッジに接続する)。
 *
 * 根本原因: buildNodeEl が foreignObject を x = pos.x - width/2 (中心合わせ) で配置するため、
 * 幅が変わると中心を軸に左右へ膨らみ内側エッジがずれる。commit 後に幅拡張ノードが中央寄りになる (#1/#2)。
 * リンク端点が中心基準なので幅変化で線が歪む (#3)。
 * 修正: right 側 = 左端(内側エッジ)を pos.x に固定、left 側 = 右端(内側エッジ)を pos.x に固定。
 * リンク端点を子の内側エッジ / 親の外側エッジに合わせる。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): 必ず page.locator(...).click() (実選択)
 * → page.keyboard.press()/type() (実キー)。el.focus() 直呼び禁止。
 * 位置は .mindmap-node[data-node-id] の getBoundingClientRect (left/right/width) で測る。
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
// foreignObject の SVG 内部座標属性 (x, width) から「内側エッジ」を測る。
// right 側: 内側エッジ = 左端 = x。left 側: 内側エッジ = 右端 = x + width。
// screen 座標 (getBoundingClientRect) は幅拡張で bounds/viewBox がシフトすると全体が動くため、
// 「内側エッジが不変/揃う」の検証には SVG 座標を使う (レイアウト座標系での不変性 = 設計正典の意図)。
function foAttr(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as SVGGraphicsElement | null;
        if (!fo) { return null; }
        const x = parseFloat(fo.getAttribute('x') || '0');
        const w = parseFloat(fo.getAttribute('width') || '0');
        return { x: Math.round(x), width: Math.round(w), rightEdge: Math.round(x + w) };
    }, id);
}

test('TC-A8-1 (#1/#2 right 側 load-bearing) 内側エッジ=左端が編集の幅拡張 commit 後も不変', async ({ page }) => {
    await setup(page);
    // title 中心ノード + right 側の兄弟複数 (layout:right で全子が右側に配置)。各子は短いテキスト。
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: 'Center', rootIds: ['c1', 'c2', 'c3'],
        mindmap: { layout: 'right' },
        nodes: {
            c1: node('c1', 'a', [], null),
            c2: node('c2', 'b', [], null),
            c3: node('c3', 'c', [], null)
        }
    });

    // 検証1 (初期): c1/c2/c3 の内側エッジ (right 側 = SVG 左端 x) がほぼ揃う (差 <= 2)
    const i1 = await foAttr(page, 'c1');
    const i2 = await foAttr(page, 'c2');
    const i3 = await foAttr(page, 'c3');
    expect(i1).not.toBeNull();
    expect(i2).not.toBeNull();
    expect(i3).not.toBeNull();
    expect(Math.abs(i1!.x - i2!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(i2!.x - i3!.x)).toBeLessThanOrEqual(2);
    const beforeScreen = await foRect(page, 'c2');

    // c2 を編集して幅拡張
    await page.locator('.mindmap-node[data-node-id="c2"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    const l0 = i2!.x; // 編集前の内側エッジ (SVG 左端 x)
    // 改行なし長文 (280 未満)
    await page.keyboard.type('これは折り返さずに横に伸びるそこそこ長い一文');
    await page.waitForTimeout(120);
    // Enter で commit
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const after = await foAttr(page, 'c2');
    const afterScreen = await foRect(page, 'c2');
    expect(after).not.toBeNull();
    // commit 後も内側エッジ (SVG 左端 x) が l0 とほぼ同じ (中央寄りにならない・左端固定)
    expect(Math.abs(after!.x - l0)).toBeLessThanOrEqual(3);
    // width は増加 (右へ伸びた)。SVG 内部幅 + screen 幅の両方で確認。
    expect(after!.width).toBeGreaterThan(i2!.width);
    expect(afterScreen!.width).toBeGreaterThan(beforeScreen!.width);

    // c1/c3 の内側エッジ x も初期と揃ったまま (内側エッジ揃え)
    const a1 = await foAttr(page, 'c1');
    const a3 = await foAttr(page, 'c3');
    expect(Math.abs(a1!.x - l0)).toBeLessThanOrEqual(3);
    expect(Math.abs(a3!.x - l0)).toBeLessThanOrEqual(3);
});

test('TC-A8-2 (#2 left 側) 内側エッジ=右端が幅拡張 commit 後も不変', async ({ page }) => {
    await setup(page);
    // title 中心ノード + left 側 (layout:left で全子が左側に配置)
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: 'Center', rootIds: ['n1', 'n2'],
        mindmap: { layout: 'left' },
        nodes: {
            n1: node('n1', 'x', [], null),
            n2: node('n2', 'y', [], null)
        }
    });
    const before = await foAttr(page, 'n1'); // 編集前の内側エッジ (left 側 = 右端 x+width)
    await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(60);
    const r0 = before!.rightEdge; // 編集前の内側エッジ (SVG 右端 = x + width)
    await page.keyboard.type('これは左へ折り返さずに伸びる一文です');
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const after = await foAttr(page, 'n1');
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // commit 後も内側エッジ (SVG 右端 = x + width) が r0 とほぼ同じ (右端固定で左へ拡張)
    expect(Math.abs(after!.rightEdge - r0)).toBeLessThanOrEqual(3);
    // 左端 (SVG x) は小さくなる (左へ伸びた)
    expect(after!.x).toBeLessThan(before!.x - 2);
    // width は増加
    expect(after!.width).toBeGreaterThan(before!.width);
});

test('TC-A8-3 (#3) 親リンクがノードの内側エッジ (中心でない) に接続する', async ({ page }) => {
    await setup(page);
    // title 中心 + right 側に、初期から長文で幅の広い子 wide と短い兄弟 short
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', title: 'Center', rootIds: ['wide', 'short'],
        mindmap: { layout: 'right' },
        nodes: {
            wide: node('wide', 'これは初期から幅の広いノードのテキストです', [], null),
            short: node('short', 's', [], null)
        }
    });
    await page.waitForTimeout(100);

    // wide への親リンク path の終点 (子側端点) を screen 座標で取得
    const res = await page.evaluate(() => {
        function endPointScreen(path: SVGPathElement) {
            const len = path.getTotalLength();
            const pt = path.getPointAtLength(len); // SVG 内部座標 (path 終点 = 子側端点 tx,ty)
            const svg = path.ownerSVGElement as SVGSVGElement;
            const m = path.getScreenCTM();
            if (!svg || !m) { return null; }
            const p = svg.createSVGPoint();
            p.x = pt.x; p.y = pt.y;
            const sp = p.matrixTransform(m);
            return { x: sp.x, y: sp.y };
        }
        function nodeRect(id: string) {
            const fo = document.querySelector(`.mindmap-node[data-node-id="${id}"]`);
            return fo ? fo.getBoundingClientRect() : null;
        }
        const widePath = document.querySelector('.mindmap-link[data-target-id="wide"]') as SVGPathElement | null;
        if (!widePath) { return { found: false }; }
        const end = endPointScreen(widePath);
        const wideR = nodeRect('wide');
        if (!end || !wideR) { return { found: false }; }
        return {
            found: true,
            endX: end.x,
            wideLeft: wideR.left,      // right 側なので内側エッジ = 左端
            wideCenter: wideR.left + wideR.width / 2,
            wideWidth: wideR.width
        };
    });

    expect(res.found).toBe(true);
    // 終点 x がノードの内側エッジ (right 側 = 左端) にほぼ一致 (差 <= 8px)
    expect(Math.abs(res.endX! - res.wideLeft!)).toBeLessThanOrEqual(8);
    // 中心ではないこと: 幅が広いので内側エッジと中心は width/2 だけ離れている
    // (差が有意 = 中心に刺さっていない)
    expect(Math.abs(res.endX! - res.wideCenter!)).toBeGreaterThan(res.wideWidth! / 4);
});
