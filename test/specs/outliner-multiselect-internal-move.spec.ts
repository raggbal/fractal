/**
 * outliner 内 D&D の複数 node 一括移動
 * sprint 20260906-024639-tree-keynav-opennew-modifier / FR-OMV-01/02 / NFR-OMV-01/02
 *
 * TC-OMV-01..13。
 *
 * 設計（design/system.md §5）:
 *   - 移動対象は `internalMoveIds(draggedId)` = 掴んだ node が複数選択に含まれるなら
 *     `selectionExportRoots()`（可視順 + 最上位のみ）/ 含まれないなら 1 件（契約不変）
 *   - 拒否ガードは**全 root** に対して評価し、1 件でも不正なら **drop 全体を拒否**
 *   - 挿入は「1 件目 = 従来の単一移動と同じ引数 / 2 件目以降 = `afterId` が直前に置いた id」
 *   - `saveSnapshot()` / `renderTree()` / `scheduleSyncToHost()` はループの外で 1 回
 *   - 移動後も選択集合は維持（クリアしない）
 *
 * ★ counterfactual の要点: 単一 id のままの実装では 1 件目だけが動く（= 依頼の症状）。
 *   各 TC は「3 件とも動いた」+「順序が保たれた」を対で assert する。
 */
import { test, expect, Page } from '@playwright/test';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

/**
 * x / y / z / t / p(>c) の木。
 *   - x, y, z … 移動する 3 件（可視順 = この順）
 *   - t       … drop 先（選択外）
 *   - p > c   … 親子（TC-OMV-05 の祖先包含 / TC-OMV-06 の子孫 drop 拒否に使う）
 */
const TREE = {
    version: 1,
    rootIds: ['x', 'y', 'z', 't', 'p'],
    nodes: {
        x: n('x', 'x-node'),
        y: n('y', 'y-node'),
        z: n('z', 'z-node'),
        t: n('t', 't-target'),
        p: n('p', 'p-parent', { children: ['c'] }),
        c: n('c', 'c-child', { parentId: 'p' }),
    },
};

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, TREE);
    await page.waitForSelector('.outliner-node[data-id="t"]', { timeout: 5000 });
}

/** cmd+click で複数選択を作る（FR-MSC-01: 行のどこを掴んでも効く）。 */
async function multiSelect(page: Page, ids: string[]): Promise<void> {
    await page.locator(`.outliner-node[data-id="${ids[0]}"] .outliner-text`).click();
    for (const id of ids) {
        await page.evaluate((i) => {
            const el = document.querySelector(`.outliner-node[data-id="${i}"] .outliner-text`) as HTMLElement;
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, metaKey: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
        }, id);
    }
    await page.waitForFunction((want) =>
        document.querySelectorAll('.outliner-node.is-selected').length === want, ids.length, { timeout: 3000 });
}

function selectedIds(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node.is-selected')).map((e) => (e as HTMLElement).dataset.id || ''));
}

/**
 * バレットから drag を開始して対象 node の指定位置へ drop する（**実行経路から踏む** — model 関数を直接呼ばない）。
 * frac: 0.1 = before（上 1/4）/ 0.5 = child（中央）/ 0.8 = after（下帯）。
 */
async function dragToNode(page: Page, dragId: string, targetId: string, frac: number): Promise<void> {
    await page.evaluate(({ d, t, f }) => {
        const bullet = document.querySelector(`.outliner-node[data-id="${d}"] .outliner-bullet`) as HTMLElement;
        if (!bullet) { throw new Error('bullet が無い: ' + d); }
        const dt = new DataTransfer();
        bullet.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const tEl = document.querySelector(`.outliner-node[data-id="${t}"]`) as HTMLElement;
        const r = tEl.getBoundingClientRect();
        const y = r.top + r.height * f;
        tEl.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: y,
        }));
        tEl.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: y,
        }));
    }, { d: dragId, t: targetId, f: frac });
}

/** ツリーの余白（treeEl 本体）へ drop する（root 末尾）。 */
async function dragToRootArea(page: Page, dragId: string): Promise<void> {
    await page.evaluate((d) => {
        const bullet = document.querySelector(`.outliner-node[data-id="${d}"] .outliner-bullet`) as HTMLElement;
        const dt = new DataTransfer();
        bullet.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const tree = document.querySelector('.outliner-tree') as HTMLElement;
        if (!tree) { throw new Error('.outliner-tree が無い'); }
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        Object.defineProperty(ev, 'target', { value: tree });
        tree.dispatchEvent(ev);
    }, dragId);
}

/** model の構造スナップショット（rootIds + 各 node の parentId / children）。 */
function snapshot(page: Page): Promise<any> {
    return page.evaluate(() => {
        const m = (window as any).Outliner.getModel();
        const out: any = { rootIds: m.rootIds.slice(), nodes: {} };
        Object.keys(m.nodes).forEach((k) => {
            out.nodes[k] = { parentId: m.nodes[k].parentId, children: (m.nodes[k].children || []).slice() };
        });
        return out;
    });
}

