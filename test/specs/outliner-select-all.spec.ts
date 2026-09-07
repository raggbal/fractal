/**
 * TASK-12 — Outliner の Cmd+A 全 node 選択（GitHub issue #2 / FR-MSEL-06）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / NFR-MSEL-01）
 *
 * TC-MSEL-21 / TC-MSEL-23。
 *
 * 🔴 **FR-MSEL-06 の前提は誤りだった**（gate で発覚 / generator-log に申告済み）:
 * requirement は「`outliner.js` に Cmd+A ハンドラが**存在しない**ため webview のネイティブ全選択に
 * 落ちる」としていたが、**`outliner.js` の `case 'a'`（keydown の Cmd/Ctrl switch 内）に
 * 既存ハンドラが実装済み**で、`preventDefault()` + `selectRange()`（内部で `removeAllRanges()`）
 * まで揃っていた。requirement / research の調査漏れ。
 *
 * したがって本 spec は **新機能の番人ではなく、FR-MSEL-06 の受け入れ条件が
 * 既存実装で満たされていることを固定する番人**として置く（実装追加はしない）。
 * 2 段階方式（1 回目 = テキスト全選択 / 2 回目 = 全 node 選択）を一度実装したが、
 * **既存仕様「1 回で全 node 選択」に依存する既存 TC が 20 本以上あり**（`outliner-keyboard` #30 /
 * `integration-outliner-cmd-cv-matrix` 全件 / `outliner-copy-html` / `outliner-copy-page-path` 等）
 * gate で NEW FAILS 27 件を出したため撤回した。
 *
 * ✅ **その未達は sprint 20260906-095357 で解消した**（FR-MSEL-06 rev3 / ADRL-0116）:
 *   - 「編集中と選択中を機構的に判別できない」という撤回理由は、モードを
 *     `selectedNodeIds.size > 0` の**派生**として明示化（ADRL-0119）したことで構造的に解消した。
 *   - Cmd+A は **2 段階 escalation** になった: 1 回目 = その node の text 全選択（編集モード維持）/
 *     2 回目 = 全 node 選択（選択モードへ）/ 3 回目以降 = no-op。
 *   - **mindmap 面は 2 段階から免除**（`VIEW_MODE === 'mindmap'` で 1 段階のまま = FR-OSM-06 rev1）。
 *     下の「Mindmap view でも全ノード選択が働く」が**無改修で green のまま**であることがその番人。
 *   - 本 spec の期待値はこの rev3 に合わせて反転済み（rev: TU-03）。2 段階の詳細な番人は
 *     `test/specs/outliner-select-mode.spec.ts`（TC-OSM-20..28）にある。
 */
import { test, expect, Page } from '@playwright/test';

/** node のひな型（既存 outliner spec の慣習）。 */
function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

/** a > a1 / b / c の 3 root（a は展開済み）。可視 = a, a1, b, c の 4 件。 */
const TREE = {
    version: 1,
    rootIds: ['a', 'b', 'c'],
    nodes: {
        a: n('a', 'alpha', { children: ['a1'] }),
        a1: n('a1', 'alpha-1', { parentId: 'a' }),
        b: n('b', 'bravo'),
        c: n('c', 'charlie'),
    },
};

/** a が collapsed で子 a1 を隠す。可視 = a, b の 2 件。 */
const TREE_COLLAPSED = {
    version: 1,
    rootIds: ['a', 'b'],
    nodes: {
        a: n('a', 'alpha', { children: ['a1'], collapsed: true }),
        a1: n('a1', 'hidden-child', { parentId: 'a' }),
        b: n('b', 'bravo'),
    },
};

async function setup(page: Page, tree: any = TREE): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, tree);
    // outliner init の setTimeout(100) focusFirstVisibleNode の着地を条件待ち
    // （generator_failures 2026-08-29: sleep 延長では直らない）
    await page.waitForFunction(() => {
        const ae = document.activeElement as HTMLElement | null;
        return !!ae && ae !== document.body;
    }, undefined, { timeout: 5000 }).catch(() => { /* 面によっては自動フォーカスが無い */ });
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
}

function selectedIds(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node.is-selected'))
            .map((el) => (el as HTMLElement).dataset.id || ''));
}

