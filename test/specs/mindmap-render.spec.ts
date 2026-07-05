/**
 * Mindmap Mode — モード切替 + SVG 描画 (Wave 1-2)
 * TC-130,131,132,133,150,151,152,155,157,158
 * sprint 20260701-122355-outliner-mindmap-mode
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

async function init(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => {
        (window as any).__testApi.initOutliner(d);
    }, data);
}

function sampleTree() {
    return {
        version: 1,
        rootIds: ['n1'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: ['n2', 'n3'], text: 'Root', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            n2: { id: 'n2', parentId: 'n1', children: [], text: 'Child A', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            n3: { id: 'n3', parentId: 'n1', children: [], text: 'Child B', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }
        }
    };
}

async function toMindmap(page: import('@playwright/test').Page) {
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(150);
}

test.describe('Mindmap Mode — toggle & render', () => {
    test('TC-130/131 setViewMode(mindmap) renders SVG with 4 layers', async ({ page }) => {
        await setup(page);
        await init(page, sampleTree());
        await toMindmap(page);

        // dataset.viewMode = mindmap
        const vm = await page.getAttribute('.outliner-tree', 'data-view-mode');
        expect(vm).toBe('mindmap');

        // SVG + 4 layers exist
        await expect(page.locator('.outliner-tree[data-view-mode="mindmap"] svg.mindmap-svg')).toHaveCount(1);
        await expect(page.locator('.mindmap-layer-groups')).toHaveCount(1);
        await expect(page.locator('.mindmap-layer-links')).toHaveCount(1);
        await expect(page.locator('.mindmap-layer-relationships')).toHaveCount(1);
        await expect(page.locator('.mindmap-layer-nodes')).toHaveCount(1);
    });

    test('TC-132 mode switch persists to serialized data', async ({ page }) => {
        await setup(page);
        await init(page, sampleTree());
        await toMindmap(page);
        // serialize immediately (no debounce wait): viewMode must be persisted by the model.
        // (getSerializedData() returns null until the 1000ms-debounced syncData fires.)
        const viewMode = await page.evaluate(() => (window as any).Outliner.getModel().serialize().viewMode);
        expect(viewMode).toBe('mindmap');
    });

    test('TC-133 init with viewMode:mindmap starts in mindmap', async ({ page }) => {
        await setup(page);
        const data = sampleTree();
        (data as any).viewMode = 'mindmap';
        await init(page, data);
        await page.waitForTimeout(150);
        const vm = await page.getAttribute('.outliner-tree', 'data-view-mode');
        expect(vm).toBe('mindmap');
    });

    test('TC-150/151 nodes rendered as foreignObject with text', async ({ page }) => {
        await setup(page);
        await init(page, sampleTree());
        await toMindmap(page);
        // 3 nodes
        await expect(page.locator('.mindmap-layer-nodes foreignObject.mindmap-node')).toHaveCount(3);
        // texts present
        const texts = await page.locator('.mindmap-node-text').allTextContents();
        expect(texts.join(' ')).toContain('Root');
        expect(texts.join(' ')).toContain('Child A');
    });

    test('TC-152 parent-child links rendered', async ({ page }) => {
        await setup(page);
        await init(page, sampleTree());
        await toMindmap(page);
        // 2 links (root->A, root->B)
        await expect(page.locator('.mindmap-layer-links path.mindmap-link')).toHaveCount(2);
    });

    test('TC-155 Page node shows icon', async ({ page }) => {
        await setup(page);
        const data = sampleTree();
        (data.nodes as any).n2.isPage = true;
        (data.nodes as any).n2.pageId = 'p-uuid-1';
        await init(page, data);
        await toMindmap(page);
        // the page node's box contains an icon span
        const iconCount = await page.locator('.mindmap-node[data-node-id="n2"] .mindmap-node-icon').count();
        expect(iconCount).toBeGreaterThanOrEqual(1);
    });

    test('TC-157 empty model shows placeholder', async ({ page }) => {
        // NOTE: initOutliner({rootIds:[]}) auto-creates a default root node (outliner UX),
        // so we render a genuinely empty model directly to exercise the empty branch.
        await setup(page);
        await init(page, sampleTree());
        await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const MR = (window as any).MindmapRender;
            const MM = (window as any).MindmapModel;
            MR.render({ rootIds: [], nodes: {} }, MM.defaultMindmapSettings(), tree,
                (window as any).outlinerHostBridge, {});
        });
        await expect(page.locator('.mindmap-empty')).toHaveCount(1);
    });

    test('TC-158 default node uses theme (no inline background)', async ({ page }) => {
        await setup(page);
        await init(page, sampleTree());
        await toMindmap(page);
        // node without mindmap.fill should not carry an inline background:...
        const style = await page.locator('.mindmap-node[data-node-id="n1"] .mindmap-node-box').getAttribute('style');
        expect(style || '').not.toMatch(/background:/);
    });

    test('TC-246 Table view still reachable (regression)', async ({ page }) => {
        await setup(page);
        await init(page, sampleTree());
        await page.evaluate(() => (window as any).Outliner.setViewMode('table'));
        await page.waitForTimeout(120);
        const vm = await page.getAttribute('.outliner-tree', 'data-view-mode');
        expect(vm).toBe('table');
    });

    test('TC-247 Outliner view unaffected (regression)', async ({ page }) => {
        await setup(page);
        await init(page, sampleTree());
        // default should render normal outliner nodes
        await expect(page.locator('.outliner-tree .outliner-node')).toHaveCount(3);
    });

    test('TC-157b empty-state "+ Add" button creates first node (FR-021-A4)', async ({ page }) => {
        // 空 model を mindmap で開き、+ Add ボタンで最初の root が作られることを検証。
        // (reviewer code_fix: 早期 return で attach を通らないため直接ハンドラを配線した)
        await setup(page);
        await init(page, sampleTree());
        await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            // 真に空の model にすげ替えて mindmap を描画
            const OM = (window as any).OutlinerModel;
            const emptyModel = new OM({ version: 1, rootIds: [], nodes: {}, viewMode: 'mindmap' });
            (window as any).__testApi.initOutliner(emptyModel.serialize());
            (window as any).Outliner.setViewMode('mindmap');
            void tree;
        });
        await page.waitForTimeout(80);
        // sampleTree init auto-created a root; force truly-empty by removing all then re-render
        // → 代わりに MindmapRender を空 model で直接描画して + Add の配線を検証
        const created = await page.evaluate(async () => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const model = (window as any).Outliner.getModel();
            // clear the model to empty
            model.rootIds.length = 0;
            Object.keys(model.nodes).forEach((k) => delete model.nodes[k]);
            (window as any).MindmapRender.render(model, model.mindmap, tree, (window as any).outlinerHostBridge, {
                addRootAndEdit: function () {
                    const n = model.addNode(null, null, '');
                    (window as any).__mmAdded = n.id;
                }
            });
            const btn = tree.querySelector('.mindmap-empty-add') as HTMLElement;
            const before = model.rootIds.length;
            btn.click();
            return { before, after: model.rootIds.length, addedId: (window as any).__mmAdded };
        });
        expect(created.before).toBe(0);
        expect(created.after).toBe(1);
        expect(created.addedId).toBeTruthy();
    });

    test('TC-150b node with icon + multiline text does not overflow its box (FR-021-A6)', async ({ page }) => {
        await setup(page);
        await init(page, {
            version: 1, viewMode: 'mindmap', rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: ['p'], text: 'Root', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                p: { id: 'p', parentId: 'n1', children: [], text: 'AWS-Black-Belt_2023_AmazonConnect-CustomCCP\nline2\nline3', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: '/x/file.pdf', tags: [] }
            }
        });
        await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
        await page.waitForTimeout(200); // allow 2-pass
        const fit = await page.evaluate(() => {
            const box = document.querySelector('.mindmap-node[data-node-id="p"] .mindmap-node-box') as HTMLElement;
            // text must not overflow horizontally, box must be tall enough for multiline
            return {
                noHOverflow: box.scrollWidth <= box.clientWidth + 2,
                noVOverflow: box.scrollHeight <= box.clientHeight + 2,
                hasIcon: !!box.querySelector('.mindmap-node-icon')
            };
        });
        expect(fit.hasIcon).toBe(true);       // 📎 icon present
        expect(fit.noHOverflow).toBe(true);   // text wraps, no horizontal overflow
        expect(fit.noVOverflow).toBe(true);   // box grew for multiline
    });

    test('TC-133b title center node renders with data-mm-title', async ({ page }) => {
        await setup(page);
        await init(page, {
            version: 1, viewMode: 'mindmap', title: 'My Map', rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'R1', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                n2: { id: 'n2', parentId: null, children: [], text: 'R2', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }
            }
        });
        await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
        await page.waitForTimeout(150);
        await expect(page.locator('.mindmap-node[data-mm-title="1"]')).toHaveCount(1);
        const titleText = await page.locator('.mindmap-node[data-mm-title="1"] .mindmap-node-text').textContent();
        expect(titleText).toBe('My Map');
    });
});