function childrenOf(page: Page, id: string): Promise<string[]> {
    return page.evaluate((i) => ((window as any).Outliner.getModel().getNode(i).children || []).slice(), id);
}
function rootIds(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as any).Outliner.getModel().rootIds.slice());
}

test.describe('outliner 内 D&D の一括移動（TASK-11 / FR-OMV-01）', () => {
    test('TC-OMV-01 before（上 1/4）: 3 件とも p の直前へ表示順のまま', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y', 'z']);
        // ★ drop 先は p（t ではない）— t の直前だと期待値が初期並びと同じになり
        //   「1 件も動かなくても green」のトートロジーになるため。
        await dragToNode(page, 'x', 'p', 0.1);
        expect(await rootIds(page), '3 件とも p の直前・順序は x,y,z').toEqual(['t', 'x', 'y', 'z', 'p']);
    });

    test('TC-OMV-03 child（中央）: 3 件とも t の子に表示順のまま', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y', 'z']);
        await dragToNode(page, 'x', 't', 0.5);
        expect(await childrenOf(page, 't'), 't の子が x,y,z の順').toEqual(['x', 'y', 'z']);
        expect(await rootIds(page), 'root からは 3 件が抜けている').toEqual(['t', 'p']);
        const parents = await page.evaluate(() => ['x', 'y', 'z'].map(
            (i) => (window as any).Outliner.getModel().getNode(i).parentId));
        expect(parents, '3 件とも parentId=t').toEqual(['t', 't', 't']);
    });

    test('TC-OMV-02 after（下帯）: 3 件とも解決位置へ表示順のまま', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y', 'z']);
        await dragToNode(page, 'x', 't', 0.8);
        const rids = await rootIds(page);
        // t の後ろに x,y,z が連なる（depth 解決なしの一意ケース）
        expect(rids.slice(rids.indexOf('t')), 't の直後に x,y,z').toEqual(['t', 'x', 'y', 'z', 'p']);
    });

    test('TC-OMV-04 余白 drop: 3 件とも root 末尾へ表示順のまま', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y', 'z']);
        await dragToRootArea(page, 'x');
        expect(await rootIds(page), 'root 末尾に x,y,z').toEqual(['t', 'p', 'x', 'y', 'z']);
    });

    test('TC-OMV-05 祖先と子孫を同時選択 → 最上位だけが動く（子が二重に現れない）', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['p', 'c']);
        await dragToNode(page, 'p', 't', 0.5);
        expect(await childrenOf(page, 't'), 't の子は p だけ').toEqual(['p']);
        expect(await childrenOf(page, 'p'), 'c は p の子のまま').toEqual(['c']);
        const cParent = await page.evaluate(() => (window as any).Outliner.getModel().getNode('c').parentId);
        expect(cParent).toBe('p');
    });

    test('TC-OMV-06 選択 root の子孫へ drop → 1 件も動かない（全体拒否）', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y', 'p']);
        const before = await snapshot(page);
        await dragToNode(page, 'x', 'c', 0.5);   // c は選択 root p の子孫
        expect(await snapshot(page), 'model が完全不変（部分適用なし）').toEqual(before);
    });

    test('TC-OMV-07 undo 1 回で 3 件すべて元に戻る（snapshot はループ外で 1 回）', async ({ page }) => {
        await setup(page);
        const before = await snapshot(page);
        await multiSelect(page, ['x', 'y', 'z']);
        await dragToNode(page, 'x', 't', 0.5);
        expect(await childrenOf(page, 't')).toEqual(['x', 'y', 'z']);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(80);
        expect(await snapshot(page), 'undo 1 回で完全一致').toEqual(before);
    });

    test('TC-OMV-08 移動後も選択集合が維持される（続けて D&D できる）', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y', 'z']);
        await dragToNode(page, 'x', 't', 0.5);
        const sel = await selectedIds(page);
        expect(sel.sort(), '3 件とも選択されたまま').toEqual(['x', 'y', 'z']);
    });

    test('TC-OMV-11 選択に含まれない node を掴んだら 1 件だけ動く（契約不変）', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y', 'z']);
        await dragToNode(page, 'p', 't', 0.5);   // p は選択外
        expect(await childrenOf(page, 't'), 't の子は p だけ').toEqual(['p']);
        expect(await rootIds(page), 'x,y,z は動いていない').toEqual(['x', 'y', 'z', 't']);
    });

    test('TC-OMV-13 Cmd+A 全選択 → drop は 0 件移動（有効な drop 先が無く全体拒否）', async ({ page }) => {
        await setup(page);
        await page.locator('.outliner-node[data-id="t"] .outliner-text').click();
        await page.keyboard.press('Meta+a');
        await page.keyboard.press('Meta+a');
        await page.waitForFunction(() =>
            document.querySelectorAll('.outliner-node.is-selected').length >= 6, undefined, { timeout: 3000 });
        const before = await snapshot(page);
        await dragToNode(page, 'x', 't', 0.5);
        // 全 root が選択されているので「選択 root 自身 or その子孫」でない drop 先が存在しない
        expect(await snapshot(page), '大量移動が走らない（ガードが全体拒否する）').toEqual(before);
    });
});

