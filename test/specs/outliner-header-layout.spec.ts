/**
 * outliner のヘッダーの並び（2026-11-05 ユーザー依頼）:
 * - undo / redo はタイトルの行の右端（search-bar の menu の真上あたり）。アイコンは md の toolbar と同じ LUCIDE_ICONS
 * - < >（nav back / forward）は検索欄の右
 * - outline / table / mindmap の切替は < > の右で、少し離す
 * TC-OHL-01 undo / redo がタイトルの行にあり、右端が menu の右端とそろう
 * TC-OHL-02 undo / redo のアイコンが md の toolbar の undo / redo と同じ
 * TC-OHL-03 検索欄 → < → > → view 切替 の順で、view 切替は > から 10px 以上離れる
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, title: 'header test', rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a' } } });
    });
});

test('TC-OHL-01 undo / redo はタイトルの行の右端（menu の右端とそろう）', async ({ page }) => {
    await expect(page.locator('.outliner-page-title .outliner-title-actions .outliner-undo-btn')).toHaveCount(1);
    await expect(page.locator('.outliner-page-title .outliner-title-actions .outliner-redo-btn')).toHaveCount(1);
    await expect(page.locator('.outliner-search-bar .outliner-undo-btn, .outliner-search-bar .outliner-redo-btn')).toHaveCount(0);
    const title = await page.locator('.outliner-page-title-input').boundingBox();
    const redo = await page.locator('.outliner-redo-btn').boundingBox();
    const menu = await page.locator('.outliner-menu-btn').boundingBox();
    // 同じ行（タイトルの縦の範囲の中）で、タイトルの入力欄の右
    expect(redo!.y + redo!.height / 2).toBeGreaterThan(title!.y);
    expect(redo!.y + redo!.height / 2).toBeLessThan(title!.y + title!.height);
    expect(redo!.x).toBeGreaterThan(title!.x + title!.width - 1);
    // 右端は menu の右端とそろう（同じ gutter）
    expect(Math.abs((redo!.x + redo!.width) - (menu!.x + menu!.width))).toBeLessThan(2);
});

test('TC-OHL-02 undo / redo のアイコンは md の toolbar と同じ', async ({ page }) => {
    const r = await page.evaluate(() => {
        const icons = (window as any).__editorUtils.LUCIDE_ICONS;
        // 文字列のまま比べると DOM の直列化（<path/> → <path></path>）で食い違うので、同じ経路で直列化してから比べる
        const norm = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.innerHTML; };
        return {
            undo: document.querySelector('.outliner-undo-btn')!.innerHTML === norm(icons.undo),
            redo: document.querySelector('.outliner-redo-btn')!.innerHTML === norm(icons.redo),
        };
    });
    expect(r).toEqual({ undo: true, redo: true });
});

test('TC-OHL-03 検索欄 → < → > → view 切替（> から少し離す）', async ({ page }) => {
    const order = await page.evaluate(() => Array.from(document.querySelector('.outliner-search-bar')!.children).map(e => e.className.split(' ')[0]));
    const i = (c: string) => order.indexOf(c);
    expect(i('outliner-search-input-wrapper')).toBeGreaterThanOrEqual(0);
    expect(i('outliner-nav-back-btn')).toBe(i('outliner-search-input-wrapper') + 1);
    expect(i('outliner-nav-forward-btn')).toBe(i('outliner-nav-back-btn') + 1);
    expect(i('outliner-view-toggle-btn')).toBe(i('outliner-nav-forward-btn') + 1);
    const fwd = await page.locator('.outliner-nav-forward-btn').boundingBox();
    const view = await page.locator('.outliner-view-toggle-btn').boundingBox();
    expect(view!.x - (fwd!.x + fwd!.width)).toBeGreaterThanOrEqual(10);
});
