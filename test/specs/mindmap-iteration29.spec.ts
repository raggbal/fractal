/**
 * Mindmap iteration 29 — 形状変更で中心化 / エクスポート削除 / Cmd+Enter 添付open /
 *   ヘッダー非アクティブ化 / mindmap 検索 (Wave 34 / TASK-74〜80)
 *   TC-M22 [G]: layout 変更 (Cmd+Shift+L / toolbar select) で title 中央ノードを画面中心へ。
 *   TC-M23 [H]: PNG/SVG/OPML/MD エクスポートボタンがツールバーに無い (別 spec の TC-223改 で担保)。
 *   TC-M24 [I][J]: file 添付ノード Cmd+Enter → openAttachedFile / page(md) → openPageInSidePanel。
 *   TC-M25 [K]: mindmap モードで使わないヘッダーボタンが disabled (grey)。使うボタンは有効。
 *   TC-M26 [M]: mindmap 検索 = 一致ノードをハイライト + 最初の一致を中央、Enter/searchNext で巡回。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。実クリック→実キー。
 */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 900, height: 700 } });

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function node(id: string, text: string, children: string[] = [], parentId: string | null = null, extra: any = {}) {
    return Object.assign({ id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
}

async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d))); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(280);
}

function titleCx(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const fo = document.querySelector('.mindmap-node[data-node-id="__title__"]');
        if (!fo) { return null; }
        const r = fo.getBoundingClientRect();
        return r.left + r.width / 2;
    });
}
function visCx(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const t = document.querySelector('.outliner-tree') as HTMLElement;
        const r = t.getBoundingClientRect();
        return (Math.max(r.left, 0) + Math.min(r.right, window.innerWidth)) / 2;
    });
}

function titleModel() {
    const nodes: any = {}; const roots: string[] = [];
    for (let i = 0; i < 6; i++) { const id = 'r' + i; roots.push(id); nodes[id] = node(id, 'root ' + i); }
    return { version: 1, viewMode: 'mindmap', title: 'Center', rootIds: roots, nodes };
}

// ============ [G] TC-M22 layout change re-centers title ============

test('TC-M22 layout 変更 (toolbar select) で title が画面中心へ', async ({ page }) => {
    await setup(page);
    await toMindmap(page, titleModel());
    // pan away
    await page.evaluate(() => { const v = (window as any).MindmapRender.getViewport(); (window as any).MindmapRender.updateViewport({ scale: v.scale, translateX: v.translateX - 220, translateY: v.translateY - 120 }); });
    await page.waitForTimeout(60);
    const vc = await visCx(page);
    expect(Math.abs((await titleCx(page))! - vc)).toBeGreaterThan(vc * 0.3); // panned away
    await page.selectOption('.mindmap-tb-layout', 'left');
    await page.waitForTimeout(250);
    // title back near center horizontally
    expect(Math.abs((await titleCx(page))! - vc)).toBeLessThanOrEqual(vc * 0.3);
});

