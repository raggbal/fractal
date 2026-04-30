/**
 * Side panel outline (TOC) は heading が無くても表示される (default ON)
 *
 * 旧仕様: toc.length === 0 で sidebar を closeSidePanelSidebar していたため
 *         heading が 1 つも無い MD では outline 非表示。
 * 新仕様: 空 placeholder ("見出しがありません") を表示し、sidebar は default ON で開く。
 */
import { test, expect, Page } from '@playwright/test';

const FILE_PATH = '/Users/raggbal/notes/sample.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

async function openSidePanelMd(page: Page, md: string, toc: any[] = []) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ md, fp, doc, toc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: md, filePath: fp, fileName: 'sample.md', toc: toc, documentBaseUri: doc
        });
    }, { md, fp: FILE_PATH, doc: DOC_BASE_URI, toc });
    await page.waitForTimeout(400);
}

test.describe('Side panel outline always-on', () => {

    test('heading なしの MD でも outline が表示される (空 placeholder)', async ({ page }) => {
        await openSidePanelMd(page, 'just plain text\n\nno headings here\n');
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const sidebar = sp?.querySelector('.side-panel-sidebar') as HTMLElement | null;
            const toc = sp?.querySelector('.side-panel-toc') as HTMLElement | null;
            const empty = toc?.querySelector('.side-panel-toc-empty');
            return {
                sidebarVisible: sidebar?.classList.contains('visible'),
                tocItemCount: toc?.querySelectorAll('.side-panel-toc-item').length,
                hasEmptyPlaceholder: !!empty,
                emptyText: empty?.textContent
            };
        });
        expect(r.sidebarVisible).toBe(true);
        expect(r.tocItemCount).toBe(0);
        expect(r.hasEmptyPlaceholder).toBe(true);
        expect(r.emptyText).toBeTruthy();
    });

    test('heading あり: 通常通り toc items 表示 (placeholder なし)', async ({ page }) => {
        await openSidePanelMd(page, '# Title\n\n## Sub\n\nbody\n', [
            { level: 1, text: 'Title', anchor: 'title' },
            { level: 2, text: 'Sub', anchor: 'sub' }
        ]);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const sidebar = sp?.querySelector('.side-panel-sidebar') as HTMLElement | null;
            const toc = sp?.querySelector('.side-panel-toc') as HTMLElement | null;
            return {
                sidebarVisible: sidebar?.classList.contains('visible'),
                tocItemCount: toc?.querySelectorAll('.side-panel-toc-item').length,
                hasEmptyPlaceholder: !!toc?.querySelector('.side-panel-toc-empty'),
                texts: Array.from(toc?.querySelectorAll('.side-panel-toc-item') || []).map((a: any) => a.textContent)
            };
        });
        expect(r.sidebarVisible).toBe(true);
        expect(r.tocItemCount).toBeGreaterThanOrEqual(2);
        expect(r.hasEmptyPlaceholder).toBe(false);
        expect(r.texts).toContain('Title');
    });

    test('全 heading 削除 → outline は非表示にならず empty placeholder に切替', async ({ page }) => {
        await openSidePanelMd(page, '# Title\n\nbody\n');
        // simulate user removing all headings — re-render via openSidePanel with new content
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'sidePanelMessage',
                data: { type: 'update', content: 'no headings here' }
            });
        });
        await page.waitForTimeout(200);
        // Trigger TOC re-render via internal markdown sync (mimics editor typing flow)
        await page.evaluate(() => {
            // outliner.js exposes updateSidePanelTocFromMarkdown indirectly via sync;
            // here we trigger by re-opening with empty toc which is the same path the
            // host-side scrollToLine etc. take.
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: 'no headings here',
                filePath: '/Users/raggbal/notes/sample.md',
                fileName: 'sample.md',
                toc: [],
                documentBaseUri: 'http://localhost:3000/note1/'
            });
        });
        await page.waitForTimeout(300);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const sidebar = sp?.querySelector('.side-panel-sidebar') as HTMLElement | null;
            const toc = sp?.querySelector('.side-panel-toc') as HTMLElement | null;
            return {
                sidebarVisible: sidebar?.classList.contains('visible'),
                hasEmptyPlaceholder: !!toc?.querySelector('.side-panel-toc-empty'),
                tocItemCount: toc?.querySelectorAll('.side-panel-toc-item').length
            };
        });
        expect(r.sidebarVisible).toBe(true);
        expect(r.hasEmptyPlaceholder).toBe(true);
        expect(r.tocItemCount).toBe(0);
    });
});
