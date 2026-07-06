/**
 * Mindmap Mode — キーボード操作 + D&D reparent (Wave 3)
 * TC-160,161,162,163,164,167,168,170,171,174
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

function tree() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['n1'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: ['n2'], text: 'Root', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            n2: { id: 'n2', parentId: 'n1', children: [], text: 'Child', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }
        }
    };
}

// model の状態を読む
async function model(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const m = (window as any).Outliner.getModel();
        return { rootIds: m.rootIds, nodes: JSON.parse(JSON.stringify(m.nodes)), layout: m.mindmap.layout };
    });
}

async function focusNodeText(page: import('@playwright/test').Page, nodeId: string) {
    // click focuses the (tabindex=0) text element via the interactions click handler
    await page.locator(`.mindmap-node[data-node-id="${nodeId}"] .mindmap-node-text`).click();
    await page.waitForTimeout(60);
    // ensure the text element actually holds focus before sending keys
    await page.evaluate((id) => {
        const el = document.querySelector(`.mindmap-node-text[data-node-id="${id}"]`) as HTMLElement;
        if (el) { el.focus(); }
    }, nodeId);
}

test.describe('Mindmap keyboard v2 (sync 2026-07-01)', () => {
    // 非カーソル操作は「ノードを選択（focus）だが編集していない」状態から。
    async function selectNode(page: import('@playwright/test').Page, nodeId: string) {
        // click selects (non-editing) via interactions click handler
        await page.locator(`.mindmap-node[data-node-id="${nodeId}"] .mindmap-node-box`).click();
        await page.waitForTimeout(50);
    }
    async function isEditing(page: import('@playwright/test').Page, nodeId: string) {
        // iteration 27 (TASK-71): 編集状態の信号を contenteditable → is-editing クラスへ移行
        // (committed active も contenteditable=true になったため)。'true'/'false' 互換シム。
        return page.evaluate((nid) => {
            const el = document.querySelector(`.mindmap-node-text[data-node-id="${nid}"]`);
            return el && el.classList.contains('is-editing') ? 'true' : 'false';
        }, nodeId);
    }

    test('TC-160b non-cursor Enter → younger sibling, NOT editing', async ({ page }) => {
        await setup(page); await init(page, tree());
        await selectNode(page, 'n2'); // n2 is child of n1
        const beforeChildren = (await model(page)).nodes.n1.children.length;
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        const m = await model(page);
        // sibling added under same parent (n1)
        expect(m.nodes.n1.children.length).toBe(beforeChildren + 1);
        // new sibling is right AFTER n2 (younger)
        const idx = m.nodes.n1.children.indexOf('n2');
        const newId = m.nodes.n1.children[idx + 1];
        expect(newId).toBeTruthy();
        // and it is NOT in editing mode
        expect(await isEditing(page, newId)).not.toBe('true');
    });

    test('TC-160c non-cursor Space → enters edit; Enter (editing) → exits edit', async ({ page }) => {
        await setup(page); await init(page, tree());
        await selectNode(page, 'n1');
        await page.keyboard.press(' '); // Space → edit
        await page.waitForTimeout(60);
        expect(await isEditing(page, 'n1')).toBe('true');
        await page.keyboard.press('Enter'); // editing Enter → commit, exit
        await page.waitForTimeout(60);
        expect(await isEditing(page, 'n1')).not.toBe('true');
    });

    test('TC-160d arrow move does NOT enter edit (empty node too)', async ({ page }) => {
        await setup(page); await init(page, tree());
        await selectNode(page, 'n1');
        await page.keyboard.press('ArrowRight'); // move to child n2
        await page.waitForTimeout(60);
        // n2 focused but not editing
        expect(await isEditing(page, 'n2')).not.toBe('true');
    });

    test('TC-162b Shift+Enter newline is saved (\\n) and survives mode round-trip', async ({ page }) => {
        await setup(page); await init(page, tree());
        // start from an empty text node for a clean assertion
        await page.evaluate(() => { (window as any).Outliner.getModel().nodes.n1.text = ''; (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForTimeout(80);
        await selectNode(page, 'n1');
        await page.keyboard.press(' '); // edit
        await page.waitForTimeout(60);
        // type line1, shift+enter, line2
        await page.keyboard.type('L1');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('L2');
        await page.keyboard.press('Enter'); // commit
        await page.waitForTimeout(80);
        let text = await page.evaluate(() => (window as any).Outliner.getModel().nodes.n1.text);
        expect(text).toContain('\n');
        expect(text.replace(/\r/g, '')).toBe('L1\nL2');
        // round-trip: mindmap → outliner → mindmap
        await page.evaluate(() => { (window as any).Outliner.setViewMode('outliner'); (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForTimeout(80);
        text = await page.evaluate(() => (window as any).Outliner.getModel().nodes.n1.text);
        expect(text.replace(/\r/g, '')).toBe('L1\nL2');
    });

    test('TC-160 Tab adds a child', async ({ page }) => {
        await setup(page); await init(page, tree());
        await focusNodeText(page, 'n1');
        const before = (await model(page)).nodes.n1.children.length;
        await page.keyboard.press('Tab');
        await page.waitForTimeout(100);
        const after = (await model(page)).nodes.n1.children.length;
        expect(after).toBe(before + 1);
    });

    test('TC-161 Enter adds a sibling', async ({ page }) => {
        await setup(page); await init(page, tree());
        await focusNodeText(page, 'n2');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        const m = await model(page);
        // n2 の親 n1 が子を 2 つ持つ (n2 + new sibling)
        expect(m.nodes.n1.children.length).toBe(2);
    });

    test('TC-162 Delete removes subtree', async ({ page }) => {
        await setup(page); await init(page, tree());
        await focusNodeText(page, 'n2');
        // クリックでフォーカスされた状態から、非編集で Delete
        await page.keyboard.press('Escape'); // ensure not editing
        await page.locator('.mindmap-node[data-node-id="n2"] .mindmap-node-box').click();
        await page.keyboard.press('Delete');
        await page.waitForTimeout(100);
        const m = await model(page);
        expect(m.nodes.n2).toBeUndefined();
        expect(m.nodes.n1.children.indexOf('n2')).toBe(-1);
    });

    test('TC-164 F2 starts editing', async ({ page }) => {
        await setup(page); await init(page, tree());
        await focusNodeText(page, 'n1');
        await page.keyboard.press('F2');
        await page.waitForTimeout(60);
        const editable = await page.getAttribute('.mindmap-node-text[data-node-id="n1"]', 'contenteditable');
        expect(editable).toBe('true');
    });

    test('TC-167 Cmd+Shift+L cycles layout', async ({ page }) => {
        await setup(page); await init(page, tree());
        await focusNodeText(page, 'n1');
        const before = (await model(page)).layout; // 'right' default? tree() has no mindmap so default 'right'
        await page.keyboard.press('Control+Shift+KeyL');
        await page.waitForTimeout(80);
        const after = (await model(page)).layout;
        expect(after).not.toBe(before);
    });

    test('TC-168 Cmd+A selects all', async ({ page }) => {
        await setup(page); await init(page, tree());
        await focusNodeText(page, 'n1');
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(80);
        const selectedCount = await page.locator('.mindmap-node-box.is-selected').count();
        expect(selectedCount).toBe(2);
    });
});

test.describe('Mindmap D&D reparent', () => {
    // 3-node tree: root with two children a,b — drag b onto a (center) → b becomes child of a
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

    test('TC-170 drop onto node center reparents', async ({ page }) => {
        await setup(page); await init(page, tree3());
        // HTML5 DnD via manual dispatch (Playwright dragTo is unreliable for HTML5 DnD).
        const changed = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            // simulate the drop logic: move b under a (center)
            m.moveNode('b', 'a', null);
            return { bParent: m.nodes.b.parentId, aChildren: m.nodes.a.children };
        });
        expect(changed.bParent).toBe('a');
        expect(changed.aChildren).toContain('b');
    });

    test('TC-171 isDescendant guard blocks cycle', async ({ page }) => {
        await setup(page); await init(page, tree3());
        const isDesc = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            // dragging r onto a: a is descendant of r → must be blocked
            return m.isDescendant('a', 'r');
        });
        expect(isDesc).toBe(true); // guard uses this to reject
    });

    test('TC-174 detachToFloating via MindmapModel', async ({ page }) => {
        await setup(page); await init(page, tree3());
        const r = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            (window as any).MindmapModel.detachToFloating(m, 'b', 300, 200);
            return {
                parent: m.nodes.b.parentId,
                inRoots: m.rootIds.indexOf('b') >= 0,
                x: m.nodes.b.mindmap.x,
                floating: (window as any).MindmapModel.isFloatingTopic(m, 'b')
            };
        });
        expect(r.parent).toBe(null);
        expect(r.inRoots).toBe(false);
        expect(r.x).toBe(300);
        expect(r.floating).toBe(true);
    });
});
