/**
 * TC-KTX-01/02/03/04/05/09 — `$$...$$` display math ブロック + ```math 内 $$ tolerant
 * （sprint 20260818-183407 FR-KTX-01/02・ADRL-0079）
 *
 * counterfactual:
 *  - $$ パース分岐が無いと TC-KTX-01/02 で .math-wrapper が生成されず RED
 *  - serialize の data-math-delim 分岐が無いと round-trip で ```math に化けて byte 不一致 = RED
 *  - tolerant 剥がしが無いと TC-KTX-04 で katex-error（errorColor span）= RED
 */
import { test, expect, Page } from '@playwright/test';

const CI_MD_LINE = '$$\\text{深度}_k \\in \\text{点位}_j \\in \\text{场地}_i$$';

async function setup(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForSelector('#editor');
    await page.waitForFunction(() => typeof (window as any).katex !== 'undefined');
}

async function roundtrip(page: Page, md: string) {
    return page.evaluate(async (src) => {
        (window as any).__testApi.setMarkdown(src);
        await new Promise((r) => setTimeout(r, 400)); // waitForKatex + render
        const editor = document.getElementById('editor')!;
        return {
            wrappers: editor.querySelectorAll('.math-wrapper').length,
            dollarWrappers: editor.querySelectorAll('.math-wrapper[data-math-delim]').length,
            katexOut: editor.querySelectorAll('.math-display .katex').length,
            katexError: editor.querySelectorAll('.math-display .katex-error, .math-display .math-error').length,
            out: (window as any).__testApi.getMarkdown(),
        };
    }, md);
}

test('TC-KTX-01 ci.md 原文 1 行 $$ が math ブロック化 + 描画 + round-trip byte 一致', async ({ page }) => {
    await setup(page);
    const md = CI_MD_LINE + '\n';
    const r = await roundtrip(page, md);
    expect(r.dollarWrappers).toBe(1);
    expect(r.katexOut).toBeGreaterThan(0);   // 描画される（生 LaTeX 表示にならない）
    expect(r.katexError).toBe(0);            // errorColor 赤字にならない
    // 1 行完結形式が 1 行のまま（複数行形式へ化けない — TDD-3 の単一行分岐 pin）
    expect(r.out.trim()).toBe(CI_MD_LINE);
});

test('TC-KTX-02 複数行 $$ ブロックのパース + round-trip byte 一致', async ({ page }) => {
    await setup(page);
    const md = '$$\nE = mc^2\n\\text{质量}\n$$\n';
    const r = await roundtrip(page, md);
    expect(r.dollarWrappers).toBe(1);
    expect(r.katexError).toBe(0);
    expect(r.out.trim()).toBe(md.trim());
});

test('TC-KTX-03 閉じ $$ 無しの開き行のみ → math ブロック化せず通常テキスト（round-trip 保全）', async ({ page }) => {
    await setup(page);
    const md = '$$\n\nplain text after\n';
    const r = await roundtrip(page, md);
    expect(r.dollarWrappers).toBe(0);
    expect(r.out).toContain('$$');
    expect(r.out).toContain('plain text after');
});

test('TC-KTX-04 ```math 内に $$ ごと書かれても描画される（tolerant 剥がし・md 本文は不変）', async ({ page }) => {
    await setup(page);
    const md = '```math\n$$\\text{深度}_k$$\n```\n';
    const r = await roundtrip(page, md);
    expect(r.wrappers).toBe(1);
    expect(r.katexOut).toBeGreaterThan(0);
    expect(r.katexError).toBe(0); // 剥がし無しだと $$ が KaTeX に渡り katex-error = RED
    expect(r.out.trim()).toBe(md.trim()); // 表示時のみ剥がし — serialize は $$ ごと保持
});

