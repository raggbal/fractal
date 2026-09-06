/**
 * 2026-09-04 ユーザー裁定 — Outliner の Cmd/Ctrl+Click 単品トグル選択（ADRL-0111・note tree / linkedfd と同型）
 * TC-MSEL-40..42。
 * 🔴 counterfactual: 実装前は cmd+click が通常 click と同じく clearSelection() で選択を消す（TC-MSEL-40 RED）。
 */
import { test, expect, Page } from '@playwright/test';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}
const TREE = {
    version: 1,
    rootIds: ['a', 'b', 'c', 'd'],
    nodes: { a: n('a', 'alpha'), b: n('b', 'bravo'), c: n('c', 'charlie'), d: n('d', 'delta') },
};

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, TREE);
    await page.waitForFunction(() => {
        const ae = document.activeElement as HTMLElement | null;
        return !!ae && ae !== document.body;
    }, undefined, { timeout: 5000 }).catch(() => { /* noop */ });
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
}
function selectedIds(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node.is-selected')).map((el) => (el as HTMLElement).dataset.id || ''));
}
/** node text に mousedown（修飾キー付き）を送る（本番の選択入口 = textEl の mousedown）。 */
async function mouseDown(page: Page, id: string, mods?: { shift?: boolean; meta?: boolean; ctrl?: boolean }): Promise<boolean> {
    return page.evaluate(({ i, m }) => {
        const el = document.querySelector(`.outliner-node[data-id="${i}"] .outliner-text`) as HTMLElement;
        const ev = new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0,
            shiftKey: !!m?.shift, metaKey: !!m?.meta, ctrlKey: !!m?.ctrl,
        });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
    }, { i: id, m: mods || {} });
}

test.describe('TC-MSEL-40 Cmd/Ctrl+Click で単品トグル', () => {
    test('加算 → 除外。preventDefault で caret を動かさない', async ({ page }) => {
        await setup(page);
        await page.locator('.outliner-node[data-id="a"] .outliner-text').click();
        expect(await mouseDown(page, 'c', { meta: true }), 'preventDefault されていない').toBe(true);
        expect(await selectedIds(page)).toEqual(['c']);
        await mouseDown(page, 'a', { ctrl: true });   // win/linux
        expect(await selectedIds(page)).toEqual(['a', 'c']);
        await mouseDown(page, 'c', { meta: true });   // 除外
        expect(await selectedIds(page)).toEqual(['a']);
        // 選択中の node id 集合（model 側）も一致
        const ids = await page.evaluate(() => Array.from((window as any).Outliner.getSelectedNodeIds?.() ?? []));
        if (ids.length) { expect(ids).toEqual(['a']); }
    });
});

test.describe('TC-MSEL-41 cmd+click 後の shift+click は直近のトグル node が anchor', () => {
    test('c を cmd+click → a を shift+click で a..c', async ({ page }) => {
        await setup(page);
        await page.locator('.outliner-node[data-id="d"] .outliner-text').click();
        await mouseDown(page, 'c', { meta: true });
        await mouseDown(page, 'a', { shift: true });
        expect(await selectedIds(page)).toEqual(['a', 'b', 'c']);
    });
});

test.describe('TC-MSEL-42 regression: 修飾なし click は従来どおり選択をクリア', () => {
    test('cmd+click で 2 件選んだ後、通常 mousedown で 0 件', async ({ page }) => {
        await setup(page);
        await mouseDown(page, 'b', { meta: true });
        await mouseDown(page, 'd', { meta: true });
        expect(await selectedIds(page)).toEqual(['b', 'd']);
        await mouseDown(page, 'a');
        expect(await selectedIds(page)).toEqual([]);
    });
});

test.describe('TC-MSEL-45 選択ハイライトは再描画（host の updateData 等）を跨いで残る', () => {
    test('cmd+click で 2 件選択 → updateData で renderTree → is-selected が付き直る', async ({ page }) => {
        await setup(page);
        await mouseDown(page, 'b', { meta: true });
        await mouseDown(page, 'd', { meta: true });
        expect(await selectedIds(page)).toEqual(['b', 'd']);
        // 実機: cmd を離した直後に host からの updateData（sync エコー / watcher）で renderTree が走り、
        // selectedNodeIds は残るのに `.is-selected` が付け直されず選択が見えなくなっていた（rc.4 ユーザー報告）
        await page.evaluate((t) => { (window as any).__hostMessageHandler({ type: 'updateData', data: t }); }, TREE);
        await page.waitForTimeout(150);
        expect(await selectedIds(page), '再描画で選択ハイライトが消えた').toEqual(['b', 'd']);
        // 消えた node の id は落ちる（stale id を残さない）
        const smaller = { version: 1, rootIds: ['a', 'b'], nodes: { a: n('a', 'alpha'), b: n('b', 'bravo') } };
        await page.evaluate((t) => { (window as any).__hostMessageHandler({ type: 'updateData', data: t }); }, smaller);
        await page.waitForTimeout(150);
        expect(await selectedIds(page)).toEqual(['b']);
    });
});
