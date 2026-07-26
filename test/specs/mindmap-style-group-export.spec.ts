/**
 * Mindmap Mode — style / group / relationship / zoom / export (Wave 4-5)
 * TC-180,182,183,190,192,200,210,213,220,221,223,224,225
 * sprint 20260701-122355-outliner-mindmap-mode
 */

import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

async function init(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(120);
}

function tree3() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: {
            r: { id: 'r', parentId: null, children: ['a', 'b'], text: 'R', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            a: { id: 'a', parentId: 'r', children: [], text: 'A', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            b: { id: 'b', parentId: 'r', children: [], text: 'B', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }
        }
    };
}

async function mm(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const m = (window as any).Outliner.getModel();
        return { settings: JSON.parse(JSON.stringify(m.mindmap)), nodes: JSON.parse(JSON.stringify(m.nodes)) };
    });
}

test.describe('Mindmap style (via model API)', () => {
    // スタイル/グループ/関連線の "適用" ロジックは context-menu 経由。
    // ここでは適用結果 (model 状態 + 描画) を検証する。UI クリックは代表 1 経路を別途。

    test('TC-180 node fill persists to node.mindmap.fill and renders', async ({ page }) => {
        await setup(page); await init(page, tree3());
        await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            (window as any).MindmapModel.ensureNodeMindmap(m.nodes.a).fill = '#00ff00';
            (window as any).Outliner.getModel(); // no-op
        });
        // rerender by toggling mode
        await page.evaluate(() => { (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForTimeout(100);
        const style = await page.getAttribute('.mindmap-node[data-node-id="a"] .mindmap-node-box', 'style');
        expect(style || '').toContain('#00ff00');
    });

    test('TC-182 shape capsule → large border-radius', async ({ page }) => {
        await setup(page); await init(page, tree3());
        await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            (window as any).MindmapModel.ensureNodeMindmap(m.nodes.a).shape = 'capsule';
            (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap');
        });
        await page.waitForTimeout(100);
        const radius = await page.evaluate(() => {
            const el = document.querySelector('.mindmap-node[data-node-id="a"] .mindmap-node-box') as HTMLElement;
            return getComputedStyle(el).borderRadius;
        });
        expect(radius).toMatch(/999|9999|50%|[0-9]{3,}px/);
    });

    test('TC-183 linkStyle change re-renders links', async ({ page }) => {
        await setup(page); await init(page, tree3());
        await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            m.mindmap.linkStyle = 'straight';
            (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap');
        });
        await page.waitForTimeout(100);
        const d = await page.getAttribute('.mindmap-layer-links path.mindmap-link', 'd');
        // straight: contains L, not C
        expect(d).toMatch(/L/);
        expect(d || '').not.toMatch(/C/);
    });
});

