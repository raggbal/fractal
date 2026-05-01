/**
 * (1) 検索ボックスを undo/redo 対象から外す
 *     - 検索ボックスフォーカス + cmd+z で input 要素 native undo を抑制 (preventDefault)
 *     - cmd+z は no-op (state 戻しは Back/Forward ボタン経由のみ)
 *
 * (2) outliner Back/Forward ショートカット (Opt+Left / Opt+Right)
 *     - sidepanel md フォーカス時は editor.js の handler に委譲 (collide しない)
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner: search box not in undo + nav shortcut', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('(1) 検索ボックスフォーカス + cmd+z は no-op、削除した検索文字は復活しない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO #task', tags: ['#task'] }
                }
            });
        });

        // 検索ボックスにテキスト入力
        await page.locator('.outliner-search-input').fill('#task');
        await page.waitForTimeout(250);

        // 削除
        await page.locator('.outliner-search-input').fill('');
        await page.waitForTimeout(150);

        // 検索ボックスにフォーカスを保ったまま cmd+z
        await page.locator('.outliner-search-input').focus();
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(100);

        // 検索文字は復活していないこと
        const value = await page.evaluate(() => {
            const input = document.querySelector('.outliner-search-input') as HTMLInputElement;
            return input?.value;
        });
        expect(value).toBe('');
    });

    test('(2) ボディフォーカス時の Opt+Left は outliner.navigateBack を発火する (back ボタン enabled 状態が変化)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO', tags: [] }
                }
            });
        });

        // 状態を 2 件 push
        await page.locator('.outliner-search-input').fill('foo');
        await page.waitForTimeout(250);
        await page.locator('.outliner-search-input').fill('bar');
        await page.waitForTimeout(250);

        // back ボタンが enabled 状態 (= back 履歴あり) を確認
        const beforeBackDisabled = await page.evaluate(() =>
            (document.querySelector('.outliner-nav-back-btn') as HTMLButtonElement)?.disabled);
        expect(beforeBackDisabled).toBe(false);

        // ボディにフォーカス + Opt+Left
        await page.evaluate(() => {
            (document.activeElement as HTMLElement)?.blur();
            document.body.focus();
        });
        await page.waitForTimeout(50);
        await page.keyboard.press('Alt+ArrowLeft');
        await page.waitForTimeout(150);

        // forward ボタンが enabled になる (back 経由で forward 履歴に push されたため)
        const afterFwdDisabled = await page.evaluate(() =>
            (document.querySelector('.outliner-nav-forward-btn') as HTMLButtonElement)?.disabled);
        expect(afterFwdDisabled).toBe(false);
    });

    test('(2) 検索ボックスフォーカス時の Opt+Left/Right も outliner navigateBack/Forward へ委譲', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO', tags: [] }
                }
            });
        });

        await page.locator('.outliner-search-input').fill('alpha');
        await page.waitForTimeout(250);
        await page.locator('.outliner-search-input').fill('beta');
        await page.waitForTimeout(250);

        const beforeFwdDisabled = await page.evaluate(() =>
            (document.querySelector('.outliner-nav-forward-btn') as HTMLButtonElement)?.disabled);
        expect(beforeFwdDisabled).toBe(true);

        // 検索ボックスにフォーカス保ったまま Opt+Left
        await page.locator('.outliner-search-input').focus();
        await page.keyboard.press('Alt+ArrowLeft');
        await page.waitForTimeout(150);

        // navigateBack が発火 → forward stack に push されて forward ボタンが enabled
        const afterFwdDisabled = await page.evaluate(() =>
            (document.querySelector('.outliner-nav-forward-btn') as HTMLButtonElement)?.disabled);
        expect(afterFwdDisabled).toBe(false);
    });

    test('(1)b 検索入力 → 削除 → ノードフォーカス → cmd+z で検索文字が復活しない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO', tags: [] }
                }
            });
        });

        // 1. search box 入力 → debounce 待ち
        await page.locator('.outliner-search-input').fill('foobar');
        await page.waitForTimeout(250);

        // 2. 削除
        await page.locator('.outliner-search-input').fill('');
        await page.waitForTimeout(250);

        // 3. ノードにフォーカス移動
        await page.locator('.outliner-node[data-id="n1"] .outliner-text').click();
        await page.waitForTimeout(100);

        // 4. cmd+z (focus は node)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(150);

        // 5. 検索ボックスは空のまま
        const value = await page.evaluate(() => {
            const input = document.querySelector('.outliner-search-input') as HTMLInputElement;
            return input?.value;
        });
        expect(value).toBe('');
    });

    test('(2) sidepanel md (mock) フォーカス時の Opt+Left では outliner navigateBack が動作しない (collide 防止)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO', tags: [] }
                }
            });
        });

        // 検索状態を 2 つ積む
        await page.locator('.outliner-search-input').fill('left');
        await page.waitForTimeout(250);
        await page.locator('.outliner-search-input').fill('right');
        await page.waitForTimeout(250);

        // mock side panel editor root を作って focus
        await page.evaluate(() => {
            // side-panel-editor-root 配下の contenteditable を mock
            const root = document.createElement('div');
            root.className = 'side-panel-editor-root';
            const ed = document.createElement('div');
            ed.contentEditable = 'true';
            ed.setAttribute('data-mock-sidepanel', 'true');
            ed.tabIndex = 0;
            root.appendChild(ed);
            document.body.appendChild(root);
            ed.focus();
        });
        await page.waitForTimeout(50);

        // この状態で Opt+Left を発火 → outliner.navigateBack は動かないはず
        await page.keyboard.press('Alt+ArrowLeft');
        await page.waitForTimeout(150);

        const value = await page.evaluate(() => {
            const input = document.querySelector('.outliner-search-input') as HTMLInputElement;
            return input?.value;
        });
        // 'right' のまま (outliner nav back が動いていない)
        expect(value).toBe('right');
    });
});
