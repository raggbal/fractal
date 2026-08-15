/**
 * file-viewer.spec.ts — viewer webview 本体（file-viewer.js）の実 Chromium 検証
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-02 / testcases.md C 節。
 * ハーネス: standalone-viewer.html（実行前に test:build:all 必須 — stale ビルド事故防止）。
 * 表示系は実レンダ結果を assert（合成イベント禁止 — generator_failures 2026-08-10/12）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const HTML_DIR = path.join(ROOT, 'test', 'html');
const FIXTURE_PDF = path.join(ROOT, 'test', 'fixtures', 'doc-search', 'fixture-ja-en.pdf');

/** fixture html/img をテストサーバー配下に書き出す（相対参照の実測用） */
function writeViewerFixtures(): void {
    const dir = path.join(HTML_DIR, 'viewer-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    // 1x1 PNG
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64');
    fs.writeFileSync(path.join(dir, 'pic.png'), png);
    // script / class / コメント / td 癒着 / entity / 相対 img / リンクを 1 枚に同居
    fs.writeFileSync(path.join(dir, 'sample.html'), [
        '<!DOCTYPE html><html><head>',
        '<style>.meeting-notes { color: red; }</style>',
        '<script>window.parent.postMessage("pwned-from-iframe", "*"); document.title = "pwned";</script>',
        '</head><body>',
        '<!-- コメント内秘匿語 -->',
        '<div class="meeting-notes">議事録本文</div>',
        '<table><tr><td>東京</td><td>大阪</td></tr></table>',
        '<p>A&amp;B&nbsp;C</p>',
        '<img src="pic.png" id="rel-img">',
        '<a href="https://example.com/away" id="nav-link">リンク</a>',
        '</body></html>',
    ].join('\n'));
    // 壊れた PDF
    fs.writeFileSync(path.join(dir, 'broken.pdf'), Buffer.from('not a pdf at all'));
    // 実 PDF fixture をコピー
    fs.copyFileSync(FIXTURE_PDF, path.join(dir, 'ja-en.pdf'));
}

test.beforeAll(() => { writeViewerFixtures(); });

test.describe('file-viewer: HTML 面（FR-FV-04 / NFR-FV-03）', () => {

    test('TC-FV-01: script 非実行番人 — 本文表示 + postMessage 非受信（counterfactual: allow-scripts で RED）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        const received = await page.evaluate(async () => {
            const msgs: string[] = [];
            window.addEventListener('message', (e) => { if (typeof e.data === 'string') { msgs.push(e.data); } });
            (window as any).__fileViewer.open('html', './viewer-fixtures/sample.html', document.getElementById('viewer-root'));
            await new Promise((r) => setTimeout(r, 1500));
            return msgs;
        });
        expect(received).not.toContain('pwned-from-iframe');   // script は実行されない
        // iframe 自体はロードされている（方式 B = blob URL — url でなく frame 内容で特定）
        const frame = page.frames().find((f) => f.url().startsWith('blob:'));
        expect(frame).toBeTruthy();
        expect(await frame!.locator('.meeting-notes').textContent()).toBe('議事録本文');
    });

    test('TC-FV-02: 相対参照 img がロードされる（方式 B: blob + base 注入の恒久番人）', async ({ page }) => {
        const imgRequests: string[] = [];
        page.on('request', (req) => { if (req.url().endsWith('pic.png')) { imgRequests.push(req.url()); } });
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/sample.html', document.getElementById('viewer-root'));
        });
        await page.waitForTimeout(1500);
        expect(imgRequests.length, '相対 img のネットワークリクエストが発生する').toBeGreaterThan(0);
    });

    test('TC-FV-03: 外部リンククリックで外部コンテンツがロードされない（親 CSP frame-src の抑止 = 受容事項 2 の pin）', async ({ page }) => {
        // 実測（2026-08-15）: sandbox="" はリンクによる iframe 内遷移自体は止めない。
        // 抑止の実体は親 CSP frame-src — 外部 URL はブロックされ iframe は chrome-error に落ちる
        // （外部コンテンツは一切ロードされない）。counterfactual: frame-src を外すと example.com へ遷移。
        const externalRequests: string[] = [];
        page.on('request', (r) => { if (r.url().includes('example.com')) { externalRequests.push(r.url()); } });
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/sample.html', document.getElementById('viewer-root'));
        });
        await page.waitForTimeout(1000);
        const frame = page.frames().find((f) => f.url().startsWith('blob:'));
        expect(frame).toBeTruthy();
        await frame!.locator('#nav-link').click();
        await page.waitForTimeout(1200);
        expect(externalRequests, '外部 URL へのリクエストが発生しない（CSP ブロック）').toEqual([]);
        const externalFrame = page.frames().find((f) => f.url().includes('example.com'));
        expect(externalFrame, '外部コンテンツの frame が存在しない').toBeUndefined();
        // 方式 B 補足: blob origin からの外部遷移も frame-src が止める（サンドボックスと CSP の二重防御は不変）
        expect(page.url()).toContain('standalone-viewer');     // 親は遷移しない
    });
});

