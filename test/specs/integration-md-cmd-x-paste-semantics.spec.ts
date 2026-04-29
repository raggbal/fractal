/**
 * MD editor cmd+x → cmd+v 仕様契約テスト
 *
 * 仕様 (editor.js paste handler):
 *   - cmd+c (copy)            : sameOutliner / cross-outliner 問わず host.pasteWithAssetCopy を呼ぶ → 常に複製
 *   - cmd+x (cut) sameOutliner: pasteWithAssetCopy を**呼ばない** → 内部 MD 直挿入 (move 経路)
 *   - cmd+x (cut) cross-outl. : pasteWithAssetCopy を呼ぶ → dest に複製、source は orphan
 *
 * このテストは clipboard 経由の dispatch (webview level) と、
 * handler (copyMdPasteAssets) が「source を削除しない契約」(= cross-cut で source orphan)
 * の 2 段を検証する。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

const FILE_PATH = '/Users/raggbal/Desktop/tasks/mns20pzd8hcj/page1.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

const SOURCE_CTX = {
    imageDir: '/tmp/note1/outline1/images',
    fileDir: '/tmp/note1/outline1/files',
    mdDir: '/tmp/note1/outline1/pages'
};
const SAME_AS_SOURCE_CTX = { ...SOURCE_CTX };
const CROSS_CTX = {
    imageDir: '/tmp/note2/outline2/images',
    fileDir: '/tmp/note2/outline2/files',
    mdDir: '/tmp/note2/outline2/pages'
};

async function openSidePanelWithCtx(page: Page, markdown: string, ctx: typeof SOURCE_CTX) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ md, fp, doc, ctx }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel',
            markdown: md,
            filePath: fp,
            fileName: 'page1.md',
            toc: [],
            documentBaseUri: doc
        });
        // 続けて _assetContext を流す (editor.js は sidePanelAssetContext message で _assetContext をセット)
        (window as any).__hostMessageHandler({
            type: 'sidePanelAssetContext',
            imageDir: ctx.imageDir,
            fileDir: ctx.fileDir,
            mdDir: ctx.mdDir
        });
    }, { md: markdown, fp: FILE_PATH, doc: DOC_BASE_URI, ctx });
    await page.waitForTimeout(400);
}

async function selectAllInSidePanelEditor(page: Page) {
    await page.evaluate(() => {
        const sp = document.querySelector('.side-panel');
        const editor: any = sp?.querySelector('.editor[contenteditable]');
        if (!editor) return;
        const r = document.createRange();
        r.selectNodeContents(editor);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
    });
}

async function clearMessages(page: Page) {
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
}

async function getMessages(page: Page): Promise<any[]> {
    return await page.evaluate(() => (window as any).__testApi.messages);
}

/**
 * cut → paste round-trip。dest 側の context を引数で切り替え可能にして
 * sameOutliner / cross-outliner の dispatch を分岐させる。
 */
async function cutThenPaste(page: Page, destCtx: typeof SOURCE_CTX) {
    return await page.evaluate(({ destCtx }) => {
        const sp = document.querySelector('.side-panel');
        const editor: any = sp?.querySelector('.editor[contenteditable]');
        if (!editor) return { err: 'no editor' };

        // cut (source ctx は editor の _assetContext = SOURCE_CTX)
        const data = new DataTransfer();
        const cutEv = new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true });
        Object.defineProperty(cutEv, 'clipboardData', { value: data });
        editor.dispatchEvent(cutEv);

        const cutMd = data.getData('text/x-any-md');
        const cutFlag = data.getData('text/x-any-md-iscut');
        const cutCtx = data.getData('text/x-any-md-context');

        // paste 直前に _assetContext を destCtx に切替 (paste 先 context をシミュレート)
        (window as any).__hostMessageHandler({
            type: 'sidePanelAssetContext',
            imageDir: destCtx.imageDir,
            fileDir: destCtx.fileDir,
            mdDir: destCtx.mdDir
        });

        // cursor を末尾へ
        const tail = editor.lastElementChild || editor;
        const r2 = document.createRange();
        r2.setStart(tail, tail.childNodes.length);
        r2.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r2);

        const pasteEv = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        Object.defineProperty(pasteEv, 'clipboardData', { value: data });
        editor.dispatchEvent(pasteEv);

        return { cutMd, cutFlag, cutCtx, editorAfterPaste: editor.innerHTML };
    }, { destCtx });
}

// ============================================================================
// Webview dispatch 契約: cmd+x sameOutliner = no pasteWithAssetCopy
//                       cmd+x cross-outliner = pasteWithAssetCopy 呼ばれる
// ============================================================================

