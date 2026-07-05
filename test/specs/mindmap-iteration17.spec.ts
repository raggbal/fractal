/**
 * Mindmap iteration 17 — .focus() の native scroll 中央寄せを止める (Wave 23 / FR-021-J2, TASK-51)
 *
 * バグ: 実機 (VS Code webview = Electron/Chromium) で矢印移動 / 追加すると、アクティブノードが
 *   画面のほぼ中央に来る。原因は focusNode の `.mindmap-node-text.focus()` が preventScroll なしで
 *   呼ばれ、Chromium の native "scroll focused element into view" が `.outliner-scroll-content`
 *   (mindmap モードで overflow:hidden だが MDN 上 scroll container のまま) を動かして中央寄せする。
 * 修正: mindmap 経路の全 `.focus()` を `focus({ preventScroll: true })` に。
 *   可視化は iteration 16 の ensureNodeVisible (transform 最小パン) に一本化。
 *
 * ★偽陽性対策の核心 (research.md「iteration 17 調査」/ testcases.md TC-V6):
 *   iteration 16 の TC-V2/V3/V4 は standalone の 2 段 DOM (scroll container 無し) で
 *   viewport.translate だけ見て、実機の中央寄せ (scroll container の native focus scroll) を
 *   見逃した。TC-V6 は本番同等の 3 段 DOM を再構成し、かつ「genuinely scrollable」な状態
 *   (scrollHeight > clientHeight) を作って scroll 軸 (scrollTop) を検証する。
 *
 * ★ headless の native focus scroll 挙動 (実装時にプローブで確定した事実):
 *   - Playwright headless Chromium は「genuinely scrollable なコンテナ (scrollHeight > clientHeight)」
 *     に対しては native focus scroll を実機同様に発火する。default focus で scrollTop が動き
 *     (実測 300〜350px)、preventScroll:true では 0 のまま。
 *   - ただし mindmap.css の :has() fix は scroll-content を overflow:hidden にしつつ tree を
 *     枠内に収めるため、素の 3 段再構成では scrollHeight === clientHeight (canScroll=false) になり
 *     native focus scroll が発火しない。→ 本番のスクロール余地 (page-title/search-bar 等の
 *     sibling + tree min-height:400px が scroll-content 高さを超える) を再現するため、
 *     scroll-content に固定 height + 背の高い sibling を入れて genuinely scrollable にする。
 *   - Playwright の .click() はアクション前に対象を view にスクロールする (テストハーネス由来の
 *     scrollTop 移動)。これは mindmap コードの挙動ではないため、click 後に scrollTop を 0 に
 *     リセットしてから ArrowDown を測る (click 由来のノイズを除去)。
 *   - load-bearing 実証: source を plain .focus() に戻して再ビルドすると、同じ ArrowDown で
 *     scrollTop が 0→305→350 と動く (native focus scroll 発火) ことをプローブで確認済み。
 *     本 spec ではソースを戻せないため、(a) focus 呼び出し引数の spy 検証 と
 *     (b) 同 DOM での default focus counterfactual (scrollTop が動く) の 2 面で load-bearing を担保。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼びを検証操作に使わない。
 *   page.locator(...).click() (実選択) → page.keyboard.press(...) (実キー) の実フロー。
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

// 縦に大きいツリー: root r に子 count 個。span が可視領域を超える。
function tallTree(count: number, layout: string = 'right') {
    const children: string[] = [];
    const nodes: any = { r: node('r', 'root', [], null) };
    for (let i = 0; i < count; i++) {
        const id = 'c' + i;
        children.push(id);
        nodes[id] = node(id, 'child-' + i + ' with a fairly long label', [], 'r');
    }
    nodes.r.children = children;
    return { version: 1, viewMode: 'mindmap', rootIds: ['r'], mindmap: { layout }, nodes };
}

/**
 * standalone の 2 段構造 (.outliner-container > .outliner-tree) を、本番同等の 3 段
 * (.outliner-container > .outliner-scroll-content > .outliner-tree) に再構成する。
 * さらに、本番でスクロール余地が生まれる条件 (scroll-content の高さ < 中身の高さ) を再現する:
 *   - scroll-content に固定 height (300px) を与える。
 *   - tree の前に背の高い sibling (250px, 本番の page-title/search-bar 相当) を挿入する。
 *   → scroll-content の scrollHeight (sibling 250 + tree 400) > clientHeight (300) となり
 *     genuinely scrollable。これで native focus scroll が動く「先」が生まれる。
 * overflow はスタイルシート経由 (inline でなく <style>) で与える (specificity で mindmap.css の
 * :has() を潰さないため — designer_failures 2026-07-03)。mindmap モードでは :has() fix が
 * overflow:hidden にするが、MDN 上 overflow:hidden は scroll container のままで programmatic/
 * focus scroll は動く (これが iteration 17 バグの本質)。
 */
