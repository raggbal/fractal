/**
 * Outliner Table Editor — Column add / remove / reorder (TASK-B5).
 *
 * TC-901〜TC-905
 *
 * design: design/system.md §6.2 (column management)
 * testcases: TC-901, TC-902, TC-903, TC-904, TC-905
 */
import { test, expect, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function setupTable(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutlinerTable(d);
    }, data);
    await page.waitForTimeout(80);
}

const baseData = () => ({
    title: 'TC-9',
    rootIds: ['n1', 'n2'],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [], columnValues: { col_text1: 'val1' } },
        n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [], columnValues: { col_text1: 'val2' } }
    },
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
        { id: 'col_text1', type: 'text', name: 'Status', order: 1 }
    ]
});

// ---------------------------------------------------------------------------
// TC-901: 列追加 (text)
// ---------------------------------------------------------------------------
test('TC-901 add column (text) appends to columns and renders', async ({ page }) => {
    await setupTable(page, baseData());
    // call addColumn API directly (modal UI is exercised in a separate sub-test below)
    const result = await page.evaluate(() => {
        const col = (window as any).OutlinerTable.addColumn('text', 'Owner');
        return col;
    });
    expect(result).toBeTruthy();
    expect(result.type).toBe('text');
    expect(result.name).toBe('Owner');
    // verify columns count
    const cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(3);
    // verify header rendered
    const headers = await page.locator('.otable-column-header').count();
    expect(headers).toBe(3);
    // verify each row has 3 cells
    const cells = await page.locator('.otable-row[data-node-id="n1"] .otable-cell').count();
    expect(cells).toBe(3);
});

test('TC-901 add column via modal UI: type text, name "Status2"', async ({ page }) => {
    await setupTable(page, baseData());
    // click + button
    await page.locator('.otable-add-column-btn').click();
    await page.waitForTimeout(40);
    await expect(page.locator('.otable-add-column-modal')).toBeVisible();
    await page.locator('.otable-modal-input').fill('Status2');
    // type select default = text
    await page.locator('.otable-modal-ok').click();
    await page.waitForTimeout(80);
    const cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(3);
    expect(cols[2].type).toBe('text');
    expect(cols[2].name).toBe('Status2');
    // modal closed
    await expect(page.locator('.otable-add-column-modal')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// TC-902: 列追加 (multiselect) - options: [] で初期化
// ---------------------------------------------------------------------------
test('TC-902 add column (multiselect) initializes options:[]', async ({ page }) => {
    await setupTable(page, baseData());
    const result = await page.evaluate(() => {
        const col = (window as any).OutlinerTable.addColumn('multiselect', 'Tags');
        return col;
    });
    expect(result.type).toBe('multiselect');
    expect(Array.isArray(result.options)).toBe(true);
    expect(result.options.length).toBe(0);
});

// ---------------------------------------------------------------------------
// TC-903: 列削除 → columns から remove + columnValues cleanup
// ---------------------------------------------------------------------------
test('TC-903 remove column also cleans up columnValues for all nodes', async ({ page }) => {
    await setupTable(page, baseData());
    const ok = await page.evaluate(() => (window as any).OutlinerTable.removeColumn('col_text1'));
    expect(ok).toBe(true);
    const cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(1);
    expect(cols[0].id).toBe('col_outliner');
    // columnValues should not contain col_text1 anymore
    const v1 = await page.evaluate(() => {
        const m: any = (window as any).OutlinerTable._getModel();
        const n = m.getNode('n1');
        return n.columnValues && Object.prototype.hasOwnProperty.call(n.columnValues, 'col_text1');
    });
    expect(v1).toBe(false);
    // header has only 1
    const headers = await page.locator('.otable-column-header').count();
    expect(headers).toBe(1);
});

// ---------------------------------------------------------------------------
// TC-904: 列並べ替え → order updated
// ---------------------------------------------------------------------------
test('TC-904 reorderColumns updates order numbers', async ({ page }) => {
    // start with 3 columns
    const data = {
        title: 'TC-904',
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'x', tags: [] } },
        columns: [
            { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
            { id: 'col_a', type: 'text', name: 'A', order: 1 },
            { id: 'col_b', type: 'text', name: 'B', order: 2 }
        ]
    };
    await setupTable(page, data);
    // move col_b (idx 2) to position 0 — i.e., col_b becomes leftmost
    await page.evaluate(() => (window as any).OutlinerTable.reorderColumns(2, 0));
    await page.waitForTimeout(40);

    const cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    // sorted by order so the array is the new order
    expect(cols[0].id).toBe('col_b');
    expect(cols[0].order).toBe(0);
    expect(cols[1].id).toBe('col_outliner');
    expect(cols[1].order).toBe(1);
    expect(cols[2].id).toBe('col_a');
    expect(cols[2].order).toBe(2);

    // headers reflect the new order
    const headerIds = await page.$$eval('.otable-column-header',
        (els) => els.map((e) => (e as HTMLElement).dataset.colId));
    expect(headerIds).toEqual(['col_b', 'col_outliner', 'col_a']);
});

// ---------------------------------------------------------------------------
// TC-905: Outliner 列削除不可 (context menu disabled)
// ---------------------------------------------------------------------------
test('TC-905 Outliner column delete is disabled in context menu', async ({ page }) => {
    await setupTable(page, baseData());
    // open context menu on outliner column
    await page.evaluate(() => {
        const col = (window as any).OutlinerTable._getColumns()[0]; // outliner
        (window as any).OutlinerTable._openColumnHeaderMenu(col, 100, 100);
    });
    await page.waitForTimeout(40);

    const item = page.locator('.otable-context-menu-item').first();
    await expect(item).toBeVisible();
    const isDisabled = await item.evaluate((el) => el.classList.contains('disabled'));
    expect(isDisabled).toBe(true);

    // also: removeColumn refuses outliner
    const result = await page.evaluate(() => (window as any).OutlinerTable.removeColumn('col_outliner'));
    expect(result).toBe(false);
});

test('TC-905 non-outliner column has enabled delete in context menu', async ({ page }) => {
    await setupTable(page, baseData());
    await page.evaluate(() => {
        const col = (window as any).OutlinerTable._getColumns()[1]; // text col
        (window as any).OutlinerTable._openColumnHeaderMenu(col, 100, 100);
    });
    await page.waitForTimeout(40);
    const item = page.locator('.otable-context-menu-item').first();
    const isDisabled = await item.evaluate((el) => el.classList.contains('disabled'));
    expect(isDisabled).toBe(false);
});
