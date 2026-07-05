/**
 * Mindmap iteration 10 — ツールバー/ミニマップを可視領域に固定 (Wave 14 / TASK-39)
 * TC-T1: 縦に大きい mindmap でも .mindmap-toolbar は tree の上部内側、.mindmap-minimap は
 *        tree の右下内側に留まり、pan (viewport transform) しても画面座標が変わらない。
 *        外側スクロールコンテナ (.outliner-scroll-content) が mindmap モードでは縦スクロール
 *        しない (overflow:hidden)。
 *
 * 根本原因: toolbar/minimap は treeEl (.outliner-tree) の absolute 子。tree の親
 * .outliner-scroll-content が overflow-y:auto のため、mindmap が縦に大きいと tree が
 * ビューポートを超え、toolbar/minimap が tree の top/bottom に貼り付いてスクロールで流れる。
 * 修正: mindmap モード時に scroll-content を overflow:hidden にして tree を固定枠化する
 * (mindmap.css の :has() セレクタ)。
 *
 * ★ load-bearing 上の注意 (generator/designer_failures: standalone が本番 DOM と不一致):
 *   本番 (outlinerWebviewContent.ts / notesWebviewContent.ts) は
 *   .outliner-container > .outliner-scroll-content{overflow-y:auto} > .outliner-tree の 3 段。
 *   一方 standalone E2E HTML は .outliner-container{overflow:hidden} > .outliner-tree の 2 段で
 *   スクロールする .outliner-scroll-content が無い = 本番のバグ (scroll-content が流れる) を
 *   そのままでは再現できない (fix なしでも緑 = 偽陽性)。
 *   → 本テストは init 後に tree を .outliner-scroll-content{overflow-y:auto} ラッパで包み、
 *     本番と同じ「スクロールする親」構造を再構成してから mindmap を描画する。これにより
 *     mindmap.css の :has() fix が効かなければ scroll-content が縦スクロールし toolbar が上へ
 *     流れる (= 修正を外すと fail) ことを担保する。
 *
 * テスト方針: 実 DOM の getBoundingClientRect で位置を測る。
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

// 縦に大きくなる構成: root r に子 20 個、各子にさらに子 1 個 (SVG が ~1500px 縦に伸びる)。
function tallModel() {
    const nodes: Record<string, any> = { r: node('r', 'Root', []) };
    const childIds: string[] = [];
    for (let i = 0; i < 20; i++) {
        const cid = 'c' + i;
        const gid = 'g' + i;
        childIds.push(cid);
        nodes[cid] = node(cid, 'Child ' + i + ' with a fairly long label', [gid], 'r');
        nodes[gid] = node(gid, 'Grandchild ' + i, [], cid);
    }
    nodes.r.children = childIds;
    return { version: 1, viewMode: 'mindmap', rootIds: ['r'], nodes };
}

/**
 * standalone の 2 段構造 (.outliner-container > .outliner-tree) を本番同等の 3 段
 * (.outliner-container > .outliner-scroll-content{overflow-y:auto} > .outliner-tree) に
 * 再構成する。tree ノードを移動しても outliner.js がキャッシュした treeEl 参照は有効。
 */
async function reproduceProdScrollStructure(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree');
        const container = document.querySelector('.outliner-container');
        if (!tree || !container) { return; }
        if (document.querySelector('.outliner-scroll-content')) { return; }
        // 本番の outliner.css:393 と同等の宣言を「スタイルシート経由」で注入する。
        // inline style だと specificity で mindmap.css の :has() fix を潰してしまい
        // load-bearing にならないため、必ず stylesheet ルールで overflow-y:auto を与える。
        const st = document.createElement('style');
        st.setAttribute('data-test', 'repro-scroll-content');
        st.textContent =
            '.outliner-scroll-content{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}';
        document.head.appendChild(st);
        // 本番と同じスクロール親を作り tree を中へ移動 (参照は維持される)
        const sc = document.createElement('div');
        sc.className = 'outliner-scroll-content';
        tree.parentNode!.insertBefore(sc, tree);
        sc.appendChild(tree);
    });
}

async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await reproduceProdScrollStructure(page);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(200);
}