test.describe('TC-MSEL-21 Outliner の Cmd+A（FR-MSEL-06 / GitHub issue #2）', () => {
    test('Cmd+A 2 回で可視 node が全選択され、ネイティブ全選択が走らない（rev3 = 2 段階）', async ({ page }) => {
        await setup(page);
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();

        // FR-MSEL-06 rev3 / ADRL-0116: 1 回目 = node の text 全選択 / 2 回目 = 全 node 選択
        await page.keyboard.press('Meta+a');
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(150);

        const sel = await selectedIds(page);
        for (const id of ['a', 'a1', 'b', 'c']) {
            expect(sel, `${id} が選択されていない: ${sel.join(',')}`).toContain(id);
        }
        expect(sel.length, '可視 node が全部選択されていない').toBeGreaterThanOrEqual(4);

        // テキスト範囲が残っていない（NFR-MSEL-01 の Hard MUST）。
        // ⚠️ これは **preventDefault の番人にはならない**（実測: preventDefault を外しても
        // `page.keyboard.press` 経由ではネイティブ全選択が発火せず assert が通ってしまう）。
        // preventDefault の実測は下の TC（合成 KeyboardEvent で defaultPrevented を読む）が担う。
        expect(await page.evaluate(() => {
            const s = window.getSelection()!;
            return s.rangeCount === 0 || s.isCollapsed;
        }), 'テキスト範囲が残っている（clipboard / D&D をブラウザ標準に奪われる）').toBe(true);
    });

    test('🔴 issue #2 の番人: Cmd+A が preventDefault される（ネイティブ全選択の抑止）', async ({ page }) => {
        await setup(page);
        // 合成 KeyboardEvent なら `defaultPrevented` を読める（実キー入力では読めない）。
        // 既存ハンドラは document の capture 段に付いているので合成でも走る。
        const prevented = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="b"] .outliner-text') as HTMLElement;
            el.focus();
            const ev = new KeyboardEvent('keydown', {
                key: 'a', code: 'KeyA', bubbles: true, cancelable: true, metaKey: true,
            });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        expect(prevented,
            'Cmd+A が preventDefault されていない — webview document のネイティブ全選択が走り '
            + 'ツールバー / パネルごと選択される（GitHub issue #2 の症状）').toBe(true);
    });

    test('Ctrl+A でも同じ（Windows / Linux / Theia 経路。2 段階）', async ({ page }) => {
        await setup(page);
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        // FR-MSEL-06 rev3 / ADRL-0116: 1 回目 = node の text 全選択 / 2 回目 = 全 node 選択
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(150);
        const sel = await selectedIds(page);
        expect(sel.length, `Ctrl+A で選択されない: ${sel.join(',')}`).toBeGreaterThanOrEqual(4);
    });

    test('collapsed 配下の非表示 node は選択されない（可視のみ = getFlattenedIds(true)）', async ({ page }) => {
        await setup(page, TREE_COLLAPSED);
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        // FR-MSEL-06 rev3 / ADRL-0116: 1 回目 = node の text 全選択 / 2 回目 = 全 node 選択
        await page.keyboard.press('Meta+a');
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(150);

        const sel = await selectedIds(page);
        expect(sel.sort(), `可視 2 件だけが選択されるべき: ${sel.join(',')}`).toEqual(['a', 'b']);
        // 折りたたみ配下は DOM に描画されない（= is-selected も付かない）ので、
        // 「非表示 node が選択集合に入らない」の直接観測はここまで（実装は selectRange と
        // 同一の getFlattenedIds(true) を使う）。
        expect(await page.locator('.outliner-node[data-id="a1"]').count(),
            '折りたたみ配下が描画されている（前提が変わった）').toBe(0);
    });

    test('2 段目の全選択後に Cmd+C すると全 node が clipboard payload に入る（テキスト範囲に奪われない）', async ({ page }) => {
        await setup(page);
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        // FR-MSEL-06 rev3 / ADRL-0116: 1 回目 = node の text 全選択 / 2 回目 = 全 node 選択
        await page.keyboard.press('Meta+a');
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(150);
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
        await page.keyboard.press('Meta+c');
        await page.waitForTimeout(200);

        const saved = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'saveOutlinerClipboard'));
        // NFR-MSEL-01 の趣旨: テキスト範囲が残っているとブラウザ標準の copy に奪われて
        // clipboard payload が作られない
        expect(saved.length, 'Cmd+C が clipboard payload を作っていない（テキスト範囲に奪われた）')
            .toBeGreaterThan(0);
        const nodes = saved[saved.length - 1].nodes || [];
        expect(nodes.length, `全選択したのに ${nodes.length} node しか入っていない`).toBeGreaterThanOrEqual(4);
    });
});

