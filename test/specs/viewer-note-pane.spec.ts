/**
 * viewer-note-pane.spec.ts — note 面（viewer-dispatcher）の受信側 — TC-FV-22/35
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-05。
 * ハーネス: standalone-notes.html（viewer-dispatcher.js 組込済み）。
 */
import { test, expect } from '@playwright/test';

test.describe('viewer note 面（FR-FV-06 / TASK-05）', () => {

    test('TC-FV-22: showViewer で他ペイン hidden・hideViewer で復帰 + viewer DOM 破棄（stale 番人）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        // showViewer（message 受信経路）
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });
        // 他ペインが隠れる
        const outlinerHidden = await page.evaluate(() => {
            const el = document.getElementById('outlinerContainer');
            return !el || el.style.display === 'none';
        });
        expect(outlinerHidden).toBe(true);
        // viewer がマウントされている
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });

        // hideViewer（message 受信経路）→ DOM 破棄（counterfactual: display:none だけだと残留で RED）
        await page.evaluate(() => { window.postMessage({ type: 'hideNoteViewer' }, '*'); });
        await page.waitForTimeout(300);
        expect(await page.locator('#viewerContainer .viewer-html-frame').count(), 'viewer DOM が破棄される').toBe(0);
        const containerHidden = await page.evaluate(() => document.getElementById('viewerContainer')!.style.display === 'none');
        expect(containerHidden).toBe(true);
    });

    test('TC-FV-35: 双方向 hide 番人 — 既存タブ切替（showOutliner/showMarkdown）で viewer が消える（counterfactual: hook 除去で RED）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });

        // 既存 dispatcher の面切替を駆動する: loadMarkdown（内部で showMarkdown → hook 発火）は
        // __testApi.mdDispatcher が公開する正規のテスト API（build-standalone-notes.js:574 の返り値）
        await page.evaluate(() => {
            (window as any).__testApi.mdDispatcher.loadMarkdown('# md へ切替', '/x/a.md', '');
        });
        await page.waitForTimeout(500);
        const viewerGone = await page.evaluate(() => {
            const el = document.getElementById('viewerContainer');
            return !el || el.style.display === 'none';
        });
        expect(viewerGone, '既存の面切替で viewer が消える（SYS-1 の双方向 hook）').toBe(true);
        expect(await page.locator('#viewerContainer .viewer-html-frame').count(), 'DOM も破棄').toBe(0);
    });
});

test.describe('note 面 viewer × md sidepanel の排他（reviewer iter3 CONS-1 / TC-FV-59）', () => {

    // standalone で `.side-panel` を open 状態にする（実 openSidePanel は host 往復を伴うため
    // クラス操作で open を再現 — sidepanel-tab-coexist.spec.ts:20 の既存 precedent と同型）。
    async function openMdSidePanelDom(page: import('@playwright/test').Page) {
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            sp.style.display = 'flex';
            sp.classList.add('open');
        });
    }

    test('TC-FV-59: note 面 viewer を開くと md sidepanel が閉じる（counterfactual: showViewer の排他 click を外すと open のまま残り RED）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.waitForFunction(() => (window as any).__viewerDispatcher);
        await openMdSidePanelDom(page);
        expect(await page.locator('.side-panel.open').count(), '前提: md sidepanel が open').toBe(1);

        // note 面 viewer を表示（In-App file link / file panel クリック いずれも showViewer を通る）
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 5000 });
        // ② viewer が実際に mount される（排他だけして viewer が出ないのを防ぐ）
        await page.waitForSelector('#viewerContainer .viewer-html-frame', { timeout: 5000 });

        // ① md sidepanel が閉じる（`.open` の除去は close ボタン click で同期・display:none は 200ms 後）
        await page.waitForTimeout(250);
        expect(
            await page.locator('.side-panel.open').count(),
            'md sidepanel（z-index:100）が viewer（z-index:50）に被さらないよう閉じる'
        ).toBe(0);
        const spHidden = await page.evaluate(() => (document.querySelector('.side-panel') as HTMLElement).style.display === 'none');
        expect(spHidden, 'closeSidePanelImmediate まで到達（display:none）').toBe(true);
    });
});

test.describe('note 面 css 配線（reviewer iter1 TASK-09 / TC-FV-39）', () => {

    test('TC-FV-39: pdf_viewer.css が notes webview に配線される（QUAL-1 契約番人）', async ({ page }) => {
        // PDF 実レンダは TC-FV-04（軽量 standalone ハーネス）に集約 — 実 3 面の表示は手動検収 §1/§4。
        // 本 TC = css 配線の契約（.pdfViewer レイアウトルールの実在）+ pdf kind の message 受理
        await page.goto('/standalone-notes.html');
        const hasPdfCss = await page.evaluate(() => {
            for (const sheet of Array.from(document.styleSheets)) {
                try {
                    for (const rule of Array.from((sheet as CSSStyleSheet).cssRules)) {
                        if ((rule as CSSStyleRule).selectorText?.includes('.pdfViewer')) { return true; }
                    }
                } catch { /* skip */ }
            }
            return false;
        });
        expect(hasPdfCss, '.pdfViewer ルールが notes ハーネス（= 本番 notesWebviewContent と同経路）に存在').toBe(true);
        // pdf kind の showNoteViewer message で viewer コンテナが表示状態になる（レンダ完了は待たない）
        await page.evaluate(() => {
            window.postMessage({ type: 'showNoteViewer', kind: 'pdf', fileUri: './viewer-fixtures/ja-en.pdf', fileName: 'ja-en.pdf', filePath: '/x/ja-en.pdf' }, '*');
        });
        await page.waitForSelector('#viewerContainer', { state: 'visible', timeout: 10000 });
        expect(await page.locator('#viewerContainer .viewer-toolbar').count(), 'viewer がマウントされる').toBe(1);
    });
});