test('TC-M22 layout 変更 (Cmd+Shift+L) でも title が画面中心へ', async ({ page }) => {
    await setup(page);
    await toMindmap(page, titleModel());
    await page.locator('.mindmap-node[data-node-id="r0"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.evaluate(() => { const v = (window as any).MindmapRender.getViewport(); (window as any).MindmapRender.updateViewport({ scale: v.scale, translateX: v.translateX - 220, translateY: v.translateY }); });
    await page.waitForTimeout(60);
    const vc = await visCx(page);
    await page.keyboard.press('Meta+Shift+KeyL');
    await page.waitForTimeout(250);
    expect(Math.abs((await titleCx(page))! - vc)).toBeLessThanOrEqual(vc * 0.3);
});

// ============ [H] TC-M23 export buttons removed ============

test('TC-M23 エクスポートボタン (PNG/SVG/OPML/MD) がツールバーに無い', async ({ page }) => {
    await setup(page);
    await toMindmap(page, titleModel());
    expect(await page.locator('.mindmap-tb-btn[data-mm-action="export"]').count()).toBe(0);
    // zoom/fit/layout は残る
    expect(await page.locator('.mindmap-tb-btn[data-mm-action="zoom-in"]').count()).toBe(1);
    expect(await page.locator('.mindmap-tb-layout[data-mm-action="layout"]').count()).toBe(1);
});

// ============ [I][J] TC-M24 Cmd+Enter opens attachment ============

test('TC-M24 file 添付ノード Cmd+Enter → openAttachedFile / page(md) → openPageInSidePanel', async ({ page }) => {
    await setup(page);
    await toMindmap(page, {
        version: 1, viewMode: 'mindmap', rootIds: ['f', 'pg', 'plain'],
        nodes: {
            f: node('f', 'file node', [], null, { filePath: '/tmp/foo.pdf' }),
            pg: node('pg', 'page node', [], null, { isPage: true, pageId: 'p1' }),
            plain: node('plain', 'plain', []),
        },
    });
    // [I] file
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await page.locator('.mindmap-node[data-node-id="f"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(100);
    let types = await page.evaluate(() => (window as any).__testApi.messages.map((m: any) => m.type));
    expect(types).toContain('openAttachedFile');
    // [J] page (md)
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await page.locator('.mindmap-node[data-node-id="pg"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(100);
    types = await page.evaluate(() => (window as any).__testApi.messages.map((m: any) => m.type));
    expect(types.some((t: string) => /openPage/i.test(t))).toBe(true);
    // load-bearing: plain ノードでは何も開かない
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await page.locator('.mindmap-node[data-node-id="plain"] .mindmap-node-box').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(100);
    types = await page.evaluate(() => (window as any).__testApi.messages.map((m: any) => m.type));
    expect(types.filter((t: string) => /openAttachedFile|openPage/i.test(t)).length).toBe(0);
});

// ============ [K] TC-M25 header buttons disabled in mindmap ============

test('TC-M25 mindmap モードで使わないヘッダーボタンが disabled、使うボタンは有効', async ({ page }) => {
    await setup(page);
    await toMindmap(page, titleModel());
    const state = await page.evaluate(() => {
        const q = (c: string) => { const e = document.querySelector(c) as HTMLElement | null; return e ? { disabled: (e as any).disabled === true || e.classList.contains('is-mindmap-disabled') } : null; };
        return {
            taskMode: q('.outliner-task-mode-toggle-btn'),
            archive: q('.outliner-archive-btn'),
            menu: q('.outliner-menu-btn'),
            navBack: q('.outliner-nav-back-btn'),
            searchModeToggle: q('.outliner-search-mode-toggle'),
            viewToggle: q('.outliner-view-toggle-btn'),
            searchInput: !!document.querySelector('.outliner-search-input'),
        };
    });
    // 使わないボタンは disabled (存在する場合)
    for (const k of ['taskMode', 'archive', 'menu', 'navBack', 'searchModeToggle'] as const) {
        if ((state as any)[k]) { expect((state as any)[k].disabled).toBe(true); }
    }
    // 使うボタンは有効 (view-toggle は disabled でない)
    if (state.viewToggle) { expect(state.viewToggle.disabled).toBe(false); }
    expect(state.searchInput).toBe(true);
});

test('TC-M25 load-bearing: outliner モードに戻すと disabled が解除される', async ({ page }) => {
    await setup(page);
    await toMindmap(page, titleModel());
    // outliner へ戻す
    await page.evaluate(() => (window as any).Outliner.setViewMode('outliner'));
    await page.waitForTimeout(200);
    const taskModeDisabled = await page.evaluate(() => {
        const e = document.querySelector('.outliner-task-mode-toggle-btn') as HTMLElement | null;
        return e ? ((e as any).disabled === true || e.classList.contains('is-mindmap-disabled')) : null;
    });
    // outliner では task-mode は mindmap 由来の disabled が外れている
    if (taskModeDisabled !== null) { expect(taskModeDisabled).toBe(false); }
});

// ============ [M] TC-M26 mindmap search ============

function searchModel() {
    const nodes: any = {}; const roots: string[] = [];
    for (let i = 0; i < 6; i++) { const id = 'r' + i; roots.push(id); nodes[id] = node(id, 'apple ' + i); }
    nodes.r2.text = 'banana target';
    nodes.r4.text = 'banana second';
    return { version: 1, viewMode: 'mindmap', title: 'Center', rootIds: roots, nodes };
}

test('TC-M26 mindmap 検索: 一致ノードをハイライト + 最初の一致を中央 (絞り込まない)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, searchModel());
    await page.locator('.outliner-search-input').fill('banana');
    await page.waitForTimeout(320);
    // 一致 2 件がハイライト
    expect(await page.locator('.mindmap-node-box.is-search-hit').count()).toBe(2);
    // 現在 (中央化対象) は最初の一致 r2
    const cur = await page.evaluate(() => {
        const e = document.querySelector('.mindmap-node-box.is-search-current');
        const fo = e && e.closest('.mindmap-node');
        return fo ? fo.getAttribute('data-node-id') : null;
    });
    expect(cur).toBe('r2');
    // 絞り込みでない = 全ノード (6+title) が DOM に残っている
    expect(await page.locator('.mindmap-node').count()).toBeGreaterThanOrEqual(7);
    // r2 が画面中央付近に来ている
    const vc = await visCx(page);
    const r2cx = await page.evaluate(() => { const r = document.querySelector('.mindmap-node[data-node-id="r2"]')!.getBoundingClientRect(); return r.left + r.width / 2; });
    expect(Math.abs(r2cx - vc)).toBeLessThanOrEqual(vc * 0.35);
});

test('TC-M26 mindmap 検索: Enter で次の一致へ巡回中央化', async ({ page }) => {
    await setup(page);
    await toMindmap(page, searchModel());
    await page.locator('.outliner-search-input').fill('banana');
    await page.waitForTimeout(320);
    // Enter で次 (r4) へ
    await page.locator('.outliner-search-input').press('Enter');
    await page.waitForTimeout(200);
    const cur = await page.evaluate(() => {
        const e = document.querySelector('.mindmap-node-box.is-search-current');
        const fo = e && e.closest('.mindmap-node');
        return fo ? fo.getAttribute('data-node-id') : null;
    });
    expect(cur).toBe('r4');
    const vc = await visCx(page);
    const r4cx = await page.evaluate(() => { const r = document.querySelector('.mindmap-node[data-node-id="r4"]')!.getBoundingClientRect(); return r.left + r.width / 2; });
    expect(Math.abs(r4cx - vc)).toBeLessThanOrEqual(vc * 0.35);
});

test('TC-M26 load-bearing: 検索クリアでハイライトが消える', async ({ page }) => {
    await setup(page);
    await toMindmap(page, searchModel());
    await page.locator('.outliner-search-input').fill('banana');
    await page.waitForTimeout(320);
    expect(await page.locator('.mindmap-node-box.is-search-hit').count()).toBe(2);
    await page.locator('.outliner-search-input').fill('');
    await page.waitForTimeout(320);
    expect(await page.locator('.mindmap-node-box.is-search-hit').count()).toBe(0);
});
