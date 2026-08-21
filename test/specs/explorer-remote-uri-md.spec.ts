/**
 * TC-RMT-04 — md editor の uri-list drop で vscode-remote scheme を受理（sprint 20260820-034017 FR-RMT-01）
 *
 * editor.js は uri-list を webview 内で fs パス化してから host（readAndInsert*）へ渡す既存非対称構造。
 * vscode-remote 分岐は host 正典 droppedUriToFsPath と同規則の最小ミラー（authority 除去 +
 * percent-decode + Windows ドライブ先頭スラッシュ剥がし）— 規則一致は TC-RMT-01（host）と本 TC
 * （webview・同一 fixture）が両側から pin する。
 */
import { test, expect, Page } from '@playwright/test';

async function dropUriList(page: Page, uriList: string) {
    await page.evaluate((ul) => {
        (window as any).__testApi.messages.length = 0;
        const editor = document.getElementById('editor')!;
        const dt = new DataTransfer();
        dt.setData('text/uri-list', ul);
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        editor.dispatchEvent(ev);
    }, uriList);
    await page.waitForTimeout(200);
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
}

function readInsertMsgs(msgs: any[]): any[] {
    return msgs.filter((m: any) => String(m.type || '').startsWith('readAndInsert'));
}

test.describe('md editor uri-list drop — vscode-remote scheme（TC-RMT-04）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.locator('#editor').click();
    });

    test('TC-RMT-04a vscode-remote の .md → subpage 取込 message が decode 済みパスで送出', async ({ page }) => {
        const msgs = await dropUriList(page, 'vscode-remote://ssh-remote%2Bhost/tmp/my%20doc%20%E3%83%A1%E3%83%A2.md');
        const hits = readInsertMsgs(msgs);
        expect(hits.length, 'readAndInsert 系 message が飛んでいない（vscode-remote 未対応）').toBe(1);
        expect(hits[0].type).toMatch(/readAndInsertMdAsSubpage|readAndInsertFile/);
        const p = hits[0].filePath || hits[0].path;
        expect(p).toBe('/tmp/my doc メモ.md'); // percent-decode 済み・authority 除去済み
    });

    test('TC-RMT-04b vscode-remote の .pdf → readAndInsertFile', async ({ page }) => {
        const msgs = await dropUriList(page, 'vscode-remote://ssh-remote%2Bhost/tmp/report.pdf');
        const hits = readInsertMsgs(msgs);
        expect(hits.length).toBe(1);
        expect(hits[0].type).toBe('readAndInsertFile');
        expect(hits[0].filePath || hits[0].path).toBe('/tmp/report.pdf');
    });

    test('TC-RMT-04c Windows 変種（host 正典 TC-RMT-01 と同一 fixture）→ ドライブ先頭スラッシュ剥がし', async ({ page }) => {
        const msgs = await dropUriList(page, 'vscode-remote://wsl%2Bubuntu/C:/x/y.md');
        const hits = readInsertMsgs(msgs);
        expect(hits.length, 'Windows 変種が取り込まれない（ミラー規則の分裂 = TDD-1）').toBe(1);
        expect(hits[0].filePath || hits[0].path).toBe('C:/x/y.md');
    });

    test('TC-RMT-04f query/fragment は path 成分に含めない（host 正典 TC-RMT-01 と同一 fixture — 規則一致 pin）', async ({ page }) => {
        const msgs = await dropUriList(page, 'vscode-remote://ssh-remote%2Bhost/tmp/c.md?query=1#frag');
        const hits = readInsertMsgs(msgs);
        expect(hits.length).toBe(1);
        expect(hits[0].filePath || hits[0].path).toBe('/tmp/c.md');
    });

    test('TC-RMT-04g encoded path separator（%2F）は拒否 — 取込 message ゼロ（SEC-1 の webview 側）', async ({ page }) => {
        const msgs = await dropUriList(page, 'vscode-remote://ssh-remote%2Bhost/home/user/..%2F..%2Fetc%2Fpasswd.md');
        expect(readInsertMsgs(msgs).length).toBe(0);
    });

    test('TC-RMT-04d 他 scheme（http の .md）は無視 — readAndInsert 系 message ゼロ', async ({ page }) => {
        const msgs = await dropUriList(page, 'http://example.com/x.md');
        expect(readInsertMsgs(msgs).length).toBe(0);
    });

    test('TC-RMT-04e file:// は従来どおり（regression pin）', async ({ page }) => {
        const msgs = await dropUriList(page, 'file:///tmp/plain.md');
        const hits = readInsertMsgs(msgs);
        expect(hits.length).toBe(1);
        expect(hits[0].type).toMatch(/readAndInsertMdAsSubpage|readAndInsertFile/);
        expect(hits[0].filePath || hits[0].path).toBe('/tmp/plain.md');
    });
});
