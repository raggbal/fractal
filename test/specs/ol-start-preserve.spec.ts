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
    // sprint 20260805-124854 TASK-07（許可: test_update・ADRL-0023 supersede）: 新ルール
    // 「番号手入力は連なりの先頭のみ・以降は自動連番」— 非連続番号でも前の ol へ結合し番号破棄
    test('TC-OL-11: 隣接 ol へは常に merge（打った途中番号は自動連番に補正）', async ({ page }) => {
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
        // 新ルール: 5 は途中番号なので破棄 → 1 本に結合し自動連番（1. a / 2. b）
        expect(olInfo.count).toBe(1);
        expect(olInfo.secondStart).toBeUndefined();

        const md = await editor.getMarkdown();
        expect(md).toContain('2. b');
        expect(md).not.toContain('5. b');
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
    // sprint 20260805-124854 TASK-07（許可: test_update）: 新ルールでは非連続でも常に統合 + 自動連番
    test('TC-OL-13: 隣接 ol は常に統合され、吸収側の start は破棄（自動連番）', async ({ page }) => {
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

        // 非連続でも統合: 変換で生じた ol の直後の ol start=5 は吸収され start 破棄（1,2 の連番）
        await setupAndConvert('<ul><li>m</li><li>n</li></ul><ol start="5"><li>b</li></ol>');
        const nonContiguous = await page.evaluate(() => {
            const ols = document.querySelectorAll('#editor ol');
            return {
                count: ols.length,
                start: ols[0]?.getAttribute('start'),
                liCount: ols[0]?.querySelectorAll(':scope > li').length,
            };
        });
        expect(nonContiguous.count).toBe(1);
        expect(nonContiguous.start).toBeNull();
        expect(nonContiguous.liCount).toBe(2);

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

    // TC-OL-18（sprint 20260805-124854 TASK-07・許可: test_update）: 新ルールでは
    // 段落 x の ol 化で x が連なりの先頭になり、後続 <ol start="5"> は吸収 + start 破棄（自動連番）
    test('TC-OL-18: convertToList(ol) で後続 ol は吸収され自動連番（x=1, a=2）', async ({ page }) => {
        // 入力 A: 段落 x の直後に <ol start="5">。期待: 1 本に結合・x が先頭（暗黙 1）・a は 2
        const prependCase = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<p>x</p><ol start="5"><li>a</li></ol>';
            const p = editor.querySelector('p')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(p);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            (window as any).__testApi.convertToList('ol');
            const ols = editor.querySelectorAll('ol');
            return {
                count: ols.length,
                firstStart: ols[0]?.getAttribute('start'),
                firstLiCount: ols[0]?.querySelectorAll(':scope > li').length,
                texts: ols[0] ? Array.from(ols[0].querySelectorAll(':scope > li')).map(l => l.textContent) : [],
            };
        });
        expect(prependCase.count).toBe(1);
        expect(prependCase.firstStart).toBeNull();   // 連なりの先頭 = 暗黙 1
        expect(prependCase.firstLiCount).toBe(2);
        expect(prependCase.texts).toEqual(['x', 'a']); // a は自動連番で 2 表示

        // 入力 B（append 側）: <ol start="3"> の直後に段落 y。
        // 期待: y は prev に append され連番を継ぐ（従来どおり merge・start="3" 保持）
        const appendCase = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ol start="3"><li>a</li></ol><p>y</p>';
            const p = editor.querySelector('p')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(p);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            (window as any).__testApi.convertToList('ol');
            const ols = editor.querySelectorAll('ol');
            return {
                count: ols.length,
                start: ols[0]?.getAttribute('start'),
                liCount: ols[0]?.querySelectorAll(':scope > li').length,
            };
        });
        expect(appendCase.count).toBe(1);
        expect(appendCase.start).toBe('3');
        expect(appendCase.liCount).toBe(2);

        const md = await editor.getMarkdown();
        expect(md).toContain('3. a');
        expect(md).toContain('4. y');
    });

    // ============ F. convertListToType CASE B split の ol start 焼き（sprint 20260805-124854・FR-OLS 実装漏れ修正） ============
    //
    // バグ（実測）: <ol start="5"> の li を convertListToType('ul')（ツールバー ul / Ctrl+Shift+U 経路）で
    // bullet 化すると、CASE B split（editor.js CASE B）が before/after list を start 無しで新規作成し
    // 1 起点化していた（例: `5. a / 6. b / 7. c` の中間 b を ul 化 → `1. a / - b / 1. c`）。
    // 同操作を changeParentListType 経路（`- `+space）で行うと正しく `5. a / - b / 7. c` になる（ADRL-0027）。
    // 修正: CASE B の before/after list（生成が ol のとき）に applyOlStartIfNeeded で実効 start を焼く。

    // 中間 li を convertListToType('ul') で分割する共通ヘルパ（TC-OL-19/20/21 で再利用）
    const convertLiToUl = async (page: any, fixtureMd: string, liIdx: number) => {
        await page.evaluate((md: string) => {
            (window as any).__testApi.setMarkdown(md);
        }, fixtureMd);
        await page.waitForTimeout(150);
        await page.evaluate((idx: number) => {
            const lis = document.querySelectorAll('#editor ol > li');
            const li = lis[idx]!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            (window as any).__testApi.convertListToType('ul');
        }, liIdx);
    };

    // TC-OL-19 ★load-bearing・counterfactual:
    // 実測 counterfactual（修正を if(false) 化 / start 焼きを削除した buggy source）で `1. a / - b / 1. c`（1 起点化）
    // を確認済み → 修正後 `5. a / - b / 7. c`。CASE B の start 焼き（before=5 保持 / after=7）を削ると RED。
    test('TC-OL-19: convertListToType(ul) で ol 中間 li を bullet 化しても before/after の start が保持される', async ({ page }) => {
        await convertLiToUl(page, '5. a\n6. b\n7. c', 1); // 中間 b を ul 化

        const md = await editor.getMarkdown();
        expect(md).toContain('5. a'); // before list: 元 start=5 保持
        expect(md).toContain('- b');  // 中間: bullet 化
        expect(md).toContain('7. c'); // after list: 5 + (lastConvertIdx+1=2) = 7 起点
        expect(md).not.toContain('1. a'); // 旧バグ（1 起点化）が消えたことの番人
        expect(md).not.toContain('1. c');

        // DOM 側でも before/after の start 属性を確認
        const dom = await page.evaluate(() => {
            const ols = document.querySelectorAll('#editor ol');
            return {
                count: ols.length,
                firstStart: ols[0]?.getAttribute('start'),
                lastStart: ols[ols.length - 1]?.getAttribute('start'),
            };
        });
        expect(dom.count).toBe(2);
        expect(dom.firstStart).toBe('5');
        expect(dom.lastStart).toBe('7');
    });

    // TC-OL-20: 先頭 li ul 化 → after は 6 起点 / 末尾 li ul 化 → before は 5 起点維持。
    // 先頭ケースは before list が生成されない（beforeItems.length===0）ため after 側 start 焼きのみが効く。
    test('TC-OL-20: 先頭 li ul 化で after=6 起点 / 末尾 li ul 化で before=5 起点維持', async ({ page }) => {
        // 先頭 a を ul 化: after = 5 + (0+1) = 6 起点
        await convertLiToUl(page, '5. a\n6. b\n7. c', 0);
        const mdFirst = await editor.getMarkdown();
        expect(mdFirst).toContain('- a');
        expect(mdFirst).toContain('6. b'); // after list は 6 起点
        expect(mdFirst).toContain('7. c');
        expect(mdFirst).not.toContain('1. b'); // 旧バグ番人

        // 末尾 c を ul 化: before = 元 start=5 保持
        await convertLiToUl(page, '5. a\n6. b\n7. c', 2);
        const mdLast = await editor.getMarkdown();
        expect(mdLast).toContain('5. a'); // before list は 5 起点維持
        expect(mdLast).toContain('6. b');
        expect(mdLast).toContain('- c');
        expect(mdLast).not.toContain('1. a'); // 旧バグ番人
    });

    // TC-OL-21 ★対称 pin: convertListToType 経路（ツールバー ul）と changeParentListType 経路（`- `+space）が
    // 同一 fixture・同一操作で一致することを固定する（片経路だけ start 焼きが漏れる再発を検出）。
    test('TC-OL-21: convertListToType 経路と changeParentListType（- +space）経路の結果が一致', async ({ page }) => {
        // 経路 A: convertListToType('ul')（中間 b）
        await convertLiToUl(page, '5. a\n6. b\n7. c', 1);
        const mdConvert = await editor.getMarkdown();

        // 経路 B: 同 fixture の中間 li 内で `- `+space（changeParentListType → mergeAdjacentLists）
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('5. a\n6. b\n7. c');
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor ol > li');
            const li = lis[1]!; // 中間 b
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('- ', { delay: 50 });
        await page.waitForTimeout(200);
        const mdChange = await editor.getMarkdown();

        // 両経路とも `5. a / - b / 7. c` に一致
        expect(mdConvert).toContain('5. a');
        expect(mdConvert).toContain('- b');
        expect(mdConvert).toContain('7. c');
        expect(mdChange).toBe(mdConvert);
    });

    // TC-OL-22: Ctrl+Shift+U ショートカット経由（editor.js の convertListToType('ul') フォールバック手前の実経路）でも
    // 中間 li の bullet 化で before/after start が保持される（__testApi 直呼びと別のキーバインド駆動経路を踏む）。
    test('TC-OL-22: Ctrl+Shift+U 経由でも ol 中間 li の bullet 化で start 保持', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('5. a\n6. b\n7. c');
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor ol > li');
            const li = lis[1]!; // 中間 b
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Control+Shift+U');
        await page.waitForTimeout(200);

        const md = await editor.getMarkdown();
        expect(md).toContain('5. a');
        expect(md).toContain('- b');
        expect(md).toContain('7. c');
        expect(md).not.toContain('1. a');
        expect(md).not.toContain('1. c');
    });
});


