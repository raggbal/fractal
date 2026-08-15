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
