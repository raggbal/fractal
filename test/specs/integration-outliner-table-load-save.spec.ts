/**
 * Outliner Table Editor v1 — bootstrap / load / save round-trip (TASK-B1)
 *
 * design: design/system.md §4.3 / §3.1〜§3.3
 * testcases:
 *   - TC-1101 (load with columns): 列ヘッダー + 行 数、cell 値が columnValues から取得
 *   - TC-1102 (save round-trip): 編集なし syncToHostImmediate で columns / columnValues 破壊なし
 *   - TC-201 (列定義あり .out load): 列ヘッダー 3 個、行 = visible nodes
 *   - TC-202 (列定義なし .out auto 補完 in-memory only): clean-by-default で save に columns 出さない
 *   - TC-203 (type:'outliner' 必須): 列定義に outliner 列が無い時の自動補完
 *   - TC-204 (ColumnDef id 衝突なし): generateColumnId の重複なし
 */
import { test, expect, Page } from '@playwright/test';

async function setupTable(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutlinerTable(d);
    }, data);
    // 多少の microtask 待ち
    await page.waitForTimeout(50);
}

async function flushSyncAndGetPayload(page: Page): Promise<any> {
    await page.evaluate(() => {
        (window as any).__testApi.lastSyncData = null;
        (window as any).__testApi.flushSync();
    });
    await page.waitForTimeout(50);
    const last = await page.evaluate(() => (window as any).__testApi.lastSyncData);
    expect(last, 'syncData should have been called').toBeTruthy();
    return JSON.parse(last);
}

// ---------------------------------------------------------------------------
// TC-1101 — load with columns: 列ヘッダー数 / 行数 / cell 値
// ---------------------------------------------------------------------------
test.describe('TC-1101 — load with columns (header + row + cell value)', () => {
    test('TC-1101 renders 3 column headers + 1 row per visible node, with columnValues populated', async ({ page }) => {
        const data = {
            title: 'TC-1101',
            rootIds: ['n1', 'n2', 'n3'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [],
                    columnValues: { col_text: 'alpha' } },
                n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [],
                    columnValues: { col_text: 'beta' } },
                n3: { id: 'n3', parentId: null, children: [], text: 'third', tags: [] }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'col_text', type: 'text', name: 'Status', order: 1 },
                { id: 'col_ms', type: 'multiselect', name: 'Tags', order: 2, options: [] }
            ]
        };
        await setupTable(page, data);

        // 列ヘッダー 3 個
        const headers = page.locator('.otable-column-header');
        await expect(headers).toHaveCount(3);
        await expect(headers.nth(0)).toContainText('Outline');
        await expect(headers.nth(1)).toContainText('Status');
        await expect(headers.nth(2)).toContainText('Tags');

        // 行数 = visible nodes (3 root, all without collapsed)
        const rows = page.locator('.otable-row');
        await expect(rows).toHaveCount(3);

        // outliner cell の text: first / second / third
        await expect(rows.nth(0).locator('.otable-cell-outliner')).toContainText('first');
        await expect(rows.nth(1).locator('.otable-cell-outliner')).toContainText('second');
        await expect(rows.nth(2).locator('.otable-cell-outliner')).toContainText('third');

        // text cell の値 (columnValues 取得)
        await expect(rows.nth(0).locator('.otable-cell-text')).toContainText('alpha');
        await expect(rows.nth(1).locator('.otable-cell-text')).toContainText('beta');
        // n3 は columnValues 未定義 → 空文字
        const n3Text = await rows.nth(2).locator('.otable-cell-text').textContent();
        expect((n3Text || '').trim()).toBe('');
    });
});

// ---------------------------------------------------------------------------
// TC-1102 — save round-trip: 何も編集せず syncToHostImmediate を発火
// ---------------------------------------------------------------------------
test.describe('TC-1102 — save round-trip preserves columns + columnValues', () => {
    test('TC-1102 syncToHostImmediate emits payload with columns and columnValues intact', async ({ page }) => {
        const data = {
            title: 'TC-1102',
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'only', tags: [],
                    columnValues: { col_text: 'value-x', col_ms: ['opt_a', 'opt_b'] } }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'col_text', type: 'text', name: 'T', order: 1 },
                { id: 'col_ms', type: 'multiselect', name: 'M', order: 2,
                    options: [
                        { id: 'opt_a', label: 'A', color: 'red' },
                        { id: 'opt_b', label: 'B', color: 'blue' }
                    ] }
            ]
        };
        await setupTable(page, data);
        const payload = await flushSyncAndGetPayload(page);

        // columns が完全に round-trip
        expect(Array.isArray(payload.columns)).toBe(true);
        expect(payload.columns).toHaveLength(3);
        expect(payload.columns[0]).toMatchObject({ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 });
        expect(payload.columns[1]).toMatchObject({ id: 'col_text', type: 'text', name: 'T', order: 1 });
        expect(payload.columns[2]).toMatchObject({ id: 'col_ms', type: 'multiselect', name: 'M', order: 2 });
        expect(payload.columns[2].options).toHaveLength(2);
        expect(payload.columns[2].options[0]).toMatchObject({ id: 'opt_a', label: 'A', color: 'red' });

        // columnValues が完全に round-trip (model.serialize 経由で保持される)
        expect(payload.nodes).toBeDefined();
        expect(payload.nodes.n1).toBeDefined();
        expect(payload.nodes.n1.columnValues).toBeDefined();
        expect(payload.nodes.n1.columnValues.col_text).toBe('value-x');
        expect(payload.nodes.n1.columnValues.col_ms).toEqual(['opt_a', 'opt_b']);
    });
});

