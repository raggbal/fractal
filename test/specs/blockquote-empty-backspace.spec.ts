import { test, expect, Page } from '@playwright/test';

// Sprint 20260810-183054 TASK-07 (FR-QB-01): 完全に空の blockquote の Backspace 脱出。
// pre(:12112 相当)と対称の isEmpty → <p><br></p> 置換を blockquote 分岐に追加
// (commit ae57510 の guard 化時に脱落した非対称の回復)。
// img/checkbox/table/pre/iframe は textContent 空でも content 扱い(資産 1:1 保全)。

async function setCursorIntoBlockquote(page: Page) {
    await page.evaluate(() => {
        const bq = document.querySelector('#editor blockquote') as HTMLElement;
        bq.focus?.();
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(bq, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await page.waitForTimeout(100);
}

test.describe('Empty blockquote backspace (FR-QB-01)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-QB-01: 完全空 blockquote で Backspace → <p><br></p> 化
    // counterfactual: isEmpty 分岐を外すと現行 guard で何も起きない = RED
    test('TC-QB-01 completely empty blockquote converts to paragraph on backspace', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<blockquote><br></blockquote>';
        });
        await setCursorIntoBlockquote(page);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            hasBq: !!document.querySelector('#editor blockquote'),
            hasP: !!document.querySelector('#editor p'),
        }));
        expect(state.hasBq).toBe(false);
        expect(state.hasP).toBe(true);
    });

    // TC-QB-02: <img> のみの blockquote → 消えない(img=content 番人)
    test('TC-QB-02 blockquote containing only an image survives backspace', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<blockquote><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="></blockquote>';
        });
        await setCursorIntoBlockquote(page);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            hasBq: !!document.querySelector('#editor blockquote'),
            hasImg: !!document.querySelector('#editor blockquote img'),
        }));
        expect(state.hasBq).toBe(true);
        expect(state.hasImg).toBe(true);
    });

    // TC-QB-03: checkbox(input)のみの blockquote → 消えない
    test('TC-QB-03 blockquote containing only a checkbox survives backspace', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<blockquote><input type="checkbox"></blockquote>';
        });
        await setCursorIntoBlockquote(page);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            hasBq: !!document.querySelector('#editor blockquote'),
            hasInput: !!document.querySelector('#editor blockquote input'),
        }));
        expect(state.hasBq).toBe(true);
        expect(state.hasInput).toBe(true);
    });

    // TC-QB-04: 非空 blockquote 先頭で Backspace → 現行 guard 維持(何もしない)
    test('TC-QB-04 non-empty blockquote start keeps current guard behavior', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<blockquote>quoted text</blockquote>';
            const bq = editor.querySelector('blockquote')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(bq.firstChild!, 0); // テキスト絶対先頭
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(100);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            hasBq: !!document.querySelector('#editor blockquote'),
            text: document.querySelector('#editor blockquote')?.textContent,
        }));
        expect(state.hasBq).toBe(true);
        expect(state.text).toBe('quoted text'); // 段落分解しない・文字も消えない
    });
});

// TC-QB-05: known-red FIXED 2 件の GREEN 化確認は、当該既存 spec の実行で担保する
// (blockquote-codeblock-operations.spec.ts「空の引用でBackspace → 段落に変換」/
//  blockquote-backspace-multiline.spec.ts「空の引用ブロック先頭でBackspace → 空段落に変換」
//  — TASK-07 完了条件で個別実行して確認し、baseline から正規除去する)
