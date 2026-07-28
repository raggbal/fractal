/**
 * ol-start-preserve — 数字リストの開始番号保持（sprint 20260729-000358）
 *
 * CommonMark 準拠: 先頭項目の番号が <ol start="N"> を決める。N=1 は属性省略。
 * 2 個目以降の番号は無視（連番正規化）。シリアライズは start 起点連番。
 *
 * TC 定義: .harness/sprint/20260729-000358-ol-start-preserve/testcases.md
 */

import { test, expect } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

test.describe('《数字リスト》開始番号の保持', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        await page.waitForTimeout(500);
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    // ============ A. パース（FR-OLS-01 / FR-OLS-04） ============

    // TC-OL-01 ★load-bearing・counterfactual:
    // parseMarkdownLine が olMatch[2] を捨てる（旧実装）に戻すと <ol>（start 無し）になり RED
    test('TC-OL-01: 先頭番号が start に焼かれる', async ({ page }) => {
        await editor.setMarkdown('3. a\n4. b\n5. c');
        await page.waitForTimeout(200);

        const html = await editor.getHtml();
        expect(html).toContain('<ol start="3">');
        expect(html).toContain('<li>a</li>');
        expect(html).toContain('<li>b</li>');
        expect(html).toContain('<li>c</li>');
    });

    // TC-OL-02 ★load-bearing: 既存 40+ spec（<ol> リテラル assert 群）を守る番人。
    // start=1 でも属性を吐く実装だと RED
    test('TC-OL-02: start=1 は属性省略（既存挙動の番人）', async ({ page }) => {
        await editor.setMarkdown('1. a\n2. b');
        await page.waitForTimeout(200);

        const html = await editor.getHtml();
        expect(html).toContain('<ol>');
        expect(html).not.toContain('<ol start');
    });

    // TC-OL-03: 先頭のみが真実（ADRL-OLS-3）
    test('TC-OL-03: 2 個目以降の番号は無視され連番正規化', async ({ page }) => {
        await editor.setMarkdown('3. a\n7. b\n9. c');
        await page.waitForTimeout(200);

        const html = await editor.getHtml();
        expect(html).toContain('<ol start="3">');
        // li は 3 個（DOM に番号情報は無い = ブラウザ連番）
        const liCount = await page.evaluate(() => {
            const ol = document.querySelector('#editor ol')!;
            return ol.querySelectorAll(':scope > li').length;
        });
        expect(liCount).toBe(3);

        const md = await editor.getMarkdown();
        expect(md).toContain('3. a');
        expect(md).toContain('4. b');
        expect(md).toContain('5. c');
    });

    // TC-OL-04: ネスト ol の各階層 start。
    // counterfactual: open タグ生成 4 箇所のうちネスト経路だけヘルパを通さないと内側 start が落ち RED
    test('TC-OL-04: ネスト ol の各階層で先頭番号が start になる', async ({ page }) => {
        await editor.setMarkdown('3. a\n  5. child1\n  6. child2\n4. b');
        await page.waitForTimeout(200);

        const html = await editor.getHtml();
        expect(html).toContain('<ol start="3">');
        expect(html).toContain('<ol start="5">');

        const md = await editor.getMarkdown();
        expect(md).toContain('3. a');
        expect(md).toMatch(/\s+5\. child1/);
        expect(md).toMatch(/\s+6\. child2/);
        expect(md).toContain('4. b');
    });

    // TC-OL-05: 不正 start は属性を付けず壊れない（FR-OLS-04 allowlist）
    test('TC-OL-05: 0 起点は属性なし・クラッシュしない', async ({ page }) => {
        await editor.setMarkdown('0. a');
        await page.waitForTimeout(200);

        const html = await editor.getHtml();
        expect(html).toContain('<ol>');
        expect(html).not.toContain('<ol start');
        expect(html).toContain('<li>a</li>');
    });

    test('TC-OL-05b: 10 桁番号は属性なし・クラッシュしない', async ({ page }) => {
        await editor.setMarkdown('1234567890. a');
        await page.waitForTimeout(200);

        const html = await editor.getHtml();
        expect(html).not.toContain('<ol start');
        // クラッシュせず何らかの形（ol または p）でレンダリングされる
        expect(html).toContain('a');
    });

    test('TC-OL-05c: 前ゼロ付き番号（03.）は 3 として解釈', async ({ page }) => {
        await editor.setMarkdown('03. a');
        await page.waitForTimeout(200);

        const html = await editor.getHtml();
        expect(html).toContain('<ol start="3">');
    });

    // ============ B. シリアライズ（FR-OLS-02） ============

    // TC-OL-06 ★load-bearing・counterfactual:
    // mdProcessNode case 'ol' の `let num = 1` 固定（旧実装）に戻すと 1. a / 2. b / 3. c になり RED
    test('TC-OL-06: start 起点連番でシリアライズ', async ({ page }) => {
        await editor.setMarkdown('3. a\n4. b\n5. c');
        await page.waitForTimeout(200);

        const md = await editor.getMarkdown();
        expect(md).toContain('3. a');
        expect(md).toContain('4. b');
        expect(md).toContain('5. c');
        expect(md).not.toContain('1. a');
    });

    // TC-OL-07 ★load-bearing: round-trip 安定（md→DOM→md→DOM。バイトのみでなく DOM も assert）
    test('TC-OL-07: round-trip 安定（md/DOM 双方で start 保持）', async ({ page }) => {
        await editor.setMarkdown('3. a\n4. b');
        await page.waitForTimeout(200);
        const md1 = await editor.getMarkdown();

        await editor.setMarkdown(md1);
        await page.waitForTimeout(200);
        const md2 = await editor.getMarkdown();
        const html2 = await editor.getHtml();

        expect(md1).toBe(md2);
        expect(md2).toContain('3. a');
        expect(md2).toContain('4. b');
        expect(html2).toContain('<ol start="3">');
    });

    // TC-OL-08: 不正 start 属性のシリアライズ・ガード（NaN 連番防止）
    test('TC-OL-08: 不正 start 属性は 1 起点フォールバック', async ({ page }) => {
        const md = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ol start="abc"><li>x</li></ol>';
            return (window as any).__testApi.getMarkdown();
        });
        expect(md).toContain('1. x');
        expect(md).not.toContain('NaN');

        const md0 = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ol start="0"><li>x</li></ol>';
            return (window as any).__testApi.getMarkdown();
        });
        expect(md0).toContain('1. x');
    });

    // ============ C. オートフォーマット（FR-OLS-03） ============

    // TC-OL-09 ★load-bearing・counterfactual:
    // checkBlockPatterns olMatch が番号を捨てる（旧実装）に戻すと素の <ol> → md 1. x で RED
    test('TC-OL-09: 「5. + space」で start=5 のリスト開始', async ({ page }) => {
        await editor.type('5. ');
        await editor.type('x');

        const html = await editor.getHtml();
        expect(html).toContain('<ol start="5">');
        expect(html).toContain('<li>x</li>');

        const md = await editor.getMarkdown();
        expect(md).toContain('5. x');
    });

    // TC-OL-10: 従来動作の番人（key-operations.spec.ts:183 と同形）
    test('TC-OL-10: 「1. + space」は従来どおり属性なし', async ({ page }) => {
        await editor.type('1. ');
        await editor.type('x');

        const html = await editor.getHtml();
        expect(html).toContain('<ol>');
        expect(html).not.toContain('<ol start');
    });

    // TC-OL-11 ★load-bearing（ADRL-OLS-2）:
    // counterfactual: 隣接判定が tagName==='ol' のみ（旧実装）だと B が merge され 5 が消えて RED。
    // 注: ol と p の間に空行があると <p><br></p> が挟まり旧実装でも merge しないため、
    // fixture は「ol の直後に p」（空行なし）で作る。
    test('TC-OL-11: 隣接 merge は連続番号のみ（連続→merge / 非連続→独立）', async ({ page }) => {
        const placeCursorInPlaceholder = async () => {
            await page.evaluate(() => {
                const editor = document.getElementById('editor')!;
                const p = Array.from(editor.querySelectorAll('p'))
                    .find(el => el.textContent === 'placeholder')!;
                p.textContent = '';
                const sel = window.getSelection()!;
                const range = document.createRange();
                range.selectNodeContents(p);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            });
        };

        // A: 連続 → merge（1. a の直後の p で 2. → 1 本の ol）
        await editor.setMarkdown('1. a\nplaceholder');
        await page.waitForTimeout(200);
        await placeCursorInPlaceholder();
        await editor.type('2. ');
        await editor.type('b');

        let olInfo = await page.evaluate(() => {
            const ols = document.querySelectorAll('#editor ol');
            return {
                count: ols.length,
                liCount: ols[0]?.querySelectorAll(':scope > li').length,
                start: ols[0]?.getAttribute('start'),
            };
        });
        expect(olInfo.count).toBe(1);
        expect(olInfo.liCount).toBe(2);
        expect(olInfo.start).toBeNull();

        // B: 非連続 → 独立リスト（1. a の直後の p で 5. → ol 2 本、後者は start=5）
        await editor.setMarkdown('1. a\nplaceholder');
        await page.waitForTimeout(200);
        await placeCursorInPlaceholder();
        await editor.type('5. ');
        await editor.type('b');

        olInfo = await page.evaluate(() => {
            const ols = document.querySelectorAll('#editor ol');
            return {
                count: ols.length,
                secondStart: ols[1]?.getAttribute('start'),
            };
        });
        expect(olInfo.count).toBe(2);
        expect(olInfo.secondStart).toBe('5');

        const md = await editor.getMarkdown();
        expect(md).toContain('5. b');
        expect(md).not.toContain('2. b');
    });

    // TC-OL-12: Enter 継続はブラウザ連番 + start 起点シリアライズ
    test('TC-OL-12: Enter でのリスト継続は start 起点で連番', async ({ page }) => {
        await editor.setMarkdown('3. a');
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const li = document.querySelector('#editor ol li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Enter');
        await editor.type('b');

        const html = await editor.getHtml();
        expect(html).toContain('<ol start="3">');

        const md = await editor.getMarkdown();
        expect(md).toContain('3. a');
        expect(md).toContain('4. b');
    });

    // ============ D. merge / 差分更新（NFR-OLS-02 / NFR-OLS-03） ============

    // TC-OL-13 ★load-bearing:
    // counterfactual: areListsCompatible の ol 無条件 true（旧実装）だと非連続ケースが統合され start=5 が消えて RED。
    // mergeAdjacentLists の唯一の呼び出し元は changeParentListType（複数兄弟分岐）なので、
    // 「ul の末尾 li 内で 1.+space 型変換」という実経路で駆動する
    //（__testApi.convertListToType は mergeAdjacentLists を呼ばない別経路 — design-review 指摘の解決）。
    test('TC-OL-13: start 非連続の隣接 ol は統合されない／連続は統合される', async ({ page }) => {
        const setupAndConvert = async (fixtureHtml: string) => {
            await page.evaluate((html) => {
                const editor = document.getElementById('editor')!;
                editor.innerHTML = html;
                (editor as HTMLElement).focus();
                // ul の 2 番目の li（n）の先頭にカーソル
                const li = editor.querySelectorAll('ul li')[1]!;
                const sel = window.getSelection()!;
                const range = document.createRange();
                range.setStart(li.firstChild!, 0);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }, fixtureHtml);
            // li 内で「1. + space」→ 型変換 → changeParentListType（複数兄弟 split）→ mergeAdjacentLists
            // 注: editor.type() は冒頭の click で設定済みカーソルを飛ばすため keyboard.type を直接使う
            await page.keyboard.type('1. ', { delay: 50 });
            await page.waitForTimeout(100);
        };

        // 非連続: 変換で生じた ol（実効 start=1, li 1 個）の直後に ol start=5 → 1+1=2 ≠ 5 → 統合されない
        await setupAndConvert('<ul><li>m</li><li>n</li></ul><ol start="5"><li>b</li></ol>');
        const nonContiguous = await page.evaluate(() => {
            const ols = document.querySelectorAll('#editor ol');
            return {
                count: ols.length,
                lastStart: ols[ols.length - 1]?.getAttribute('start'),
                lastLiCount: ols[ols.length - 1]?.querySelectorAll(':scope > li').length,
            };
        });
        expect(nonContiguous.count).toBe(2);
        expect(nonContiguous.lastStart).toBe('5');
        expect(nonContiguous.lastLiCount).toBe(1);

        // 連続: 直後の ol が start=2 → 1+1=2 === 2 → 1 本に統合、先行側（属性なし=実効1）を保持
        await setupAndConvert('<ul><li>m</li><li>n</li></ul><ol start="2"><li>b</li></ol>');
        const contiguous = await page.evaluate(() => {
            const ols = document.querySelectorAll('#editor ol');
            return {
                count: ols.length,
                liCount: ols[0]?.querySelectorAll(':scope > li').length,
                start: ols[0]?.getAttribute('start'),
            };
        });
        expect(contiguous.count).toBe(1);
        expect(contiguous.liCount).toBe(2);
        expect(contiguous.start).toBeNull();
    });

    // TC-OL-14 ★load-bearing・counterfactual:
    // blocksAreEqual に start 比較が無い（旧実装）と innerHTML 同一のため「等しい」と誤判定され DOM が変わらず RED
    test('TC-OL-14: updateFromMarkdown（差分更新）経路で start 変更が反映', async ({ page }) => {
        await editor.setMarkdown('1. a\n2. b');
        await page.waitForTimeout(200);

        const start = await page.evaluate(() => {
            (window as any).__testApi.updateMarkdown('3. a\n4. b');
            return document.querySelector('#editor ol')?.getAttribute('start');
        });
        expect(start).toBe('3');

        // 逆方向（start 除去）も反映される
        const startBack = await page.evaluate(() => {
            (window as any).__testApi.updateMarkdown('1. a\n2. b');
            return document.querySelector('#editor ol')?.getAttribute('start');
        });
        expect(startBack).toBeNull();
    });

    // ============ E. undo / 回帰（NFR-OLS-01 / NFR-OLS-03） ============

    // TC-OL-15: undo は md snapshot 経由なので parse/serialize が正しければ start が保たれる。
    // serialize が 1 起点に戻す回帰（旧 num=1 固定）があると undo 後に start が消えて RED
    test('TC-OL-15: undo/redo で start 保持', async ({ page }) => {
        await editor.type('5. ');
        await editor.type('x');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        await editor.type('y');
        await page.waitForTimeout(600); // undo snapshot（debounce）を確定させる

        let html = await editor.getHtml();
        expect(html).toContain('<ol start="5">');

        await editor.shortcut('z'); // undo
        await page.waitForTimeout(300);
        html = await editor.getHtml();
        expect(html).toContain('<ol start="5">'); // undo 後も 5 起点

        await editor.shortcut('Shift+z'); // redo
        await page.waitForTimeout(300);
        html = await editor.getHtml();
        expect(html).toContain('<ol start="5">');
    });

    // TC-OL-16: bullet→ordered 変換は属性なし ol（v1.1.9 changeParentListType 経路との交差回帰。
    // toolbar-list-conversion.spec.ts 群の巻き添え防止）
    test('TC-OL-16: bullet→ordered 変換は属性なし ol を作る', async ({ page }) => {
        await editor.setMarkdown('- a\n- b');
        await page.waitForTimeout(200);

        const result = await page.evaluate(() => {
            const li = document.querySelector('#editor ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            (window as any).__testApi.convertListToType('ol');
            const ol = document.querySelector('#editor ol');
            return { hasOl: !!ol, start: ol?.getAttribute('start') };
        });
        expect(result.hasOl).toBe(true);
        expect(result.start).toBeNull();

        const md = await editor.getMarkdown();
        expect(md).toContain('1. a');
    });

    // TC-OL-17: ol 途中行の削除で start 保持（v1.1.10 cut 掃除経路との交差回帰）
    test('TC-OL-17: ol 途中項目の cut/削除で start 保持', async ({ page }) => {
        await editor.setMarkdown('3. a\n4. b\n5. c');
        await page.waitForTimeout(200);

        // 2 番目 li（b）を範囲選択して cut
        await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor ol > li');
            const li = lis[1]!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+x' : 'Control+x');
        await page.waitForTimeout(300);

        const html = await editor.getHtml();
        expect(html).toContain('<ol start="3">');

        const md = await editor.getMarkdown();
        expect(md).toContain('3. a');
        expect(md).toContain('c'); // c は残る（cut の空 li 掃除仕様により番号は 4. に詰まる）
        expect(md).not.toContain('1. a');
    });
});

