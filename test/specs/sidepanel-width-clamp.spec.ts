/**
 * sidepanel-width-clamp — sidepanel md の横幅を表示領域の 95% でクランプ（FR-WC-01）
 *
 * 保存幅（sidePanelWidthSetting）を無条件 px 適用すると表示領域を超えて溢れていた。
 * open 時 / expand 解除時に min(保存幅, 親offsetWidth*0.95) にクランプする applySidePanelWidthClamped の検証。
 */
import { test, expect, Page } from '@playwright/test';

const SP_FILE = '/Users/test/notes/page.md';

async function openSidePanelWithSavedWidth(page: Page, savedWidth: number) {
    // ★init（Outliner.init）が __noteSidePanelWidth を読むのは ready 時点。
    //   そのため goto 前に addInitScript で仕込み、init が sidePanelWidthSetting に確実に取り込むようにする。
    await page.addInitScript((w) => { (window as any).__noteSidePanelWidth = w; }, savedWidth);
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // sidepanel を開く（outliner.js が openSidePanel を処理し applySidePanelWidthClamped で幅適用）
    await page.evaluate(({ fp }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: '# sp\n', filePath: fp, fileName: 'page.md', toc: [], documentBaseUri: 'http://localhost:3000/notes/',
        });
    }, { fp: SP_FILE });
    await page.waitForTimeout(400);
}

function measure(page: Page) {
    return page.evaluate(() => {
        const sp = document.querySelector('.side-panel') as HTMLElement;
        if (!sp) return { err: 'no side-panel', spWidth: -1, parentWidth: -1 };
        const parent = (sp.parentElement || document.body) as HTMLElement;
        return {
            err: null as string | null,
            spWidth: sp.getBoundingClientRect().width,
            parentWidth: parent.getBoundingClientRect().width,
            styleWidth: sp.style.width,
        };
    });
}