function rects(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const q = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) { return null; }
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
        };
        return {
            tree: q('.outliner-tree[data-view-mode="mindmap"]'),
            toolbar: q('.mindmap-toolbar'),
            minimap: q('.mindmap-minimap'),
        };
    });
}

test('TC-T1 toolbar/minimap は可視領域 (tree) に固定され pan で動かない、外側は非スクロール', async ({ page }) => {
    await setup(page);
    await toMindmap(page, tallModel());

    // 本番同等の scroll-content が再構成されていること (前提の担保)
    const hasSC = await page.evaluate(() => !!document.querySelector('.outliner-scroll-content'));
    expect(hasSC).toBe(true);

    // --- 描画直後: toolbar は tree の上部内側、minimap は右下内側 ---
    const r0 = await rects(page);
    expect(r0.tree).not.toBeNull();
    expect(r0.toolbar).not.toBeNull();
    expect(r0.minimap).not.toBeNull();

    // toolbar は tree の上部内側 (left:12/top:12 の absolute)。
    // fix が無いと scroll が発生し toolbar が上へ流れて tree.top より上に出る/画面外に隠れる。
    expect(r0.toolbar!.top).toBeGreaterThanOrEqual(r0.tree!.top - 2);
    expect(r0.toolbar!.top).toBeLessThanOrEqual(r0.tree!.top + 60);

    // minimap は tree の右下内側 (right:12/bottom:12 の absolute)
    expect(r0.minimap!.bottom).toBeLessThanOrEqual(r0.tree!.bottom + 2);
    expect(r0.minimap!.right).toBeLessThanOrEqual(r0.tree!.right + 2);

    // --- 外側 scroll-content が mindmap モードで縦スクロールしない (:has() fix の効果) ---
    const scroll = await page.evaluate(() => {
        const sc = document.querySelector('.outliner-scroll-content') as HTMLElement | null;
        if (!sc) { return null; }
        const cs = getComputedStyle(sc);
        return {
            overflowY: cs.overflowY,
            scrolls: sc.scrollHeight > sc.clientHeight + 2,
        };
    });
    expect(scroll).not.toBeNull();
    // mindmap モードでは :has() セレクタで overflow:hidden になり縦スクロールしない
    // (mindmap は .mindmap-viewport の transform で pan する)。
    expect(scroll!.overflowY).toBe('hidden');
    expect(scroll!.scrolls).toBe(false);

    // --- ユーザー報告の症状直接再現: スクロールを試みても toolbar が上へ流れて消えない ---
    // fix が無いと scroll-content が overflow-y:auto でスクロールでき、scrollTop>0 で
    // toolbar が tree の上端より上 (画面外) へ流れる。fix があれば scrollTop は 0 のまま。
    const afterScroll = await page.evaluate(() => {
        const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
        sc.scrollTop = 400;
        const applied = sc.scrollTop;
        const tb = document.querySelector('.mindmap-toolbar')!.getBoundingClientRect();
        const tr = document.querySelector('.outliner-tree[data-view-mode="mindmap"]')!.getBoundingClientRect();
        return { scrollTop: applied, toolbarTop: Math.round(tb.top), treeTop: Math.round(tr.top) };
    });
    // overflow:hidden なので scrollTop は 0 のまま (スクロールできない)
    expect(afterScroll.scrollTop).toBe(0);
    // toolbar は tree 上端付近に留まる (上へ流れて消えていない)
    expect(afterScroll.toolbarTop).toBeGreaterThanOrEqual(afterScroll.treeTop - 2);
    expect(afterScroll.toolbarTop).toBeLessThanOrEqual(afterScroll.treeTop + 60);

    // --- pan 後も toolbar/minimap の画面座標が不変 (viewport transform は .mindmap-viewport のみ) ---
    await page.evaluate(() => {
        (window as any).MindmapRender.updateViewport({ scale: 1, translateX: -300, translateY: -300 });
    });
    await page.waitForTimeout(120);
    const r1 = await rects(page);

    expect(Math.abs(r1.toolbar!.top - r0.toolbar!.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(r1.toolbar!.left - r0.toolbar!.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(r1.minimap!.bottom - r0.minimap!.bottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(r1.minimap!.right - r0.minimap!.right)).toBeLessThanOrEqual(2);
});
