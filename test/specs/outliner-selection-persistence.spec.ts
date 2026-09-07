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

    test('TC-MSC-10 rev2: Option / CapsLock の keydown では消えない（文字キーでも消えない = FR-MSC-02 rev2）', async ({ page }) => {
        await bootWithTwoSelected(page);
        await page.keyboard.press('Alt');
        await page.waitForTimeout(60);
        expect(await selIds(page)).toEqual(['b', 'c']);
        await page.keyboard.press('CapsLock');
        await page.waitForTimeout(60);
        expect(await selIds(page)).toEqual(['b', 'c']);

        // 🔄 FR-MSC-02 rev2（sprint 20260906-095357 / ADRL-0114）: **文字キーでも消えない**。
        //    選択モードでは printable キーは no-op（本文も選択も変えない）。
        //    旧契約「文字キーは選択をクリアする（編集開始 = 選択の意味が消える）」を supersede した。
        //    根拠: outliner は既定が編集モードで ↑↓ 1 つで戻れるため、選択モード中に文字を打つ意図が
        //    ほぼ存在せず、no-op が非破壊で正しい（md 表は既定が選択モードなので逆になる = 正当な非対称）。
        //    ⚠️ 上半分（修飾キー / lock キーでは消えない = 裁定 R31 の本体）は**変更していない**。
        await page.keyboard.press('x');
        await page.waitForTimeout(60);
        expect(await selIds(page), '文字キーで選択が消えた（FR-MSC-02 rev2 = printable は no-op）').toEqual(['b', 'c']);
    });

    test('TC-MSC-11 rev2: 修飾フラグ無しで届いた Meta の keydown でも消えない（文字キーでも消えない）', async ({ page }) => {
        await bootWithTwoSelected(page);
        // webview/Electron が focus 変化を挟んだときに観測される形（key='Meta' なのに metaKey=false）
        await dispatchKeydown(page, { key: 'Meta', code: 'MetaLeft', metaKey: false });
        expect(await selIds(page)).toEqual(['b', 'c']);
        await dispatchKeydown(page, { key: 'Control', code: 'ControlLeft', ctrlKey: false });
        expect(await selIds(page)).toEqual(['b', 'c']);

        // 🔄 FR-MSC-02 rev2: 同じ経路で文字キーが来ても**クリアされない**（printable は no-op）。
        //    「ガードが key 種別だけを見ている」ことの証拠としては、
        //    **修飾キー系が素通しされ printable が preventDefault される**（TC-OSM-05/06 が番人）ことで担保する。
        await dispatchKeydown(page, { key: 'a', code: 'KeyA' });
        expect(await selIds(page), '文字キーで選択が消えた（FR-MSC-02 rev2）').toEqual(['b', 'c']);
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

    test('TC-MSC-13 rev2: 選択トレースが「誰が消したか」を理由付きで残す（文字キーでは記録されない）', async ({ page }) => {
        await bootWithTwoSelected(page);
        // 選択の増加が記録されている
        const before = await page.evaluate(() => (window as any).__fractalSelTrace.get());
        expect(before.filter((r: any) => r.kind === 'toggle').length).toBeGreaterThanOrEqual(2);
        expect(before.some((r: any) => r.kind === 'keyup' && r.detail.indexOf('Meta') >= 0)).toBe(true);
        // keyup の時点では消えていない（n が 2 のまま）
        const lastKeyup = before.filter((r: any) => r.kind === 'keyup').pop();
        expect(lastKeyup.n).toBe(2);

        // 🔄 FR-MSC-02 rev2: 文字キーは no-op なので **clear が記録されない**。
        //    トレース機構自体（誰が消したかを理由付きで残す）は Escape で健在であることを見る。
        await page.keyboard.press('x');
        await page.waitForTimeout(60);
        const afterChar = await page.evaluate(() => (window as any).__fractalSelTrace.get());
        expect(afterChar.filter((r: any) => r.kind === 'clear').length,
            '文字キーで clear が記録された（printable は no-op なので何も起きないはず）').toBe(0);

        // Escape は明示分岐で解除し、理由付きでトレースに残る（FR-OSM-03 の出口 X1）
        await page.keyboard.press('Escape');
        await page.waitForTimeout(60);
        const after = await page.evaluate(() => (window as any).__fractalSelTrace.get());
        const clears = after.filter((r: any) => r.kind === 'clear');
        expect(clears.length, 'Escape で clear が 1 回記録されない').toBe(1);
        expect(clears[0].detail, 'clear の理由が記録されていない').toContain('Escape');
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
