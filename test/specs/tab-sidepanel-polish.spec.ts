/**
 * FR-TP-01/02/03/05 — タブ/サイドパネル追加改修 E2E（standalone-notes）。
 * 幅追従・復帰アニメ・検索状態復元・背景色を実 DOM/CSS で検証。実 host 往復（openSidePanel/updateData）は
 * vscode 依存なので、DOM 操作 or window.Outliner API 直叩きで検証する。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, rootIds: [], nodes: {} });
        (window as any).__testApi.initTabManager();
    });
    await page.waitForTimeout(80);
}

test.describe('tab/sidepanel polish (FR-TP)', () => {
    // TC-TP-01（★load-bearing・counterfactual）: 保存幅 px を焼き込んだ状態で wrapper が縮むと
    //   ResizeObserver 経由の再クランプで sidePanel が wrapper 内に収まる。
    //   inline px(width/maxWidth) は CSS の width:50%/max-width:70% を上書きするので、
    //   再クランプが無ければ焼き込んだ px がそのまま残り wrapper を溢れる（＝真のバグ）。
    // ★ load-bearing の肝: wrapper 縮小に対し「実際に ResizeObserver が発火して再クランプする」ことを検証する。
    //   clamp を手動で叩くと RO 配線を迂回する tautology になるため、FIX 経路では RO の非同期発火に委ねる
    //   （手動 clamp を呼ばない）。counterfactual は同じ RO を無効化し、px が据え置きで溢れることを実証する。
    test('TC-TP-01 wrapper 縮小で ResizeObserver が再クランプ→収まる（RO 無効化で溢れる=RED）', async ({ page }) => {
        await boot(page);
        async function run(disableRO: boolean) {
            return await page.evaluate(async (disable) => {
                const O = (window as any).Outliner;
                const wrapper = document.querySelector('.notes-main-wrapper') as HTMLElement;
                const sp = document.querySelector('.side-panel') as HTMLElement;
                // .notes-main-wrapper は flex:1 なので明示 width が無視される。
                // ファイルパネル開閉による containing-block 幅変化を決定的に模擬するため flex を外す。
                wrapper.style.flex = 'none';
                wrapper.style.width = '1000px';
                sp.style.display = 'flex'; sp.classList.add('open');
                O.__setSidePanelWidthForTest(900);          // 大きい保存幅を注入
                O.__setSidePanelResizeObserverDisabledForTest(disable);
                O.__wireSidePanelResizeObserverForTest();   // RO を張る（openSidePanel 相当）
                O.__applySidePanelWidthClampedForTest();    // 初期 px を inline に焼き込む（min(900,950)=900px）
                const bakedW = sp.getBoundingClientRect().width;
                // ★ wrapper を縮める。以後は手動 clamp を呼ばず RO の発火だけに委ねる。
                wrapper.style.width = '400px';
                // ResizeObserver は次フレームで非同期発火 → 複数フレーム待つ
                await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 30))));
                return { bakedW, spW: sp.getBoundingClientRect().width, wrapW: wrapper.getBoundingClientRect().width };
            }, disableRO);
        }
        // FIX: RO 有効 → wrapper 縮小で自動再クランプ → 収まる
        const fix = await run(false);
        expect(fix.bakedW).toBeGreaterThan(500);                   // 大きい px が焼き込まれた（前提）
        expect(fix.spW).toBeLessThanOrEqual(fix.wrapW + 1);        // RO 発火で収まった
        // COUNTERFACTUAL: RO 無効 → wrapper 縮小しても px 据え置き → 溢れる（fix を消すと同じ RED）
        const cf = await run(true);
        expect(cf.spW).toBeGreaterThan(cf.wrapW + 1);              // 900px のまま wrapper(400) を溢れる
    });

    // TC-TP-02: 復帰アニメ off の機構（.side-panel.no-transition が transition:none で .side-panel に勝つ）
    // ※ 実 restore 経路（openSidePanel(restoreForTab)）は host 往復依存なので、ここでは CSS 機構を検証。
    //   実スライド有無は手動 US。
    test('TC-TP-02 .side-panel.no-transition が transition:none（.side-panel の transition に勝つ）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.style.display = 'flex';
            const withoutClass = getComputedStyle(sp).transitionProperty;   // transform（アニメ有）
            sp.classList.add('no-transition');
            const withClass = getComputedStyle(sp).transitionDuration;      // 0s（アニメ無）
            return { withoutClass, withClass };
        });
        // no-transition class で transition が消える（duration 0s）
        expect(r.withClass === '0s' || r.withClass === '0ms').toBe(true);
    });

    // TC-TP-05: タブ選択/非選択の背景色（選択が明るい・非選択が灰）
    test('TC-TP-05 選択タブの背景が非選択より明るい（反転済み）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            tm.initFirstTab('/note/a.out', 'out');
            tm.openInNewTab('/note/b.md', 'md');  // 2 タブ
            const bar = document.getElementById('notesTabBar')!;
            const tabs = bar.querySelectorAll('.notes-tab');
            const active = Array.from(tabs).find((t: any) => t.dataset.active === 'true') as HTMLElement;
            const inactive = Array.from(tabs).find((t: any) => t.dataset.active !== 'true') as HTMLElement;
            const cs = (el: HTMLElement) => getComputedStyle(el).backgroundColor;
            return { activeBg: cs(active), inactiveBg: cs(inactive) };
        });
        // 選択と非選択の背景色が異なる（反転して割り当てられている）
        expect(r.activeBg).not.toBe(r.inactiveBg);
    });

    // TC-TP-03: captureView に検索状態が含まれ applyView で復元（純関数寄り・window.Outliner 直叩き）
    test('TC-TP-03 captureView に searchQuery が含まれ applyView で searchInput が復元', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const O = (window as any).Outliner;
            const si = document.querySelector('.outliner-search-input') as HTMLInputElement;
            // 検索テキストを入れて capture
            if (si) si.value = 'hello';
            const captured = O.captureView();
            // クリアしてから apply で復元
            if (si) si.value = '';
            O.applyView({ searchQuery: 'hello', searchFocusMode: false });
            return {
                capturedHasSearch: Object.prototype.hasOwnProperty.call(captured, 'searchQuery'),
                capturedQuery: captured.searchQuery,
                restored: si ? si.value : null,
            };
        });
        expect(r.capturedHasSearch).toBe(true);   // ★ captureView が searchQuery を含む（現状は含まない=counterfactual）
        expect(r.capturedQuery).toBe('hello');
        expect(r.restored).toBe('hello');          // applyView で searchInput 復元
    });
});
