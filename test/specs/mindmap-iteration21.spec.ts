/**
 * Mindmap iteration 21 — ensureNodeVisible の可視端を実ウィンドウと交差させる
 *   (Wave 26 / FR-021-J2, TASK-54)
 *
 * バグ (right-Tab 隙間・実機 0.208.32 ログで真因確定): `ensureNodeVisible` は可視右端の基準に
 *   `_treeEl.getBoundingClientRect().right` を使うが、実機で `.outliner-tree` の right(=716) が
 *   window.innerWidth(=687) より 29px 外側にオーバーフローしていた (祖先 scroll-content 以上は
 *   R687 で clip)。→ treeEl 基準で marginX=32 を確保しても、実際に見えている右端 (winW=687) との
 *   隙間は 3px でくっついて見えた。左/上/下はズレが無いので正常だったため right-Tab だけ露呈。
 * 修正 (TASK-54): 可視領域を treeEl 矩形そのままでなく **実ウィンドウと交差させた矩形** にする:
 *   visRight = Math.min(vr.right, window.innerWidth) 等。tree が実ウィンドウより外にはみ出していても
 *   実可視端 (winW) から marginX(32) の余白を確保する。window が取れない環境は vr フォールバック。
 *   iteration 16/17 (中央寄せしない・preventScroll・フレーム安定化) / 18 (margin 値) / 19 (トリガー)
 *   は不変。可視端の取り方だけ厳密化。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   page.locator(...).click() (実選択) → page.keyboard.press(...) (実キー) の実フロー。
 *   screen 位置は getBoundingClientRect。ハンドル張り出しは .mindmap-collapse-handle の rect で測る。
 *
 * ★ standalone で「tree.right > window.innerWidth」を人工的に作る (generator_failures 2026-07-03
 *   「standalone DOM が本番と不一致で偽陽性」への対処):
 *   standalone は innerWidth=1280 で `.outliner-tree` の CSS width=1280px + left=29 → right=1309 と
 *   既に 29px 外へはみ出しているが、余白が微妙なので `.outliner-tree` の width を 1700px に拡張して
 *   tree.right≈1729 (>> innerWidth=1280) にして「tree が実ウィンドウより大きくはみ出す」実機状況を
 *   はっきり再現する。設定後に前提 assert で treeRect.right > window.innerWidth を確認する。
 *
 * ジオメトリ (standalone で実測, tree.width=1700 + viewport translateX=-150):
 *   R0 (子持ち = ハンドルあり) の handleRight≈1263。gapToWin = 1280-1263 = 17 (< marginX=32 = バグ)、
 *   gapToTree = 1729-1263 = 466 (>> 32 = tree 基準では余白十分に見える)。
 *   → 修正なし (可視端=vr.right): margin トリガーは gapToTree=466 で発動せず gapToWin=17 のまま (red)。
 *   → 修正あり (可視端=min(vr.right, innerWidth)=1280): gapToWin=17<32 で発動 → 左へパン →
 *      gapToWin≈35 (>= 32, green)。
 *
 * load-bearing: MindmapInteractions._setEnsureVisibleClampToWindow(false) で可視端を vr.right に
 *   戻すと、tree はみ出し状況で gapToWin が marginX 未満 (17) のまま red。既定 (true, 実ウィンドウ交差)
 *   で gapToWin >= 32 になり green。
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

// title 中心 + balanced。R0 は子を持つ (= 折りたたみハンドルあり) チェーンにして横に広げる。
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

// `.outliner-tree` を実ウィンドウより大きく広げて tree.right >> window.innerWidth を作る
// (実機の tree R716 > winW687 の 29px オーバーフローをはっきり再現)。
async function forceTreeOverflowWindow(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        t.style.width = '1700px';
        t.style.minWidth = '1700px';
    });
    await page.waitForTimeout(60);
}

// treeEl (.outliner-tree) 可視 rect + window。
function frame(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        return { treeRight: r.right, treeLeft: r.left, innerWidth: window.innerWidth };
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
            foRight: r.right,
            hasHandle: !!h,
            handleRight: hr ? hr.right : r.right, // ハンドル込みの実描画右端
        };
    }, id);
}

function focusedId(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const b = document.querySelector('.mindmap-node-box.is-focused');
        const fo = b ? b.closest('.mindmap-node') : null;
        return fo ? fo.getAttribute('data-node-id') : null;
    });
}

// viewport を絶対値で pan する (getViewport が返す live オブジェクトを in-place 変更)。
async function setPanX(page: import('@playwright/test').Page, tx: number) {
    await page.evaluate((v) => {
        const MR = (window as any).MindmapRender;
        const vp = MR.getViewport();
        vp.translateX = v;
        MR.updateViewport(vp);
    }, tx);
    await page.waitForTimeout(80);
}

// R1 (R0 の下の兄弟) を click → ArrowUp で R0 へ移動 → ensureNodeVisible を R0 に発火。
async function reachR0ViaArrow(page: import('@playwright/test').Page) {
    await page.locator('.mindmap-node[data-node-id="R1"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('ArrowUp'); // R1 → R0
    await page.waitForTimeout(150);
}

test('TC-V10 tree が実ウィンドウより外にはみ出していても実ウィンドウ端から余白を確保する', async ({ page }) => {
    await setup(page);
    await toMindmap(page, FIXTURE);

    // tree を実ウィンドウより大きく広げ、viewport を pan して R0 を「実ウィンドウ右端に密着だが
    //   tree 矩形の内側 (tree 基準では余白十分)」の状態にする。
    await forceTreeOverflowWindow(page);
    await setPanX(page, -150);

    // ★ 前提 assert (真因の再現・偽陽性防止): tree.right が window.innerWidth より外側にはみ出す。
    const fr = await frame(page);
    expect(fr.treeRight).toBeGreaterThan(fr.innerWidth); // 実機の「tree R716 > winW687」を模す

    // ★ 前提 assert: 発火前、R0 は
    //   (a) 実ウィンドウ右端に密着 (gapToWin < marginX = バグ) かつ
    //   (b) tree 矩形の内側で余白十分 (gapToTree >= marginX = tree 基準では発動しない)
    //   の状態にある。これを踏まないと「tree 基準で余白があるのに実可視端では潰れている」真因を突けない。
    const eBefore = await nodeEdges(page, 'R0');
    expect(eBefore).not.toBeNull();
    expect(eBefore!.hasHandle).toBe(true); // 子持ち → ハンドルあり
    const gapWinBefore = fr.innerWidth - eBefore!.handleRight;
    const gapTreeBefore = fr.treeRight - eBefore!.handleRight;
    expect(gapWinBefore).toBeGreaterThanOrEqual(0);  // はみ出してはいない (画面内)
    expect(gapWinBefore).toBeLessThan(MARGIN_X);      // 実ウィンドウ端に密着 (< marginX = バグ再現)
    expect(gapTreeBefore).toBeGreaterThanOrEqual(MARGIN_X); // tree 基準では余白十分 (tree 基準では不発動)

    // --- R0 へ矢印移動 → ensureNodeVisible 発火 ---
    await reachR0ViaArrow(page);
    expect(await focusedId(page)).toBe('R0');

    // ★ 発火後、ノード右端 (ハンドル含む) と window.innerWidth の隙間が marginX(32) 以上。
    //   treeEl.right でなく **実ウィンドウ** 基準で余白ができる = 修正の核心。
    const frAfter = await frame(page);
    const eAfter = await nodeEdges(page, 'R0');
    expect(eAfter).not.toBeNull();
    const gapWinAfter = Math.round(frAfter.innerWidth - eAfter!.handleRight);
    expect(gapWinAfter).toBeGreaterThanOrEqual(MARGIN_X);
});

test('TC-V10 load-bearing: 可視端を vr.right に戻すと gapToWin < 32 で red、実ウィンドウ交差で green', async ({ page }) => {
    await setup(page);
    await toMindmap(page, FIXTURE);

    // --- (a) 可視端を treeEl 矩形のまま (window 交差なし = 旧挙動) にする ---
    await page.evaluate(() => { (window as any).MindmapInteractions._setEnsureVisibleClampToWindow(false); });
    await forceTreeOverflowWindow(page);
    await setPanX(page, -150);

    const frOld = await frame(page);
    expect(frOld.treeRight).toBeGreaterThan(frOld.innerWidth); // 前提: tree が window より外
    const eBeforeOld = await nodeEdges(page, 'R0');
    // 前提: 実ウィンドウ端に密着 (< marginX) だが tree 内側では余白十分。
    expect(frOld.innerWidth - eBeforeOld!.handleRight).toBeGreaterThanOrEqual(0);
    expect(frOld.innerWidth - eBeforeOld!.handleRight).toBeLessThan(MARGIN_X);
    expect(frOld.treeRight - eBeforeOld!.handleRight).toBeGreaterThanOrEqual(MARGIN_X);

    await reachR0ViaArrow(page);
    expect(await focusedId(page)).toBe('R0');
    const frOldAfter = await frame(page);
    const eOld = await nodeEdges(page, 'R0');
    const gapWinOld = Math.round(frOldAfter.innerWidth - eOld!.handleRight);
    // window 交差なしでは tree 基準 (gapToTree 十分) で発動せず → 実ウィンドウとの隙間据え置き (< 32)。
    // 「gapToWin >= 32」判定なら red の領域。
    expect(gapWinOld).toBeLessThan(MARGIN_X);

    // --- (b) 既定 (window 交差あり) に戻す → 実ウィンドウ端から隙間 >= 32 (green) ---
    await page.evaluate(() => { (window as any).MindmapInteractions._setEnsureVisibleClampToWindow(true); });
    await toMindmap(page, FIXTURE);
    await forceTreeOverflowWindow(page);
    await setPanX(page, -150);
    await reachR0ViaArrow(page);
    expect(await focusedId(page)).toBe('R0');
    const frFix = await frame(page);
    const eFix = await nodeEdges(page, 'R0');
    const gapWinFix = Math.round(frFix.innerWidth - eFix!.handleRight);
    expect(gapWinFix).toBeGreaterThanOrEqual(MARGIN_X);

    // ★ 修正が実際に実ウィンドウとの隙間を広げている (旧 < 修正)。TC-V10 の「>= 32」判定が偽陽性でない。
    expect(gapWinFix).toBeGreaterThan(gapWinOld);
});
