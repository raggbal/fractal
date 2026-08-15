/**
 * viewer-sidepanel.spec.ts — sidepanel 面の受信側（表示・排他）— TC-FV-20/21
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-04。
 * ハーネス: standalone-outliner.html（viewer-side-panel.js 組込済み。実行前 test:build:all）。
 */
import { test, expect } from '@playwright/test';

test.describe('viewer sidepanel 面（FR-FV-05 / TASK-04）', () => {

    test('TC-FV-20: openViewerPanel message で表示・closeViewerPanel で消える（受信側）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel);
        // 受信側: host message と同型の message を window に流す
        await page.evaluate(() => {
            window.postMessage({ type: 'openViewerPanel', kind: 'html', fileUri: './viewer-fixtures/sample.html', filePath: '/x/sample.html' }, '*');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 5000 });
        expect(await page.locator('.viewer-side-panel.open').count()).toBe(1);
        // viewer がマウントされている（iframe が生成される）
        await page.waitForSelector('.viewer-side-panel .viewer-html-frame', { timeout: 5000 });

        await page.evaluate(() => { window.postMessage({ type: 'closeViewerPanel' }, '*'); });
        await page.waitForTimeout(300);
        expect(await page.locator('.viewer-side-panel.open').count()).toBe(0);
        // 閉じたら viewer DOM は破棄される
        expect(await page.locator('.viewer-side-panel .viewer-html-frame').count()).toBe(0);
    });

    test('TC-FV-21: 排他番人 — 両方向（viewer open で md close / md open で viewer close）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__testApi);

        // 方向 1: md sidepanel 表示中に viewer を開く → md 側が閉じる
        await page.evaluate(() => {
            // md sidepanel を開く（outliner.js の openSidePanel 相当を message で）
            (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: '# md panel', filePath: '/x/a.md', fileName: 'a.md', toc: [], documentBaseUri: '' });
        });
        await page.waitForSelector('.side-panel.open', { timeout: 5000 });
        await page.evaluate(() => {
            window.postMessage({ type: 'openViewerPanel', kind: 'html', fileUri: './viewer-fixtures/sample.html', filePath: '/x/s.html' }, '*');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 5000 });
        await page.waitForTimeout(500);   // md close のアニメーション（200ms）余裕
        expect(await page.locator('.side-panel.open').count(), 'md sidepanel が閉じる').toBe(0);

        // 方向 2: viewer 表示中に md sidepanel を開く → viewer が閉じる（counterfactual: hook を外すと残留で RED）
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: '# md again', filePath: '/x/b.md', fileName: 'b.md', toc: [], documentBaseUri: '' });
        });
        await page.waitForSelector('.side-panel.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        expect(await page.locator('.viewer-side-panel.open').count(), 'viewer が閉じる').toBe(0);
    });
});

test.describe('sidepanel 面 fallback 中継（reviewer iter1 TASK-09 / TC-FV-38）', () => {

    test('TC-FV-38: OS で開く中継（SEC-2 番人 — bridge 経由で filePath 付き message が届く）', async ({ page }) => {
        // PDF 実レンダの検証は TC-FV-04（軽量 standalone ハーネス・1 実装 3 マウントの共通コード）に集約。
        // 本 TC の検証面 = sidepanel 面の fallback 配線（ボタンは kind 非依存でツールバー常設 — html で駆動）
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__fileViewer);
        await page.evaluate(() => {
            window.postMessage({ type: 'openViewerPanel', kind: 'html', fileUri: './viewer-fixtures/sample.html', filePath: '/x/sample.html' }, '*');
        });
        await page.waitForSelector('.viewer-side-panel.open', { timeout: 10000 });
        await page.click('.viewer-side-panel .viewer-open-external');
        await expect.poll(async () =>
            page.evaluate(() => ((window as any).__testApi.messages as any[])
                .find((m) => m.type === 'openExternalFallback')?.filePath ?? null),
        { timeout: 10000 }).toBe('/x/sample.html');
    });

    test('TC-FV-38b: pdf_viewer.css が outliner webview に配線される（QUAL-1 契約番人）', async ({ page }) => {
        // 実レンダの代わりに css 配線を DOM で契約検証（PDFViewer レイアウトの前提 — .pdfViewer ルールの実在）
        await page.goto('/standalone-outliner.html');
        const hasPdfCss = await page.evaluate(() => {
            for (const sheet of Array.from(document.styleSheets)) {
                try {
                    for (const rule of Array.from((sheet as CSSStyleSheet).cssRules)) {
                        if ((rule as CSSStyleRule).selectorText?.includes('.pdfViewer')) { return true; }
                    }
                } catch { /* cross-origin sheet は skip */ }
            }
            return false;
        });
        expect(hasPdfCss, '.pdfViewer ルールがハーネス（= 本番 outlinerWebviewContent と同経路）に存在').toBe(true);
    });
});
