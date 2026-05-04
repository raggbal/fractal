/**
 * Phase F TASK-F1.2: flat DOM 描画パスの smoke test
 *
 * RENDER_MODE='flat' に切り替えて renderTree した時、各 node が
 * `.outliner-children` ネスト無しに、grid root の直接子として
 * flat に並ぶことを確認する。
 *
 * 機能 spec ではない (機能は F1.3/F1.4 で取り組む)。あくまで
 * 「flat mode が DOM 構造を返せる」段階の smoke 確認。
 */
import { test, expect } from '@playwright/test';

const STANDALONE_URL = 'http://localhost:3000/standalone-outliner.html';

test.describe('Phase F TASK-F1.2 — flat mode smoke', () => {
    test('hierarchical (default) で .outliner-children が出る', async ({ page }) => {
        await page.goto(STANDALONE_URL);
        await page.waitForSelector('.outliner-tree');

        // Sample data: 2 root nodes, 1 child
        await page.evaluate(() => {
            const initialData = {
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n1a'], text: 'Project A', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n1a: { id: 'n1a', parentId: 'n1', children: [], text: 'Subtask 1', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Project B', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] }
                }
            };
            (window as any).Outliner.init(initialData);
        });

        await page.waitForTimeout(100);
        const childrenWrapperCount = await page.locator('.outliner-children').count();
        expect(childrenWrapperCount).toBeGreaterThan(0);

        const nodeCount = await page.locator('.outliner-node').count();
        expect(nodeCount).toBe(3);
    });

    test('flat mode 切替後、.outliner-children が出ない', async ({ page }) => {
        await page.goto(STANDALONE_URL);
        await page.waitForSelector('.outliner-tree');

        await page.evaluate(() => {
            const initialData = {
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n1a'], text: 'Project A', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n1a: { id: 'n1a', parentId: 'n1', children: [], text: 'Subtask 1', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Project B', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] }
                }
            };
            (window as any).Outliner.init(initialData);
            (window as any).Outliner._setRenderMode('flat');
            // 再描画
            (window as any).Outliner.resetSearchAndScope();
        });

        await page.waitForTimeout(100);
        const childrenWrapperCount = await page.locator('.outliner-children').count();
        expect(childrenWrapperCount).toBe(0);

        // 全 node が flat に並ぶ
        const nodeCount = await page.locator('.outliner-node').count();
        expect(nodeCount).toBe(3);

        // depth 属性が正しい
        const depths = await page.$$eval('.outliner-node', (els) =>
            els.map((el) => el.getAttribute('data-depth'))
        );
        expect(depths).toEqual(['0', '1', '0']);
    });

    test('flat mode でも node の indent (data-depth + .outliner-node-indent) が表現される', async ({ page }) => {
        await page.goto(STANDALONE_URL);
        await page.waitForSelector('.outliner-tree');

        await page.evaluate(() => {
            const initialData = {
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n1a'], text: 'Parent', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n1a: { id: 'n1a', parentId: 'n1', children: ['n1aa'], text: 'Child', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n1aa: { id: 'n1aa', parentId: 'n1a', children: [], text: 'Grandchild', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] }
                }
            };
            (window as any).Outliner.init(initialData);
            (window as any).Outliner._setRenderMode('flat');
            (window as any).Outliner.resetSearchAndScope();
        });

        await page.waitForTimeout(100);

        // depth 0/1/2 の indent 幅が 0 / 24 / 48 px
        const indentWidths = await page.$$eval('.outliner-node .outliner-node-indent', (els) =>
            els.map((el) => (el as HTMLElement).style.width)
        );
        expect(indentWidths).toEqual(['0px', '24px', '48px']);
    });

    test('flat mode で collapsed parent の子は描画されない', async ({ page }) => {
        await page.goto(STANDALONE_URL);
        await page.waitForSelector('.outliner-tree');

        await page.evaluate(() => {
            const initialData = {
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n1a'], text: 'Parent', isPage: false, pageId: null, collapsed: true, checked: null, subtext: '', images: [] },
                    n1a: { id: 'n1a', parentId: 'n1', children: [], text: 'Hidden', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Visible', isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] }
                }
            };
            (window as any).Outliner.init(initialData);
            (window as any).Outliner._setRenderMode('flat');
            (window as any).Outliner.resetSearchAndScope();
        });

        await page.waitForTimeout(100);

        const nodeIds = await page.$$eval('.outliner-node', (els) =>
            els.map((el) => el.getAttribute('data-id'))
        );
        expect(nodeIds).toEqual(['n1', 'n2']);   // n1a は collapsed parent の子なので非表示
    });
});
