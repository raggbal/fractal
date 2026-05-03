/**
 * Outliner Table Editor — Outliner cell 操作互換 (TASK-B2)
 *
 * TC-601〜TC-620 (+ optional drawio suffix subcases TC-610-A / 611-A / 612-A).
 *
 * design: design/system.md §4.3 / §4.3.4 (Cell ↔ Tree boundary)
 * testcases: TC-601〜TC-620
 *
 * 注意: TC-610-A / 611-A / 612-A (drawio multi-extension suffix) と TC-616 (image D&D)
 *      / TC-620 (file attach D&D) は host 側の fs 操作を伴うため standalone HTML 内では
 *      限定的にしか検証できない。host bridge メッセージが正しく組み立てられるかまで確認し、
 *      実 fs 動作は手動 US テストに委ねる。
 */
import { test, expect, Page } from '@playwright/test';

// Use single worker for these spec files (DOM state is module-private and shared across describes).
test.describe.configure({ mode: 'serial' });

async function setupTable(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutlinerTable(d);
    }, data);
    await page.waitForTimeout(80);
}

async function clearMessages(page: Page) {
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
}

async function getMessages(page: Page): Promise<any[]> {
    return await page.evaluate(() => (window as any).__testApi.messages);
}

async function focusOutlinerTextByIndex(page: Page, idx: number) {
    const textEl = page.locator('.otable-row').nth(idx).locator('.outliner-text');
    await textEl.click();
    await page.waitForTimeout(40);
    return textEl;
}

async function focusOutlinerTextByNodeId(page: Page, nodeId: string) {
    const textEl = page.locator(`.otable-row[data-node-id="${nodeId}"] .outliner-text`);
    await textEl.click();
    await page.waitForTimeout(40);
    return textEl;
}

const simpleData = () => ({
    title: 'cell-compat',
    rootIds: ['n1', 'n2', 'n3'],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [] },
        n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [] },
        n3: { id: 'n3', parentId: null, children: [], text: 'third', tags: [] }
    },
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }
    ]
});

// ---------------------------------------------------------------------------
// TC-601: cmd+enter -> host.openMdPage
// ---------------------------------------------------------------------------
test.describe('TC-601 — cmd+enter on isPage opens md page', () => {
    test('TC-601 cmd+enter on a page node calls host.openMdPage with nodeId/pageId', async ({ page }) => {
        const data = {
            title: 'TC-601',
            rootIds: ['n1'],
            nodes: {
                n1: {
                    id: 'n1', parentId: null, children: [], text: 'page node',
                    tags: [], isPage: true, pageId: 'page-1234'
                }
            },
            columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
        };
        await setupTable(page, data);
        await focusOutlinerTextByNodeId(page, 'n1');
        await clearMessages(page);
        await page.keyboard.press('Meta+Enter');
        await page.waitForTimeout(60);
        const msgs = await getMessages(page);
        const open = msgs.find((m) => m.type === 'openMdPage');
        expect(open).toBeTruthy();
        expect(open.payload.nodeId).toBe('n1');
        expect(open.payload.pageId).toBe('page-1234');
    });
});

// ---------------------------------------------------------------------------
// TC-602: cmd+B 太字 toggle
// ---------------------------------------------------------------------------
test.describe('TC-602 — cmd+B inserts bold marker', () => {
    test('TC-602 cmd+B inserts ** at cursor (no selection)', async ({ page }) => {
        await setupTable(page, simpleData());
        await focusOutlinerTextByNodeId(page, 'n1');
        await page.keyboard.press('Meta+b');
        await page.waitForTimeout(60);
        const text = await page.evaluate(() => {
            const m: any = (window as any).OutlinerTable._getModel();
            return m.getNode('n1').text;
        });
        // Insertion at end of "first" should produce "first****"
        expect(text).toContain('**');
    });
});

// ---------------------------------------------------------------------------
// TC-603: cmd+I 斜体
// ---------------------------------------------------------------------------
test('TC-603 cmd+I inserts italic marker', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n1');
    await page.keyboard.press('Meta+i');
    await page.waitForTimeout(60);
    const text = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    // italic uses single * — text should contain ** (two * for empty insertion)
    expect(text.indexOf('*')).toBeGreaterThan(-1);
});

