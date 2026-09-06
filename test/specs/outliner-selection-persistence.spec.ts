/**
 * FR-MSC-02 (sprint 20260901-075849 / 裁定 R31):
 * cmd+click で作った複数選択は「文字も移動も生まないキー」では消えない。
 *
 * 報告バグ: 「outliner で CMD+CLICK すると複数選択できるが、**CMD を離すと複数選択が解除される**」。
 * 調査: keyup を listen して選択に触るコードは存在しない（`shortcut-hud.js` の keyup は HUD ログのみ）。
 *       一方 `handleNodeKeydown` の「選択中に修飾なしキーが来たら clearSelection」判定は
 *       `!e.shiftKey && !e.metaKey && !e.ctrlKey` しか見ておらず、
 *         - 修飾キー自身の keydown が押下フラグ無しで届くケース（webview/Electron で focus 変化を
 *           挟むと Meta の keydown が metaKey=false で来る）
 *         - Option / CapsLock / 英数・かな（IME モード切替）の keydown（altKey は判定対象外）
 *       で複数選択を落としていた。= 「離した瞬間に消えた」に見える機序。
 * 対策: 文字も移動も生まない key（修飾キー / lock / IME モードキー / dead key / composing 中）では
 *       選択に触らない。併せて選択の増減・消滅を理由付きで記録する選択トレースを入れ、
 *       実機で機序を特定できるようにした（Cmd/Ctrl+Shift+Alt+S でオーバーレイ表示）。
 */

import { test, expect } from '@playwright/test';

const DOC = {
    version: 1,
    rootIds: ['a', 'b', 'c'],
    nodes: {
        a: { id: 'a', parentId: null, children: [], text: 'Alpha', tags: [] },
        b: { id: 'b', parentId: null, children: [], text: 'Bravo', tags: [] },
        c: { id: 'c', parentId: null, children: [], text: 'Charlie', tags: [] }
    }
};

const selIds = (page: any) => page.evaluate(() =>
    Array.from(document.querySelectorAll('.outliner-node.is-selected')).map(e => (e as HTMLElement).dataset.id));

/** node a の text に編集フォーカスを置いた上で b / c を cmd+click して 2 件選択する */
async function bootWithTwoSelected(page: any) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((doc: any) => { (window as any).__testApi.initOutliner(doc); }, DOC);
    await page.locator('.outliner-node[data-id="a"] .outliner-text').click();
    await page.keyboard.down('Meta');
    await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
    await page.locator('.outliner-node[data-id="c"] .outliner-text').click();
    await page.keyboard.up('Meta');
    await page.waitForTimeout(60);
    expect(await selIds(page)).toEqual(['b', 'c']);
    // 編集フォーカスは a のまま = 以後の keydown は a の textEl に届く（clear 判定が走る経路）
    expect(await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.closest('.outliner-node')?.getAttribute('data-id'))).toBe('a');
}

/** activeElement へ keydown を直接投げる（実キーでは作れない修飾フラグの組み合わせを再現する） */
async function dispatchKeydown(page: any, init: Record<string, unknown>) {
    await page.evaluate((opts: any) => {
        const el = (document.activeElement || document.body) as HTMLElement;
        el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts)));
    }, init);
    await page.waitForTimeout(60);
}

