import { test, expect } from '@playwright/test';

// Sprint 20260812-032645: 行フィルタ(FR-TFL-01)。表示のみ・md 不変・非永続

async function setup(page, md = '| H1 | H2 |\n| --- | --- |\n| Apple | red |\n| Banana | yellow |\n| Cherry | red |') {
    await page.goto('http://localhost:3000/standalone-editor.html');
    await page.waitForSelector('#editor', { state: 'visible' });
    await page.evaluate(async (src) => {
        (window as any).__testApi.setMarkdown(src);
        await new Promise(r => setTimeout(r, 300));
        // toolbar を出す(セルクリック)
        const table = document.querySelector('#editor table') as HTMLTableElement;
        (table.rows[1].cells[0] as HTMLElement).click();
    }, md);
    await page.waitForTimeout(200);
}

const visibleRows = (page) => page.evaluate(() => {
    const table = document.querySelector('#editor table') as HTMLTableElement;
    return Array.from(table.rows)
        .filter(r => !r.classList.contains('tbl-row-filtered'))
        .map(r => r.cells[0].textContent?.trim());
});

async function typeFilter(page, text: string) {
    await page.evaluate((t) => {
        const input = document.querySelector('.table-toolbar .table-filter-input') as HTMLInputElement;
        input.value = t;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.waitForTimeout(150);
}

test.describe('Table row filter (FR-TFL-01)', () => {
    // TC-TFL-01: 絞り込み(case-insensitive・ヘッダー常時)+ クリアで全行復帰
    test('TC-TFL-01 filter narrows rows; clear restores', async ({ page }) => {
        await setup(page);
        await typeFilter(page, 'RED'); // case-insensitive
        expect(await visibleRows(page)).toEqual(['H1', 'Apple', 'Cherry']);
        await typeFilter(page, '');
        expect(await visibleRows(page)).toEqual(['H1', 'Apple', 'Banana', 'Cherry']);
    });

    // TC-TFL-02: フィルタ中も md 不変(全行)+ serialize byte 不変
    test('TC-TFL-02 markdown is unchanged while filtered', async ({ page }) => {
        const md = '| H1 | H2 |\n| --- | --- |\n| Apple | red |\n| Banana | yellow |\n| Cherry | red |';
        await setup(page, md);
        await typeFilter(page, 'red');
        const out = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(out.trim()).toBe(md); // Banana 行も md には残る・byte 不変
    });

    // TC-TFL-03: フィルタ中の行追加操作 → フィルタ自動解除
    test('TC-TFL-03 row-add operation clears the filter', async ({ page }) => {
        await setup(page);
        await typeFilter(page, 'red');
        expect((await visibleRows(page)).length).toBe(3);
        await page.evaluate(() => {
            (document.querySelector('.table-toolbar [data-action="add-row-below"]') as HTMLElement).click();
        });
        await page.waitForTimeout(300);
        const rows = await visibleRows(page);
        expect(rows.length).toBe(5); // 全 4 行 + 新行(フィルタ解除済み)
        const input = await page.evaluate(() =>
            (document.querySelector('.table-toolbar .table-filter-input') as HTMLInputElement).value);
        expect(input).toBe('');
    });

    // TC-TFL-04: PDF 回収 DOM はフィルタ無視(全行)
    test('TC-TFL-04 PDF collection ignores the filter', async ({ page }) => {
        await setup(page);
        await typeFilter(page, 'red');
        const pdfHtml = await page.evaluate(() => {
            const editorEl = document.querySelector('#editor') as HTMLElement;
            return (window as any).PdfExport.buildPdfExportHtml(editorEl).html;
        });
        expect(pdfHtml).toContain('Banana');               // フィルタ非表示行も出る
        expect(pdfHtml).not.toContain('tbl-row-filtered'); // class 自体が剥がれている
    });

    // TC-TFL-05: rowspan グループはメンバーヒットで全体表示
    test('TC-TFL-05 rowspan group shows entirely when any member matches', async ({ page }) => {
        await setup(page, '<!-- fractal-merged-table -->\n| H1 | H2 |\n| --- | --- |\n| grp | match-me |\n| ^ | other |\n| solo | nothing |');
        await typeFilter(page, 'match-me');
        const vis = await visibleRows(page);
        expect(vis).toEqual(['H1', 'grp', 'other']); // グループ 2 行とも表示・solo は消える
    });

    // TC-TFL-06: i18n 3 キーが interface + 7 locale 全登録
    test('TC-TFL-06 i18n keys registered in all locales', async () => {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', '..', 'src', 'i18n');
        const targets = ['messages.ts', 'locales/en.ts', 'locales/ja.ts', 'locales/es.ts',
            'locales/fr.ts', 'locales/ko.ts', 'locales/zh-cn.ts', 'locales/zh-tw.ts'];
        for (const rel of targets) {
            const content = fs.readFileSync(path.join(dir, rel), 'utf8');
            for (const key of ['tableMergeCells', 'tableUnmergeCells', 'tableFilterRows']) {
                expect(content, `${rel} should contain ${key}`).toContain(key);
            }
        }
    });
});

// 再オープン① bug(7): filter input クリックで toolbar が消えず入力できる
test('TC-TFL-07 clicking the filter input keeps the toolbar and accepts input', async ({ page }) => {
    await page.goto('http://localhost:3000/standalone-editor.html');
    await page.waitForSelector('#editor', { state: 'visible' });
    await page.evaluate(async () => {
        (window as any).__testApi.setMarkdown('| H1 | H2 |\n| --- | --- |\n| Apple | red |\n| Banana | yellow |');
        await new Promise(r => setTimeout(r, 300));
        const table = document.querySelector('#editor table') as HTMLTableElement;
        (table.rows[1].cells[0] as HTMLElement).click();
    });
    await page.waitForTimeout(200);
    // input を実クリック → focusout の 200ms delay 後も toolbar が残る
    const box = await page.evaluate(() => {
        const el = document.querySelector('.table-toolbar .table-filter-input') as HTMLElement;
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(400); // focusout delay 200ms を跨ぐ
    const visible = await page.evaluate(() =>
        document.querySelector('.table-toolbar')?.classList.contains('visible'));
    expect(visible).toBe(true);
    // 実タイプでフィルタが効く
    await page.keyboard.type('red');
    await page.waitForTimeout(200);
    const rows = await page.evaluate(() => {
        const t = document.querySelector('#editor table') as HTMLTableElement;
        return Array.from(t.rows).filter(r => !r.classList.contains('tbl-row-filtered')).length;
    });
    expect(rows).toBe(2); // header + Apple
});
