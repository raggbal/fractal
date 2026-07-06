/**
 * Mindmap iteration 18 — ensureNodeVisible の追従マージンを左右対称にする (Wave 24 / FR-021-J2, TASK-52)
 *
 * バグ (Image #18/#19): iteration 17 で追従は 1 ノード分で動くようになったが、right 側に広がる
 *   子持ちノードで Tab/矢印移動すると追従先が画面端ギリギリで余裕がない。left 側は余白があって
 *   見やすい。→ 左右非対称。
 * 根本原因 (実測): ensureNodeVisible の margin=16px。折りたたみハンドル `−`
 *   (.mindmap-collapse-handle = position:absolute; right:-9px; width:16px) が box 右端を ~9px
 *   右に張り出すが、fo.getBoundingClientRect() は absolute 子を含まないため nr.right に反映されず、
 *   right 側の子持ちノードで実効マージンが 16−9=7px に減る。left 側はハンドルが内側 (中心向き) なので
 *   画面端 (外側) マージンを食わない。
 * 修正 (TASK-52): 横方向 margin を 16 → 32 に拡大 (左右共通)。右はみ出し補正のみ、対象ノードに
 *   .mindmap-collapse-handle があれば handlePad=12 を上乗せ (dx = -((nr.right−vr.right)+marginX+handlePad))。
 *   縦方向 margin は 16 のまま据え置き: ユーザー報告バグ (#18/#19) は横方向のみであり、縦を 32 に
 *   上げると iteration 17 の TC-V6 (ArrowDown 連打で選択ノードが下へ march = 中央寄せしない invariant)
 *   の許容 (-2px) を超えて既存 green を壊すため。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   page.locator(...).click() (実選択) → page.keyboard.press(...) (実キー) の実フロー。
 *   screen 位置は getBoundingClientRect。ハンドル張り出しは .mindmap-collapse-handle の rect で測る。
 *
 * ★ TASK-59 (test_update): iteration 23 で open-centering が縦のみ → 縦横とも full center に変わり、
 *   title マップの初期 translateX が非 0 になった。従来この spec は「translate=0 の既定フレーム」で
 *   right 側が自然に画面右外・left 側は固定 700px pan で左外、を前提にしていたが、full center で初期
 *   フレームがずれるとその前提が崩れる。→ pan 起点を「対象ノードの getBoundingClientRect を実測して
 *   から」の相対 pan に変える (panNodeOffRight = R0a を実可視右端の外へ / panNodeOffLeft = L0 を実可視
 *   左端の外へ、いずれも現在位置を測って相対 pan)。TC の意図 (右追従の余白が左と対称) と閾値 (20/16)
 *   は不変。pan の起点を実測相対にするだけ。
 *
 * ジオメトリ: title 中心 + balanced。対象ノードへ矢印移動すると ensureNodeVisible が発火して最小パンで
 *   可視化する。補正後:
 *   - right 側 R0a (ハンドルあり): fo 右端が実可視右端から margin+handlePad=44px 内側 → ハンドル
 *     (9px 張り出し) 込みの右端も余白 (>= 20)。旧値 (16,0) だと 7px でギリギリ (< 20)。
 *   - left 側 L0 (ハンドルあり): 左端が実可視左端から margin=32px 内側。
 *   → 左右の余白が対称 (|差| <= 16)。
 *
 * load-bearing: MindmapInteractions._setEnsureVisibleParams(16,0) で旧挙動に戻すと、同じ操作で
 *   右側のハンドル込み余白が 20px 未満 (実測 7px) になり red。既定 (32,12) で >= 20 になり green。
 *   (mindmap-render.js の _setStabilizeEnabled と同方針のテストフック。本番は既定値を使う。)
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
// R0/L0 は子を持つ (= 折りたたみハンドルが付く) 深いチェーンにして横に広げる。
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

// treeEl 可視 rect。
// TASK-54 で ensureNodeVisible の可視端が treeEl 矩形そのものでなく「実ウィンドウとの交差」に
// 変わった (standalone でも .outliner-tree の right=1309 は window.innerWidth=1280 を 29px はみ出す)。
// TC の余白測定は「実際に見えている端」= visRight/visLeft を基準にする (TASK-55, 測定基準のみ是正)。
//   visRight = Math.min(tree.right, window.innerWidth), visLeft = Math.max(tree.left, 0)
function treeRect(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        const winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : r.right;
        return {
            left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width,
            visRight: Math.min(r.right, winW),  // 実可視右端
            visLeft: Math.max(r.left, 0),       // 実可視左端
        };
    });
}

// 対象ノードの rect (ハンドルありなら handle 込みの右端 / 左端は fo 左端)。
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

// viewport を原点にリセット (module viewport は page 内で永続するため、独立性確保用)。
async function resetViewport(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        (window as any).MindmapRender.updateViewport({ scale: 1, translateX: 0, translateY: 0 });
    });
    await page.waitForTimeout(60);
}

// ★ TASK-59 test_update: 対象ノードを実可視右端の外へ相対 pan する (現在位置を実測して pan 量を決める。
//   full center で初期 translateX が非 0 でも確実に画面右外へ追いやれる)。fo 右端を visRight + OFF に置く。
const OFF = 60;
async function panNodeOffRight(page: import('@playwright/test').Page, id: string) {
    await page.evaluate((args) => {
        const { nid, off } = args as { nid: string; off: number };
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as any;
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const tr = t.getBoundingClientRect();
        const winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : tr.right;
        const visRight = Math.min(tr.right, winW);
        const r = fo.getBoundingClientRect();
        const dx = (visRight + off) - r.right; // fo 右端を実可視右端の off px 外へ
        const MR = (window as any).MindmapRender;
        const vp = MR.getViewport();
        vp.translateX = vp.translateX + dx;
        MR.updateViewport(vp);
    }, { nid: id, off: OFF });
    await page.waitForTimeout(80);
}
// 対象ノードを実可視左端の外へ相対 pan する (現在位置を実測)。fo 左端を visLeft - OFF に置く。
async function panNodeOffLeft(page: import('@playwright/test').Page, id: string) {
    await page.evaluate((args) => {
        const { nid, off } = args as { nid: string; off: number };
        const fo = document.querySelector(`.mindmap-node[data-node-id="${nid}"]`) as any;
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const tr = t.getBoundingClientRect();
        const visLeft = Math.max(tr.left, 0);
        const r = fo.getBoundingClientRect();
        const dx = (visLeft - off) - r.left; // fo 左端を実可視左端の off px 外へ
        const MR = (window as any).MindmapRender;
        const vp = MR.getViewport();
        vp.translateX = vp.translateX + dx;
        MR.updateViewport(vp);
    }, { nid: id, off: OFF });
    await page.waitForTimeout(80);
}

/**
 * right 側の子持ちノード R0a を実可視右端の外へ pan してから R1 → R0a へ矢印移動して
 * ensureNodeVisible を発火させ、補正後のハンドル込み右端と実可視右端の余白 (rightGap) を返す。
 */
