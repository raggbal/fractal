/**
 * list-optenter-wrap — opt+enter の折り返し子ノード（sprint 20260730-071730）
 *
 * FR-LOE-01: カーソルが行途中なら、カーソル以降を子リスト項目へ折り返す。
 * FR-LOE-02: 行末なら従来どおり空の子（挙動不変）。
 * FR-LOE-03: 子リストの型は親タグ継承（既存ルール）。
 *
 * TC 定義: .harness/sprint/20260730-071730-list-optenter-wrap-olbackspace/testcases.md
 */

import { test, expect } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

// li 内テキストノードの絶対 offset にカーソルを置く（テキスト分割位置指定用）
async function placeCursorInFirstLi(page: any, offset: number) {
    await page.evaluate((off: number) => {
        const li = document.querySelector('#editor li')!;
        const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) =>
                (n.parentElement?.closest('ul, ol') === li.parentElement?.closest('ul, ol') ||
                 !n.parentElement?.closest('li li'))
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        });
        let remaining = off;
        let node = walker.nextNode();
        while (node) {
            const len = node.textContent!.length;
            if (remaining <= len) break;
            remaining -= len;
            node = walker.nextNode();
        }
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(node!, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }, offset);
}

test.describe('opt+enter 折り返し子ノード', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    // TC-LW-01 ★load-bearing・counterfactual: 折り返し実装を外す（旧: 常に空の子）と bbbbb が親に残り RED
    test('TC-LW-01: 行途中 opt+enter で折り返し子ノード + カーソル子先頭', async ({ page }) => {
        await editor.setMarkdown('- aaaabbbbb');
        await page.waitForTimeout(200);
        await placeCursorInFirstLi(page, 4);
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(200);

        const md = await editor.getMarkdown();
        expect(md).toContain('- aaaa');
        expect(md).toMatch(/\n\s+- bbbbb/);
        expect(md).not.toContain('aaaabbbbb');

        // カーソルは子 li の先頭（打鍵が bbbbb の前に入る）
        await page.keyboard.type('X');
        await page.waitForTimeout(200);
        const md2 = await editor.getMarkdown();
        expect(md2).toMatch(/\n\s+- Xbbbbb/);
    });

    // TC-LW-02: 行末は従来どおり空の子（既存挙動の番人。integration-md-opt-enter-child-list.spec と同義）
    test('TC-LW-02: 行末 opt+enter は空の子（従来）', async ({ page }) => {
        await editor.setMarkdown('- aaaa');
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const textNode = li.firstChild!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(textNode, textNode.textContent!.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(200);

        const structure = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const nested = li.querySelector(':scope > ul, :scope > ol');
            const childLi = nested?.querySelector('li');
            return {
                parentText: li.firstChild?.textContent,
                hasNested: !!nested,
                childIsEmpty: childLi ? childLi.textContent!.trim() === '' : null,
            };
        });
        expect(structure.parentText).toBe('aaaa');
        expect(structure.hasNested).toBe(true);
        expect(structure.childIsEmpty).toBe(true);
    });

    // TC-LW-03 ★load-bearing: inline 要素を跨ぐ折り返しで要素保全（ADRL-LST-3 extractContents）
    test('TC-LW-03: inline 要素（link/bold）を跨ぐ折り返しで保全', async ({ page }) => {
        await editor.setMarkdown('- aa [link](http://x/) bb **bold** cc');
        await page.waitForTimeout(200);
        // 「bb」の直前 = rendered テキスト "aa link bb bold cc" の offset。
        // li 内の実テキストで「 bb」の b の位置を DOM から特定して置く
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            // link アンカーの直後のテキストノード（" bb "）の offset 1（スペースの後）
            const anchor = li.querySelector('a')!;
            const after = anchor.nextSibling!; // " bb " テキストノード
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(after, 1); // " |bb ..."
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(200);

        const md = await editor.getMarkdown();
        // 親に link が残り、子に bold が生きて移る
        expect(md).toContain('[link](http://x/)');
        expect(md).toMatch(/\n\s+- bb \*\*bold\*\* cc/);
    });

    // TC-LW-04: img を含む後半の折り返しで img 保全（NFR-LST-02。textContent 空判定の穴の番人）
    test('TC-LW-04: img を含む後半の折り返しで img が生存', async ({ page }) => {
        const imgCount = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ul><li>text<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="pic"></li></ul>';
            const li = ed.querySelector('li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 2); // "te|xt<img>"
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            return ed.querySelectorAll('img').length;
        });
        expect(imgCount).toBe(1);
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(200);

        const after = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const nested = ed.querySelector('li > ul, li > ol');
            return {
                imgCount: ed.querySelectorAll('img').length,
                imgInChild: !!nested?.querySelector('img'),
            };
        });
        expect(after.imgCount).toBe(1); // img が消えない
        expect(after.imgInChild).toBe(true); // 子に移動
    });

    // TC-LW-05: nested list 持ち li の行途中 → 折り返しは既存 nested の先頭・child1 不動
    test('TC-LW-05: nested list 持ち li の折り返しは nested 先頭に挿入', async ({ page }) => {
        await editor.setMarkdown('- aaaabbbbb\n  - child1');
        await page.waitForTimeout(200);
        await placeCursorInFirstLi(page, 4);
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(200);

        const md = await editor.getMarkdown();
        const bIdx = md.indexOf('- bbbbb');
        const cIdx = md.indexOf('- child1');
        expect(bIdx).toBeGreaterThan(-1);
        expect(cIdx).toBeGreaterThan(-1);
        expect(bIdx).toBeLessThan(cIdx); // bbbbb が child1 より先（nested 先頭）
        expect(md).toContain('- aaaa');
    });

    // TC-LW-06: ol 項目での折り返しは子も ol（FR-LOE-03 親タグ継承）
    test('TC-LW-06: ol 項目の折り返しは子リストも ol', async ({ page }) => {
        await editor.setMarkdown('1. aaaabbbbb');
        await page.waitForTimeout(200);
        await placeCursorInFirstLi(page, 4);
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(200);

        const structure = await page.evaluate(() => {
            const li = document.querySelector('#editor ol > li')!;
            const nested = li.querySelector(':scope > ul, :scope > ol');
            return { nestedTag: nested?.tagName.toLowerCase(), childText: nested?.querySelector('li')?.textContent };
        });
        expect(structure.nestedTag).toBe('ol');
        expect(structure.childText).toBe('bbbbb');
    });

    // TC-LW-07: undo 1 手で元の 1 行に戻る（NFR-LST-03）
    test('TC-LW-07: undo で折り返し前に戻る', async ({ page }) => {
        await editor.setMarkdown('- aaaabbbbb');
        await page.waitForTimeout(200);
        await placeCursorInFirstLi(page, 4);
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(400);

        let md = await editor.getMarkdown();
        expect(md).toMatch(/\n\s+- bbbbb/);

        await editor.shortcut('z');
        await page.waitForTimeout(300);
        md = await editor.getMarkdown();
        expect(md).toContain('- aaaabbbbb');
    });
});