test.describe('file-viewer: PDF 面（FR-FV-03）', () => {

    test('TC-FV-04: PDF 実レンダ — canvas 非ゼロ + 非空白 + ズーム再レンダ', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        // pdfjs のレンダ完了を canvas 出現で待つ
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        await page.waitForTimeout(1000);   // 描画完了余裕
        const info = await page.evaluate(() => {
            const canvas = document.querySelector('.pdfViewer canvas') as HTMLCanvasElement;
            if (!canvas) { return null; }
            // 非空白判定: 全ピクセル白でないこと（toDataURL は膨大なので imageData サンプリング）
            const ctx = canvas.getContext('2d')!;
            const d = ctx.getImageData(0, 0, Math.min(canvas.width, 200), Math.min(canvas.height, 200)).data;
            let nonWhite = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) { nonWhite++; }
            }
            return { w: canvas.width, h: canvas.height, nonWhite };
        });
        expect(info).not.toBeNull();
        expect(info!.w).toBeGreaterThan(0);
        expect(info!.h).toBeGreaterThan(0);
        expect(info!.nonWhite, '描画済み（真っ白でない）').toBeGreaterThan(0);
        // ズーム再レンダ（実クリック）
        const before = info!.w;
        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(1500);
        const afterW = await page.evaluate(() => (document.querySelector('.pdfViewer canvas') as HTMLCanvasElement)?.width || 0);
        expect(afterW, 'ズームで canvas 幅が変わる').not.toBe(before);
    });

    test('TC-FV-05: 壊れた PDF → 読み込み失敗表示 + OS で開くボタンが message を送る', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/broken.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.viewer-error', { timeout: 10000 });
        const errText = await page.locator('.viewer-error').textContent();
        expect(errText).toContain('表示できません');
        // OS で開くボタン（実クリック → postMessage 記録をハーネスの __postedMessages で観測）
        await page.click('.viewer-open-external');
        const posted = await page.evaluate(() => (window as any).__postedMessages);
        expect(posted.some((m: any) => m.type === 'openExternalFallback')).toBe(true);
    });

    test('TC-FV-06: isEvalSupported:false が getDocument 実引数に渡る', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        const params = await page.evaluate(() => (window as any).__lastGetDocumentParams);
        expect(params).not.toBeNull();
        expect(params.isEvalSupported).toBe(false);
        expect(params.cMapUrl).toBeTruthy();   // 日本語 PDF 用 cmaps 指定
    });
});

test.describe('file-viewer: destroy のリソース解放（reviewer iter1 TASK-10 / TC-FV-40）', () => {

    test('TC-FV-40: destroy(mount) で pdfDocument.destroy が呼ばれる（ARCH-CONS-1 番人）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__lastPdfDocDestroyed = false;
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 30000 });
        await page.evaluate(() => {
            (window as any).__fileViewer.destroy(document.getElementById('viewer-root'));
        });
        const destroyed = await page.evaluate(() => (window as any).__lastPdfDocDestroyed);
        // counterfactual: destroy が cleanupRegistry を呼ばないと false のまま = RED
        // （note 面の hideViewer → destroy(container) 連結は TC-FV-22 が DOM 面で検証済み）
        expect(destroyed, 'pdfDocument.destroy() が呼ばれた').toBe(true);
    });
});
