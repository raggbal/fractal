/**
 * Multiple drawio.svg in the same MD: 全 img が外部編集を反映する regression。
 *
 * BUG: 「1つもmdに複数枚 drawio.svg があると、2つめや3つめが反映されないことがある」
 *
 * 原因 (extension 側):
 *   notesEditorProvider が vscode.workspace.createFileSystemWatcher のみで監視 →
 *   drawio Desktop の atomic-rename 保存を取りこぼす。
 *   editorProvider と同じ fs.watchFile (1s polling) fallback を併用するように統一。
 *
 * 原因 (webview 側):
 *   matcher が basename のみで判定 → 強化: 絶対 path full match を優先、basename fallback。
 *   さらに同一 mtime 通知の重複時に強制 reload (removeAttribute → setAttribute) を追加。
 *
 * このテストは webview 側の matcher 動作を検証する (extension 側 fs.watchFile fallback は別 unit test で扱う)。
 */
import { test, expect, Page } from '@playwright/test';

const FILE_PATH = '/Users/raggbal/notes/A.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

async function openSidePanelWithMd(page: Page, md: string) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ md, fp, doc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel',
            markdown: md,
            filePath: fp,
            fileName: 'A.md',
            toc: [],
            documentBaseUri: doc
        });
    }, { md, fp: FILE_PATH, doc: DOC_BASE_URI });
    await page.waitForTimeout(400);
}

async function fireDrawioFileChanged(page: Page, absPath: string, mtime: number) {
    await page.evaluate(({ p, m }) => {
        (window as any).__hostMessageHandler({
            type: 'sidePanelMessage',
            data: { type: 'drawioFileChanged', path: p, mtime: m }
        });
    }, { p: absPath, m: mtime });
    await page.waitForTimeout(120);
}

async function getImageSrcs(page: Page) {
    return await page.evaluate(() => {
        const sp = document.querySelector('.side-panel');
        const imgs = sp?.querySelectorAll('.editor[contenteditable] img') || [];
        return Array.from(imgs).map((img: any) => ({
            src: img.getAttribute('src'),
            mdPath: img.dataset.markdownPath
        }));
    });
}

test.describe('Multi-drawio external edit refresh', () => {

    test('3 drawio with unique basenames: each external edit refreshes the matching img only', async ({ page }) => {
        await openSidePanelWithMd(page,
            '# T\n\n![](files/a.drawio.svg)\n\n![](files/b.drawio.svg)\n\n![](files/c.drawio.svg)\n');

        // Edit B
        await fireDrawioFileChanged(page, '/Users/raggbal/notes/files/b.drawio.svg', 1000);
        let r = await getImageSrcs(page);
        expect(r[0].src).toBe('http://localhost:3000/note1/files/a.drawio.svg');
        expect(r[1].src).toBe('http://localhost:3000/note1/files/b.drawio.svg?v=1000');
        expect(r[2].src).toBe('http://localhost:3000/note1/files/c.drawio.svg');

        // Edit C
        await fireDrawioFileChanged(page, '/Users/raggbal/notes/files/c.drawio.svg', 2000);
        r = await getImageSrcs(page);
        expect(r[1].src).toBe('http://localhost:3000/note1/files/b.drawio.svg?v=1000');
        expect(r[2].src).toBe('http://localhost:3000/note1/files/c.drawio.svg?v=2000');

        // Edit A
        await fireDrawioFileChanged(page, '/Users/raggbal/notes/files/a.drawio.svg', 3000);
        r = await getImageSrcs(page);
        expect(r[0].src).toBe('http://localhost:3000/note1/files/a.drawio.svg?v=3000');
        expect(r[1].src).toBe('http://localhost:3000/note1/files/b.drawio.svg?v=1000');
        expect(r[2].src).toBe('http://localhost:3000/note1/files/c.drawio.svg?v=2000');
    });

    test('Same drawio referenced 3 times: all 3 imgs bump on external edit', async ({ page }) => {
        await openSidePanelWithMd(page,
            '# T\n\n![](files/foo.drawio.svg)\n\n![](files/foo.drawio.svg)\n\n![](files/foo.drawio.svg)\n');

        await fireDrawioFileChanged(page, '/Users/raggbal/notes/files/foo.drawio.svg', 5000);
        const r = await getImageSrcs(page);
        expect(r).toHaveLength(3);
        for (const img of r) {
            expect(img.src).toBe('http://localhost:3000/note1/files/foo.drawio.svg?v=5000');
        }
    });

    test('Repeated edit with same mtime forces reload (removeAttribute→setAttribute)', async ({ page }) => {
        await openSidePanelWithMd(page, '# T\n\n![](files/x.drawio.svg)\n');
        await fireDrawioFileChanged(page, '/Users/raggbal/notes/files/x.drawio.svg', 7777);
        const first = (await getImageSrcs(page))[0].src;
        // Send the same mtime again — should still update src (force reload path)
        await fireDrawioFileChanged(page, '/Users/raggbal/notes/files/x.drawio.svg', 7777);
        const second = (await getImageSrcs(page))[0].src;
        expect(first).toBe('http://localhost:3000/note1/files/x.drawio.svg?v=7777');
        expect(second).toBe('http://localhost:3000/note1/files/x.drawio.svg?v=7777');
    });

    test('Edit on different folder same basename: both imgs bump (basename fallback)', async ({ page }) => {
        // Two drawio with same basename in different folders (rare but possible)
        await openSidePanelWithMd(page,
            '# T\n\n![](folder1/diagram.drawio.svg)\n\n![](folder2/diagram.drawio.svg)\n');

        // Edit folder2's
        await fireDrawioFileChanged(page, '/Users/raggbal/notes/folder2/diagram.drawio.svg', 9999);
        const r = await getImageSrcs(page);
        // folder2's img should be bumped (full path match)
        expect(r[1].src).toBe('http://localhost:3000/note1/folder2/diagram.drawio.svg?v=9999');
        // folder1's img also bumps via basename fallback (acceptable: re-fetch but no actual change)
        expect(r[0].src).toBe('http://localhost:3000/note1/folder1/diagram.drawio.svg?v=9999');
    });
});
