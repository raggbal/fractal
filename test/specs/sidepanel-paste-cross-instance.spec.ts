/**
 * sidepanel-paste-cross-instance — sidepanel paste の cross-instance 混線修正の E2E
 *
 * バグ: notes モードで sidepanel の md に画像 paste すると、backend の insertImageHtml が単一 webview に
 * broadcast され、メインペイン md instance が instance-local フラグ破れで誤受信 → 親メインペインにも貼りつく。
 * 修正: insertImageHtml/insertFileLink に sidePanelFilePath（宛先）を載せ、受信側が「自分宛か」を判定。
 *
 * ★2 系統受信の忠実化: standalone-notes の test bridge は onMessage を配列（__hostMessageHandlers）に push し
 * __hostMessageHandler で全 handler へ配送する（本番の window broadcast = 全 instance 受信を再現）。
 * loadMarkdownPane で md pane instance を、openSidePanel で sidepanel instance を構築して 2 系統受信を作る。
 *
 * TC-CI-01 (load-bearing): sidepanel 宛 insertImageHtml → メインペイン md pane editor に img 0 / sidepanel に 1。
 *          counterfactual: sidePanelFilePath 無しだと md pane に img が入る（fix を戻すと RED）。
 * TC-CI-04: sidePanelFilePath 無し（メイン宛）→ md pane editor に挿入される（従来どおり）。
 */
import { test, expect, Page } from '@playwright/test';

const SP_FILE = '/Users/imaken/workspace/fractal/newtest3/page-sp.md';
const SP_DOC_BASE = 'http://localhost:3000/newtest3/';

async function setupNotesTwoInstances(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // (1) メインペイン md instance を構築（editor.js md instance = 誤受信しうる側）
    await page.evaluate(() => (window as any).__testApi.loadMarkdownPane('# main pane\n'));
    // (2) sidepanel instance を構築（outliner.js 管轄）
    await page.evaluate(({ fp, doc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: '# side panel\n', filePath: fp, fileName: 'page-sp.md', toc: [], documentBaseUri: doc
        });
    }, { fp: SP_FILE, doc: SP_DOC_BASE });
    await page.waitForTimeout(400);
    // 2 系統受信の成立確認（handler が 2 本以上登録されている）
    const handlerCount = await page.evaluate(() => ((window as any).__hostMessageHandlers || []).length);
    expect(handlerCount, '2 系統受信の成立（md pane + sidepanel の handler 登録）').toBeGreaterThanOrEqual(2);
}

function imgCounts(page: Page) {
    return page.evaluate(() => ({
        mainPane: document.querySelectorAll('.markdown-container .editor img').length,
        sidePanel: document.querySelectorAll('.side-panel .editor img').length,
    }));
}

test.describe('sidepanel paste cross-instance', () => {
    test('TC-CI-01: sidepanel 宛 insertImageHtml はメインペインに貼りつかない（load-bearing）', async ({ page }) => {
        await setupNotesTwoInstances(page);
        // sidepanel 宛（sidePanelFilePath あり）の insertImageHtml を broadcast
        await page.evaluate(({ fp }) => {
            (window as any).__hostMessageHandler({
                type: 'insertImageHtml',
                markdownPath: 'images/x.png',
                displayUri: 'http://localhost:3000/newtest3/images/x.png',
                sidePanelFilePath: fp,
            });
        }, { fp: SP_FILE });
        await page.waitForTimeout(200);
        const c = await imgCounts(page);
        expect(c.mainPane, 'メインペイン md には貼りつかない').toBe(0);
        expect(c.sidePanel, 'sidepanel にだけ挿入').toBe(1);

        // ★counterfactual: sidePanelFilePath 無し（旧挙動相当）だと md pane にも img が入る = 宛先判定が load-bearing
        const cf = await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'insertImageHtml',
                markdownPath: 'images/y.png',
                displayUri: 'http://localhost:3000/newtest3/images/y.png',
                // sidePanelFilePath 無し = メイン宛判定 → md pane に挿入される
            });
            return document.querySelectorAll('.markdown-container .editor img').length;
        });
        expect(cf, 'counterfactual: sidePanelFilePath 無しだと md pane に img が入る（fix を戻すと TC が RED になる証拠）').toBeGreaterThanOrEqual(1);
    });

    test('TC-CI-05: sidepanel drawio（isMd=true でも sidepanel 宛）はメインに貼りつかない（load-bearing）', async ({ page }) => {
        // メインが md を開いた状態（isMd=true）+ sidepanel から drawio insert のケース。
        // backend の is-from-sidepanel 是正後は insertImageHtml に sidePanelFilePath を載せて broadcast する。
        // それを受信側が sidepanel にのみ挿入し、メインペイン md には入らないことを検証。
        await setupNotesTwoInstances(page);
        await page.evaluate(({ fp }) => {
            (window as any).__hostMessageHandler({
                type: 'insertImageHtml',
                markdownPath: 'files/diagram.drawio.svg',
                displayUri: 'http://localhost:3000/newtest3/files/diagram.drawio.svg',
                sidePanelFilePath: fp, // drawio 由来でも sidepanel 宛（是正後）
            });
        }, { fp: SP_FILE });
        await page.waitForTimeout(200);
        const c = await imgCounts(page);
        expect(c.mainPane, 'drawio: メインペイン md には貼りつかない').toBe(0);
        expect(c.sidePanel, 'drawio: sidepanel にだけ挿入').toBe(1);

        // ★counterfactual: isMd 分岐に戻して drawio がメイン基準で sidePanelFilePath を載せない旧挙動だと md pane に入る
        const cf = await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'insertImageHtml',
                markdownPath: 'files/diagram2.drawio.svg',
                displayUri: 'http://localhost:3000/newtest4/files/diagram2.drawio.svg',
                // sidePanelFilePath 無し = 旧 isMd=true 挙動（メイン宛）→ md pane に貼りつく
            });
            return document.querySelectorAll('.markdown-container .editor img').length;
        });
        expect(cf, 'counterfactual: sidePanelFilePath を載せないと drawio が md pane に貼りつく（是正を戻すと RED）').toBeGreaterThanOrEqual(1);
    });

    test('TC-CI-04: sidePanelFilePath 無し（メイン宛）は md pane に挿入される（後方互換）', async ({ page }) => {
        await setupNotesTwoInstances(page);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'insertImageHtml',
                markdownPath: 'images/main.png',
                displayUri: 'http://localhost:3000/main/images/main.png',
                // sidePanelFilePath 無し = 自分（md pane）宛
            });
        });
        await page.waitForTimeout(200);
        const c = await imgCounts(page);
        expect(c.mainPane, 'メイン宛は md pane に挿入').toBeGreaterThanOrEqual(1);
    });
});