async function reachRightHandleNode(page: import('@playwright/test').Page) {
    await panNodeOffRight(page, 'R0a'); // R0a を画面右外へ (full center 対応の実測相対 pan)
    await page.locator('.mindmap-node[data-node-id="R1"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('ArrowRight'); // R1 → R0a (右側の深いノード = 画面外だった)
    await page.waitForTimeout(150);
    const fid = await focusedId(page);
    const tr = await treeRect(page);
    const e = await nodeEdges(page, 'R0a');
    // 実可視右端 (min(tree.right, innerWidth)) を基準に余白を測る (TASK-55)。
    return { fid, hasHandle: !!(e && e.hasHandle), rightGap: e ? Math.round(tr.visRight - e.handleRight) : null };
}

test('TC-V7 右側子持ちノードの追従余白がギリギリでなく左と対称', async ({ page }) => {
    await setup(page);
    await toMindmap(page, FIXTURE);

    // R0a を実可視右端の外へ pan して「画面外」状態を作る (full center で初期 translateX が非 0 でも
    // 確実に外へ出す実測相対 pan, TASK-59 test_update)。
    await panNodeOffRight(page, 'R0a');
    // 前提: R0a が子持ち (ハンドルあり) で、pan 後にハンドル込み右端が実可視右端の外にあること。
    const tr0 = await treeRect(page);
    const e0 = await nodeEdges(page, 'R0a');
    expect(e0).not.toBeNull();
    expect(e0!.hasHandle).toBe(true);                  // 子持ち → ハンドルあり
    expect(e0!.handleRight > tr0.visRight).toBe(true); // ハンドル込み右端が実可視右端の外

    // --- 右側: R0a へ矢印移動 → ensureNodeVisible 発火 → ハンドル込み右端の余白を測る ---
    // (reachRightHandleNode が冒頭で改めて panNodeOffRight するので初期状態から独立)
    const right = await reachRightHandleNode(page);
    expect(right.fid).toBe('R0a');       // 意図した子持ちノードに到達
    expect(right.hasHandle).toBe(true);
    // ★ ハンドル含む右端と画面右端の余白がギリギリでない (>= 20px)。
    expect(right.rightGap).not.toBeNull();
    expect(right.rightGap!).toBeGreaterThanOrEqual(20);

    // --- 左側: L0 を画面左外へ pan → 矢印移動 → 左端の余白を測る ---
    // L0 の現在位置を実測してから実可視左端の外へ相対 pan する (TASK-59 test_update: full center で
    // 初期 translateX が非 0 でも確実に L0 を左外へ出す)。R1 を選択してから L0 を pan で外へ。
    await page.locator('.mindmap-node[data-node-id="R1"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await panNodeOffLeft(page, 'L0'); // L0 を実可視左端の外へ (現在位置を実測して相対 pan)

    // L0 が画面左外にあることを前提確認。
    const trPan = await treeRect(page);
    const eL0pan = await nodeEdges(page, 'L0');
    expect(eL0pan).not.toBeNull();
    expect(eL0pan!.foLeft < trPan.visLeft).toBe(true); // 実可視左端の外

    // R1 → __title__ → L0 の順に ArrowLeft 2 回で子持ちノード L0 に到達 (ensureNodeVisible 発火)。
    await page.keyboard.press('ArrowLeft'); // → __title__
    await page.waitForTimeout(90);
    await page.keyboard.press('ArrowLeft'); // → L0 (左側の子持ちノード = 画面外だった)
    await page.waitForTimeout(150);

    const fidL = await focusedId(page);
    expect(fidL).toBe('L0');
    const trL = await treeRect(page);
    const eL0 = await nodeEdges(page, 'L0');
    expect(eL0).not.toBeNull();
    expect(eL0!.hasHandle).toBe(true);
    // 左側ノードの左端 (内側=右にハンドルがあるので外側=左端は fo 左端で測る) と実可視左端の余白。
    const leftGap = Math.round(eL0!.foLeft - trL.visLeft);

    // ★ 左端の余白もギリギリでない (>= 20px)。
    expect(leftGap).toBeGreaterThanOrEqual(20);

    // ★ 左右の余白がほぼ対称 (差が小さい)。右はハンドル込みで測っているので、両者が近い =
    //   ハンドル張り出しを加味した右補正で left と揃ったことの証左。
    expect(Math.abs(right.rightGap! - leftGap)).toBeLessThanOrEqual(16);
});

test('TC-V7 load-bearing: 旧マージン (16,0) に戻すと右側がギリギリ (< 20) で red、既定 (32,12) で green', async ({ page }) => {
    await setup(page);
    await toMindmap(page, FIXTURE);

    // --- (a) 旧挙動 (margin=16, handlePad=0) を再現 → 右側のハンドル込み余白が 20px 未満 ---
    await resetViewport(page);
    await page.evaluate(() => { (window as any).MindmapInteractions._setEnsureVisibleParams(16, 0); });
    const oldGap = await reachRightHandleNode(page);
    expect(oldGap.fid).toBe('R0a');
    expect(oldGap.rightGap).not.toBeNull();
    // 旧挙動: 実効右余白 = 16 − ハンドル張り出し 9 ≈ 7px。「>= 20」判定なら red になる領域。
    expect(oldGap.rightGap!).toBeLessThan(20);

    // --- (b) 既定 (margin=32, handlePad=12) に戻す → 右側の余白が >= 20px (green) ---
    await page.evaluate(() => { (window as any).MindmapInteractions._setEnsureVisibleParams(32, 12); });
    await resetViewport(page);
    await toMindmap(page, FIXTURE);
    await resetViewport(page);
    const fixGap = await reachRightHandleNode(page);
    expect(fixGap.fid).toBe('R0a');
    expect(fixGap.rightGap).not.toBeNull();
    expect(fixGap.rightGap!).toBeGreaterThanOrEqual(20);

    // ★ 修正が余白を実際に広げている (旧 < 修正)。これで TC-V7 の「>= 20」判定が偽陽性でない。
    expect(fixGap.rightGap!).toBeGreaterThan(oldGap.rightGap!);
});
