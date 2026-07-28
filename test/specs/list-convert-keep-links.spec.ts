/**
 * md リスト/ブロック変換で inline 要素（URL リンク・md リンク・ファイルリンク・subpage）を維持
 * — sprint 20260728-121645（バグ修正: textContent 再構築で anchor が脱落していた）
 *
 * 経路: (A) 行頭 "- " 等 + space の入力ルール（checkBlockPatterns P-level）
 *       (B) li 内の型相互変換（in-li bulletMatch/orderedMatch/taskInListMatch）
 *       (C) toolbar/shortcut の convertToList/convertToTaskList/convertToHeading/convertToBlockquote
 */

import { test, expect } from '@playwright/test';

// 行 HTML を editor に置き、caret を行頭に置く
async function setLine(page: import('@playwright/test').Page, html: string) {
    await page.evaluate((html) => {
        const editor = document.getElementById('editor')!;
        editor.innerHTML = html;
        const first = editor.firstElementChild!;
        const r = document.createRange();
        r.setStart(first, 0);
        r.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        (first as HTMLElement).focus?.();
    }, html);
}

async function editorHtml(page: import('@playwright/test').Page) {
    return page.evaluate(() => document.getElementById('editor')!.innerHTML);
}

const LINK_LINE =
    '<p>see <a href="https://example.com">site</a> and ' +
    '<a href="./sub.md" data-subpage="true" class="link-internal-md link-subpage">Sub Page</a> here</p>';

test.describe('リスト変換で link/subpage 維持（バグ修正）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
    });

    // ── (A) 入力ルール: 行頭 "- " + space ──
    test('TC-LC-01 ★バグ再現: link+subpage 行の行頭で "- " → ul li 内にリンクが残る', async ({ page }) => {
        await setLine(page, LINK_LINE);
        // 行頭に "- " を打つ: caret は行頭にあるので type で入力 → space が入力ルールを発火
        await page.keyboard.type('- ');
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        // counterfactual: 修正前は textContent 化で <a> が全て消える = RED
        expect(html).toContain('<ul>');
        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('data-subpage="true"');
        expect(html).toContain('Sub Page');
        expect(html).not.toContain('- see'); // マーカーは剥がれている
    });

    test('TC-LC-02 入力ルール "1. " → ol li 内にリンクが残る', async ({ page }) => {
        await setLine(page, LINK_LINE);
        await page.keyboard.type('1. ');
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        expect(html).toContain('<ol>');
        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('data-subpage="true"');
    });

    test('TC-LC-03 入力ルール task: "- [ ]" 既存の行で space → task li 内にリンクが残る', async ({ page }) => {
        // 実タイピングでは "- " の時点で ul 変換が先に発火する（既存 UX）ため、
        // task ルールの発火形 = 「行テキストが既に "- [ ]" で始まる状態で space」で駆動する。
        await setLine(page,
            '<p>- [ ] see <a href="https://example.com">site</a> and ' +
            '<a href="./sub.md" data-subpage="true" class="link-internal-md link-subpage">Sub Page</a> here</p>');
        // caret を "- [ ]" 直後（先頭テキストノード offset 5）へ置いて space
        await page.evaluate(() => {
            const p = document.querySelector('#editor p')!;
            const r = document.createRange();
            r.setStart(p.firstChild!, 5);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('Space');
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        expect(html).toContain('type="checkbox"');
        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('data-subpage="true"');
    });

    test('TC-LC-04 入力ルール "# " → h1 内にリンクが残る / "> " → blockquote 内にリンクが残る', async ({ page }) => {
        await setLine(page, LINK_LINE);
        await page.keyboard.type('# ');
        await page.waitForTimeout(100);
        let html = await editorHtml(page);
        expect(html).toMatch(/<h1[^>]*>/);
        expect(html).toContain('href="https://example.com"');

        await setLine(page, LINK_LINE);
        await page.keyboard.type('> ');
        await page.waitForTimeout(100);
        html = await editorHtml(page);
        expect(html).toContain('<blockquote>');
        expect(html).toContain('data-subpage="true"');
    });

    // ── (B) li 内の型相互変換 ──
    test('TC-LC-05 既存 li（リンク入り）の行頭 "1. " → ol 化してもリンクが残る', async ({ page }) => {
        await setLine(page,
            '<ul><li>go <a href="https://example.com">site</a> now</li></ul>');
        // caret を li 先頭へ
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const r = document.createRange();
            r.setStart(li.firstChild!, 0);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.type('1. ');
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        expect(html).toContain('<ol>');
        expect(html).toContain('href="https://example.com"');
    });

    test('TC-LC-06 既存 li（リンク+ネスト子リスト）の行頭 "[ ] " → task 化でリンクも子リストも残る', async ({ page }) => {
        await setLine(page,
            '<ul><li>go <a href="./doc.md" data-subpage="true">Doc</a> now<ul><li>child</li></ul></li></ul>');
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const r = document.createRange();
            r.setStart(li.firstChild!, 0);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.type('[ ] ');
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        expect(html).toContain('type="checkbox"');
        expect(html).toContain('data-subpage="true"');
        expect(html).toContain('child'); // ネスト子リスト温存
    });

    // ── (C) toolbar/shortcut 変換 ──
    test('TC-LC-07 convertToList(ul): P 行のリンクが li に残る（toolbar 経由の同バグ）', async ({ page }) => {
        await setLine(page, LINK_LINE);
        await page.evaluate(() => (window as any).__testApi.convertToList('ul'));
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        expect(html).toContain('<ul>');
        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('data-subpage="true"');
    });

    test('TC-LC-08 隣接リストへの merge でもリンクが残る', async ({ page }) => {
        await setLine(page, '<ul><li>first</li></ul>' + LINK_LINE);
        await page.evaluate(() => {
            const p = document.querySelector('#editor p')!;
            const r = document.createRange();
            r.setStart(p, 0);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.evaluate(() => (window as any).__testApi.convertToList('ul'));
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        // 既存 ul に append され、リンク維持
        expect((html.match(/<ul>/g) || []).length).toBe(1);
        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('data-subpage="true"');
    });

    test('TC-LC-09 regression: リンク無し行の "- " 変換は従来どおり（テキストのみ li）', async ({ page }) => {
        await setLine(page, '<p>plain text line</p>');
        await page.keyboard.type('- ');
        await page.waitForTimeout(100);
        const html = await editorHtml(page);
        expect(html).toContain('<ul>');
        expect(html).toContain('plain text line');
        expect(html).not.toContain('<a ');
    });
});
