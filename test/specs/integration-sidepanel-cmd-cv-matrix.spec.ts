/**
 * Side panel MD editor cmd+c/v 完全 matrix test
 *
 * 検証対象:
 *   asset type: image / file / markdown-link / drawio.svg (image 扱いだが file dir 管理)
 *   layer 1: cmd+c が clipboard text/x-any-md に正しい RELATIVE path で書き出すか
 *   layer 2: cmd+c → cmd+v round-trip で再 render 後も RELATIVE path 維持するか
 *
 * Layer 3 (4 location 別 outliner / 別 note 別 outliner / asset copy) は
 *   integration-md-paste-cross-outliner.spec.ts で copyMdPasteAssets unit として既存カバー。
 */
import { test, expect, Page } from '@playwright/test';

const FILE_PATH = '/Users/raggbal/Desktop/tasks/mns20pzd8hcj/page1.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

async function openSidePanelWith(page: Page, markdown: string) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ md, fp, doc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel',
            markdown: md,
            filePath: fp,
            fileName: 'page1.md',
            toc: [],
            documentBaseUri: doc
        });
    }, { md: markdown, fp: FILE_PATH, doc: DOC_BASE_URI });
    await page.waitForTimeout(400);
}

async function selectAllInSidePanelEditor(page: Page) {
    return await page.evaluate(() => {
        const sidePanel = document.querySelector('.side-panel');
        const editor: any = sidePanel?.querySelector('.editor[contenteditable]');
        if (!editor) return { err: 'no editor' };
        const range = document.createRange();
        range.selectNodeContents(editor);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return { ok: true, html: editor.innerHTML.slice(0, 500) };
    });
}

async function fireCopyAndReadClipboard(page: Page) {
    return await page.evaluate(() => {
        const sidePanel = document.querySelector('.side-panel');
        const editor: any = sidePanel?.querySelector('.editor[contenteditable]');
        if (!editor) return { err: 'no editor' };
        const data = new DataTransfer();
        const ev = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        editor.dispatchEvent(ev);
        return {
            anyMd: data.getData('text/x-any-md'),
            plain: data.getData('text/plain'),
            ctx: data.getData('text/x-any-md-context'),
            isCut: data.getData('text/x-any-md-iscut'),
            html: data.getData('text/html').slice(0, 300)
        };
    });
}

// ============================================================================
// Layer 1: cmd+c serialization (clipboard 出力)
// ============================================================================

test.describe('Layer 1: side panel cmd+c clipboard serialization', () => {

    test('image (.png) ![](rel) → clipboard も rel', async ({ page }) => {
        await openSidePanelWith(page, '![alt](images/photo.png)\n');
        await selectAllInSidePanelEditor(page);
        const r = await fireCopyAndReadClipboard(page);
        expect(r.anyMd).toContain('images/photo.png');
        expect(r.anyMd).not.toContain('http://');
        expect(r.anyMd).not.toContain('/Users/');
    });

    test('drawio.svg ![](rel) → clipboard も rel (img 扱いだが file dir 管理経路)', async ({ page }) => {
        await openSidePanelWith(page, '![alt](files/diagram.drawio.svg)\n');
        await selectAllInSidePanelEditor(page);
        const r = await fireCopyAndReadClipboard(page);
        expect(r.anyMd).toContain('files/diagram.drawio.svg');
        expect(r.anyMd).not.toContain('http://');
        expect(r.anyMd).not.toContain('/Users/');
    });

    test('file [📎](rel) → clipboard も rel', async ({ page }) => {
        await openSidePanelWith(page, '[📎 doc.pdf](files/doc.pdf)\n');
        await selectAllInSidePanelEditor(page);
        const r = await fireCopyAndReadClipboard(page);
        expect(r.anyMd).toContain('files/doc.pdf');
        expect(r.anyMd).not.toContain('http://');
        expect(r.anyMd).not.toContain('/Users/');
    });

    test('markdown link [](*.md) → clipboard も rel', async ({ page }) => {
        await openSidePanelWith(page, '[memo](memo.md)\n');
        await selectAllInSidePanelEditor(page);
        const r = await fireCopyAndReadClipboard(page);
        expect(r.anyMd).toContain('memo.md');
        expect(r.anyMd).toContain('[memo]');
        expect(r.anyMd).not.toContain('http://');
        expect(r.anyMd).not.toContain('/Users/');
    });

    test('regenerate bug — clipboard text/x-any-md must NOT be empty for img-only selection', async ({ page }) => {
        // この bug が再発防止 testbed (旧バグ: img 単体選択で md = "" になる)
        await openSidePanelWith(page, '![alt](images/photo.png)\n');
        await selectAllInSidePanelEditor(page);
        const r = await fireCopyAndReadClipboard(page);
        expect(r.anyMd).toBeTruthy();
        expect(r.anyMd.length).toBeGreaterThan(0);
        expect(r.anyMd).toContain('![');
    });

    test('regenerate bug — file-link single selection も同様', async ({ page }) => {
        await openSidePanelWith(page, '[📎 doc.pdf](files/doc.pdf)\n');
        await selectAllInSidePanelEditor(page);
        const r = await fireCopyAndReadClipboard(page);
        expect(r.anyMd).toBeTruthy();
        expect(r.anyMd).toContain('[📎');
    });

    test('regenerate bug — md-link single selection も同様', async ({ page }) => {
        await openSidePanelWith(page, '[memo](memo.md)\n');
        await selectAllInSidePanelEditor(page);
        const r = await fireCopyAndReadClipboard(page);
        expect(r.anyMd).toBeTruthy();
        expect(r.anyMd).toMatch(/\[memo\]\(memo\.md\)/);
    });
});

