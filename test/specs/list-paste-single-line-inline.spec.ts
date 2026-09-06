/**
 * 2026-09-04 ユーザー裁定 — md editor のリスト項目内で **1 行**を paste したら、ソースが別リストの行 /
 * 見出し / 引用 / 番号付きでも「普通のテキスト」として caret 位置へ inline 挿入する。
 * 複数行 / 段落（非リスト）への paste は従来どおり。
 *
 * TC-LPP-03..08。
 * 🔴 counterfactual: 実装前は `- gamma` → 新規 li / `<h1>` → リスト直下に h1 ブロック（ユーザー実機報告）。
 */
import { test, expect, Page } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

async function simulatePaste(page: Page, html: string, plainText: string) {
    await page.evaluate(({ html, text }) => {
        const editor = document.getElementById('editor')!;
        const clipboardData = {
            _data: { 'text/plain': text || '', 'text/html': html || '' } as Record<string, string>,
            getData(type: string) { return this._data[type] || ''; },
            setData(type: string, v: string) { this._data[type] = v; },
            items: [],
        };
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        Object.defineProperty(event, 'clipboardData', { value: clipboardData, writable: false, configurable: true });
        editor.dispatchEvent(event);
    }, { html, text: plainText });
    await page.waitForTimeout(120);
}

/** `- alpha` / `- beta` のリストを作り、alpha の text node の offset に caret を置く。 */
async function setupList(page: Page, editor: EditorTestHelper, offset: number) {
    await editor.setMarkdown('- alpha\n- beta');
    await page.waitForTimeout(100);
    await page.evaluate((off) => {
        const li = document.querySelector('#editor li') as HTMLElement;
        const tn = li.firstChild as Text;
        const r = document.createRange();
        r.setStart(tn, Math.min(off, tn.textContent!.length));
        r.collapse(true);
        const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    }, offset);
}

test.describe('リスト項目内の 1 行 paste は普通のテキスト（2026-09-04）', () => {
    let editor: EditorTestHelper;
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    test('TC-LPP-03 別リストの 1 行（- gamma）を li 末尾に paste → 同じ li の続きに inline（新規 li を作らない）', async ({ page }) => {
        await setupList(page, editor, 5);
        await simulatePaste(page, '<ul><li>gamma</li></ul>', '- gamma');
        const md = await editor.getMarkdown();
        expect(md.trim(), `md=${JSON.stringify(md)}`).toBe('- alphagamma\n- beta');
        expect(await page.locator('#editor li').count(), 'li が増えている').toBe(2);
    });

    test('TC-LPP-04 見出し（<h1>Title</h1> / # Title）を li に paste → # なしの普通のテキスト・h1 ブロックを作らない', async ({ page }) => {
        await setupList(page, editor, 5);
        await simulatePaste(page, '<h1>Title</h1>', '# Title');
        const md = await editor.getMarkdown();
        expect(md.trim(), `md=${JSON.stringify(md)}`).toBe('- alphaTitle\n- beta');
        expect(await page.locator('#editor h1').count(), 'h1 ブロックが出来ている（実機報告の症状）').toBe(0);
    });

    test('TC-LPP-05 caret が語の途中でも、そこから普通のテキストとして入る（引用 / 番号付き / チェックボックス）', async ({ page }) => {
        await setupList(page, editor, 2);   // "al|pha"
        await simulatePaste(page, '', '> quoted');
        expect((await editor.getMarkdown()).trim()).toBe('- alquotedpha\n- beta');

        await setupList(page, editor, 2);
        await simulatePaste(page, '<ol><li>one</li></ol>', '1. one');
        expect((await editor.getMarkdown()).trim()).toBe('- alonepha\n- beta');

        await setupList(page, editor, 5);
        await simulatePaste(page, '', '- [ ] task');
        expect((await editor.getMarkdown()).trim()).toBe('- alphatask\n- beta');
    });

    test('TC-LPP-06 inline 記法は保たれる（**bold** を paste すると bold のまま）', async ({ page }) => {
        await setupList(page, editor, 5);
        await simulatePaste(page, '<ul><li><strong>bold</strong></li></ul>', '- **bold**');
        const md = await editor.getMarkdown();
        expect(md.trim()).toBe('- alpha**bold**\n- beta');
        expect(await page.locator('#editor li strong').count()).toBe(1);
    });

    test('TC-LPP-07 regression: 複数行の paste は従来どおり兄弟 li になる', async ({ page }) => {
        await setupList(page, editor, 5);
        await simulatePaste(page, '<ul><li>x</li><li>y</li></ul>', '- x\n- y');
        const md = await editor.getMarkdown();
        expect(md.trim(), `md=${JSON.stringify(md)}`).toBe('- alpha\n- x\n- y\n- beta');
    });

    test('TC-LPP-08 regression: 段落（非リスト）へ `- gamma` を paste すると従来どおりリストになる', async ({ page }) => {
        await editor.setMarkdown('hello');
        await page.waitForTimeout(100);
        await page.evaluate(() => {
            const p = document.querySelector('#editor p') as HTMLElement;
            const r = document.createRange(); r.setStart(p.firstChild!, 5); r.collapse(true);
            const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
        });
        await simulatePaste(page, '<ul><li>gamma</li></ul>', '- gamma');
        expect(await page.locator('#editor li').count(), '段落への list paste は list のまま').toBe(1);
        expect(await page.locator('#editor h1').count()).toBe(0);
    });
});
