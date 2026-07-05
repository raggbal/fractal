/**
 * Mindmap Mode — no-data-loss + 4-mode regression (Wave 6, Hard MUST)
 * TC-240,242,243,244,245,246,247
 * sprint 20260701-122355-outliner-mindmap-mode
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

async function init(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.waitForTimeout(60);
}

function fullMindmapDoc() {
    return {
        version: 1,
        viewMode: 'mindmap',
        rootIds: ['n1'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: ['n2'], text: 'Root', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [], mindmap: { fill: '#f00', shape: 'capsule' } },
            n2: { id: 'n2', parentId: 'n1', children: [], text: 'Child', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }
        },
        mindmap: {
            layout: 'radial', linkStyle: 'elbow', linkColor: null, linkWidth: 3,
            siblingSpacing: 20, levelSpacing: 100,
            groups: [{ id: 'g1', nodeIds: ['n1', 'n2'], label: 'G', color: null }],
            relationships: [{ id: 'r1', fromNodeId: 'n1', toNodeId: 'n2', label: '', color: null }]
        }
    };
}

test.describe('Mindmap no-data-loss', () => {
    test('TC-240 Outliner Single: mindmap edit round-trips through serialize', async ({ page }) => {
        await setup(page); await init(page, fullMindmapDoc());
        await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
        await page.waitForTimeout(80);
        const out = await page.evaluate(() => (window as any).Outliner.getModel().serialize());
        expect(out.viewMode).toBe('mindmap');
        expect(out.mindmap.layout).toBe('radial');
        expect(out.mindmap.groups[0].id).toBe('g1');
        expect(out.mindmap.relationships[0].id).toBe('r1');
        expect(out.nodes.n1.mindmap.fill).toBe('#f00');
    });

    test('TC-243 idempotent round-trip (serialize JSON equality)', async ({ page }) => {
        await setup(page); await init(page, fullMindmapDoc());
        const eq = await page.evaluate(() => {
            const OM = (window as any).OutlinerModel;
            const input = (window as any).Outliner.getModel().serialize();
            const j1 = JSON.stringify(new OM(input).serialize());
            const j2 = JSON.stringify(new OM(JSON.parse(j1)).serialize());
            return j1 === j2;
        });
        expect(eq).toBe(true);
    });

    test('TC-244 old .out untouched (no mindmap fields sprout)', async ({ page }) => {
        await setup(page);
        await init(page, { version: 1, rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'plain', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } } });
        const out = await page.evaluate(() => (window as any).Outliner.getModel().serialize());
        expect('viewMode' in out).toBe(false);
        expect('mindmap' in out).toBe(false);
        expect('mindmap' in out.nodes.n1).toBe(false);
        expect(out.nodes.n1.text).toBe('plain');
    });

    test('TC-245 node delete only prunes refs (locality)', async ({ page }) => {
        await setup(page); await init(page, fullMindmapDoc());
        const r = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            m.removeNode('n2');
            (window as any).MindmapModel.cleanupDanglingRefs(m, m.mindmap);
            return {
                n1Alive: !!m.nodes.n1,
                n1FillIntact: m.nodes.n1.mindmap.fill,
                relCount: m.mindmap.relationships.length,
                groupNodeIds: m.mindmap.groups[0] ? m.mindmap.groups[0].nodeIds : null
            };
        });
        expect(r.n1Alive).toBe(true);         // other node intact
        expect(r.n1FillIntact).toBe('#f00');  // its data untouched
        expect(r.relCount).toBe(0);           // r1 (n1->n2) removed
        expect(r.groupNodeIds).toEqual(['n1']); // n2 pruned from group
    });
});

test.describe('Mindmap 4-mode coverage', () => {
    test('TC-246 Table view still works (regression)', async ({ page }) => {
        await setup(page); await init(page, fullMindmapDoc());
        await page.evaluate(() => (window as any).Outliner.setViewMode('table'));
        await page.waitForTimeout(80);
        expect(await page.getAttribute('.outliner-tree', 'data-view-mode')).toBe('table');
    });

    test('TC-247 Outliner view still works (regression)', async ({ page }) => {
        await setup(page); await init(page, fullMindmapDoc());
        await page.evaluate(() => (window as any).Outliner.setViewMode('outliner'));
        await page.waitForTimeout(80);
        expect(await page.getAttribute('.outliner-tree', 'data-view-mode')).toBe('outliner');
        // normal outliner nodes render
        await expect(page.locator('.outliner-tree .outliner-node')).toHaveCount(2);
    });

    test('TC-242 Markdown editor has no mindmap toggle (standalone editor)', async ({ page }) => {
        // Markdown editor は別 webview (standalone-editor.html)。mindmap トグルは存在しない。
        await page.goto('/standalone-editor.html');
        await page.waitForTimeout(200);
        // outliner の view-toggle 自体が Markdown editor には無い
        await expect(page.locator('.outliner-view-toggle-btn')).toHaveCount(0);
    });
});
