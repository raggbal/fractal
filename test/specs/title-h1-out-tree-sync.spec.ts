/**
 * TASK-09（手動テスト起因）: outliner の page-title を編集して確定（IME確定/blur/Enter）したとき、
 * host へ syncData が **即座に**（SYNC_DEBOUNCE_MS=1000ms を待たず）送出され、tree title が即反映される。
 *
 * 現象: md の H1 は確定で即 tree 反映されるのに、outliner title は 1000ms debounce のため
 *       別ファイルを click してファイル切替 flush が走るまで反映されなかった。
 * 実 IME フローは synthetic event で完全再現できない（designer_failures 2026-04-21）ため、
 * compositionend / blur / Enter keydown を dispatch して「確定で即送出される」ことを検証する。
 * page-title コンテナは standalone で display:none のため、click でなく直接 dispatch する。
 */
import { test, expect, Page } from '@playwright/test';

async function initWithTitle(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({
            version: 1, rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'x', tags: [] } },
            title: 'OldTitle',
        });
    });
}

// 直近 syncData の title を返す（debounce 未満の待機で「即送出」を検証）
async function lastSyncTitleWithin(page: Page, ms: number): Promise<{ count: number; title: string | null }> {
    await page.waitForTimeout(ms);
    return page.evaluate(() => {
        const arr = (window as any).__testApi.messages.filter((m: any) => m.type === 'syncData');
        let title: string | null = null;
        try { title = arr.length ? JSON.parse(arr[arr.length - 1].content).title : null; } catch { title = null; }
        return { count: arr.length, title };
    });
}

test.describe('TASK-09 outliner title → tree 即反映（debounce 待たず flush）', () => {
    test('TC-TH-23 IME 確定（compositionend）で syncData が即送出される', async ({ page }) => {
        await initWithTitle(page);
        await page.evaluate(() => {
            (window as any).__testApi.messages = [];
            const el = document.querySelector('.outliner-page-title-input') as HTMLInputElement;
            el.value = 'IMEタイトル';
            el.dispatchEvent(new Event('compositionstart', { bubbles: true }));
            el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        });
        // SYNC_DEBOUNCE_MS(1000ms) より十分短い待機で送出済みを確認 = 即 flush の証明
        const r = await lastSyncTitleWithin(page, 100);
        expect(r.count, 'IME 確定で即 syncData').toBeGreaterThanOrEqual(1);
        expect(r.title).toBe('IMEタイトル');
    });

    test('TC-TH-23b blur で syncData が即送出される', async ({ page }) => {
        await initWithTitle(page);
        await page.evaluate(() => {
            (window as any).__testApi.messages = [];
            const el = document.querySelector('.outliner-page-title-input') as HTMLInputElement;
            el.value = 'BlurTitle';
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        });
        const r = await lastSyncTitleWithin(page, 100);
        expect(r.count, 'blur で即 syncData').toBeGreaterThanOrEqual(1);
        expect(r.title).toBe('BlurTitle');
    });

    test('TC-TH-23d 1テンポ遅れ回避: compositionend 時点で value 未反映でも最新確定値を送る', async ({ page }) => {
        // 実ブラウザ（Chromium）は IME 確定時 compositionend → input の順で value が更新される。
        // compositionend で同期的に value を読むと「1つ前の確定値」を送り 1 テンポ遅れる。
        // 修正: compositionend の読み取りを次 tick に遅延 → input 反映後の最新値を送る。
        await initWithTitle(page);
        await page.evaluate(() => {
            (window as any).__testApi.messages = [];
            const el = document.querySelector('.outliner-page-title-input') as HTMLInputElement;
            el.value = 'PrevConfirmed';
            el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            // compositionend 時点では value がまだ旧値（実ブラウザの厄介な順序を模擬）
            el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            // 直後に value が最新確定値へ更新され input 発火
            el.value = 'LatestConfirmed';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const r = await lastSyncTitleWithin(page, 120); // setTimeout(0) + margin, <1000ms debounce
        expect(r.count, '即送出される').toBeGreaterThanOrEqual(1);
        expect(r.title, '1テンポ遅れず最新確定値を送る').toBe('LatestConfirmed');
    });

    test('TC-TH-23c 非 IME の通常入力は debounce（100ms 時点では未送出、確定時に送出）', async ({ page }) => {
        // counterfactual/仕様確認: input（打鍵）だけでは即送出しない = 過剰送信しない。
        await initWithTitle(page);
        await page.evaluate(() => {
            (window as any).__testApi.messages = [];
            const el = document.querySelector('.outliner-page-title-input') as HTMLInputElement;
            el.value = 'TypedTitle';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const early = await lastSyncTitleWithin(page, 100);
        expect(early.count, '打鍵直後(100ms)は debounce で未送出').toBe(0);
        // blur で確定 → 即送出
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-page-title-input') as HTMLInputElement;
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        });
        const after = await lastSyncTitleWithin(page, 100);
        expect(after.count, 'blur 確定で送出').toBeGreaterThanOrEqual(1);
        expect(after.title).toBe('TypedTitle');
    });
});
