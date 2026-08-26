/**
 * PDF 幅追従再フィット（FR-FV-23 / ADRL-0099）
 * sprint 20260825-115048-pdf-pagewidth-refit TASK-01
 *
 * page-width スケールは従来 pagesinit の一度きりで、コンテナ幅の変化に追従しなかった
 * （初期表示はみ出しの間欠バグ — 決定論再現 = doc/repro-pdf-width.spec.ts）。
 * ResizeObserver（content-box）で preset（isNaN = 'page-width'）中のみ再代入して追従する。
 *
 * TC-PWR-01: 縮小追従 / TC-PWR-02: 拡大追従 / TC-PWR-03: 手動ズーム後は追従しない
 * TC-PWR-04: destroy 後は再フィットが走らない（RO disconnect） / TC-PWR-05: 幅 0 no-op + 表示復帰でフィット
 * counterfactual: 修正前コードで TC-PWR-01/02/05 が RED（01/02 は repro で実測済み）。
 * ハーネス: standalone-viewer.html + 実 pdfjs レンダ（先例 file-viewer-find.spec.ts・軽量ハーネス集約 =
 * generator_failures 2026-08-15 準拠）。
 */
import { test, expect } from '@playwright/test';

async function openPdfAt(page, width: number) {
    await page.evaluate((w) => {
        const root = document.getElementById('viewer-root')!;
        root.style.width = w + 'px';
        root.style.height = '600px';
        root.style.position = 'relative';
    }, width);
    await page.evaluate(() => (window as any).__fileViewer.open(
        'pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'), '/x/ja-en.pdf'));
    await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30000 });
    await page.waitForTimeout(300);
}

async function measure(page) {
    return page.evaluate(() => {
        const container = document.querySelector('.viewer-pdf-container') as HTMLElement;
        const pg = document.querySelector('.pdfViewer .page') as HTMLElement;
        return {
            containerClientWidth: container ? container.clientWidth : -1,
            pageWidth: pg ? pg.getBoundingClientRect().width : -1,
        };
    });
}

const setRootWidth = (page, w: number) =>
    page.evaluate((v) => { document.getElementById('viewer-root')!.style.width = v + 'px'; }, w);