test.describe('sidepanel width clamp (FR-WC-01)', () => {
    test('TC-WC-01: 保存幅が表示領域より大きいと 95% にクランプ（load-bearing）', async ({ page }) => {
        // viewport を狭くして、保存幅がそれを超える状況を作る
        await page.setViewportSize({ width: 800, height: 800 });
        await openSidePanelWithSavedWidth(page, 5000); // 明らかに表示領域超え
        const m = await measure(page);
        expect(m.err).toBeNull();
        // sidepanel 幅は親の 95% 以下（+誤差 2px）
        expect(m.spWidth, `sp幅(${m.spWidth}) <= 親幅(${m.parentWidth})*0.95`).toBeLessThanOrEqual(m.parentWidth * 0.95 + 2);
        // 溢れていない（親幅以内）
        expect(m.spWidth).toBeLessThanOrEqual(m.parentWidth + 1);
    });

    test('TC-WC-01-cf: counterfactual — クランプ無効化すると保存幅がそのまま出て溢れる', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 800 });
        await openSidePanelWithSavedWidth(page, 5000);
        // クランプを打ち消して保存幅を無条件適用（旧挙動を再現）
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            if (sp) { sp.style.width = '5000px'; sp.style.maxWidth = '5000px'; }
        });
        await page.waitForTimeout(50);
        const m = await measure(page);
        // 旧挙動では親幅を大きく超える（クランプが load-bearing である証拠）
        expect(m.spWidth, '旧挙動は親幅を超える').toBeGreaterThan(m.parentWidth);
    });

    test('TC-WC-03: ドラッグ resize も親 95% クランプを維持（回帰）', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 800 });
        await openSidePanelWithSavedWidth(page, 400);
        // resize ハンドルを掴んで、親幅を大きく超える量だけ左へドラッグ（幅を増やす方向）
        const dragged = await page.evaluate(() => {
            const handle = document.getElementById('sidePanelResizeHandle');
            const sp = document.querySelector('.side-panel') as HTMLElement;
            if (!handle || !sp) return { err: 'no handle/sp', spWidth: -1, parentWidth: -1 };
            const startX = 400;
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX }));
            // 左へ 5000px ドラッグ（delta = startX - clientX が大 → newWidth 巨大 → クランプされるはず）
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: startX - 5000 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX - 5000 }));
            const parent = (sp.parentElement || document.body) as HTMLElement;
            return { err: null as string | null, spWidth: sp.getBoundingClientRect().width, parentWidth: parent.getBoundingClientRect().width };
        });
        expect(dragged.err).toBeNull();
        // resize しても親幅の 95% を超えない（既存クランプ維持）
        expect(dragged.spWidth, `resize 後 sp幅(${dragged.spWidth}) <= 親幅(${dragged.parentWidth})*0.95`).toBeLessThanOrEqual(dragged.parentWidth * 0.95 + 2);
    });

    test('TC-WC-04: 開いた後に表示領域を縮めると再クランプで追従（FR-WC-02・load-bearing）', async ({ page }) => {
        // 広い viewport で保存幅 1400 を開く（1600*0.95=1520 内なので 1400 で開く）
        await page.setViewportSize({ width: 1600, height: 900 });
        await openSidePanelWithSavedWidth(page, 1400);
        const before = await measure(page);
        expect(before.spWidth, '広い時は 1400 前後').toBeGreaterThan(1000);
        // 表示領域を縮める → window resize が発火し再クランプされるはず
        await page.setViewportSize({ width: 700, height: 900 });
        await page.waitForTimeout(200);
        const after = await measure(page);
        expect(after.err).toBeNull();
        expect(after.spWidth, `縮小後 sp幅(${after.spWidth}) <= 新親幅(${after.parentWidth})*0.95`).toBeLessThanOrEqual(after.parentWidth * 0.95 + 2);
        expect(after.spWidth, '溢れていない').toBeLessThanOrEqual(after.parentWidth + 1);

        // ★counterfactual: window resize ハンドラを外すと（inline width が固定のまま）溢れる
        const cf = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            // 旧挙動再現: 幅を保存幅 1400px 固定に戻す（resize 追従なし）
            sp.style.width = '1400px'; sp.style.maxWidth = '1400px';
            const parent = (sp.parentElement || document.body) as HTMLElement;
            return { spWidth: sp.getBoundingClientRect().width, parentWidth: parent.getBoundingClientRect().width };
        });
        expect(cf.spWidth, 'counterfactual: 追従なしなら新表示領域を超える').toBeGreaterThan(cf.parentWidth);
    });

    test('TC-WC-05: 表示領域が min-width(288)未満でも左にはみ出さない（FR-WC-03・load-bearing）', async ({ page }) => {
        await page.setViewportSize({ width: 1200, height: 800 });
        await openSidePanelWithSavedWidth(page, 800);
        // min-width(288) より狭い表示領域に縮める
        await page.setViewportSize({ width: 260, height: 800 });
        await page.waitForTimeout(200);
        const m = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            const r = sp.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width, vw: window.innerWidth, minWidth: getComputedStyle(sp).minWidth };
        });
        // 左端が画面内（>= -1）で、表示領域を溢れない
        expect(m.left, `sp左端(${m.left}) >= 0（はみ出さない）`).toBeGreaterThanOrEqual(-1);
        expect(m.right, '右端が表示領域内').toBeLessThanOrEqual(m.vw + 1);
        // min-width が 95vw に譲っている（288px 固定でない）
        expect(parseFloat(m.minWidth), `min-width(${m.minWidth}) が 288 未満に譲っている`).toBeLessThan(288);
    });

    test('TC-WC-02: 保存幅が表示領域より十分小さいと保存幅そのまま', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await openSidePanelWithSavedWidth(page, 400); // 1600*0.95=1520 より十分小さい
        const m = await measure(page);
        expect(m.err).toBeNull();
        // 400px 前後（クランプで縮まない）。誤差許容
        expect(m.spWidth).toBeGreaterThanOrEqual(360);
        expect(m.spWidth).toBeLessThanOrEqual(440);
    });
});