// sprint 20260805-124854 TASK-05（手動テスト fail 反映）: bullet 行頭の「N. 」入力で
// 打った番号を尊重する（従来は typedNum を捨て 1 起点化 = 明示番号の無言破棄）。
test.describe('bullet 行頭の「N. 」入力の番号尊重 (TASK-05)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    async function typeAtLiStart(page: import('@playwright/test').Page, selector: string, liIndex: number, text: string) {
        await page.evaluate(({ selector, liIndex }) => {
            const editor = document.getElementById('editor')!;
            (editor as HTMLElement).focus();
            const li = editor.querySelectorAll(selector)[liIndex]!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }, { selector, liIndex });
        await page.keyboard.type(text, { delay: 50 });
        await page.waitForTimeout(150);
    }

    test('TC-OL-23: 1. / - / - の最後の bullet 行頭で「2. 」→ 2. として続く', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ol><li>xxx</li></ol><ul><li>aaa</li><li>bbb</li></ul>';
        });
        await typeAtLiStart(page, 'ul li', 1, '2. ');
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        // counterfactual: typedNum 未配線だと bbb が「1. bbb」になり RED
        expect(md).toContain('1. xxx');
        expect(md).toContain('- aaa');
        expect(md).toContain('2. bbb');
        expect(md).not.toContain('1. bbb');
    });

    test('TC-OL-24: ネスト ul 内の bullet 行頭で「3. 」→ ネスト ol start=3（どの階層でも）', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>parent<ul><li>c1</li><li>c2</li></ul></li></ul>';
        });
        await typeAtLiStart(page, 'ul ul li', 1, '3. ');
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect(html).toMatch(/<ol start="3"><li>c2<\/li><\/ol>/);
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('3. c2');
    });

    test('TC-OL-25: 「1. 」は従来どおり素の ol（start 属性なし = byte 互換）+ 連番なら隣接結合', async ({ page }) => {
        // 単独 bullet → 「1. 」= 属性なし ol（従来挙動不変）
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>only</li></ul>';
        });
        await typeAtLiStart(page, 'ul li', 0, '1. ');
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect(html).toMatch(/<ol><li>only<\/li><\/ol>/);
        expect(html).not.toContain('start=');
        // 連番: 1. a の直後の bullet で「2. 」→ 前 ol に結合（1 個の ol・2 項目）
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ol><li>a</li></ol><ul><li>b</li></ul>';
        });
        await typeAtLiStart(page, 'ul li', 0, '2. ');
        const merged = await page.evaluate(() => {
            const ols = document.querySelectorAll('#editor ol');
            return { count: ols.length, lis: ols[0]?.querySelectorAll(':scope > li').length };
        });
        expect(merged.count).toBe(1);
        expect(merged.lis).toBe(2);
    });
});

