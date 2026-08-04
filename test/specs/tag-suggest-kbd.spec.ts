/**
 * FR-TK-01: tag サジェストバーのキーボード roving（フォーカスは input に置いたまま）
 *
 * Search box フォーカス中に tag サジェストバーが出ているとき:
 *   ↓        : サジェストへ入る（1 個目をハイライト）。input のフォーカスは維持。
 *   ← / →    : ハイライト移動（端で停止・循環しない）。index=-1 は素通し（input カーソル移動）。
 *   Enter    : ハイライト中の tag を Search box へ反映（既存 click と同規則 = 空白区切り追記）+ 解除。
 *   ↑ / Esc  : ハイライト解除のみ（選択中のみ横取り。非選択時は Esc の既存挙動）。
 *   再描画/入力 : roving state（.kbd-active）をリセット（stale 防止）。
 *
 * 対象TC: TC-TK-01〜05（design/system.md §4）
 * 3 view 共有ヘッダのため mindmap view でも同一動作（NFR-TK/TS-01）を 1 点踏む。
 */

import { test, expect } from '@playwright/test';

// count が同数（1 個ずつ）だと computeAllTagsSorted は tag.localeCompare 昇順で並ぶ
// → 予測可能な順序: #alpha, #beta, #gamma
const FIXTURE = {
    version: 1,
    rootIds: ['n1', 'n2', 'n3'],
    nodes: {
        n1: { id: 'n1', parentId: null, children: [], text: 'task one #alpha', tags: ['#alpha'] },
        n2: { id: 'n2', parentId: null, children: [], text: 'task two #beta', tags: ['#beta'] },
        n3: { id: 'n3', parentId: null, children: [], text: 'task three #gamma', tags: ['#gamma'] },
    },
};

async function loadFixture(page: any) {
    await page.evaluate((data: any) => {
        (window as any).__testApi.initOutliner(data);
    }, FIXTURE);
    // suggest bar は search input focus で出る
    await page.locator('.outliner-search-input').focus();
    // 3 個の item が描画されるまで待つ
    await page.waitForFunction(() => {
        const bar = document.querySelector('.outliner-tag-suggest-bar') as HTMLElement;
        return bar && bar.style.display !== 'none' &&
            bar.querySelectorAll('.outliner-tag-suggest-item').length === 3;
    });
}

/** ハイライト中の item index（0 始まり）。0 個なら -1。 */
async function activeIndex(page: any): Promise<number> {
    return await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.outliner-tag-suggest-item'));
        return items.findIndex((el) => el.classList.contains('kbd-active'));
    });
}

/** ハイライト中の item 数。 */
async function activeCount(page: any): Promise<number> {
    return await page.evaluate(() =>
        document.querySelectorAll('.outliner-tag-suggest-item.kbd-active').length);
}

async function searchValue(page: any): Promise<string> {
    return await page.evaluate(() => {
        const input = document.querySelector('.outliner-search-input') as HTMLInputElement;
        return input ? input.value : '';
    });
}

async function activeElementIsSearchInput(page: any): Promise<boolean> {
    return await page.evaluate(() =>
        document.activeElement === document.querySelector('.outliner-search-input'));
}