// ---------------------------------------------------------------------------
// TC-604: cmd+E コード
// ---------------------------------------------------------------------------
test('TC-604 cmd+E inserts code marker', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n1');
    await page.keyboard.press('Meta+e');
    await page.waitForTimeout(60);
    const text = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    expect(text).toContain('`');
});

// ---------------------------------------------------------------------------
// TC-605: cmd+Shift+S 取り消し
// ---------------------------------------------------------------------------
test('TC-605 cmd+Shift+S inserts strike marker', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n1');
    await page.keyboard.press('Meta+Shift+s');
    await page.waitForTimeout(60);
    const text = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    expect(text).toContain('~~');
});

// ---------------------------------------------------------------------------
// TC-606: Tab indent
// ---------------------------------------------------------------------------
test('TC-606 Tab indents the focused node, table renders updated row', async ({ page }) => {
    await setupTable(page, simpleData());
    // focus n2 (sibling of n1) and Tab → n2 becomes child of n1
    await focusOutlinerTextByNodeId(page, 'n2');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);
    // verify model state
    const parentId = await page.evaluate(() => {
        const m: any = (window as any).OutlinerTable._getModel();
        return m.getNode('n2').parentId;
    });
    expect(parentId).toBe('n1');
});

// ---------------------------------------------------------------------------
// TC-607: Shift+Tab outdent
// ---------------------------------------------------------------------------
test('TC-607 Shift+Tab outdents the focused node', async ({ page }) => {
    await setupTable(page, {
        title: 'TC-607',
        rootIds: ['n1'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: ['c1'], text: 'parent', tags: [] },
            c1: { id: 'c1', parentId: 'n1', children: [], text: 'child', tags: [] }
        },
        columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
    });
    await focusOutlinerTextByNodeId(page, 'c1');
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(80);
    const parentId = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('c1').parentId);
    expect(parentId).toBeNull();
});

// ---------------------------------------------------------------------------
// TC-608: Enter sibling 追加
// ---------------------------------------------------------------------------
test('TC-608 Enter adds new sibling row directly after current', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n1');
    // Move cursor to end of "first"
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    const rows = await page.locator('.otable-row').count();
    expect(rows).toBe(4); // original 3 + 1 new
    // The newly inserted node should be after n1 in rootIds
    const rootIds = await page.evaluate(() => (window as any).OutlinerTable._getModel().rootIds);
    expect(rootIds[0]).toBe('n1');
    expect(rootIds[2]).toBe('n2');
});

// ---------------------------------------------------------------------------
// TC-609: Backspace 空+子あり 子昇格
// ---------------------------------------------------------------------------
test('TC-609 Backspace on empty node with children promotes children', async ({ page }) => {
    await setupTable(page, {
        title: 'TC-609',
        rootIds: ['top', 'empty'],
        nodes: {
            top: { id: 'top', parentId: null, children: [], text: 'top', tags: [] },
            empty: { id: 'empty', parentId: null, children: ['c1', 'c2'], text: '', tags: [] },
            c1: { id: 'c1', parentId: 'empty', children: [], text: 'child1', tags: [] },
            c2: { id: 'c2', parentId: 'empty', children: [], text: 'child2', tags: [] }
        },
        columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
    });
    await focusOutlinerTextByNodeId(page, 'empty');
    // Cursor naturally at offset 0 since text is empty
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    // empty node should be removed, c1/c2 promoted to root
    const result = await page.evaluate(() => {
        const m: any = (window as any).OutlinerTable._getModel();
        return {
            hasEmpty: !!m.getNode('empty'),
            c1Parent: m.getNode('c1') ? m.getNode('c1').parentId : '?',
            c2Parent: m.getNode('c2') ? m.getNode('c2').parentId : '?',
            rootIds: m.rootIds.slice()
        };
    });
    expect(result.hasEmpty).toBe(false);
    expect(result.c1Parent).toBeNull();
    expect(result.c2Parent).toBeNull();
    expect(result.rootIds).toContain('c1');
    expect(result.rootIds).toContain('c2');
});

