/**
 * Outliner ⇄ Table view switch (TASK-B7)
 *
 * design: design/system.md §4.2.3 / §4.4 / §7 (Switch button layout)
 * testcases:
 *   - TC-401: Outliner editor Switch button posts requestReopenAs
 *   - TC-402: Switch button DOM placement (left of search input)
 *   - TC-403: Table editor Switch button posts requestReopenAs
 *   - TC-404: Switch button does not visually overlap with sibling header items
 */
import { test, expect, Page } from '@playwright/test';

async function setupOutliner(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).Outliner.init(d);
    }, data);
    await page.waitForTimeout(50);
}

async function setupTable(page: Page, data: any): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate((d) => {
        (window as any).__testApi.initOutlinerTable(d);
    }, data);
    await page.waitForTimeout(50);
}

// ---------------------------------------------------------------------------
// TC-401: Outliner Switch button posts requestReopenAs
// ---------------------------------------------------------------------------
test('TC-401 — Outliner Switch button posts requestReopenAs with fractal.outlinerTable', async ({ page }) => {
    await setupOutliner(page, {
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'hello', tags: [] } }
    });
    // verify the button exists
    const btn = page.locator('.outliner-switch-view-btn');
    await expect(btn).toHaveCount(1);
    // click it
    await btn.click();
    await page.waitForTimeout(50);
    const messages = await page.evaluate(() => (window as any).__testApi.messages);
    const reopen = messages.find((m: any) => m.type === 'requestReopenAs');
    expect(reopen).toBeTruthy();
    expect(reopen.viewType).toBe('fractal.outlinerTable');
});

// ---------------------------------------------------------------------------
// TC-402: Outliner Switch button is positioned left of the search input
// ---------------------------------------------------------------------------
test('TC-402 — Outliner Switch button is placed left of the search input', async ({ page }) => {
    await setupOutliner(page, {
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'hello', tags: [] } }
    });
    const order = await page.evaluate(() => {
        const bar = document.querySelector('.outliner-search-bar');
        if (!bar) { return null; }
        const switchBtn = bar.querySelector('.outliner-switch-view-btn');
        const wrapper = bar.querySelector('.outliner-search-input-wrapper');
        if (!switchBtn || !wrapper) { return null; }
        const children = Array.from(bar.children);
        return {
            switchIdx: children.indexOf(switchBtn as Element),
            wrapperIdx: children.indexOf(wrapper as Element)
        };
    });
    expect(order).not.toBeNull();
    expect(order!.switchIdx).toBeLessThan(order!.wrapperIdx);
});

// ---------------------------------------------------------------------------
// TC-403: Table Switch button posts requestReopenAs with fractal.outliner
// ---------------------------------------------------------------------------
test('TC-403 — Table Switch button posts requestReopenAs with fractal.outliner', async ({ page }) => {
    await setupTable(page, {
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'hello', tags: [] } }
    });
    const btn = page.locator('.otable-switch-view');
    await expect(btn).toHaveCount(1);
    // clear messages
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await btn.click();
    await page.waitForTimeout(50);
    const messages = await page.evaluate(() => (window as any).__testApi.messages);
    const reopen = messages.find((m: any) => m.type === 'requestReopenAs');
    expect(reopen).toBeTruthy();
    expect(reopen.viewType).toBe('fractal.outliner');
});

// ---------------------------------------------------------------------------
// TC-404: Switch button does not visually overlap sibling header items
// ---------------------------------------------------------------------------
test('TC-404 — Outliner Switch button does not overlap sibling header elements', async ({ page }) => {
    await setupOutliner(page, {
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'hello', tags: [] } }
    });
    const overlaps = await page.evaluate(() => {
        const bar = document.querySelector('.outliner-search-bar');
        if (!bar) { return null; }
        const btn = bar.querySelector('.outliner-switch-view-btn') as HTMLElement | null;
        if (!btn) { return null; }
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) { return 'zero-size'; }
        const others = Array.from(bar.children).filter((c) => c !== btn) as HTMLElement[];
        for (const o of others) {
            const r = o.getBoundingClientRect();
            // skip zero-size
            if (r.width === 0 || r.height === 0) { continue; }
            // overlap iff intersection non-empty
            const ix = Math.max(rect.left, r.left) < Math.min(rect.right, r.right);
            const iy = Math.max(rect.top, r.top) < Math.min(rect.bottom, r.bottom);
            if (ix && iy) { return o.className; }
        }
        return null;
    });
    // null = no overlap (success). Anything else identifies which element overlaps.
    expect(overlaps).toBeNull();
});