test.describe('FR-TK-01: tag suggest bar keyboard roving', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-TK-01: ↓ で 1 個目がハイライト・フォーカスは input のまま', async ({ page }) => {
        await loadFixture(page);
        const input = page.locator('.outliner-search-input');

        // ↓
        await input.press('ArrowDown');

        expect(await activeCount(page)).toBe(1);
        expect(await activeIndex(page)).toBe(0);
        // roving 方式: DOM フォーカスは input のまま（視覚ハイライトのみ移動）
        expect(await activeElementIsSearchInput(page)).toBe(true);
    });

    test('TC-TK-02: → ×2 で 3 個目・さらに → しても 3 個目のまま（端で停止）', async ({ page }) => {
        await loadFixture(page);
        const input = page.locator('.outliner-search-input');

        await input.press('ArrowDown'); // index 0
        await input.press('ArrowRight'); // index 1
        await input.press('ArrowRight'); // index 2 (最後)
        expect(await activeIndex(page)).toBe(2);

        // 端で → しても循環せず 2 のまま
        await input.press('ArrowRight');
        expect(await activeIndex(page)).toBe(2);
        expect(await activeCount(page)).toBe(1);
    });

    test('TC-TK-03: Enter で該当 tag を box に追記（既存値 + 空白区切り）+ ハイライト解除', async ({ page }) => {
        await loadFixture(page);
        const input = page.locator('.outliner-search-input');

        // ↓ → で 2 個目(#beta)を選択
        await input.press('ArrowDown'); // index 0 = #alpha
        await input.press('ArrowRight'); // index 1 = #beta
        expect(await activeIndex(page)).toBe(1);

        // Enter → box に反映
        await input.press('Enter');

        expect(await searchValue(page)).toBe('#beta');
        // ハイライトは解除
        expect(await activeCount(page)).toBe(0);
    });

    test('TC-TK-03b: 既存値がある状態で Enter → 空白区切りで追記', async ({ page }) => {
        await loadFixture(page);
        const input = page.locator('.outliner-search-input');

        // 既存値を入力（この入力自体は roving をリセットするが、その後 ↓ で入り直す）
        await input.fill('keyword');
        // fill 後もバーは表示のまま（入力で hide しない）。再度 ↓ で roving へ。
        await page.waitForFunction(() => {
            const bar = document.querySelector('.outliner-tag-suggest-bar') as HTMLElement;
            return bar && bar.style.display !== 'none' &&
                bar.querySelectorAll('.outliner-tag-suggest-item').length === 3;
        });
        await input.press('ArrowDown'); // index 0 = #alpha
        await input.press('Enter');

        expect(await searchValue(page)).toBe('keyword #alpha');
        expect(await activeCount(page)).toBe(0);
    });

    test('TC-TK-04: Esc / ↑ でハイライト解除・値不変。バー非表示時の ↓ は no-op', async ({ page }) => {
        await loadFixture(page);
        const input = page.locator('.outliner-search-input');

        // --- Esc ---
        await input.press('ArrowDown'); // index 0
        expect(await activeIndex(page)).toBe(0);
        await input.press('Escape');
        expect(await activeCount(page)).toBe(0);       // ハイライト解除
        expect(await searchValue(page)).toBe('');       // 値不変
        // Esc で clearSearch が走っても value は空のまま（元々空）。バーは focus 中なので依然表示され得る。

        // --- ↑ ---
        // 再度 ↓ で入る（バーが再描画されても index は 0 に入れ直せる）
        await input.focus();
        await page.waitForFunction(() => {
            const bar = document.querySelector('.outliner-tag-suggest-bar') as HTMLElement;
            return bar && bar.style.display !== 'none' &&
                bar.querySelectorAll('.outliner-tag-suggest-item').length === 3;
        });
        await input.press('ArrowDown'); // index 0
        expect(await activeIndex(page)).toBe(0);
        await input.press('ArrowUp');
        expect(await activeCount(page)).toBe(0);
        expect(await searchValue(page)).toBe('');

        // --- バー非表示時の ↓ は no-op（tag 0 個の .out）---
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['e1'],
                nodes: { e1: { id: 'e1', parentId: null, children: [], text: 'no tags here', tags: [] } },
            });
        });
        // blur→focus で focus ハンドラを再発火させ、新しい（空）tag セットでバーを再描画させる
        await input.blur();
        await input.focus();
        await page.waitForTimeout(50);
        // バーは非表示（tag 0）
        expect(await page.evaluate(() => {
            const bar = document.querySelector('.outliner-tag-suggest-bar') as HTMLElement;
            return bar ? bar.style.display : null;
        })).toBe('none');
        await input.press('ArrowDown');
        // 何も起きない（ハイライト 0・値不変）
        expect(await activeCount(page)).toBe(0);
        expect(await searchValue(page)).toBe('');
    });

    test('TC-TK-05: 選択中に 1 文字入力（再描画）で stale ハイライトが消える', async ({ page }) => {
        await loadFixture(page);
        const input = page.locator('.outliner-search-input');

        await input.press('ArrowDown'); // index 0
        expect(await activeIndex(page)).toBe(0);

        // 実ユーザー入力（1 文字）→ roving リセット
        await input.pressSequentially('x');

        expect(await activeCount(page)).toBe(0);
    });

    test('TC-TK-05b: mindmap view でも roving が効く（共有ヘッダ・view 非依存）', async ({ page }) => {
        await loadFixture(page);
        // mindmap view に切替
        await page.evaluate(() => { (window as any).Outliner.setViewMode('mindmap'); });
        const input = page.locator('.outliner-search-input');
        await input.focus();
        await page.waitForFunction(() => {
            const bar = document.querySelector('.outliner-tag-suggest-bar') as HTMLElement;
            return bar && bar.style.display !== 'none' &&
                bar.querySelectorAll('.outliner-tag-suggest-item').length === 3;
        });

        // ↓ → Enter が mindmap の Enter 早期 return より前に処理される
        await input.press('ArrowDown'); // index 0 = #alpha
        expect(await activeIndex(page)).toBe(0);
        await input.press('ArrowRight'); // index 1 = #beta
        await input.press('Enter');

        expect(await searchValue(page)).toBe('#beta');
        expect(await activeCount(page)).toBe(0);
    });
});

