/**
 * Outliner Table Editor — Multiselect column (TASK-C1〜C4)
 *
 * design: design/system.md §4.3 (multiselect chip + dropdown UI), §6.4 (8 color palette),
 *         §3.1 (OptionDef = {id, label, color})
 * testcases:
 *   - TC-801 chip rendering with color class (TASK-C1)
 *   - TC-801-B orphan option ids skipped (data preserved) (TASK-C1)
 *   - TC-802 chip remove via ✕ click (TASK-C1)
 *   - TC-803 dropdown open + input focus (TASK-C2)
 *   - TC-804 dropdown filter + multi-toggle (☑/☐) (TASK-C2)
 *   - TC-805 inline option create with palette[N % 8] color (TASK-C2)
 *
 * TASK-C3 / TASK-C4 commits append TC-806 / TC-1003 reinforcement.
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
// ---------------------------------------------------------------------------
// TC-803: dropdown open + input focus
// ---------------------------------------------------------------------------
test('TC-803 — clicking the + opener opens the dropdown with input focused and existing options listed', async ({ page }) => {
    await setupTable(page, baseData());

    // Click + opener on n1 multiselect cell
    await page.locator(
        '.otable-row[data-node-id="n1"] .otable-cell-multiselect .otable-chip-add'
    ).click();
    await page.waitForTimeout(40);

    // Dropdown rendered
    const dropdown = page.locator('.otable-multiselect-dropdown');
    await expect(dropdown).toHaveCount(1);

    // Input is focused
    const inputFocused = await page.evaluate(() => {
        const inp = document.querySelector('.otable-multiselect-dropdown-input') as HTMLElement;
        return inp ? document.activeElement === inp : false;
    });
    expect(inputFocused).toBe(true);

    // Both existing options are listed
    const optionLabels = await page.$$eval(
        '.otable-multiselect-dropdown-option .otable-chip-label',
        (els) => els.map((e) => (e as HTMLElement).textContent)
    );
    expect(optionLabels).toEqual(expect.arrayContaining(['urgent', 'review']));

    // n1 currently has both → both checked
    const checks = await page.$$eval(
        '.otable-multiselect-dropdown-option .otable-multiselect-dropdown-check',
        (els) => els.map((e) => (e as HTMLElement).textContent)
    );
    expect(checks.every((c) => c === '☑')).toBe(true);
});

// ---------------------------------------------------------------------------
// TC-804: dropdown filter + multi-toggle
// ---------------------------------------------------------------------------
test('TC-804 — typing into the input filters options and clicking toggles selection', async ({ page }) => {
    const data = baseData();
    // Start with n1 having only opt_1, so toggling opt_2 from unchecked → checked is testable
    data.nodes.n1.columnValues.col_tags = ['opt_1'];
    await setupTable(page, data);

    // Open dropdown
    await page.locator(
        '.otable-row[data-node-id="n1"] .otable-cell-multiselect .otable-chip-add'
    ).click();
    await page.waitForTimeout(40);

    // Type "rev" → only "review" visible
    await page.locator('.otable-multiselect-dropdown-input').fill('rev');
    await page.waitForTimeout(40);

    let labels = await page.$$eval(
        '.otable-multiselect-dropdown-option .otable-chip-label',
        (els) => els.map((e) => (e as HTMLElement).textContent)
    );
    expect(labels).toEqual(['review']);

    // First option is unchecked (opt_2 not yet on n1)
    const initialCheck = await page.locator(
        '.otable-multiselect-dropdown-option:first-child .otable-multiselect-dropdown-check'
    ).textContent();
    expect(initialCheck).toBe('☐');

    // Click → toggles on
    await page.locator('.otable-multiselect-dropdown-option').first().click();
    await page.waitForTimeout(40);

    // Now n1 has both
    const after = await page.evaluate(() => {
        const T = (window as any).OutlinerTable;
        return T._getModel().getNode('n1').columnValues.col_tags;
    });
    expect(after).toEqual(['opt_1', 'opt_2']);

    // Dropdown still open, the same row now ☑
    const newCheck = await page.locator(
        '.otable-multiselect-dropdown-option:first-child .otable-multiselect-dropdown-check'
    ).textContent();
    expect(newCheck).toBe('☑');

    // Cell now shows 2 chips (count direct chip children only, excluding dropdown previews)
    const chipCount = await page.$$eval(
        '.otable-row[data-node-id="n1"] .otable-cell-multiselect > .otable-chip',
        (els) => els.length
    );
    expect(chipCount).toBe(2);

    // Click again → toggles off
    await page.locator('.otable-multiselect-dropdown-option').first().click();
    await page.waitForTimeout(40);

    const after2 = await page.evaluate(() => {
        const T = (window as any).OutlinerTable;
        return T._getModel().getNode('n1').columnValues.col_tags;
    });
    expect(after2).toEqual(['opt_1']);
});

// ---------------------------------------------------------------------------
// TC-805: inline option create with palette[N % 8]
// ---------------------------------------------------------------------------
test('TC-805 — typing a non-matching label shows + Create row and adds option with palette[N%8] color', async ({ page }) => {
    await setupTable(page, baseData());

    // Open dropdown on n2 (currently has only opt_2)
    await page.locator(
        '.otable-row[data-node-id="n2"] .otable-cell-multiselect .otable-chip-add'
    ).click();
    await page.waitForTimeout(40);

    // Type a brand new label
    await page.locator('.otable-multiselect-dropdown-input').fill('blocker');
    await page.waitForTimeout(40);

    // "+ Create" row visible
    const createRow = page.locator('.otable-multiselect-dropdown-create');
    await expect(createRow).toHaveCount(1);
    const createText = await createRow.textContent();
    expect(createText || '').toContain('blocker');

    // Click → adds new option (palette index = 2 == 'yellow', since options.length was 2)
    await createRow.click();
    await page.waitForTimeout(60);

    const cols = await page.evaluate(() => (window as any).OutlinerTable._getColumns());
    const tagCol = cols.find((c: any) => c.id === 'col_tags');
    expect(tagCol.options.length).toBe(3);
    const newOpt = tagCol.options[2];
    expect(newOpt.label).toBe('blocker');
    expect(newOpt.color).toBe('yellow'); // palette[2 % 8]
    expect(typeof newOpt.id).toBe('string');
    expect(newOpt.id).toMatch(/^opt_/);

    // n2 now has [opt_2, <new>]
    const after = await page.evaluate(() => {
        const T = (window as any).OutlinerTable;
        return T._getModel().getNode('n2').columnValues.col_tags;
    });
    expect(after.length).toBe(2);
    expect(after[0]).toBe('opt_2');
    expect(after[1]).toBe(newOpt.id);

    // Cell shows the new chip with correct color class (direct chip children only)
    const chipClasses = await page.$$eval(
        '.otable-row[data-node-id="n2"] .otable-cell-multiselect > .otable-chip',
        (els) => els.map((e) => (e as HTMLElement).className)
    );
    expect(chipClasses.some((cls) => cls.indexOf('otable-chip-color-yellow') !== -1)).toBe(true);
});

// ---------------------------------------------------------------------------
