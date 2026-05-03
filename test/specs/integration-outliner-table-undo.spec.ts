/**
 * Outliner Table Editor — undo/redo extensions (TASK-B8)
 *
 * design: design/system.md §4.3.2
 * testcases:
 *   - TC-1201: cell text edit -> cmd+z reverts, cmd+shift+z re-applies
 *   - TC-1202: column add -> cmd+z removes new column
 *   - TC-1203: column remove -> cmd+z restores column + columnValues
 *   - TC-1204: multiselect option add -> cmd+z removes option (placeholder
 *              skipped until TASK-C2 wires the dropdown UI)
 */
import { test, expect, Page } from '@playwright/test';

async function setupTable(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutlinerTable(d);
    }, data);
    await page.waitForTimeout(50);
}

// ---------------------------------------------------------------------------
// TC-1201: cell text edit undo/redo
// ---------------------------------------------------------------------------
test('TC-1201 — cell text edit reverts with cmd+z and re-applies with cmd+shift+z', async ({ page }) => {
    await setupTable(page, {
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'original', tags: [] } }
    });
    await page.evaluate(() => {
        const T = (window as any).OutlinerTable;
        T._saveSnapshot();
        const m = T._getModel();
        m.updateText('n1', 'edited');
        T._saveSnapshot();
    });
    let txt = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    expect(txt).toBe('edited');

    await page.evaluate(() => (window as any).OutlinerTable.undo());
    txt = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    expect(txt).toBe('original');

    await page.evaluate(() => (window as any).OutlinerTable.redo());
    txt = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    expect(txt).toBe('edited');
});

// ---------------------------------------------------------------------------
// TC-1202: column add undo/redo
// ---------------------------------------------------------------------------
test('TC-1202 — column add reverts with cmd+z and is restored with cmd+shift+z', async ({ page }) => {
    await setupTable(page, {
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a', tags: [] } },
        columns: [
            { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }
        ]
    });
    // Save baseline first
    await page.evaluate(() => (window as any).OutlinerTable._saveSnapshot());
    await page.evaluate(() => (window as any).OutlinerTable.addColumn('text', 'Status'));
    let cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(2);
    expect(cols.find((c: any) => c.name === 'Status')).toBeTruthy();

    await page.evaluate(() => (window as any).OutlinerTable.undo());
    cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(1);
    expect(cols.find((c: any) => c.name === 'Status')).toBeFalsy();

    await page.evaluate(() => (window as any).OutlinerTable.redo());
    cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(2);
    expect(cols.find((c: any) => c.name === 'Status')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// TC-1203: column remove undo restores column + columnValues
// ---------------------------------------------------------------------------
test('TC-1203 — column remove reverts and restores columnValues with cmd+z', async ({ page }) => {
    await setupTable(page, {
        rootIds: ['n1', 'n2'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [],
                columnValues: { col_status: 'in progress' } },
            n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [],
                columnValues: { col_status: 'done' } }
        },
        columns: [
            { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
            { id: 'col_status', type: 'text', name: 'Status', order: 1 }
        ]
    });
    await page.evaluate(() => (window as any).OutlinerTable._saveSnapshot());
    await page.evaluate(() => (window as any).OutlinerTable.removeColumn('col_status'));
    let cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(1);
    let val = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').columnValues);
    // after removeColumn, columnValues for col_status is cleaned up
    expect(val == null || val.col_status == null).toBeTruthy();

    await page.evaluate(() => (window as any).OutlinerTable.undo());
    cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    expect(cols.length).toBe(2);
    val = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').columnValues);
    expect(val).toBeTruthy();
    expect(val.col_status).toBe('in progress');
    val = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n2').columnValues);
    expect(val.col_status).toBe('done');
});

// ---------------------------------------------------------------------------
// TC-1204: multiselect option add undo (placeholder, skipped until TASK-C2)
// ---------------------------------------------------------------------------
test.skip('TC-1204 — multiselect option add reverts with cmd+z (TASK-C2 deferred)', async () => {
    // Once TASK-C2 wires the dropdown's "+ Create option" path through
    // saveSnapshot + col.options.push, this test should:
    //   1) call OutlinerTable.<some-multiselect-add-option-api>('col_tags', 'Important')
    //   2) assert col.options length += 1
    //   3) call undo()
    //   4) assert col.options length reverted
});