// ============================================================================
// Layer 2: cmd+c → cmd+v round-trip (再 render 後の DOM 状態)
// ============================================================================

test.describe('Layer 2: side panel cmd+c → cmd+v round-trip', () => {

    async function runRoundTrip(page: Page, markdown: string) {
        await openSidePanelWith(page, markdown);
        await selectAllInSidePanelEditor(page);
        return await page.evaluate(() => {
            const sidePanel = document.querySelector('.side-panel');
            const editor: any = sidePanel?.querySelector('.editor[contenteditable]');
            if (!editor) return { err: 'no editor' };

            // copy
            const clipData = new DataTransfer();
            const copyEv = new ClipboardEvent('copy', { clipboardData: clipData, bubbles: true, cancelable: true });
            Object.defineProperty(copyEv, 'clipboardData', { value: clipData });
            editor.dispatchEvent(copyEv);
            const copiedMd = clipData.getData('text/x-any-md');

            // cursor を末尾へ
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            if (lastP) {
                const r2 = document.createRange();
                r2.setStart(lastP, lastP.childNodes.length);
                r2.collapse(true);
                const sel = window.getSelection()!;
                sel.removeAllRanges();
                sel.addRange(r2);
            }

            // paste
            const pasteEv = new ClipboardEvent('paste', { clipboardData: clipData, bubbles: true, cancelable: true });
            Object.defineProperty(pasteEv, 'clipboardData', { value: clipData });
            editor.dispatchEvent(pasteEv);
            return {
                copiedMd,
                editorHTML: editor.innerHTML
            };
        });
    }

    test('image round-trip: rel path 維持 + 絶対 path 混入なし', async ({ page }) => {
        const r = await runRoundTrip(page, '![alt](images/photo.png)\n');
        if ('err' in r) throw new Error(r.err);
        expect(r.copiedMd).toContain('images/photo.png');
        expect(r.editorHTML).not.toContain('/Users/');
        expect(r.editorHTML).not.toContain('https://file');
    });

    test('drawio round-trip: rel path 維持 + 絶対 path 混入なし', async ({ page }) => {
        const r = await runRoundTrip(page, '![alt](files/diagram.drawio.svg)\n');
        if ('err' in r) throw new Error(r.err);
        expect(r.copiedMd).toContain('files/diagram.drawio.svg');
        expect(r.editorHTML).not.toContain('/Users/');
        expect(r.editorHTML).not.toContain('https://file');
    });

    test('file [📎] round-trip: rel path 維持', async ({ page }) => {
        const r = await runRoundTrip(page, '[📎 doc.pdf](files/doc.pdf)\n');
        if ('err' in r) throw new Error(r.err);
        expect(r.copiedMd).toContain('files/doc.pdf');
        // 全 img / a の dataset.markdownPath / href が rel か検証
        const datasetCheck = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const links = sp?.querySelectorAll('a[href]') || [];
            return Array.from(links).map((a: any) => ({
                href: a.getAttribute('href'),
                dataset: a.dataset.markdownPath
            }));
        });
        for (const link of datasetCheck) {
            expect(link.href || '').not.toContain('/Users/');
        }
    });

    test('markdown link round-trip: rel path 維持', async ({ page }) => {
        const r = await runRoundTrip(page, '[memo](memo.md)\n');
        if ('err' in r) throw new Error(r.err);
        expect(r.copiedMd).toContain('memo.md');
        expect(r.copiedMd).toContain('[memo]');
        expect(r.editorHTML).not.toContain('/Users/');
        expect(r.editorHTML).not.toContain('https://file');
    });

    test('mixed (image + file + md link) round-trip: 全 rel 維持', async ({ page }) => {
        const md = '![img](images/photo.png) [📎 doc.pdf](files/doc.pdf) [memo](memo.md)';
        const r = await runRoundTrip(page, md + '\n');
        if ('err' in r) throw new Error(r.err);
        expect(r.copiedMd).toContain('images/photo.png');
        expect(r.copiedMd).toContain('files/doc.pdf');
        expect(r.copiedMd).toContain('memo.md');
        expect(r.editorHTML).not.toContain('/Users/');
    });
});
