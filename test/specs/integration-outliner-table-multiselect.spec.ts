/**
 * Outliner Table Editor — Multiselect column (TASK-C1〜C4)
 *
 * design: design/system.md §4.3 (multiselect chip + dropdown UI), §6.4 (8 color palette),
 *         §3.1 (OptionDef = {id, label, color})
 * testcases:
 *   - TC-801 chip rendering with color class (TASK-C1)
 *   - TC-801-B orphan option ids skipped (data preserved) (TASK-C1)
 *   - TC-802 chip remove via ✕ click (TASK-C1)
 *
 * Subsequent TASK-C2〜C4 commits append TC-803〜806 to this file.
 */
import { test, expect, Page } from '@playwright/test';

// Shared module-private state across tests in this file → run serially.
test.describe.configure({ mode: 'serial' });

async function setupTable(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutlinerTable(d);
    }, data);
    await page.waitForTimeout(60);
}

const baseData = () => ({
    rootIds: ['n1', 'n2'],
    nodes: {
        n1: {
            id: 'n1', parentId: null, children: [], text: 'first', tags: [],
            columnValues: { col_tags: ['opt_1', 'opt_2'] }
        },
        n2: {
            id: 'n2', parentId: null, children: [], text: 'second', tags: [],
            columnValues: { col_tags: ['opt_2'] }
        }
    },
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
        {
            id: 'col_tags', type: 'multiselect', name: 'Tags', order: 1,
            options: [
                { id: 'opt_1', label: 'urgent', color: 'red' },
                { id: 'opt_2', label: 'review', color: 'blue' }
            ]
        }
    ]
});

// ---------------------------------------------------------------------------
// TC-801: chip rendering with color class
// ---------------------------------------------------------------------------
test('TC-801 — multiselect cell renders one chip per option id with color class', async ({ page }) => {
    await setupTable(page, baseData());

    const chipsN1 = await page.$$eval(
        '.otable-row[data-node-id="n1"] .otable-cell-multiselect > .otable-chip',
        (els) => els.map((e) => ({
            text: (e.querySelector('.otable-chip-label') as HTMLElement)?.textContent,
            classes: (e as HTMLElement).className.split(/\s+/),
            optId: (e as HTMLElement).dataset.optId
        }))
    );
    expect(chipsN1.length).toBe(2);
    expect(chipsN1[0].text).toBe('urgent');
    expect(chipsN1[0].classes).toContain('otable-chip-color-red');
    expect(chipsN1[0].optId).toBe('opt_1');
    expect(chipsN1[1].text).toBe('review');
    expect(chipsN1[1].classes).toContain('otable-chip-color-blue');
    expect(chipsN1[1].optId).toBe('opt_2');

    const chipsN2 = await page.$$eval(
        '.otable-row[data-node-id="n2"] .otable-cell-multiselect > .otable-chip',
        (els) => els.length
    );
    expect(chipsN2).toBe(1);
});

test('TC-801-B orphan option ids are skipped (data preserved)', async ({ page }) => {
    const data = baseData();
    data.nodes.n1.columnValues.col_tags = ['opt_1', 'opt_orphan'];
    await setupTable(page, data);

    const chips = await page.$$eval(
        '.otable-row[data-node-id="n1"] .otable-cell-multiselect > .otable-chip',
        (els) => els.map((e) => (e as HTMLElement).dataset.optId)
    );
    expect(chips).toEqual(['opt_1']); // orphan skipped from render

    // model preserves orphan
    const modelValues = await page.evaluate(() => {
        const T = (window as any).OutlinerTable;
        return T._getModel().getNode('n1').columnValues.col_tags;
    });
    expect(modelValues).toEqual(['opt_1', 'opt_orphan']);
});

// ---------------------------------------------------------------------------
// TC-802: chip remove via ✕ click
// ---------------------------------------------------------------------------
test('TC-802 — clicking the ✕ on a chip removes that option id from the cell value', async ({ page }) => {
    await setupTable(page, baseData());

    // Initial state: n1 has [opt_1, opt_2]
    const before = await page.evaluate(() => {
        const T = (window as any).OutlinerTable;
        return T._getModel().getNode('n1').columnValues.col_tags;
    });
    expect(before).toEqual(['opt_1', 'opt_2']);

    // Click ✕ on first chip
    await page.locator(
        '.otable-row[data-node-id="n1"] .otable-chip[data-opt-id="opt_1"] .otable-chip-remove'
    ).click();
    await page.waitForTimeout(40);

    const after = await page.evaluate(() => {
        const T = (window as any).OutlinerTable;
        return T._getModel().getNode('n1').columnValues.col_tags;
    });
    expect(after).toEqual(['opt_2']);

    // DOM reflects: only one chip
    const chipCount = await page.$$eval(
        '.otable-row[data-node-id="n1"] .otable-cell-multiselect > .otable-chip',
        (els) => els.length
    );
    expect(chipCount).toBe(1);
});