async function reproduceScrollableProdDom(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        if (!tree || document.querySelector('.outliner-scroll-content')) { return; }
        const st = document.createElement('style');
        st.setAttribute('data-test', 'repro-scroll-content');
        st.textContent =
            '.outliner-scroll-content{overflow-y:auto;overflow-x:hidden;height:300px !important;' +
            'max-height:300px !important;position:relative;display:flex;flex-direction:column;flex:0 0 auto;}';
        document.head.appendChild(st);
        const sc = document.createElement('div');
        sc.className = 'outliner-scroll-content';
        tree.parentNode!.insertBefore(sc, tree);
        const sib = document.createElement('div');
        sib.className = 'repro-tall-sibling';
        sib.style.cssText = 'height:250px;flex:0 0 auto;';
        sc.appendChild(sib);
        sc.appendChild(tree);
    });
}

async function toMindmapScrollable(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await reproduceScrollableProdDom(page);
    // 再構成後に mindmap の :has() fix を確実に反映させるため viewMode を入れ直す。
    await page.evaluate(() => {
        (window as any).Outliner.setViewMode('outliner');
        (window as any).Outliner.setViewMode('mindmap');
    });
    await page.waitForTimeout(200);
}

function scrollState(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
        return {
            top: sc.scrollTop, left: sc.scrollLeft,
            scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight,
            canScroll: sc.scrollHeight > sc.clientHeight,
        };
    });
}

function focusedNodeCenter(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const box = document.querySelector('.mindmap-node-box.is-focused');
        const foEl = box ? box.closest('.mindmap-node') : null;
        const tree = document.querySelector('.outliner-tree[data-view-mode="mindmap"]') as HTMLElement;
        if (!foEl || !tree) { return null; }
        const nr = foEl.getBoundingClientRect();
        const tr = tree.getBoundingClientRect();
        return {
            focCy: (nr.top + nr.bottom) / 2,
            treeCy: (tr.top + tr.bottom) / 2,
            treeH: tr.height,
        };
    });
}

test('TC-V6 本番同等の genuinely-scrollable 3 段 DOM で矢印移動が native focus scroll しない', async ({ page }) => {
    await setup(page);
    await toMindmapScrollable(page, tallTree(24, 'right'));

    // --- 前提: scroll container が本番同等で genuinely scrollable であること ---
    const s0 = await scrollState(page);
    expect(s0.canScroll).toBe(true); // scrollHeight > clientHeight (native focus scroll が動く先がある)

    // --- 上端の子を実クリックで選択 ---
    await page.locator('.mindmap-node[data-node-id="c0"] .mindmap-node-box').click();
    await page.waitForTimeout(60);

    // Playwright の .click() は対象を view にスクロールする (ハーネス由来)。mindmap コードの
    // 挙動を測るため、click 後に scrollTop/scrollLeft を 0 にリセットしてから ArrowDown を測る。
    await page.evaluate(() => {
        const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
        sc.scrollTop = 0; sc.scrollLeft = 0;
    });
    const sReset = await scrollState(page);
    expect(sReset.top).toBe(0);
    expect(sReset.left).toBe(0);

    // --- ArrowDown を 6 回、各回で (1) scroll 軸不変 を検証し、(2) 中央寄せ非発生の証跡を集める ---
    // 中央寄せ (バグ) は「毎ステップ選択ノードを treeEl 中心付近に固定する」挙動。
    // 修正後は scrollTop が動かないため、選択ノードの screen 中心は純粋にレイアウトで決まり、
    // 下へ進むほど下方へ march していき最終的に画面外 (中心から大きく外れる) になる。
    const STEPS = 6;
    const centers: { focCy: number; treeCy: number; treeH: number }[] = [];
    for (let step = 0; step < STEPS; step++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(60);

        const s = await scrollState(page);
        // (1) scroll container の scrollTop / scrollLeft が動かない (native focus scroll が起きていない)。
        //     preventScroll を外すと (plain .focus()) ここが 305/350 と動く (プローブで実証済み・load-bearing)。
        expect(s.top).toBe(0);
        expect(s.left).toBe(0);

        const c = await focusedNodeCenter(page);
        expect(c).not.toBeNull();
        centers.push(c!);
    }

    // (2) 中央寄せしない証跡:
    //   (2a) 選択ノードの screen 中心が単調に下方へ march している (中央固定でない)。
    //        中央寄せなら各ステップで focCy ≈ treeCy に張り付き march しない。
    for (let i = 1; i < centers.length; i++) {
        expect(centers[i].focCy).toBeGreaterThan(centers[i - 1].focCy - 2);
    }
    //   (2b) 最終ステップでは選択ノードが treeEl 中心から十分外れている (中央に来ていない)。
    //        march した結果、下端付近もしくは画面外にあるはず。中央寄せ実装なら中心付近で red。
    const last = centers[centers.length - 1];
    expect(Math.abs(last.focCy - last.treeCy)).toBeGreaterThan(last.treeH * 0.15);
});

