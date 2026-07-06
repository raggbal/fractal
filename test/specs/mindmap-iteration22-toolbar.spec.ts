/**
 * Mindmap iteration 22 — toolbar / minimap を rerender・スクロール・小さい窓をまたいで固定
 * (Wave 27 / TASK-58, TC-M6)。
 *
 * 症状 (ユーザー実機 #1): mindmap の toolbar が消える / 全体マップ(minimap)が上にずれる。
 *
 * 根本原因 (本 TASK で 3 段 DOM 実測特定):
 *   .mindmap-toolbar(absolute; top:12) / .mindmap-minimap(absolute; bottom:12) は treeEl
 *   (.outliner-tree[mindmap] = position:relative; overflow:hidden) の absolute 子として毎 render
 *   appendChild される。treeEl は min-height:400px を持つため、可視領域 (flex 親
 *   .outliner-scroll-content) が 400px 未満の窓では treeEl が可視領域より高くなり (h=400 > 可視 h)、
 *   minimap(bottom:12) が可視枠の外 (下) にアンカーされ overflow:hidden でクリップ = ミニマップが
 *   消える/ずれる。実測: 可視 250px の窓で treeEl.h=400 → minimap.bottom=441 > 可視 bottom 250
 *   (191px 下に隠れる)。scroll ancestor が縦スクロールする場合は treeEl 全体が上へ流れ toolbar が
 *   画面上に消える。
 *
 * 修正 (mindmap-render.js + mindmap.css):
 *   toolbar/minimap を treeEl 直下でなく .mindmap-chrome overlay に入れ、render.js の
 *   positionChrome() が overlay を「実際に見えている可視クリップ矩形 (treeEl ∩ overflow 祖先 ∩
 *   window)」に配置する。これで treeEl の高さ (min-height:400 のまま = TC-V6 等の scroll テストを
 *   壊さない) やスクロールに関係なく、toolbar は可視枠左上・minimap は可視枠右下に固定される。
 *   scroll/resize でも positionChrome を再実行して追従、destroy でハンドラ解除。
 *
 * ★ load-bearing / 偽陽性対策 (generator/designer_failures: standalone が本番 DOM と不一致):
 *   本番 (outlinerWebviewContent.ts / notesWebviewContent.ts) は 3 段
 *   (.outliner-container > .outliner-scroll-content{overflow-y:auto} > .outliner-tree)。
 *   standalone E2E は 2 段。→ 3 段を再構成し、可視領域を mindmap min-height (400px) より小さく
 *   制約してバグを genuinely 再現する。overflow スタイルは <style> タグ (stylesheet) 経由で与える
 *   (inline は specificity で mindmap.css の :has() を潰し load-bearing にならない)。
 *   load-bearing: chrome overlay を外して toolbar/minimap を treeEl 直下の絶対子に戻す (= 旧実装)
 *   と、小さい窓で minimap が可視枠外に落ちて red。chrome overlay があると可視枠内で green。
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

// 縦に大きい構成: root r に子 n 個 (SVG が縦に伸びる)。
function tallModel(n = 24) {
    const nodes: Record<string, any> = { r: node('r', 'Root', []) };
    const childIds: string[] = [];
    for (let i = 0; i < n; i++) {
        const cid = 'c' + i;
        childIds.push(cid);
        nodes[cid] = node(cid, 'Child ' + i + ' with a fairly long label here', [], 'r');
    }
    nodes.r.children = childIds;
    return { version: 1, viewMode: 'mindmap', rootIds: ['r'], nodes };
}

/**
 * standalone の 2 段構造 (.outliner-container > .outliner-tree) を本番同等の 3 段
 * (.outliner-container > .outliner-scroll-content{overflow-y:auto} > .outliner-tree) に再構成。
 * @param containerHeight > 0 のとき .outliner-container の高さを制約する
 *        (mindmap tree の可視領域を小さくして「treeEl が可視領域より高い」バグを露呈させる用)。
 */
