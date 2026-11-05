/**
 * outliner のヘッダーの並び（2026-11-05 ユーザー依頼。タイトルの行はスクロールで消えるので undo / redo は search-bar に置く）:
 * - < >（nav back / forward）は検索欄の右
 * - outline / table / mindmap の切替は < > の右で、少し離す
 * - undo / redo は切替の右で、また少し離す。アイコンは md の toolbar と同じ LUCIDE_ICONS
 * TC-OHL-01 undo / redo は sticky の search-bar の中（タイトルの行には無い）。スクロールしても見える
 * TC-OHL-02 undo / redo のアイコンが md の toolbar の undo / redo と同じ
 * TC-OHL-03 検索欄 → < → > → view 切替 → undo → redo の順で、切替は > から・undo は切替から 10px 以上離れる
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, title: 'header test', rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a' } } });
    });
});

test('TC-OHL-01 undo / redo は sticky の search-bar の中（スクロールしても見える）', async ({ page }) => {
    await expect(page.locator('.outliner-search-bar .outliner-undo-btn')).toHaveCount(1);
    await expect(page.locator('.outliner-search-bar .outliner-redo-btn')).toHaveCount(1);
    await expect(page.locator('.outliner-page-title .outliner-undo-btn, .outliner-page-title .outliner-redo-btn')).toHaveCount(0);
    // 長い tree にして下までスクロールしても undo は画面の中に残る（タイトルの行は流れて消える）。
    // 縦に流れる .outliner-scroll-content と sticky の search-bar は本番と同じ構造の Notes の harness で確かめる
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate(() => {
        const nodes: any = {}; const rootIds: string[] = [];
        for (let i = 0; i < 120; i++) { const id = 'n' + i; rootIds.push(id); nodes[id] = { id, parentId: null, children: [], text: 'line ' + i }; }
        (window as any).__testApi.initOutliner({ version: 1, title: 'long', rootIds, nodes });
    });
    await page.waitForSelector('.outliner-node');
    await page.waitForTimeout(300); // 初期化の後の focus / scrollIntoView が済むのを待つ
    // スクロールと位置の取得は同じ evaluate の中で行う（間に再描画が入って戻されないように）
    const r = await page.evaluate(() => {
        const sc = document.querySelector('.outliner-container .outliner-scroll-content') as HTMLElement;
        sc.scrollTop = sc.scrollHeight;
        const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON();
        return {
            scrollTop: sc.scrollTop,
            box: sc.getBoundingClientRect().toJSON(),
            undo: rect('.outliner-container .outliner-undo-btn'),
            title: rect('.outliner-container .outliner-page-title'),
        };
    });
    expect(r.scrollTop).toBeGreaterThan(0);
    expect(r.undo.top).toBeGreaterThanOrEqual(r.box.top);
    expect(r.undo.bottom).toBeLessThanOrEqual(r.box.bottom);
    expect(r.title.bottom).toBeLessThanOrEqual(r.box.top + 1); // タイトルの行は scroll の上へ流れて見えない
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

test('TC-OHL-03 検索欄 → < → > → view 切替 → undo → redo（それぞれ少し離す）', async ({ page }) => {
    const order = await page.evaluate(() => Array.from(document.querySelector('.outliner-search-bar')!.children).map(e => e.className.split(' ')[0]));
    const i = (c: string) => order.indexOf(c);
    expect(i('outliner-search-input-wrapper')).toBeGreaterThanOrEqual(0);
    expect(i('outliner-nav-back-btn')).toBe(i('outliner-search-input-wrapper') + 1);
    expect(i('outliner-nav-forward-btn')).toBe(i('outliner-nav-back-btn') + 1);
    expect(i('outliner-view-toggle-btn')).toBe(i('outliner-nav-forward-btn') + 1);
    expect(i('outliner-undo-btn')).toBe(i('outliner-view-toggle-btn') + 1);
    expect(i('outliner-redo-btn')).toBe(i('outliner-undo-btn') + 1);
    const fwd = await page.locator('.outliner-nav-forward-btn').boundingBox();
    const view = await page.locator('.outliner-view-toggle-btn').boundingBox();
    const undo = await page.locator('.outliner-undo-btn').boundingBox();
    expect(view!.x - (fwd!.x + fwd!.width)).toBeGreaterThanOrEqual(10);
    expect(undo!.x - (view!.x + view!.width)).toBeGreaterThanOrEqual(10);
});
