/**
 * FR-SPC-01〜05 — サイドパネル×タブ共存 E2E（standalone-notes）。
 *
 * overlay 廃止・外側クリックで閉じない・高さがタブ内領域・タブ共存 を standalone build の実 DOM で検証。
 * 実 openSidePanel は host 往復（vscode 依存）なので、standalone では既存の openSidePanel 経路
 * （window.Outliner 経由 or DOM 直操作）で `.side-panel` を open 状態にして DOM/CSS を検証する。
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

// standalone で `.side-panel` を open 状態にする（overlay 廃止後の DOM を検証するため、
// クラス操作で open を再現。実 openSidePanel の host 往復は E2E 外）。
async function openSidePanelDom(page: Page) {
    await page.evaluate(() => {
        const sp = document.querySelector('.side-panel') as HTMLElement;
        sp.style.display = 'flex';
        sp.classList.add('open');
    });
}

test.describe('sidepanel × tab coexist (FR-SPC)', () => {
    // TC-SPC-01: overlay 廃止（DOM に存在しない）
    test('TC-SPC-01 .side-panel-overlay が DOM に存在しない', async ({ page }) => {
        await boot(page);
        const overlayExists = await page.evaluate(() => !!document.querySelector('.side-panel-overlay'));
        expect(overlayExists).toBe(false);
    });

    // TC-SPC-02: 外側クリックで閉じない（overlay click listener 廃止 → close 経路なし）
    test('TC-SPC-02 サイドパネル外側クリックで閉じない', async ({ page }) => {
        await boot(page);
        await openSidePanelDom(page);
        const r = await page.evaluate(() => {
            // サイドパネル外側（左上・メインペイン領域）をクリック相当（document の任意要素 click）
            const outside = document.querySelector('.outliner-tree') as HTMLElement || document.body;
            outside.click();
            return { open: (document.querySelector('.side-panel') as HTMLElement).classList.contains('open') };
        });
        expect(r.open).toBe(true); // 外側クリックしても開いたまま（overlay + close listener が無い）
    });

    // TC-SPC-03: Esc で閉じる（既存 listener 維持・overlay 非依存）
    test('TC-SPC-03 Esc でサイドパネルが閉じる', async ({ page }) => {
        await boot(page);
        await openSidePanelDom(page);
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await page.waitForTimeout(250); // closeSidePanel は 200ms transition 後 immediate
        const open = await page.evaluate(() => (document.querySelector('.side-panel') as HTMLElement).classList.contains('open'));
        expect(open).toBe(false);
    });

    // TC-SPC-04: ✗ で閉じる（既存 .side-panel-close 維持）
    test('TC-SPC-04 ヘッダー ✗ でサイドパネルが閉じる', async ({ page }) => {
        await boot(page);
        await openSidePanelDom(page);
        await page.evaluate(() => {
            const btn = document.querySelector('.side-panel-close') as HTMLElement;
            btn.click();
        });
        await page.waitForTimeout(250);
        const open = await page.evaluate(() => (document.querySelector('.side-panel') as HTMLElement).classList.contains('open'));
        expect(open).toBe(false);
    });

    // TC-SPC-05: 高さがタブ内領域（--notes-tab-bar-height でタブバー下端に）
    test('TC-SPC-05 サイドパネル top がタブバー下端に追従（tab2）/ tab1 は 0', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            const sp = document.querySelector('.side-panel') as HTMLElement;
            const mw = document.querySelector('.notes-main-wrapper') as HTMLElement;
            const bar = document.getElementById('notesTabBar')!;
            // .side-panel は .notes-main-wrapper の子孫（containing block）
            const insideWrapper = mw.contains(sp);
            // tab1: タブバー非表示 → --notes-tab-bar-height = 0px
            tm.initFirstTab('/note/a.out', 'out');
            const varTab1 = mw.style.getPropertyValue('--notes-tab-bar-height');
            // tab2: タブバー表示 → --notes-tab-bar-height = tabBar.offsetHeight
            tm.openInNewTab('/note/b.md', 'md');
            const varTab2 = mw.style.getPropertyValue('--notes-tab-bar-height');
            const barH = bar.offsetHeight;
            return { insideWrapper, varTab1, varTab2, barH };
        });
        expect(r.insideWrapper).toBe(true);            // containing block = notes-main-wrapper
        expect(r.varTab1).toBe('0px');                 // tab1 = 0（画面全高）
        expect(r.varTab2).toBe(r.barH + 'px');         // tab2 = タブバー下端
        expect(r.barH).toBeGreaterThan(0);
    });

    // TC-SPC-06: タブ共存（overlay が無いのでタブを触れる — overlay 不在で担保）
    test('TC-SPC-06 サイドパネル open 中もタブバーがクリック可能（overlay がクリックを奪わない）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const tm = (window as any).__notesTabManager;
            tm.initFirstTab('/note/a.out', 'out');
            tm.openInNewTab('/note/b.md', 'md'); // 2 タブ
            openSidePanelDomInline();
            function openSidePanelDomInline() {
                const sp = document.querySelector('.side-panel') as HTMLElement;
                sp.style.display = 'flex'; sp.classList.add('open');
            }
            // サイドパネル open 中に、タブバー先頭タブの座標に overlay が無い（elementFromPoint がタブ側）
            const bar = document.getElementById('notesTabBar')!;
            const firstTab = bar.querySelector('.notes-tab') as HTMLElement;
            const rect = firstTab.getBoundingClientRect();
            const el = document.elementFromPoint(rect.left + 5, rect.top + 5);
            const overlayAtPoint = !!(el && el.closest && el.closest('.side-panel-overlay'));
            return { overlayAtPoint, sidePanelOpen: (document.querySelector('.side-panel') as HTMLElement).classList.contains('open') };
        });
        expect(r.sidePanelOpen).toBe(true);       // サイドパネルは開いている
        expect(r.overlayAtPoint).toBe(false);     // タブ位置に overlay が無い（タブを触れる）
    });
});
