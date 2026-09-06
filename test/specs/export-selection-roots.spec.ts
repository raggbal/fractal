/**
 * TASK-25 — Export の選択集合 roots（祖先包含の重複排除）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-SND-03 / §6-2 / ADRL-0077）
 *
 * TC-SND-07。TC-SND-08/09（出力レイアウト / uniquify）は `ExportNode[]` 契約が**変更なし**なので
 * 既存の Export folder host TC が番人（本 TASK は payload の作り方だけを変える）— 契約の同一性を
 * 本 spec の最後で機械的に確認する。
 *
 * 🔴 counterfactual: `expandSelectionWithDescendants()`（子孫を**足す**逆方向の関数）を使うと
 * 子孫が root に混ざって二重出力になり RED。
 */
import { test, expect, Page } from '@playwright/test';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

/**
 * a > a1 > a11 / b / c の木。
 * 祖先（a）と子孫（a1 / a11）を同時に選べる形（重複排除の検証に必須）。
 */
const TREE = {
    version: 1,
    rootIds: ['a', 'b', 'c'],
    nodes: {
        a: n('a', 'alpha', { children: ['a1'], filePath: 'files/a.pdf' }),
        a1: n('a1', 'alpha-1', { parentId: 'a', children: ['a11'] }),
        a11: n('a11', 'alpha-1-1', { parentId: 'a1', isPage: true, pageId: 'p-a11' }),
        b: n('b', 'bravo'),
        c: n('c', 'charlie', { images: ['images/c.png'] }),
    },
};

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, TREE);
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
}

/** Cmd+A の 2 段階（1 段目 = テキスト全選択 / 2 段目 = 全 node 選択）で全選択状態を作る。 */
async function selectAllNodes(page: Page): Promise<void> {
    await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Meta+a');
    await page.waitForFunction(() =>
        document.querySelectorAll('.outliner-node.is-selected').length >= 5, undefined, { timeout: 3000 });
}

/**
 * shift+↓ で focus から N 行ぶんの連続範囲を選ぶ。
 *
 * ⚠️ **初回の Shift+↓ は「自行のみ選択」でフォーカスを動かさない**（outliner.js:5376-5382 の
 * anchor 初期化）。2 回目以降が拡張なので、N 行選ぶには **N 回**押す（1 + (N-1)）。
 */
async function selectRangeFrom(page: Page, id: string, extraRows: number): Promise<void> {
    await page.locator(`.outliner-node[data-id="${id}"] .outliner-text`).click();
    await page.keyboard.press('Shift+ArrowDown');            // anchor 確定（自行のみ）
    for (let i = 0; i < extraRows; i++) { await page.keyboard.press('Shift+ArrowDown'); }
    await page.waitForFunction((want) =>
        document.querySelectorAll('.outliner-node.is-selected').length === want,
    extraRows + 1, { timeout: 3000 });
}

