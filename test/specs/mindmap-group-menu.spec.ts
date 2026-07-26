/**
 * Mindmap Group 右クリックメニュー — sprint 20260727-080242-mindmap-group-context-menu
 * TC-GC-01〜05 (testcases.md)
 *
 * FR-GC-01: group 枠右クリックで Group 用メニュー（従来は「空白扱い」に落ち Create Group が
 * 出るバグだった）。FR-GC-02: Rename Group…（prompt）。FR-GC-03: Delete Group。
 *
 * 実クリック / 実右クリック（click({button:'right'})）で駆動（dispatchEvent 禁止）。
 * Rename はカスタムダイアログ（.outliner-add-col-dialog — window.prompt は VS Code webview で
 * ブロックされるため不使用。outliner の列 rename と同型）を実操作。
 */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 900, height: 700 } });

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function node(id: string, text: string, children: string[] = [], parentId: string | null = null) {
    return { id, parentId, children, text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] };
}

/** r1/r2 の 2 ノード + それを囲む group 1 個（label は引数） */
async function toMindmapWithGroup(page: import('@playwright/test').Page, label = '') {
    await page.evaluate((lbl) => {
        (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify({
            version: 1, viewMode: 'mindmap', title: '',
            rootIds: ['r1', 'r2'],
            nodes: {
                r1: { id: 'r1', parentId: null, children: [], text: 'alpha', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                r2: { id: 'r2', parentId: null, children: [], text: 'beta', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            },
            mindmap: { layout: 'right', groups: [{ id: 'g1', nodeIds: ['r1', 'r2'], label: lbl, color: null }] },
        })));
        (window as any).Outliner.setViewMode('mindmap');
    }, label);
    await page.waitForTimeout(300);
}

function groups(page: import('@playwright/test').Page) {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).Outliner.getModel().mindmap.groups || [])));
}

/** group 枠のノードが重なっていない部分（rect 上端付近）を右クリック */
async function rightClickGroupRect(page: import('@playwright/test').Page) {
    const pt = await page.evaluate(() => {
        const rect = document.querySelector('.mindmap-group-rect') as SVGRectElement;
        const r = rect.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 4 }; // 上端はノードと重ならない padding 帯
    });
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await page.waitForTimeout(120);
}

function menuLabels(page: import('@playwright/test').Page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.mindmap-context-menu .mindmap-ctx-item')).map((e) => e.textContent));
}

