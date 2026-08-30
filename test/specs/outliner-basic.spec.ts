/**
 * Outliner 基本テスト
 * 初期化、ノード追加、編集、キー操作の基盤テスト
 *
 * 待ち方の規約（2026-08-29 TASK-22）:
 *   - init 後に操作する前に waitInitFocus() を挟む。outliner.js の init は `setTimeout(100)` で
 *     focusFirstVisibleNode() を呼ぶ（同ファイル :317 のコメントが明言）ため、待たずにクリック/
 *     キー操作すると **後からフォーカスを奪われて入力先が入れ替わる**（負荷時に顕在化する flake）。
 *   - 操作結果は `await expect(locator).toXxx()` / `expect.poll()` の retrying assertion で見る。
 *     `const x = await locator.count()` 形のスナップショットは render 前を見て落ちる。
 *   - 固定 `waitForTimeout` は使わない（負荷でタイミングが伸びると破れる）。
 */

import { test, expect } from '@playwright/test';

/** init の自動フォーカス（setTimeout(100) focusFirstVisibleNode）が着地するのを待つ */
async function waitInitFocus(page: any) {
    await page.waitForFunction(() =>
        (document.activeElement as HTMLElement)?.classList?.contains('outliner-text'));
}

/** 指定 node にフォーカスを確定させる */
async function focusNodeText(page: any, nth: number, expectId: string) {
    await page.locator('.outliner-node .outliner-text').nth(nth).click();
    await page.waitForFunction(
        (id: string) => (document.activeElement as HTMLElement)?.dataset?.nodeId === id, expectId);
}

const nodeParentId = (page: any, id: string) =>
    page.evaluate((n: string) => (window as any).__testApi.getModel().getNode(n).parentId, id);