test.describe('TC-SND-07 選択集合から最上位のみを root にする（FR-SND-03）', () => {
    test('祖先と子孫を同時に選んでも root は最上位だけ（二重出力しない）', async ({ page }) => {
        await setup(page);
        await selectAllNodes(page);   // a, a1, a11, b, c すべて選択

        const roots = await page.evaluate(() => (window as any).Outliner.selectionExportRoots());
        // a1 / a11 は a の subtree に含まれるので root から除かれる
        expect(roots, `root が最上位だけになっていない: ${JSON.stringify(roots)}`).toEqual(['a', 'b', 'c']);

        const trees = await page.evaluate(() => (window as any).Outliner.buildExportTreeForSelection());
        expect(trees.length, 'ExportNode[] の件数が root 数と一致しない').toBe(3);
        expect(trees.map((t: any) => t.id)).toEqual(['a', 'b', 'c']);
        // 子孫は親の children として 1 度だけ現れる（root と children で二重に出ない）
        expect(trees[0].children.map((c: any) => c.id), 'a の子が欠けている').toEqual(['a1']);
        expect(trees[0].children[0].children.map((c: any) => c.id), 'a1 の子が欠けている').toEqual(['a11']);

        // 木全体で各 id が 1 度しか現れない（= 二重出力ゼロ）
        const flat: string[] = await page.evaluate(() => {
            const out: string[] = [];
            const walk = (ns: any[]) => { for (const x of ns) { out.push(x.id); walk(x.children || []); } };
            walk((window as any).Outliner.buildExportTreeForSelection());
            return out;
        });
        expect(flat.length, `二重出力がある: ${flat.join(',')}`).toBe(new Set(flat).size);
        expect(new Set(flat)).toEqual(new Set(['a', 'a1', 'a11', 'b', 'c']));
    });

    test('部分選択（祖先 + その子）でも root は祖先 1 件', async ({ page }) => {
        await setup(page);
        // a（root）から shift+↓ で a1 まで = a, a1 の 2 件選択
        await selectRangeFrom(page, 'a', 1);
        const selected = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-node.is-selected')).map((e) => (e as HTMLElement).dataset.id));
        expect(selected, `前提: a と a1 が選択されていない（実際 ${selected.join(',')}）`).toEqual(['a', 'a1']);

        const roots = await page.evaluate(() => (window as any).Outliner.selectionExportRoots());
        expect(roots, '子（a1）が root に混ざった').toEqual(['a']);
    });

    test('兄弟だけを選んだ場合は全部 root（重複排除が効きすぎていない）', async ({ page }) => {
        await setup(page);
        // b から shift+↓ で c まで = b, c（兄弟・親子関係なし）
        await selectRangeFrom(page, 'b', 1);
        const roots = await page.evaluate(() => (window as any).Outliner.selectionExportRoots());
        expect(roots, '兄弟が落とされた（抽出条件が厳しすぎる）').toEqual(['b', 'c']);
    });

    test('選択ゼロなら空配列（全 root を返してしまわない）', async ({ page }) => {
        await setup(page);
        const roots = await page.evaluate(() => (window as any).Outliner.selectionExportRoots());
        expect(roots, '選択ゼロで全 root が返った（buildExportTree(null) の挙動に落ちている）').toEqual([]);
        const trees = await page.evaluate(() => (window as any).Outliner.buildExportTreeForSelection());
        expect(trees).toEqual([]);
    });

    test('🔴 expandSelectionWithDescendants を使っていない（逆方向の関数）', async ({ page }) => {
        await setup(page);
        await selectAllNodes(page);
        // 逆方向の関数を使っていたら root に子孫が混ざる。ここでは root 数 = 3（rootIds と同数）
        const roots = await page.evaluate(() => (window as any).Outliner.selectionExportRoots());
        expect(roots.length, '子孫が root に混ざっている（expandSelectionWithDescendants の誤用）').toBe(3);
    });
});

test.describe('TC-SND-08/09 ExportNode 契約が Export folder と同一（既存 host TC が番人）', () => {
    test('buildExportTreeForSelection の要素は buildExportTree(rootId) と同じ形', async ({ page }) => {
        await setup(page);
        await selectAllNodes(page);
        const cmp = await page.evaluate(() => {
            const w = (window as any).Outliner;
            const viaSelection = w.buildExportTreeForSelection();
            const direct = ['a', 'b', 'c'].map((id) => w.buildExportTree(id));
            return { viaSelection, direct };
        });
        // 契約（キー集合と値）が完全一致 = host の folder-export.ts 側は無変更でよい
        expect(cmp.viaSelection, 'ExportNode の形が既存 Export folder と違う（host 契約が壊れる）')
            .toEqual(cmp.direct);
        // 併持（md 添付 + file 添付 + 画像）が落ちていない
        const a = cmp.viaSelection[0];
        expect(a.filePath, 'file 添付が落ちた').toBe('files/a.pdf');
        expect(a.children[0].children[0].pageId, 'md 添付（pageId）が落ちた').toBe('p-a11');
        expect(cmp.viaSelection[2].images, '画像が落ちた').toEqual(['images/c.png']);
    });
});
