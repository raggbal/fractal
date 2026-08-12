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

    // TC-TSL-03 rev(再オープン⑤(5)): Enter → edit(内容保持)→ Enter → 確定 + 同セル select
    test('TC-TSL-03 Enter edits (content kept), Enter commits staying on the cell', async ({ page }) => {
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
        expect(s.selectedText).toBe('b1X'); // 同セルに留まる(下移動しない — ユーザー裁定)
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

// ---- TASK-02: 範囲選択・範囲操作・縦断正規化(FR-TSL-02/03/04) ----

test.describe('Table range selection and operations (FR-TSL-02/03/04)', () => {
    // TC-TSL-07: Shift+Arrow で矩形範囲拡張 → Delete でクリア → undo 復帰
    test('TC-TSL-07 shift+arrow range, Delete clears, undo restores', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(100);
        let s = await snapSel(page);
        expect(s.rangeTexts.sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
        await page.keyboard.press('Delete');
        await page.waitForTimeout(300);
        let md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).not.toContain('a1');
        expect(md).toContain('c1'); // 範囲外は不変
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('a1');
        expect(md).toContain('b2');
    });

    // TC-TSL-08: マウスドラッグで範囲選択(real mouse)
    test('TC-TSL-08 mouse drag selects a range', async ({ page }) => {
        await setupTable(page);
        const boxes = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const c1 = table.rows[1].cells[0].getBoundingClientRect();
            const c2 = table.rows[2].cells[1].getBoundingClientRect();
            return {
                from: { x: c1.x + c1.width / 2, y: c1.y + c1.height / 2 },
                to: { x: c2.x + c2.width / 2, y: c2.y + c2.height / 2 },
            };
        });
        await page.mouse.move(boxes.from.x, boxes.from.y);
        await page.mouse.down();
        await page.mouse.move(boxes.to.x, boxes.to.y, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(150);
        const s = await snapSel(page);
        expect(s.rangeTexts.sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    });

    // TC-TSL-09 rev(再オープン② bug(1)): cmd+c は実キーで navigator.clipboard に書く
    // (select モードは selection collapsed のため copy イベントが発火しない — 合成
    //  ClipboardEvent の旧 TC は false-green だった)。paste も実キー相当の流れで検証
    test('TC-TSL-09 real cmd+c writes clipboard; cmd+v fills from top-left with overflow rules', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await setupTable(page, '| H1 | H2 |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |');
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Meta+c'); // 実キー
        await page.waitForTimeout(300);
        const clip = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const out: Record<string, string> = {};
            for (const item of items) {
                for (const t of item.types) {
                    out[t] = await (await item.getType(t)).text();
                }
            }
            return out;
        });
        expect(clip['text/plain']).toBe('a1\tb1\na2\tb2');
        expect(clip['text/html']).toContain('a1');
        expect(clip['text/html']).toContain('<table');
        // cmd+v: (1,1) 起点 → 右はみ出しは列を追加して全部貼る(再オープン④裁定)・下は行追加
        await clickBodyCell(page, 1, 1);
        await page.evaluate(() => {
            const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(e, 'clipboardData', {
                value: { getData: (t: string) => t === 'text/plain' ? 'X1\tY1\nX2\tY2' : '' },
            });
            document.querySelector('#editor')!.dispatchEvent(e);
        });
        await page.waitForTimeout(300);
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('| a2 | X1 | Y1 |'); // 列が 1 本増えて全部貼られる
        expect(md).toContain('X2');
        expect(md).toContain('Y2');
        // 全行の列数が一致(3 列)
        const lines = md.split('\n').filter((l: string) => l.startsWith('|') && !l.includes('---'));
        const counts = lines.map((l: string) => l.split('|').length - 2);
        expect(new Set(counts).size).toBe(1);
        expect(counts[0]).toBe(3);
    });

    // TC-TSL-11: 縦断選択の正規化 + 部分行コピーの md 書式(header + separator + 選択行)
    test('TC-TSL-11 cross-table selection normalizes to rows; partial copy keeps header', async ({ page }) => {
        await setupTable(page, 'before\n\n| H1 | H2 |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |');
        // 表の前の段落から 2 行目セルまで実マウスで選択
        const pts = await page.evaluate(() => {
            const p = document.querySelector('#editor p')!;
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const pb = p.getBoundingClientRect();
            const cb = table.rows[2].cells[0].getBoundingClientRect(); // a2 行
            return {
                from: { x: pb.x + 5, y: pb.y + pb.height / 2 },
                to: { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 },
            };
        });
        await page.mouse.move(pts.from.x, pts.from.y);
        await page.mouse.down();
        await page.mouse.move(pts.to.x, pts.to.y, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        // 正規化: 終端が a2 行の末尾(行単位)まで拡張されている
        const copied = await page.evaluate(() => {
            const store: Record<string, string> = {};
            const e = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
            Object.defineProperty(e, 'clipboardData', {
                value: { setData: (t: string, v: string) => { store[t] = v; }, getData: () => '' },
            });
            document.querySelector('#editor')!.dispatchEvent(e);
            return store;
        });
        const md = copied['text/markdown'] || copied['text/plain'] || '';
        // 行単位正規化により b2(a2 行の末尾セル)まで含まれる
        expect(md).toContain('b2');
        expect(md).not.toContain('a3'); // 選択外の行は含まれない
    });
});

