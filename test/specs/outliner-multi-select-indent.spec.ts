import { test, expect } from '@playwright/test';

// Tab/Shift+Tabをプログラムで発火するヘルパー
async function pressTab(page: any, shiftKey = false) {
    await page.evaluate((shift: boolean) => {
        const focused = document.activeElement as HTMLElement;
        if (focused) {
            const event = new KeyboardEvent('keydown', {
                key: 'Tab', code: 'Tab', keyCode: 9,
                shiftKey: shift,
                bubbles: true, cancelable: true
            });
            focused.dispatchEvent(event);
        }
    }, shiftKey);
}


/**
 * init の自動フォーカスが「終わった」ことを待つ。
 *
 * outliner.js の init は `setTimeout(100)` で focusFirstVisibleNode() を呼ぶ（同ファイル :317 の
 * コメントが明言）。これを待たずにキー列を打つと、途中でフォーカスが先頭ノードへ奪われ、
 * Shift+↓ の選択アンカーが差し替わって Tab の結果が変わる。**本 spec の flake の真因はこれ**で、
 * 固定 sleep（50ms/200ms）はタイマーとの競走に勝つか負けるかを運任せにしていた
 * （待ちを長くすると必ず負けるため「sleep を伸ばす」では直らない）。
 */
async function waitInitFocus(page: any, firstRootId: string) {
    await page.waitForFunction(
        (id: string) => (document.activeElement as HTMLElement)?.dataset?.nodeId === id, firstRootId);
}

/** 指定 node にフォーカスを確定させる（確定を条件待ちする） */
async function focusNodeText(page: any, id: string) {
    await page.locator(`.outliner-text[data-node-id="${id}"]`).click();
    await page.waitForFunction(
        (n: string) => (document.activeElement as HTMLElement)?.dataset?.nodeId === n, id);
}

/** その node に is-selected が付くまで待つ */
async function waitSelected(page: any, id: string) {
    await page.waitForFunction(
        (n: string) => document.querySelector(`.outliner-node[data-id="${n}"]`)?.classList.contains('is-selected'), id);
}

/** フォーカスがその node へ移るまで待つ */
async function waitFocused(page: any, id: string) {
    await page.waitForFunction(
        (n: string) => (document.activeElement as HTMLElement)?.dataset?.nodeId === n, id);
}

/**
 * 直前の syncData を捨ててから操作し、**新しい** syncData の到着を待って返す。
 * sync は debounce（実測 ~1000ms）なので固定 1500ms 待ちは負荷で破れる。
 */
async function actAndGetSync(page: any, act: () => Promise<void>) {
    await page.evaluate(() => { (window as any).__testApi.lastSyncData = null; });
    await act();
    await page.waitForFunction(() => (window as any).__testApi.lastSyncData !== null, undefined, { timeout: 20000 });
    return await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
}

