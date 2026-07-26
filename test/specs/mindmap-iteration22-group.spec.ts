/**
 * Mindmap iteration 22 — group メニューを単一ノード + 選択で作れるよう是正 (Wave 27 / TASK-57, #3)
 *   TC-M4: 単一ノード右クリック (選択なし) → 「Create Group」→ settings.groups に 1 件 (nodeIds=該当ノード)。
 *   TC-M5: shift+click で 2 ノード選択 → いずれかを右クリック → 「Create Group (2)」→ groups に nodeIds=[A,B]。
 *
 * 根本原因 (session-log「iteration 22」#3): buildContextMenu の group 項目が
 *   `if (selectedIds.length >= 2)` のみ。単一ノード右クリックは selected 空で出ず、
 *   空白右クリックは if(nodeId) ブロックごとスキップされ group 項目が出なかった。
 * 修正 (TASK-57): group 対象集合 groupTargets = selected があれば selected、無ければ
 *   右クリックノード 1 個。groupTargets.length >= 1 で「Create Group (N)」を表示 (1 ノードも許可)。
 *   ノード上右クリック + 空白右クリック (selected>=1) の両方で出す。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。
 *   ノード選択は実クリック (page.locator(...).click())、追加選択は shift+click、
 *   コンテキストメニューは実右クリック (click({button:'right'}))、メニュー項目は実クリック。
 *   group の格納は Outliner.getModel().mindmap.groups で検証し、描画は .mindmap-group で確認。
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
    await page.waitForTimeout(200);
}

// r(ROOT) - a, b, c の 3 子。context menu / 選択の対象。
function tree() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        mindmap: { layout: 'balanced' },
        nodes: {
            r: node('r', 'ROOT', ['a', 'b', 'c'], null),
            a: node('a', 'Alpha', [], 'r'),
            b: node('b', 'Bravo', [], 'r'),
            c: node('c', 'Charlie', [], 'r'),
        }
    };
}

function groups(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const g = (window as any).Outliner.getModel().mindmap.groups || [];
        return g.map((x: any) => ({ id: x.id, nodeIds: (x.nodeIds || []).slice() }));
    });
}

// コンテキストメニュー内の「Create Group」項目のテキスト一覧 (実右クリックで開いた後)。
function ctxGroupItems(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const menu = document.querySelector('.mindmap-context-menu');
        if (!menu) { return null; }
        return Array.from(menu.querySelectorAll('.mindmap-ctx-item'))
            .map((el: any) => (el.textContent || ''))
            .filter((t: string) => /Create Group/.test(t));
    });
}

// 「Create Group」項目を実クリックする。
async function clickCreateGroup(page: import('@playwright/test').Page) {
    const item = page.locator('.mindmap-context-menu .mindmap-ctx-item', { hasText: 'Create Group' });
    await expect(item).toHaveCount(1);
    await item.click();
    await page.waitForTimeout(120);
}

// =====================================================================================
// TC-M4: 単一ノード右クリック (選択なし) で group 作成
// =====================================================================================
test('TC-M4 単一ノード右クリック → 「Create Group」→ settings.groups に該当ノード 1 件', async ({ page }) => {
    await setup(page);
    await toMindmap(page, tree());

    // 前提: 選択なし・group 0 件。
    expect(await groups(page)).toHaveLength(0);

    // --- ノード a を実右クリック (選択せずに) → メニューに「Create Group」が出る ---
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click({ button: 'right' });
    await page.waitForTimeout(80);
    const items = await ctxGroupItems(page);
    expect(items).not.toBeNull();
    expect(items!.length).toBe(1);                       // 単一ノードでも group 項目が出る
    expect(items![0]).toContain('Create Group (1)');     // 対象は右クリックノード 1 個

    // --- 「Create Group」を実クリック → groups に nodeIds=['a'] が 1 件追加 ---
    await clickCreateGroup(page);
    const g = await groups(page);
    expect(g).toHaveLength(1);
    expect(g[0].nodeIds).toEqual(['a']);

    // rerender で group 枠が描画される。
    await expect(page.locator('.mindmap-group')).toHaveCount(1);
});

test('TC-M4 load-bearing: group ゲートを >= 2 に戻すと単一ノードで「Create Group」が出ず group を作れない', async ({ page }) => {
    await setup(page);
    // ★ 旧ゲート (複数選択時のみ = >= 2) に戻すフックを立ててから開く。
    await page.evaluate(() => { (window as any).MindmapInteractions._setGroupMinSelection(2); });
    await toMindmap(page, tree());

    expect(await groups(page)).toHaveLength(0);

    // 単一ノード右クリック → 旧ゲートでは group 項目が出ない。
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click({ button: 'right' });
    await page.waitForTimeout(80);
    const items = await ctxGroupItems(page);
    expect(items).not.toBeNull();
    expect(items!.length).toBe(0);                       // ★ 単一ノードでは項目が出ない (red 領域)

    // 項目が無いので group も作れない (作成経路が存在しない)。
    expect(await groups(page)).toHaveLength(0);

    // 後始末: 本番既定に戻す。
    await page.evaluate(() => { (window as any).MindmapInteractions._setGroupMinSelection(1); });
});

// =====================================================================================
// TC-M5: shift+click 複数選択 → 右クリックで group 作成
// =====================================================================================
test('TC-M5 A を click → B を shift+click → 右クリック「Create Group (2)」→ groups に [A,B]', async ({ page }) => {
    await setup(page);
    await toMindmap(page, tree());

    expect(await groups(page)).toHaveLength(0);

    // --- ノード a と b を shift+click で追加選択 (mindmap の複数選択は shift+click add) ---
    //   実装 (interactions.js click ハンドラ): plain click は selected を clear して focus する
    //   だけで add しない。shift/meta/ctrl 付き click のみ selected に add する。よって複数選択は
    //   両ノードを shift+click する (tasks.md TC-M5「2 ノードを shift+click 選択」)。
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(60);
    await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(80);

    // 2 ノードが選択されている (shift+click が add 選択で効いている前提が崩れると偽陽性)。
    const selCount = await page.locator('.mindmap-node-box.is-selected').count();
    expect(selCount).toBe(2);

    // --- いずれか (a) を実右クリック → 「Create Group (2)」が出る ---
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click({ button: 'right' });
    await page.waitForTimeout(80);
    const items = await ctxGroupItems(page);
    expect(items).not.toBeNull();
    expect(items!.length).toBe(1);
    expect(items![0]).toContain('Create Group (2)');     // 選択 2 個が対象

    // --- クリック → groups に nodeIds=[a,b] の group 追加 ---
    await clickCreateGroup(page);
    const g = await groups(page);
    expect(g).toHaveLength(1);
    expect([...g[0].nodeIds].sort()).toEqual(['a', 'b']);

    // rerender で group 枠が描画される。
    await expect(page.locator('.mindmap-group')).toHaveCount(1);
});
