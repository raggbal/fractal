/**
 * md-list-undo-replace — リスト内で選択範囲をタイプで置き換えたあと undo で戻らない（データ消失）
 *
 * 症状: li の文字を選択した状態で文字を打つと選択が置き換わり、Cmd+Z を押しても元に戻らない。
 * 原因: editor の beforeinput で「選択範囲の端が要素（li 等）」のとき li の中身を手で置き換える
 *   ハンドラ（triple-click 置換）が preventDefault する → input が来ず snapshot が積まれない。
 *   さらに undo 用の「変化前」記録（notePreEditCursor）がその後に登録された listener で、
 *   手で置き換えた後の DOM を「変化前」として拾っていた。
 *
 * 同じハンドラ（と paste の同形分岐）は選択範囲でなく li の文字を丸ごと消していた（選択の外まで消える）
 *   → 選択した範囲だけ消す（UR-04 / UR-17〜25）。
 * 今の内容と同じ update（自分の保存のはね返り）が idle で届くと undo 履歴が消えていた（UR-26 / 27）。
 *
 * 実キー入力（page.keyboard）で選択 → タイプ → Meta/Control+z を確かめる。
 */

import { test, expect, Page } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

// li の n 番目（document 順）の直下テキストの [start, end) を選択する（text node 内の選択）
async function selectTextInLi(page: Page, liIdx: number, start: number, end: number) {
    await page.evaluate(({ liIdx, start, end }) => {
        const li = document.querySelectorAll('#editor li')[liIdx]!;
        const tn = Array.from(li.childNodes).find(n => n.nodeType === 3 && (n.textContent || '').trim())!;
        const r = document.createRange();
        r.setStart(tn, start);
        r.setEnd(tn, end);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
    }, { liIdx, start, end });
}

// li の中身全体を要素境界で選択する（トリプルクリック / マウスで行末まで引いたときの形）
async function selectLiContents(page: Page, liIdx: number) {
    await page.evaluate((liIdx) => {
        const li = document.querySelectorAll('#editor li')[liIdx]!;
        const r = document.createRange();
        r.selectNodeContents(li);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
    }, liIdx);
}

// li[a] の text offset から li[b] の先頭（要素境界 offset 0）までを選択する
async function selectLiTextToNextLiStart(page: Page, a: number, offset: number, b: number) {
    await page.evaluate(({ a, offset, b }) => {
        const lis = document.querySelectorAll('#editor li');
        const tn = Array.from(lis[a]!.childNodes).find(n => n.nodeType === 3 && (n.textContent || '').trim())!;
        const r = document.createRange();
        r.setStart(tn, offset);
        r.setEnd(lis[b]!, 0);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
    }, { a, offset, b });
}

// li[a] の直下テキスト中の needle の先頭から、li[b] の先頭（要素境界 offset 0）までを選択する
async function selectFromNeedleToLiStart(page: Page, a: number, needle: string, b: number) {
    await page.evaluate(({ a, needle, b }) => {
        const lis = document.querySelectorAll('#editor li');
        const tn = Array.from(lis[a]!.childNodes).find(n => n.nodeType === 3 && (n.textContent || '').includes(needle))!;
        const r = document.createRange();
        r.setStart(tn, (tn.textContent || '').indexOf(needle));
        r.setEnd(lis[b]!, 0);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
    }, { a, needle, b });
}

const mdOf = async (editor: EditorTestHelper) => (await editor.getMarkdown()).replace(/\n+$/, '');

async function waitDebounce(page: Page) {
    // タイピング debounce（500ms）が切れるのを待つ
    await page.waitForTimeout(700);
}