test.describe('Outliner multi-select indent/outdent', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('複数ノード選択+Tabで全ノードがインデントされる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'node2', tags: [] },
                    n3: { id: 'n3', parentId: null, children: [], text: 'node3', tags: [] }
                }
            });
        });

        await waitInitFocus(page, 'n1');
        await focusNodeText(page, 'n2');

        // Shift+↓ ×2（1 回目 = 自行のみ選択・移動なし / 2 回目 = 次行まで拡張 + フォーカス移動）
        await page.keyboard.press('Shift+ArrowDown');
        await waitSelected(page, 'n2');
        await page.keyboard.press('Shift+ArrowDown');
        await waitFocused(page, 'n3');

        const syncData = await actAndGetSync(page, () => page.keyboard.press('Tab'));

        expect(syncData).not.toBeNull();
        expect(syncData.rootIds).toHaveLength(1);
        expect(syncData.rootIds[0]).toBe('n1');
        const n1 = syncData.nodes['n1'];
        expect(n1.children).toContain('n2');
        expect(n1.children).toContain('n3');
    });

    test('複数ノード選択+Shift+Tabで全ノードがデインデントされる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n2', 'n3'], text: 'node1', tags: [] },
                    n2: { id: 'n2', parentId: 'n1', children: [], text: 'node2', tags: [] },
                    n3: { id: 'n3', parentId: 'n1', children: [], text: 'node3', tags: [] }
                }
            });
        });

        await waitInitFocus(page, 'n1');
        await focusNodeText(page, 'n2');

        await page.keyboard.press('Shift+ArrowDown');
        await waitSelected(page, 'n2');
        await page.keyboard.press('Shift+ArrowDown');
        await waitFocused(page, 'n3');

        const syncData = await actAndGetSync(page, () => page.keyboard.press('Shift+Tab'));

        expect(syncData).not.toBeNull();
        expect(syncData.rootIds).toHaveLength(3);
        expect(syncData.nodes['n2'].parentId).toBeNull();
        expect(syncData.nodes['n3'].parentId).toBeNull();
    });

    test('処理後も選択状態が維持される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'node2', tags: [] },
                    n3: { id: 'n3', parentId: null, children: [], text: 'node3', tags: [] }
                }
            });
        });

        await waitInitFocus(page, 'n1');
        await focusNodeText(page, 'n2');
        await page.locator('.outliner-text[data-node-id="n3"]').click({ modifiers: ['Shift'] });

        // 選択が 2 件以上になるまで待つ（固定 200ms 待ちの置換）
        await expect.poll(() => page.locator('.outliner-node.is-selected').count())
            .toBeGreaterThanOrEqual(2);

        await pressTab(page, false);
        // Tab の適用（モデル上で n2 が誰かの子になる）を待ってから選択維持を見る
        await page.waitForFunction(() =>
            (window as any).__testApi.getModel().getNode('n2')?.parentId !== null);

        const afterCount = await page.locator('.outliner-node.is-selected').count();
        expect(afterCount).toBeGreaterThanOrEqual(2);
    });

    test('複数ノード選択+Tab連続操作ができる', async ({ page }) => {
        // n0をルートに、n1,n2,n3を兄弟として初期化
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n0', 'n1', 'n2'],
                nodes: {
                    n0: { id: 'n0', parentId: null, children: [], text: 'root', tags: [] },
                    n1: { id: 'n1', parentId: null, children: [], text: 'child1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'child2', tags: [] }
                }
            });
        });

        await waitInitFocus(page, 'n0');
        await focusNodeText(page, 'n1');

        // n1, n2 を選択
        await page.keyboard.press('Shift+ArrowDown');
        await waitSelected(page, 'n1');
        await page.keyboard.press('Shift+ArrowDown');
        await waitFocused(page, 'n2');

        // 1回目のTab: n1,n2 がn0の子になる（適用をモデルで待つ）
        await page.keyboard.press('Tab');
        await page.waitForFunction(() =>
            (window as any).__testApi.getModel().getNode('n1')?.parentId === 'n0');

        // フォーカスがまだ存在し、連続操作可能かテスト
        const focusedAfterFirst = await page.evaluate(() => {
            return document.activeElement?.classList.contains('outliner-text');
        });
        expect(focusedAfterFirst).toBe(true);

        // 選択状態が維持されている
        const selectedAfterFirst = await page.locator('.outliner-node.is-selected').count();
        expect(selectedAfterFirst).toBeGreaterThanOrEqual(2);

        // 1回目のShift+Tab: n1,n2 がn0と同レベルに戻る
        const syncData = await actAndGetSync(page, () => page.keyboard.press('Shift+Tab'));
        expect(syncData).not.toBeNull();
        // n0, n1, n2 がルートレベルに戻っている
        expect(syncData.rootIds).toHaveLength(3);
    });

    test('単一ノード（選択なし）のTabは既存通り動作する', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'node2', tags: [] }
                }
            });
        });

        await waitInitFocus(page, 'n1');
        await focusNodeText(page, 'n2');

        // 直接textElにTabイベントを発火
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-text[data-node-id="n2"]');
            if (textEl) {
                textEl.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Tab', code: 'Tab', keyCode: 9, which: 9,
                    shiftKey: false, bubbles: true, cancelable: true
                }));
            }
        });
        // 適用（parentId が null から変わる）を待つ。値そのものは下で assert する
        await page.waitForFunction(() =>
            (window as any).__testApi.getModel().getNode('n2')?.parentId !== null);

        // Phase F flat mode: モデル上で n2 の parentId が n1 になっていることを確認
        const n2Parent = await page.evaluate(() => {
            const api = (window as any).__testApi;
            return api.getModel().getNode('n2')?.parentId || 'root';
        });

        expect(n2Parent).toBe('n1');
    });
});
