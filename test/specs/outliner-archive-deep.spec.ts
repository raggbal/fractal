/**
 * archive: 全階層から checked=true ノードを収集 (祖先 checked=true があればその子孫として吸収)
 * Notes mode 以外では host.archiveTasks 未定義のため archive 自体は走らないが、
 * target 収集ロジックを内部公開してテストする代わりに、楽観的削除の挙動から検証。
 */

import { test, expect } from '@playwright/test';

const HTML = '/standalone-outliner.html';

async function initOutliner(page, data: any) {
    await page.evaluate((d) => (window as any).__testApi.initOutliner(d), data);
    await page.waitForTimeout(200);
}

// host.archiveTasks をテストでスタブ
async function stubArchive(page) {
    await page.evaluate(() => {
        (window as any).__archivedSubtrees = [];
        (window as any).outlinerHostBridge.archiveTasks = function (subtrees) {
            (window as any).__archivedSubtrees = subtrees;
        };
    });
}

test.describe('archive 深さ対応', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(HTML);
        await page.waitForSelector('.outliner-tree');
        await stubArchive(page);
    });

    test('root が未チェック / 子が checked=true → 子のみ archive', async ({ page }) => {
        await initOutliner(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: ['n2'], text: 'parent', tags: [], checked: null },
                n2: { id: 'n2', parentId: 'n1', children: ['n3'], text: 'task', tags: [], checked: true },
                n3: { id: 'n3', parentId: 'n2', children: [], text: 'subtask', tags: [] },
            }
        });

        await page.evaluate(() => {
            var b = document.querySelector('.outliner-archive-btn') as HTMLElement;
            if (b) b.click();
        });
        await page.waitForTimeout(200);

        const arch = await page.evaluate(() => (window as any).__archivedSubtrees);
        expect(arch.length).toBe(1);
        expect(arch[0].rootId).toBe('n2');
        expect(Object.keys(arch[0].nodes).sort()).toEqual(['n2', 'n3']);

        const m = await page.evaluate(() => (window as any).__testApi.getModel());
        // n1 は残る、n2/n3 は削除済み
        expect(m.nodes.n1).toBeTruthy();
        expect(m.nodes.n1.children).not.toContain('n2');
        expect(m.nodes.n2).toBeUndefined();
        expect(m.nodes.n3).toBeUndefined();
    });

    test('祖先も checked=true なら、子は祖先の subtree として一緒に archive (個別 target にならない)', async ({ page }) => {
        await initOutliner(page, {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: ['n2'], text: 'root', tags: [], checked: true },
                n2: { id: 'n2', parentId: 'n1', children: [], text: 'inner', tags: [], checked: true },
            }
        });

        await page.evaluate(() => {
            var b = document.querySelector('.outliner-archive-btn') as HTMLElement;
            if (b) b.click();
        });
        await page.waitForTimeout(200);

        const arch = await page.evaluate(() => (window as any).__archivedSubtrees);
        // target は n1 のみ。n2 は subtree に含まれる
        expect(arch.length).toBe(1);
        expect(arch[0].rootId).toBe('n1');
        expect(Object.keys(arch[0].nodes).sort()).toEqual(['n1', 'n2']);
    });

    test('root checked + 別 branch の子 checked → 両方 target', async ({ page }) => {
        await initOutliner(page, {
            version: 1,
            rootIds: ['n1', 'n3'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'rootA', tags: [], checked: true },
                n3: { id: 'n3', parentId: null, children: ['n4'], text: 'rootB', tags: [] },
                n4: { id: 'n4', parentId: 'n3', children: [], text: 'leafChecked', tags: [], checked: true },
            }
        });

        await page.evaluate(() => {
            var b = document.querySelector('.outliner-archive-btn') as HTMLElement;
            if (b) b.click();
        });
        await page.waitForTimeout(200);

        const arch = await page.evaluate(() => (window as any).__archivedSubtrees);
        expect(arch.length).toBe(2);
        const rootIds = arch.map(s => s.rootId).sort();
        expect(rootIds).toEqual(['n1', 'n4']);
    });
});