test.describe('FR-MSC-02 複数選択はキーの押し離しで壊れない', () => {

    test('TC-MSC-09: Meta を押して離しても複数選択が残る', async ({ page }) => {
        await bootWithTwoSelected(page);
        await page.keyboard.down('Meta');
        await page.waitForTimeout(80);
        await page.keyboard.up('Meta');
        await page.waitForTimeout(200);
        expect(await selIds(page)).toEqual(['b', 'c']);
    });

    test('TC-MSC-10: Option / CapsLock の keydown では消えない（文字キーでは消える）', async ({ page }) => {
        await bootWithTwoSelected(page);
        await page.keyboard.press('Alt');
        await page.waitForTimeout(60);
        expect(await selIds(page)).toEqual(['b', 'c']);
        await page.keyboard.press('CapsLock');
        await page.waitForTimeout(60);
        expect(await selIds(page)).toEqual(['b', 'c']);

        // 反実仮想: 文字キーは従来どおり選択をクリアする（編集開始 = 選択の意味が消える）
        await page.keyboard.press('x');
        await page.waitForTimeout(60);
        expect(await selIds(page)).toEqual([]);
    });

    test('TC-MSC-11: 修飾フラグ無しで届いた Meta の keydown でも消えない（文字キー相当なら消える）', async ({ page }) => {
        await bootWithTwoSelected(page);
        // webview/Electron が focus 変化を挟んだときに観測される形（key='Meta' なのに metaKey=false）
        await dispatchKeydown(page, { key: 'Meta', code: 'MetaLeft', metaKey: false });
        expect(await selIds(page)).toEqual(['b', 'c']);
        await dispatchKeydown(page, { key: 'Control', code: 'ControlLeft', ctrlKey: false });
        expect(await selIds(page)).toEqual(['b', 'c']);

        // 反実仮想: 同じ経路で文字キーが来たときはクリアされる（ガードが key 種別だけを見ている証拠）
        await dispatchKeydown(page, { key: 'a', code: 'KeyA' });
        expect(await selIds(page)).toEqual([]);
    });

    test('TC-MSC-12: IME モードキー / composing 中の keydown では消えない', async ({ page }) => {
        await bootWithTwoSelected(page);
        await dispatchKeydown(page, { key: 'Eisu', code: 'Lang2' });
        expect(await selIds(page)).toEqual(['b', 'c']);
        await dispatchKeydown(page, { key: 'KanaMode', code: 'Lang1' });
        expect(await selIds(page)).toEqual(['b', 'c']);
        await dispatchKeydown(page, { key: 'a', code: 'KeyA', isComposing: true });
        expect(await selIds(page)).toEqual(['b', 'c']);
    });

    test('TC-MSC-13: 選択トレースが「誰が消したか」を理由付きで残す', async ({ page }) => {
        await bootWithTwoSelected(page);
        // 選択の増加が記録されている
        const before = await page.evaluate(() => (window as any).__fractalSelTrace.get());
        expect(before.filter((r: any) => r.kind === 'toggle').length).toBeGreaterThanOrEqual(2);
        expect(before.some((r: any) => r.kind === 'keyup' && r.detail.indexOf('Meta') >= 0)).toBe(true);
        // keyup の時点では消えていない（n が 2 のまま）
        const lastKeyup = before.filter((r: any) => r.kind === 'keyup').pop();
        expect(lastKeyup.n).toBe(2);

        await page.keyboard.press('x');
        await page.waitForTimeout(60);
        const after = await page.evaluate(() => (window as any).__fractalSelTrace.get());
        const clears = after.filter((r: any) => r.kind === 'clear');
        expect(clears.length).toBe(1);
        expect(clears[0].detail).toContain('keydown:x');
    });

    test('TC-MSC-14: Cmd+Shift+Alt+S でトレース overlay をトグルでき、選択は壊れない', async ({ page }) => {
        await bootWithTwoSelected(page);
        expect(await page.locator('#fr-sel-trace').count()).toBe(0);
        await page.keyboard.press('Meta+Shift+Alt+s');
        await page.waitForTimeout(80);
        expect(await page.locator('#fr-sel-trace').count()).toBe(1);
        expect(await selIds(page)).toEqual(['b', 'c']);
        // overlay の中身に選択の履歴が出ている
        expect(await page.locator('#fr-sel-trace').innerText()).toContain('toggle');
        await page.keyboard.press('Meta+Shift+Alt+s');
        await page.waitForTimeout(80);
        expect(await page.locator('#fr-sel-trace').count()).toBe(0);
        expect(await selIds(page)).toEqual(['b', 'c']);
    });
});
