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

    test('(1)b 検索入力 → 削除 → ノードフォーカス → cmd+z で検索文字が復活しない (実際の typing 再現)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'TODO match', tags: [] }
                }
            });
        });

        // 1. search box にフォーカスして実際にキー入力 (match させる文字列で表示維持)
        await page.locator('.outliner-search-input').click();
        await page.keyboard.type('TODO', { delay: 80 });
        await page.waitForTimeout(300);

        // 2. 削除: Playwright で完全削除を確実にするため evaluate で value='' + input event dispatch
        //    (実際の native input undo stack には typing 部分のみ残る)
        await page.evaluate(() => {
            var inp = document.querySelector('.outliner-search-input') as HTMLInputElement;
            if (inp) {
                inp.value = '';
                inp.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
            }
        });
        await page.waitForTimeout(300);
        const beforeFocusValue = await page.evaluate(() => {
            return (document.querySelector('.outliner-search-input') as HTMLInputElement)?.value;
        });
        expect(beforeFocusValue).toBe('');

        // 3. ノードにフォーカス移動 (DOM レベルで focus 確実に移動)
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.focus();
        });
        await page.waitForTimeout(100);

        // focus が確実に node に移ったか確認
        const focusOnNode = await page.evaluate(() =>
            document.activeElement?.classList.contains('outliner-text'));
        expect(focusOnNode).toBe(true);

        // 4. cmd+z (focus は node)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(500);

        // 5. 検索ボックスは空のまま + フォーカスは node に維持されている
        const result = await page.evaluate(() => {
            const input = document.querySelector('.outliner-search-input') as HTMLInputElement;
            const ae = document.activeElement;
            return {
                value: input?.value,
                focusOnSearch: ae === input,
                focusOnNode: !!(ae && ae.classList.contains('outliner-text'))
            };
        });
        expect(result.value).toBe('');
        expect(result.focusOnSearch).toBe(false);
        expect(result.focusOnNode).toBe(true);
    });

    test('(1)c 連打 cmd+z (5 回) でも検索文字は復活しない', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'hello match', tags: [] }
                }
            });
        });

        await page.locator('.outliner-search-input').click();
        await page.keyboard.type('hello', { delay: 80 });
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            var inp = document.querySelector('.outliner-search-input') as HTMLInputElement;
            if (inp) {
                inp.value = '';
                inp.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
            }
        });
        await page.waitForTimeout(300);

        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.focus();
        });
        await page.waitForTimeout(100);

        // cmd+z 連打
        for (var j = 0; j < 5; j++) {
            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(80);
        }
        await page.waitForTimeout(200);

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
