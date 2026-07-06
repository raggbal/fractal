/**
 * Mindmap iteration 25 — active 太枠の一貫性 (Wave 30 / TASK-68)
 *   TC-M16: click で太枠 (is-selected) になったノードが、矢印/Enter/Tab で active が別ノードへ
 *           移った後も太枠のまま残る問題を解消。active(=is-focused) 移動で複数選択をクリアし、
 *           移動先のみ太枠にする。shift+click の複数選択は維持 (TC-M14 回帰)。
 *
 * 根本原因 (session-log「iteration 25」): focusNode() は is-focused を張り替えるが selected を
 *   触らないため、click A (selected={A}, iter24 で is-selected=太枠) → 矢印で focusNode(B) しても
 *   selected は {A} のまま → A が太枠残留。→ focusNode(nodeId, startEdit, keepSelection) で
 *   keepSelection 省略時に selected.clear()+add(nodeId)+paintSelection() を実行 (active 移動でクリア)。
 *
 * テスト方針 (generator_failures 2026-07-02 厳守): el.focus() 直呼び禁止。実クリック→実キー。
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

async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
}

function classesOf(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((id) => {
        const fo = document.querySelector('.mindmap-node[data-node-id="' + id + '"]');
        const box = fo && fo.querySelector('.mindmap-node-box') as HTMLElement;
        return box ? box.className : '(none)';
    }, id);
}

function selectedCount(page: import('@playwright/test').Page) {
    return page.evaluate(() => document.querySelectorAll('.mindmap-node-box.is-selected').length);
}

function model() {
    // a (子 a1,a2) + b
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['a', 'b'],
        nodes: {
            a: node('a', 'AAA', ['a1', 'a2']),
            a1: node('a1', 'A1', [], 'a'),
            a2: node('a2', 'A2', [], 'a'),
            b: node('b', 'BBB'),
        },
    };
}

test('TC-M16 矢印で active 移動すると古い太枠が消え、移動先のみ太枠', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());

    // (1) a を click → a が is-selected (太枠)
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    expect(await classesOf(page, 'a')).toContain('is-selected');
    expect(await selectedCount(page)).toBe(1);

    // (2) 矢印で active を別ノードへ移動 (a には子 a1,a2 と兄弟 b があるのでいずれかへ動く)
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
    // a はもう太枠でない
    expect(await classesOf(page, 'a')).not.toContain('is-selected');
    // 太枠は 1 個だけ (移動先のみ)
    expect(await selectedCount(page)).toBe(1);
    // 移動先は is-selected かつ is-focused
    const movedId = await page.evaluate(() => {
        const b = document.querySelector('.mindmap-node-box.is-selected') as HTMLElement;
        const fo = b && b.closest('.mindmap-node');
        return fo ? fo.getAttribute('data-node-id') : null;
    });
    expect(movedId).not.toBe('a');
    expect(await classesOf(page, movedId!)).toContain('is-focused');
});

test('TC-M16 Tab で子追加すると新ノードのみ太枠、親の太枠は消える', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    expect(await classesOf(page, 'b')).toContain('is-selected');

    await page.keyboard.press('Tab'); // b の子を追加 → 新ノードが active
    await page.waitForTimeout(150);
    // b はもう太枠でない、太枠は 1 個 (新規子ノード)
    expect(await classesOf(page, 'b')).not.toContain('is-selected');
    expect(await selectedCount(page)).toBe(1);
});

test('TC-M16 load-bearing: active 移動で selected をクリアしないと旧ノードが太枠のまま残る', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    // 反実仮想: 現行修正が効いていれば ArrowDown 後に太枠は 1 個。
    // (fix を外すと a が残って 2 個になる — その状態を検出するのが本 assert の主旨)
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
    const cnt = await selectedCount(page);
    // 修正後は必ず 1。もし 2 以上なら「active 移動で旧太枠が残っている」= 退行。
    expect(cnt).toBe(1);
});

test('TC-M16 回帰: shift+click の複数選択は維持される (active 移動クリアの巻き添えにしない)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.locator('.mindmap-node[data-node-id="b"] .mindmap-node-box').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(120);
    // a・b 両方 is-selected (複数選択維持)
    expect(await classesOf(page, 'a')).toContain('is-selected');
    expect(await classesOf(page, 'b')).toContain('is-selected');
    expect(await selectedCount(page)).toBe(2);
});
