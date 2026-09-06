/**
 * 2026-09-04 ユーザー実機（rc.3）— VS Code 外から md（note main / sidepanel / standalone は同一 document 側 drop
 * handler）へ**複数ファイル**を D&D すると 1 つ目しか貼り付かなかった（`files[0]` / items の先勝ち return / uri-list の先頭 break）。
 * 期待: 全件を drop 順に host へ送る（分類は 1 件ごと従来どおり）。
 *
 * TC-DDM-01（files チャネル 3 件・順序・種別分岐）/ TC-DDM-02（items のみ 2 件）/ TC-DDM-03（uri-list 2 行）
 * 🔴 counterfactual: 実装前は各 TC で host message が 1 件のみ → RED。
 */
import { test, expect, Page } from '@playwright/test';

function mkFile(name: string, mime: string): File {
    return new File([new Uint8Array([60, 120, 62])], name, { type: mime });
}

async function dropFiles(page: Page, specs: { name: string; mime: string }[], itemsOnly = false) {
    await page.evaluate(({ specs, itemsOnly }) => {
        (window as any).__testApi.messages.length = 0;
        const editor = document.getElementById('editor')!;
        const dt = new DataTransfer();
        for (const s of specs) { dt.items.add(new File([new Uint8Array([60, 120, 62])], s.name, { type: s.mime })); }
        if (itemsOnly) { Object.defineProperty(dt, 'files', { value: [], configurable: true }); }
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        editor.dispatchEvent(ev);
    }, { specs, itemsOnly });
    await page.waitForTimeout(500); // FileReader ×N は直列 async
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
}

const SAVE_TYPES = new Set(['saveFileAndInsert', 'saveImageAndInsert', 'saveMdAsSubpage', 'saveDrawioAndInsert']);
const READ_TYPES = new Set(['readAndInsertFile', 'readAndInsertImage', 'readAndInsertMdAsSubpage', 'readAndInsertDrawio']);

test.describe('md エディタへの複数ファイル D&D（全件・drop 順）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.locator('#editor').click();
    });

    test('TC-DDM-01 files チャネル: pdf + png + md の 3 件が drop 順に、種別ごとの host 経路で全件届く', async ({ page }) => {
        const msgs = await dropFiles(page, [
            { name: 'a.pdf', mime: 'application/pdf' },
            { name: 'b.png', mime: 'image/png' },
            { name: 'c.md', mime: 'text/markdown' },
        ]);
        const saves = msgs.filter((m: any) => SAVE_TYPES.has(m.type));
        expect(saves.length, `host へ届いた件数: ${msgs.map((m: any) => m.type).join(',')}`).toBe(3);
        expect(saves.map((m: any) => m.fileName || m.name)).toEqual(['a.pdf', 'b.png', 'c.md']);
        expect(saves[0].type).toBe('saveFileAndInsert');
        expect(saves[1].type).toBe('saveImageAndInsert');
        expect(['saveMdAsSubpage', 'saveFileAndInsert']).toContain(saves[2].type);
    });

    test('TC-DDM-02 items チャネルのみ: 2 件とも届く（先勝ち return の除去）', async ({ page }) => {
        const msgs = await dropFiles(page, [
            { name: 'x.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            { name: 'y.txt', mime: 'text/plain' },
        ], true);
        const saves = msgs.filter((m: any) => SAVE_TYPES.has(m.type));
        expect(saves.map((m: any) => m.fileName || m.name)).toEqual(['x.docx', 'y.txt']);
    });

    test('TC-DDM-03 uri-list チャネル: 2 行とも host の read 経路へ（先頭 1 件で break しない）', async ({ page }) => {
        const msgs = await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            dt.setData('text/uri-list', 'file:///tmp/one.pdf\r\nfile:///tmp/two%20pic.png\r\n');
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            editor.dispatchEvent(ev);
            return JSON.parse(JSON.stringify((window as any).__testApi.messages));
        });
        const reads = msgs.filter((m: any) => READ_TYPES.has(m.type));
        expect(reads.length, `read 経路の件数: ${msgs.map((m: any) => m.type).join(',')}`).toBe(2);
        expect(reads[0].type).toBe('readAndInsertFile');
        expect(reads[0].filePath || reads[0].path).toBe('/tmp/one.pdf');
        expect(reads[1].type).toBe('readAndInsertImage');
        expect(reads[1].filePath || reads[1].path).toBe('/tmp/two pic.png');
    });

    test('TC-DDM-04 regression: 1 件 drop は従来どおり 1 件', async ({ page }) => {
        const msgs = await dropFiles(page, [{ name: 'solo.pdf', mime: 'application/pdf' }]);
        expect(msgs.filter((m: any) => SAVE_TYPES.has(m.type)).length).toBe(1);
    });
});
