import { test, expect } from '@playwright/test';

// Sprint 20260812-032645: セル結合(FR-TMG, ADRL-0054)
// md = <!-- fractal-merged-table --> gate + `<`(左結合)/`^`(上結合)

const M = '<!-- fractal-merged-table -->';

async function setup(page, md: string) {
    await page.goto('http://localhost:3000/standalone-editor.html');
    await page.waitForSelector('#editor', { state: 'visible' });
    await page.evaluate(async (src) => {
        (window as any).__testApi.setMarkdown(src);
        await new Promise(r => setTimeout(r, 300));
    }, md);
}

const gridInfo = (page) => page.evaluate(() => {
    const table = document.querySelector('#editor table') as HTMLTableElement;
    if (!table) return null;
    return Array.from(table.rows).map(row =>
        Array.from(row.cells).map(c =>
            `${c.tagName}:${c.textContent?.trim()}:${c.colSpan}x${c.rowSpan}`));
});

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

test.describe('Table cell merge (FR-TMG)', () => {
    // TC-TMG-01: マーカー gate — gate ありで span 化・gate なしはリテラル(counterfactual)
    test('TC-TMG-01 marker gates the <,^ interpretation', async ({ page }) => {
        await setup(page, M + '\n| H1 | H2 | H3 |\n| --- | --- | --- |\n| wide | < | c1 |\n| tall | b2 | c2 |\n| ^ | b3 | c3 |');
        let g = await gridInfo(page);
        expect(g![1][0]).toBe('TD:wide:2x1');  // colspan 2
        expect(g![1].length).toBe(2);           // 被覆セルは出ない
        expect(g![2][0]).toBe('TD:tall:1x2');   // rowspan 2
        expect(g![3].length).toBe(2);           // ^ 位置はセルなし
        // counterfactual: gate なし = リテラル
        await setup(page, '| H1 | H2 | H3 |\n| --- | --- | --- |\n| wide | < | c1 |\n| tall | b2 | c2 |\n| ^ | b3 | c3 |');
        g = await gridInfo(page);
        expect(g![1][1]).toBe('TD:<:1x1');
        expect(g![3][0]).toBe('TD:^:1x1');
    });

    // TC-TMG-02: 2×2 結合の往復(ユーザー例の md 形・2 往復 byte 安定)
    test('TC-TMG-02 2x2 merge roundtrip is stable', async ({ page }) => {
        const md = M + '\n| カラム1 | カラム2 |\n| --- | --- |\n| 2×2結合セル | < |\n| ^ | ^ |';
        await setup(page, md);
        const g = await gridInfo(page);
        expect(g![1][0]).toBe('TD:2×2結合セル:2x2');
        const out1 = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(out1).toContain(M);
        expect(out1).toContain('| 2×2結合セル | < |');
        expect(out1).toContain('| ^ | ^ |');
        await setup(page, out1);
        const out2 = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(out2).toBe(out1);
    });

    // TC-TMG-03: UI Merge — 範囲選択 → merge → 左上内容のみ + undo 復帰
    test('TC-TMG-03 UI merge keeps top-left content; undo restores', async ({ page }) => {
        await setup(page, '| H1 | H2 |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |');
        await clickBodyCell(page, 0, 0);
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowDown');
        await page.evaluate(() => {
            (document.querySelector('.table-toolbar [data-action="merge-cells"]') as HTMLElement).click();
        });
        await page.waitForTimeout(300);
        let g = await gridInfo(page);
        expect(g![1][0]).toBe('TD:a1:2x2'); // 左上のみ・2x2
        expect(g![2].length).toBe(0);
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain(M);
        expect(md).not.toContain('b2'); // 内容は左上のみ(Excel)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        g = await gridInfo(page);
        expect(g![1][0]).toBe('TD:a1:1x1');
        expect(g![2][1]).toBe('TD:b2:1x1'); // undo で復元
    });

    // TC-TMG-04: Unmerge — span 解除 + 空セル復元 + マーカー消滅
    test('TC-TMG-04 unmerge restores cells and drops marker', async ({ page }) => {
        await setup(page, M + '\n| H1 | H2 |\n| --- | --- |\n| big | < |\n| ^ | ^ |');
        await clickBodyCell(page, 0, 0); // 結合セルを選択
        await page.evaluate(() => {
            (document.querySelector('.table-toolbar [data-action="unmerge-cells"]') as HTMLElement).click();
        });
        await page.waitForTimeout(300);
        const g = await gridInfo(page);
        expect(g![1][0]).toBe('TD:big:1x1');
        expect(g![1].length).toBe(2);
        expect(g![2].length).toBe(2);
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).not.toContain('fractal-merged-table');
    });

    // TC-TMG-05: th 含む選択の Merge = no-op
    test('TC-TMG-05 merge including header row is a no-op', async ({ page }) => {
        await setup(page, '| H1 | H2 |\n| --- | --- |\n| a1 | b1 |');
        // header セルから body まで範囲選択(header 行クリック → shift+down)
        const box = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const b = table.rows[0].cells[0].getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        });
        await page.mouse.click(box.x, box.y);
        await page.waitForTimeout(150);
        await page.keyboard.press('Shift+ArrowDown');
        await page.evaluate(() => {
            (document.querySelector('.table-toolbar [data-action="merge-cells"]') as HTMLElement).click();
        });
        await page.waitForTimeout(200);
        const g = await gridInfo(page);
        expect(g![0][0]).toBe('TH:H1:1x1'); // 変化なし
        expect(g![1][0]).toBe('TD:a1:1x1');
    });

    // TC-TMG-06: 不正形はリテラル(1 列目 `<`・先頭 body 行 `^`)
    test('TC-TMG-06 invalid tokens stay literal', async ({ page }) => {
        await setup(page, M + '\n| H1 | H2 |\n| --- | --- |\n| < | ^ |\n| a2 | b2 |');
        const g = await gridInfo(page);
        expect(g![1][0]).toBe('TD:<:1x1');  // 1 列目 < = リテラル
        expect(g![1][1]).toBe('TD:^:1x1');  // 先頭 body 行 ^ = リテラル
    });

    // TC-TMG-07: 行挿入/行削除/列挿入/列削除の 4 パターンが交差 span を事前 unmerge
    test('TC-TMG-07 row/col insert/delete unmerge intersecting spans (4 patterns)', async ({ page }) => {
        const merged = M + '\n| H1 | H2 | H3 |\n| --- | --- | --- |\n| big | < | c1 |\n| ^ | ^ | c2 |\n| a3 | b3 | c3 |';
        const actions = ['add-row-below', 'del-row', 'add-col-right', 'del-col'];
        for (const action of actions) {
            await setup(page, merged);
            await clickBodyCell(page, 0, 0); // 結合セル(交差位置)を active に
            await page.evaluate((a) => {
                (document.querySelector(`.table-toolbar [data-action="${a}"]`) as HTMLElement).click();
            }, action);
            await page.waitForTimeout(300);
            const spans = await page.evaluate(() =>
                document.querySelectorAll('#editor table [colspan], #editor table [rowspan]').length);
            expect(spans, `action=${action} should unmerge first`).toBe(0);
        }
    });

    // TC-TMG-08: 3 マーカー併存(headerless + col-widths + merged)の往復(2 順序)
    test('TC-TMG-08 three markers coexist across roundtrip', async ({ page }) => {
        const body = '|  |  |\n| --- | --- |\n| wide | < |\n| a2 | b2 |';
        for (const order of [
            '<!-- fractal-headerless-table -->\n<!-- fractal-col-widths: 100,120 -->\n' + M,
            M + '\n<!-- fractal-headerless-table -->\n<!-- fractal-col-widths: 100,120 -->',
        ]) {
            await setup(page, order + '\n' + body);
            const st = await page.evaluate(() => {
                const t = document.querySelector('#editor table') as HTMLTableElement;
                return {
                    th: t.querySelectorAll('th').length,
                    colW: t.getAttribute('data-col-widths'),
                    span: (t.querySelector('[colspan]') as HTMLTableCellElement)?.colSpan,
                };
            });
            expect(st.th).toBe(0);
            expect(st.colW).toBe('100,120');
            expect(st.span).toBe(2);
            const out = await page.evaluate(() => (window as any).__testApi.getMarkdown());
            expect(out).toContain('fractal-headerless-table');
            expect(out).toContain('fractal-col-widths: 100,120');
            expect(out).toContain('fractal-merged-table');
        }
    });

    // TC-TMG-09: span なし table の serialize byte 不変(NFR-03)
    test('TC-TMG-09 span-free table serialize is byte-identical', async ({ page }) => {
        const md = '| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |';
        await setup(page, md);
        const out = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(out.trim()).toBe(md);
        expect(out).not.toContain('fractal-merged-table');
    });

    // TC-TMG-10: 範囲選択が結合セルに交差 → 結合領域全体を含むまで矩形拡張(REQ-1)
    test('TC-TMG-10 range selection grows to include merged region', async ({ page }) => {
        await setup(page, M + '\n| H1 | H2 | H3 |\n| --- | --- | --- |\n| big | < | c1 |\n| ^ | ^ | c2 |');
        await clickBodyCell(page, 0, 1); // c1 セル(グリッド (0,2))
        await page.keyboard.press('Shift+ArrowLeft'); // big(2x2)に交差
        await page.waitForTimeout(100);
        const rangeCount = await page.evaluate(() =>
            document.querySelectorAll('#editor table .tbl-cell-range').length);
        // big(1) + c1 + c2 = 3 実セル(矩形は 2 行に拡張)
        expect(rangeCount).toBe(3);
    });

    // TC-TMG-11: 矢印移動で被覆位置に入る → anchor に着地(REQ-1)
    test('TC-TMG-11 arrow into covered position lands on anchor', async ({ page }) => {
        await setup(page, M + '\n| H1 | H2 |\n| --- | --- |\n| big | < |\n| a2 | b2 |');
        await clickBodyCell(page, 1, 1); // b2
        await page.keyboard.press('ArrowUp'); // 被覆位置(0,1)→ anchor(big)
        await page.waitForTimeout(100);
        const sel = await page.evaluate(() =>
            document.querySelector('#editor table .tbl-cell-selected')?.textContent?.trim());
        expect(sel).toBe('big');
    });
});
