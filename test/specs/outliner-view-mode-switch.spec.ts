/**
 * Switching files in one outliner webview (the Notes outliner: updateData) from a .out shown as a table or a mindmap
 * to a new outliner (made by NotesFileManager.createFile — no viewMode): the new one is a plain outliner. Before the
 * fix the table's grid (inline display:grid and its column widths on the tree) stayed, so the lines became grid cells
 * side by side and Enter added the next one to the right; the header's view toggle still showed the table's.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

function newOutData(): Record<string, unknown> {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-vms-')));
    try {
        const fm = new NotesFileManager(dir);
        fm.loadStructure();
        const outPath = fm.createFile('fresh');
        fm.dispose();
        return JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const SHOWN = (viewMode: 'table' | 'mindmap') => ({
    version: 1, title: 'Board', viewMode,
    columns: [
        { id: 'col_outliner', type: 'outliner', name: 'Outline', width: 360 },
        { id: 'col_status', type: 'text', name: 'Status', width: 140 },
    ],
    rootIds: ['a1', 'a2'],
    nodes: {
        a1: { id: 'a1', parentId: null, children: [], text: 'first', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null },
        a2: { id: 'a2', parentId: null, children: [], text: 'second', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null },
    },
});

async function open(page: Page, viewMode: 'table' | 'mindmap'): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((d) => (window as any).__testApi.initOutliner(d, 'board.out'), SHOWN(viewMode));
    await expect(page.locator('.outliner-tree')).toHaveAttribute('data-view-mode', viewMode);
}

for (const from of ['table', 'mindmap'] as const) {
    test(`TC-VMS-0${from === 'table' ? 1 : 2} ${from} → a new outliner (file switch): a plain outliner, lines one under another`, async ({ page }) => {
        await open(page, from);
        if (from === 'table') {
            expect(await page.$eval('.outliner-tree', (t) => (t as HTMLElement).style.display)).toBe('grid'); // the table's grid is on
        }
        await page.evaluate((d) => (window as any).__hostMessageHandler({ type: 'updateData', data: d, fileChangeId: 'vms-1', outFileKey: 'fresh.out' }), newOutData());
        const tree = page.locator('.outliner-tree');
        await expect(tree).toHaveAttribute('data-view-mode', 'outliner');
        expect(await tree.evaluate((t) => [(t as HTMLElement).style.display, (t as HTMLElement).style.gridTemplateColumns])).toEqual(['', '']);
        await expect(page.locator('.outliner-view-toggle-btn')).toHaveAttribute('title', 'Switch to Database Mode');
        await expect(page.locator('.outliner-view-toggle-btn .outliner-mode-label')).toHaveText('Outliner Mode');

        await page.locator('.outliner-node .outliner-text').first().click();
        await page.keyboard.type('one');
        await page.keyboard.press('Enter');
        await page.keyboard.type('two');
        const boxes = await page.$$eval('.outliner-node', (ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; }));
        expect(boxes).toHaveLength(2);
        expect(boxes[1].x).toBe(boxes[0].x); // under it, not beside it
        expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
        expect(boxes[0].w).toBeGreaterThan(600); // the full width, not one table column
    });
}

test('TC-VMS-03 the mode tag button: shows the current mode, one switch icon, a click goes Outliner → Database → Mindmap → Outliner', async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((d) => (window as any).__testApi.initOutliner(d, 'fresh.out'), newOutData());
    const btn = page.locator('.outliner-view-toggle-btn');
    await expect(btn).toHaveClass(/outliner-mode-pill/);
    const icons: string[] = [];
    for (const [mode, label, next] of [['outliner', 'Outliner Mode', 'Database Mode'], ['table', 'Database Mode', 'Mindmap Mode'], ['mindmap', 'Mindmap Mode', 'Outliner Mode'], ['outliner', 'Outliner Mode', 'Database Mode']] as const) {
        await expect(page.locator('.outliner-tree')).toHaveAttribute('data-view-mode', mode);
        await expect(btn.locator('.outliner-mode-label')).toHaveText(label);
        await expect(btn).toHaveAttribute('title', `Switch to ${next}`);
        icons.push(await btn.locator('svg').evaluate((e) => e.outerHTML));
        await btn.click();
    }
    expect(new Set(icons).size).toBe(1); // the same switch icon in every mode
});