async function reproduceProdScrollStructure(page: import('@playwright/test').Page, containerHeight = 0) {
    await page.evaluate((h) => {
        const tree = document.querySelector('.outliner-tree');
        const container = document.querySelector('.outliner-container') as HTMLElement;
        if (!tree || !container) { return; }
        if (document.querySelector('.outliner-scroll-content')) { return; }
        // 本番 outliner.css:393 と同等の宣言を stylesheet 経由で注入 (inline は specificity で
        // mindmap.css の :has() overflow:hidden fix を潰すため NG)。
        const st = document.createElement('style');
        st.setAttribute('data-test', 'repro-scroll-content');
        st.textContent =
            '.outliner-scroll-content{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}';
        document.head.appendChild(st);
        const sc = document.createElement('div');
        sc.className = 'outliner-scroll-content';
        tree.parentNode!.insertBefore(sc, tree);
        sc.appendChild(tree);
        if (h > 0) { container.style.height = h + 'px'; }
    }, containerHeight);
}

async function toMindmap(page: import('@playwright/test').Page, data: any, containerHeight = 0) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await reproduceProdScrollStructure(page, containerHeight);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(200);
}

function rects(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const q = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) { return null; }
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) };
        };
        return {
            scrollContent: q('.outliner-scroll-content'),
            tree: q('.outliner-tree[data-view-mode="mindmap"]'),
            toolbar: q('.mindmap-toolbar'),
            minimap: q('.mindmap-minimap'),
            toolbarCount: document.querySelectorAll('.mindmap-toolbar').length,
            minimapCount: document.querySelectorAll('.mindmap-minimap').length,
            chromeCount: document.querySelectorAll('.mindmap-chrome').length,
        };
    });
}

