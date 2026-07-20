/**
 * sidepanel md ヘッダーの狭幅レスポンシブ（sprint 20260720-221254-sidepanel-header-narrow-scroll）。
 *
 * 狭幅時: lead（戻る/進む .side-panel-nav-leading）と close（.side-panel-close）は固定表示、
 *         中央（.side-panel-header-scroll）だけが横スクロール（overflow-x:auto）。
 * 広幅時: スクロール不要（scrollWidth <= clientWidth）で回帰なし。
 *
 * standalone-notes.html の .side-panel を開き、幅を制限して computed layout を読む。
 */
import { test, expect, Page } from '@playwright/test';

// side-panel を開いて幅を widthPx に固定する。ヘッダー要素の測定を返す。
async function openAndSize(page: Page, widthPx: number) {
    await page.evaluate((w) => {
        const sp = document.querySelector('.side-panel') as HTMLElement;
        if (sp) {
            sp.classList.add('open');
            sp.style.setProperty('display', 'flex', 'important');
            sp.style.setProperty('width', w + 'px', 'important');
            sp.style.setProperty('max-width', w + 'px', 'important');
        }
        // container も幅制限（header は container 内）
        const c = document.querySelector('.side-panel-editor-container') as HTMLElement;
        if (c) c.style.setProperty('width', w + 'px', 'important');
    }, widthPx);
    await page.waitForTimeout(50);
}

function headerMetrics(page: Page) {
    return page.evaluate(() => {
        const header = document.querySelector('.side-panel-header') as HTMLElement;
        const scroll = document.querySelector('.side-panel-header-scroll') as HTMLElement;
        const nav = Array.from(document.querySelectorAll('.side-panel-header .side-panel-nav-leading')) as HTMLElement[];
        const close = document.querySelector('.side-panel-header .side-panel-close') as HTMLElement;
        if (!header || !scroll || !close) return null;
        const hRect = header.getBoundingClientRect();
        const scRect = scroll.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        const cs = getComputedStyle(scroll);
        return {
            navCount: nav.length,
            navVisible: nav.map((n) => n.offsetWidth > 0),
            navLefts: nav.map((n) => n.getBoundingClientRect().left),
            closeVisible: close.offsetWidth > 0,
            closeRight: closeRect.right,
            headerRight: hRect.right,
            scrollLeft: scRect.left,
            overflowX: cs.overflowX,
            scrollW: scroll.scrollWidth,
            clientW: scroll.clientWidth,
        };
    });
}

test.describe('sidepanel header 狭幅レスポンシブ (standalone-notes)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // TC-HN-01: 狭幅で戻る/進む（nav-leading）が可視・左端側に固定
    test('TC-HN-01 狭幅で nav-leading が可視・左端固定', async ({ page }) => {
        await openAndSize(page, 220);
        const m = await headerMetrics(page);
        expect(m, 'header 要素が存在').not.toBeNull();
        expect(m!.navCount).toBe(2);
        expect(m!.navVisible, 'nav 2 個とも可視（潰れない）').toEqual([true, true]);
        // nav は中央スクロール領域より左（固定 lead）
        for (const left of m!.navLefts) {
            expect(left).toBeLessThan(m!.scrollLeft + 1);
        }
    });

    // TC-HN-02: 狭幅で閉じる（×）が可視・右端固定
    test('TC-HN-02 狭幅で close が可視・右端固定', async ({ page }) => {
        await openAndSize(page, 220);
        const m = await headerMetrics(page);
        expect(m!.closeVisible, 'close が可視（潰れない）').toBe(true);
        // close はヘッダー右端付近（中央がはみ出ても隠れない）
        expect(m!.closeRight).toBeLessThanOrEqual(m!.headerRight + 1);
        expect(m!.closeRight).toBeGreaterThan(m!.scrollLeft);
    });

    // TC-HN-03: 中央領域が狭幅で横スクロール可能（overflow-x:auto + scrollWidth>clientWidth）
    test('TC-HN-03 狭幅で中央が横スクロール可能', async ({ page }) => {
        await openAndSize(page, 200);
        const m = await headerMetrics(page);
        expect(['auto', 'scroll'], 'overflow-x が auto/scroll').toContain(m!.overflowX);
        expect(m!.scrollW, '中央がはみ出しスクロール可能').toBeGreaterThan(m!.clientW);
    });

    // TC-HN-04: 広幅では回帰なし（スクロール不要 = バー出ない）
    test('TC-HN-04 広幅ではスクロール不要（回帰なし）', async ({ page }) => {
        await openAndSize(page, 640);
        const m = await headerMetrics(page);
        expect(m!.navVisible).toEqual([true, true]);
        expect(m!.closeVisible).toBe(true);
        // 広幅では中央がはみ出さない（scrollWidth <= clientWidth + 誤差）
        expect(m!.scrollW).toBeLessThanOrEqual(m!.clientW + 2);
    });
});
