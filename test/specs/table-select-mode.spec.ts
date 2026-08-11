import { test, expect } from '@playwright/test';

// Sprint 20260812-032645: table cell select/edit モード(FR-TSL)
// 裁定は session-log「裁定記録」(Excel 軸 + recommend)。

async function setupTable(page, md = '| H1 | H2 | H3 |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n| a3 | b3 | c3 |') {
    await page.goto('http://localhost:3000/standalone-editor.html');
    await page.waitForSelector('#editor', { state: 'visible' });
    await page.evaluate(async (src) => {
        (window as any).__testApi.setMarkdown(src);
        await new Promise(r => setTimeout(r, 300));
    }, md);
}

// body セル(r,c)を実クリック(r は body 行 0 起点)
async function clickBodyCell(page, r: number, c: number) {
    const box = await page.evaluate(([rr, cc]) => {
        const table = document.querySelector('#editor table') as HTMLTableElement;
        const cell = table.rows[rr + 1].cells[cc];
        const b = cell.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, [r, c]);
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(150);
}

const snapSel = (page) => page.evaluate(() => {
    const table = document.querySelector('#editor table') as HTMLTableElement;
    const sel = table?.querySelector('.tbl-cell-selected');
    return {
        selectMode: table?.classList.contains('tbl-select-mode'),
        selectedText: sel?.textContent?.trim() ?? null,
        rangeTexts: Array.from(table?.querySelectorAll('.tbl-cell-range') || [])
            .map(c => c.textContent?.trim()),
    };
});

test.describe('Table select/edit mode (FR-TSL-01)', () => {
    // TC-TSL-01: click → select モード。counterfactual: 入口を殺すと selectMode=false = RED
    test('TC-TSL-01 single click enters select mode', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0);
        const s = await snapSel(page);
        expect(s.selectMode).toBe(true);
        expect(s.selectedText).toBe('a1');
    });

    // TC-TSL-02: 矢印 4 方向移動 + 上端↑で表外へ
    test('TC-TSL-02 arrows move between cells; up at top edge leaves table', async ({ page }) => {
        await setupTable(page, 'before\n\n| H1 | H2 |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n\nafter');
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('ArrowRight');
        expect((await snapSel(page)).selectedText).toBe('b1');
        await page.keyboard.press('ArrowDown');
        expect((await snapSel(page)).selectedText).toBe('b2');
        await page.keyboard.press('ArrowLeft');
        expect((await snapSel(page)).selectedText).toBe('a2');
        await page.keyboard.press('ArrowUp');
        expect((await snapSel(page)).selectedText).toBe('a1');
        // 上端(header)を越えて ↑↑ = 表外(表の前の段落)へ
        await page.keyboard.press('ArrowUp'); // → header 行
        await page.keyboard.press('ArrowUp'); // → 表外
        const out = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const sel = window.getSelection()!;
            const el = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode as Element;
            return {
                selectMode: table.classList.contains('tbl-select-mode'),
                inTable: !!(el as Element)?.closest?.('table'),
            };
        });
        expect(out.selectMode).toBe(false);
        expect(out.inTable).toBe(false);
    });

    // TC-TSL-03: Enter → edit(内容保持)→ Enter → 確定 + 下セル select(Excel)
    test('TC-TSL-03 Enter edits (content kept), Enter commits and moves down', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 1);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        let s = await snapSel(page);
        expect(s.selectMode).toBe(false); // edit = キャレット可視
        await page.keyboard.type('X');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        s = await snapSel(page);
        expect(s.selectMode).toBe(true);
        expect(s.selectedText).toBe('b2'); // 下のセルへ
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('b1X');
    });

    // TC-TSL-04: タイプ開始 = 内容置換(Excel)。undo 1 回で復帰
    test('TC-TSL-04 typing replaces content; undo restores', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0);
        await page.keyboard.type('ZZ');
        await page.waitForTimeout(300);
        let text = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return table.rows[1].cells[0].textContent;
        });
        expect(text).toBe('ZZ'); // a1 が置換された
        await page.keyboard.press('Escape'); // select に戻してから
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        text = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return table.rows[1].cells[0].textContent;
        });
        expect(text).toBe('a1');
    });

    // TC-TSL-05: edit 中 Esc = 変更破棄(Excel)
    test('TC-TSL-05 Escape in edit discards changes', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('Enter'); // edit(内容保持)
        await page.keyboard.type('junk');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        const s = await snapSel(page);
        expect(s.selectMode).toBe(true);
        const text = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return table.rows[1].cells[0].textContent;
        });
        expect(text).toBe('a1'); // junk が破棄された
    });

    // TC-TSL-06: ダブルクリック = edit 直行
    test('TC-TSL-06 double click enters edit directly', async ({ page }) => {
        await setupTable(page);
        const box = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const b = table.rows[1].cells[0].getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        });
        await page.mouse.dblclick(box.x, box.y);
        await page.waitForTimeout(150);
        const s = await snapSel(page);
        expect(s.selectMode).toBe(false); // edit モード(キャレット可視)
        await page.keyboard.type('!');
        await page.waitForTimeout(200);
        const text = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return table.rows[1].cells[0].textContent;
        });
        expect(text).toContain('a1'); // 置換でなく編集(内容保持)
        expect(text).toContain('!');
    });

    // TC-TSL-10: select 中 Tab = 右 / 最終セル Tab = 行追加
    test('TC-TSL-10 Tab moves right; Tab on last cell appends a row', async ({ page }) => {
        await setupTable(page, '| H1 | H2 |\n| --- | --- |\n| a1 | b1 |');
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('Tab');
        expect((await snapSel(page)).selectedText).toBe('b1');
        await page.keyboard.press('Tab'); // 最終セル → 行追加
        await page.waitForTimeout(300);
        const rows = await page.evaluate(() =>
            document.querySelectorAll('#editor table tr').length);
        expect(rows).toBe(3); // header + 2 body
        expect((await snapSel(page)).selectedText).toBe(''); // 新行 1 列目(空)
    });

    // TC-TSL-12: 互換 — プログラム的キャレット配置では mode=null・既存 Enter 行追加が動く
    test('TC-TSL-12 programmatic caret keeps legacy behavior (Enter adds row)', async ({ page }) => {
        await setupTable(page, '| H1 | H2 |\n| --- | --- |\n| a1 | b1 |');
        await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const cell = table.rows[1].cells[0];
            const r = document.createRange();
            r.selectNodeContents(cell); r.collapse(false);
            const s = window.getSelection()!;
            s.removeAllRanges(); s.addRange(r);
        });
        await page.keyboard.press('Enter'); // mode=null → 既存分岐 = 行追加
        await page.waitForTimeout(300);
        const st = await page.evaluate(() => ({
            rows: document.querySelectorAll('#editor table tr').length,
            selectMode: (document.querySelector('#editor table') as HTMLTableElement)
                .classList.contains('tbl-select-mode'),
        }));
        expect(st.rows).toBe(3);
        expect(st.selectMode).toBe(false);
    });

    // TC-TSL-13: IME compositionstart で edit 遷移(内容置換)
    test('TC-TSL-13 IME composition starts edit with replacement', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0);
        const client = await page.context().newCDPSession(page);
        await client.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
        await page.waitForTimeout(100);
        await client.send('Input.insertText', { text: 'あ' });
        await page.waitForTimeout(300);
        const text = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return table.rows[1].cells[0].textContent;
        });
        expect(text).toBe('あ'); // a1 が置換された(edit 遷移済みの証跡)
    });

    // TC-TSL-14: edit 中 Shift+Enter = セル内改行(既存挙動不変)
    test('TC-TSL-14 Shift+Enter in edit inserts in-cell line break', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('Enter'); // edit
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('L2');
        await page.keyboard.press('Enter'); // 確定
        await page.waitForTimeout(300);
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('a1<br>L2'); // セル内改行の md 形(既存)
    });
});