test.describe('cmd+x dispatch — sameOutliner = move / cross = copy', () => {

    test('image cmd+x same outliner: pasteWithAssetCopy が呼ばれない (move 経路)', async ({ page }) => {
        await openSidePanelWithCtx(page, '![alt](images/photo.png)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        const r = await cutThenPaste(page, SAME_AS_SOURCE_CTX);
        if ('err' in r) throw new Error(r.err);
        expect(r.cutFlag).toBe('1');
        const msgs = await getMessages(page);
        const pwac = msgs.find((m) => m.type === 'pasteWithAssetCopy');
        expect(pwac).toBeFalsy();
        // 内部挿入経路に乗ったので絶対 path 混入なし
        expect(r.editorAfterPaste).toContain('images/photo.png');
        expect(r.editorAfterPaste).not.toContain('/Users/');
    });

    test('image cmd+x cross outliner: pasteWithAssetCopy が呼ばれる (copy + orphan 経路)', async ({ page }) => {
        await openSidePanelWithCtx(page, '![alt](images/photo.png)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        const r = await cutThenPaste(page, CROSS_CTX);
        if ('err' in r) throw new Error(r.err);
        expect(r.cutFlag).toBe('1');
        const msgs = await getMessages(page);
        const pwac = msgs.find((m) => m.type === 'pasteWithAssetCopy');
        expect(pwac).toBeTruthy();
        expect(pwac.markdown).toContain('images/photo.png');
        // sourceContext が source の dir を持っていること (= host が正しく dest に複製できる)
        expect(pwac.sourceContext.imageDir).toBe(SOURCE_CTX.imageDir);
    });

    test('drawio cmd+x same outliner: 同じく内部挿入 (no pasteWithAssetCopy)', async ({ page }) => {
        await openSidePanelWithCtx(page, '![alt](files/diagram.drawio.svg)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        const r = await cutThenPaste(page, SAME_AS_SOURCE_CTX);
        if ('err' in r) throw new Error(r.err);
        expect(r.cutFlag).toBe('1');
        const msgs = await getMessages(page);
        expect(msgs.find((m) => m.type === 'pasteWithAssetCopy')).toBeFalsy();
        expect(r.editorAfterPaste).toContain('files/diagram.drawio.svg');
    });

    test('drawio cmd+x cross outliner: pasteWithAssetCopy', async ({ page }) => {
        await openSidePanelWithCtx(page, '![alt](files/diagram.drawio.svg)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        const r = await cutThenPaste(page, CROSS_CTX);
        if ('err' in r) throw new Error(r.err);
        const pwac = (await getMessages(page)).find((m) => m.type === 'pasteWithAssetCopy');
        expect(pwac).toBeTruthy();
        expect(pwac.markdown).toContain('files/diagram.drawio.svg');
    });

    test('file cmd+x same outliner: 内部挿入 (no pasteWithAssetCopy)', async ({ page }) => {
        await openSidePanelWithCtx(page, '[📎 doc.pdf](files/doc.pdf)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        const r = await cutThenPaste(page, SAME_AS_SOURCE_CTX);
        if ('err' in r) throw new Error(r.err);
        expect((await getMessages(page)).find((m) => m.type === 'pasteWithAssetCopy')).toBeFalsy();
        expect(r.editorAfterPaste).toContain('files/doc.pdf');
    });

    test('file cmd+x cross outliner: pasteWithAssetCopy', async ({ page }) => {
        await openSidePanelWithCtx(page, '[📎 doc.pdf](files/doc.pdf)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        await cutThenPaste(page, CROSS_CTX);
        const pwac = (await getMessages(page)).find((m) => m.type === 'pasteWithAssetCopy');
        expect(pwac).toBeTruthy();
        expect(pwac.markdown).toContain('files/doc.pdf');
    });

    test('md-link cmd+x same outliner: 内部挿入', async ({ page }) => {
        await openSidePanelWithCtx(page, '[memo](memo.md)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        const r = await cutThenPaste(page, SAME_AS_SOURCE_CTX);
        if ('err' in r) throw new Error(r.err);
        expect((await getMessages(page)).find((m) => m.type === 'pasteWithAssetCopy')).toBeFalsy();
        expect(r.editorAfterPaste).toContain('memo.md');
    });

    test('md-link cmd+x cross outliner: pasteWithAssetCopy', async ({ page }) => {
        await openSidePanelWithCtx(page, '[memo](memo.md)\n', SOURCE_CTX);
        await selectAllInSidePanelEditor(page);
        await clearMessages(page);
        await cutThenPaste(page, CROSS_CTX);
        const pwac = (await getMessages(page)).find((m) => m.type === 'pasteWithAssetCopy');
        expect(pwac).toBeTruthy();
        expect(pwac.markdown).toContain('memo.md');
    });
});

// ============================================================================
// Handler 契約 (copyMdPasteAssets): source を削除しない = cross-cut 後 orphan として残る
// ============================================================================

test.describe('copyMdPasteAssets — cross outliner cut で source orphan 契約', () => {
    let tmpDir: string;
    let src: { dir: string; pagesDir: string; imageDir: string; fileDir: string };
    let dst: { dir: string; pagesDir: string; imageDir: string; fileDir: string };

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-cut-orphan-'));
        const note1 = path.join(tmpDir, 'note1', 'outline1');
        const note2 = path.join(tmpDir, 'note2', 'outline2');
        const mk = (base: string) => ({
            dir: base,
            pagesDir: path.join(base, 'pages'),
            imageDir: path.join(base, 'images'),
            fileDir: path.join(base, 'files')
        });
        src = mk(note1);
        dst = mk(note2);
        for (const d of [src, dst]) {
            for (const sub of [d.pagesDir, d.imageDir, d.fileDir]) {
                fs.mkdirSync(sub, { recursive: true });
            }
        }
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('image cross-cut: dest にコピー + source ファイルは消えない (orphan として残る)', () => {
        fs.writeFileSync(path.join(src.imageDir, 'photo.png'), 'PHOTO');
        const result = copyMdPasteAssets({
            markdown: '![alt](../images/photo.png)',
            sourceMdDir: src.pagesDir,
            sourceImageDir: src.imageDir,
            sourceFileDir: src.fileDir,
            destImageDir: dst.imageDir,
            destFileDir: dst.fileDir,
            destMdDir: dst.pagesDir
        });
        // dest に複製
        const destFiles = fs.readdirSync(dst.imageDir);
        expect(destFiles.some((n) => /photo\.png$/.test(n))).toBe(true);
        // source orphan 契約: source 側のファイルは削除されない
        expect(fs.existsSync(path.join(src.imageDir, 'photo.png'))).toBe(true);
        // 結果 markdown は dest 相対 path に書換 + 絶対 path 混入なし
        expect(result.rewrittenMarkdown).not.toContain('/Users/');
        expect(result.rewrittenMarkdown).not.toContain(src.imageDir);
    });

    test('drawio cross-cut: dest fileDir にコピー + source 残る', () => {
        fs.writeFileSync(path.join(src.fileDir, 'diagram.drawio.svg'), '<svg/>');
        const result = copyMdPasteAssets({
            markdown: '![diag](../files/diagram.drawio.svg)',
            sourceMdDir: src.pagesDir,
            sourceImageDir: src.imageDir,
            sourceFileDir: src.fileDir,
            destImageDir: dst.imageDir,
            destFileDir: dst.fileDir,
            destMdDir: dst.pagesDir
        });
        const destFiles = fs.readdirSync(dst.fileDir);
        expect(destFiles.some((n) => /diagram(-\d+)?\.drawio\.svg$/.test(n))).toBe(true);
        // image dir には入らない (drawio は file 系)
        expect(fs.readdirSync(dst.imageDir)).not.toContain('diagram.drawio.svg');
        // source 残る
        expect(fs.existsSync(path.join(src.fileDir, 'diagram.drawio.svg'))).toBe(true);
        expect(result.rewrittenMarkdown).toMatch(/files\/diagram(-\d+)?\.drawio\.svg/);
    });

    test('file cross-cut: dest fileDir にコピー + source 残る', () => {
        fs.writeFileSync(path.join(src.fileDir, 'doc.pdf'), 'PDF');
        copyMdPasteAssets({
            markdown: '[📎 doc.pdf](../files/doc.pdf)',
            sourceMdDir: src.pagesDir,
            sourceImageDir: src.imageDir,
            sourceFileDir: src.fileDir,
            destImageDir: dst.imageDir,
            destFileDir: dst.fileDir,
            destMdDir: dst.pagesDir
        });
        expect(fs.readdirSync(dst.fileDir).some((n) => /doc(-\d+)?\.pdf$/.test(n))).toBe(true);
        expect(fs.existsSync(path.join(src.fileDir, 'doc.pdf'))).toBe(true);
    });

    test('md-link cross-cut: dest pagesDir にコピー + source 残る', () => {
        fs.writeFileSync(path.join(src.pagesDir, 'memo.md'), '# memo');
        copyMdPasteAssets({
            markdown: '[memo](memo.md)',
            sourceMdDir: src.pagesDir,
            sourceImageDir: src.imageDir,
            sourceFileDir: src.fileDir,
            destImageDir: dst.imageDir,
            destFileDir: dst.fileDir,
            destMdDir: dst.pagesDir
        });
        expect(fs.readdirSync(dst.pagesDir).some((n) => /memo(-\d+)?\.md$/.test(n))).toBe(true);
        expect(fs.existsSync(path.join(src.pagesDir, 'memo.md'))).toBe(true);
    });
});
