/**
 * Mindmap iteration 28 — 矢印移動で「編集モードに見える」バグの是正 (Wave 33 / TASK-73)
 *   TC-M21: committed active ノード (矢印/click で選択中・非編集) は caret を出さない
 *           (is-editing でない間 caret-color:transparent)。編集に入る (is-editing) と caret 表示。
 *
 * 根本原因 (session-log「iteration 28」): iteration 27 で committed active を contenteditable=true に
 *   した (IME 合成のため) が、focus された contenteditable は caret が点滅し「編集モードに見える」。
 *   矢印移動で移動先が編集モードのように見えた。→ CSS で is-editing でない間 caret を透明化
 *   (contenteditable=true は維持 = IME hiragana type-to-edit は引き続き動く)。編集へ入る
 *   (is-editing 付与) と caret 表示。
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
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(JSON.parse(JSON.stringify(d))); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(250);
}

function nodeStyle(page: import('@playwright/test').Page, id: string) {
    return page.evaluate((nid) => {
        const t = document.querySelector(`.mindmap-node-text[data-node-id="${nid}"]`) as HTMLElement;
        if (!t) { return null; }
        const cs = getComputedStyle(t);
        return { editing: t.classList.contains('is-editing'), caret: cs.caretColor, ce: t.getAttribute('contenteditable') };
    }, id);
}

function model() {
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

function isTransparent(caret: string) {
    // rgba(0,0,0,0) や transparent 相当
    return /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(caret) || caret === 'transparent';
}

test('TC-M21 committed active (click) は caret を出さない (編集モードに見えない)', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    const st = await nodeStyle(page, 'a');
    // IME 合成のため contenteditable=true だが、is-editing でなく caret は透明 (編集に見えない)。
    expect(st!.ce).toBe('true');
    expect(st!.editing).toBe(false);
    expect(isTransparent(st!.caret)).toBe(true);
});

test('TC-M21 矢印移動した先も caret を出さない (編集モードに見えない) ★iter28 核心', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
    // 移動先 (active) を特定
    const movedId = await page.evaluate(() => {
        const b = document.querySelector('.mindmap-node-box.is-focused');
        const fo = b && b.closest('.mindmap-node');
        return fo ? fo.getAttribute('data-node-id') : null;
    });
    expect(movedId).not.toBeNull();
    const st = await nodeStyle(page, movedId!);
    // 移動先は非編集 (is-editing なし) で caret 透明 = 編集モードに見えない。
    expect(st!.editing).toBe(false);
    expect(isTransparent(st!.caret)).toBe(true);
});

test('TC-M21 編集に入ると (Space) caret が表示される', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(80);
    await page.keyboard.press('Space'); // 編集開始
    await page.waitForTimeout(100);
    const st = await nodeStyle(page, 'a');
    expect(st!.editing).toBe(true);
    // caret が可視 (透明でない)。
    expect(isTransparent(st!.caret)).toBe(false);
});

test('TC-M21 load-bearing: caret 透明化を外すと committed active でも caret が可視になる', async ({ page }) => {
    await setup(page);
    await toMindmap(page, model());
    // 反実仮想: caret 透明ルールを打ち消す (fix を無効化) → committed でも caret 可視。
    await page.evaluate(() => {
        const st = document.createElement('style');
        st.textContent = '.mindmap-node-text[contenteditable="true"]:not(.is-editing){caret-color:rgb(34,34,34) !important;}';
        document.head.appendChild(st);
    });
    await page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-box').click();
    await page.waitForTimeout(100);
    const st = await nodeStyle(page, 'a');
    expect(st!.editing).toBe(false);
    // 無効化すると caret が可視 (= fix が load-bearing)。
    expect(isTransparent(st!.caret)).toBe(false);
});
