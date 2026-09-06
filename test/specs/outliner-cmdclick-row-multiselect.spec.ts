/**
 * FR-MSC-01 (sprint 20260901-075849 / 裁定 R30):
 * Outliner の Cmd/Ctrl+Click 複数選択は「行のどこを掴んでも」効く。
 *
 * 報告バグ: cmd+click しても黄色（選択色）が付かないことがある / 色が付かない /
 *          青色（is-focused）になることがある。
 * 原因: 選択トグルが `.outliner-text` の mousedown にしか付いておらず、
 *       bullet / checkbox / subtext / scope ボタンを cmd+click すると
 *       トグルが走らないまま widget 側の click が発火 → focus が移って
 *       is-focused（水色）になる、checkbox なら値まで変わる。
 * 対策: treeEl の capture 段階で mousedown / click を先取りして選択トグルへ振る。
 *       ただし cmd+click に既存の別意味がある 📄 page icon（FR-CT-03 新規タブ）/
 *       📎 file icon / a[href] は従来動作を維持する。
 */

import { test, expect } from '@playwright/test';

const DOC = {
    version: 1,
    rootIds: ['a', 'b', 'c', 'f', 'g', 'p'],
    nodes: {
        a: { id: 'a', parentId: null, children: [], text: 'Alpha', tags: [] },
        b: { id: 'b', parentId: null, children: [], text: 'Bravo', tags: [] },
        c: { id: 'c', parentId: null, children: ['c1'], text: 'Charlie', tags: [] },
        c1: { id: 'c1', parentId: 'c', children: [], text: 'Charlie child', tags: [] },
        f: { id: 'f', parentId: null, children: [], text: 'Foxtrot', subtext: 'note line', tags: [] },
        g: { id: 'g', parentId: null, children: [], text: 'Golf', checked: false, tags: [] },
        p: { id: 'p', parentId: null, children: [], text: 'Page node', isPage: true, pageId: 'pg1', tags: [] }
    }
};

const SUBTEXT_F = '.outliner-node[data-id="f"] .outliner-subtext';
const BULLET_C = '.outliner-node[data-id="c"] .outliner-bullet';
const CHECKBOX_G = '.outliner-node[data-id="g"] .outliner-checkbox';
const SCOPE_F = '.outliner-node[data-id="f"] .outliner-scope-btn';

async function boot(page: any) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((doc: any) => { (window as any).__testApi.initOutliner(doc); }, DOC);
    // 編集フォーカスを a に置く（cmd+click が focus を奪わないことの観測点）
    await page.locator('.outliner-node[data-id="a"] .outliner-text').click();
}
const selIds = (page: any) => page.evaluate(() =>
    Array.from(document.querySelectorAll('.outliner-node.is-selected')).map(e => (e as HTMLElement).dataset.id));
const focIds = (page: any) => page.evaluate(() =>
    Array.from(document.querySelectorAll('.outliner-node.is-focused')).map(e => (e as HTMLElement).dataset.id));
const rowCount = (page: any) => page.locator('.outliner-node').count();

async function clickAt(page: any, selector: string, opts: { meta?: boolean; frac?: number } = {}) {
    const bb = await page.locator(selector).first().boundingBox();
    expect(bb, 'target must be present: ' + selector).toBeTruthy();
    const x = bb!.x + bb!.width * (opts.frac === undefined ? 0.5 : opts.frac);
    const y = bb!.y + bb!.height / 2;
    if (opts.meta) { await page.keyboard.down('Meta'); }
    await page.mouse.click(x, y);
    if (opts.meta) { await page.keyboard.up('Meta'); }
    await page.waitForTimeout(60);
}