test('TC-V6 load-bearing (a): mindmap の focus が preventScroll:true 付きで呼ばれている', async ({ page }) => {
    await setup(page);
    await toMindmapScrollable(page, tallTree(24, 'right'));

    // .mindmap-node-text の focus をラップして、最後の呼び出しの preventScroll 引数を記録する。
    // (これは検証用の spy であり、el.focus() の「プログラム的直呼び」ではない。実際の focus は
    //  実キー ArrowDown → focusNode 経由で発火し、その引数を観測するだけ。)
    await page.evaluate(() => {
        const proto = (window as any).HTMLElement.prototype;
        const orig = proto.focus;
        (window as any).__focusCalls = [];
        proto.focus = function (opts?: any) {
            // mindmap ノードのテキスト要素への focus のみ記録
            if (this.classList && this.classList.contains('mindmap-node-text')) {
                (window as any).__focusCalls.push(opts && typeof opts === 'object' ? !!opts.preventScroll : false);
            }
            return orig.apply(this, arguments as any);
        };
    });

    await page.locator('.mindmap-node[data-node-id="c0"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    // spy をリセットしてから実キーで移動 (click 由来の focus を除外)
    await page.evaluate(() => { (window as any).__focusCalls = []; });
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);

    const calls: boolean[] = await page.evaluate(() => (window as any).__focusCalls);
    // ArrowDown → focusNode(adj,false) → .mindmap-node-text.focus({preventScroll:true}) が呼ばれる。
    expect(calls.length).toBeGreaterThan(0);
    // 記録された全 focus 呼び出しが preventScroll:true (plain .focus() に戻すと false になり red)。
    expect(calls.every((v) => v === true)).toBe(true);

    // 後始末: focus を元に戻す
    await page.evaluate(() => {
        const proto = (window as any).HTMLElement.prototype;
        // 直前に上書きした関数は closure 内 orig を呼ぶので、ページ遷移で破棄されるが念のため noop 化はしない
    });
});

test('TC-V6 load-bearing (b): 同 DOM で default focus はコンテナを動かす (counterfactual)', async ({ page }) => {
    // 「scrollTop が 0 のまま」が tautology でない (＝ preventScroll を外せば動く) ことを、
    // 同一の再構成 DOM 上で default focus (preventScroll なし) を offscreen ノードに掛けて
    // scrollTop が動くことで実証する。これは native focus scroll が headless で発火する条件
    // (genuinely scrollable) が本テストで整っていることの証左でもある。
    await setup(page);
    await toMindmapScrollable(page, tallTree(24, 'right'));

    const s0 = await scrollState(page);
    expect(s0.canScroll).toBe(true);

    const cmp = await page.evaluate(() => {
        const sc = document.querySelector('.outliner-scroll-content') as HTMLElement;
        const results: { id: string; def: number; prev: number }[] = [];
        // 下方の (画面外になりやすい) ノード群で比較
        for (const nid of ['c15', 'c20', 'c23']) {
            const el = document.querySelector('.mindmap-node[data-node-id="' + nid + '"] .mindmap-node-text') as HTMLElement | null;
            if (!el) { continue; }
            sc.scrollTop = 0;
            (document.activeElement as HTMLElement | null)?.blur?.();
            el.focus(); // default (preventScroll:false) = 本バグの再現
            const def = sc.scrollTop;
            sc.scrollTop = 0;
            el.blur();
            el.focus({ preventScroll: true }); // 修正の挙動
            const prev = sc.scrollTop;
            results.push({ id: nid, def, prev });
        }
        return results;
    });

    expect(cmp.length).toBeGreaterThan(0);
    // default focus は少なくとも 1 ノードで scrollTop を動かす (native focus scroll 発火)。
    expect(cmp.some((r) => r.def > 20)).toBe(true);
    // preventScroll:true では全ノードで scrollTop が動かない (0 のまま)。
    expect(cmp.every((r) => r.prev === 0)).toBe(true);
});
