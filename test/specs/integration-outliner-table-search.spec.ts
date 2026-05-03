/**
 * Outliner Table Editor — header search box (TASK-B6)
 *
 * design: design/system.md §4.3 / §10
 * testcases:
 *   - TC-1001 keyword search across Outliner cell + text cell values
 *   - TC-1002 Dynalist-compatible operators (is:page, has:children)
 *   - TC-1003 multiselect option label matching
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

async function applyFilter(page: Page, query: string): Promise<void> {
    await page.evaluate((q) => {
        (window as any).OutlinerTable.applySearchFilter(q);
    }, query);
    await page.waitForTimeout(20);
}

async function getVisibleNodeIds(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const rows = document.querySelectorAll('.otable-rows .otable-row');
        const out: string[] = [];
        rows.forEach((r) => {
            const el = r as HTMLElement;
            if (!el.classList.contains('otable-row-hidden')) {
                const id = el.dataset.nodeId;
                if (id) { out.push(id); }
            }
        });
        return out;
    });
}

// ---------------------------------------------------------------------------
// TC-1001: keyword search across Outliner cell + text cell values
// ---------------------------------------------------------------------------
test.describe('TC-1001 — keyword search (Outliner cell + text cell)', () => {
    test('TC-1001-A matches keyword in Outliner cell text', async ({ page }) => {
        const data = {
            rootIds: ['n1', 'n2', 'n3'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'apple banana', tags: [] },
                n2: { id: 'n2', parentId: null, children: [], text: 'orange', tags: [] },
                n3: { id: 'n3', parentId: null, children: [], text: 'banana split', tags: [] }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }
            ]
        };
        await setupTable(page, data);
        await applyFilter(page, 'banana');
        const visible = await getVisibleNodeIds(page);
        // n1 (banana) and n3 (banana split) should be visible, n2 hidden
        expect(visible).toEqual(expect.arrayContaining(['n1', 'n3']));
        expect(visible).not.toContain('n2');
    });

    test('TC-1001-B matches keyword in text cell value', async ({ page }) => {
        const data = {
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
        };
        await setupTable(page, data);
        await applyFilter(page, 'progress');
        const visible = await getVisibleNodeIds(page);
        expect(visible).toContain('n1');
        expect(visible).not.toContain('n2');
    });

    test('TC-1001-C empty query restores all rows', async ({ page }) => {
        const data = {
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'foo', tags: [] },
                n2: { id: 'n2', parentId: null, children: [], text: 'bar', tags: [] }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }
            ]
        };
        await setupTable(page, data);
        await applyFilter(page, 'foo');
        let visible = await getVisibleNodeIds(page);
        expect(visible).toEqual(['n1']);
        await applyFilter(page, '');
        visible = await getVisibleNodeIds(page);
        expect(visible).toEqual(expect.arrayContaining(['n1', 'n2']));
    });
});

// ---------------------------------------------------------------------------
// TC-1002: Dynalist-compatible search operators
// ---------------------------------------------------------------------------
test.describe('TC-1002 — Dynalist operators (is:page, has:children)', () => {
    test('TC-1002-A is:page filters page nodes only', async ({ page }) => {
        const data = {
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'page node', tags: [], isPage: true, pageId: 'p1' },
                n2: { id: 'n2', parentId: null, children: [], text: 'plain node', tags: [] }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }
            ]
        };
        await setupTable(page, data);
        await applyFilter(page, 'is:page');
        const visible = await getVisibleNodeIds(page);
        expect(visible).toContain('n1');
        expect(visible).not.toContain('n2');
    });

    test('TC-1002-B has:children matches parents and shows descendants', async ({ page }) => {
        const data = {
            rootIds: ['p1', 'leaf1'],
            nodes: {
                p1: { id: 'p1', parentId: null, children: ['c1', 'c2'], text: 'parent', tags: [] },
                c1: { id: 'c1', parentId: 'p1', children: [], text: 'child1', tags: [] },
                c2: { id: 'c2', parentId: 'p1', children: [], text: 'child2', tags: [] },
                leaf1: { id: 'leaf1', parentId: null, children: [], text: 'leaf', tags: [] }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }
            ]
        };
        await setupTable(page, data);
        await applyFilter(page, 'has:children');
        const visible = await getVisibleNodeIds(page);
        // p1 matches; descendants c1, c2 should also be shown (tree mode)
        expect(visible).toContain('p1');
        expect(visible).toContain('c1');
        expect(visible).toContain('c2');
        expect(visible).not.toContain('leaf1');
    });
});

// ---------------------------------------------------------------------------
// TC-1003: multiselect option label search (TASK-C4)
// matchesNodeWithColumns augments node.text with each multiselect option label
// of selected option ids — so search hits work against the human label, not
// the internal opt_xxxx id.
// ---------------------------------------------------------------------------
test.describe('TC-1003 — multiselect option label search', () => {
    test('TC-1003 matches against option label, not just option id', async ({ page }) => {
        const data = {
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [],
                    columnValues: { col_tags: ['opt_a'] } },
                n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [],
                    columnValues: { col_tags: ['opt_b'] } }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'col_tags', type: 'multiselect', name: 'Tags', order: 1,
                    options: [
                        { id: 'opt_a', label: 'Important', color: 'red' },
                        { id: 'opt_b', label: 'Optional', color: 'gray' }
                    ]
                }
            ]
        };
        await setupTable(page, data);
        await applyFilter(page, 'Important');
        const visible = await getVisibleNodeIds(page);
        expect(visible).toContain('n1');
        expect(visible).not.toContain('n2');
    });

    test('TC-1003-B partial match against label is honored', async ({ page }) => {
        const data = {
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'a', tags: [],
                    columnValues: { col_tags: ['opt_a'] } },
                n2: { id: 'n2', parentId: null, children: [], text: 'b', tags: [],
                    columnValues: { col_tags: ['opt_b'] } }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'col_tags', type: 'multiselect', name: 'Tags', order: 1,
                    options: [
                        { id: 'opt_a', label: 'urgent', color: 'red' },
                        { id: 'opt_b', label: 'review', color: 'blue' }
                    ]
                }
            ]
        };
        await setupTable(page, data);
        await applyFilter(page, 'urg'); // partial
        const visible = await getVisibleNodeIds(page);
        expect(visible).toContain('n1');
        expect(visible).not.toContain('n2');
    });

    test('TC-1003-C orphan option id is not matched by label search (no label registered)', async ({ page }) => {
        // n1 has an option id opt_orphan that is NOT in column.options[].
        // Searching for the would-be label should NOT match — only registered
        // option labels are augmented into the search corpus.
        const data = {
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'a', tags: [],
                    columnValues: { col_tags: ['opt_orphan'] } },
                n2: { id: 'n2', parentId: null, children: [], text: 'b', tags: [],
                    columnValues: { col_tags: ['opt_known'] } }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'col_tags', type: 'multiselect', name: 'Tags', order: 1,
                    options: [
                        { id: 'opt_known', label: 'shipping', color: 'green' }
                    ]
                }
            ]
        };
        await setupTable(page, data);
        await applyFilter(page, 'shipping');
        const visible = await getVisibleNodeIds(page);
        expect(visible).toContain('n2');
        expect(visible).not.toContain('n1');
    });
});