test.describe('TASK-03: ロード時の tags 再計算（未編集 node のタグ欠落バグ）', () => {
    // TC-TK-06: node.tags は編集確定（updateText）時にのみ保存されるため、
    //   tags フィールドを持たない .out（旧形式・外部ツール由来・未編集 node）を
    //   ロードすると #tag がサジェストにも #tag 検索にも出なかった。
    //   修正 = constructor（_ensureChildren）で全 node の tags を text から常に再計算。
    //   counterfactual: 再計算を外す（修正前）と missing/stale の 2 tag が出ず
    //   suggest item は 1 個だけ = 本 TC の期待 3 個に対し RED（実装前に実測済み）。
    test('TC-TK-06: tags フィールド欠落/stale の .out でも全 #tag がサジェストされる', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);

        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['m1', 'm2', 'm3'],
                nodes: {
                    // tags フィールド欠落（未編集 node / 旧 .out 相当）
                    m1: { id: 'm1', parentId: null, children: [], text: 'db choice #db' },
                    // tags が stale（外部編集で text は変わったが tags は旧値のまま）
                    m2: { id: 'm2', parentId: null, children: [], text: 'event bus #async', tags: ['#old-stale'] },
                    // tags 正常保存済み
                    m3: { id: 'm3', parentId: null, children: [], text: 'api #backend', tags: ['#backend'] },
                },
            });
        });
        await page.locator('.outliner-search-input').focus();
        await page.waitForFunction(() => {
            const bar = document.querySelector('.outliner-tag-suggest-bar') as HTMLElement;
            return bar && bar.style.display !== 'none';
        });

        const suggested = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-tag-suggest-item')).map((el) => el.textContent)
        );
        // 欠落分（#db）・stale の実 text 分（#async）・正常分（#backend）がすべて出る。
        // stale の旧値（#old-stale）は text に無いので出ない（text が単一真実）。
        expect(suggested).toContain('#db');
        expect(suggested).toContain('#async');
        expect(suggested).toContain('#backend');
        expect(suggested).not.toContain('#old-stale');

        // #tag 検索も同じ tags を使うため、欠落していた tag で検索がヒットする。
        await page.locator('.outliner-search-input').fill('#db');
        await page.waitForTimeout(300);
        const visibleTexts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-node:not([style*="display: none"]) .outliner-text'))
                .map((el) => el.textContent || '')
        );
        expect(visibleTexts.some((t) => t.includes('db choice'))).toBe(true);
    });
});