test.describe('FR-MSC-01 cmd+click は行のどこでも複数選択', () => {

    test('TC-MSC-01: subtext を cmd+click → その node が選択される（通常 click では選択されない）', async ({ page }) => {
        await boot(page);
        await clickAt(page, SUBTEXT_F, { meta: true });
        expect(await selIds(page)).toEqual(['f']);
        expect(await focIds(page)).toEqual(['a']);   // 編集フォーカスは奪われない
        // cmd+click では subtext 編集モードに入らない
        expect(await page.locator(SUBTEXT_F).evaluate((e: Element) => e.classList.contains('is-editing'))).toBe(false);

        // 反実仮想: 修飾なし click では選択されない（subtext は cmd 修飾だけが選択契機）
        await boot(page);
        await clickAt(page, SUBTEXT_F, {});
        expect(await selIds(page)).toEqual([]);
        expect(await focIds(page)).toEqual(['a']);
    });

    test('TC-MSC-02: bullet を cmd+click → 選択されるだけで折りたたまれない（通常 click は折りたたむ）', async ({ page }) => {
        await boot(page);
        const before = await rowCount(page);
        await clickAt(page, BULLET_C, { meta: true });
        expect(await selIds(page)).toEqual(['c']);
        expect(await rowCount(page)).toBe(before);   // c1 は消えていない

        // 反実仮想: 修飾なし click は折りたたむ（= 行数が減る）
        await boot(page);
        await clickAt(page, BULLET_C, {});
        expect(await rowCount(page)).toBe(before - 1);
        expect(await selIds(page)).toEqual([]);
    });

    test('TC-MSC-03: checkbox を cmd+click → 選択されるだけで checked が変わらない（通常 click は変わる）', async ({ page }) => {
        await boot(page);
        const checked = () => page.locator(CHECKBOX_G + ' input').isChecked();
        expect(await checked()).toBe(false);
        await clickAt(page, CHECKBOX_G, { meta: true });
        expect(await selIds(page)).toEqual(['g']);
        expect(await checked()).toBe(false);

        // 反実仮想: 修飾なし click は checked をトグルし、選択は作らない
        await boot(page);
        await clickAt(page, CHECKBOX_G, {});
        expect(await checked()).toBe(true);
        expect(await selIds(page)).toEqual([]);
    });

    test('TC-MSC-04: scope ボタンを cmd+click → 選択されるだけでスコープが変わらない（通常 click は絞り込む）', async ({ page }) => {
        await boot(page);
        const before = await rowCount(page);
        await clickAt(page, SCOPE_F, { meta: true });
        expect(await selIds(page)).toEqual(['f']);
        expect(await rowCount(page)).toBe(before);

        // 反実仮想: 修飾なし click は subtree scope に入る（表示行が減る）
        await boot(page);
        await clickAt(page, SCOPE_F, {});
        expect(await rowCount(page)).toBeLessThan(before);
    });

    test('TC-MSC-05: text / subtext / bullet をまたいで積み上がり、Cmd を離しても選択は残る', async ({ page }) => {
        await boot(page);
        await page.keyboard.down('Meta');
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        const fb = (await page.locator(SUBTEXT_F).boundingBox())!;
        await page.mouse.click(fb.x + 4, fb.y + fb.height / 2);
        const gb = (await page.locator('.outliner-node[data-id="g"] .outliner-bullet').boundingBox())!;
        await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2);
        expect((await selIds(page)).sort()).toEqual(['b', 'f', 'g']);

        // Cmd 解放 → 選択は保持される（keyup で解除されない）
        await page.keyboard.up('Meta');
        await page.waitForTimeout(400);
        expect((await selIds(page)).sort()).toEqual(['b', 'f', 'g']);

        // 同じ zone を再 cmd+click → その node だけ解除
        await page.keyboard.down('Meta');
        await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2);
        await page.keyboard.up('Meta');
        expect((await selIds(page)).sort()).toEqual(['b', 'f']);
    });

    test('TC-MSC-06: cmd+click は focus を奪わず、選択色は focus 色・非選択色と別色', async ({ page }) => {
        await boot(page);
        await clickAt(page, SUBTEXT_F, { meta: true, frac: 0.1 });
        expect(await focIds(page)).toEqual(['a']);   // 青（is-focused）は移らない
        const bg = (id: string) => page.evaluate((nid: string) =>
            getComputedStyle(document.querySelector('.outliner-node[data-id="' + nid + '"]')!).backgroundColor, id);
        const selectedBg = await bg('f');
        const focusedBg = await bg('a');
        const plainBg = await bg('b');
        expect(selectedBg).not.toBe(focusedBg);
        expect(selectedBg).not.toBe(plainBg);
    });

    test('TC-MSC-07: 📄 page icon の cmd+click は従来どおり新規タブ（選択は作らない・FR-CT-03 非退行）', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
        await clickAt(page, '.outliner-node[data-id="p"] .outliner-page-icon', { meta: true });
        const types = await page.evaluate(() => (window as any).__testApi.messages.map((m: any) => m.type));
        expect(types).toContain('openPageInTab');
        expect(await selIds(page)).toEqual([]);
    });

    test('TC-MSC-08: 修飾なし click は従来どおり複数選択をクリアする', async ({ page }) => {
        await boot(page);
        await page.keyboard.down('Meta');
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        await page.locator('.outliner-node[data-id="f"] .outliner-text').click();
        await page.keyboard.up('Meta');
        expect((await selIds(page)).sort()).toEqual(['b', 'f']);
        await page.locator('.outliner-node[data-id="c"] .outliner-text').click();
        expect(await selIds(page)).toEqual([]);
        expect(await focIds(page)).toEqual(['c']);
    });
});
