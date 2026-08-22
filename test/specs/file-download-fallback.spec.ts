/**
 * TC-DLF-02 — triggerFileDownload の webview 端（sprint 20260822-051129 TASK-14b）
 *
 * <a download> は cross-origin で無効（ナビゲーションになり webview がブロック画面に潰れる —
 * ユーザー実測 2026-08-23）→ fetch → blob → same-origin blob URL で download する契約を実測 pin。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const HTML_DIR = path.join(__dirname, '..', '..', 'test', 'html');

test.beforeAll(() => {
    const dir = path.join(HTML_DIR, 'viewer-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dl-sample.bin'), Buffer.from('BINARY-CONTENT-123'));
});

test('TC-DLF-02 triggerFileDownload → ブラウザ download が発火し、画面遷移しない', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.evaluate(() => {
        window.postMessage({ type: 'triggerFileDownload', fileUri: './viewer-fixtures/dl-sample.bin', fileName: 'dl-sample.bin' }, '*');
    });
    const dl = await downloadPromise;
    expect(dl.suggestedFilename()).toBe('dl-sample.bin');
    // 画面が遷移していない（Notes UI が生きている）
    expect(page.url()).toContain('standalone-notes');
    expect(await page.locator('body').count()).toBe(1);
});
