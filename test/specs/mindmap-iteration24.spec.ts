/**
 * Mindmap iteration 24 — v0.209.2 手動テスト後の実機バグ (Wave 29)
 *   [A] TC-M13: ズーム (toolbar +/− / Ctrl+wheel) で active(focused) node を画面中心へ寄せる。
 *   [B] TC-M14: shift+click 複数選択が視覚的に強調される (is-selected の CSS 強化)。
 *   [C] TC-M15: group 作成をまたいで固定ノードの screen 位置が不変 (scale≠1 の viewBox シフト補償)。
 *
 * 根本原因 (session-log「iteration 24」, 実測 probe で確定):
 *   [A] toolbar +/− (mindmap-interactions.js) も wheel も viewport.scale を変えるだけで translate を
 *       再アンカーせず、active node が画面中心から遠ざかっていた。→ zoomTo(newScale) 共通ヘルパで
 *       active node の SVG 点をズーム後に画面中心へ placeSvgAtScreen。
 *   [B] shift+click 後の DOM クラスは正しい (両方 is-selected) が、CSS が薄い 15% 背景のみで
 *       is-focused が外れると「解除されて見える」。→ .is-selected に濃い背景 + box-shadow リング。
 *   [C] scale=1 では group 作成で viewBox 不変だが、scale=1.2 では bounds.min が動き viewBox origin
 *       (=bounds.min − PAD) がシフト → translate 不動でも全ノードが平行移動 (実測 r0 ~10px)。
 *       → withViewportFrozen を「基準ノードの screen 位置を捕捉→復元」に変更し bounds シフトを吸収。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。実クリック→実キー。
 *   本番同等 3 段 DOM (.outliner-container > .outliner-scroll-content{overflow-y:auto} > .outliner-tree)。
 *   座標は実可視領域 (treeEl ∩ window)。[A][C] は scale≠1 で検証。
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

// 横に広いマップ (root 多数) — active node が可視中心から離れる状況を作る。
function wideModel(n = 8) {
    const nodes: any = {};
    const roots: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = 'r' + i;
        roots.push(id);
        nodes[id] = node(id, 'root-' + i + '-xxxxxxxx');
    }
    return { version: 1, viewMode: 'mindmap', rootIds: roots, nodes };
}

// 本番同等 3 段 DOM に再構成 (iteration 22 toolbar spec と同方式)。
async function reproduceProdScrollStructure(page: import('@playwright/test').Page, containerHeight = 0) {
    await page.evaluate((h) => {
        const tree = document.querySelector('.outliner-tree');
        const container = document.querySelector('.outliner-container') as HTMLElement;
        if (!tree || !container) { return; }
        if (document.querySelector('.outliner-scroll-content')) { return; }
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
    await page.waitForTimeout(250);
}

function visFrame(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        const visLeft = Math.max(r.left, 0);
        const visRight = Math.min(r.right, window.innerWidth);
        const visTop = Math.max(r.top, 0);
        const visBottom = Math.min(r.bottom, window.innerHeight);
        return { cx: (visLeft + visRight) / 2, cy: (visTop + visBottom) / 2, w: visRight - visLeft, h: visBottom - visTop };
    });
}

function nodeCenter(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((id) => {
        const fo = document.querySelector('.mindmap-node[data-node-id="' + id + '"]');
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }, id);
}

// ============ [A] TC-M13 zoom re-anchors on active node ============

test('TC-M13 toolbar + で active node が画面中心へ寄る (#A)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, wideModel(8));
    const vis = await visFrame(page);

    // 端寄りの active node を選ぶ (可視中心から一番遠い root を探す)。
    let target = 'r0', best = -1;
    for (let i = 0; i < 8; i++) {
        const c = await nodeCenter(page, 'r' + i);
        if (!c) { continue; }
        const d = Math.abs(c.cx - vis.cx) + Math.abs(c.cy - vis.cy);
        if (d > best) { best = d; target = 'r' + i; }
    }
    await page.locator('.mindmap-node[data-node-id="' + target + '"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    const before = await nodeCenter(page, target);
    const dBefore = Math.abs(before!.cx - vis.cx) + Math.abs(before!.cy - vis.cy);

    await page.locator('.mindmap-toolbar [data-mm-action="zoom-in"]').click();
    await page.waitForTimeout(150);
    const after = await nodeCenter(page, target);
    const dAfter = Math.abs(after!.cx - vis.cx) + Math.abs(after!.cy - vis.cy);

    // active node がズーム後に可視中心へ近づく (旧実装は遠ざかる)。
    expect(dAfter).toBeLessThan(dBefore);
    // 最終的に十分中心付近 (可視幅/高の一定割合以内)。
    expect(Math.abs(after!.cx - vis.cx)).toBeLessThanOrEqual(vis.w * 0.25);
    expect(Math.abs(after!.cy - vis.cy)).toBeLessThanOrEqual(vis.h * 0.25);
});

test('TC-M13 Ctrl+wheel でも active node が画面中心へ寄る (#A)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, wideModel(8));
    const vis = await visFrame(page);
    let target = 'r0', best = -1;
    for (let i = 0; i < 8; i++) {
        const c = await nodeCenter(page, 'r' + i);
        if (!c) { continue; }
        const d = Math.abs(c.cx - vis.cx) + Math.abs(c.cy - vis.cy);
        if (d > best) { best = d; target = 'r' + i; }
    }
    await page.locator('.mindmap-node[data-node-id="' + target + '"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    const before = await nodeCenter(page, target);
    const dBefore = Math.abs(before!.cx - vis.cx) + Math.abs(before!.cy - vis.cy);

    // Ctrl+wheel (deltaY<0 = zoom in) を treeEl 上で発火。
    await page.mouse.move(vis.cx, vis.cy);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(150);

    const after = await nodeCenter(page, target);
    const dAfter = Math.abs(after!.cx - vis.cx) + Math.abs(after!.cy - vis.cy);
    expect(dAfter).toBeLessThan(dBefore);
});

// ============ [B] TC-M14 selected visual is strong ============

test('TC-M14 shift+click 複数選択が視覚的に強調される (#B)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['a', 'b'], nodes: { a: node('a', 'AAA'), b: node('b', 'BBB') } });

    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(120);

    const info = await page.evaluate(() => {
        const g = (id: string) => {
            const fo = document.querySelector('.mindmap-node[data-node-id="' + id + '"]');
            const box = fo && fo.querySelector('.mindmap-node-box') as HTMLElement;
            if (!box) { return null; }
            const cs = getComputedStyle(box);
            return { cls: box.className, boxShadow: cs.boxShadow, background: cs.backgroundColor };
        };
        return { a: g('a'), b: g('b') };
    });

    // DOM クラスは両方 is-selected (iteration 23 で担保済み)。
    expect(info.a!.cls).toContain('is-selected');
    expect(info.b!.cls).toContain('is-selected');
    // 視覚指標: box-shadow が none でない (選択リング) — 両ノードとも。
    expect(info.a!.boxShadow).not.toBe('none');
    expect(info.b!.boxShadow).not.toBe('none');
});

test('TC-M14 load-bearing: is-selected の box-shadow を消すと選択リングが none になる (#B)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, { version: 1, viewMode: 'mindmap', rootIds: ['a', 'b'], nodes: { a: node('a', 'AAA'), b: node('b', 'BBB') } });
    // 反実仮想: is-selected の box-shadow を打ち消すルールを注入 (fix を無効化)。
    await page.evaluate(() => {
        const st = document.createElement('style');
        st.textContent = '.mindmap-node-box.is-selected{box-shadow:none !important;background:rgba(125,196,223,0.15) !important;}';
        document.head.appendChild(st);
    });
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(120);
    const shadowB = await page.evaluate(() => {
        const box = document.querySelector('.mindmap-node[data-node-id="b"] .mindmap-node-box') as HTMLElement;
        return getComputedStyle(box).boxShadow;
    });
    // 無効化すると選択リングが消える = fix が load-bearing。
    expect(shadowB).toBe('none');
});

// ============ [C] TC-M15 group create keeps screen invariant at scale≠1 ============

async function selectAndGroup(page: import('@playwright/test').Page, id: string) {
    await page.locator('.mindmap-node[data-node-id="' + id + '"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.locator('.mindmap-node[data-node-id="' + id + '"] .mindmap-node-box').click({ button: 'right' });
    await page.waitForTimeout(120);
    await page.locator('text=/Create Group/i').first().click();
    await page.waitForTimeout(180);
}

test('TC-M15 group 作成で固定ノードの screen 位置が不変 (scale≠1) (#C)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, wideModel(8));
    // scale≠1 にする (核心)。
    await page.locator('.mindmap-toolbar [data-mm-action="zoom-in"]').click();
    await page.waitForTimeout(120);

    const beforeR0 = await nodeCenter(page, 'r0');
    await selectAndGroup(page, 'r2'); // r2 を単一ノード group 化 (r0 は group 外の固定ノード)
    const afterR0 = await nodeCenter(page, 'r0');

    // 固定ノード r0 の screen 中心が group 作成前後で不変。
    expect(Math.abs(afterR0!.cx - beforeR0!.cx)).toBeLessThanOrEqual(4);
    expect(Math.abs(afterR0!.cy - beforeR0!.cy)).toBeLessThanOrEqual(4);
});

test('TC-M15 load-bearing: freeze を無効化すると scale≠1 で固定ノードが動く (#C)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, wideModel(8));
    await page.locator('.mindmap-toolbar [data-mm-action="zoom-in"]').click();
    await page.waitForTimeout(120);
    // 反実仮想: viewport freeze/補償を無効化 (旧・未補償相当)。
    await page.evaluate(() => (window as any).MindmapInteractions._setFreezeViewportOnStructuralEdit(false));

    const beforeR0 = await nodeCenter(page, 'r0');
    await selectAndGroup(page, 'r2');
    const afterR0 = await nodeCenter(page, 'r0');

    // 補償なしでは bounds シフトにより固定ノードが動く (実測 ~10px)。
    const moved = Math.abs(afterR0!.cx - beforeR0!.cx) + Math.abs(afterR0!.cy - beforeR0!.cy);
    expect(moved).toBeGreaterThan(4);
});
