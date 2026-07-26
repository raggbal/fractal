/**
 * Mindmap Task Mode E2E — sprint 20260727-024112-mindmap-task-mode
 * TC-MT-01〜14 (testcases.md §B)
 *
 * FR-MT-01: checkbox 実クリックで toggle / FR-MT-02: Cmd+Shift(+Opt)+X /
 * FR-MT-03: 右クリックメニュー Add/Remove Checkbox / FR-MT-04: task filter で subtree+線が消える /
 * FR-MT-05: ヘッダー task 3 ボタン有効。
 *
 * テスト方針 (generator_failures 2026-07-02/07-21 厳守): el.focus() 直呼び禁止・
 * dispatchEvent 駆動禁止。実クリック (locator.click) → 実キー (keyboard.press)。
 * 右クリックは click({button:'right'})。TC-MT-01 は SVG foreignObject 内 <input> への
 * 実クリック到達 (pointer-events) を検証する load-bearing (NFR-MT-08)。
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

/** checked を持つ 3 ノード構成: r1(checked=false) -> c1(checked=true) -> g1、r2(checked 無し) */
function taskModel(extra: any = {}) {
    return Object.assign({
        version: 1, viewMode: 'mindmap', title: '', taskFilter: 'all',
        rootIds: ['r1', 'r2'],
        nodes: {
            r1: node('r1', 'task root', ['c1'], null, { checked: false }),
            c1: node('c1', 'done child', ['g1'], 'r1', { checked: true }),
            g1: node('g1', 'grandchild', [], 'c1'),
            r2: node('r2', 'no checkbox', [], null)
        }
    }, extra);
}

function getChecked(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => (window as any).Outliner.getModel().nodes[nid].checked, id);
}

