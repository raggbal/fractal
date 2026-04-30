/**
 * Bug 5: ノード内テキスト範囲選択 + Shift+Arrow で複数行選択モードに入る時、
 *        text Selection を解除する。
 *
 * 旧症状: text Selection が残ったまま cmd+c するとブラウザ標準が走り選択テキスト
 *         のみコピー → 複数ノードが clipboard に入らない。
 */

import { test, expect } from '@playwright/test';

test.describe('Bug 5: shift+arrow clears text selection', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('テキスト範囲選択中に Shift+ArrowDown で multi-row 選択 → text selection が解除される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'First node', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Second node', tags: [] }
                }
            });
        });

        // n1 にフォーカスしてテキスト範囲選択 + 確認を 1 つの evaluate にまとめる
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(50);

        const before = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            el.focus();
            const tn = el.firstChild as Text;
            const range = document.createRange();
            range.setStart(tn, 0);
            range.setEnd(tn, 5);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            return { collapsed: sel.isCollapsed, text: sel.toString() };
        });
        expect(before.collapsed).toBe(false);
        expect(before.text).toBe('First');

        // Shift+ArrowDown で multi-row 選択開始
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(150);

        // text selection が解除されているか
        const after = await page.evaluate(() => {
            const sel = window.getSelection();
            return { collapsed: sel?.isCollapsed, text: sel?.toString() };
        });
        // テキスト範囲は解除されている (collapsed === true or text === '')
        expect(after.text === '' || after.collapsed).toBe(true);
    });

    test('テキスト範囲選択 + Shift+ArrowDown + cmd+c で複数ノードがコピーされる (Bug 5 root)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Hello', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'World', tags: [] }
                }
            });
        });

        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(50);

        // 'Hello' を全選択
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            const tn = el.firstChild as Text;
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(50);

        // Shift+ArrowDown ×2 で n2 まで複数行選択
        // (1 回目: anchor 設定 + 自行のみ、2 回目: 拡張)
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(50);
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(100);

        // cmd+c
        await page.keyboard.press('Meta+c');
        await page.waitForTimeout(200);

        // saveOutlinerClipboard message が複数ノードを持っているか
        const messages = await page.evaluate(() => (window as any).__testApi.messages);
        const saveClipMsg = messages.find((m: any) => m.type === 'saveOutlinerClipboard');
        expect(saveClipMsg).toBeTruthy();
        // 'Hello' のテキストだけでなく n1 + n2 の 2 ノードが clipboard に入る
        expect(saveClipMsg.nodes.length).toBeGreaterThanOrEqual(2);
        const texts = saveClipMsg.nodes.map((n: any) => n.text);
        expect(texts).toContain('Hello');
        expect(texts).toContain('World');
    });
});
