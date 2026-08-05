/**
 * TC-B6B-01〜06 — FR-B06b: cmd（mac meta / win ctrl）単独長押し 800ms でショートカット一覧 HUD。
 *
 * standalone editor / outliner / notes で実 DOM + 実 keydown/keyup を使う。
 * タイマーは window.__shortcutHudDelayMs で短縮（実時間 800ms を待たずに決定的に検証）。
 */
import { test, expect, Page } from '@playwright/test';

const HUD_SEL = '#fractal-shortcut-hud';

async function bootEditor(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // タイマーを短縮（HUD init は既に module scope で走っているが、init は _getDelayMs() を
    // 発火時に読むため、ここで上書きすれば以降の keydown に効く）。
    await page.evaluate(() => { (window as any).__shortcutHudDelayMs = 60; });
}

async function bootOutliner(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => { (window as any).__shortcutHudDelayMs = 60; });
}

async function bootNotes(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => { (window as any).__shortcutHudDelayMs = 60; });
}

test.describe('cmd 長押しショートカット HUD (FR-B06b)', () => {
    // TC-B6B-01: Meta keydown → 800ms(短縮) 経過 → HUD 表示
    test('TC-B6B-01 Meta 長押しで HUD が表示される', async ({ page }) => {
        await bootEditor(page);
        // 押下前は HUD なし
        expect(await page.locator(HUD_SEL).count()).toBe(0);
        await page.keyboard.down('Meta');
        // 遅延経過を待つ
        await page.waitForTimeout(150);
        const hud = page.locator(HUD_SEL);
        await expect(hud).toHaveCount(1);
        await expect(hud).toBeVisible();
        // 中身: md リストの代表項目（Bold）が出ている
        const text = await hud.textContent();
        expect(text || '').toContain('Bold');
        await page.keyboard.up('Meta');
    });

    // TC-B6B-02: keyup で消える
    test('TC-B6B-02 Meta を離すと HUD が消える', async ({ page }) => {
        await bootEditor(page);
        await page.keyboard.down('Meta');
        await page.waitForTimeout(150);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        await page.keyboard.up('Meta');
        await expect(page.locator(HUD_SEL)).toHaveCount(0);
    });

    // TC-B6B-03: 800ms 以内に他キー（cmd+B 等）→ HUD 出ない
    //   ★ counterfactual: 他キーでのキャンセルロジックを外すと、Meta 長押し継続で HUD が出てしまう = RED 構造
    test('TC-B6B-03 Meta 長押し中に他キーを押すと HUD は出ない', async ({ page }) => {
        await bootEditor(page);
        await page.keyboard.down('Meta');
        // 遅延満了前に他キー（cmd+B）を押す → タイマーキャンセル
        await page.waitForTimeout(20);
        await page.keyboard.press('b');
        await page.waitForTimeout(150);
        // HUD は出ていない
        expect(await page.locator(HUD_SEL).count()).toBe(0);
        await page.keyboard.up('Meta');
    });

    // TC-B6B-04: standalone outliner でも表示され、内容が SHORTCUTS_OUTLINER 由来
    //   （md と違うリスト = outliner 固有 desc「New sibling node」で判別）
    test('TC-B6B-04 outliner では outliner 用リストが表示される', async ({ page }) => {
        await bootOutliner(page);
        await page.keyboard.down('Meta');
        await page.waitForTimeout(150);
        const hud = page.locator(HUD_SEL);
        await expect(hud).toHaveCount(1);
        const text = (await hud.textContent()) || '';
        // outliner 固有（md リストには無い）
        expect(text).toContain('New sibling node');
        // md 固有（outliner リストには無い）が出ていないこと
        expect(text).not.toContain('Toggle source mode');
        await page.keyboard.up('Meta');
    });

    // TC-B6B-05: standalone notes（editor.js + outliner.js 両ロード）で HUD が 1 個だけ（二重 init ガード）
    test('TC-B6B-05 notes で HUD は 1 個だけ（二重 init ガード）', async ({ page }) => {
        await bootNotes(page);
        await page.keyboard.down('Meta');
        await page.waitForTimeout(150);
        // 両スクリプトがロードされても HUD は 1 個
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        await page.keyboard.up('Meta');
    });

    // TC-B6B-06: blur で消える（cmd+tab でアプリ切替すると keyup が来ない）
    test('TC-B6B-06 window blur で HUD が消える', async ({ page }) => {
        await bootEditor(page);
        await page.keyboard.down('Meta');
        await page.waitForTimeout(150);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        // window blur を発火
        await page.evaluate(() => { window.dispatchEvent(new Event('blur')); });
        await expect(page.locator(HUD_SEL)).toHaveCount(0);
        await page.keyboard.up('Meta');
    });

    // TC-B6B-07 (TASK-10 / review iteration 1): 純 standalone md editor 相当の i18n 経路 —
    // __outlinerMessages が無い環境でも __shortcutHudMessages（webviewContent.ts が注入）から
    // カテゴリ見出しが localize される。HUD は showHud() のたびに _buildHudEl で再構築されるため
    // 表示前に global を差し込めば効く。
    test('TC-B6B-07 __shortcutHudMessages fallback でカテゴリ見出しが localize される', async ({ page }) => {
        await bootEditor(page);
        // standalone-editor には __outlinerMessages が無いことが前提（純 standalone md 相当）
        const hasOutlinerMsgs = await page.evaluate(() => !!(window as any).__outlinerMessages);
        expect(hasOutlinerMsgs, 'standalone-editor は __outlinerMessages 非注入').toBe(false);
        await page.evaluate(() => {
            (window as any).__shortcutHudMessages = { shortcutCatEditing: '編集テスト見出し' };
        });
        await page.keyboard.down('Meta');
        await page.waitForTimeout(150);
        const text = await page.locator(HUD_SEL).textContent();
        // counterfactual: _resolveMessages が __shortcutHudMessages を見ないと英語 fallback
        //（'Editing'）になり RED
        expect(text || '').toContain('編集テスト見出し');
        await page.keyboard.up('Meta');
    });
});