test.describe('outliner 内 D&D の単一移動が不変（TASK-11 / 非回帰）', () => {
    test('TC-OMV-09 単一選択の before / child / after', async ({ page }) => {
        await setup(page);
        await dragToNode(page, 'x', 't', 0.5);
        expect(await childrenOf(page, 't')).toEqual(['x']);
        await setup(page);
        await dragToNode(page, 'x', 'p', 0.1);   // x を p の直前へ（移動が観測できる並び）
        expect(await rootIds(page)).toEqual(['y', 'z', 't', 'x', 'p']);
        await setup(page);
        await dragToNode(page, 'x', 't', 0.8);
        const rids = await rootIds(page);
        expect(rids.slice(rids.indexOf('t'))).toEqual(['t', 'x', 'p']);
    });

    test('TC-OMV-10 単一選択の余白 drop（root 末尾）', async ({ page }) => {
        await setup(page);
        await dragToRootArea(page, 'x');
        expect(await rootIds(page)).toEqual(['y', 'z', 't', 'p', 'x']);
    });

    test('TC-OMV-12 一括移動でも host 同期は 1 回（N 回呼ばない）', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            const w = window as any;
            w.__syncCalls = 0;
            const orig = w.__testApi.messages;
            void orig;
            // scheduleSyncToHost は debounce 後に syncData を送る。ここでは送信メッセージ数を数える。
            w.__testApi.messages.length = 0;
        });
        await multiSelect(page, ['x', 'y', 'z']);
        await dragToNode(page, 'x', 't', 0.5);
        await page.waitForTimeout(600);   // debounce の着地を待つ
        const syncMsgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'syncData' || m.type === 'save').length);
        expect(syncMsgs, '同期は 1 回に束ねられる（3 件でも N 回にならない）').toBeLessThanOrEqual(1);
    });
});

/**
 * TC-OMV-14 — reviewer iteration 1 FINDING-DC-1 の番人。
 * 余白（root 末尾）drop はガード（targetId 基準）の対象外なので、**既に末尾に同じ順で並んでいる集合**は
 * `saveSnapshot` / `moveNode` を 1 度も呼ばずに終了する（Cmd+A 全選択 drop がその典型）。
 */
test.describe('余白 drop の no-op 短絡（TASK-14 / NFR-OMV-02）', () => {
    test('TC-OMV-14 Cmd+A 全選択 → 余白 drop は model 不変 + undo スタックを伸ばさない', async ({ page }) => {
        await setup(page);
        // moveNode / saveSnapshot の呼び出しを数える（実行経路から踏んだ結果を測る）
        await page.evaluate(() => {
            const w = window as any;
            const m = w.Outliner.getModel();
            w.__calls = { moveNode: 0 };
            const orig = m.moveNode.bind(m);
            m.moveNode = function (...args: any[]) { w.__calls.moveNode++; return orig(...args); };
        });
        await page.locator('.outliner-node[data-id="t"] .outliner-text').click();
        await page.keyboard.press('Meta+a');
        await page.keyboard.press('Meta+a');
        await page.waitForFunction(() =>
            document.querySelectorAll('.outliner-node.is-selected').length >= 6, undefined, { timeout: 3000 });
        const roots = await page.evaluate(() => (window as any).Outliner.selectionExportRoots());
        expect(roots.length, '前提: 全 root（5 件）が移動対象になる').toBe(5);

        const before = await snapshot(page);
        await dragToRootArea(page, 'x');
        expect(await snapshot(page), 'model が完全不変').toEqual(before);
        // ★ counterfactual: 短絡を外すと moveNode が 5 回走る（実測値）
        const calls = await page.evaluate(() => (window as any).__calls.moveNode);
        expect(calls, 'moveNode が 1 度も呼ばれない（無駄な N splice を作らない）').toBe(0);

        // undo スタックが伸びていない（Meta+z が「この no-op」を戻す形になっていない）
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(80);
        expect(await snapshot(page), 'undo しても直前の状態が壊れない').toEqual(before);
    });

    test('TC-OMV-14b 末尾に無い集合の余白 drop は従来どおり移動する（短絡が効きすぎていない）', async ({ page }) => {
        await setup(page);
        await multiSelect(page, ['x', 'y']);
        await dragToRootArea(page, 'x');
        expect(await rootIds(page), 'x,y が root 末尾へ').toEqual(['z', 't', 'p', 'x', 'y']);
    });
});
