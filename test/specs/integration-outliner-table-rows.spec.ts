/**
 * Outliner Table Editor — Row recycling (TASK-B4).
 *
 * TC-501〜TC-503
 *
 * design: design/system.md §4.3.3 (row recycling) / §8.2 row recycling 必須
 * testcases: TC-501, TC-502, TC-503
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

const fiveTopWithChildren = () => ({
    title: 'TC-501',
    rootIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    nodes: {
        p1: { id: 'p1', parentId: null, children: ['c1', 'c2'], text: 'Project A', tags: [] },
        c1: { id: 'c1', parentId: 'p1', children: [], text: 'A-child-1', tags: [] },
        c2: { id: 'c2', parentId: 'p1', children: [], text: 'A-child-2', tags: [] },
        p2: { id: 'p2', parentId: null, children: [], text: 'Project B', tags: [] },
        p3: { id: 'p3', parentId: null, children: [], text: 'Project C', tags: [] },
        p4: { id: 'p4', parentId: null, children: [], text: 'Project D', tags: [] },
        p5: { id: 'p5', parentId: null, children: [], text: 'Project E', tags: [] }
    },
    columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
});

// ---------------------------------------------------------------------------
// TC-501: row count = visible nodes (5 top + 2 expanded children = 7)
// ---------------------------------------------------------------------------
test('TC-501 row count equals visible nodes (5 top + 2 children = 7)', async ({ page }) => {
    await setupTable(page, fiveTopWithChildren());
    const rows = await page.locator('.otable-row').count();
    expect(rows).toBe(7);
});

// ---------------------------------------------------------------------------
// TC-502: collapse → child rows disappear
// ---------------------------------------------------------------------------
test('TC-502 collapse removes child rows from DOM', async ({ page }) => {
    await setupTable(page, fiveTopWithChildren());
    let rows = await page.locator('.otable-row').count();
    expect(rows).toBe(7);

    // collapse Project A by clicking its bullet
    await page.locator('.otable-row[data-node-id="p1"] .outliner-bullet').click();
    await page.waitForTimeout(80);

    rows = await page.locator('.otable-row').count();
    expect(rows).toBe(5);
    // children should not exist
    expect(await page.locator('.otable-row[data-node-id="c1"]').count()).toBe(0);
    expect(await page.locator('.otable-row[data-node-id="c2"]').count()).toBe(0);
});

// ---------------------------------------------------------------------------
// TC-503: indent / Enter / Backspace move rows correctly with recycling
// ---------------------------------------------------------------------------
test('TC-503 indent moves a row under its previous sibling', async ({ page }) => {
    await setupTable(page, fiveTopWithChildren());

    // focus p2 and Tab → p2 becomes child of p1
    await page.locator('.otable-row[data-node-id="p2"] .outliner-text').click();
    await page.waitForTimeout(40);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);

    // verify model: p2.parentId == p1
    const parentId = await page.evaluate(() =>
        (window as any).OutlinerTable._getModel().getNode('p2').parentId);
    expect(parentId).toBe('p1');

    // visible row count should still be 7 (now p1 has 3 children: c1, c2, p2)
    const rows = await page.locator('.otable-row').count();
    expect(rows).toBe(7);
});

test('TC-503 Enter at end of focused row inserts a new row immediately after', async ({ page }) => {
    await setupTable(page, fiveTopWithChildren());
    // collapse p1 first to keep simple
    await page.locator('.otable-row[data-node-id="p1"] .outliner-bullet').click();
    await page.waitForTimeout(60);
    let rows = await page.locator('.otable-row').count();
    expect(rows).toBe(5);

    // focus end of p3 then Enter
    await page.locator('.otable-row[data-node-id="p3"] .outliner-text').click();
    await page.waitForTimeout(40);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);

    rows = await page.locator('.otable-row').count();
    expect(rows).toBe(6);

    const rootIds = await page.evaluate(() =>
        (window as any).OutlinerTable._getModel().rootIds);
    expect(rootIds[0]).toBe('p1');
    expect(rootIds[2]).toBe('p3');
    // new sibling should be inserted between p3 and p4
    expect(rootIds[3]).not.toBe('p4');
    expect(rootIds[4]).toBe('p4');
});

test('TC-503 Backspace on empty node + children promotes children to parent level', async ({ page }) => {
    const data = {
        title: 'TC-503-bs',
        rootIds: ['p1', 'empty', 'p3'],
        nodes: {
            p1: { id: 'p1', parentId: null, children: [], text: 'p1', tags: [] },
            empty: { id: 'empty', parentId: null, children: ['c1', 'c2'], text: '', tags: [] },
            c1: { id: 'c1', parentId: 'empty', children: [], text: 'c1', tags: [] },
            c2: { id: 'c2', parentId: 'empty', children: [], text: 'c2', tags: [] },
            p3: { id: 'p3', parentId: null, children: [], text: 'p3', tags: [] }
        },
        columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
    };
    await setupTable(page, data);
    let rows = await page.locator('.otable-row').count();
    expect(rows).toBe(5);

    // focus empty node (no text) then Backspace
    await page.locator('.otable-row[data-node-id="empty"] .outliner-text').click();
    await page.waitForTimeout(40);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);

    // empty should be removed; c1, c2 promoted to root
    rows = await page.locator('.otable-row').count();
    expect(rows).toBe(4);
    expect(await page.locator('.otable-row[data-node-id="empty"]').count()).toBe(0);

    const rootIds = await page.evaluate(() =>
        (window as any).OutlinerTable._getModel().rootIds);
    expect(rootIds).toEqual(['p1', 'c1', 'c2', 'p3']);
    const c1Parent = await page.evaluate(() =>
        (window as any).OutlinerTable._getModel().getNode('c1').parentId);
    expect(c1Parent).toBeNull();
});

// ---------------------------------------------------------------------------
// Sanity: row recycling preserves DOM identity for unaffected rows
// ---------------------------------------------------------------------------
test('row recycling preserves the same DOM element for unaffected rows after collapse', async ({ page }) => {
    await setupTable(page, fiveTopWithChildren());

    // mark a custom property on p3's row before collapse
    await page.evaluate(() => {
        const row = document.querySelector('.otable-row[data-node-id="p3"]') as HTMLElement;
        if (row) { row.dataset.testMarker = 'persistent'; }
    });

    // collapse p1 (p3 row should be unchanged)
    await page.locator('.otable-row[data-node-id="p1"] .outliner-bullet').click();
    await page.waitForTimeout(80);

    // marker on p3 should survive recycling (no rebuild)
    const marker = await page.evaluate(() => {
        const row = document.querySelector('.otable-row[data-node-id="p3"]') as HTMLElement;
        return row ? row.dataset.testMarker : null;
    });
    expect(marker).toBe('persistent');
});