test('TC-M6 toolbar/minimap は rerender・pan をまたいで可視枠に固定され消えない', async ({ page }) => {
    await setup(page);
    await toMindmap(page, tallModel(24));

    // 前提: 本番同等 3 段 DOM。
    const hasSC = await page.evaluate(() => !!document.querySelector('.outliner-scroll-content'));
    expect(hasSC).toBe(true);

    // --- (a) 初期描画: toolbar は可視枠左上、minimap は右下。1 個ずつ ---
    const r0 = await rects(page);
    expect(r0.tree).not.toBeNull();
    expect(r0.toolbar).not.toBeNull();
    expect(r0.minimap).not.toBeNull();
    expect(r0.toolbarCount).toBe(1);
    expect(r0.minimapCount).toBe(1);
    expect(r0.chromeCount).toBe(1);

    // toolbar は可視枠 (scroll-content) 左上内側
    expect(r0.toolbar!.top).toBeGreaterThanOrEqual(r0.scrollContent!.top - 2);
    expect(r0.toolbar!.top).toBeLessThanOrEqual(r0.scrollContent!.top + 60);
    expect(r0.toolbar!.left).toBeGreaterThanOrEqual(r0.scrollContent!.left - 2);
    // minimap は可視枠右下内側
    expect(r0.minimap!.bottom).toBeLessThanOrEqual(r0.scrollContent!.bottom + 2);
    expect(r0.minimap!.right).toBeLessThanOrEqual(r0.scrollContent!.right + 2);

    // --- (b) rerender (ノード追加で bounds/コンテンツ高さが変わる) → 画面座標が不変 ---
    await page.evaluate(() => {
        const model = (window as any).Outliner.getModel();
        for (let i = 24; i < 48; i++) {
            model.addNode('r', null, 'Extra child ' + i + ' with an even longer label to grow bounds');
        }
        (window as any).MindmapRender.render(
            model, model.mindmap,
            document.querySelector('.outliner-tree'),
            (window as any).outlinerHostBridge, {});
    });
    await page.waitForTimeout(150);

    const r1 = await rects(page);
    expect(r1.toolbarCount).toBe(1);
    expect(r1.minimapCount).toBe(1);
    expect(r1.chromeCount).toBe(1);
    expect(Math.abs(r1.toolbar!.top - r0.toolbar!.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(r1.toolbar!.left - r0.toolbar!.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(r1.minimap!.bottom - r0.minimap!.bottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(r1.minimap!.right - r0.minimap!.right)).toBeLessThanOrEqual(2);

    // --- (c) pan (viewport transform) 後も toolbar/minimap の画面座標が不変 ---
    await page.evaluate(() => {
        (window as any).MindmapRender.updateViewport({ scale: 1, translateX: -400, translateY: -400 });
    });
    await page.waitForTimeout(120);
    const r2 = await rects(page);
    expect(Math.abs(r2.toolbar!.top - r0.toolbar!.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(r2.minimap!.bottom - r0.minimap!.bottom)).toBeLessThanOrEqual(2);

    // 外側 scroll-content は mindmap モードで縦スクロールしない (:has() overflow:hidden, iteration 10)
    const scroll = await page.evaluate(() => {
        const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
        return { overflowY: getComputedStyle(sc).overflowY, scrolls: sc.scrollHeight > sc.clientHeight + 2 };
    });
    expect(scroll.overflowY).toBe('hidden');
    expect(scroll.scrolls).toBe(false);
});

test('TC-M6 (核心) 可視領域が min-height 未満の小さい窓でも minimap が可視枠内に留まる', async ({ page }) => {
    await setup(page);
    // 可視領域を 250px に制約 (mindmap の min-height:400px より小さい = バグ露呈条件)。
    await toMindmap(page, tallModel(24), 250);

    const r = await rects(page);
    expect(r.tree).not.toBeNull();
    expect(r.minimap).not.toBeNull();
    expect(r.scrollContent).not.toBeNull();

    // treeEl 自体は min-height:400 で可視領域より高いまま (TC-V6 の scroll テスト前提を壊さない)。
    expect(r.tree!.h).toBeGreaterThanOrEqual(390);

    // chrome overlay により、toolbar/minimap は可視枠 (scroll-content) 内に固定される。
    expect(r.toolbar!.top).toBeGreaterThanOrEqual(r.scrollContent!.top - 2);
    expect(r.toolbar!.top).toBeLessThanOrEqual(r.scrollContent!.bottom);
    // minimap (右下) が可視枠内 (旧実装なら treeEl.h=400 の底 = 可視 bottom 250 を大きく超えて隠れる)。
    expect(r.minimap!.bottom).toBeLessThanOrEqual(r.scrollContent!.bottom + 2);
    expect(r.minimap!.right).toBeLessThanOrEqual(r.scrollContent!.right + 2);

    // --- load-bearing 反証: chrome overlay を外して toolbar/minimap を treeEl 直下の絶対子に
    //     戻す (= 旧実装) と、treeEl(h=400) の bottom:12 にアンカーされて minimap が可視枠外に落ちる ---
    const counterfactual = await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree[data-view-mode="mindmap"]') as HTMLElement;
        const tb = document.querySelector('.mindmap-toolbar') as HTMLElement;
        const mm = document.querySelector('.mindmap-minimap') as HTMLElement;
        const chrome = document.querySelector('.mindmap-chrome') as HTMLElement;
        // 旧実装再現: chrome を潰して toolbar/minimap を treeEl 直下へ (絶対配置は treeEl 基準に戻る)。
        tree.appendChild(tb);
        tree.appendChild(mm);
        if (chrome && chrome.parentNode) { chrome.parentNode.removeChild(chrome); }
        const sc = document.querySelector('.outliner-scroll-content')!.getBoundingClientRect();
        const mr = mm.getBoundingClientRect();
        return {
            treeH: Math.round(tree.getBoundingClientRect().height),
            scBottom: Math.round(sc.bottom),
            mmBottom: Math.round(mr.bottom),
            mmBelowVisible: mr.bottom > sc.bottom + 2,
        };
    });
    // 旧実装では treeEl が可視 (250) より高く (>=400)、minimap が可視 bottom の下に落ちる (消える)。
    expect(counterfactual.treeH).toBeGreaterThanOrEqual(390);
    expect(counterfactual.mmBelowVisible).toBe(true);
});
