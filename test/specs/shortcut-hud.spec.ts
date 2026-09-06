/**
 * TC-B6B-01〜08 — FR-B06b: ショートカット一覧 HUD。
 *
 * rev2（2026-09-04 ユーザー裁定）: トリガーを **Cmd+Shift+/（= Cmd+?。Win: Ctrl+Shift+/）の表示トグル**に変更。
 * 旧「cmd 単独長押し 800ms」は cmd+click 複数選択（note tree / outliner / linkedfd）と干渉するため廃止
 *（TC-B6B-08 が「Meta 長押しでは出ない」を pin）。`Cmd+/` は md editor のアクションパレットが使用中なので Shift 付き。
 *
 * standalone editor / outliner / notes で実 DOM + 実 keydown を使う。
 */
import { test, expect, Page } from '@playwright/test';

const HUD_SEL = '#fractal-shortcut-hud';
const TOGGLE = 'Meta+Shift+Slash';

async function bootEditor(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
async function bootOutliner(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
async function bootNotes(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

test.describe('ショートカット HUD — Cmd+Shift+/ トグル (FR-B06b rev2)', () => {
    test('TC-B6B-01 Cmd+Shift+/ で HUD が表示され、キーを離しても残る', async ({ page }) => {
        await bootEditor(page);
        expect(await page.locator(HUD_SEL).count()).toBe(0);
        await page.keyboard.press(TOGGLE);
        const hud = page.locator(HUD_SEL);
        await expect(hud).toHaveCount(1);
        await expect(hud).toBeVisible();
        expect((await hud.textContent()) || '').toContain('Bold');
        // 旧方式との差: キーを離した後（press は down+up）も表示が残る
        await page.waitForTimeout(150);
        await expect(hud).toHaveCount(1);
    });

    test('TC-B6B-02 もう一度 Cmd+Shift+/ で閉じる / Esc でも閉じる', async ({ page }) => {
        await bootEditor(page);
        await page.keyboard.press(TOGGLE);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        await page.keyboard.press(TOGGLE);
        await expect(page.locator(HUD_SEL)).toHaveCount(0);
        await page.keyboard.press(TOGGLE);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator(HUD_SEL)).toHaveCount(0);
    });

    test('TC-B6B-03 表示中に他キー（文字）を押すと閉じる。修飾キー単独の押下では閉じない', async ({ page }) => {
        await bootEditor(page);
        await page.keyboard.press(TOGGLE);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        await page.keyboard.down('Shift');
        await page.waitForTimeout(30);
        await expect(page.locator(HUD_SEL), 'Shift 単独で消えた').toHaveCount(1);
        await page.keyboard.up('Shift');
        await page.keyboard.press('b');
        await expect(page.locator(HUD_SEL)).toHaveCount(0);
    });

    test('TC-B6B-04 outliner では outliner 用リストが表示される', async ({ page }) => {
        await bootOutliner(page);
        await page.keyboard.press(TOGGLE);
        const hud = page.locator(HUD_SEL);
        await expect(hud).toHaveCount(1);
        const text = (await hud.textContent()) || '';
        expect(text).toContain('New sibling node');
        expect(text).not.toContain('Toggle source mode');
        // 一覧自身にトグルキーが載る（README「Learning the ropes」と同期）
        expect(text).toContain('Show / hide this shortcut list');
    });

    test('TC-B6B-05 notes で HUD は 1 個だけ（二重 init ガード）', async ({ page }) => {
        await bootNotes(page);
        await page.keyboard.press(TOGGLE);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
    });

    test('TC-B6B-06 window blur / どこかを click で閉じる', async ({ page }) => {
        await bootEditor(page);
        await page.keyboard.press(TOGGLE);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        await page.evaluate(() => { window.dispatchEvent(new Event('blur')); });
        await expect(page.locator(HUD_SEL)).toHaveCount(0);
        await page.keyboard.press(TOGGLE);
        await expect(page.locator(HUD_SEL)).toHaveCount(1);
        await page.mouse.click(5, 5);
        await expect(page.locator(HUD_SEL)).toHaveCount(0);
    });

    test('TC-B6B-07 __shortcutHudMessages fallback でカテゴリ見出しが localize される', async ({ page }) => {
        await bootEditor(page);
        const hasOutlinerMsgs = await page.evaluate(() => !!(window as any).__outlinerMessages);
        expect(hasOutlinerMsgs, 'standalone-editor は __outlinerMessages 非注入').toBe(false);
        await page.evaluate(() => { (window as any).__shortcutHudMessages = { shortcutCatEditing: '編集テスト見出し' }; });
        await page.keyboard.press(TOGGLE);
        const text = await page.locator(HUD_SEL).textContent();
        expect(text || '').toContain('編集テスト見出し');
    });

    test('TC-B6B-08 ★rev2 の番人: Meta 単独長押しでは HUD が出ない（cmd+click 複数選択と干渉しない）', async ({ page }) => {
        await bootOutliner(page);
        await page.keyboard.down('Meta');
        await page.waitForTimeout(1000);   // 旧 800ms を超えて待つ
        expect(await page.locator(HUD_SEL).count(), '旧長押し方式が残っている').toBe(0);
        await page.keyboard.up('Meta');
        // Ctrl（win/linux）も同じ
        await page.keyboard.down('Control');
        await page.waitForTimeout(1000);
        expect(await page.locator(HUD_SEL).count()).toBe(0);
        await page.keyboard.up('Control');
    });
});
