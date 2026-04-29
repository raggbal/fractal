/**
 * Bug fix regressions:
 *   1. parseMarkdownLine: 空 heading (`# ` だけ) を `<h1><br></h1>` で render
 *      → cmd+/ Add Page で初期 content `# ` が visible h1 として表示される
 *   2. 右クリックで「リンク名変更」context menu
 */
import { test, expect, Page } from '@playwright/test';

const FILE_PATH = '/Users/raggbal/Desktop/tasks/mns20pzd8hcj/page1.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

async function openSidePanelMd(page: Page, md: string) {
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
    }, { md, fp: FILE_PATH, doc: DOC_BASE_URI });
    await page.waitForTimeout(400);
}

test.describe('Empty heading rendering (`# ` only)', () => {

    test('`# ` (trailing space, no text) → <h1><br></h1> visible', async ({ page }) => {
        await openSidePanelMd(page, '# ');
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const h1 = editor?.querySelector('h1');
            return {
                hasH1: !!h1,
                innerHTML: h1?.innerHTML || '',
                rect: h1 ? h1.getBoundingClientRect() : null
            };
        });
        expect(r.hasH1).toBe(true);
        // 空 heading でも <br> を入れて高さを確保
        expect(r.innerHTML.toLowerCase()).toContain('<br>');
        expect(r.rect).toBeTruthy();
        expect((r.rect as any).height).toBeGreaterThan(0);
    });

    test('`# Hello` (with content) は通常通り <h1>Hello</h1>', async ({ page }) => {
        await openSidePanelMd(page, '# Hello');
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const h1 = editor?.querySelector('h1');
            return { html: h1?.innerHTML || '' };
        });
        expect(r.html).toContain('Hello');
        expect(r.html.toLowerCase()).not.toBe('<br>');
    });

    test('`## ` (h2 empty) も同様に <br> 補填', async ({ page }) => {
        await openSidePanelMd(page, '## ');
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const h2 = editor?.querySelector('h2');
            return { hasH2: !!h2, innerHTML: h2?.innerHTML || '' };
        });
        expect(r.hasH2).toBe(true);
        expect(r.innerHTML.toLowerCase()).toContain('<br>');
    });
});