// ---------------------------------------------------------------------------
// TC-201 — 列定義あり .out load (header count + row count)
// ---------------------------------------------------------------------------
test.describe('TC-201 — load .out with explicit column definitions', () => {
    test('TC-201 displays headers for each column and one row per visible node', async ({ page }) => {
        const data = {
            title: 'TC-201',
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: ['n3'], text: 'parent', tags: [], collapsed: false },
                n2: { id: 'n2', parentId: null, children: [], text: 'sibling', tags: [] },
                n3: { id: 'n3', parentId: 'n1', children: [], text: 'child', tags: [] }
            },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'col_text', type: 'text', name: 'Status', order: 1 },
                { id: 'col_ms', type: 'multiselect', name: 'Tags', order: 2, options: [] }
            ]
        };
        await setupTable(page, data);

        await expect(page.locator('.otable-column-header')).toHaveCount(3);
        // visible nodes: n1, n3 (child of n1, not collapsed), n2
        await expect(page.locator('.otable-row')).toHaveCount(3);
        // 各行が data-node-id を持つ
        const ids = await page.locator('.otable-row').evaluateAll(
            (els) => els.map((e) => (e as HTMLElement).dataset.nodeId)
        );
        expect(ids).toEqual(['n1', 'n3', 'n2']);
    });
});

// ---------------------------------------------------------------------------
// TC-202 — 列定義なし .out: in-memory auto-completion, clean-by-default save
// ---------------------------------------------------------------------------
test.describe('TC-202 — auto-complete columns in-memory only when none defined', () => {
    test('TC-202 auto-injects outliner column for display, but does not write columns on save', async ({ page }) => {
        const data = {
            title: 'TC-202',
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'plain', tags: [] } }
        };
        await setupTable(page, data);

        // 列ヘッダー 1 個 (auto outliner)
        await expect(page.locator('.otable-column-header')).toHaveCount(1);
        await expect(page.locator('.otable-column-header').first()).toContainText('Outline');

        // save しても columns は書き出されない (clean-by-default)
        const payload = await flushSyncAndGetPayload(page);
        expect(payload.columns).toBeUndefined();
        // node は当然書き出される
        expect(payload.nodes.n1).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// TC-203 — type:'outliner' 必須: outliner 列がない場合は先頭に自動補完
// ---------------------------------------------------------------------------
test.describe('TC-203 — outliner column is enforced (auto-prepended when missing)', () => {
    test('TC-203 prepends outliner column when columns array has only text/multiselect', async ({ page }) => {
        const data = {
            title: 'TC-203',
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'one', tags: [] } },
            columns: [
                { id: 'col_text', type: 'text', name: 'Status', order: 1 }
            ]
        };
        await setupTable(page, data);

        const headers = page.locator('.otable-column-header');
        await expect(headers).toHaveCount(2);
        // 先頭は outliner 列
        await expect(headers.nth(0)).toHaveAttribute('data-col-id', 'col_outliner');
        await expect(headers.nth(0)).toContainText('Outline');
        // 既存の text 列は維持される
        await expect(headers.nth(1)).toHaveAttribute('data-col-id', 'col_text');

        // save 時には columns は書き出される (元データに columns があったので、
        // 自動補完された outliner 列も含めて永続化)
        const payload = await flushSyncAndGetPayload(page);
        expect(Array.isArray(payload.columns)).toBe(true);
        const types = payload.columns.map((c: any) => c.type);
        expect(types).toContain('outliner');
        expect(types).toContain('text');
    });
});

// ---------------------------------------------------------------------------
// TC-204 — ColumnDef id 衝突なし
// ---------------------------------------------------------------------------
test.describe('TC-204 — generateColumnId / generateOptionId produce unique ids', () => {
    test('TC-204 100 calls of generateColumnId produce no duplicates', async ({ page }) => {
        await page.goto('/standalone-outliner-table.html');
        await page.waitForFunction(() => (window as any).OutlinerTable && (window as any).OutlinerTable._generateColumnId);
        const result = await page.evaluate(() => {
            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                ids.add((window as any).OutlinerTable._generateColumnId());
            }
            const opts = new Set<string>();
            for (let i = 0; i < 100; i++) {
                opts.add((window as any).OutlinerTable._generateOptionId());
            }
            return { idCount: ids.size, optCount: opts.size };
        });
        expect(result.idCount).toBe(100);
        expect(result.optCount).toBe(100);
    });

    test('TC-204 generated ids match expected format (col_<8 chars>, opt_<8 chars>)', async ({ page }) => {
        await page.goto('/standalone-outliner-table.html');
        await page.waitForFunction(() => (window as any).OutlinerTable && (window as any).OutlinerTable._generateColumnId);
        const samples = await page.evaluate(() => {
            return {
                col: (window as any).OutlinerTable._generateColumnId(),
                opt: (window as any).OutlinerTable._generateOptionId()
            };
        });
        expect(samples.col).toMatch(/^col_[a-z0-9]{1,8}$/);
        expect(samples.opt).toMatch(/^opt_[a-z0-9]{1,8}$/);
    });
});
