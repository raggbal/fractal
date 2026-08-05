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

    // TC-OB-07（sprint 20260805-124854 TASK-06(3)・許可: test_update）: 仕様変更 —
    // 空 ol li も行頭 backspace で demote する（「どんな時も 1 段階目は bullet 解除」・
    // 旧仕様の「空は li 即削除」は空/非空の非対称でカーソル飛びの温床だった）
    test('TC-OB-07: 空 ol li の行頭 backspace も demote する（仕様変更）', async ({ page }) => {
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

        // demote: 空 li が bullet（ul）になる（ol: a は不変）
        const after = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            return {
                ulCount: ed.querySelectorAll('ul').length,
                ulLiCount: ed.querySelectorAll('ul > li').length,
                olTexts: Array.from(ed.querySelectorAll('ol > li')).map(l => l.textContent),
            };
        });
        expect(after.ulCount).toBe(1);
        expect(after.ulLiCount).toBe(1);
        expect(after.olTexts).toEqual(['a']);
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

// sprint 20260805-124854 TASK-06（手動テスト fail 第 2 陣）
test.describe('空 bullet backspace のカーソル・連番結合 (TASK-06)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // (1) code_fix: ネスト内で demote 分割された空 bullet の backspace で、カーソルが
    // 「親 li のテキスト末尾」でなく「直前兄弟リスト（a. sdsd）の末尾」に移動する
    test('TC-OB-09: 親 li 内の ol / 空ul / ol 構造で空 bullet を backspace → カーソルは直前 ol の末尾', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            // 2. dadada の子: a. sdsd / （空 bullet）/ c. sddsds — 画像 #2 の再現
            ed.innerHTML = '<ol><li>aaada</li><li>dadada' +
                '<ol><li>sdsd</li></ol>' +
                '<ul><li><br></li></ul>' +
                '<ol start="3"><li>sddsds</li></ol>' +
                '</li></ol>';
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
        const at = await page.evaluate(() => {
            const sel = window.getSelection()!;
            let n: Node | null = sel.anchorNode;
            while (n && (n as HTMLElement).tagName?.toLowerCase() !== 'li') n = n.parentNode;
            return n ? (n as HTMLElement).textContent : null;
        });
        // counterfactual: 修正前は親 li（dadada...）に飛ぶ = RED
        expect(at).toContain('sdsd');
        expect(at).not.toMatch(/^dadada/);
    });

    // (2) 仕様: 空 bullet 削除で ol 同士が隣接 → 自動結合 + 連番修正（after の start 破棄）
    test('TC-OB-10: ol / 空ul / ol(start=3) の空 bullet を backspace → 1 個の ol・連番', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>aaada</li><li>dadada' +
                '<ol><li>sdsd</li></ol>' +
                '<ul><li><br></li></ul>' +
                '<ol start="3"><li>sddsds</li></ol>' +
                '</li></ol>';
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
        const joined = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const parentLi = ed.querySelectorAll('#editor > ol > li')[1]!;
            const nestedOls = parentLi.querySelectorAll(':scope > ol');
            return {
                olCount: nestedOls.length,
                lis: nestedOls[0] ? Array.from(nestedOls[0].querySelectorAll(':scope > li')).map(l => l.textContent) : [],
                start: nestedOls[0]?.getAttribute('start'),
                ulLeft: parentLi.querySelectorAll(':scope > ul').length,
            };
        });
        // counterfactual: join を外すと nestedOls が 2 個のまま = RED
        expect(joined.olCount).toBe(1);
        expect(joined.lis).toEqual(['sdsd', 'sddsds']);
        expect(joined.start).toBeNull(); // after の start=3 破棄 → a,b（1,2）連番
        expect(joined.ulLeft).toBe(0);
    });

    // (3)+(1)+(2) 統合: 空 ol li → backspace 1 回目 demote（bullet 化）→ 2 回目で結合 + 連番
    test('TC-OB-11: 空 ol li は backspace 2 回で「bullet 化 → 結合・連番」の 2 段階', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>a</li><li><br></li><li>c</li></ol>';
            const li = ed.querySelectorAll('ol > li')[1]!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace'); // 1 回目: demote（ol/ul/ol に分割）
        await page.waitForTimeout(200);
        const mid = await page.evaluate(() => ({
            uls: document.querySelectorAll('#editor ul').length,
            ols: document.querySelectorAll('#editor ol').length,
        }));
        expect(mid.uls).toBe(1);
        expect(mid.ols).toBe(2);
        await page.keyboard.press('Backspace'); // 2 回目: 空 bullet 削除 → ol 結合 + 連番
        await page.waitForTimeout(300);
        const fin = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const ols = ed.querySelectorAll('ol');
            return {
                uls: ed.querySelectorAll('ul').length,
                ols: ols.length,
                lis: ols[0] ? Array.from(ols[0].querySelectorAll(':scope > li')).map(l => l.textContent) : [],
                start: ols[0]?.getAttribute('start'),
            };
        });
        expect(fin.uls).toBe(0);
        expect(fin.ols).toBe(1);
        expect(fin.lis).toEqual(['a', 'c']);
        expect(fin.start).toBeNull(); // 連番（1,2）
    });
});