test.describe('Mindmap Group context menu', () => {

    test('TC-GC-01 ★バグ counterfactual: group 枠右クリック → Rename/Delete が出て Create Group が出ない', async ({ page }) => {
        await setup(page);
        await toMindmapWithGroup(page);
        // 事前にノードをクリック選択（修正前バグの発火条件: 選択があると Create Group (N) が出る）
        await page.locator('.mindmap-node[data-node-id="r1"] .mindmap-node-box').click();
        await page.waitForTimeout(80);
        await rightClickGroupRect(page);
        const labels = await menuLabels(page);
        expect(labels.some((l) => /Rename Group/.test(l || ''))).toBe(true);
        expect(labels.some((l) => /Delete Group/.test(l || ''))).toBe(true);
        // counterfactual: 修正前は「空白扱い」に落ちて Create Group が出ていた
        expect(labels.some((l) => /Create Group/.test(l || ''))).toBe(false);
        expect(labels.some((l) => /Fit to screen/.test(l || ''))).toBe(false);
    });

    test('TC-GC-02 Rename Group: ダイアログ入力で label 設定 + 表示 + Cmd+Z で戻る', async ({ page }) => {
        await setup(page);
        await toMindmapWithGroup(page);
        await rightClickGroupRect(page);
        await page.locator('.mindmap-ctx-item', { hasText: 'Rename Group' }).click();
        // カスタムダイアログに実入力 → Save
        const input = page.locator('.outliner-add-col-dialog .outliner-add-col-name');
        await expect(input).toBeVisible();
        await input.fill('Sprint Q1');
        await page.locator('.outliner-add-col-dialog button', { hasText: 'Save' }).click();
        await page.waitForTimeout(200);
        let g = await groups(page);
        expect(g[0].label).toBe('Sprint Q1');
        // 枠左上の label 表示
        const shown = await page.evaluate(() => document.querySelector('.mindmap-group-label')?.textContent);
        expect(shown).toBe('Sprint Q1');
        // undo で旧値（空）に戻る
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);
        g = await groups(page);
        expect(g[0].label || '').toBe('');
    });

    test('TC-GC-03 Rename: 初期値 = 現 label / 空文字 + Enter で消去 / Esc で変更なし', async ({ page }) => {
        await setup(page);
        await toMindmapWithGroup(page, 'OldName');
        // 1) 初期値の確認 + 空文字（Enter 確定）で消去
        await rightClickGroupRect(page);
        await page.locator('.mindmap-ctx-item', { hasText: 'Rename Group' }).click();
        const input = page.locator('.outliner-add-col-dialog .outliner-add-col-name');
        await expect(input).toBeVisible();
        expect(await input.inputValue()).toBe('OldName'); // 初期値 = 現 label
        await input.fill('');
        await input.press('Enter');
        await page.waitForTimeout(200);
        let g = await groups(page);
        expect(g[0].label).toBe('');
        expect(g.length).toBe(1); // 枠は残る
        // 2) Esc キャンセルで変更なし
        await page.evaluate(() => { const m = (window as any).Outliner.getModel(); m.mindmap.groups[0].label = 'Keep'; });
        await rightClickGroupRect(page);
        await page.locator('.mindmap-ctx-item', { hasText: 'Rename Group' }).click();
        await expect(input).toBeVisible();
        await input.fill('Discarded');
        await input.press('Escape');
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => !!document.querySelector('.outliner-add-col-dialog'))).toBe(false);
        g = await groups(page);
        expect(g[0].label).toBe('Keep');
    });

    test('TC-GC-04 Delete Group: 枠が消えメンバーノードは残る', async ({ page }) => {
        await setup(page);
        await toMindmapWithGroup(page, 'ToDelete');
        await rightClickGroupRect(page);
        await page.locator('.mindmap-ctx-item', { hasText: 'Delete Group' }).click();
        await page.waitForTimeout(200);
        const g = await groups(page);
        expect(g.length).toBe(0);
        // メンバーノードは残る
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="r1"]'))).toBe(true);
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-node[data-node-id="r2"]'))).toBe(true);
        expect(await page.evaluate(() => !!document.querySelector('.mindmap-group'))).toBe(false);
    });

    test('TC-GC-05 非回帰: ノード右クリック / 空白右クリック / group 選択 + Delete キー', async ({ page }) => {
        await setup(page);
        await toMindmapWithGroup(page);
        // ノード右クリック → Create Group / Shape 等の従来メニュー
        await page.locator('.mindmap-node[data-node-id="r1"] .mindmap-node-box').click({ button: 'right' });
        await page.waitForTimeout(120);
        let labels = await menuLabels(page);
        expect(labels.some((l) => /Create Group/.test(l || ''))).toBe(true);
        expect(labels.some((l) => /Shape:/.test(l || ''))).toBe(true);
        expect(labels.some((l) => /Rename Group/.test(l || ''))).toBe(false);
        await page.keyboard.press('Escape');
        await page.evaluate(() => document.body.click());
        await page.waitForTimeout(80);
        // 空白右クリック → Fit to screen（group/node 外）
        const blank = await page.evaluate(() => {
            const t = document.querySelector('.outliner-tree') as HTMLElement;
            const r = t.getBoundingClientRect();
            return { x: r.left + 20, y: Math.min(r.bottom - 20, window.innerHeight - 20) };
        });
        await page.mouse.click(blank.x, blank.y, { button: 'right' });
        await page.waitForTimeout(120);
        labels = await menuLabels(page);
        expect(labels.some((l) => /Fit to screen/.test(l || ''))).toBe(true);
        await page.evaluate(() => document.body.click());
        await page.waitForTimeout(80);
        // group クリック選択 + Delete キー削除（既存経路）
        const pt = await page.evaluate(() => {
            const rect = document.querySelector('.mindmap-group-rect') as SVGRectElement;
            const r = rect.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + 4 };
        });
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(120);
        await page.keyboard.press('Delete');
        await page.waitForTimeout(200);
        expect((await groups(page)).length).toBe(0);
    });
});