test.describe('Mindmap group & relationship', () => {
    test('TC-190/192 create group renders boundary; TC-200 relationship renders', async ({ page }) => {
        await setup(page); await init(page, tree3());
        await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            (window as any).MindmapModel.createGroup(m.mindmap, ['a', 'b'], 'Ideas', '#ff8800');
            (window as any).MindmapModel.createRelationship(m.mindmap, 'a', 'b', 'rel', null);
            (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap');
        });
        await page.waitForTimeout(100);
        await expect(page.locator('.mindmap-group')).toHaveCount(1);
        await expect(page.locator('.mindmap-relationship')).toHaveCount(1);
        // TC-195/205 cleanup: delete node a → group prunes, relationship removed
        const after = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            m.removeNode('a');
            (window as any).MindmapModel.cleanupDanglingRefs(m, m.mindmap);
            return { relCount: m.mindmap.relationships.length, groupNodeIds: m.mindmap.groups[0] ? m.mindmap.groups[0].nodeIds : [] };
        });
        expect(after.relCount).toBe(0);          // a→b removed (a gone)
        expect(after.groupNodeIds).toEqual(['b']); // a pruned, b kept
    });

    // sync 2026-07-01: グループ子孫包含 + クリック選択 + 削除
    function treeWithSubtree() {
        return {
            version: 1, viewMode: 'mindmap', rootIds: ['r'],
            nodes: {
                r: { id: 'r', parentId: null, children: ['a', 'x'], text: 'R', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                a: { id: 'a', parentId: 'r', children: ['a1', 'a2'], text: 'A', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                a1: { id: 'a1', parentId: 'a', children: [], text: 'A1', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                a2: { id: 'a2', parentId: 'a', children: [], text: 'A2', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
                x: { id: 'x', parentId: 'r', children: [], text: 'X', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }
            }
        };
    }

    test('TC-191b group boundary encloses selected node AND its descendants', async ({ page }) => {
        await setup(page); await init(page, treeWithSubtree());
        // group with only 'a' (nodeIds=['a']) — must enclose a, a1, a2
        await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            (window as any).MindmapModel.createGroup(m.mindmap, ['a'], '', null);
            (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap');
        });
        await page.waitForTimeout(120);
        // saved nodeIds = only the selected top
        const nodeIds = await page.evaluate(() => (window as any).Outliner.getModel().mindmap.groups[0].nodeIds);
        expect(nodeIds).toEqual(['a']);
        // boundary rect encloses a, a1, a2 positions
        const encloses = await page.evaluate(() => {
            const rect = document.querySelector('.mindmap-group-rect') as SVGGraphicsElement;
            const rb = rect.getBBox();
            function boxOf(id: string) {
                const fo = document.querySelector(`.mindmap-node[data-node-id="${id}"]`) as SVGGraphicsElement;
                return fo.getBBox();
            }
            function inside(id: string) {
                const b = boxOf(id);
                return b.x >= rb.x - 1 && b.y >= rb.y - 1 && (b.x + b.width) <= (rb.x + rb.width) + 1 && (b.y + b.height) <= (rb.y + rb.height) + 1;
            }
            return { a: inside('a'), a1: inside('a1'), a2: inside('a2') };
        });
        expect(encloses.a).toBe(true);
        expect(encloses.a1).toBe(true);
        expect(encloses.a2).toBe(true);
    });

    test('TC-192b group click selects group + members; TC-194b Delete removes group only', async ({ page }) => {
        await setup(page); await init(page, treeWithSubtree());
        await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            (window as any).MindmapModel.createGroup(m.mindmap, ['a'], '', null);
            (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap');
        });
        await page.waitForTimeout(120);
        // click the group rect
        await page.locator('.mindmap-group-rect').click();
        await page.waitForTimeout(80);
        // group gets .is-selected
        await expect(page.locator('.mindmap-group.is-selected')).toHaveCount(1);
        // members (a + descendants a1,a2) selected
        const selCount = await page.locator('.mindmap-node-box.is-selected').count();
        expect(selCount).toBeGreaterThanOrEqual(3);
        // Delete → group removed, nodes remain
        await page.locator('.mindmap-group-rect').click();
        await page.waitForTimeout(50);
        await page.keyboard.press('Delete');
        await page.waitForTimeout(100);
        const res = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            return { groups: m.mindmap.groups.length, aAlive: !!m.nodes.a, a1Alive: !!m.nodes.a1 };
        });
        expect(res.groups).toBe(0);      // group removed
        expect(res.aAlive).toBe(true);   // member node remains
        expect(res.a1Alive).toBe(true);  // descendant remains
    });
});

test.describe('Mindmap zoom & export', () => {
    test('TC-210 zoom-in changes viewport transform', async ({ page }) => {
        await setup(page); await init(page, tree3());
        const before = await page.getAttribute('.mindmap-viewport', 'style');
        await page.locator('.mindmap-tb-btn[data-mm-action="zoom-in"]').click();
        await page.waitForTimeout(60);
        const after = await page.getAttribute('.mindmap-viewport', 'style');
        expect(after).not.toBe(before);
        expect(after || '').toMatch(/scale\(/);
    });

    test('TC-220 toOpml pure (via MindmapExport)', async ({ page }) => {
        await setup(page); await init(page, tree3());
        const opml = await page.evaluate(() => (window as any).MindmapExport.toOpml((window as any).Outliner.getModel()));
        expect(opml).toContain('<opml');
        expect(opml).toContain('text="R"');
        expect(opml).toContain('text="A"');
    });

    test('TC-221 toMarkdown pure', async ({ page }) => {
        await setup(page); await init(page, tree3());
        const md = await page.evaluate(() => (window as any).MindmapExport.toMarkdown((window as any).Outliner.getModel()));
        expect(md).toContain('R');
        expect(md).toMatch(/[-#]\s*A/);
    });

    // [H] iteration 29 / TASK-74 (test_update): PNG/SVG/OPML/MD エクスポートボタンは
    // ツールバーから削除した (まだ不要)。→ ボタンが存在しないことを検証する
    // (doExport ハンドラ自体は将来復活用に残置しているが UI からは出さない)。
    test('TC-223/224/225改 export ボタンはツールバーに存在しない (iter29 で削除)', async ({ page }) => {
        await setup(page); await init(page, tree3());
        const exportBtnCount = await page.locator('.mindmap-tb-btn[data-mm-action="export"]').count();
        expect(exportBtnCount).toBe(0);
        // zoom/fit/layout の主要ツールバー機能は残っている。
        expect(await page.locator('.mindmap-tb-btn[data-mm-action="zoom-in"]').count()).toBe(1);
        expect(await page.locator('.mindmap-tb-btn[data-mm-action="fit"]').count()).toBe(1);
        expect(await page.locator('.mindmap-tb-layout[data-mm-action="layout"]').count()).toBe(1);
    });
});
