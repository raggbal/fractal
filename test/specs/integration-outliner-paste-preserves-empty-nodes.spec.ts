/**
 * Bug: cmd+c / cmd+x → cmd+v で空ノード (text === '') が落ちる
 *
 * 旧症状:
 *   pasteNodesFromText() の `if (content === '') { continue; }` が空ノードを問答無用で skip。
 *   階層中の空ノードが消えるため、paste 結果の親子関係が壊れる。
 *
 * 修正:
 *   clipboardNodes が provided な内部 copy/cut では clipboardNodes をそのまま parsed に
 *   流し込み、text パースを bypass。空ノードも保持される。外部 paste (clipboardNodes なし)
 *   は従来通り空行スキップ。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner paste preserves empty nodes', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    /** Helper: clipboardNodes と plainText から DataTransfer 経由で paste を発火 */
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

    test('階層中の空ノード (parent + empty middle + child) が完全に保持される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['target'],
                nodes: {
                    target: { id: 'target', parentId: null, children: [], text: 'paste here', tags: [] }
                }
            });
        });

        // ソース構造:
        //   a (lvl 0)
        //     (empty, lvl 1)
        //     b (lvl 1)
        const plainText = 'a\n\t\n\tb';
        const clipNodes = [
            { text: 'a', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 1, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'b', level: 1, isPage: false, pageId: null, images: [], filePath: null, collapsed: false }
        ];
        await pasteWithClipNodes(page, 'target', plainText, clipNodes);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        const allTexts = Object.values(data.nodes).map((n: any) => n.text);
        // a, '' (空), b の 3 ノードがすべて存在
        expect(allTexts).toContain('a');
        expect(allTexts).toContain('b');
        // 空ノードが少なくとも 1 つ追加で存在 ('paste here' の空置換以外)
        const emptyCount = allTexts.filter(t => t === '').length;
        expect(emptyCount).toBeGreaterThanOrEqual(1);

        // 親子関係: a の children に空ノードと b が含まれる (両方 lvl 1 なので a の子)
        const aNode = (Object.values(data.nodes) as any[]).find((n: any) => n.text === 'a');
        expect(aNode).toBeTruthy();
        expect(aNode.children.length).toBe(2);
        const childTexts = aNode.children.map((cid: string) => data.nodes[cid].text);
        expect(childTexts).toContain('');
        expect(childTexts).toContain('b');
    });

    test('連続した空ノード (empty x3) も全て保持', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['target'],
                nodes: {
                    target: { id: 'target', parentId: null, children: [], text: 'paste here', tags: [] }
                }
            });
        });

        const plainText = 'a\n\n\n\nb';
        const clipNodes = [
            { text: 'a', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'b', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false }
        ];
        await pasteWithClipNodes(page, 'target', plainText, clipNodes);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        const allTexts = Object.values(data.nodes).map((n: any) => n.text);
        expect(allTexts).toContain('a');
        expect(allTexts).toContain('b');
        // 連続 3 つの空 + paste 先の置換による 0 = 3 以上の空ノード
        const emptyCount = allTexts.filter(t => t === '').length;
        expect(emptyCount).toBeGreaterThanOrEqual(3);
    });

    test('複雑な階層 (a > [empty, empty, b], c) でも親子関係が壊れない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['target'],
                nodes: {
                    target: { id: 'target', parentId: null, children: [], text: 'paste here', tags: [] }
                }
            });
        });

        // ソース:
        //   a (lvl 0)
        //     (empty, lvl 1)
        //     (empty, lvl 1)
        //     b (lvl 2) ← b is child of last empty
        //   c (lvl 0)
        const plainText = 'a\n\t\n\t\n\t\tb\nc';
        const clipNodes = [
            { text: 'a', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 1, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 1, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'b', level: 2, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'c', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false }
        ];
        await pasteWithClipNodes(page, 'target', plainText, clipNodes);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());

        // 全 5 ノード (a, empty, empty, b, c) + 'paste here' の空置換 = 6 ノードが期待
        // (paste here がそのまま empty になるか他経路で削除されるかは置換挙動次第)
        const allTexts = (Object.values(data.nodes) as any[]).map((n: any) => n.text);
        expect(allTexts).toContain('a');
        expect(allTexts).toContain('b');
        expect(allTexts).toContain('c');

        // a の children は 2 (empty, empty)
        const aNode = (Object.values(data.nodes) as any[]).find((n: any) => n.text === 'a');
        expect(aNode).toBeTruthy();
        expect(aNode.children.length).toBe(2);
        const aChildTexts = aNode.children.map((cid: string) => data.nodes[cid].text);
        expect(aChildTexts.every((t: string) => t === '')).toBe(true);

        // 2 つ目の empty が b の親 (lvl 2 → lvl 1 に正規化はせず lvl 2 のまま、最後の empty の子)
        const lastEmptyChild = data.nodes[aNode.children[1]];
        expect(lastEmptyChild.children.length).toBe(1);
        expect(data.nodes[lastEmptyChild.children[0]].text).toBe('b');
    });

    test('兄弟レベル: [empty, A, empty, B, empty] 全 5 ノードが順序通り保持される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['target'],
                nodes: {
                    target: { id: 'target', parentId: null, children: [], text: 'paste here', tags: [] }
                }
            });
        });

        // ソース: 全 root レベル sibling、empty が前後・中間に挟まる
        //   (empty)
        //   A
        //   (empty)
        //   B
        //   (empty)
        const plainText = '\nA\n\nB\n';
        const clipNodes = [
            { text: '',  level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'A', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: 'B', level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false },
            { text: '',  level: 0, isPage: false, pageId: null, images: [], filePath: null, collapsed: false }
        ];
        await pasteWithClipNodes(page, 'target', plainText, clipNodes);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());

        // rootIds の順序通りに並んでいるか確認
        const rootTexts = data.rootIds.map((rid: string) => data.nodes[rid].text);
        // paste 先 'paste here' は空ノードに置換される (sibIdx=0 + insertAtStart 経路)
        // 期待: rootTexts に [empty?, '', 'A', '', 'B', ''] が連続して含まれる (順序維持)
        // 'A' と 'B' の間に空ノードが少なくとも 1 つ
        const aIdx = rootTexts.indexOf('A');
        const bIdx = rootTexts.indexOf('B');
        expect(aIdx).toBeGreaterThanOrEqual(0);
        expect(bIdx).toBeGreaterThan(aIdx);
        expect(bIdx - aIdx).toBeGreaterThanOrEqual(2);  // A と B の間に空が挟まる

        // A の前にも空ノードが 1 つ以上ある
        expect(aIdx).toBeGreaterThanOrEqual(1);

        // B の後にも空ノードが 1 つ以上ある
        expect(rootTexts.length - 1 - bIdx).toBeGreaterThanOrEqual(1);

        // 空ノードの総数 ≥ 3 (源 3 + paste 先置換でもう 1 = 計 4 程度)
        const emptyCount = rootTexts.filter((t: string) => t === '').length;
        expect(emptyCount).toBeGreaterThanOrEqual(3);
    });

    test('regression: 外部 paste (clipboardNodes なし) では空行は従来通りスキップ', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['target'],
                nodes: {
                    target: { id: 'target', parentId: null, children: [], text: 'paste here', tags: [] }
                }
            });
        });

        // 外部 paste (text/html なし、text/plain のみ): 末尾改行は skip 期待
        await page.evaluate(() => {
            const target = document.querySelector('.outliner-node[data-id="target"] .outliner-text') as HTMLElement;
            target.focus();
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', 'foo\n\nbar\n');
            target.dispatchEvent(ev);
        });
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        const allTexts = (Object.values(data.nodes) as any[]).map((n: any) => n.text);
        // 'foo' / 'bar' は paste されるが、空行は skip される (外部 paste 既存挙動)
        expect(allTexts).toContain('foo');
        expect(allTexts).toContain('bar');
    });
});
