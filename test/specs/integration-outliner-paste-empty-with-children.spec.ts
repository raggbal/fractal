/**
 * Bug: 子供ノードを持つ空ノードに cmd+v すると、その空ノードが削除され
 *       子孫が cascade 削除される。
 *
 * 旧症状:
 *   handleNodePaste の `currentText === ''` ブランチで `model.removeNode(nodeId)` を
 *   呼んでいたが、removeNode は cascade 削除なので子孫が全部消える。
 *
 * 修正:
 *   `currentText === '' && !hasChildren` の時のみ removeNode 経路。
 *   子持ちの空ノードはテキストありノードと同じく「ノードの直後に sibling として挿入」する。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner: paste at empty-node-with-children behaves like non-empty', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    async function pasteWithClipNodes(page: any, targetNodeId: string, plainText: string, clipNodes: any[]) {
        const meta = JSON.stringify({ nodes: clipNodes, sourceOutFileKey: null, isCut: false });
        const html = '<ul data-outliner-clipboard="' + encodeURIComponent(meta) + '"><li></li></ul>';
        await page.evaluate(({ tid, plain, h }) => {
            const target = document.querySelector('.outliner-node[data-id="' + tid + '"] .outliner-text') as HTMLElement;
            target.focus();
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', plain);
            ev.clipboardData!.setData('text/html', h);
            target.dispatchEvent(ev);
        }, { tid: targetNodeId, plain: plainText, h: html });
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);
    }

    test('子持ち空ノードに paste → 空ノードと子孫が保持され、新規ノードは sibling として挿入', async ({ page }) => {
        // 初期構造:
        //   d (root)
        //   empty (root, has children)
        //     child1
        //       grandchild
        //         great-grandchild
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['d-root', 'empty'],
                nodes: {
                    'd-root':           { id: 'd-root',           parentId: null,                children: [],                       text: 'd', tags: [] },
                    'empty':            { id: 'empty',            parentId: null,                children: ['child1'],               text: '',  tags: [] },
                    'child1':           { id: 'child1',           parentId: 'empty',             children: ['grandchild'],           text: 'd', tags: [] },
                    'grandchild':       { id: 'grandchild',       parentId: 'child1',            children: ['great-grandchild'],     text: 'd', tags: [] },
                    'great-grandchild': { id: 'great-grandchild', parentId: 'grandchild',        children: [],                       text: 'd', tags: [] }
                }
            });
        });

        // paste するクリップボード内容: 2 ノード [X, Y]
        const plainText = 'X\nY';
        const clipNodes = [
            { text: 'X', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'Y', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false }
        ];

        // 子持ち empty ノードに paste
        await pasteWithClipNodes(page, 'empty', plainText, clipNodes);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());

        // 子孫が全て生き残っている
        const allTexts = (Object.values(data.nodes) as any[]).map((n: any) => n.text);
        const dCount = allTexts.filter((t: string) => t === 'd').length;
        expect(dCount).toBe(4); // d-root + child1 + grandchild + great-grandchild
        expect(allTexts).toContain('X');
        expect(allTexts).toContain('Y');

        // empty ノードがまだ存在し、children も保持
        const emptyNode = (Object.values(data.nodes) as any[]).find((n: any) => n.id === 'empty');
        expect(emptyNode).toBeTruthy();
        expect(emptyNode.children.length).toBe(1);
        expect(data.nodes[emptyNode.children[0]].text).toBe('d'); // child1

        // X / Y は empty の sibling (root レベル) に挿入される、empty の直後
        const rootTexts = data.rootIds.map((rid: string) => data.nodes[rid].text);
        // 期待 rootIds 順: d, '', X, Y
        const dIdx = rootTexts.indexOf('d');
        const emptyIdx = rootTexts.indexOf('');
        const xIdx = rootTexts.indexOf('X');
        const yIdx = rootTexts.indexOf('Y');
        expect(dIdx).toBe(0);
        expect(emptyIdx).toBe(1);
        expect(xIdx).toBe(2);
        expect(yIdx).toBe(3);
    });

    test('regression: 子なし空ノードに paste は従来通り「空ノードを置換」挙動 (sibling 末尾追加ではない)', async ({ page }) => {
        // 初期: [d, (empty leaf)]
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['d-root', 'empty-leaf'],
                nodes: {
                    'd-root':     { id: 'd-root',     parentId: null, children: [], text: 'd', tags: [] },
                    'empty-leaf': { id: 'empty-leaf', parentId: null, children: [], text: '',  tags: [] }
                }
            });
        });

        const plainText = 'X\nY';
        const clipNodes = [
            { text: 'X', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'Y', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false }
        ];
        await pasteWithClipNodes(page, 'empty-leaf', plainText, clipNodes);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        // empty-leaf は削除され (cascade 子なし)、X / Y が同じ位置に挿入される
        const emptyLeaf = (Object.values(data.nodes) as any[]).find((n: any) => n.id === 'empty-leaf');
        expect(emptyLeaf).toBeUndefined();

        const rootTexts = data.rootIds.map((rid: string) => data.nodes[rid].text);
        // 期待: [d, X, Y]
        expect(rootTexts).toEqual(['d', 'X', 'Y']);
    });
});
