/**
 * TC-EX-18: notes モードの sidepanel（outliner.js 所有）の export ボタン配線の番人。
 * sprint 20260720-170429-md-export-bundle / TASK-05（manual-test iteration）。
 *
 * バグ: export sprint は editor.js の setupSidePanelHeaderButtons にのみ exportBundle click を配線した。
 *       だが notes モードの sidepanel は outliner.js が所有する（editor.js の openSidePanel は
 *       sidePanelIframeContainer=null で早期 return）。outliner.js の独自 header 配線（:7154+）に
 *       exportBundle が無く、ボタンは表示されるが押しても無反応だった（silent multi-path drop）。
 *
 * この spec は standalone-notes（outliner.js が sidepanel を所有）で:
 *   openSidePanel → export ボタン click → ダイアログ表示 → Export click →
 *   host.exportBundle 経由で {type:'exportBundle', sidePanelFilePath} が post される、を検証する。
 *
 * load-bearing: outliner.js の click 配線が無い（バグ状態）と、click しても message は 0 件 → RED。
 */
import { test, expect, Page } from '@playwright/test';

const FILE_A = '/Users/raggbal/notes/A.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

async function openSidePanel(page: Page, md: string, filePath: string, fileName: string) {
    await page.evaluate(({ md, fp, name, doc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: md, filePath: fp, fileName: name, toc: [], documentBaseUri: doc,
        });
    }, { md, fp: filePath, name: fileName, doc: DOC_BASE_URI });
    await page.waitForTimeout(300);
}

test.describe('TC-EX-18 notes sidepanel export 配線（outliner.js 所有）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await openSidePanel(page, '# A\n\nbody\n', FILE_A, 'A.md');
    });

    test('export ボタンが sidepanel header に存在する', async ({ page }) => {
        const found = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            return !!sp?.querySelector('[data-action="exportBundle"]');
        });
        expect(found).toBe(true);
    });

    test('export ボタン click → ダイアログ表示 → Export で exportBundle が post される（sidePanelFilePath 付き）', async ({ page }) => {
        // click 前は exportBundle message 0 件
        const before = await page.evaluate(() =>
            ((window as any).__testApi.messages || []).filter((m: any) => m.type === 'exportBundle').length);
        expect(before).toBe(0);

        // export ボタンを click → ダイアログ overlay が出る
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const btn = sp?.querySelector('[data-action="exportBundle"]') as HTMLElement;
            btn?.click();
        });
        await page.waitForTimeout(100);
        const dialogVisible = await page.evaluate(() => !!document.querySelector('.md-export-dialog-overlay'));
        expect(dialogVisible, 'export ダイアログが表示される').toBe(true);

        // ダイアログの Export ボタンを click
        await page.evaluate(() => {
            const exec = document.querySelector('.md-export-dialog .md-export-execute') as HTMLElement;
            exec?.click();
        });
        await page.waitForTimeout(100);

        // exportBundle message が post され、sidePanelFilePath が開いている md を指す
        const msgs = await page.evaluate(() =>
            ((window as any).__testApi.messages || [])
                .filter((m: any) => m.type === 'exportBundle')
                .map((m: any) => ({ sidePanelFilePath: m.sidePanelFilePath, options: m.options })));
        expect(msgs.length, 'exportBundle が 1 回 post される').toBe(1);
        expect(msgs[0].sidePanelFilePath, 'root は sidepanel で開いている md').toBe(FILE_A);
        expect(msgs[0].options, 'options が載る').toBeTruthy();
        expect(typeof msgs[0].options.includeChildren).toBe('boolean');
    });
});