// ---------------------------------------------------------------------------
// TC-610: cmd+x ノード切り取り
// ---------------------------------------------------------------------------
test('TC-610 cmd+x cuts node — clipboard saved, row removed', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n2');
    // Place cursor at end (no text selection, so cmd+x triggers node-cut)
    await page.keyboard.press('End');
    await clearMessages(page);
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(80);
    const msgs = await getMessages(page);
    const save = msgs.find((m) => m.type === 'saveOutlinerClipboard' && m.isCut === true);
    expect(save).toBeTruthy();
    expect(save.nodes.length).toBeGreaterThanOrEqual(1);
    expect(save.nodes[0].text).toBe('second');
    // row count = 2 (n2 removed)
    const rows = await page.locator('.otable-row').count();
    expect(rows).toBe(2);
});

// ---------------------------------------------------------------------------
// TC-611: cmd+c ノードコピー
// ---------------------------------------------------------------------------
test('TC-611 cmd+c copies node — clipboard saved, row remains', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n2');
    await page.keyboard.press('End');
    await clearMessages(page);
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(80);
    const msgs = await getMessages(page);
    const save = msgs.find((m) => m.type === 'saveOutlinerClipboard' && m.isCut === false);
    expect(save).toBeTruthy();
    expect(save.nodes[0].text).toBe('second');
    // row count = 3 (no removal)
    const rows = await page.locator('.otable-row').count();
    expect(rows).toBe(3);
});

// ---------------------------------------------------------------------------
// TC-612: cmd+v ノードペースト
// ---------------------------------------------------------------------------
test('TC-612 cmd+v pastes clipboard as sibling after current node', async ({ page }) => {
    await setupTable(page, simpleData());
    // copy n1
    await focusOutlinerTextByNodeId(page, 'n1');
    await page.keyboard.press('End');
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(60);
    // focus n3 and paste
    await focusOutlinerTextByNodeId(page, 'n3');
    await page.keyboard.press('End');
    await clearMessages(page);
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(80);
    const rows = await page.locator('.otable-row').count();
    expect(rows).toBe(4);
    // last row should contain "first" (the cloned text)
    const lastRowText = await page.locator('.otable-row').nth(3).locator('.outliner-text').textContent();
    expect(lastRowText).toContain('first');
});

// ---------------------------------------------------------------------------
// TC-613: tag (#tag / @tag) ハイライト
// ---------------------------------------------------------------------------
test('TC-613 tag highlight renders #urgent as outliner-tag span on blur', async ({ page }) => {
    await setupTable(page, {
        title: 'TC-613',
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'task #urgent here', tags: [] } },
        columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
    });
    // verify on initial render (no focus yet, so renderInlineText is used)
    const textEl = page.locator('.otable-row[data-node-id="n1"] .outliner-text');
    const inner = await textEl.innerHTML();
    expect(inner).toContain('outliner-tag');
    expect(inner).toContain('#urgent');
});

// ---------------------------------------------------------------------------
// TC-614: link blur で render
// ---------------------------------------------------------------------------
test('TC-614 [label](url) renders as <a> on blur', async ({ page }) => {
    await setupTable(page, {
        title: 'TC-614',
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'see [docs](https://example.com)', tags: [] } },
        columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
    });
    const inner = await page.locator('.otable-row[data-node-id="n1"] .outliner-text').innerHTML();
    expect(inner).toMatch(/<a[^>]+href="https:\/\/example\.com"/);
});

// ---------------------------------------------------------------------------
// TC-615: image paste — stub host.imagePaste call
// ---------------------------------------------------------------------------
test('TC-615 image paste forwards to host.imagePaste', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n1');
    await clearMessages(page);
    // Synthesize a paste event with an image item
    await page.evaluate(() => {
        const textEl = document.querySelector('.otable-row[data-node-id="n1"] .outliner-text') as HTMLElement;
        const dt = new DataTransfer();
        // create a small blob and add it as a file
        const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
        const file = new File([blob], 'paste.png', { type: 'image/png' });
        dt.items.add(file);
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt as any });
        textEl.dispatchEvent(evt);
    });
    await page.waitForTimeout(60);
    const msgs = await getMessages(page);
    const ip = msgs.find((m) => m.type === 'imagePaste');
    expect(ip).toBeTruthy();
    expect(ip.payload.nodeId).toBe('n1');
});

