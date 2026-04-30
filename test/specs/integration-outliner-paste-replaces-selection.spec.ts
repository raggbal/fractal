/**
 * Bug 3: ノード内テキスト範囲選択 + cmd+v で範囲選択を置換
 *
 * 旧症状: 範囲選択 + cmd+v が `<paste><selected>` のように concat されてしまう。
 * 修正後: 範囲選択を貼り付けテキストで置換する (ブラウザ標準の paste 挙動と一致)。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner: paste replaces text selection', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('ノード内全選択 + cmd+v でテキスト全置換', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'OriginalText', tags: [] }
                }
            });
        });

        // ノードクリックでフォーカス
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(50);

        // 範囲選択 + paste を 1 つの evaluate にまとめて、focus 等で selection が失われないようにする
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            el.focus();
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', 'NewText');
            el.dispatchEvent(ev);
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        const result = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        const node = result.nodes['n1'];
        // 旧バグ: 'NewTextOriginalText' or 'OriginalTextNewText' になっていた
        // 修正後: 'NewText' に置換
        expect(node.text).toBe('NewText');
    });

    test('ノード内一部選択 + cmd+v で選択部分のみ置換', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'AAA-BBB-CCC', tags: [] }
                }
            });
        });

        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(50);

        // 'BBB' (offset 4-7) を選択 + paste を 1 つの evaluate にまとめる
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            el.focus();
            const tn = el.firstChild as Text;
            const range = document.createRange();
            range.setStart(tn, 4);
            range.setEnd(tn, 7);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', 'XXX');
            el.dispatchEvent(ev);
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        const result = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        expect(result.nodes['n1'].text).toBe('AAA-XXX-CCC');
    });

    test('cursor のみ (collapsed selection) は従来通りカーソル位置に挿入', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Hello World', tags: [] }
                }
            });
        });

        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(50);

        // カーソル設定 + paste を 1 つの evaluate にまとめる
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            el.focus();
            const tn = el.firstChild as Text;
            const range = document.createRange();
            range.setStart(tn, 5);
            range.setEnd(tn, 5);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', '!');
            el.dispatchEvent(ev);
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        const result = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        // cursor 位置に挿入: 'Hello' + '!' + ' World'
        expect(result.nodes['n1'].text).toBe('Hello! World');
    });
});
