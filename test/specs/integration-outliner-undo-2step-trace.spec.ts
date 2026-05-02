/**
 * ユーザー報告: cmd+z 1 回目で cursor が first row に行き undo されず、2 回目で実 undo
 * これを精密に再現する
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner: undo 2-step trace', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('nested 構造: parent > [c1, c2] で c1 編集 + c2 編集 → cmd+z で c2 修正 + cursor c2', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['p'],
                nodes: {
                    p:  { id: 'p',  parentId: null, children: ['c1', 'c2'], text: 'parent', tags: [] },
                    c1: { id: 'c1', parentId: 'p',  children: [], text: 'one', tags: [] },
                    c2: { id: 'c2', parentId: 'p',  children: [], text: 'two', tags: [] }
                }
            });
        });

        // c1 末尾に 'a' 入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="c1"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        });
        await page.keyboard.type('a');
        await page.waitForTimeout(700);

        // c2 末尾に 'b' 入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="c2"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        });
        await page.keyboard.type('b');
        await page.waitForTimeout(700);

        const before = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            return (window as any).__testApi.getSerializedData();
        });
        expect(before.nodes.c1.text).toBe('onea');
        expect(before.nodes.c2.text).toBe('twob');

        // cmd+z 1: c2 を 'two' に戻し、cursor c2 (← parent ではない)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const after1 = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            const data = (window as any).__testApi.getSerializedData();
            const ae = document.activeElement;
            const nodeId = ae?.closest('.outliner-node')?.getAttribute('data-id');
            return { c1: data.nodes.c1.text, c2: data.nodes.c2.text, focusOn: nodeId };
        });
        expect(after1.c2).toBe('two');
        expect(after1.c1).toBe('onea');
        expect(after1.focusOn).toBe('c2');

        // cmd+z 2: c1 を 'one' に戻し、cursor c1
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const after2 = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            const data = (window as any).__testApi.getSerializedData();
            const ae = document.activeElement;
            const nodeId = ae?.closest('.outliner-node')?.getAttribute('data-id');
            return { c1: data.nodes.c1.text, c2: data.nodes.c2.text, focusOn: nodeId };
        });
        expect(after2.c1).toBe('one');
        expect(after2.c2).toBe('two');
        expect(after2.focusOn).toBe('c1');
    });

    test.skip('Enter で 子作成 → 入力 → Enter で次の子 → 入力 → cmd+z で 1 回で b undone + cursor c2', async ({ page }) => {
        // 親 1 つだけで開始
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['p'],
                nodes: {
                    p: { id: 'p', parentId: null, children: [], text: 'parent', tags: [] }
                }
            });
        });

        // p にフォーカス
        await page.evaluate(() => {
            const t = document.querySelector('.outliner-node[data-id="p"] .outliner-text') as HTMLElement;
            t.focus();
            const r = document.createRange();
            r.selectNodeContents(t);
            r.collapse(false);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(r);
        });

        // Enter で c1 作成 (新規子)
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        // 'a' タイプ
        await page.keyboard.type('a');
        await page.waitForTimeout(700); // saveSnapshot debounce 通過
        // Enter で c2 作成 (兄弟)
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        // 'b' タイプ
        await page.keyboard.type('b');
        await page.waitForTimeout(700);

        // 状態確認
        const before = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            return (window as any).__testApi.getSerializedData();
        });
        // p の children に 2 つ child
        const childIds = before.nodes.p.children;
        expect(childIds.length).toBeGreaterThanOrEqual(2);
        const c1Id = childIds[0];
        const c2Id = childIds[1];
        expect(before.nodes[c1Id].text).toContain('a');
        expect(before.nodes[c2Id].text).toContain('b');

        // cmd+z 1: 'b' typing を undone、cursor c2 (or 親 — bug の確認)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const after1 = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            const data = (window as any).__testApi.getSerializedData();
            const ae = document.activeElement;
            const focusNodeId = ae?.closest('.outliner-node')?.getAttribute('data-id');
            return {
                pChildren: data.nodes.p.children,
                texts: Object.values(data.nodes).map((n: any) => n.text),
                focusOn: focusNodeId
            };
        });
        // 期待: cmd+z 1 で 'b' typing を undone (c2.text='' or 'b' の前段)
        // 実際の挙動を観察するため、focusOn だけまず確認
        console.log('cmd+z 1 result:', JSON.stringify(after1));
        // ★ cursor が parent ではない (= 子に正しくフォーカスされている)
        expect(after1.focusOn).not.toBe('p');
    });

    test.skip('折りたたみ親 → 展開 → 子編集 → cmd+z で 1 回で undo + 子にフォーカス', async ({ page }) => {
        // 親が collapsed の状態で初期化 → toggleCollapse で展開 (saveSnapshot しない経路)
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['p'],
                nodes: {
                    p:  { id: 'p',  parentId: null, children: ['c1', 'c2'], text: 'parent', tags: [], collapsed: true },
                    c1: { id: 'c1', parentId: 'p',  children: [], text: 'one', tags: [] },
                    c2: { id: 'c2', parentId: 'p',  children: [], text: 'two', tags: [] }
                }
            });
        });

        // 直接 model.collapsed=false にして renderTree 再描画
        await page.evaluate(() => {
            const o = (window as any).Outliner;
            const m = o.getModel();
            m.getNode('p').collapsed = false;
            // 内部 renderTree を呼ぶ手段がないので、ノード上で何か発火させる
            // — focus event 経由
            const pTextEl = document.querySelector('.outliner-node[data-id="p"] .outliner-text') as HTMLElement;
            pTextEl.focus();
        });
        await page.waitForTimeout(50);

        // c1 が DOM に出るまで待つ (collapsed=false にしたので render が必要)
        // テスト互換: もし出ていなければ initOutliner で再初期化 (collapsed=false)
        const visible = await page.evaluate(() => !!document.querySelector('.outliner-node[data-id="c1"]'));
        if (!visible) {
            // ハック: model state を維持しつつ render 強制
            // initOutliner は baseline をリセットするので使わず、cmd+? 等で render 発火
            // → 手段なければ test スキップ
            test.skip();
            return;
        }

        // c1 末尾に 'a' 入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="c1"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        });
        await page.keyboard.type('a');
        await page.waitForTimeout(700);

        // c2 末尾に 'b' 入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="c2"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        });
        await page.keyboard.type('b');
        await page.waitForTimeout(700);

        // cmd+z 1
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const after1 = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            const data = (window as any).__testApi.getSerializedData();
            const ae = document.activeElement;
            const nodeId = ae?.closest('.outliner-node')?.getAttribute('data-id');
            return { c1: data.nodes.c1.text, c2: data.nodes.c2.text, focusOn: nodeId };
        });
        expect(after1.c2).toBe('two');
        expect(after1.c1).toBe('onea');
        expect(after1.focusOn).toBe('c2');
    });

    test('node1 入力 → node2 入力 → cmd+z で b が undone (1 回で十分)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'one', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'two', tags: [] },
                    n3: { id: 'n3', parentId: null, children: [], text: 'three', tags: [] }
                }
            });
        });

        // n1 末尾に 'a' 入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n1"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        });
        await page.keyboard.type('a');
        await page.waitForTimeout(700); // 500ms debounce 通過

        // n2 末尾に 'b' 入力
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="n2"] .outliner-text') as HTMLElement;
            textEl.focus();
            const range = document.createRange();
            range.selectNodeContents(textEl);
            range.collapse(false);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
        });
        await page.keyboard.type('b');
        await page.waitForTimeout(700);

        // 状態確認: n1='onea', n2='twob'
        const before = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            return (window as any).__testApi.getSerializedData();
        });
        expect(before.nodes.n1.text).toBe('onea');
        expect(before.nodes.n2.text).toBe('twob');

        // cmd+z 1 回目
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const after1 = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            const data = (window as any).__testApi.getSerializedData();
            const ae = document.activeElement;
            const nodeId = ae?.closest('.outliner-node')?.getAttribute('data-id');
            return { n1: data.nodes.n1.text, n2: data.nodes.n2.text, focusOn: nodeId };
        });
        // 期待: n2 が 'two' に戻り、cursor は n2 にある
        expect(after1.n2).toBe('two');
        expect(after1.n1).toBe('onea');
        expect(after1.focusOn).toBe('n2');

        // cmd+z 2 回目
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);

        const after2 = await page.evaluate(() => {
            (window as any).Outliner.flushSync();
            const data = (window as any).__testApi.getSerializedData();
            const ae = document.activeElement;
            const nodeId = ae?.closest('.outliner-node')?.getAttribute('data-id');
            return { n1: data.nodes.n1.text, n2: data.nodes.n2.text, focusOn: nodeId };
        });
        // 期待: n1 が 'one' に戻り、cursor は n1 にある
        expect(after2.n1).toBe('one');
        expect(after2.n2).toBe('two');
        expect(after2.focusOn).toBe('n1');
    });
});
