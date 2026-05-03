/**
 * Outliner Table Editor — Column width + horizontal scroll + resize
 * (Phase E, sync iteration 2).
 *
 * TC-906〜TC-909
 *
 * design: design/system.md §3.1 (ColumnDef.width) / §4.5-A (resize spec) / §4.6 (CSS)
 * task: TASK-E1, TASK-E2
 */
import { test, expect, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function setupTable(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutlinerTable(d);
    }, data);
    // small settle so renderTable + applyColumnWidths run
    await page.waitForTimeout(80);
}

const baseData = () => ({
    title: 'TC-90X',
    rootIds: ['n1', 'n2'],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [] },
        n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [] }
    },
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
        { id: 'col_text1', type: 'text', name: 'Status', order: 1 }
    ]
});

// ---------------------------------------------------------------------------
// TC-909: デフォルト列幅 (Outliner 320 / その他 200)
// ---------------------------------------------------------------------------
test('TC-909 default column widths: outliner 320 / text 200', async ({ page }) => {
    await setupTable(page, baseData());

    // resolve via API
    const widths = await page.evaluate(() => {
        const cols = (window as any).OutlinerTable._getColumns();
        return cols.map((c: any) => (window as any).OutlinerTable._resolveColumnWidth(c));
    });
    expect(widths[0]).toBe(320); // outliner default
    expect(widths[1]).toBe(200); // text default

    // verify constants
    const constants = await page.evaluate(() => ({
        outliner: (window as any).OutlinerTable._getDefaultOutlinerWidth(),
        other: (window as any).OutlinerTable._getDefaultOtherWidth(),
        min: (window as any).OutlinerTable._getMinColumnWidth()
    }));
    expect(constants.outliner).toBe(320);
    expect(constants.other).toBe(200);
    expect(constants.min).toBe(120);

    // verify actual computed grid-template-columns reflects defaults
    const gridTemplate = await page.evaluate(() => {
        const headers = document.querySelector('.otable-column-headers') as HTMLElement;
        return headers ? headers.style.gridTemplateColumns : '';
    });
    expect(gridTemplate).toBe('320px 200px');

    // total width = 320 + 200 = 520
    const headerWidth = await page.evaluate(() => {
        const headers = document.querySelector('.otable-column-headers') as HTMLElement;
        return headers ? headers.style.width : '';
    });
    expect(headerWidth).toBe('520px');

    // each row also gets the same template + width
    const rowStyles = await page.$$eval('.otable-row', (els) =>
        els.map((e) => ({
            template: (e as HTMLElement).style.gridTemplateColumns,
            width: (e as HTMLElement).style.width
        }))
    );
    expect(rowStyles.length).toBeGreaterThan(0);
    for (const s of rowStyles) {
        expect(s.template).toBe('320px 200px');
        expect(s.width).toBe('520px');
    }
});

// ---------------------------------------------------------------------------
// TC-906: 5 列でテーブル全体幅 = 列幅合計 + 横スクロール
// ---------------------------------------------------------------------------
test('TC-906 5 columns produce horizontal scroll when total width > viewport', async ({ page }) => {
    // viewport を 800px に絞る (5 列の 1120px より狭い)
    await page.setViewportSize({ width: 800, height: 600 });

    // 5 列構成: outliner(320) + text x 4 (200 each) = 1120px
    const data = {
        title: 'TC-906',
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'row1', tags: [] } },
        columns: [
            { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
            { id: 'col_a', type: 'text', name: 'A', order: 1 },
            { id: 'col_b', type: 'text', name: 'B', order: 2 },
            { id: 'col_c', type: 'text', name: 'C', order: 3 },
            { id: 'col_d', type: 'text', name: 'D', order: 4 }
        ]
    };
    await setupTable(page, data);

    // テーブル全体幅 (.otable-rows / .otable-column-headers の inline style)
    const totalWidth = await page.evaluate(() => {
        const rows = document.querySelector('.otable-rows') as HTMLElement;
        return rows ? parseInt(rows.style.width, 10) : 0;
    });
    expect(totalWidth).toBeGreaterThanOrEqual(1120);
    expect(totalWidth).toBe(320 + 200 * 4);

    // header total width も同じ
    const headerWidth = await page.evaluate(() => {
        const h = document.querySelector('.otable-column-headers') as HTMLElement;
        return h ? parseInt(h.style.width, 10) : 0;
    });
    expect(headerWidth).toBe(1120);

    // .otable-body の scrollWidth > clientWidth で横スクロール出る
    const scroll = await page.evaluate(() => {
        const body = document.querySelector('.otable-body') as HTMLElement;
        if (!body) { return null; }
        return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth };
    });
    expect(scroll).not.toBeNull();
    expect(scroll!.scrollWidth).toBeGreaterThan(scroll!.clientWidth);
    // 横スクロール量 = 全体幅 - viewport ぐらい (誤差許容)
    expect(scroll!.scrollWidth - scroll!.clientWidth).toBeGreaterThan(200);
});