test('TC-KTX-05 ```math は ```math のまま / $$ は $$ のまま（相互変換しない）', async ({ page }) => {
    await setup(page);
    const md = '```math\nE = mc^2\n```\n\n$$a + b$$\n';
    const r = await roundtrip(page, md);
    expect(r.wrappers).toBe(2);
    expect(r.dollarWrappers).toBe(1);
    const out = r.out;
    expect(out).toContain('```math\nE = mc^2\n```');
    expect(out).toContain('$$a + b$$');
});

test('TC-KTX-09 $$ 非含有の代表 md は round-trip byte 不変（副作用ゼロ counterfactual）', async ({ page }) => {
    await setup(page);
    const md = [
        '# Title',
        '',
        '- list item',
        '  - nested',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        'para with $inline dollar$ and $$ mid-line $$ not-block text',
    ].join('\n') + '\n';
    const r = await roundtrip(page, md);
    expect(r.dollarWrappers).toBe(0); // 行中 $$ はブロック化しない
    expect(r.out.trim()).toBe(md.trim());
});

/**
 * TC-KTX-06/07/08 — KaTeX strict:false + CJK/ハングル fallback CSS（FR-KTX-03/04/05・TASK-03）
 */
test('TC-KTX-06 多言語 \\text regression pin: 深度/한글/éàü が katex-error 無しで描画', async ({ page }) => {
    await setup(page);
    const md = '```math\n\\text{深度}_k\n```\n\n```math\n\\text{한글}\n```\n\n```math\n\\text{éàü}\n```\n';
    const r = await roundtrip(page, md);
    expect(r.wrappers).toBe(3);
    expect(r.katexOut).toBeGreaterThanOrEqual(3);
    expect(r.katexError).toBe(0);
});

test('TC-KTX-07 strict:false: \\text 無し直書き CJK も katex-error / console 警告なしで描画', async ({ page }) => {
    await setup(page);
    const warnings: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'warning') warnings.push(msg.text()); });
    const md = '```math\n深度_k = 1\n```\n';
    const r = await roundtrip(page, md);
    expect(r.katexOut).toBeGreaterThan(0);
    expect(r.katexError).toBe(0);
    // strict 未指定（default 'warn'）だと unicodeTextInMathMode の console 警告が出る = RED
    expect(warnings.filter((w) => w.includes('unicodeTextInMathMode')).length).toBe(0);
});

test('TC-KTX-08 cjk_fallback / hangul_fallback の CSS ルールが webview + PDF CSS に実在', async ({ page }) => {
    await setup(page);
    // webview: 実 CJK 数式を描画し computed style で font-size 補正が当たることを確認
    const r = await page.evaluate(async () => {
        (window as any).__testApi.setMarkdown('```math\n\\text{深度한글}\n```\n');
        await new Promise((res) => setTimeout(res, 400));
        const cjk = document.querySelector('.katex .cjk_fallback') as HTMLElement | null;
        const hangul = document.querySelector('.katex .hangul_fallback') as HTMLElement | null;
        const fs = (el: HTMLElement | null) => (el ? getComputedStyle(el).fontSize : null);
        const base = document.querySelector('.katex') as HTMLElement | null;
        return { cjkFs: fs(cjk), hangulFs: fs(hangul), baseFs: fs(base), hasCjk: !!cjk, hasHangul: !!hangul };
    });
    expect(r.hasCjk).toBe(true);
    expect(r.hasHangul).toBe(true);
    // 90% 補正が当たる（counterfactual: CSS 追加なしだと baseFs と同値 = RED）
    expect(parseFloat(r.cjkFs!)).toBeLessThan(parseFloat(r.baseFs!));
    expect(parseFloat(r.hangulFs!)).toBeLessThan(parseFloat(r.baseFs!));
    // PDF: PDF_DEFAULT_CSS に同セレクタが実在（描画済み DOM 再利用のため CSS 到達のみが論点）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsMod = require('fs');
    const pdfCore = fsMod.readFileSync(require('path').join(__dirname, '../../src/shared/pdf-export-core.ts'), 'utf8');
    expect(pdfCore).toContain('.cjk_fallback');
    expect(pdfCore).toContain('.hangul_fallback');
});
