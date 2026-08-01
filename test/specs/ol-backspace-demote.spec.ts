/**
 * ol-backspace-demote — 数字リスト行頭 backspace の 2 段階化（sprint 20260730-071730）
 *
 * FR-OLB-01: ol li 行頭 backspace 1 回目 = 通常バレット化（全 ol li、ネスト含む = ADRL-LST-1）
 * FR-OLB-02: 2 回目 = 従来の結合（既存経路）
 * FR-OLB-03: 残り ol の表示番号を変えない（after-ol に start 焼き = ADRL-LST-2）
 * FR-OLB-04: round-trip 整合
 *
 * TC 定義: .harness/sprint/20260730-071730-list-optenter-wrap-olbackspace/testcases.md
 */

import { test, expect } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

// n 番目（0-index）の ol li のテキスト先頭にカーソル
async function cursorAtLiStart(page: any, liIndex: number, selector = '#editor ol > li') {
    await page.evaluate(({ idx, sel: cssSel }: any) => {
        const li = document.querySelectorAll(cssSel)[idx]!;
        const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode()!;
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }, { idx: liIndex, sel: selector });
}

test.describe('ol 行頭 backspace の 2 段階化', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    // TC-OB-01 ★load-bearing・counterfactual A/B:
    // A: demote 分岐を外すと従来の結合で RED / B: after-ol start 焼きを外すと c が 1 表示で RED
    test('TC-OB-01: 途中行の行頭 backspace → バレット化 + 番号維持', async ({ page }) => {
        await editor.setMarkdown('1. a\n2. b\n3. c');
        await page.waitForTimeout(200);
        await cursorAtLiStart(page, 1);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        const structure = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const children = Array.from(ed.children).map(el => ({
                tag: el.tagName.toLowerCase(),
                start: el.getAttribute('start'),
                texts: Array.from(el.querySelectorAll(':scope > li')).map(li => li.textContent),
            }));
            return children;
        });
        // <ol>[a] <ul>[b] <ol start="3">[c]
        expect(structure).toEqual([
            { tag: 'ol', start: null, texts: ['a'] },
            { tag: 'ul', start: null, texts: ['b'] },
            { tag: 'ol', start: '3', texts: ['c'] },
        ]);

        // カーソルは b の先頭
        await page.keyboard.type('X');
        await page.waitForTimeout(200);
        const md = await editor.getMarkdown();
        expect(md).toContain('Xb');
    });

    // TC-OB-02: 2 回目の backspace で前の ol 末尾に結合（FR-OLB-02）
    // sprint 20260802-010347 (TU-OBM-01, 許可: test_update): 旧 assert は negative-only
    //（段落化しても green の tautology）だったため、「上のリストへ結合」を positive に強化。
    // = TC-OBM-01 ★load-bearing・counterfactual: findVisuallyPreviousElement の
    //   crossTopLevelList 分岐を外すと段落化して RED
    test('TC-OB-02: 2 回目 backspace で前の ol 末尾に結合（TC-OBM-01）', async ({ page }) => {
        await editor.setMarkdown('1. a\n2. b\n3. c');
        await page.waitForTimeout(200);
        await cursorAtLiStart(page, 1);
        await page.keyboard.press('Backspace'); // 1 回目: demote
        await page.waitForTimeout(200);
        await page.keyboard.press('Backspace'); // 2 回目: 前の ol 末尾へ結合
        await page.waitForTimeout(300);

        const md = await editor.getMarkdown();
        expect(md).toContain('1. ab'); // b が a の末尾に結合（positive assert）
        expect(md).not.toMatch(/^- b$/m); // 独立バレットが消える
        // 段落化していない（<p>b</p> が無い）
        const html = await editor.getHtml();
        expect(html).not.toMatch(/<p>b<\/p>/);
        expect(md).toContain('c'); // c は残る
    });

    // TC-OBM-02: 手書きの「ol 直後の ul 先頭 li」でも結合（demote 経路に限らない一般ケース）
    test('TC-OBM-02: ol 直後の ul 先頭 li の行頭 backspace → ol 末尾へ結合', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>a</li></ol><ul><li>b</li></ul>';
            const li = ed.querySelector('ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);

        const md = await editor.getMarkdown();
        expect(md).toContain('1. ab');
        expect(md).not.toMatch(/^- b$/m);
    });

    // TC-OBM-03: 前が段落なら従来どおり（結合しない = 不変の番人）
    test('TC-OBM-03: 前が段落のリスト先頭 li は従来どおり（結合しない）', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<p>para</p><ul><li>b</li></ul>';
            const li = ed.querySelector('ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);

        const md = await editor.getMarkdown();
        // para の末尾に結合されない（従来挙動 = リスト解除等。少なくとも "parab" にならない）
        expect(md).not.toContain('parab');
        expect(md).toContain('para');
        expect(md).toContain('b');
    });

    // TC-OBM-05: nested の cross-merge は不変（前段 :7960 経路の回帰番人。
    // backspace-mixed-nested-list.spec の green 維持と重ねての明示 1 本）
    test('TC-OBM-05: ネスト内の前兄弟リストへの cross-merge は従来どおり', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            // 親 li 内: ul[b] の後に ul[c]（nested 先頭 li の cross-merge 構成）
            ed.innerHTML = '<ul><li>a<ul><li>b</li></ul><ul><li>c</li></ul></li></ul>';
            const lis = ed.querySelectorAll('li li');
            const li = lis[1]!; // c
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);

        const html = await editor.getHtml();
        expect(html).toContain('bc'); // 前兄弟リスト末尾へ統合（従来どおり）
    });

    // TC-OBM-04 ★load-bearing: 空 li は opt-in 対象外（段落化の既存仕様不変）
    // counterfactual: opt-in でなく無条件分岐にすると空 li が前の ol に結合され RED
    test('TC-OBM-04: 前が ol でも空 li の行頭 backspace は従来どおり（結合しない）', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>a</li></ol><ul><li><br></li></ul>';
            const li = ed.querySelector('ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);

        // 空 li のテキストが a に結合される事象は起きない（a は不変）
        const md = await editor.getMarkdown();
        expect(md).toMatch(/1\. a$|1\. a\n/);
        // ol の li 数が増えていない（結合で空テキストが足されてもいない）
        const liCount = await page.evaluate(() =>
            document.querySelectorAll('#editor ol > li').length);
        expect(liCount).toBe(1);
        // sprint 20260802-010347 (TASK-04, 許可: test_update): 段落化の実挙動を番人化。
        // 正しい実装は handleEmptyLi の "No previous element" 分岐が <p><br></p> を生成する。
        // counterfactual（opt-in を無条件分岐にする）だと空 li が ol へ結合され <p> が生成されず RED
        //（旧 assert 2 本は両実装で同一結果の tautology だった）。
        const hasParagraph = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            return !!ed.querySelector('ol + p, ol ~ p');
        });
        expect(hasParagraph).toBe(true);
    });

    // TC-OB-03: 先頭行のバレット化（シナリオ i / ii）
    test('TC-OB-03: 先頭行の demote で残り ol の番号維持', async ({ page }) => {
        // A: start なし ol の先頭 → 残りは start="2"
        await editor.setMarkdown('1. a\n2. b');
        await page.waitForTimeout(200);
        await cursorAtLiStart(page, 0);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        let structure = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            return Array.from(ed.children).map(el => ({
                tag: el.tagName.toLowerCase(), start: el.getAttribute('start'),
            }));
        });
        expect(structure).toEqual([
            { tag: 'ul', start: null },
            { tag: 'ol', start: '2' },
        ]);

        // B: <ol start="5"> の先頭 → 残りは start="6"
        await editor.setMarkdown('5. a\n6. b');
        await page.waitForTimeout(200);
        await cursorAtLiStart(page, 0);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        structure = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            return Array.from(ed.children).map(el => ({
                tag: el.tagName.toLowerCase(), start: el.getAttribute('start'),
            }));
        });
        expect(structure).toEqual([
            { tag: 'ul', start: null },
            { tag: 'ol', start: '6' },
        ]);
    });

    // TC-OB-04: 唯一行のバレット化（シナリオ iv・stale start 防止）
    test('TC-OB-04: 唯一行の demote で ol 消滅・ul に stale start なし', async ({ page }) => {
        // start 付き ol でも ul に start が持ち込まれない（changeParentListType 属性コピー修正の番人）
        await editor.setMarkdown('5. only');
        await page.waitForTimeout(200);
        await cursorAtLiStart(page, 0);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        const structure = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const ul = ed.querySelector('ul');
            return {
                olCount: ed.querySelectorAll('ol').length,
                ulHasStart: ul?.hasAttribute('start'),
                text: ul?.textContent,
            };
        });
        expect(structure.olCount).toBe(0);
        expect(structure.ulHasStart).toBe(false);
        expect(structure.text).toBe('only');

        const md = await editor.getMarkdown();
        expect(md).toContain('- only');
    });

    // TC-OB-05 ★load-bearing: ネスト先頭 ol li の demote（TU-LST-01 の仕様変更と対）
    test('TC-OB-05: ネスト先頭 ol li の行頭 backspace → バレット化 + 番号維持', async ({ page }) => {
        const structure = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ul><li>parent<ol><li>x</li><li>y</li></ol></li></ul>';
            const li = ed.querySelector('ol > li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
        });
        expect(structure).toBe(true);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        const after = await page.evaluate(() => {
            const parentLi = document.querySelector('#editor > ul > li')!;
            const lists = Array.from(parentLi.querySelectorAll(':scope > ul, :scope > ol')).map(el => ({
                tag: el.tagName.toLowerCase(),
                start: el.getAttribute('start'),
                texts: Array.from(el.querySelectorAll(':scope > li')).map(li => li.textContent),
            }));
            return lists;
        });
        // x が ul li 化・y は start="2" の ol（番号維持）
        expect(after).toEqual([
            { tag: 'ul', start: null, texts: ['x'] },
            { tag: 'ol', start: '2', texts: ['y'] },
        ]);
    });

    // TC-OB-06 ★load-bearing・counterfactual: ネスト非先頭 ol li（第 3 状態・designer_failures 2026-07-30）
    // counterfactual: demote 判定に nested 除外（!isNestedList 等）を足すとこの状態が merge に落ち RED
    test('TC-OB-06: ネスト非先頭 ol li の行頭 backspace → バレット化', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ul><li>parent<ol><li>a</li><li>b</li><li>c</li></ol></li></ul>';
            const lis = ed.querySelectorAll('ol > li');
            const li = lis[2]!; // c = 非先頭
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        const after = await page.evaluate(() => {
            const parentLi = document.querySelector('#editor > ul > li')!;
            return Array.from(parentLi.querySelectorAll(':scope > ul, :scope > ol')).map(el => ({
                tag: el.tagName.toLowerCase(),
                start: el.getAttribute('start'),
                texts: Array.from(el.querySelectorAll(':scope > li')).map(li => li.textContent),
            }));
        });
        // a,b は元 ol・c は末尾で ul li 化（after 側なし）
        expect(after).toEqual([
            { tag: 'ol', start: null, texts: ['a', 'b'] },
            { tag: 'ul', start: null, texts: ['c'] },
        ]);
    });

    // TC-OB-07: 空 ol li は demote 対象外（既存の空 li 処理のまま）
    test('TC-OB-07: 空 ol li の行頭 backspace は demote しない', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>a</li><li><br></li></ol>';
            const li = ed.querySelectorAll('ol > li')[1]!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);

        // demote（<ul><li><br></li></ul> の出現）ではなく既存処理（li 削除 or 段落化）
        const after = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            return { ulCount: ed.querySelectorAll('ul').length, html: ed.innerHTML.slice(0, 200) };
        });
        expect(after.ulCount).toBe(0);
    });

    // TC-OB-08: task li は既存 checkbox 剥がしのまま（demote 経路に吸われない）
    test('TC-OB-08: ネスト task li 先頭の backspace は checkbox 剥がし（既存）', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ul><li>parent<ul><li><input type="checkbox">task1</li></ul></li></ul>';
            const li = ed.querySelector('li li')!;
            const textNode = Array.from(li.childNodes).find(n => n.nodeType === 3)!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(textNode, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        const after = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const inner = ed.querySelector('li li')!;
            return {
                checkboxCount: ed.querySelectorAll('input[type="checkbox"]').length,
                innerText: inner?.textContent,
            };
        });
        expect(after.checkboxCount).toBe(0); // checkbox が剥がれた
        expect(after.innerText).toBe('task1'); // li は残る（merge されていない）
    });

    // TC-OB-09: バレット化の undo（NFR-LST-03）
    test('TC-OB-09: demote の undo で元の ol に戻る', async ({ page }) => {
        await editor.setMarkdown('1. a\n2. b\n3. c');
        await page.waitForTimeout(400);
        await cursorAtLiStart(page, 1);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(400);

        let md = await editor.getMarkdown();
        expect(md).toContain('- b');

        await editor.shortcut('z');
        await page.waitForTimeout(300);
        md = await editor.getMarkdown();
        expect(md).toContain('1. a');
        expect(md).toContain('2. b');
        expect(md).toContain('3. c');
        expect(md).not.toContain('- b');
    });

    // TC-OB-10: round-trip（FR-OLB-04）
    test('TC-OB-10: demote 結果の md 再投入で同じ DOM に戻る', async ({ page }) => {
        await editor.setMarkdown('1. a\n2. b\n3. c');
        await page.waitForTimeout(200);
        await cursorAtLiStart(page, 1);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        const md1 = await editor.getMarkdown();
        await editor.setMarkdown(md1);
        await page.waitForTimeout(200);

        // 末尾改行由来の <p><br></p> は除外し、リスト要素の構造だけを比較
        const structure = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            return Array.from(ed.children)
                .filter(el => el.tagName === 'OL' || el.tagName === 'UL')
                .map(el => ({
                    tag: el.tagName.toLowerCase(), start: el.getAttribute('start'),
                }));
        });
        expect(structure).toEqual([
            { tag: 'ol', start: null },
            { tag: 'ul', start: null },
            { tag: 'ol', start: '3' },
        ]);
        const md2 = await editor.getMarkdown();
        expect(md2).toBe(md1);
    });

    // TC-OB-11: space 打鍵の「- 」型変換でも番号維持（changeParentListType 共有経路の番人・design-review MEDIUM②）
    test('TC-OB-11: リスト内「- +space」型変換でも after-ol の番号維持', async ({ page }) => {
        await editor.setMarkdown('1. a\n2. b\n3. c');
        await page.waitForTimeout(200);
        await cursorAtLiStart(page, 1);
        await page.keyboard.type('- ', { delay: 50 });
        await page.waitForTimeout(200);

        const structure = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            return Array.from(ed.children).map(el => ({
                tag: el.tagName.toLowerCase(), start: el.getAttribute('start'),
                texts: Array.from(el.querySelectorAll(':scope > li')).map(li => li.textContent),
            }));
        });
        expect(structure).toEqual([
            { tag: 'ol', start: null, texts: ['a'] },
            { tag: 'ul', start: null, texts: ['b'] },
            { tag: 'ol', start: '3', texts: ['c'] },
        ]);
    });
});
