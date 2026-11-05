/**
 * outliner のヘッダー（2026-11-05 ユーザー依頼）:
 * - 1 行目: ≡（パネル開閉）→ Recent の < >（Notes でパネルを閉じたときだけ）→ タイトル → 右端に undo / redo
 * - 2 行目: 集中ボタン → 検索欄 → ← →（表示の履歴）→ 少し離して outline / table / mindmap 切替 → 右端にタスク系 + menu
 * - スクロールしても 1 行目は消えない。2 行目と同じ高さに縮み、タイトルの文字が小さくなる（行の高さは変えないので本文はずれない）
 * - undo / redo のアイコンは md の toolbar と同じ LUCIDE_ICONS。← → は Recent の < > と見分ける
 * TC-OHL-01 undo / redo は 1 行目の右端（2 行目の menu の右端とそろう）
 * TC-OHL-02 undo / redo のアイコンが md の toolbar と同じ
 * TC-OHL-03 2 行目: 集中ボタン → 検索欄 → ← → → view 切替（→ から 10px 以上離す）。undo / redo は 2 行目に無い
 * TC-OHL-04 ← → のアイコン（Recent の < > と見分ける）
 * TC-OHL-05 スクロールすると 1 行目は 2 行目と同じ高さで残り、タイトルの文字が小さくなる。上へ戻すと元に戻る。スクロールの位置は揺れない
 */
import { test, expect, Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, title: 'header test', rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a' } } });
    });
});

test('TC-OHL-01 undo / redo は 1 行目の右端（2 行目の menu の右端とそろう）', async ({ page }) => {
    await expect(page.locator('.outliner-page-title .outliner-title-actions .outliner-undo-btn')).toHaveCount(1);
    await expect(page.locator('.outliner-page-title .outliner-title-actions .outliner-redo-btn')).toHaveCount(1);
    const title = await page.locator('.outliner-page-title-input').boundingBox();
    const redo = await page.locator('.outliner-redo-btn').boundingBox();
    const menu = await page.locator('.outliner-menu-btn').boundingBox();
    expect(redo!.y + redo!.height / 2).toBeGreaterThan(title!.y);
    expect(redo!.y + redo!.height / 2).toBeLessThan(title!.y + title!.height);
    expect(redo!.x).toBeGreaterThan(title!.x + title!.width - 1);
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

test('TC-OHL-03 2 行目: 集中ボタン → 検索欄 → ← → → view 切替（少し離す）。undo / redo は 2 行目に無い', async ({ page }) => {
    const order = await page.evaluate(() => Array.from(document.querySelector('.outliner-search-bar')!.children).map(e => e.className.split(' ')[0]));
    const i = (c: string) => order.indexOf(c);
    expect(order[0]).toBe('outliner-search-mode-toggle');
    expect(i('outliner-search-input-wrapper')).toBe(1);
    expect(i('outliner-nav-back-btn')).toBe(2);
    expect(i('outliner-nav-forward-btn')).toBe(3);
    expect(i('outliner-view-toggle-btn')).toBe(4);
    expect(i('outliner-undo-btn')).toBe(-1);
    expect(i('outliner-redo-btn')).toBe(-1);
    const fwd = await page.locator('.outliner-nav-forward-btn').boundingBox();
    const view = await page.locator('.outliner-view-toggle-btn').boundingBox();
    expect(view!.x - (fwd!.x + fwd!.width)).toBeGreaterThanOrEqual(10);
});

test('TC-OHL-04 ← → のアイコン（Recent の Back / Forward の < > と見分ける）', async ({ page }) => {
    const r = await page.evaluate(() => {
        const paths = (sel: string) => Array.from(document.querySelectorAll(sel + ' svg path, ' + sel + ' svg polyline')).map(e => e.getAttribute('d') || e.getAttribute('points'));
        return { back: paths('.outliner-nav-back-btn'), fwd: paths('.outliner-nav-forward-btn') };
    });
    expect(r.back).toEqual(['m12 19-7-7 7-7', 'M19 12H5']);
    expect(r.fwd).toEqual(['M5 12h14', 'm12 5 7 7-7 7']);
});

/** 縦に流れる .outliner-scroll-content と sticky の行は、本番と同じ構造の Notes の harness で確かめる */
async function setupLongNotesOutliner(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate(() => {
        const nodes: any = {}; const rootIds: string[] = [];
        for (let i = 0; i < 120; i++) { const id = 'n' + i; rootIds.push(id); nodes[id] = { id, parentId: null, children: [], text: 'line ' + i }; }
        (window as any).__testApi.initOutliner({ version: 1, title: 'long', rootIds, nodes });
    });
    await page.waitForSelector('.outliner-node');
    await page.waitForTimeout(300); // 初期化の後の focus / scrollIntoView が済むのを待つ
}
/** スクロールと位置の取得は同じ evaluate の中で（間に再描画が入って戻されないように） */
async function scrollAndMeasure(page: Page, top: number) {
    return page.evaluate(async (t) => {
        const sc = document.querySelector('.outliner-container .outliner-scroll-content') as HTMLElement;
        sc.scrollTop = t;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON();
        const title = rect('.outliner-container .outliner-page-title');
        const box = sc.getBoundingClientRect();
        return {
            scrollTop: sc.scrollTop,
            compact: document.querySelector('.outliner-container')!.classList.contains('outliner-title-compact'),
            visibleTitleH: Math.min(title.bottom, box.bottom) - Math.max(title.top, box.top),
            search: rect('.outliner-container .outliner-search-bar'),
            undo: rect('.outliner-container .outliner-undo-btn'),
            input: rect('.outliner-container .outliner-page-title-input'),
            fontPx: parseFloat(getComputedStyle(document.querySelector('.outliner-container .outliner-page-title-input')!).fontSize),
            boxTop: box.top,
        };
    }, top);
}

test('TC-OHL-05 スクロールすると 1 行目は 2 行目と同じ高さで残り、タイトルが小さくなる。上へ戻すと元に戻る', async ({ page }) => {
    await setupLongNotesOutliner(page);
    const top0 = await scrollAndMeasure(page, 0);
    expect(top0.compact).toBe(false);
    const down = await scrollAndMeasure(page, 600);
    expect(down.scrollTop, 'スクロールの位置は揺れない（行の高さを変えないので）').toBe(600);
    expect(down.compact).toBe(true);
    // 1 行目は消えずに、2 行目と同じ高さで一番上に残る。2 行目はその直下
    expect(Math.abs(down.visibleTitleH - down.search.height)).toBeLessThan(1.5);
    expect(Math.abs(down.search.top - (down.boxTop + down.visibleTitleH))).toBeLessThan(1.5);
    // undo と タイトルは見える範囲（1 行目の中）にある
    expect(down.undo.top).toBeGreaterThanOrEqual(down.boxTop - 0.5);
    expect(down.undo.bottom).toBeLessThanOrEqual(down.search.top + 0.5);
    expect(down.input.top).toBeGreaterThanOrEqual(down.boxTop - 0.5);
    expect(down.input.bottom).toBeLessThanOrEqual(down.search.top + 0.5);
    // タイトルの文字は小さくなる
    expect(down.fontPx).toBeLessThan(top0.fontPx);
    // 上へ戻すと元の高さ・大きさ
    const back = await scrollAndMeasure(page, 0);
    expect(back.compact).toBe(false);
    expect(back.fontPx).toBe(top0.fontPx);
    expect(Math.abs(back.visibleTitleH - top0.visibleTitleH)).toBeLessThan(0.5);
});