// ---- 再オープン①(2026-08-12 手動テスト) ----

test.describe('Table select mode re-open 1 fixes', () => {
    // bug(2): edit 中の IME 変換確定 Enter でセルを出ない
    test('TC-TSL-15 IME-confirm Enter does not commit the cell', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('Enter'); // edit
        await page.waitForTimeout(100);
        // isComposing な Enter を合成(かな変換確定)
        await page.evaluate(() => {
            const sel = window.getSelection()!;
            const cell = (sel.anchorNode!.nodeType === 3
                ? sel.anchorNode!.parentElement : sel.anchorNode) as Element;
            const e = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
            });
            Object.defineProperty(e, 'isComposing', { value: true });
            cell.dispatchEvent(e);
        });
        await page.waitForTimeout(150);
        const s = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return { selectMode: table.classList.contains('tbl-select-mode') };
        });
        expect(s.selectMode).toBe(false); // edit のまま(セル確定していない)
    });

    // bug(3): 逆向き範囲選択でも paste 起点は範囲の左上
    test('TC-TSL-16 paste anchors at top-left of selection regardless of drag direction', async ({ page }) => {
        await setupTable(page, '| H1 | H2 |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |');
        await clickBodyCell(page, 1, 1); // b2 から逆向きに選択
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Shift+ArrowUp');
        await page.evaluate(() => {
            const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(e, 'clipboardData', {
                value: { getData: (t: string) => t === 'text/plain' ? 'X1\tY1\nX2\tY2' : '' },
            });
            document.querySelector('#editor')!.dispatchEvent(e);
        });
        await page.waitForTimeout(300);
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('| X1 | Y1 |'); // 左上(a1)起点で 2x2 充填
        expect(md).toContain('| X2 | Y2 |');
    });

    // bug(5): 先頭列の Shift+Tab = 上の行の末尾セルへ
    test('TC-TSL-17 Shift+Tab at first column wraps to previous row end', async ({ page }) => {
        await setupTable(page, '| H1 | H2 |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |');
        await clickBodyCell(page, 1, 0); // a2(2 行目先頭)
        await page.keyboard.press('Shift+Tab');
        await page.waitForTimeout(100);
        const sel = await page.evaluate(() =>
            document.querySelector('#editor table .tbl-cell-selected')?.textContent?.trim());
        expect(sel).toBe('b1'); // 上の行の末尾
    });
});

// ---- 再オープン⑤(2026-08-12) ----

test.describe('Table re-open 5 fixes', () => {
    // (1) Shift+click = anchor から click セルまでの矩形範囲
    test('TC-TSL-19 shift+click extends selection from active cell', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 0); // a1
        const box = await page.evaluate(() => {
            const t = document.querySelector('#editor table') as HTMLTableElement;
            const b = t.rows[2].cells[1].getBoundingClientRect(); // b2
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        });
        await page.keyboard.down('Shift');
        await page.mouse.click(box.x, box.y);
        await page.keyboard.up('Shift');
        await page.waitForTimeout(150);
        const s = await snapSel(page);
        expect(s.rangeTexts.sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    });

    // (4) edit 中の矢印はセルから出ない(端で止まる)
    test('TC-TSL-20 arrows in edit mode stay inside the cell', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 1); // b1
        await page.keyboard.press('Enter'); // edit(キャレット末尾)
        await page.keyboard.press('ArrowRight'); // 末尾 → 出ようとする
        await page.keyboard.press('ArrowDown');  // 同上
        await page.waitForTimeout(150);
        let cur = await page.evaluate(() => {
            const sel = window.getSelection()!;
            const el = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode as Element;
            return (el as Element)?.closest?.('td, th')?.textContent?.trim();
        });
        expect(cur).toBe('b1'); // セルから出ていない
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowLeft'); // 先頭 → 出ようとする
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(150);
        cur = await page.evaluate(() => {
            const sel = window.getSelection()!;
            const el = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode as Element;
            return (el as Element)?.closest?.('td, th')?.textContent?.trim();
        });
        expect(cur).toBe('b1');
    });

    // (5) edit Enter = 確定して同セル select(下移動しない)
    test('TC-TSL-21 Enter commits and stays on the same cell in select mode', async ({ page }) => {
        await setupTable(page);
        await clickBodyCell(page, 0, 1); // b1
        await page.keyboard.press('Enter');
        await page.keyboard.type('X');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        const s = await snapSel(page);
        expect(s.selectMode).toBe(true);
        expect(s.selectedText).toBe('b1X'); // 同セルに留まる
    });
});