// sprint 20260805-124854 TASK-07（画像 #7→#8 の再現）: 連なりの途中の bullet 行で
// 「5. 」等を打っても、前の ol に結合され自動連番になる（途中番号の手入力は補正される）
test.describe('連なりの途中での番号手入力は自動補正 (TASK-07)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-OL-26: ol(a,b) / -xxx / ol(start=4: d,e) の xxx で「5. 」→ 全結合・自動連番', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>sada</li><li>adsa</li></ol><ul><li>xxx</li></ul><ol start="4"><li>sdas</li><li>dsds</li></ol>';
            (ed as HTMLElement).focus();
            const li = ed.querySelector('ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('5. ', { delay: 50 });
        await page.waitForTimeout(200);
        const r = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const ols = ed.querySelectorAll('ol');
            return {
                olCount: ols.length,
                ulCount: ed.querySelectorAll('ul').length,
                texts: ols[0] ? Array.from(ols[0].querySelectorAll(':scope > li')).map(l => l.textContent) : [],
                start: ols[0]?.getAttribute('start'),
            };
        });
        // counterfactual: 旧ルール（連続性判定）だと xxx が <ol start="5"> の独立リストになり olCount=3 = RED
        expect(r.olCount).toBe(1);
        expect(r.ulCount).toBe(0);
        expect(r.texts).toEqual(['sada', 'adsa', 'xxx', 'sdas', 'dsds']); // a,b,c,d,e の自動連番
        expect(r.start).toBeNull();
    });

    test('TC-OL-27: 連なりの先頭（前に ol なし）では打った番号が尊重される（先頭のみ指定可）', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<p>head</p><ul><li>xxx</li></ul>';
            (ed as HTMLElement).focus();
            const li = ed.querySelector('ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('7. ', { delay: 50 });
        await page.waitForTimeout(200);
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect(html).toMatch(/<ol start="7"><li>xxx<\/li><\/ol>/);
    });
});