// sprint 20260805-124854 TASK-06(2) 追補（画像 #5→#6 の再現）: 非空 bullet が
// ol / ol の間にあり、その行頭 backspace で前 ol 末尾へ結合 → ul 消滅 → ol 再結合 + 連番
test.describe('非空 bullet の merge でも ol 再結合 + 連番 (TASK-06 追補)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-OB-12: 1.sdsf / -f / 3.dsds の f 行頭 backspace → sdsff の 1 個の ol・連番', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>sdsf</li></ol><ul><li>f</li></ul><ol start="3"><li>dsds</li></ol>';
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
        const r = await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            const ols = ed.querySelectorAll('ol');
            return {
                olCount: ols.length,
                ulCount: ed.querySelectorAll('ul').length,
                lis: ols[0] ? Array.from(ols[0].querySelectorAll(':scope > li')).map(l => l.textContent) : [],
                start: ols[0]?.getAttribute('start'),
            };
        });
        // counterfactual: join 未配線だと olCount=2 で dsds が「3.」のまま = RED
        expect(r.ulCount).toBe(0);
        expect(r.olCount).toBe(1);
        expect(r.lis).toEqual(['sdsff', 'dsds']);
        expect(r.start).toBeNull(); // 1,2 の連番
    });

    test('TC-OB-13: ネスト内でも同様（親 li 内の ol / -f / ol）', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>p<ol><li>sdsf</li></ol><ul><li>f</li></ul><ol start="3"><li>dsds</li></ol></li></ol>';
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
        const r = await page.evaluate(() => {
            const parentLi = document.querySelector('#editor > ol > li')!;
            const ols = parentLi.querySelectorAll(':scope > ol');
            return {
                olCount: ols.length,
                ulCount: parentLi.querySelectorAll(':scope > ul').length,
                lis: ols[0] ? Array.from(ols[0].querySelectorAll(':scope > li')).map(l => l.textContent) : [],
                start: ols[0]?.getAttribute('start'),
            };
        });
        expect(r.ulCount).toBe(0);
        expect(r.olCount).toBe(1);
        expect(r.lis).toEqual(['sdsff', 'dsds']);
        expect(r.start).toBeNull();
    });

    test('TC-OB-14: ol / -f / ul（次が ol でない）は結合しない（no-op 番人）', async ({ page }) => {
        await page.evaluate(() => {
            const ed = document.getElementById('editor')!;
            ed.innerHTML = '<ol><li>a</li></ol><ul><li>f</li></ul><ul><li>z</li></ul>';
            const li = ed.querySelectorAll('ul')[0]!.querySelector('li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        const r = await page.evaluate(() => ({
            html: document.getElementById('editor')!.innerHTML,
            olLis: Array.from(document.querySelectorAll('#editor ol > li')).map(l => l.textContent),
        }));
        expect(r.olLis).toEqual(['af']); // f は前 ol 末尾へ merge（従来）
        expect(r.html).toContain('<ul><li>z</li></ul>'); // ul z は不変（ol 化されない）
    });
});

// sprint 20260805-124854 TASK-08 追補（画像 #13→#14）: join 時のカーソルは
// 「視覚的に直前の行」= prev 最終 li の最深末尾（入れ子 bullet がある場合はそこ）
test('TC-OB-15: ol(1: sdsff + 子bullet aaadsds) / 空2 / ol(3: d) で空行 bk×2 → カーソルは aaadsds 末尾', async ({ page }) => {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        const ed = document.getElementById('editor')!;
        ed.innerHTML = '<ol><li>sdsff<ul><li>aaadsds</li></ul></li><li><br></li><li>d</li></ol>';
        (ed as HTMLElement).focus();
        const li = ed.querySelectorAll('ol > li')[1]!;
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(li, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await page.keyboard.press('Backspace'); // 1回目: demote（bullet 化）
    await page.waitForTimeout(200);
    await page.keyboard.press('Backspace'); // 2回目: 空 bullet 削除 → ol 結合
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
        const sel = window.getSelection()!;
        let n: Node | null = sel.anchorNode;
        while (n && (n as HTMLElement).tagName?.toLowerCase() !== 'li') n = n.parentNode;
        const ed = document.getElementById('editor')!;
        const ols = ed.querySelectorAll('ol');
        return {
            cursorLiText: n ? (n as HTMLElement).firstChild?.textContent : null,
            olCount: ols.length,
            topTexts: Array.from(ols[0].querySelectorAll(':scope > li')).map(l => (l.firstChild?.textContent || '').trim()),
        };
    });
    // counterfactual: cursorLi を prevLastLi のままにすると sdsff（1 の行）に飛び RED
    expect(r.cursorLiText).toBe('aaadsds');
    expect(r.olCount).toBe(1);
    expect(r.topTexts).toEqual(['sdsff', 'd']); // 1, 2 の連番
});