test.describe('Outliner 基本テスト', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // --- 初期化 ---

    test('空データで初期化できる', async ({ page }) => {
        await expect(page.locator('.outliner-tree')).toBeVisible();
    });

    test('ノード付きデータで初期化できる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'ノード1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'ノード2', tags: [] }
                }
            });
        });

        await expect(page.locator('.outliner-node')).toHaveCount(2);
        await expect(page.locator('.outliner-node').first().locator('.outliner-text'))
            .toContainText('ノード1');
    });

    // --- ノード編集 ---

    test('ノードのテキストを編集して syncData が呼ばれる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'テスト', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        await focusNodeText(page, 0, 'n1');

        // 直前の sync を捨ててから入力し、**新しい** syncData の到着を待つ（固定 1500ms の置換。
        // sync は debounce 実測 ~1000ms なので負荷時に 1500ms では足りないことがある）
        await page.evaluate(() => { (window as any).__testApi.lastSyncData = null; });
        await page.keyboard.type('追加');
        await page.waitForFunction(() => (window as any).__testApi.lastSyncData !== null,
            undefined, { timeout: 20000 });

        const lastSync = await page.evaluate(() => (window as any).__testApi.lastSyncData);
        expect(lastSync).not.toBeNull();

        const data = JSON.parse(lastSync);
        expect(data.nodes.n1.text).toContain('追加');
    });

    // --- Enter でノード追加 ---

    test('Enter で新しいノードが追加される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'ノード1', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        await focusNodeText(page, 0, 'n1');

        // テキスト末尾にカーソルを移動してEnter
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');

        await expect(page.locator('.outliner-node')).toHaveCount(2);
    });

    // --- Backspace でノード削除 ---

    test('空ノードの先頭で Backspace → ノード削除', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'ノード1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: '', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        // 2番目の空ノードにフォーカス
        await focusNodeText(page, 1, 'n2');

        await page.keyboard.press('Backspace');

        await expect(page.locator('.outliner-node')).toHaveCount(1);
    });

    // --- Tab でインデント ---

    test('Tab でノードがインデントされる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'ノード1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'ノード2', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        // 2番目のノードにフォーカス
        await focusNodeText(page, 1, 'n2');

        await page.keyboard.press('Tab');

        // Phase F flat mode: n2 は data-depth=1 で indent される
        await expect(page.locator('.outliner-node[data-id="n2"]')).toHaveAttribute('data-depth', '1');
        await expect.poll(() => nodeParentId(page, 'n2')).toBe('n1');
    });

    // --- Shift+Tab でアウトデント ---

    test('Shift+Tab でノードがアウトデントされる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n2'], text: 'ノード1', tags: [] },
                    n2: { id: 'n2', parentId: 'n1', children: [], text: 'ノード2', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        // Phase F flat mode: n2 (depth=1) のテキストにフォーカス
        await focusNodeText(page, 1, 'n2');

        await page.keyboard.press('Shift+Tab');

        // n2 がトップレベルに戻っている (depth=0、parentId=null)
        await expect(page.locator('.outliner-node[data-id="n2"]')).toHaveAttribute('data-depth', '0');
        await expect.poll(() => nodeParentId(page, 'n2')).toBe(null);
        // Phase F flat mode: data-depth=0 の node が 2 つ並ぶ
        await expect(page.locator('.outliner-tree > .outliner-node[data-depth="0"]')).toHaveCount(2);
    });

    // --- 折りたたみ ---

    test('バレットクリックで子ノードが折りたたまれる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['n2'], text: '親ノード', tags: [], collapsed: false },
                    n2: { id: 'n2', parentId: 'n1', children: [], text: '子ノード', tags: [] }
                }
            });
        });

        // Phase F flat mode: 子ノードが flat に並ぶ (n1 + n2 が同階層)
        await expect(page.locator('.outliner-node[data-id="n2"]')).toHaveCount(1);
        await waitInitFocus(page);

        // バレットをクリック (n1 の bullet)
        await page.locator('.outliner-node[data-id="n1"] .outliner-bullet').first().click();

        // 折りたたみ後: n2 row が DOM から消える (flat mode は collapsed parent の子を描画しない)
        await expect(page.locator('.outliner-node[data-id="n2"]')).toHaveCount(0);
    });

    // --- タグ検出 ---

    test('テキスト内の #tag が検出される', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'タスク #TODO 完了', tags: ['#TODO'] }
                }
            });
        });

        // タグがハイライト表示されている（blur状態ではrenderInlineTextでタグspan生成）
        await expect.poll(() => page.locator('.outliner-tag').count()).toBeGreaterThanOrEqual(1);
    });

    // --- ↑↓ ナビゲーション ---

    test('↑↓ でノード間を移動できる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: '1行目', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: '2行目', tags: [] },
                    n3: { id: 'n3', parentId: null, children: [], text: '3行目', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        // 1行目にフォーカス
        await focusNodeText(page, 0, 'n1');

        // ↓ で2行目へ（n1 から n2 に移動しているはず）
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => page.evaluate(() => {
            const focused = document.querySelector('.outliner-node.is-focused');
            return focused ? focused.getAttribute('data-id') : null;
        })).toBe('n2');
    });

    // --- Undo/Redo ---

    test('Cmd+Z で undo できる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: '元テキスト', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        const textEl = page.locator('.outliner-node .outliner-text').first();
        await focusNodeText(page, 0, 'n1');
        await page.keyboard.press('End');
        await page.keyboard.type('追加');
        await expect(textEl).toContainText('追加');

        // Undo（このキーは Linux でも app 側 handler が metaKey||ctrlKey を見るため発火する。
        // ここを Control+z にするとブラウザ標準の undo と競合しうるので変更しない）
        await page.keyboard.press('Meta+z');

        await expect(textEl).not.toContainText('追加');
    });

    // --- 検索 ---

    test('検索でノードがフィルタされる', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'りんご', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'みかん', tags: [] },
                    n3: { id: 'n3', parentId: null, children: [], text: 'りんごジュース', tags: [] }
                }
            });
        });

        await waitInitFocus(page);
        // 検索バーに入力
        const searchInput = page.locator('.outliner-search-input');
        await searchInput.click();
        await searchInput.fill('りんご');

        // マッチしないノードが非表示（反映は非同期なので retrying assertion で待つ）
        await expect(page.locator('.outliner-node:not([style*="display: none"])')).toHaveCount(2);
    });
});
