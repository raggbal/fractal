/**
 * ol-nested-markers — ネスト深さ別の数字リスト表示（sprint 20260805-124854 / FR-T03）
 *
 * 表示のみ・常時 ON。深さ循環 decimal → lower-alpha → lower-roman（9 段 = 3 周）を
 * ol の祖先数だけで数える（間に ul を挟んでも ol の祖先数でマッチ）。
 * serialize / md は数字のまま不変（CSS 変更が serialize に漏れない不変 pin）。
 * <ol start="N"> は native ::marker が honor するので FR-OLS の start 保持と両立。
 *
 * 番人方針: class 存在 assert（tautology）を禁止し、getComputedStyle の
 * list-style-type を実測する。CSS ルールを消す/循環を壊すと computed が
 * 既定 decimal に落ちて RED（counterfactual）。
 *
 * TC 定義: .harness/sprint/20260805-124854-tree-md-dnd-and-ol-lists/tasks.md TASK-03
 */

import { test, expect } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';
import { PDF_DEFAULT_CSS, buildSelfContainedHtml } from '../../src/shared/pdf-export-core';

/** editor 内の全 ol を文書順で { depth(ol 祖先数), computed list-style-type, start } にする。 */
async function collectOls(page: import('@playwright/test').Page) {
    return await page.evaluate(() => {
        const editor = document.getElementById('editor')!;
        const ols = Array.from(editor.querySelectorAll('ol'));
        return ols.map((ol) => {
            let depth = 0;
            let n: Element | null = ol;
            while (n) {
                if (n.tagName === 'OL') depth++;
                n = n.parentElement;
            }
            return {
                depth,
                lst: getComputedStyle(ol).listStyleType,
                start: ol.getAttribute('start'),
            };
        });
    });
}

