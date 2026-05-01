/**
 * Feature: Opt+Enter で list item の子 (1 indent 深い) を直下に追加
 *
 * 通常 Enter: 同じインデントの sibling LI を作成
 * Opt+Enter: 直下に nested LI を作成 (現在 LI の child)
 */

import { test, expect } from '@playwright/test';

test.describe('MD editor: Opt+Enter creates child list item', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('単純な ul で Opt+Enter → 直下に nested LI が作られる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- a\n- b\n');
        });
        await page.waitForTimeout(100);

        // 1 つ目の LI 末尾にカーソル
        await page.evaluate(() => {
            const lis = document.querySelectorAll('.editor li');
            const li = lis[0] as HTMLElement;
            li.focus();
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(false);  // end
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(50);

        // Opt+Enter (Alt+Enter)
        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(150);

        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        // 期待: a の child として空 li が作られる → "- a\n  - " もしくは "- a\n  -"
        // 改行 + 2 space インデント + dash でネスト表現
        expect(md).toMatch(/^- a\n  -\s*\n- b\n/);
    });

    test('Opt+Enter 後にテキスト入力すると、子インデントの LI として表示される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- parent\n');
        });
        await page.waitForTimeout(100);

        await page.evaluate(() => {
            const li = document.querySelector('.editor li') as HTMLElement;
            li.focus();
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(50);

        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(100);
        await page.keyboard.type('child');
        await page.waitForTimeout(150);

        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toMatch(/- parent\n  - child/);
    });

    test('regression: 通常 Enter は sibling LI を作る (子になっていない)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- a\n');
        });
        await page.waitForTimeout(100);

        await page.evaluate(() => {
            const li = document.querySelector('.editor li') as HTMLElement;
            li.focus();
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(50);

        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        await page.keyboard.type('b');
        await page.waitForTimeout(150);

        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        // 期待: 同インデントで - b が並ぶ
        expect(md).toMatch(/- a\n- b/);
    });

    test('既存 nested list がある場合、Opt+Enter は nested list の先頭に挿入される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- a\n  - existing-child\n');
        });
        await page.waitForTimeout(100);

        // 親 LI ('a') の末尾にカーソル (nested list の前)
        await page.evaluate(() => {
            const li = document.querySelector('.editor > ul > li') as HTMLElement;
            li.focus();
            // 'a' のテキストノードの末尾にカーソル
            const tn = Array.from(li.childNodes).find(n => n.nodeType === 3) as Text;
            const range = document.createRange();
            range.setStart(tn, tn.textContent!.length);
            range.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(50);

        await page.keyboard.press('Alt+Enter');
        await page.waitForTimeout(100);
        await page.keyboard.type('new-child');
        await page.waitForTimeout(150);

        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        // 期待: new-child が nested list の先頭、existing-child は後続
        expect(md).toMatch(/- a\n  - new-child\n  - existing-child/);
    });
});
