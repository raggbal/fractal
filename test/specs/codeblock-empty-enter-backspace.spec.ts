import { test, expect, Page } from '@playwright/test';

// Sprint 20260810-183054 TASK-06 (FR-CB-01): 空コードブロックの Enter/Backspace 対称性。
// 空判定 2 箇所(Backspace / Enter sentinel)が textContent ベースで <br> を数えず、
// (1) Enter N 回で md 改行が増殖 (2) <br> 蓄積状態の Backspace 1 回でブロック全消し。
// 正典 getCodePlainText(<br> を \n に数える)に統一する。
// キー駆動は実キーボード(page.keyboard.press) — blockquote-codeblock-backspace-fix.spec.ts precedent。

async function setupEmptyCodeBlock(page: Page) {
    await page.evaluate(() => {
        (window as any).__testApi.setMarkdown('```\n\n```');
    });
    await page.waitForTimeout(300);
    // 編集モードに入れてカーソルを code 内に置く(既存 GREEN spec と同手法)
    await page.evaluate(async () => {
        const pre = document.querySelector('#editor pre')!;
        const code = pre.querySelector('code')!;
        pre.setAttribute('data-mode', 'edit');
        code.setAttribute('contenteditable', 'true');
        code.innerHTML = '<br>';
        (code as HTMLElement).focus();
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(code, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        await new Promise(r => setTimeout(r, 100));
    });
    await page.waitForTimeout(200);
}

async function cursorToCodeEnd(page: Page) {
    await page.evaluate(() => {
        const code = document.querySelector('#editor pre code') as HTMLElement;
        code.focus();
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(code);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    });
}

async function getState(page: Page) {
    return await page.evaluate(() => {
        const pre = document.querySelector('#editor pre');
        const code = pre?.querySelector('code');
        return {
            hasPre: !!pre,
            brCount: code ? code.querySelectorAll('br').length : -1,
            plainLen: code ? (code.textContent || '').length : -1,
            md: (window as any).__testApi.getMarkdown(),
        };
    });
}

test.describe('Empty code block Enter/Backspace symmetry (FR-CB-01)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-CB-01: 改行蓄積状態で Backspace してもブロックは 1 発全消ししない。
    // 実測機序(2026-08-11): 蓄積ブロックは reload 後 <br> ベース DOM になり textContent='' →
    // 旧 isEmpty 判定が true → カーソル絶対先頭(offset 0)からの Backspace 1 回で pre 全体が
    // <p><br></p> に置換される(3 行分の改行が一瞬で消える)。カーソルが末尾なら browser default
    // が <br> を 1 個ずつ消すため無事 — バグは先頭経路のみ。
    // counterfactual: isEmpty を textContent 判定に戻すと at-start Backspace で pre 消滅 = RED
    test('TC-CB-01 accumulated-breaks block survives backspace (no whole-block delete)', async ({ page }) => {
        // 改行 3 個が蓄積した空コードブロック(ユーザーが Enter×3 → 保存 → 再オープンした状態)
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('```\n\n\n\n```');
        });
        await page.waitForTimeout(300);
        await page.click('#editor pre'); // 編集モード(enterEditMode 経路・<br> ベース DOM)
        await page.waitForTimeout(300);
        const initial = await getState(page);
        expect(initial.hasPre).toBe(true);
        expect(initial.brCount).toBeGreaterThanOrEqual(3);

        // (A) カーソル絶対先頭で Backspace → pre は消えない(旧実装はここで全消し = RED)
        await page.evaluate(() => {
            const code = document.querySelector('#editor pre code') as HTMLElement;
            code.focus();
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(code, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const afterStart = await getState(page);
        expect(afterStart.hasPre).toBe(true); // ← counterfactual の核心
        expect(afterStart.brCount).toBe(initial.brCount); // 先頭では何も消えない(非空ブロックと同じ guard)

        // (B) カーソル末尾からは改行が 1 個ずつ減る(N 回で元の空ブロック相当まで)
        await cursorToCodeEnd(page);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150);
        const after1 = await getState(page);
        expect(after1.hasPre).toBe(true);
        expect(after1.brCount).toBe(initial.brCount - 1);
    });

    // TC-CB-02: 真に空のブロックで Backspace → 段落化(現 GREEN spec と同方向・維持)
    test('TC-CB-02 truly empty code block backspace converts to paragraph', async ({ page }) => {
        await setupEmptyCodeBlock(page);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        const html = await page.evaluate(() =>
            document.getElementById('editor')!.innerHTML);
        expect(html).not.toContain('<pre');
        expect(html).toContain('<p>');
    });

    // TC-CB-03: Enter×2 → md の fence 内改行が増殖しない(往復対称)
    // counterfactual: sentinel 判定が textContent ベースのままだと改行が純増 = RED
    test('TC-CB-03 enters do not inflate serialized newlines across roundtrip', async ({ page }) => {
        await setupEmptyCodeBlock(page);
        for (let i = 0; i < 2; i++) {
            await cursorToCodeEnd(page);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(120);
        }
        await page.waitForTimeout(300);
        const md1 = (await getState(page)).md;
        // 再ロード → 再 serialize で md が安定(増殖しない)
        const md2 = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            return (window as any).__testApi.getMarkdown();
        }, md1);
        expect(md2).toBe(md1);
        // 入力は Enter 2 回 → 全体の改行数が入力量に対して有界
        const newlines = (md1.match(/\n/g) || []).length;
        expect(newlines).toBeLessThanOrEqual(7);
    });

    // TC-CB-04: 非空コードブロックの Enter/Backspace 既存挙動不変 + serialize byte 不変(NFR-03)
    test('TC-CB-04 non-empty code block behavior and serialization unchanged', async ({ page }) => {
        const md = '```js\nconst a = 1;\nconst b = 2;\n```';
        const out = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            return (window as any).__testApi.getMarkdown();
        }, md);
        expect(out.trim()).toBe(md); // byte 比較(NFR-03)

        // 非空ブロック末尾で Backspace → ブロックは消えず 1 文字消える(既存挙動)
        await page.evaluate(async () => {
            const pre = document.querySelector('#editor pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            await new Promise(r => setTimeout(r, 100));
        });
        await cursorToCodeEnd(page);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await getState(page);
        expect(state.hasPre).toBe(true);
    });
});