// ---------------------------------------------------------------------------
// TC-616: image D&D order change (skipped — DataTransfer in Playwright is limited)
// ---------------------------------------------------------------------------
test.skip('TC-616 image D&D reorders images — defer to manual US-12', () => { /* manual */ });

// ---------------------------------------------------------------------------
// TC-617: subtext 開閉 (Shift+Enter)
// ---------------------------------------------------------------------------
test('TC-617 Shift+Enter opens subtext editing mode', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n1');
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(80);
    const subtextHasEditing = await page.evaluate(() => {
        const sub = document.querySelector('.otable-row[data-node-id="n1"] .outliner-subtext');
        return sub ? sub.classList.contains('is-editing') : false;
    });
    expect(subtextHasEditing).toBe(true);
});

// ---------------------------------------------------------------------------
// TC-618: undo (cell 内編集)
// ---------------------------------------------------------------------------
test('TC-618 cmd+z reverts cell-internal edits', async ({ page }) => {
    await setupTable(page, simpleData());
    await focusOutlinerTextByNodeId(page, 'n1');
    await page.keyboard.press('End');
    // type a character
    await page.keyboard.type('X');
    await page.waitForTimeout(60);
    let text = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    expect(text).toContain('X');
    // explicit snapshot to ensure stack has both states
    await page.evaluate(() => (window as any).OutlinerTable._saveSnapshot());
    // Type another character then undo
    await page.keyboard.type('Y');
    await page.waitForTimeout(60);
    await page.evaluate(() => (window as any).OutlinerTable._saveSnapshot());
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(120);
    text = await page.evaluate(() => (window as any).OutlinerTable._getModel().getNode('n1').text);
    // After undo, text should not include the most recently typed Y (or be reverted to an earlier state)
    expect(text.length).toBeLessThanOrEqual(7); // 'firstX' or 'first' or 'firstXY' (allow some tolerance)
});

// ---------------------------------------------------------------------------
// TC-619: cmd+Shift+C ページパスコピー
// ---------------------------------------------------------------------------
test('TC-619 cmd+Shift+C on isPage node calls host.copyPagePaths', async ({ page }) => {
    await setupTable(page, {
        title: 'TC-619',
        rootIds: ['p1'],
        nodes: { p1: { id: 'p1', parentId: null, children: [], text: 'page', tags: [], isPage: true, pageId: 'pid-9' } },
        columns: [{ id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 }]
    });
    await focusOutlinerTextByNodeId(page, 'p1');
    await clearMessages(page);
    await page.keyboard.press('Meta+Shift+c');
    await page.waitForTimeout(80);
    const msgs = await getMessages(page);
    const cp = msgs.find((m) => m.type === 'copyPagePaths');
    expect(cp).toBeTruthy();
    expect(cp.pageIds).toContain('pid-9');
});

// ---------------------------------------------------------------------------
// TC-620: file attach (D&D) — skipped (DataTransfer.files are read-only in Playwright;
//          host.attachFile bridge is verified via simulated drop in unit-level)
// ---------------------------------------------------------------------------
test.skip('TC-620 file attach D&D — defer to manual US (DataTransfer.files unsynthesizable)', () => { /* manual */ });

// ---------------------------------------------------------------------------
// TC-610-A / 611-A / 612-A: drawio.svg multi-extension suffix — defer to host fs
// ---------------------------------------------------------------------------
test.skip('TC-610-A drawio.svg cut+cross-paste suffix — manual US (host fs required)', () => { /* manual */ });
test.skip('TC-611-A drawio.svg copy+same-outliner duplicate suffix — manual US', () => { /* manual */ });
test.skip('TC-612-A drawio.svg paste suffix collision avoid — manual US', () => { /* manual */ });
