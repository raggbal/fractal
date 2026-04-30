/**
 * fractal.imageMaxWidth (default 600px) は **main editor / side panel 両方** で適用される
 *
 * 旧バグ: standalone editor の main view では効くが、side panel では反映されない症状報告。
 * 修正: max-width: var(--image-max-width, 600px) !important を styles.css 本体に置き、
 *       全 webview (notes / outliner / standalone) で確実にバンドルされるようにした。
 *       per-webview CSS variable 注入は config 値の上書き用。
 */
import { test, expect, Page } from '@playwright/test';

const FILE_A = '/Users/raggbal/notes/A.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

async function loadStandaloneNotes(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

test.describe('Image max-width applies to side panel', () => {

    test('side panel <img> は max-width 600px (default) が computed style に入る', async ({ page }) => {
        await loadStandaloneNotes(page);
        await page.evaluate(({ md, fp, doc }) => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: md, filePath: fp, fileName: 'A.md', toc: [], documentBaseUri: doc
            });
        }, { md: '![alt](images/photo.png)\n', fp: FILE_A, doc: DOC_BASE_URI });
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const img = sp?.querySelector('.editor[contenteditable] img') as HTMLImageElement | null;
            if (!img) return { err: 'no img' };
            return {
                inlineStyle: img.style.maxWidth,
                computed: getComputedStyle(img).maxWidth
            };
        });
        if ('err' in r) throw new Error(r.err);
        // インライン style="max-width:100%" は残る (markup と一致) が、computed は CSS rule の 600px が勝つ
        expect(r.inlineStyle).toBe('100%');
        expect(r.computed).toBe('600px');
    });

    test('drawio.svg も同じ rule で 600px に制約される', async ({ page }) => {
        await loadStandaloneNotes(page);
        await page.evaluate(({ md, fp, doc }) => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: md, filePath: fp, fileName: 'A.md', toc: [], documentBaseUri: doc
            });
        }, { md: '![diag](files/diagram.drawio.svg)\n', fp: FILE_A, doc: DOC_BASE_URI });
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const img = sp?.querySelector('.editor[contenteditable] img') as HTMLImageElement | null;
            if (!img) return { err: 'no img' };
            return { computed: getComputedStyle(img).maxWidth };
        });
        if ('err' in r) throw new Error(r.err);
        expect(r.computed).toBe('600px');
    });

    test('CSS variable 上書きで指定値 400px に変わる', async ({ page }) => {
        await loadStandaloneNotes(page);
        // production 同等: webviewContent.ts が `:root { --image-max-width: 400px }` を注入する想定
        await page.addStyleTag({ content: ':root { --image-max-width: 400px; }' });
        await page.evaluate(({ md, fp, doc }) => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: md, filePath: fp, fileName: 'A.md', toc: [], documentBaseUri: doc
            });
        }, { md: '![alt](images/photo.png)\n', fp: FILE_A, doc: DOC_BASE_URI });
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const img = sp?.querySelector('.editor[contenteditable] img') as HTMLImageElement | null;
            return { computed: img ? getComputedStyle(img).maxWidth : null };
        });
        expect(r.computed).toBe('400px');
    });
});