// ---------------------------------------------------------------------------
// TC-907: 列幅 D&D resize (mousedown → mousemove → mouseup) + min-width clamp
// ---------------------------------------------------------------------------
test('TC-907 drag resize updates col.width and clamps to MIN_COLUMN_WIDTH', async ({ page }) => {
    await setupTable(page, baseData());

    // 1) text 列 (col_text1) を +50px resize
    const beforeWidth = await page.evaluate(() => {
        const cols = (window as any).OutlinerTable._getColumns();
        return (window as any).OutlinerTable._resolveColumnWidth(
            cols.find((c: any) => c.id === 'col_text1')
        );
    });
    expect(beforeWidth).toBe(200);

    // simulate startColumnResize via API + manual mousemove dispatch on document
    await page.evaluate(() => {
        const col = (window as any).OutlinerTable._getColumns().find((c: any) => c.id === 'col_text1');
        // startX = 100 (任意)
        (window as any).OutlinerTable._startColumnResize(col, 100);
    });
    // mousemove +50px
    await page.evaluate(() => {
        const ev = new MouseEvent('mousemove', { clientX: 150, bubbles: true });
        document.dispatchEvent(ev);
    });
    // verify intermediate state
    const midWidth = await page.evaluate(() => {
        const cols = (window as any).OutlinerTable._getColumns();
        return cols.find((c: any) => c.id === 'col_text1').width;
    });
    expect(midWidth).toBe(250); // 200 + 50
    // body has resizing class
    const hasClass = await page.evaluate(() =>
        document.body.classList.contains('is-otable-resizing')
    );
    expect(hasClass).toBe(true);

    // grid-template-columns 反映
    const template = await page.evaluate(() => {
        const h = document.querySelector('.otable-column-headers') as HTMLElement;
        return h ? h.style.gridTemplateColumns : '';
    });
    expect(template).toBe('320px 250px');

    // mouseup で commit
    await page.evaluate(() => {
        const ev = new MouseEvent('mouseup', { bubbles: true });
        document.dispatchEvent(ev);
    });
    // body class removed
    const stillResizing = await page.evaluate(() =>
        document.body.classList.contains('is-otable-resizing')
    );
    expect(stillResizing).toBe(false);

    // 2) min-width clamp test: extreme negative move (-500) should clamp to 120
    await page.evaluate(() => {
        const col = (window as any).OutlinerTable._getColumns().find((c: any) => c.id === 'col_text1');
        // startWidth は今 250 — そこから -500 移動 → 250 - 500 = -250 だが MIN_COLUMN_WIDTH = 120 で clamp
        (window as any).OutlinerTable._startColumnResize(col, 500);
    });
    await page.evaluate(() => {
        const ev = new MouseEvent('mousemove', { clientX: 0, bubbles: true });
        document.dispatchEvent(ev);
    });
    const clampedWidth = await page.evaluate(() => {
        const cols = (window as any).OutlinerTable._getColumns();
        return cols.find((c: any) => c.id === 'col_text1').width;
    });
    expect(clampedWidth).toBe(120); // clamped to MIN_COLUMN_WIDTH

    await page.evaluate(() => {
        const ev = new MouseEvent('mouseup', { bubbles: true });
        document.dispatchEvent(ev);
    });
});

// ---------------------------------------------------------------------------
// TC-908: 列幅永続化 round-trip — resize → syncData payload → reload で復元
// ---------------------------------------------------------------------------
test('TC-908 width persists round-trip via syncData payload', async ({ page }) => {
    await setupTable(page, baseData());

    // resize col_text1 to 200 + 80 = 280
    await page.evaluate(() => {
        const col = (window as any).OutlinerTable._getColumns().find((c: any) => c.id === 'col_text1');
        (window as any).OutlinerTable._startColumnResize(col, 100);
        const move = new MouseEvent('mousemove', { clientX: 180, bubbles: true });
        document.dispatchEvent(move);
        const up = new MouseEvent('mouseup', { bubbles: true });
        document.dispatchEvent(up);
    });
    // sync 即時反映
    await page.evaluate(() => (window as any).__testApi.flushSync());
    await page.waitForTimeout(40);

    // payload に width が乗っているか
    const payload = await page.evaluate(() => (window as any).__testApi.getSerializedData());
    expect(payload).toBeTruthy();
    expect(Array.isArray(payload.columns)).toBe(true);
    const persistedTextCol = payload.columns.find((c: any) => c.id === 'col_text1');
    expect(persistedTextCol).toBeTruthy();
    expect(persistedTextCol.width).toBe(280);

    // reload: applyExternalUpdate(payload) で再構築 → width が DOM に反映される
    await page.evaluate((data) => {
        (window as any).__testApi.applyExternalUpdate(data);
    }, payload);
    await page.waitForTimeout(80);

    const restoredWidth = await page.evaluate(() => {
        const cols = (window as any).OutlinerTable._getColumns();
        return cols.find((c: any) => c.id === 'col_text1').width;
    });
    expect(restoredWidth).toBe(280);

    const restoredTemplate = await page.evaluate(() => {
        const h = document.querySelector('.otable-column-headers') as HTMLElement;
        return h ? h.style.gridTemplateColumns : '';
    });
    expect(restoredTemplate).toBe('320px 280px');
});