test.describe('Link rename via right-click context menu', () => {

    test('リンク上で contextmenu → "リンク名変更" item が出現', async ({ page }) => {
        await openSidePanelMd(page, '[old name](https://example.com)');
        // Force-show context menu by dispatching contextmenu event on the <a>
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            if (!a) return { err: 'no link' };
            const rect = a.getBoundingClientRect();
            const ev = new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + 2,
                clientY: rect.top + 2
            });
            a.dispatchEvent(ev);
            // Read context menu DOM
            const menu = document.querySelector('.editor-context-menu');
            const labels = menu
                ? Array.from(menu.querySelectorAll('.context-menu-label')).map((s: any) => s.textContent)
                : [];
            return { labels };
        });
        if ('err' in r) throw new Error(r.err);
        expect(r.labels.find((l) => l && (l.includes('Rename Link') || l.includes('リンク名')))).toBeTruthy();
    });

    test('rename クリック → custom modal → OK で textContent 更新', async ({ page }) => {
        await openSidePanelMd(page, '[old name](https://example.com)');
        // Open modal via context menu
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            const rect = a.getBoundingClientRect();
            a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
            const menu = document.querySelector('.editor-context-menu') as HTMLElement | null;
            const items = menu ? Array.from(menu.querySelectorAll('.editor-context-menu-item')) : [];
            const renameItem = items.find((it: any) => {
                const label = it.querySelector('.context-menu-label')?.textContent || '';
                return label.includes('Rename Link') || label.includes('リンク名');
            }) as HTMLElement | undefined;
            if (renameItem) renameItem.click();
        });
        await page.waitForTimeout(150);
        // Modal must be present with input pre-filled
        const probe = await page.evaluate(() => {
            const overlay = document.querySelector('.rename-link-modal-overlay');
            const input: any = overlay?.querySelector('input[type="text"]');
            return { hasModal: !!overlay, value: input?.value };
        });
        expect(probe.hasModal).toBe(true);
        expect(probe.value).toBe('old name');
        // Type new value, click OK
        await page.evaluate(() => {
            const overlay: any = document.querySelector('.rename-link-modal-overlay');
            const input: any = overlay.querySelector('input[type="text"]');
            input.value = 'new name';
            const okBtn = Array.from(overlay.querySelectorAll('button')).reverse()[0] as HTMLButtonElement;
            okBtn.click();
        });
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            const overlay = document.querySelector('.rename-link-modal-overlay');
            return {
                text: a?.textContent || '',
                href: a?.getAttribute('href') || '',
                modalGone: !overlay
            };
        });
        expect(r.text).toBe('new name');
        expect(r.href).toBe('https://example.com'); // href は変えない
        expect(r.modalGone).toBe(true);
    });

    test('rename cancel (Cancel ボタン) → text 不変', async ({ page }) => {
        await openSidePanelMd(page, '[unchanged](https://x.com)');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            const rect = a.getBoundingClientRect();
            a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
            const menu = document.querySelector('.editor-context-menu') as HTMLElement | null;
            const items = menu ? Array.from(menu.querySelectorAll('.editor-context-menu-item')) : [];
            const renameItem = items.find((it: any) => {
                const label = it.querySelector('.context-menu-label')?.textContent || '';
                return label.includes('Rename Link') || label.includes('リンク名');
            }) as HTMLElement | undefined;
            if (renameItem) renameItem.click();
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            const overlay: any = document.querySelector('.rename-link-modal-overlay');
            const input: any = overlay.querySelector('input[type="text"]');
            input.value = 'CHANGED'; // user typed but cancels
            const cancelBtn = overlay.querySelector('button') as HTMLButtonElement; // first button = Cancel
            cancelBtn.click();
        });
        await page.waitForTimeout(120);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            return { text: a?.textContent, modalGone: !document.querySelector('.rename-link-modal-overlay') };
        });
        expect(r.text).toBe('unchanged');
        expect(r.modalGone).toBe(true);
    });

    test('rename Escape で cancel', async ({ page }) => {
        await openSidePanelMd(page, '[esc-test](https://e.com)');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            const rect = a.getBoundingClientRect();
            a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
            const menu = document.querySelector('.editor-context-menu') as HTMLElement | null;
            const items = menu ? Array.from(menu.querySelectorAll('.editor-context-menu-item')) : [];
            const renameItem = items.find((it: any) => {
                const label = it.querySelector('.context-menu-label')?.textContent || '';
                return label.includes('Rename Link') || label.includes('リンク名');
            }) as HTMLElement | undefined;
            if (renameItem) renameItem.click();
        });
        await page.waitForTimeout(150);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            return { text: a?.textContent, modalGone: !document.querySelector('.rename-link-modal-overlay') };
        });
        expect(r.text).toBe('esc-test');
        expect(r.modalGone).toBe(true);
    });

    test('non-link 上で右クリック → "リンク名変更" は出ない', async ({ page }) => {
        await openSidePanelMd(page, 'plain text\n');
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const p = editor?.querySelector('p');
            const rect = p.getBoundingClientRect();
            p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
            const menu = document.querySelector('.editor-context-menu');
            const labels = menu
                ? Array.from(menu.querySelectorAll('.context-menu-label')).map((s: any) => s.textContent)
                : [];
            return { labels };
        });
        expect(r.labels.find((l) => l && (l.includes('Rename Link') || l.includes('リンク名')))).toBeFalsy();
    });

    test('md link [memo](memo.md) も rename 可能 (href 変更なし)', async ({ page }) => {
        await openSidePanelMd(page, '[memo](memo.md)');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            const rect = a.getBoundingClientRect();
            a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
            const menu = document.querySelector('.editor-context-menu') as HTMLElement | null;
            const items = menu ? Array.from(menu.querySelectorAll('.editor-context-menu-item')) : [];
            const renameItem = items.find((it: any) => {
                const label = it.querySelector('.context-menu-label')?.textContent || '';
                return label.includes('Rename Link') || label.includes('リンク名');
            }) as HTMLElement | undefined;
            if (renameItem) renameItem.click();
        });
        await page.waitForTimeout(150);
        // Set value and click OK in modal
        await page.evaluate(() => {
            const overlay: any = document.querySelector('.rename-link-modal-overlay');
            const input: any = overlay.querySelector('input[type="text"]');
            input.value = 'My Memo';
            const okBtn = Array.from(overlay.querySelectorAll('button')).reverse()[0] as HTMLButtonElement;
            okBtn.click();
        });
        await page.waitForTimeout(120);
        const r = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            const a: any = editor?.querySelector('a[href]');
            return { text: a?.textContent || '', href: a?.getAttribute('href') || '' };
        });
        expect(r.text).toBe('My Memo');
        expect(r.href).toBe('memo.md');
    });
});