test.describe('Mindmap Task Mode', () => {

    // ============ FR-MT-01: checkbox click ============

    test('TC-MT-01 ★load-bearing: checkbox 実クリックで model.checked が反転 (foreignObject 内 input への実クリック到達 = NFR-MT-08)', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        expect(await getChecked(page, 'r1')).toBe(false);
        // 実クリック (locator.click = 実マウスイベント。dispatchEvent ではない)
        await page.locator('.mindmap-node-checkbox[data-node-id="r1"]').click();
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r1')).toBe(true);
        // rerender 後の DOM も model に追随 (checked 属性)
        const domChecked = await page.evaluate(() => {
            const cb = document.querySelector('.mindmap-node-checkbox[data-node-id="r1"]') as HTMLInputElement;
            return cb ? cb.checked : null;
        });
        expect(domChecked).toBe(true);
    });

    test('TC-MT-02 checkbox クリックはノード選択・編集に伝播しない', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        // 先に r2 をクリックして focus を確定させる
        await page.locator('.mindmap-node[data-node-id="r2"] .mindmap-node-box').click();
        await page.waitForTimeout(60);
        await page.locator('.mindmap-node-checkbox[data-node-id="r1"]').click();
        await page.waitForTimeout(150);
        // focus は r2 のまま (checkbox クリックで r1 に移らない)
        const focused = await page.evaluate(() => (window as any).Outliner.getFocusedNodeId
            ? (window as any).Outliner.getFocusedNodeId()
            : document.querySelector('.mindmap-node-box.is-focused')?.closest('.mindmap-node')?.getAttribute('data-node-id'));
        expect(focused).not.toBe('r1');
        // 編集モードにも入っていない
        const editing = await page.evaluate(() => !!document.querySelector('.mindmap-node-text.is-editing'));
        expect(editing).toBe(false);
    });

    test('TC-MT-03 checkbox クリック → Cmd+Z で undo できる', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        await page.locator('.mindmap-node-checkbox[data-node-id="r1"]').click();
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r1')).toBe(true);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);
        expect(await getChecked(page, 'r1')).toBe(false);
    });

    // ============ FR-MT-02: keyboard ============

    test('TC-MT-04 Cmd+Shift+X: checkbox 追加 → もう一度で完了トグル (実クリック→実キー)', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        await page.locator('.mindmap-node[data-node-id="r2"] .mindmap-node-box').click();
        await page.waitForTimeout(60);
        expect(await getChecked(page, 'r2')).toBe(null);
        await page.keyboard.press('Meta+Shift+KeyX');
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r2')).toBe(false); // null → false (追加)
        await page.keyboard.press('Meta+Shift+KeyX');
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r2')).toBe(true);  // false → true (トグル)
    });

    test('TC-MT-05 Cmd+Shift+Alt+X: checkbox 削除 + 判定順 counterfactual (Alt 付きがトグルに食われない)', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        await page.locator('.mindmap-node[data-node-id="r1"] .mindmap-node-box').click();
        await page.waitForTimeout(60);
        expect(await getChecked(page, 'r1')).toBe(false);
        await page.keyboard.press('Meta+Shift+Alt+KeyX');
        await page.waitForTimeout(150);
        // counterfactual: トグル側が食っていたら true になる。削除側が正しく発火すれば null
        expect(await getChecked(page, 'r1')).toBe(null);
        // checkbox DOM も消える
        const cbExists = await page.evaluate(() => !!document.querySelector('.mindmap-node-checkbox[data-node-id="r1"]'));
        expect(cbExists).toBe(false);
    });

    test('TC-MT-06 title ノードには Cmd+Shift+X が効かない', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel({ title: 'My Map' }));
        await page.locator('.mindmap-title-node .mindmap-node-box').click();
        await page.waitForTimeout(60);
        await page.keyboard.press('Meta+Shift+KeyX');
        await page.waitForTimeout(150);
        // title に checkbox は付かず、model にも __title__ ノードは作られない
        const titleCb = await page.evaluate(() => !!document.querySelector('.mindmap-title-node .mindmap-node-checkbox'));
        expect(titleCb).toBe(false);
        const hasTitleNode = await page.evaluate(() => !!(window as any).Outliner.getModel().nodes.__title__);
        expect(hasTitleNode).toBe(false);
    });

    test('TC-MT-15 ★load-bearing: DOM フォーカスが body に落ちても Cmd+Shift+X / +Alt+X が効く (document フォールバック)', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        // node を選択して論理フォーカスを確立
        await page.locator('.mindmap-node[data-node-id="r2"] .mindmap-node-box').click();
        await page.waitForTimeout(60);
        // DOM フォーカスを body に落とす (実機で checkbox クリック/rerender 後に起きる状態を再現)
        await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); });
        const active = await page.evaluate(() => document.activeElement === document.body);
        expect(active).toBe(true); // counterfactual 前提: keydown は treeEl に届かない状態
        await page.keyboard.press('Meta+Shift+KeyX');
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r2')).toBe(false); // フォールバックが追加を処理
        // 削除側 (Alt) も body フォーカスで効く
        await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); });
        await page.keyboard.press('Meta+Shift+Alt+KeyX');
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r2')).toBe(null);
    });

    test('TC-MT-16 二重発火なし: node にフォーカスがある通常経路で toggle は 1 回だけ', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        // 通常経路 (TC-MT-04 と同じ): treeEl ハンドラが処理し document フォールバックは
        // e.defaultPrevented で skip するはず。二重発火なら null→false→true になる。
        await page.locator('.mindmap-node[data-node-id="r2"] .mindmap-node-box').click();
        await page.waitForTimeout(60);
        await page.keyboard.press('Meta+Shift+KeyX');
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r2')).toBe(false); // 1 回だけ (追加で止まる)
    });

    // ============ FR-MT-03: context menu ============

    test('TC-MT-07 右クリック → Add Checkbox が出て機能する', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        await page.locator('.mindmap-node[data-node-id="r2"] .mindmap-node-box').click({ button: 'right' });
        await page.waitForTimeout(100);
        const addItem = page.locator('.mindmap-ctx-item', { hasText: 'Add Checkbox' });
        await expect(addItem).toHaveCount(1);
        await addItem.click();
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r2')).toBe(false);
        // menu が閉じている
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-context-menu'))).toBe(false);
    });

    test('TC-MT-08 右クリック → Remove Checkbox / 空白右クリックには出ない', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        // checked=false の r1 → Remove Checkbox
        await page.locator('.mindmap-node[data-node-id="r1"] .mindmap-node-box').click({ button: 'right' });
        await page.waitForTimeout(100);
        const removeItem = page.locator('.mindmap-ctx-item', { hasText: 'Remove Checkbox' });
        await expect(removeItem).toHaveCount(1);
        await removeItem.click();
        await page.waitForTimeout(150);
        expect(await getChecked(page, 'r1')).toBe(null);
        // 空白右クリック → Add/Remove Checkbox 無し。
        // ノードが無い空白座標を実マウス (page.mouse) で右クリック
        // (locator.click は前面 svg の actionability 判定で timeout するため。実イベントには変わりない)
        const blank = await page.evaluate(() => {
            const t = document.querySelector('.outliner-tree') as HTMLElement;
            const r = t.getBoundingClientRect();
            return { x: r.left + 30, y: Math.min(r.bottom - 30, window.innerHeight - 30) };
        });
        await page.mouse.click(blank.x, blank.y, { button: 'right' });
        await page.waitForTimeout(100);
        const anyCb = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.mindmap-ctx-item'));
            return items.some((it) => /Add Checkbox|Remove Checkbox/.test(it.textContent || ''));
        });
        expect(anyCb).toBe(false);
    });

    // ============ FR-MT-04: task filter ============

    test('TC-MT-09 taskFilter=active で完了 subtree+線が消え、filter ボタン実クリックで復帰', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel({ taskFilter: 'active' }));
        // c1 (checked=true) とその子孫 g1 が描かれない
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="c1"]'))).toBe(false);
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="g1"]'))).toBe(false);
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="r1"]'))).toBe(true);
        // c1 への接続線も無い (links は positions 由来)
        const linkCountActive = await page.evaluate(() => document.querySelectorAll('.mindmap-link').length);
        // ヘッダーの filter ボタンを実クリックして 'all' へ → 再表示
        await page.locator('.outliner-task-filter-toggle-btn').click();
        await page.waitForTimeout(250);
        expect(await page.evaluate(() => (window as any).Outliner.getModel().taskFilter)).toBe('all');
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="c1"]'))).toBe(true);
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="g1"]'))).toBe(true);
        const linkCountAll = await page.evaluate(() => document.querySelectorAll('.mindmap-link').length);
        expect(linkCountAll).toBeGreaterThan(linkCountActive); // 線も戻る = active 時は線が消えていた
    });

    test('TC-MT-10 filter=active 中に checkbox クリックで完了化 → 即座に消える', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel({ taskFilter: 'active' }));
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="r1"]'))).toBe(true);
        await page.locator('.mindmap-node-checkbox[data-node-id="r1"]').click();
        await page.waitForTimeout(200);
        expect(await getChecked(page, 'r1')).toBe(true);
        // rerender 一体: r1 が mindmap から消える
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="r1"]'))).toBe(false);
    });

    // ============ FR-MT-05: header buttons ============

    test('TC-MT-11 task 3 ボタンは mindmap で有効・menu/nav/search-mode は disabled 維持 (部分 supersede 両面)', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        const state = await page.evaluate(() => {
            const q = (c: string) => { const e = document.querySelector(c) as HTMLElement | null; return e ? ((e as any).disabled === true || e.classList.contains('is-mindmap-disabled')) : null; };
            return {
                taskMode: q('.outliner-task-mode-toggle-btn'),
                taskFilter: q('.outliner-task-filter-toggle-btn'),
                archive: q('.outliner-archive-btn'),
                menu: q('.outliner-menu-btn'),
                navBack: q('.outliner-nav-back-btn'),
                searchModeToggle: q('.outliner-search-mode-toggle'),
            };
        });
        expect(state.taskMode).toBe(false);
        expect(state.taskFilter).toBe(false);
        expect(state.archive).toBe(false);
        // 部分 supersede: 残り 4 ボタン相当は disabled のまま (存在するもののみ)
        for (const k of ['menu', 'navBack', 'searchModeToggle'] as const) {
            if (state[k] !== null) { expect(state[k], `${k} stays disabled`).toBe(true); }
        }
    });

    test('TC-MT-12 mindmap でヘッダー Task Mode ボタン実クリック → root backfill + filter=active', async ({ page }) => {
        await setup(page);
        await toMindmap(page, {
            version: 1, viewMode: 'mindmap', title: '', rootIds: ['r1', 'r2'],
            nodes: { r1: node('r1', 'a', []), r2: node('r2', 'b', []) }
        });
        await page.locator('.outliner-task-mode-toggle-btn').click();
        await page.waitForTimeout(250);
        const m = await page.evaluate(() => {
            const mm = (window as any).Outliner.getModel();
            return { taskMode: mm.taskMode, taskFilter: mm.taskFilter, r1: mm.nodes.r1.checked, r2: mm.nodes.r2.checked };
        });
        expect(m.taskMode).toBe(true);
        expect(m.taskFilter).toBe('active');
        expect(m.r1).toBe(false); // backfill
        expect(m.r2).toBe(false);
        // mindmap にも checkbox が描かれる
        expect(await page.evaluate(() => document.querySelectorAll('.mindmap-node-checkbox').length)).toBe(2);
    });

    test('TC-MT-13 全 root 完了 + filter=active → 空状態 → filter ボタンで復帰 (US-MT-08)', async ({ page }) => {
        await setup(page);
        await toMindmap(page, {
            version: 1, viewMode: 'mindmap', title: '', taskFilter: 'active', rootIds: ['r1'],
            nodes: { r1: node('r1', 'done', [], null, { checked: true }) }
        });
        // 全滅 → 既存 .mindmap-empty
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-empty'))).toBe(true);
        // ヘッダー filter ボタンで復帰 (空状態でもヘッダーは操作可能)
        await page.locator('.outliner-task-filter-toggle-btn').click();
        await page.waitForTimeout(250);
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="r1"]'))).toBe(true);
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-empty'))).toBe(false);
    });

    test('TC-MT-14 view 往復でデータ不変 (NFR-MT-01): mindmap で変更 → outliner に一致', async ({ page }) => {
        await setup(page);
        await toMindmap(page, taskModel());
        await page.locator('.mindmap-node-checkbox[data-node-id="r1"]').click();
        await page.waitForTimeout(150);
        await page.evaluate(() => (window as any).Outliner.setViewMode('outliner'));
        await page.waitForTimeout(200);
        // outliner DOM の checkbox 状態が mindmap での変更を反映
        const outlinerChecked = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="r1"]') as HTMLElement;
            return el ? el.dataset.checked : null;
        });
        expect(outlinerChecked).toBe('true');
        expect(await getChecked(page, 'r1')).toBe(true);
    });
});
