/**
 * Outliner Table Editor — Text cell rich text (TASK-B3).
 *
 * TC-701〜TC-705
 *
 * design: design/system.md §4.3.2 (text cell)
 * testcases: TC-701〜TC-705
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

async function clearMessages(page: Page) {
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
}

async function getMessages(page: Page): Promise<any[]> {
    return await page.evaluate(() => (window as any).__testApi.messages);
}

const dataWithTextCol = () => ({
    title: 'TC-701',
    rootIds: ['n1', 'n2'],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [], columnValues: { col_text: 'plain' } },
        n2: { id: 'n2', parentId: null, children: [], text: 'second', tags: [], columnValues: {} }
    },
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
        { id: 'col_text', type: 'text', name: 'Status', order: 1 }
    ]
});

// ---------------------------------------------------------------------------
// TC-701: input + blur で markdown render
// ---------------------------------------------------------------------------
test('TC-701 text cell input → blur renders markdown (bold)', async ({ page }) => {
    await setupTable(page, dataWithTextCol());
    // text cell for n1
    const textEl = page.locator('.otable-row[data-node-id="n1"] .otable-cell-text .otable-text-content');
    await expect(textEl).toBeVisible();
    await textEl.click();
    await page.waitForTimeout(40);
    // type **bold**
    await page.keyboard.press('Control+a'); // select all (mac: cmd+a but we'll use both)
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('**bold**');
    await page.waitForTimeout(40);
    // blur by clicking elsewhere
    await page.locator('.otable-row[data-node-id="n2"] .outliner-text').click();
    await page.waitForTimeout(80);
    // verify rendered HTML
    const innerHtml = await page.evaluate(() => {
        const el = document.querySelector('.otable-row[data-node-id="n1"] .otable-cell-text .otable-text-content');
        return el ? el.innerHTML : '';
    });
    expect(innerHtml).toContain('<strong>');
    expect(innerHtml).toContain('bold');

    // verify model state
    const colVal = await page.evaluate(() => {
        const m: any = (window as any).OutlinerTable._getModel();
        return m.getNode('n1').columnValues['col_text'];
    });
    expect(colVal).toBe('**bold**');
});

// ---------------------------------------------------------------------------
// TC-702: cmd+B in text cell → bold marker
// ---------------------------------------------------------------------------
test('TC-702 cmd+B in text cell inserts bold marker', async ({ page }) => {
    await setupTable(page, dataWithTextCol());
    const textEl = page.locator('.otable-row[data-node-id="n1"] .otable-cell-text .otable-text-content');
    await textEl.click();
    await page.waitForTimeout(40);
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(60);
    const colVal = await page.evaluate(() => {
        const m: any = (window as any).OutlinerTable._getModel();
        return m.getNode('n1').columnValues['col_text'];
    });
    expect(colVal).toContain('**');
});

// ---------------------------------------------------------------------------
// TC-703: URL paste auto convert to [url](url)
// ---------------------------------------------------------------------------
test('TC-703 URL paste in text cell auto-converts to [url](url)', async ({ page }) => {
    await setupTable(page, dataWithTextCol());
    const textEl = page.locator('.otable-row[data-node-id="n2"] .otable-cell-text .otable-text-content');
    await textEl.click();
    await page.waitForTimeout(40);
    // Simulate paste with URL via clipboardData
    await page.evaluate(() => {
        const el = document.querySelector(
            '.otable-row[data-node-id="n2"] .otable-cell-text .otable-text-content'
        ) as HTMLElement;
        if (!el) { return; }
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', 'https://example.com');
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
    });
    await page.waitForTimeout(80);
    // blur to commit
    await page.locator('.otable-row[data-node-id="n1"] .outliner-text').click();
    await page.waitForTimeout(80);
    const colVal = await page.evaluate(() => {
        const m: any = (window as any).OutlinerTable._getModel();
        return m.getNode('n2').columnValues['col_text'];
    });
    expect(colVal).toBe('[https://example.com](https://example.com)');
});

// ---------------------------------------------------------------------------
// TC-704: tag (#urgent) ハイライト
// ---------------------------------------------------------------------------
test('TC-704 text cell with tag #urgent renders tag span on blur', async ({ page }) => {
    await setupTable(page, dataWithTextCol());
    const textEl = page.locator('.otable-row[data-node-id="n1"] .otable-cell-text .otable-text-content');
    await textEl.click();
    await page.waitForTimeout(40);
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('hello #urgent');
    await page.waitForTimeout(40);
    // blur
    await page.locator('.otable-row[data-node-id="n2"] .outliner-text').click();
    await page.waitForTimeout(80);
    const innerHtml = await page.evaluate(() => {
        const el = document.querySelector('.otable-row[data-node-id="n1"] .otable-cell-text .otable-text-content');
        return el ? el.innerHTML : '';
    });
    expect(innerHtml).toContain('outliner-tag');
    expect(innerHtml).toContain('#urgent');
});

// ---------------------------------------------------------------------------
// TC-705: text cell value persisted to host.syncData payload
// ---------------------------------------------------------------------------
test('TC-705 text cell edit syncs to host with columnValues[colId]', async ({ page }) => {
    await setupTable(page, dataWithTextCol());
    const textEl = page.locator('.otable-row[data-node-id="n2"] .otable-cell-text .otable-text-content');
    await textEl.click();
    await page.waitForTimeout(40);
    await clearMessages(page);
    await page.keyboard.type('done');
    await page.waitForTimeout(40);
    // blur to commit + flushSync
    await page.locator('.otable-row[data-node-id="n1"] .outliner-text').click();
    await page.waitForTimeout(120);
    await page.evaluate(() => (window as any).__testApi.flushSync());
    await page.waitForTimeout(80);
    const msgs = await getMessages(page);
    const sync = msgs.find((m) => m.type === 'syncData');
    expect(sync).toBeTruthy();
    const parsed = JSON.parse(sync.content);
    expect(parsed.nodes.n2.columnValues.col_text).toBe('done');
});
