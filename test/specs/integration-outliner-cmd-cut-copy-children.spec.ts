/**
 * Outliner cut/copy + paste: 子ノードと折りたたみ状態の取り扱い
 *
 * Bug 1: 複数ノード選択 (or 1) で cmd+x した時、対象に子ノードがあれば
 *        子も含めて切り取る。cmd+v で子も合わせて貼り付ける。
 * Bug 2: 折りたたみ状態 (collapsed) でも cmd+x / cmd+c → cmd+v で全子孫を含む。
 *        貼り付け時は折りたたみ状態を維持。
 * Bug 4: cross-outliner cmd+c → cmd+v で 1 行しかコピーされない再現性なし症状の根本原因
 *        は Bug 1/2 と共通 (collapsed 子の取りこぼし) のため、Bug 1/2 の fix で解消する。
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner cut/copy + paste with children', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('Bug 1: 親 1 ノード選択 + 子 2 (展開状態) で cmd+x → 子も clipboard に入る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['p'],
                nodes: {
                    p:  { id: 'p',  parentId: null, children: ['c1', 'c2'], text: 'Parent', tags: [] },
                    c1: { id: 'c1', parentId: 'p',  children: [], text: 'Child 1', tags: [] },
                    c2: { id: 'c2', parentId: 'p',  children: [], text: 'Child 2', tags: [] }
                }
            });
        });

        // Parent ノードのみクリック → Cmd+A で全選択 (single-row visible 想定なら shift+click)
        // 確実に「親ノードのみ選択」状態を作るため、selectedNodeIds を直接操作
        await page.evaluate(() => {
            const o = (window as any).Outliner;
            o.testHooks ? o.testHooks.selectNode('p') : null;
            const treeEl = document.querySelector('.outliner-tree');
            // selectedNodeIds は private。代わりに Shift+Click で範囲選択する
        });

        // 親ノードを click → Shift+Down で 1 行選択
        const parentText = page.locator('.outliner-node[data-id="p"] .outliner-text');
        await parentText.click();
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowUp'); // 親 1 行のみ選択 (anchor=p, focus=p)
        await page.waitForTimeout(50);

        await page.keyboard.press('Meta+x');
        await page.waitForTimeout(200);

        const messages = await page.evaluate(() => (window as any).__testApi.messages);
        const saveClipMsg = messages.find((m: any) => m.type === 'saveOutlinerClipboard');
        expect(saveClipMsg).toBeTruthy();
        expect(saveClipMsg.isCut).toBe(true);
        // 親 + 子 2 = 3 ノード
        expect(saveClipMsg.nodes).toHaveLength(3);
        const texts = saveClipMsg.nodes.map((n: any) => n.text);
        expect(texts).toContain('Parent');
        expect(texts).toContain('Child 1');
        expect(texts).toContain('Child 2');
    });

    test('Bug 2: 親 (折りたたみ) で cmd+c → clipboard に全子孫が collapsed 状態付きで入る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['p'],
                nodes: {
                    p:  { id: 'p',  parentId: null, children: ['c1'], text: 'Folded Parent', tags: [], collapsed: true },
                    c1: { id: 'c1', parentId: 'p',  children: ['gc'], text: 'Hidden Child', tags: [] },
                    gc: { id: 'gc', parentId: 'c1', children: [], text: 'Hidden Grandchild', tags: [] }
                }
            });
        });

        // 折りたたみ状態確認
        const visibleNodes = await page.locator('.outliner-node:visible').count();
        expect(visibleNodes).toBe(1); // parent のみ表示

        const parentText = page.locator('.outliner-node[data-id="p"] .outliner-text');
        await parentText.click();
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowUp'); // 親 1 行のみ選択
        await page.waitForTimeout(50);

        await page.keyboard.press('Meta+c');
        await page.waitForTimeout(200);

        const messages = await page.evaluate(() => (window as any).__testApi.messages);
        const saveClipMsg = messages.find((m: any) => m.type === 'saveOutlinerClipboard');
        expect(saveClipMsg).toBeTruthy();
        expect(saveClipMsg.isCut).toBe(false);
        // 親 + 子 + 孫 = 3 ノード
        expect(saveClipMsg.nodes).toHaveLength(3);
        const parentNode = saveClipMsg.nodes.find((n: any) => n.text === 'Folded Parent');
        expect(parentNode.collapsed).toBe(true);
    });

    test('Bug 1/2: cmd+x で削除されたあと cmd+v で子孫まで復元される (full round-trip)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['p', 'sib'],
                nodes: {
                    p:   { id: 'p',   parentId: null, children: ['c1'], text: 'Parent', tags: [], collapsed: true },
                    c1:  { id: 'c1',  parentId: 'p',  children: [], text: 'Child', tags: [] },
                    sib: { id: 'sib', parentId: null, children: [], text: 'Sibling', tags: [] }
                }
            });
        });

        // Parent ノードを cmd+x (子も含めて切り取り)
        const parentText = page.locator('.outliner-node[data-id="p"] .outliner-text');
        await parentText.click();
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowUp');
        await page.waitForTimeout(50);
        await page.keyboard.press('Meta+x');
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        // ソース側からは parent + child が消えていることを確認
        const afterCutData = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        expect(afterCutData).toBeTruthy();
        // rootIds に sib のみ残る
        expect(afterCutData.rootIds).toEqual(['sib']);

        // Cmd+V のシミュレート: clipboardData に text/plain + text/html を渡す
        const htmlMeta = await page.evaluate(() => {
            const msgs = (window as any).__testApi.messages;
            const cm = msgs.find((m: any) => m.type === 'saveOutlinerClipboard');
            return JSON.stringify({
                nodes: cm.nodes,
                isCut: cm.isCut,
                plainText: cm.plainText
            });
        });
        const meta = JSON.parse(htmlMeta);
        const fakeHtml = '<ul data-outliner-clipboard="' + encodeURIComponent(JSON.stringify({
            nodes: meta.nodes, sourceOutFileKey: null, isCut: meta.isCut
        })) + '"><li>' + meta.nodes[0].text + '</li></ul>';

        // sib にフォーカスして paste
        const sibText = page.locator('.outliner-node[data-id="sib"] .outliner-text');
        await sibText.click();
        await page.waitForTimeout(50);
        await page.evaluate(({ plainText, html }) => {
            const targetEl = document.querySelector('.outliner-node[data-id="sib"] .outliner-text') as HTMLElement;
            targetEl.focus();
            const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            ev.clipboardData!.setData('text/plain', plainText);
            ev.clipboardData!.setData('text/html', html);
            targetEl.dispatchEvent(ev);
        }, { plainText: meta.plainText, html: fakeHtml });
        await page.waitForTimeout(300);
        await page.evaluate(() => (window as any).Outliner.flushSync());
        await page.waitForTimeout(50);

        // 貼り付け後: 子も含めて復元されているか
        const afterPasteData = await page.evaluate(() => (window as any).__testApi.getSerializedData());
        const allTexts = Object.values(afterPasteData.nodes).map((n: any) => n.text);
        expect(allTexts).toContain('Parent');
        expect(allTexts).toContain('Child');
        // collapsed 状態が復元されているか
        const restoredParent = (Object.values(afterPasteData.nodes) as any[]).find((n: any) => n.text === 'Parent');
        expect(restoredParent.collapsed).toBe(true);
    });

    test('複数ノード選択 + cmd+x: 各選択ノードの descendants が全部 clipboard に入る', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n1c'], text: 'N1', tags: [] },
                    n1c: { id: 'n1c', parentId: 'n1', children: [], text: 'N1 child', tags: [] },
                    n2: { id: 'n2', parentId: null, children: ['n2c'], text: 'N2', tags: [], collapsed: true },
                    n2c: { id: 'n2c', parentId: 'n2', children: [], text: 'N2 child (hidden)', tags: [] }
                }
            });
        });

        // Cmd+A で全選択
        const firstText = page.locator('.outliner-text').first();
        await firstText.click();
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(100);
        await page.keyboard.press('Meta+x');
        await page.waitForTimeout(200);

        const messages = await page.evaluate(() => (window as any).__testApi.messages);
        const saveClipMsg = messages.find((m: any) => m.type === 'saveOutlinerClipboard');
        expect(saveClipMsg).toBeTruthy();
        // N1 + N1 child + N2 + N2 child (hidden) = 4 ノード
        expect(saveClipMsg.nodes).toHaveLength(4);
        const texts = saveClipMsg.nodes.map((n: any) => n.text);
        expect(texts).toContain('N1');
        expect(texts).toContain('N1 child');
        expect(texts).toContain('N2');
        expect(texts).toContain('N2 child (hidden)');
    });
});