test.describe('《ネスト ol マーカー》深さ別 list-style-type', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        await page.waitForTimeout(500);
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    // TC-T03-01 ★load-bearing・counterfactual:
    // styles.css の深さ循環ルールを消す/壊すと computed が既定 decimal に落ち
    // depth 2/3 の assert が RED。class 存在ではなく getComputedStyle 実測で pin。
    // ネスト ol は 3 スペースインデントで生成される（実測: mixed-nested 系と同様に
    // 番号幅ぶんのインデントが要る。probe で確認済み）。
    test('TC-T03-01: 深さ 1-4 の computed list-style-type = decimal/lower-alpha/lower-roman/decimal', async ({ page }) => {
        // 1. a
        //    1. b
        //       1. c
        //          1. d   （各段 3 スペース深く = ネスト ol 4 段）
        await editor.setMarkdown('1. a\n   1. b\n      1. c\n         1. d');
        await page.waitForTimeout(200);

        const ols = await collectOls(page);
        // ネストが 4 段の ol になっていることをまず確認（構造前提の番人）
        expect(ols.map((o) => o.depth)).toEqual([1, 2, 3, 4]);

        const byDepth: Record<number, string> = {};
        for (const o of ols) byDepth[o.depth] = o.lst;
        expect(byDepth[1]).toBe('decimal');
        expect(byDepth[2]).toBe('lower-alpha');
        expect(byDepth[3]).toBe('lower-roman');
        expect(byDepth[4]).toBe('decimal'); // 3 周目の頭に戻る（循環）
    });

    // TC-T03-01b: ul を挟んでも ol の祖先数だけで数える（Word 等と同じ自然な挙動）。
    // ol > li > ul > li > ol の内側 ol は ol 祖先 2 個 = lower-alpha。
    // （設計注記「ul を挟むケースの表示を実測して記録」の番人化）
    test('TC-T03-01b: ul を挟んだネスト ol は ol 祖先数で数える（lower-alpha）', async ({ page }) => {
        const data = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ol><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li></ol>';
            const ols = Array.from(editor.querySelectorAll('ol'));
            return ols.map((ol) => {
                let depth = 0;
                let n: Element | null = ol;
                while (n) {
                    if (n.tagName === 'OL') depth++;
                    n = n.parentElement;
                }
                return { depth, lst: getComputedStyle(ol).listStyleType };
            });
        });
        // 外側 ol（祖先 1）= decimal、ul を挟んだ内側 ol（祖先 2）= lower-alpha
        expect(data).toEqual([
            { depth: 1, lst: 'decimal' },
            { depth: 2, lst: 'lower-alpha' },
        ]);
    });

    // TC-T03-02 ★load-bearing:
    // <ol start=3> の 2 段目 → computed list-style-type が lower-alpha かつ start 属性が 3 のまま。
    // マーカー種別（alpha）と start 番号（3 → 'c' 相当）が両立することを pin。
    // list-style-type ルールが start を潰さないこと・start 保持が alpha 化を潰さないことの相互番人。
    test('TC-T03-02: <ol start=3> の深さ 2 は lower-alpha かつ start=3 保持（表示 c 相当）', async ({ page }) => {
        // 3. x
        //    3. y
        //    4. z   （深さ 2 の ol は start=3・lower-alpha → 表示 c, d）
        await editor.setMarkdown('3. x\n   3. y\n   4. z');
        await page.waitForTimeout(200);

        const ols = await collectOls(page);
        expect(ols.map((o) => o.depth)).toEqual([1, 2]);

        const outer = ols.find((o) => o.depth === 1)!;
        const inner = ols.find((o) => o.depth === 2)!;
        // 外側: decimal・start=3
        expect(outer.lst).toBe('decimal');
        expect(outer.start).toBe('3');
        // 内側: lower-alpha かつ start 属性 3 を保持（native ::marker が start を honor → 'c' 起点）
        expect(inner.lst).toBe('lower-alpha');
        expect(inner.start).toBe('3');
    });

    // TC-T03-03: ネスト ol の serialize round-trip が従来 byte 同一（CSS 変更が serialize に漏れない不変 pin）。
    // load → getMarkdown で数字マーカーのまま + 再 parse で idempotent。
    test('TC-T03-03: ネスト ol の serialize は数字のまま・round-trip byte 同一', async ({ page }) => {
        await editor.setMarkdown('1. a\n   1. b\n      1. c\n   2. d');
        await page.waitForTimeout(200);

        const md1 = await editor.getMarkdown();
        // マーカーは数字のまま（alpha/roman が md に漏れない）
        expect(md1).toContain('1. a');
        expect(md1).toContain('1. b');
        expect(md1).toContain('1. c');
        expect(md1).toContain('2. d');
        expect(md1).not.toMatch(/[a-z]\.\s/); // 'a. ' / 'i. ' 等のアルファ/ローマ字マーカーが無い

        // 再 parse で idempotent（byte 同一）
        await editor.setMarkdown(md1);
        await page.waitForTimeout(200);
        const md2 = await editor.getMarkdown();
        expect(md2).toBe(md1);
    });

    // ============ PDF（PDF_DEFAULT_CSS はスコープ無し = body 直下に効く） ============

    // TC-T03-04 (PDF) ★load-bearing:
    // PDF_DEFAULT_CSS の ol 循環ルールを、実際に buildSelfContainedHtml で組んだ
    // 自己完結 HTML（.editor で包まれない body 直下 innerHTML）に setContent して
    // computed list-style-type を実測（文字列 assert の tautology を避ける）。
    // スコープ無しルールを消すと depth 2/3 が decimal に落ち RED（counterfactual）。
    test('TC-T03-04: PDF 自己完結 HTML（body 直下）でも深さ循環マーカーが効く', async ({ page }) => {
        const body = '<ol><li>a<ol><li>b<ol><li>c<ol><li>d</li></ol></li></ol></li></ol></li></ol>';
        const html = buildSelfContainedHtml({ bodyHtml: body, css: PDF_DEFAULT_CSS, title: 't' });
        await page.setContent(html);

        const data = await page.evaluate(() => {
            const ols = Array.from(document.querySelectorAll('ol'));
            return ols.map((ol) => {
                let depth = 0;
                let n: Element | null = ol;
                while (n) {
                    if (n.tagName === 'OL') depth++;
                    n = n.parentElement;
                }
                return { depth, lst: getComputedStyle(ol).listStyleType };
            });
        });
        expect(data).toEqual([
            { depth: 1, lst: 'decimal' },
            { depth: 2, lst: 'lower-alpha' },
            { depth: 3, lst: 'lower-roman' },
            { depth: 4, lst: 'decimal' },
        ]);
    });
});
