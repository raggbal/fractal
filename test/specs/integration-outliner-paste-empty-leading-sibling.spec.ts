/**
 * Bug 6: 兄弟ノードの先頭が空ノードの場合、その空ノードに cmd+v すると、
 *        本来は空ノード位置で置換されるべきなのに、parent.children の末尾に
 *        貼り付けが飛んでしまう症状。
 *
 * 例:
 *   貼り付け前: a の children = [<empty>, b, c]
 *               貼り付けデータ = e + f (複数行)
 *   旧症状  : a の children = [b, c, e, f]
 *   修正後  : a の children = [e, f, b, c]
 */

import { test, expect } from '@playwright/test';

test.describe('Bug 6: empty leading sibling paste position', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('先頭が空 sibling で複数行 paste → 空ノード位置 (children 先頭) に挿入される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['a'],
                nodes: {
                    a:     { id: 'a',     parentId: null, children: ['empty', 'b', 'c'], text: 'a', tags: [] },
                    empty: { id: 'empty', parentId: 'a',  children: [], text: '', tags: [] },
                    b:     { id: 'b',     parentId: 'a',  children: [], text: 'b', tags: [] },
                    c:     { id: 'c',     parentId: 'a',  children: [], text: 'c', tags: [] }
                }
            });
        });

        // empty にフォーカス
        const emptyText = page.locator('.outliner-node[data-id="empty"] .outliner-text');
        await emptyText.click();
        await page.waitForTimeout(50);

        // 複数行 paste
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="empty"] .outliner-text') as HTMLElement;
            el.focus();
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', 'e\nf');
            el.dispatchEvent(ev);
        });
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        // a の children を順に取って text を取得
        const aChildren = data.nodes['a'].children;
        const texts = aChildren.map((id: string) => data.nodes[id].text);
        // 期待: ['e', 'f', 'b', 'c'] (空ノード削除 + e/f が先頭、b/c が後続)
        // 旧バグ: ['b', 'c', 'e', 'f']
        expect(texts).toEqual(['e', 'f', 'b', 'c']);
    });

    test('regression: 先頭が空 sibling 以外 (b と c の間) で paste は従来通り afterId 経路', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['a'],
                nodes: {
                    a:     { id: 'a',     parentId: null, children: ['b', 'empty', 'c'], text: 'a', tags: [] },
                    b:     { id: 'b',     parentId: 'a',  children: [], text: 'b', tags: [] },
                    empty: { id: 'empty', parentId: 'a',  children: [], text: '', tags: [] },
                    c:     { id: 'c',     parentId: 'a',  children: [], text: 'c', tags: [] }
                }
            });
        });

        const emptyText = page.locator('.outliner-node[data-id="empty"] .outliner-text');
        await emptyText.click();
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="empty"] .outliner-text') as HTMLElement;
            el.focus();
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', 'e\nf');
            el.dispatchEvent(ev);
        });
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        const aChildren = data.nodes['a'].children;
        const texts = aChildren.map((id: string) => data.nodes[id].text);
        // 期待: ['b', 'e', 'f', 'c'] (b の直後に e/f 挿入、empty は削除)
        expect(texts).toEqual(['b', 'e', 'f', 'c']);
    });

    test('regression: 末尾が空 sibling で paste は従来通り afterId 経路 (children 末尾に挿入)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['a'],
                nodes: {
                    a:     { id: 'a',     parentId: null, children: ['b', 'c', 'empty'], text: 'a', tags: [] },
                    b:     { id: 'b',     parentId: 'a',  children: [], text: 'b', tags: [] },
                    c:     { id: 'c',     parentId: 'a',  children: [], text: 'c', tags: [] },
                    empty: { id: 'empty', parentId: 'a',  children: [], text: '', tags: [] }
                }
            });
        });

        const emptyText = page.locator('.outliner-node[data-id="empty"] .outliner-text');
        await emptyText.click();
        await page.waitForTimeout(50);

        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="empty"] .outliner-text') as HTMLElement;
            el.focus();
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', 'e\nf');
            el.dispatchEvent(ev);
        });
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        const aChildren = data.nodes['a'].children;
        const texts = aChildren.map((id: string) => data.nodes[id].text);
        // 期待: ['b', 'c', 'e', 'f'] (c の直後に e/f 挿入)
        expect(texts).toEqual(['b', 'c', 'e', 'f']);
    });
});
