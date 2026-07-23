/**
 * TASK-11（バグ修正 2026-07-24）: caret 追従スクロールが↑方向で効かない既存バグの番人。
 *
 * 旧実装は window.innerHeight 基準 + scrollIntoView({block:'nearest'}) で、祖先スクロールコンテナ
 * （.editor-wrapper）に対して up/down 非対称（下は追従・上は非追従）だった。
 * 新実装は owner-rect ベースの純関数 computeCaretScrollDelta で up/down 対称に scrollTop を増減する。
 *
 * computeCaretScrollDelta は __editorUtils（DOM 非依存の純関数）なので addScriptTag で editor-utils.js を
 * inject して検証する（tab-manager unit と同パターン）。実 caret 移動・実スクロールは手動 US。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const EDITOR_UTILS_JS = fs.readFileSync(
    path.join(__dirname, '../../src/webview/editor-utils.js'), 'utf8');

async function loadUtils(page: import('@playwright/test').Page) {
    await page.goto('about:blank');
    await page.addScriptTag({ content: EDITOR_UTILS_JS });
}

// owner rect: 画面上 top=100, bottom=300（高さ 200 のスクロールコンテナを模す）
const OWNER = { top: 100, bottom: 300 };

test.describe('TASK-11 — caret scroll-follow (computeCaretScrollDelta)', () => {
    // TC-CS-01（★↑追従・load-bearing）: caret が owner 上端より上 → 負の delta（上へスクロール）
    test('TC-CS-01 caret が owner 上端より上なら負の delta（↑追従）', async ({ page }) => {
        await loadUtils(page);
        const delta = await page.evaluate((owner) => {
            // caret top=40 は owner.top=100 より上（画面外・上）
            return (window as any).__editorUtils.computeCaretScrollDelta(
                { top: 40, bottom: 58 }, owner, 8);
        }, OWNER);
        expect(delta).toBeLessThan(0);          // ★ 負 = owner.scrollTop を減らす = 上へスクロール
        expect(delta).toBe(40 - 100 - 8);       // caretRect.top - ownerRect.top - margin
    });

    // TC-CS-02（↓追従・回帰）: caret が owner 下端より下 → 正の delta（下へスクロール）
    test('TC-CS-02 caret が owner 下端より下なら正の delta（↓追従）', async ({ page }) => {
        await loadUtils(page);
        const delta = await page.evaluate((owner) => {
            // caret bottom=360 は owner.bottom=300 より下（画面外・下）
            return (window as any).__editorUtils.computeCaretScrollDelta(
                { top: 342, bottom: 360 }, owner, 8);
        }, OWNER);
        expect(delta).toBeGreaterThan(0);        // 正 = owner.scrollTop を増やす = 下へスクロール
        expect(delta).toBe(360 - 300 + 8);       // caretRect.bottom - ownerRect.bottom + margin
    });

    // TC-CS-03（可視域内は no-op）
    test('TC-CS-03 caret が owner 可視域内なら delta=0（no-op）', async ({ page }) => {
        await loadUtils(page);
        const delta = await page.evaluate((owner) => {
            return (window as any).__editorUtils.computeCaretScrollDelta(
                { top: 180, bottom: 198 }, owner, 8);
        }, OWNER);
        expect(delta).toBe(0);
    });

    // TC-CS-03b（★up/down 対称・counterfactual）: 旧 window.innerHeight 判定との対比。
    // 旧ロジックは「rect.top < 0 || rect.bottom > viewportHeight」で、owner の可視域（top=100〜bottom=300）
    // 内でも rect.top>=0 なら「可視」と誤判定し↑追従しなかった。owner-rect ベースなら↑も検知する。
    test('TC-CS-03b owner 上端より上でも rect.top>=0 なら旧判定は見逃す（新判定は↑追従）', async ({ page }) => {
        await loadUtils(page);
        const r = await page.evaluate((owner) => {
            const caret = { top: 40, bottom: 58 }; // 画面座標では top=40>=0 だが owner.top=100 より上
            const viewportHeight = 800;
            // 旧ロジック相当: rect.top < 0 || rect.bottom > viewportHeight → 40<0(false) || 58>800(false) = 追従しない
            const oldWouldScroll = (caret.top < 0 || caret.bottom > viewportHeight);
            // 新ロジック: owner-rect ベース → caret.top(40) < owner.top(100) → 追従する（負 delta）
            const newDelta = (window as any).__editorUtils.computeCaretScrollDelta(caret, owner, 8);
            return { oldWouldScroll, newDelta };
        }, OWNER);
        expect(r.oldWouldScroll).toBe(false);    // ★ 旧判定は↑を見逃す（バグ再現）
        expect(r.newDelta).toBeLessThan(0);      // ★ 新判定は↑追従する（修正）
    });
});
