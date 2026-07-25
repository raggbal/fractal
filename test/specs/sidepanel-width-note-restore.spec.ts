/**
 * TC-SW-01/02 — Notes モードでサイドパネル幅（note 単位 = window.__noteSidePanelWidth）が
 * updateData（ファイル切替・note 再オープン）で .out 個別値 null に上書きされず復元される。
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, rootIds: [], nodes: {} });
    });
}

test.describe('サイドパネル幅の note 復元 (sidepanel-width-note-restore)', () => {
    // TC-SW-01: notes モードで note 幅が updateData で null 上書きされない ★load-bearing・counterfactual
    test('TC-SW-01 note 幅(__noteSidePanelWidth)が updateData で保持される', async ({ page }) => {
        await boot(page);
        const w = await page.evaluate(async () => {
            // note 単位の保存幅を復元した状態を模す
            (window as any).__noteSidePanelWidth = 700;
            // updateData（.out data に sidePanelWidth 無し = Notes の .out は幅を持たない）を host 経路で発火
            (window as any).__hostMessageHandler({ type: 'updateData', fileChangeId: 12345,
                data: { version: 1, rootIds: [], nodes: {} } });
            await new Promise(r => setTimeout(r, 80));
            return (window as any).Outliner.__getSidePanelWidthSettingForTest();
        });
        // ★ note 値 700 が保たれる（修正前は msg.data.sidePanelWidth(undefined)||null で null 上書き=RED）
        expect(w).toBe(700);
    });

    // TC-SW-02: __noteSidePanelWidth 無し（standalone 相当）は .out の data 値を使う（回帰）
    test('TC-SW-02 note 幅が無ければ .out data.sidePanelWidth を使う', async ({ page }) => {
        await boot(page);
        const w = await page.evaluate(async () => {
            (window as any).__noteSidePanelWidth = undefined;   // note 値なし
            (window as any).__hostMessageHandler({ type: 'updateData', fileChangeId: 22222,
                data: { version: 1, rootIds: [], nodes: {}, sidePanelWidth: 500 } });
            await new Promise(r => setTimeout(r, 80));
            return (window as any).Outliner.__getSidePanelWidthSettingForTest();
        });
        expect(w).toBe(500);   // .out 個別値を使う
    });

    // TC-SW-03（note 開き直し後の window 縮小で editor 領域内に再クランプ）★load-bearing・counterfactual
    // ★ window-resize / ResizeObserver の再クランプ handler は `if(!sidePanelWidthSetting) return` でガードされる。
    //   updateData で幅が null 上書きされていると（旧バグ）、window 縮小しても再クランプが効かず editor 領域を
    //   はみ出す。TC-SW-01 の幅保持と合わせ、「updateData 後も window 縮小で収まる」まで踏む番人。
    test('TC-SW-03 note 開き直し(updateData)後、window 縮小でサイドパネルが editor 領域内に収まる', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(async () => {
            const O = (window as any).Outliner;
            const wrapper = document.querySelector('.notes-main-wrapper') as HTMLElement;
            const sp = document.querySelector('.side-panel') as HTMLElement;
            // note 幅 900 を復元・パネル open・RO/resize handler を wire（openSidePanel 相当）
            wrapper.style.flex = 'none'; wrapper.style.width = '1000px';
            sp.style.display = 'flex'; sp.classList.add('open');
            (window as any).__noteSidePanelWidth = 900;
            O.__setSidePanelWidthForTest(900);
            O.__wireSidePanelResizeObserverForTest();
            O.__applySidePanelWidthClampedForTest();   // 初期 900px 焼き込み
            // note 開き直し / 別ファイル切替を模す updateData（.out に幅なし）
            (window as any).__hostMessageHandler({ type: 'updateData', fileChangeId: 33333,
                data: { version: 1, rootIds: [], nodes: {} } });
            await new Promise(r => setTimeout(r, 50));
            // vscode window 縮小を模す（wrapper 縮小 + window resize）
            wrapper.style.width = '400px';
            window.dispatchEvent(new Event('resize'));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))));
            return { spW: sp.getBoundingClientRect().width, wrapW: wrapper.getBoundingClientRect().width };
        });
        // ★ サイドパネルが editor 領域（wrapper）を超えない（updateData で幅が保持され再クランプが効く）
        expect(r.spW).toBeLessThanOrEqual(r.wrapW + 1);
    });
});