test.describe('リスト内の選択置換を undo で戻せる（データ消失）', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        editor = new EditorTestHelper(page);
        await editor.focus();
    });

    test('UR-01: li の一部を選択して 1 文字タイプ → undo で元の文字に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectTextInLi(page, 0, 6, 10);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toContain('- alpha X gamma');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });

    test('UR-02: li の中身全体（要素境界の選択）をタイプで置換 → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('alpha');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });

    test('UR-03: トリプルクリックで li を選択して数文字タイプ → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await page.locator('#editor li').first().click({ clickCount: 3 });
        await page.keyboard.type('xyz');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('alpha');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });

    test('UR-04: 2 つの li にまたがる選択（text → 次 li 先頭）をタイプ → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta\n- second\n- third');
        await page.waitForTimeout(200);
        await selectLiTextToNextLiStart(page, 0, 6, 1);
        await page.keyboard.type('X');
        await waitDebounce(page);
        // 選択は「beta」+ 行末まで。選択の外の「alpha 」と次の li は残る
        //（修正前は li の文字を丸ごと消して「- X」になっていた = 選択の外まで消すデータ消失）
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha X\n- second\n- third');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta\n- second\n- third');
    });

    test('UR-05: 2 つの li にまたがる選択（Shift+Down）をタイプ → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta\n- second\n- third');
        await page.waitForTimeout(200);
        await selectTextInLi(page, 0, 6, 6);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.type('X');
        await waitDebounce(page);
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta\n- second\n- third');
    });

    test('UR-06: ネストしたリストの子 li を要素境界で選択して置換 → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- parent\n  - child text\n  - sibling\n- next');
        await page.waitForTimeout(200);
        await selectLiContents(page, 1);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('child text');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- parent\n  - child text\n  - sibling\n- next');
    });

    test('UR-07: 親 li（子リストあり）を要素境界で選択して置換 → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- parent text\n  - child\n- next');
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const r = document.createRange();
            r.setStart(li, 0);
            r.setEnd(li.firstChild!, (li.firstChild!.textContent || '').length);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('parent text');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- parent text\n  - child\n- next');
    });

    test('UR-08: タスクリストの li を要素境界で選択して置換 → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- [ ] task one\n- [x] task two');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('task one');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- [ ] task one\n- [x] task two');
    });

    test('UR-09: タスクリストの li の一部を選択して置換 → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- [ ] task one\n- [x] task two');
        await page.waitForTimeout(200);
        await selectTextInLi(page, 0, 0, 4);
        await page.keyboard.type('X');
        await waitDebounce(page);
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- [ ] task one\n- [x] task two');
    });

    test('UR-10: 要素境界の選択を Backspace で消す → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        await page.keyboard.press('Backspace');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('alpha');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });

    test('UR-11: IME 合成で li の選択（要素境界）を置換 → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        const client = await page.context().newCDPSession(page);
        await client.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
        await page.waitForTimeout(100);
        await client.send('Input.imeSetComposition', { text: 'あい', selectionStart: 2, selectionEnd: 2 });
        await page.waitForTimeout(100);
        await client.send('Input.insertText', { text: 'あい' });
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('alpha');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });

    test('UR-12: IME 合成で li の一部（text 内）を置換 → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectTextInLi(page, 0, 6, 10);
        const client = await page.context().newCDPSession(page);
        await client.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
        await page.waitForTimeout(100);
        await client.send('Input.insertText', { text: 'あ' });
        await waitDebounce(page);
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });

    test('UR-13: タイプ → 置換 → タイプを重ねても undo を繰り返せば元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        // 1) li 末尾にタイプ
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const r = document.createRange();
            r.selectNodeContents(li); r.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type(' delta');
        await waitDebounce(page);
        // 2) li 全体を要素境界で選択して置換
        await selectLiContents(page, 0);
        await page.keyboard.type('Z');
        await waitDebounce(page);
        // 3) 続けてタイプ
        await page.keyboard.type('zz');
        await waitDebounce(page);
        const md = async () => (await editor.getMarkdown()).replace(/\n+$/, '');
        expect(await md()).toBe('- Zzz\n- second');
        // 1 手ずつ戻る: Zzz → Z → 置換前(delta 付き) → 元
        await editor.shortcut('z');
        await page.waitForTimeout(250);
        expect(await md()).toBe('- Z\n- second');
        await editor.shortcut('z');
        await page.waitForTimeout(250);
        expect(await md()).toBe('- alpha beta gamma delta\n- second');
        await editor.shortcut('z');
        await page.waitForTimeout(250);
        expect(await md()).toBe('- alpha beta gamma\n- second');
    });

    test('UR-14: undo 直後（debounce 窓内）に選択置換しても undo で戻せる', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const r = document.createRange();
            r.selectNodeContents(li); r.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type('Q');
        await editor.shortcut('z');
        await page.waitForTimeout(50);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
        await selectTextInLi(page, 0, 6, 10);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toContain('- alpha X gamma');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });
    test('UR-15: 要素境界の選択を Delete で消す → undo で元に戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        await page.keyboard.press('Delete');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).not.toContain('alpha');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- alpha beta gamma\n- second');
    });

    test('UR-16: li 内の太字末尾にタイプ（inline 境界脱出の手書き挿入）→ undo で消える', async ({ page }) => {
        await editor.setMarkdown('- plain **bold**\n- second');
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const strong = document.querySelector('#editor li strong')!;
            const tn = strong.firstChild!;
            const r = document.createRange();
            r.setStart(tn, (tn.textContent || '').length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type('Q');
        await waitDebounce(page);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- plain **bold**Q\n- second');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect((await editor.getMarkdown()).replace(/\n+$/, "")).toBe('- plain **bold**\n- second');
    });
    // ---- 選択より広く消さない（選択の外は残る）+ undo で戻る ----
    // 要素境界の選択は beforeinput で手で消している（ブラウザ標準だと次の li が結合される・
    // チェックボックスや子リストが消える）。以前は li の文字を丸ごと消し、選択の外まで消していた。

    test('UR-17: li の途中 → 次 li 先頭の選択を Delete → 選択の外は残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta\n- second\n- third');
        await page.waitForTimeout(200);
        await selectFromNeedleToLiStart(page, 0, 'beta', 1);
        await page.keyboard.press('Delete');
        await waitDebounce(page);
        const md = await mdOf(editor);
        expect(md).toMatch(/^- alpha\s*\n- second\n- third$/);
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- alpha beta\n- second\n- third');
    });

    test('UR-18: li の途中 → 次 li 先頭の選択を Backspace → 選択の外は残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta\n- second\n- third');
        await page.waitForTimeout(200);
        await selectFromNeedleToLiStart(page, 0, 'beta', 1);
        await page.keyboard.press('Backspace');
        await waitDebounce(page);
        const md = await mdOf(editor);
        expect(md).toMatch(/^- alpha\s*\n- second\n- third$/);
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- alpha beta\n- second\n- third');
    });

    test('UR-19: li の途中 → 次 li 先頭の選択を IME で置換 → 選択の外は残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta\n- second\n- third');
        await page.waitForTimeout(200);
        await selectFromNeedleToLiStart(page, 0, 'beta', 1);
        const client = await page.context().newCDPSession(page);
        await client.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
        await page.waitForTimeout(100);
        await client.send('Input.insertText', { text: 'あ' });
        await waitDebounce(page);
        const md = await mdOf(editor);
        expect(md).toContain('alpha あ');
        expect(md).toContain('second');
        expect(md).toContain('third');
        expect(md).not.toContain('beta');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- alpha beta\n- second\n- third');
    });

    test('UR-20: ネストの子 li の途中 → 次の子 li 先頭の選択をタイプ → 選択の外は残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- parent\n  - child text\n  - sibling\n- next');
        await page.waitForTimeout(200);
        await selectFromNeedleToLiStart(page, 1, 'text', 2);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect(await mdOf(editor)).toBe('- parent\n  - child X\n  - sibling\n- next');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- parent\n  - child text\n  - sibling\n- next');
    });

    test('UR-21: 親 li の途中 → 子 li 先頭の選択をタイプ → 親の残りと子リストは残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- parent text\n  - child\n- next');
        await page.waitForTimeout(200);
        await selectFromNeedleToLiStart(page, 0, 'text', 1);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect(await mdOf(editor)).toBe('- parent X\n  - child\n- next');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- parent text\n  - child\n- next');
    });

    test('UR-22: タスクリストの li の途中 → 次 li 先頭の選択をタイプ → チェックボックスと残りは残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- [ ] task one\n- [x] task two');
        await page.waitForTimeout(200);
        await selectFromNeedleToLiStart(page, 0, 'one', 1);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect(await mdOf(editor)).toBe('- [ ] task X\n- [x] task two');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- [ ] task one\n- [x] task two');
    });

    test('UR-23: タスクリストの li 全体（要素境界）をタイプ → チェックボックスは残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- [ ] task one\n- [x] task two');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        await page.keyboard.type('X');
        await waitDebounce(page);
        expect(await mdOf(editor)).toBe('- [ ] X\n- [x] task two');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- [ ] task one\n- [x] task two');
    });

    test('UR-24: li の途中 → 次 li 先頭の選択に paste → 選択の外は残り、undo で戻る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta\n- second\n- third');
        await page.waitForTimeout(200);
        await selectFromNeedleToLiStart(page, 0, 'beta', 1);
        await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.setData('text/plain', 'PP');
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            document.getElementById('editor')!.dispatchEvent(ev);
        });
        await waitDebounce(page);
        expect(await mdOf(editor)).toBe('- alpha PP\n- second\n- third');
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- alpha beta\n- second\n- third');
    });

    test('UR-25: トリプルクリックで li を選択してタイプ → 次の li は結合されずに残る', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await page.locator('#editor li').first().click({ clickCount: 3 });
        await page.keyboard.type('xyz');
        await waitDebounce(page);
        expect(await mdOf(editor)).toBe('- xyz\n- second');
    });
    // ---- 自分の保存のはね返り（self-write echo）で undo 履歴を消さない ----
    // host の「自分の書き込み中」フラグ（notesMdMainManager / sidePanelManager の _isApplyingEdit）は
    // boolean で、保存が重なると後の保存の変更イベントが externalUpdate として戻ってくる。
    // 今の内容と同じ update は外部変更ではないので、idle で届いても undo を消さない。

    test('UR-26: idle 中に今の内容と同じ update（自分の保存のはね返り）が届いても undo で戻せる', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        await page.keyboard.type('X');
        await page.waitForTimeout(2000); // EDITING_IDLE_TIMEOUT(1500ms) を超えて idle
        const echoed = await editor.getMarkdown();
        await page.evaluate((c) => { (window as any).__hostMessageHandler({ type: 'update', content: c }); }, echoed);
        await page.waitForTimeout(100);
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- alpha beta gamma\n- second');
    });

    test('UR-27: idle 中に内容の違う update（本当の外部変更）が届いたら反映し、undo 履歴は従来どおり消す', async ({ page }) => {
        await editor.setMarkdown('- alpha beta gamma\n- second');
        await page.waitForTimeout(200);
        await selectLiContents(page, 0);
        await page.keyboard.type('X');
        await page.waitForTimeout(2000);
        await page.evaluate(() => { (window as any).__hostMessageHandler({ type: 'update', content: '- EXTERNAL\n- second\n' }); });
        await page.waitForTimeout(100);
        expect(await mdOf(editor)).toBe('- EXTERNAL\n- second');
        await page.locator('#editor li').first().click();
        await editor.shortcut('z');
        await page.waitForTimeout(300);
        expect(await mdOf(editor)).toBe('- EXTERNAL\n- second');
    });
});