test.describe('FR-FV-23: PDF 幅追従再フィット', () => {

    test('TC-PWR-01: 縮小追従 — 800→400px で page が再フィットしてはみ出さない', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await openPdfAt(page, 800);
        const before = await measure(page);
        expect(before.pageWidth, '初期フィット').toBeLessThanOrEqual(before.containerClientWidth + 2);

        await setRootWidth(page, 400);
        await page.waitForTimeout(500);
        const after = await measure(page);
        expect(after.pageWidth, '縮小後も viewer 幅にフィット（水平はみ出しなし）')
            .toBeLessThanOrEqual(after.containerClientWidth + 2);
        expect(after.pageWidth, '実際に縮んでいる').toBeLessThan(before.pageWidth - 100);
    });

    test('TC-PWR-02: 拡大追従 — 400→900px で広い幅にフィットし直す', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await openPdfAt(page, 400);
        await setRootWidth(page, 900);
        await page.waitForTimeout(500);
        const m = await measure(page);
        expect(m.pageWidth, '拡大後は広い幅にフィット').toBeGreaterThanOrEqual(m.containerClientWidth * 0.9);
    });

    test('TC-PWR-03: 手動ズーム後は幅変化に追従しない（FR-FV-19 保護）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await openPdfAt(page, 800);
        await page.click('.viewer-zoom-in');   // currentScale 数値代入 → currentScaleValue が数値化
        await page.waitForTimeout(300);
        const zoomed = await measure(page);

        await setRootWidth(page, 500);
        await page.waitForTimeout(500);
        const after = await measure(page);
        expect(Math.abs(after.pageWidth - zoomed.pageWidth), 'ズーム倍率がリサイズで変わらない')
            .toBeLessThanOrEqual(2);
    });

    test('TC-PWR-04: destroy で RO が実際に disconnect される（spy 実測 — dead code 検出）', async ({ page }) => {
        // reviewer iteration 1 DSN-1: 文字列 toContain の source pin は dead code を検出できない
        // トートロジー → ResizeObserver を spy でラップし「構築された全インスタンスに disconnect が
        // 呼ばれた」を実測する（counterfactual = open() pdf 分岐の非連鎖 cleanup 上書しで RED）。
        await page.addInitScript(() => {
            const Orig = (window as any).ResizeObserver;
            const registry: { disconnected: boolean }[] = [];
            (window as any).__roSpy = registry;
            (window as any).ResizeObserver = class {
                _rec: { disconnected: boolean; targets: string[] };
                _inner: any;
                constructor(cb: any) { this._inner = new Orig(cb); this._rec = { disconnected: false, targets: [] }; registry.push(this._rec); }
                observe(el: any, ...a: any[]) { this._rec.targets.push(String(el && el.className || '')); return this._inner.observe(el, ...a); }
                unobserve(...a: any[]) { return this._inner.unobserve(...a); }
                disconnect() { this._rec.disconnected = true; return this._inner.disconnect(); }
            };
        });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('/standalone-viewer.html');
        await openPdfAt(page, 800);
        const constructedDuringPdf = await page.evaluate(() => (window as any).__roSpy.length);
        expect(constructedDuringPdf, 'refit RO が構築されている').toBeGreaterThanOrEqual(1);

        // 同一 mount に別 kind を open → open 冒頭の destroy(mount) が cleanupRegistry を発火
        await page.evaluate(() => (window as any).__fileViewer.open(
            'text', './viewer-fixtures/dummy.txt', document.getElementById('viewer-root'), '/x/dummy.txt'));
        await page.waitForTimeout(500);

        const spy = await page.evaluate((n) => (window as any).__roSpy.slice(0, n), constructedDuringPdf);
        // .viewer-pdf-container を observe する RO は 2 本: 本 sprint の refit RO と、pdf.js PDFViewer が
        // 内部で張る RO（--viewer-container-height 用）。後者は PDFViewer 破棄 API を通さない現行構造では
        // disconnect されない（main 由来の pre-existing・スコープ外）。よって pin は
        // 「container を observe した RO のうち少なくとも 1 本が destroy で disconnect される」=
        // refit RO の解放実測（counterfactual: 非連鎖上書きの dead code 状態では 0 本 = RED を実測済み）。
        const containerRos = spy.filter((r: any) => r.targets.some((t: string) => t.includes('viewer-pdf-container')));
        expect(containerRos.length, 'container を observe する RO が構築されている').toBeGreaterThanOrEqual(1);
        expect(containerRos.some((r: any) => r.disconnected), 'refit RO が destroy で disconnect 済み（dead code なら 0 本）')
            .toBe(true);
        // 既存 cleanup（pdf.destroy — TASK-10 由来）も連鎖後に発火していること
        expect(await page.evaluate(() => (window as any).__lastPdfDocDestroyed), 'pdf.destroy も発火').toBe(true);

        await setRootWidth(page, 400);
        await page.waitForTimeout(500);
        expect(errors, 'destroy 後の幅変更で例外が出ない').toEqual([]);
        expect(await page.locator('.viewer-pdf-container').count()).toBe(0);
    });

    test('TC-PWR-05: 幅 0（非表示）では no-op・表示復帰でその時点の幅へ再フィット', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('/standalone-viewer.html');
        await openPdfAt(page, 800);

        // 非表示化 + 幅変更（幅 0 の間は再フィットしない — 負/ゼロ幅スケールを作らない）
        await page.evaluate(() => { document.getElementById('viewer-root')!.style.display = 'none'; });
        await setRootWidth(page, 400);
        await page.waitForTimeout(300);
        const scaleWhileHidden = await page.evaluate(() => {
            const v = document.querySelector('.pdfViewer') as HTMLElement;
            return v ? parseFloat(getComputedStyle(v).getPropertyValue('--scale-factor')) : NaN;
        });
        expect(scaleWhileHidden, '非表示中に負/ゼロスケールにならない').toBeGreaterThan(0);
        expect(errors, '非表示中の幅変更で例外なし').toEqual([]);

        // 表示復帰 → その時点の幅（400px）へフィット
        await page.evaluate(() => { document.getElementById('viewer-root')!.style.display = ''; });
        await page.waitForTimeout(500);
        const m = await measure(page);
        expect(m.pageWidth, '表示復帰でその時点の幅にフィット').toBeLessThanOrEqual(m.containerClientWidth + 2);
        expect(m.containerClientWidth, '復帰後の幅は縮小後の値').toBeLessThan(450);
    });
});
