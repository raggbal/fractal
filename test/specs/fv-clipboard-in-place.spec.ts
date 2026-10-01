/**
 * その場複製: linkedfd で Cmd+C → 選択を変えずに Cmd+V（FR-CBD-07 rev3 / ADRL-0133 / DOM-InPlacePaste）
 * sprint 20260930-192647-linkedfd-conflict-rename-and-paste-sibling
 *
 * TC-IPP-01: ファイルを選択 → Cmd+C → そのまま Cmd+V で宛先 = 親
 * TC-IPP-02: フォルダを選択 → Cmd+C → そのまま Cmd+V で宛先 = 親（中ではない）
 * TC-IPP-03: 複数選択で focus がコピー元の 1 つ → 全件を focus 行の親へ
 * TC-IPP-04: Cmd+C 後に別フォルダを選んで Cmd+V → その中（不変）
 *
 * copy は実キー押下（keydown 駆動）、paste は fv-clipboard.spec.ts と同じく実 clipboard の内容を
 * document.body へ配送する（Chromium の配送先の模倣 = HM-5）。
 * 番人: H 分岐の「focus がコピー元なら親」を外すと TC-IPP-02/03 が落ちる / 「フォルダ行なら常に親」に
 * 広げると TC-IPP-04 が落ちる。
 */
import { test, expect, Page } from '@playwright/test';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function mountFv(page: Page): Promise<void> {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { /* noop */ });
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() =>
        !!(window as any).__folderViewDispatcher && !!(window as any).__folderView, undefined, { timeout: 8000 });
    await page.evaluate(() => {
        const w = window as any;
        w.__calls = [];
        w.notesHostBridge = new Proxy({}, {
            get: (_t, prop: string) => (...args: any[]) => { w.__calls.push({ type: prop, args }); },
        });
    });
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.evaluate(() => {
        const entries: any[] = [
            { name: 'assets', relPath: 'assets', isDir: true },
            { name: 'docs', relPath: 'docs', isDir: true },
            { name: 'a.md', relPath: 'a.md', isDir: false },
            { name: 'c.txt', relPath: 'c.txt', isDir: false },
        ];
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}

const clickRow = (page: Page, rel: string, meta = false) =>
    page.locator(`.fv-row[data-rel="${rel}"]`).click({ modifiers: meta ? [MOD as any] : [] });

async function copyNow(page: Page) {
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(250);
}

async function pasteToBody(page: Page) {
    await page.evaluate(() => { (window as any).__calls.length = 0; });
    await page.evaluate(async () => {
        let html = ''; let plain = '';
        const items = await navigator.clipboard.read();
        for (const it of items) {
            if (it.types.includes('text/html')) { html = await (await it.getType('text/html')).text(); }
            if (it.types.includes('text/plain')) { plain = await (await it.getType('text/plain')).text(); }
        }
        const dt = new DataTransfer();
        dt.setData('text/plain', plain);
        dt.setData('text/html', html);
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(250);
}
const calledMove = (page: Page) => page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.type === 'folderViewMove' || c.type === 'folderViewMoveBatch'));

test.describe('その場複製の貼り付け先（FR-CBD-07 rev3 / ADRL-0133）', () => {
    test('TC-IPP-01: ファイルを選択 → Cmd+C → そのまま Cmd+V で宛先 = 親', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await copyNow(page);
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length, 'H 分岐が発火していない').toBe(1);
        expect(mv[0].type).toBe('folderViewMove');
        expect(mv[0].args).toEqual(['fl1', 'a.md', '', 'copy']);
    });

    test('TC-IPP-02: フォルダを選択 → Cmd+C → そのまま Cmd+V で宛先 = 親（中ではない）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'assets');
        await copyNow(page);
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length, 'H 分岐が発火していない').toBe(1);
        expect(mv[0].type).toBe('folderViewMoveBatch');
        expect(mv[0].args[1]).toEqual(['assets']);
        expect(mv[0].args[2], 'コピー元フォルダ自身の中が宛先になっている').toBe('');
        expect(mv[0].args[3]).toBe('copy');
    });

    test('TC-IPP-03: 複数選択で focus がコピー元の 1 つ → 全件を focus 行の親へ', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await clickRow(page, 'assets', true);   // focus = assets（フォルダ行）
        await copyNow(page);
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length).toBe(1);
        expect(mv[0].type).toBe('folderViewMoveBatch');
        expect([...mv[0].args[1]].sort()).toEqual(['a.md', 'assets']);
        expect(mv[0].args[2], 'focus がコピー元なのに中が宛先になっている').toBe('');
        expect(mv[0].args[3]).toBe('copy');
    });

    test('TC-IPP-04: Cmd+C 後に別フォルダを選んで Cmd+V → その中（不変）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await copyNow(page);
        await clickRow(page, 'docs');
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length).toBe(1);
        expect(mv[0].args[2], 'コピー元以外のフォルダ行なのにその中にならない').toBe('docs');
    });
});
