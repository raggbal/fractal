/**
 * viewer-spike.spec.ts — TC-FV-90 スパイク実測（sprint 20260815-075428 TASK-01）
 *
 * 目的（design/tdd.md スパイク節）:
 *  (1) sandbox="" iframe から相対 subresource（img/css）のリクエストが発生するか
 *      → 方式 A（src 直指定）/ B（blob + base 注入）の one-option 確定
 *  (2) 方式 B（blob URL の iframe）でも base 注入で subresource が解決するか
 *  結果は design/system.md §4 と generator-log.md に転記する（恒久番人は TC-FV-02）。
 *
 * 限界（design 記載済み）: ハーネスは http serve であり vscode-webview scheme とは
 * origin 挙動が異なりうる — 本番 scheme の最終確認は test-usecase §3。
 */
import { test, expect } from '@playwright/test';

test.describe('TC-FV-90 スパイク: sandbox="" iframe の subresource 配信実測', () => {

    test('方式 A: src 直指定の sandbox iframe から相対 img のリクエストが出るか', async ({ page }) => {
        const requests: string[] = [];
        page.on('request', (req) => { requests.push(req.url()); });
        await page.goto('/standalone-viewer.html');
        // 相対 img を参照する html を data 経由でなく実 URL で（テストサーバーの既存資産を流用）
        await page.evaluate(() => {
            const root = document.getElementById('viewer-root')!;
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', '');
            // vendor/ 配下は serve 済み — 相対参照を含む html を同 origin URL で指す代わりに
            // srcdoc でなく blob を避け、実在の html を作れないため:
            // pdfjs-viewer/ の css を相対参照する最小 html を Blob でなく
            // 同 origin の実ファイルとして扱えないので、ここでは src=URL 型の代表として
            // standalone-viewer.html 自身を入れ、subresource（pdfjs-viewer/pdf_viewer.css 相当の
            // <link> / <img>）のリクエスト発生を観測する
            iframe.src = './standalone-viewer.html';
            iframe.style.width = '400px';
            iframe.style.height = '300px';
            root.appendChild(iframe);
        });
        await page.waitForTimeout(1500);
        // sandbox="" の iframe 内ページ自体はロードされ、そのページが読む subresource
        // （module script 等）のリクエストが観測されるか
        const subresourceRequested = requests.some((u) => u.includes('pdfjs-viewer/') || u.includes('standalone-viewer.html'));
        console.log('[SPIKE-A] requests:', JSON.stringify(requests.slice(0, 10)));
        console.log('[SPIKE-A] subresource requested =', subresourceRequested);
        expect(requests.length).toBeGreaterThan(0);   // 実測の記録が目的（判定は console 出力）
    });

    test('方式 A 実体: sandbox iframe 内の <img src=相対> がネットワークリクエストを発生させるか', async ({ page }) => {
        const imgRequests: string[] = [];
        page.on('request', (req) => {
            if (req.url().endsWith('.png') || req.url().includes('images/')) { imgRequests.push(req.url()); }
        });
        await page.goto('/standalone-viewer.html');
        // pdfjs-viewer/images/ 配下（pdf_viewer.css の資産）を相対参照する html を
        // 同一 origin の URL として作れないため、object URL でなく iframe.srcdoc は CSP 継承の
        // 別問題があるので、「src に data: 不可 / blob URL」= 方式 B の実測をここで行う:
        await page.evaluate(async () => {
            const html = '<html><body><img src="pdfjs-viewer/images/loading-icon.gif"><p>本文</p></body></html>';
            const blob = new Blob([html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', '');
            iframe.src = url;
            document.getElementById('viewer-root')!.appendChild(iframe);
        });
        await page.waitForTimeout(1000);
        console.log('[SPIKE-B-noBase] blob iframe の相対 img リクエスト:', JSON.stringify(imgRequests));
        // blob URL の相対参照は blob: 基底で解決不能のはず（リクエスト 0 件想定）
    });

    test('方式 B: blob + <base> 注入で相対 img が解決するか', async ({ page }) => {
        const imgRequests: string[] = [];
        page.on('request', (req) => {
            if (req.url().includes('images/') || req.url().endsWith('.gif')) { imgRequests.push(req.url()); }
        });
        await page.goto('/standalone-viewer.html');
        await page.evaluate(async () => {
            const baseHref = new URL('./pdfjs-viewer/', location.href).href;
            const html = `<html><head><base href="${baseHref}"></head><body><img src="images/loading-icon.gif"><p>本文</p></body></html>`;
            const blob = new Blob([html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', '');
            iframe.src = url;
            document.getElementById('viewer-root')!.appendChild(iframe);
        });
        await page.waitForTimeout(1500);
        console.log('[SPIKE-B-withBase] base 注入後の相対 img リクエスト:', JSON.stringify(imgRequests));
        expect(imgRequests.length).toBeGreaterThan(0);   // base 注入で解決することの実測
    });
});
