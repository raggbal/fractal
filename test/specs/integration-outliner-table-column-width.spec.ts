/**
 * Outliner Table Editor — Column width + horizontal scroll
 * (Phase E, sync iteration 2).
 *
 * TC-906, TC-909
 *
 * design: design/system.md §3.1 (ColumnDef.width) / §4.6 (CSS)
 * task: TASK-E1
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
