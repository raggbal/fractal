/**
 * Mindmap iteration 19 — ensureNodeVisible のトリガーを「はみ出し」→「マージン込み収まり」に是正
 *   (Wave 25 / FR-021-J2, TASK-53)
 *
 * バグ (Image #20): iteration 18 で ensureNodeVisible の margin 値を 32/handlePad 12 に増やしたが、
 *   発動トリガー (`nr.right > vr.right` = はみ出し判定) を変えなかった。→ Tab 追加ノードが画面内に
 *   ピッタリ収まる (nr.right <= vr.right だが端に密着) と dx=0 で何もしない → 画面端にくっつく。
 * 根本原因: トリガーが「はみ出し時のみ」だったため、端に密着 (はみ出さないが余白 < marginX) の
 *   ケースにマージンが効かなかった。マージン値をいくら増やしても、はみ出していなければ発動しない。
 * 修正 (TASK-53): トリガーを「マージン分の余白を確保して収まっているか」に変える (4 方向対称)。
 *   右: `nr.right + marginX + handlePad > vr.right` → dx = -(超過分)。端密着でも発動して隙間を作る。
 *   十分内側 (マージン分の余裕あり) のノードは全条件 false → dx=dy=0 → 不動 (過剰パン防止)。
 *   margin 値 (marginX=32, marginY=16, handlePad=12) は iteration 18 のまま。トリガー式のみ変更。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   page.locator(...).click() (実選択) → page.keyboard.press(...) (実キー) の実フロー。
 *   screen 位置は getBoundingClientRect。ハンドル張り出しは .mindmap-collapse-handle の rect で測る。
 *
 * ★ TASK-55 (測定基準是正): TASK-54 で ensureNodeVisible の可視右端が treeEl.right(=1309) →
 *   実可視右端 visRight = Math.min(tree.right, window.innerWidth) = 1280 に変わった (standalone でも
 *   .outliner-tree は right=1309 が innerWidth=1280 を 29px はみ出す)。よって余白/端密着は visRight 基準で
 *   測り、端密着を作る pan 量も visRight に合わせて 109 → 140 に再校正 (閾値 32 は不変、基準のみ是正)。
 *
 * ジオメトリ (standalone で実測): title 中心 + balanced。right 側の子持ちノード R0 は translate=0 で
 *   fo.right≈1404 (visRight=1280 を超えてはみ出す)。viewport を左へ 140px pan すると
 *   fo.right≈1264 (visRight=1280 の 16px 内側 = 端密着・はみ出さない・余白 < marginX(32))。
 *   この状態で R1 (下の兄弟) を click → ArrowUp で R0 へ移動 → ensureNodeVisible が R0 に発火。
 *   マージン込みトリガー: nr.right+32+12 > visRight → dx=-(超過分) → handleRight が visRight から
 *   handle gap ≈ 35 (>= 32) 内側へ。旧 overflow トリガーでは発動せず handle gap ≈ 7 (< 32)。
 *
 * load-bearing: MindmapInteractions._setEnsureVisibleTrigger('overflow') で旧トリガー (はみ出し時のみ)
 *   に戻すと、端密着ノードで発動せず隙間 < 32 で red。既定 'margin' で >= 32 になり green。
 *   (mindmap-render.js の _setStabilizeEnabled と同方針のテストフック。本番は既定 'margin' を使う。)
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
    await page.waitForTimeout(250);
}

// title 中心 + balanced。前半 ceil(4/2)=2 が右ブロック (R0,R1)、後半が左ブロック (L0,L1)。
// R0 は子を持つ (= 折りたたみハンドルが付く) チェーンにして横に広げる (端密着を作りやすくする)。
const FIXTURE = {
    version: 1, viewMode: 'mindmap', title: 'CENTER', rootIds: ['R0', 'R1', 'L0', 'L1'],
    mindmap: { layout: 'balanced' },
    nodes: {
        R0: node('R0', 'right zero long label here', ['R0a'], null),
        R0a: node('R0a', 'right zero child A deep', ['R0a1'], 'R0'),
        R0a1: node('R0a1', 'right zero grand', [], 'R0a'),
        R1: node('R1', 'right one', [], null),
        L0: node('L0', 'left zero long label here', ['L0a'], null),
        L0a: node('L0a', 'left zero child A deep', ['L0a1'], 'L0'),
        L0a1: node('L0a1', 'left zero grand', [], 'L0a'),
        L1: node('L1', 'left one', [], null),
    }
};

const MARGIN_X = 32; // 本番既定 (_ensureMarginX)。テストはこの値以上の隙間を要求する。

// treeEl (.outliner-tree) 可視 rect。
// TASK-54 で ensureNodeVisible の可視端が treeEl 矩形そのものでなく「実ウィンドウとの交差」に
// 変わった (standalone でも .outliner-tree の right=1309 は window.innerWidth=1280 を 29px はみ出す)。
// TC の余白/端密着測定は「実際に見えている端」= visRight/visLeft を基準にする (TASK-55, 測定基準のみ是正)。
//   visRight = Math.min(tree.right, window.innerWidth), visLeft = Math.max(tree.left, 0)
function treeRect(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        const winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : r.right;
        return {
            left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            visRight: Math.min(r.right, winW),  // 実可視右端
            visLeft: Math.max(r.left, 0),       // 実可視左端
        };
    });
}

// 対象ノードの rect (fo 右端 + ハンドル込み右端)。
function nodeEdges(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as any;
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        const h = fo.querySelector('.mindmap-collapse-handle');
        const hr = h ? h.getBoundingClientRect() : null;
        return {
            foLeft: r.left, foRight: r.right,
            hasHandle: !!h,
            // ハンドル込みの実描画右端 (無ければ fo 右端)。
            handleRight: hr ? hr.right : r.right,
        };
    }, id);
}

// 現在フォーカス中のノード id。
function focusedId(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const b = document.querySelector('.mindmap-node-box.is-focused');
        const fo = b ? b.closest('.mindmap-node') : null;
        return fo ? fo.getAttribute('data-node-id') : null;
    });
}

// MindmapRender.getViewport() の translate をコピーで返す。
function getViewport(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const vp = (window as any).MindmapRender.getViewport();
        return { translateX: vp.translateX, translateY: vp.translateY, scale: vp.scale };
    });
}

// viewport を左へ pan して R0 を「画面内かつ右端に密着 (はみ出さない・余白 < marginX)」にする。
// getViewport() が返す live オブジェクトを in-place 変更 → interactions の viewport 参照と同期。
async function panRightNodeToEdge(page: import('@playwright/test').Page, dx: number) {
    await page.evaluate((d) => {
        const MR = (window as any).MindmapRender;
        const vp = MR.getViewport();
        vp.translateX = vp.translateX - d;
        MR.updateViewport(vp);
    }, dx);
    await page.waitForTimeout(80);
}

// R1 (R0 の下の兄弟) を click → ArrowUp で R0 へ移動 → ensureNodeVisible を R0 に発火。
async function reachR0ViaArrow(page: import('@playwright/test').Page) {
    await page.locator('.mindmap-node[data-node-id="R1"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('ArrowUp'); // R1 → R0
    await page.waitForTimeout(150);
}

test('TC-V8 端密着ノード (はみ出さない) でも ensureNodeVisible がマージン分の隙間を作る', async ({ page }) => {
    await setup(page);
    await toMindmap(page, FIXTURE);

    // 初期 (translate=0) では R0 は画面右外へはみ出している。左へ 140px pan して実可視右端に密着させる。
    await panRightNodeToEdge(page, 140);

    // ★ 前提 assert (偽陽性防止・iteration 18 の反省): 発火前に R0 が
    //   「画面内 (nr.right <= vr.right = はみ出さない) かつ 端に密着 (余白 < marginX)」であることを確認。
    //   これを踏まないと iteration 18 と同じ「はみ出しケース」を検証してしまい是正を検証できない。
    const trBefore = await treeRect(page);
    const eBefore = await nodeEdges(page, 'R0');
    expect(eBefore).not.toBeNull();
    expect(eBefore!.hasHandle).toBe(true);                    // 子持ち → ハンドルあり
    const gapBefore = trBefore.visRight - eBefore!.foRight;   // fo 右端の余白 (実可視右端基準)
    expect(gapBefore).toBeGreaterThanOrEqual(0);              // はみ出していない (nr.right <= visRight)
    expect(gapBefore).toBeLessThan(MARGIN_X);                 // 端に密着 (余白 < marginX=32)
    // ハンドル込みでもはみ出していない (端密着であってはみ出しではないことを厳密化)。
    expect(eBefore!.handleRight).toBeLessThanOrEqual(trBefore.visRight);

    // --- R0 へ矢印移動 → ensureNodeVisible 発火 → ハンドル込み右端の隙間を測る ---
    await reachR0ViaArrow(page);
    expect(await focusedId(page)).toBe('R0'); // 意図した子持ちノードに到達

    const trAfter = await treeRect(page);
    const eAfter = await nodeEdges(page, 'R0');
    expect(eAfter).not.toBeNull();
    const gapAfter = Math.round(trAfter.visRight - eAfter!.handleRight); // 実可視右端基準

    // ★ 発火後、ノード右端 (ハンドル含む) と画面右端の隙間が marginX(32) 以上。
    //   端密着 (はみ出していない) でもパンして隙間ができる = トリガー是正の核心。
    expect(gapAfter).toBeGreaterThanOrEqual(MARGIN_X);
});

test('TC-V8 load-bearing: 旧 overflow トリガーに戻すと端密着で発動せず隙間 < 32 で red、margin で green', async ({ page }) => {
    await setup(page);
    await toMindmap(page, FIXTURE);

    // --- (a) 旧トリガー 'overflow' (はみ出し時のみ) → 端密着ノードで発動せず隙間据え置き (< 32) ---
    await page.evaluate(() => { (window as any).MindmapInteractions._setEnsureVisibleTrigger('overflow'); });
    await panRightNodeToEdge(page, 140);
    const trBeforeOld = await treeRect(page);
    const eBeforeOld = await nodeEdges(page, 'R0');
    // 前提: 端密着 (はみ出していない)。実可視右端基準。
    expect(trBeforeOld.visRight - eBeforeOld!.foRight).toBeGreaterThanOrEqual(0);
    expect(trBeforeOld.visRight - eBeforeOld!.foRight).toBeLessThan(MARGIN_X);

    await reachR0ViaArrow(page);
    expect(await focusedId(page)).toBe('R0');
    const trOld = await treeRect(page);
    const eOld = await nodeEdges(page, 'R0');
    const gapOld = Math.round(trOld.visRight - eOld!.handleRight); // 実可視右端基準
    // 旧トリガーははみ出していないので発動しない → 隙間据え置き (< 32)。「>= 32」判定なら red の領域。
    expect(gapOld).toBeLessThan(MARGIN_X);

    // --- (b) 既定トリガー 'margin' に戻す → 端密着でも発動して隙間 >= 32 (green) ---
    await page.evaluate(() => { (window as any).MindmapInteractions._setEnsureVisibleTrigger('margin'); });
    await toMindmap(page, FIXTURE);
    await panRightNodeToEdge(page, 140);
    await reachR0ViaArrow(page);
    expect(await focusedId(page)).toBe('R0');
    const trFix = await treeRect(page);
    const eFix = await nodeEdges(page, 'R0');
    const gapFix = Math.round(trFix.visRight - eFix!.handleRight); // 実可視右端基準
    expect(gapFix).toBeGreaterThanOrEqual(MARGIN_X);

    // ★ 修正が実際に隙間を広げている (旧 < 修正)。これで TC-V8 の「>= 32」判定が偽陽性でない。
    expect(gapFix).toBeGreaterThan(gapOld);
});

test('TC-V9 十分内側のノードは発動しない (過剰パン防止・viewport 不変)', async ({ page }) => {
    await setup(page);
    // 画面中央付近に余裕を持って収まる小さいツリー。子 a, b は左端 ~309・右端 ~389 で
    // 全方向にマージン以上の余裕がある (tree: 29〜1309)。
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

    // 前提: a, b が全方向にマージン以上の余裕を持って画面内にある。
    const tr = await treeRect(page);
    for (const id of ['a', 'b']) {
        const e = await nodeEdges(page, id);
        expect(e).not.toBeNull();
        expect(e!.foLeft - tr.left).toBeGreaterThan(MARGIN_X);   // 左に余裕
        expect(tr.right - e!.foRight).toBeGreaterThan(MARGIN_X); // 右に余裕
    }

    const v0 = await getViewport(page);

    // a を実クリックで選択 → ArrowDown で b へ移動 (b は十分内側)
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
    expect(await focusedId(page)).toBe('b');

    const v1 = await getViewport(page);

    // ★ 移動先がマージン込みで完全に収まっているので viewport translate は不変 (過剰パンしない)。
    expect(Math.abs(v1.translateX - v0.translateX)).toBeLessThanOrEqual(1);
    expect(Math.abs(v1.translateY - v0.translateY)).toBeLessThanOrEqual(1);
});
