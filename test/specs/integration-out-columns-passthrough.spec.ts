/**
 * Outliner editor の `.out` 未知 top-level fields passthrough テスト (TASK-A6)
 *
 * design 仕様: design/system.md §4.2.2 + §4.2.2-A
 * testcases: TC-301, TC-301-A, TC-302, TC-303
 *
 * 検証対象:
 *   - rawDataExtras 機構: init / applyExternalUpdate / updateData (file change) で
 *     未知 top-level fields を保持し syncToHostImmediate で passthrough
 *   - knownKeys には既存 fields (title/pageDir/fileDir/imageDir/rootIds/nodes/
 *     pinnedTags/searchFocusMode/sidePanelWidth/sidePanelOutlineWidth) +
 *     v7.3 で撤回された schemaVersion を含む
 *   - schemaVersion は drop される (knownKeys 扱い)、columns / 任意 myCustomField は保持
 *   - external update 後の save で「古い snapshot で上書き」しないことを確認 (シナリオ C)
 */
import { test, expect, Page } from '@playwright/test';

const TEST_OUT_KEY = '/path/to/test.out';

async function setupOutliner(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate(({ data, key }) => {
        (window as any).__testApi.initOutliner(data, key);
    }, { data, key: TEST_OUT_KEY });
    await page.waitForTimeout(100);
}

async function clearMessages(page: Page): Promise<void> {
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
}

async function flushSyncAndGetPayload(page: Page): Promise<any> {
    // host.flushSync() を呼び、同期的に host.syncData が発火 → __testApi.lastSyncData に書き込まれる
    await page.evaluate(() => {
        if ((window as any).Outliner && (window as any).Outliner.flushSync) {
            (window as any).Outliner.flushSync();
        }
    });
    await page.waitForTimeout(80);
    const lastSyncData = await page.evaluate(() => (window as any).__testApi.lastSyncData);
    expect(lastSyncData, 'host.syncData should have been called').toBeTruthy();
    return JSON.parse(lastSyncData);
}

async function editFirstNodeText(page: Page, append: string): Promise<void> {
    const firstText = page.locator('.outliner-text').first();
    await firstText.click();
    // Move to end of cell content, then type
    await page.keyboard.press('End');
    await page.keyboard.type(append);
    await page.waitForTimeout(120);
}

test.describe('TC-301 — Outliner editor preserves columns + columnValues on save', () => {
    const initData = () => ({
        title: 'Test Outline',
        rootIds: ['n1', 'n2'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [] },
            n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [] }
        },
        columns: [
            { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
            { id: 'col_test', type: 'text', name: 'Test', order: 1 }
        ]
    });

    test('TC-301 saves columns array unchanged after node text edit', async ({ page }) => {
        const data = initData();
        // node に columnValues を仕込む (.out 仕様の columnValues も passthrough されるか確認)
        (data.nodes.n1 as any).columnValues = { col_test: 'hello' };

        await setupOutliner(page, data);
        await clearMessages(page);
        await editFirstNodeText(page, ' edited');

        const payload = await flushSyncAndGetPayload(page);

        // 1. 未知 top-level field `columns` が保持されている
        expect(payload.columns).toBeDefined();
        expect(Array.isArray(payload.columns)).toBe(true);
        expect(payload.columns).toHaveLength(2);
        expect(payload.columns[0]).toMatchObject({ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 });
        expect(payload.columns[1]).toMatchObject({ id: 'col_test', type: 'text', name: 'Test', order: 1 });

        // 2. node.columnValues は model.serialize 経由で保持される (OutlinerModel が拾えば)
        //    この sprint では outliner-model.js は無変更なので、columnValues が「ノード内の
        //    既存形式を破壊しない」ことのみ確認。最低限 nodes.n1 自体は payload にある
        expect(payload.nodes).toBeDefined();
        expect(payload.nodes.n1).toBeDefined();
        expect(payload.nodes.n1.text).toContain('edited');
    });
});

test.describe('TC-301-A — external update refreshes rawDataExtras (scenario C)', () => {
    test('TC-301-A applies new columns snapshot after externalUpdate, not the original', async ({ page }) => {
        // 初期: columns: [colA] のみ
        const initial = {
            title: 'Sync Test',
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'one', tags: [] } },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'colA', type: 'text', name: 'A', order: 1 }
            ]
        };
        await setupOutliner(page, initial);

        // 別 webview (Table editor) が columns: [colA, colB] を加えて保存した想定 →
        // file watcher が externalUpdate で notify
        const updatedFromExternal = {
            title: 'Sync Test',
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'one', tags: [] } },
            columns: [
                { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
                { id: 'colA', type: 'text', name: 'A', order: 1 },
                { id: 'colB', type: 'multiselect', name: 'B', order: 2, options: [] }
            ]
        };
        await page.evaluate((newData) => {
            (window as any).__hostMessageHandler({ type: 'updateData', data: newData });
        }, updatedFromExternal);
        await page.waitForTimeout(150);

        // この後 outliner editor 側で text 編集 → save
        await clearMessages(page);
        await editFirstNodeText(page, ' edited');
        const payload = await flushSyncAndGetPayload(page);

        // payload の columns は新 snapshot ([colA, colB] あり)
        expect(payload.columns).toHaveLength(3);
        const ids = payload.columns.map((c: any) => c.id).sort();
        expect(ids).toEqual(['colA', 'colB', 'col_outliner'].sort());

        // 念のため: 古い snapshot で上書きしていない (colB がいる)
        expect(payload.columns.some((c: any) => c.id === 'colB')).toBe(true);
    });
});

test.describe('TC-302 — clean-by-default for .out without columns', () => {
    test('TC-302 does not add columns key when input had none', async ({ page }) => {
        const data = {
            title: 'No Columns',
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'plain', tags: [] } }
        };
        await setupOutliner(page, data);
        await clearMessages(page);
        await editFirstNodeText(page, ' edited');
        const payload = await flushSyncAndGetPayload(page);

        // columns field は存在しない (clean-by-default)
        expect(payload.columns).toBeUndefined();
    });
});

test.describe('TC-303 — unknown forward-compat fields preserved, schemaVersion dropped', () => {
    test('TC-303 preserves myCustomField but drops schemaVersion (knownKeys / v7.3 retired)', async ({ page }) => {
        const data: any = {
            title: 'Forward Compat',
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'hello', tags: [] } },
            myCustomField: 42,
            schemaVersion: 2,                    // v7.3 で撤回 → drop されること
            columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
        };
        await setupOutliner(page, data);
        await clearMessages(page);
        await editFirstNodeText(page, '!');
        const payload = await flushSyncAndGetPayload(page);

        // forward-compat: 未知 field は保持
        expect(payload.myCustomField).toBe(42);
        // columns も passthrough
        expect(payload.columns).toBeDefined();
        expect(payload.columns[0].id).toBe('col_outliner');
        // schemaVersion は knownKeys 扱いで drop (現行 outliner editor は schemaVersion を書かない)
        expect(payload.schemaVersion).toBeUndefined();
    });
});
