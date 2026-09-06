/**
 * 2026-09-05 FR-DFI-02 — md 面（note / sidepanel / standalone）へのフォルダ D&D
 * TC-DFI-08 Explorer: uri-list を host に展開依頼（resolveDroppedPaths）→ 返ってきたファイル列を従来の 1 ファイル経路で順に
 * TC-DFI-09 Finder: items の DirectoryEntry を再帰展開して File 列 → 従来の save* 経路で順に（通常ファイルとの混在も）
 */
import { test, expect } from '@playwright/test';

const SAVE = new Set(['saveFileAndInsert', 'saveImageAndInsert', 'saveMdAsSubpage', 'saveDrawioAndInsert']);
const READ = new Set(['readAndInsertFile', 'readAndInsertImage', 'readAndInsertMdAsSubpage', 'readAndInsertDrawio']);

test.describe('md 面へのフォルダ D&D', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.locator('#editor').click();
    });

    test('TC-DFI-08 Explorer: resolveDroppedPaths → droppedPathsResolved の順で 1 ファイル経路を呼ぶ', async ({ page }) => {
        const first = await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            dt.setData('text/uri-list', 'file:///tmp/folder%20A\r\nfile:///tmp/z.pdf');
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            editor.dispatchEvent(ev);
            return JSON.parse(JSON.stringify((window as any).__testApi.messages));
        });
        const req = first.filter((m: any) => m.type === 'resolveDroppedPaths');
        expect(req.length, `展開依頼が 1 回でない: ${first.map((m: any) => m.type).join(',')}`).toBe(1);
        // 拡張子付き（z.pdf）は従来どおり即 dispatch、拡張子なし（folder A）だけ host に展開を頼む
        expect(req[0].paths).toEqual(['/tmp/folder A']);
        const immediate = first.filter((m: any) => READ.has(m.type));
        expect(immediate.map((m: any) => [m.type, m.filePath])).toEqual([['readAndInsertFile', '/tmp/z.pdf']]);
        // host の返信を注入（展開結果 = folder A の中身 2 件）
        const after = await page.evaluate((requestId) => {
            (window as any).__testApi.messages.length = 0;
            (window as any).__hostMessageHandler({ type: 'droppedPathsResolved', requestId, files: ['/tmp/folder A/a.md', '/tmp/folder A/pic.png'] });
            return JSON.parse(JSON.stringify((window as any).__testApi.messages));
        }, req[0].requestId);
        const reads = after.filter((m: any) => READ.has(m.type));
        expect(reads.map((m: any) => [m.type, m.filePath])).toEqual([
            ['readAndInsertMdAsSubpage', '/tmp/folder A/a.md'],
            ['readAndInsertImage', '/tmp/folder A/pic.png'],
        ]);
    });

    test('TC-DFI-09 Finder: DirectoryEntry を再帰展開して File 列 → save* 経路（通常ファイルと混在・drop 順）', async ({ page }) => {
        const msgs = await page.evaluate(async () => {
            (window as any).__testApi.messages.length = 0;
            function fileEntry(name: string, blob: any) { return { isDirectory: false, isFile: true, name, file: (ok: any) => ok(new File([blob], name, { type: name.endsWith('.png') ? 'image/png' : '' })) }; }
            function dirEntry(name: string, children: any[]) { let done = false; return { isDirectory: true, isFile: false, name, createReader: () => ({ readEntries: (ok: any) => { if (done) { ok([]); return; } done = true; ok(children); } }) }; }
            const fake = dirEntry('proj', [fileEntry('index.md', '# Index'), dirEntry('sub', [fileEntry('pic.png', new Uint8Array([1, 2])), fileEntry('.DS_Store', 'x')])]);
            const plain = new File([new Uint8Array([1])], 'solo.pdf', { type: 'application/pdf' });
            const editor = document.getElementById('editor')!;
            const dt: any = {
                types: ['Files'], files: [plain], getData: () => '',
                items: [
                    { kind: 'file', type: 'application/pdf', webkitGetAsEntry: () => ({ isDirectory: false, isFile: true, name: 'solo.pdf' }), getAsFile: () => plain },
                    { kind: 'file', type: '', webkitGetAsEntry: () => fake, getAsFile: () => null },
                ],
            };
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            editor.dispatchEvent(ev);
            await new Promise((res) => setTimeout(res, 600));
            return JSON.parse(JSON.stringify((window as any).__testApi.messages));
        });
        const saves = msgs.filter((m: any) => SAVE.has(m.type));
        expect(saves.map((m: any) => [m.type, m.fileName || m.name]), `saves: ${msgs.map((m: any) => m.type).join(',')}`).toEqual([
            ['saveFileAndInsert', 'solo.pdf'],
            ['saveMdAsSubpage', 'index.md'],
            ['saveImageAndInsert', 'pic.png'],
        ]);
    });
});
