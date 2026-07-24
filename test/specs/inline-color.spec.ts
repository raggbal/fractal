/**
 * TC-IC-03〜06 — md editor のインライン文字色 parse / serialize / round-trip / code 非着色。
 * standalone-editor で setMarkdown(=renderFromMarkdown) / getMarkdown(=htmlToMarkdown) を使う。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

test.describe('md インライン文字色 (FR-IC-01/02)', () => {
    // TC-IC-03: parse — 色 span がリテラルでなく色付き DOM になる ★load-bearing
    test('TC-IC-03 色 span を parse → 色付き DOM（escape されない）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('foo <span style="color:#ef4444">red</span> bar');
            const editorEl = document.querySelector('.editor') || document.body;
            const span = editorEl.querySelector('span[style*="color"]') as HTMLElement;
            return {
                hasColorSpan: !!span,
                spanText: span ? span.textContent : null,
                color: span ? span.style.color : null,
                // リテラル `<span` がテキストとして残っていないこと
                literalTag: (editorEl.textContent || '').includes('<span'),
            };
        });
        expect(r.hasColorSpan).toBe(true);
        expect(r.spanText).toBe('red');
        expect(r.literalTag).toBe(false);   // ★ counterfactual: passthrough が無いとリテラル表示（true=RED）
    });

    // TC-IC-04: serialize + round-trip 表示 DOM（color 最内・R-1）★load-bearing・counterfactual
    test('TC-IC-04 bold+色 の round-trip は reload で <strong> 内に色 span', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            // color 最内の canonical エンコード
            const src = '**<span style="color:#ef4444">bold red</span>**';
            (window as any).__testApi.setMarkdown(src);
            // serialize
            const md = (window as any).__testApi.getMarkdown();
            // reload（再 parse）して表示 DOM を確認
            (window as any).__testApi.setMarkdown(md);
            const editorEl = document.querySelector('.editor') || document.body;
            const strong = editorEl.querySelector('strong') as HTMLElement;
            const spanInStrong = strong ? strong.querySelector('span[style*="color"]') as HTMLElement : null;
            return {
                md: md,
                // ★ 表示 DOM assert: strong の中に色付き span（** が bold 解釈されている）
                strongHasColorSpan: !!spanInStrong,
                spanText: spanInStrong ? spanInStrong.textContent : null,
                // リテラル ** がテキストに残っていない（色最外なら ** がリテラル化していた=RED）
                literalStars: (editorEl.textContent || '').includes('**'),
            };
        });
        // serialize に色 span が出る
        expect(r.md).toContain('<span style="color:#ef4444">');
        // ★ 表示 DOM: <strong> 内に色 span（color 最内の証明・バイトだけ見ない）
        expect(r.strongHasColorSpan).toBe(true);
        expect(r.spanText).toBe('bold red');
        expect(r.literalStars).toBe(false);   // ★ counterfactual: 色最外だと ** がリテラル（true=RED）
    });

    // TC-IC-05: 既存書式の非回帰（color 追加が bold/italic 比較を壊さない）
    test('TC-IC-05 bold/italic/strike/code round-trip 不変', async ({ page }) => {
        await boot(page);
        const md = await page.evaluate(() => {
            const src = '**bold** *italic* ~~strike~~ `code`';
            (window as any).__testApi.setMarkdown(src);
            return (window as any).__testApi.getMarkdown();
        });
        expect(md).toContain('**bold**');
        expect(md).toContain('*italic*');
        expect(md).toContain('~~strike~~');
        expect(md).toContain('`code`');
    });

    // TC-IC-06: code 非着色 + ★code 内容が破壊されない（TASK-08 強化・自己 round-trip 破損の番人）
    test('TC-IC-06 inline code 内の色 span 記法は着色されず code 内容が保存される', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('`<span style="color:#ef4444">x</span>`');
            const editorEl = document.querySelector('.editor') || document.body;
            const code = editorEl.querySelector('code') as HTMLElement;
            const colorSpanInCode = code ? code.querySelector('span[style*="color"]') : null;
            const codeText = code ? (code.textContent || '') : '';
            // serialize して round-trip でも壊れないこと
            const md = (window as any).__testApi.getMarkdown();
            return {
                hasCode: !!code,
                colorSpanInCode: !!colorSpanInCode,
                codeText,
                md,
                // ★ COLOR プレースホルダや NUL がリークしていない
                leak: codeText.includes('COLOR') || codeText.includes('\x00'),
            };
        });
        expect(r.hasCode).toBe(true);
        expect(r.colorSpanInCode).toBe(false);   // ★ code 内は着色しない
        // ★ code 内容が破壊されていない（COLOR0 化しない・元の span 記法テキストが保たれる）
        expect(r.leak).toBe(false);
        expect(r.codeText).toContain('<span style="color:#ef4444">x</span>');
        expect(r.md).not.toContain('`COLOR');   // round-trip で code が COLOR0 に化けない
    });

    // TC-IC-15: 色 + link の round-trip（自己 round-trip 破損の番人・TASK-08）★load-bearing・counterfactual
    test('TC-IC-15 色付きリンクテキストが round-trip で壊れない', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            // serializer の canonical 出力形（リンクテキストに色）
            (window as any).__testApi.setMarkdown('[<span style="color:#ef4444">red link</span>](https://x.com)');
            const editorEl = document.querySelector('.editor') || document.body;
            const a = editorEl.querySelector('a') as HTMLElement;
            const aColorSpan = a ? a.querySelector('span[style*="color"]') : null;
            const md = (window as any).__testApi.getMarkdown();
            return {
                hasAnchor: !!a,
                anchorText: a ? (a.textContent || '') : '',
                anchorHasColor: !!aColorSpan,
                md,
            };
        });
        expect(r.hasAnchor).toBe(true);
        // ★ リンクテキストが COLOR0 に化けていない（自己 round-trip 破損の counterfactual）
        expect(r.anchorText).not.toContain('COLOR');
        expect(r.anchorText).toContain('red link');
        expect(r.anchorHasColor).toBe(true);         // リンクテキストに色が乗っている
        expect(r.md).toContain('https://x.com');     // link 自体保持
        expect(r.md).not.toContain('COLOR');         // serialize でも壊れない
    });

    // TC-IC-07: picker → swatch click → applyTextColor で選択に色付与（picker→onPick 実チェーン）E2E
    // ※ standalone-editor は #toolbar が空 DOM（本番のみ live）なので、picker は openTextColorPicker 経由で開き、
    //   swatch の実 click → onPick → applyTextColor の連鎖を検証する（toolbar ボタンの実配線は手動 US）。
    test('TC-IC-07 picker の swatch click で選択に色を適用', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('color me');
            const editorEl = document.querySelector('.editor') as HTMLElement;
            editorEl.focus();
            const range = document.createRange();
            range.selectNodeContents(editorEl);
            const sel = window.getSelection()!;
            sel.removeAllRanges(); sel.addRange(range);
            (window as any).__testApi.openTextColorPicker(null);
        });
        const pickerVisible = await page.locator('.inline-color-popover').isVisible();
        expect(pickerVisible).toBe(true);
        // 最初の swatch を実 click（赤 #ef4444）→ onPick → applyTextColor
        const md = await page.evaluate(() => {
            const sw = document.querySelector('.inline-color-popover .file-panel-color-swatch') as HTMLElement;
            sw.click();
            return (window as any).__testApi.getMarkdown();
        });
        expect(md).toContain('<span style="color:#ef4444">');
    });

    // TC-IC-17: 色適用後、末尾で入力しても色が継続しない（再オープン①）★load-bearing
    test('TC-IC-17 色付き文字の直後に入力した文字は無色', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('word');
            const editorEl = document.querySelector('.editor') as HTMLElement;
            editorEl.focus();
            // "word" を選択して色適用
            const range = document.createRange();
            range.selectNodeContents(editorEl);
            const sel = window.getSelection()!;
            sel.removeAllRanges(); sel.addRange(range);
            (window as any).__testApi.applyTextColor('#ef4444');
            // caret は末尾に畳まれているはず。新しい文字を挿入
            document.execCommand('insertText', false, 'X');
            return (window as any).__testApi.getMarkdown();
        });
        // ★ "word" は色付き・追加した "X" は色 span の外（色継続しない）
        expect(r).toContain('<span style="color:#ef4444">word</span>');
        expect(r).toContain('</span>X');           // X が span の外に出ている
        expect(r).not.toContain('wordX</span>');   // X が span 内に入っていない（色継続=NG）
    });

    // TC-IC-18: toolbar の翻訳ボタン重複解消（dead translateLang 削除・再オープン①）
    test('TC-IC-18 editor-body-html の translate group にボタンは1個（translateLang 削除）', async ({ page }) => {
        await boot(page);
        // standalone-editor は editor.js:265 の toolbar を使うが、editor-body-html.js の翻訳グループ検証は
        // 生成物（standalone-notes/outliner の body）で行う。ここでは editor-body-html の translate group を確認。
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(process.cwd(), 'src/shared/editor-body-html.js'), 'utf8');
        // translate group に translateLang ボタンが無いこと
        const grp = src.match(/data-group="translate"[\s\S]*?<\/div>/);
        expect(grp).not.toBeNull();
        expect(grp![0]).not.toContain('translateLang');
        expect((grp![0].match(/data-action="translate"/g) || []).length).toBe(1);
    });

    // TC-IC-13: サニタイズ — 危険 span はエスケープ（実 HTML 化しない）★load-bearing・counterfactual
    test('TC-IC-13 危険 span は着色されずエスケープされる', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            // 複合 style（background+url）/ 危険属性 → COLOR_SPAN_RE 不成立 → 実 HTML 化しない
            (window as any).__testApi.setMarkdown('<span style="color:#ef4444;background:url(x)">danger</span>');
            const editorEl = document.querySelector('.editor') || document.body;
            // background 付き span 要素は生成されない（テキスト or 無害化）
            const bgSpan = editorEl.querySelector('span[style*="background"]');
            const colorSpan = editorEl.querySelector('span[style*="color"]');
            return { bgSpan: !!bgSpan, colorSpan: !!colorSpan, text: editorEl.textContent || '' };
        });
        expect(r.bgSpan).toBe(false);     // ★ background:url を持つ span は DOM に入らない
        expect(r.colorSpan).toBe(false);  // 複合 style は color span としても通さない
    });

    // TC-IC-14: 共通 picker — 20色 swatch + None
    test('TC-IC-14 picker が 20色 swatch + None を描画', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            (window as any).showInlineColorPicker({ x: 10, y: 10, onPick: function () {} });
            const pop = document.querySelector('.inline-color-popover')!;
            const swatches = pop.querySelectorAll('.file-panel-color-swatch');
            const none = pop.querySelector('.file-panel-color-none');
            const firstHex = (swatches[0] as HTMLElement).dataset.hex;
            (window as any).closeInlineColorPicker();
            return { count: swatches.length, hasNone: !!none, firstHex };
        });
        expect(r.count).toBe(20);
        expect(r.hasNone).toBe(true);
        expect(r.firstHex).toBe('#ef4444');   // パレット先頭（赤）の hex
    });

    // TC-IC-08: None で色除去 E2E
    test('TC-IC-08 picker の None で色 span を除去', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('<span style="color:#ef4444">colored</span>');
            const editorEl = document.querySelector('.editor') as HTMLElement;
            editorEl.focus();
            const range = document.createRange();
            range.selectNodeContents(editorEl);
            const sel = window.getSelection()!;
            sel.removeAllRanges(); sel.addRange(range);
            (window as any).__testApi.openTextColorPicker(null);
        });
        expect(await page.locator('.inline-color-popover').isVisible()).toBe(true);
        const md = await page.evaluate(() => {
            const none = document.querySelector('.inline-color-popover .file-panel-color-none') as HTMLElement;
            none.click();
            return (window as any).__testApi.getMarkdown();
        });
        // 色 span が外れてテキストだけになる
        expect(md).not.toContain('color:#ef4444');
        expect(md).toContain('colored');
    });
});
