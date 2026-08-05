/**
 * FR-B10: codeblock 右上「折り返し」トグルボタン
 *
 * - トグルで当該 pre の white-space を pre ⇄ pre-wrap（class .code-block-wrap の付け外し）
 * - 表示状態のみ・md serialize には一切影響しない
 * - トグル ON でも copy ボタンのコピー内容は元コードのまま（改行挿入なし）
 *
 * counterfactual: white-space 実測は class 付与ロジックに依存する。
 *   click ハンドラの `pre.classList.toggle('code-block-wrap')` を外すと
 *   TC-B10-01（computed white-space が pre-wrap）が RED になる。
 *   （class 存在だけの tautology を避け、getComputedStyle の実測値で担保）
 *
 * 補足: codeblock ヘッダのボタンは pre の上マージン領域に描画され、
 *   Playwright の pointer hit-test は contenteditable な .editor に吸われる
 *   （既存 code-copy-btn / code-lang-tag の click テストと同じ既知の harness 事情）。
 *   本 spec は実 click ハンドラを確実に発火させるため dispatchEvent('click') で駆動する
 *   （production のユーザークリックと同じ handler を通す）。
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

// 折り返しがない状態では横に溢れる長い 1 行
const LONG_LINE =
    'const veryLongVariableNameThatKeepsGoing = someFunctionCall(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive, argumentSix);';
const CODE_MD = '```javascript\n' + LONG_LINE + '\n```\n';

async function renderCodeBlock(page: Page): Promise<EditorTestHelper> {
    const editor = new EditorTestHelper(page);
    await editor.setMarkdown(CODE_MD);
    await page.waitForTimeout(300);
    // pre と折り返しボタンが用意されるのを待つ
    await page.waitForSelector('.editor pre .code-wrap-btn');
    return editor;
}

async function clickWrapBtn(page: Page) {
    await page.locator('.editor pre .code-wrap-btn').first().dispatchEvent('click');
    await page.waitForTimeout(50);
}

async function whiteSpaceOf(page: Page, sel: string): Promise<string> {
    return await page.evaluate((s) => {
        const el = document.querySelector(s) as HTMLElement;
        return getComputedStyle(el).whiteSpace;
    }, sel);
}

test.describe('《codeblock 折り返しトグル》FR-B10', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
    });

    test('TC-B10-01: トグル click → computed white-space が pre-wrap になる', async ({ page }) => {
        await renderCodeBlock(page);

        // 折り返し前は white-space: pre（実測）
        expect(await whiteSpaceOf(page, '.editor pre')).toBe('pre');

        // 折り返しトグルボタンを押す
        await clickWrapBtn(page);

        // computed white-space が pre-wrap に切替わる（class 存在でなく実測値で担保）
        expect(await whiteSpaceOf(page, '.editor pre')).toBe('pre-wrap');
        // 内側の code も pre-wrap（実際に折り返す side）
        expect(await whiteSpaceOf(page, '.editor pre code')).toBe('pre-wrap');
    });

    test('TC-B10-02: 再 click で white-space が pre に戻る', async ({ page }) => {
        await renderCodeBlock(page);

        // ON
        await clickWrapBtn(page);
        expect(await whiteSpaceOf(page, '.editor pre')).toBe('pre-wrap');

        // OFF（再押下）
        await clickWrapBtn(page);
        expect(await whiteSpaceOf(page, '.editor pre')).toBe('pre');
        expect(await whiteSpaceOf(page, '.editor pre code')).toBe('pre');
    });

    test('TC-B10-03: トグル ON のまま copy → コピー内容が元コード（改行挿入なし・不変）', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await renderCodeBlock(page);

        // 折り返し ON
        await clickWrapBtn(page);
        expect(await whiteSpaceOf(page, '.editor pre')).toBe('pre-wrap');

        // copy ボタンの実 handler を発火
        await page.locator('.editor pre .code-copy-btn').first().dispatchEvent('click');
        await page.waitForTimeout(150);

        const clip = await page.evaluate(async () => navigator.clipboard.readText());
        // 折り返しは表示だけなので、コピーは元の長い 1 行そのまま（視覚的折り返しの改行が混入しない）
        expect(clip).toContain(LONG_LINE);
        // コード本体には改行が 1 つも増えていない（元は 1 行）
        expect(clip.trim()).toBe(LONG_LINE);
    });

    test('TC-B10-04: トグルは md serialize に影響しない（前後で同一）', async ({ page }) => {
        const editor = await renderCodeBlock(page);

        const before = await editor.getMarkdown();

        // 折り返し ON → serialize 不変
        await clickWrapBtn(page);
        expect(await editor.getMarkdown()).toBe(before);

        // 折り返し OFF → serialize 不変
        await clickWrapBtn(page);
        expect(await editor.getMarkdown()).toBe(before);

        // serialize 結果に折り返し用の class 名が漏れていない
        expect(before).not.toContain('code-block-wrap');
        expect(before).toContain('```');
        expect(before).toContain(LONG_LINE);
    });

    test('TC-B10-01b(counterfactual 補強): ON 中は pre に .code-block-wrap・ボタンが is-active になる', async ({ page }) => {
        await renderCodeBlock(page);
        const wrapBtn = page.locator('.editor pre .code-wrap-btn').first();

        // 初期は class 無し・active 無し
        expect(await page.evaluate(() => document.querySelector('.editor pre')!.classList.contains('code-block-wrap'))).toBe(false);
        await expect(wrapBtn).not.toHaveClass(/is-active/);

        await clickWrapBtn(page);

        // class 付与 + active。この class 付与こそが TC-B10-01 の computed pre-wrap の唯一の駆動源。
        expect(await page.evaluate(() => document.querySelector('.editor pre')!.classList.contains('code-block-wrap'))).toBe(true);
        await expect(wrapBtn).toHaveClass(/is-active/);
    });
});