test.describe('TC-MSEL-23 Mindmap view の Cmd+A は従来どおり（回帰なし）', () => {
    test('Mindmap view でも全ノード選択が働く', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => { (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForSelector('.mindmap-node', { timeout: 5000 });

        // mindmap の keydown ハンドラは treeEl に delegate されている（mindmap-interactions.js:552）
        await page.evaluate(() => {
            const el = (document.querySelector('.mindmap-node') as HTMLElement)
                || (document.querySelector('#outlinerTree, .outliner-tree') as HTMLElement)
                || document.body;
            el.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'a', code: 'KeyA', bubbles: true, cancelable: true, metaKey: true, ctrlKey: true,
            }));
        });
        await page.waitForTimeout(150);
        const selected = await page.evaluate(() =>
            document.querySelectorAll('.mindmap-node .is-selected, .mindmap-node.is-selected').length);
        expect(selected, 'Mindmap の全ノード選択が壊れた（回帰）').toBeGreaterThan(0);
    });
});

test.describe('TC-MSEL-21c HUD の記載が実挙動と一致する', () => {
    test('shortcut-list の Cmd+A の記載が 2 段階の実挙動と一致する（rev3）', async ({ page }) => {
        await setup(page);
        // 🔴 TASK-25 (QUAL-3): 旧実装は `w.ShortcutList.forSurface` を呼んでいたが
        // **`forSurface` は repo 全体で定義 0 件**（実 API は getList / categoryLabel / modeTitle / formatKeys）。
        // 常に undefined → groups が null → `test.skip(true, ...)` が必ず走り、直後の expect に
        // **一度も到達していなかった**（= HUD 文言の一致を「担保した」根拠が実在しなかった）。
        const listed = await page.evaluate(() => {
            const w = window as any;
            const groups = w.ShortcutList && typeof w.ShortcutList.getList === 'function'
                ? w.ShortcutList.getList('outliner') : null;
            if (!groups) { return null; }
            // FR-MSEL-06 rev3: HUD は「1 回目 = node の text / 2 回目 = 全 node」を説明する。
            // 旧文言 'Select all nodes' 単独は 1 段階前提なので実挙動と食い違う。
            const j = JSON.stringify(groups);
            return j.includes('Select node text') && j.includes('all nodes');
        });
        expect(listed, 'ShortcutList.getList がハーネスに無い（skip で逃げず配線の欠落として落とす）').not.toBe(null);
        expect(listed, 'HUD の記載が 2 段階の実挙動と一致していない（記載と実装の一致が本 TC の趣旨）').toBe(true);
    });
});

/**
 * TC-OSM-29（reviewer iteration 1 QUAL-2 / DESIGN-2 / TASK-22 / FR-OSM-06）:
 * mindmap 面の HUD は **1 段階の説明のまま**であること。
 *
 * FR-OSM-06 は「mindmap は Cmd+A の 2 段階 escalation から**免除**する」「mindmap 面のモード二態化 UI は
 * 本 sprint のスコープ外」と明記し、実装（`outliner.js` の `if (VIEW_MODE === 'mindmap') { selectAllNodes(); break; }`）も
 * 1 回押しで即全 node 選択のまま。ところが iteration 1 は `shortcut-list.js` の `Cmd+A` を grep して
 * `SHORTCUTS_OUTLINER` と `SHORTCUTS_MINDMAP` の**両方**を同じ 2 段階文言に書き換えてしまい、
 * mindmap ユーザーに "press again" という成立しない操作説明を表示していた。
 *
 * counterfactual（iteration 1）: mindmap 側が 'Select node text (again: all nodes) / undo'
 */
test.describe('TC-OSM-29 面別 HUD 文言（mindmap は 2 段階から免除）', () => {
    const cmdAdesc = async (page: Page, mode: string) => page.evaluate((m) => {
        const w = window as any;
        const groups = w.ShortcutList.getList(m);
        for (const g of groups) {
            for (const it of g.items) {
                if (/(^|\s)Cmd\+A(\s|$|\s*\/)/.test(it.keys)) { return it.desc as string; }
            }
        }
        return null;
    }, mode);

    test('mindmap の Cmd+A は 1 段階の説明 / outliner は 2 段階の説明', async ({ page }) => {
        await setup(page);
        const mm = await cmdAdesc(page, 'mindmap');
        const ol = await cmdAdesc(page, 'outliner');
        expect(mm, 'mindmap の Cmd+A エントリが見つからない').toBeTruthy();
        expect(ol, 'outliner の Cmd+A エントリが見つからない').toBeTruthy();

        expect(/again|press again/i.test(mm!),
            `mindmap の HUD が 2 段階の説明になっている（FR-OSM-06 は mindmap を免除している）: ${mm}`)
            .toBe(false);
        expect(/again/i.test(ol!),
            `outliner の HUD が 2 段階の説明になっていない: ${ol}`)
            .toBe(true);
    });
});
