/**
 * Side panel cmd+/ navigation history (back/forward) regression
 *
 * BUG: side panel で .md link をクリックしても back ボタンがアクティブにならず、
 * 押しても戻れない症状があった。
 *
 * 根本原因: openSidePanel(B.md) が closeSidePanelImmediate() を呼ぶ実装。
 *   closeSidePanelImmediate は host.notifySidePanelClosed() を発火し、
 *   extension 側で SidePanelManager.handleClose → clearNavigationHistory が走り、
 *   handleOpenLink で push されたばかりの back stack が即座に消えていた。
 *
 * 修正: closeSidePanelImmediate(isSwitch=true) — file 切替時は notify せず history 保持。
 */
import { test, expect, Page } from '@playwright/test';

const FILE_A = '/Users/raggbal/notes/A.md';
const FILE_B = '/Users/raggbal/notes/B.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

async function openSidePanel(page: Page, md: string, filePath: string, fileName: string) {
    await page.evaluate(({ md, fp, name, doc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: md, filePath: fp, fileName: name, toc: [], documentBaseUri: doc
        });
    }, { md, fp: filePath, name: fileName, doc: DOC_BASE_URI });
    await page.waitForTimeout(300);
}

async function sendNavStateUpdate(page: Page, canGoBack: boolean, canGoForward: boolean) {
    await page.evaluate(({ b, f }) => {
        (window as any).__hostMessageHandler({
            type: 'sidePanelMessage',
            data: { type: 'sidePanelNavStateUpdate', canGoBack: b, canGoForward: f }
        });
    }, { b: canGoBack, f: canGoForward });
    await page.waitForTimeout(150);
}

test.describe('Side panel link → nav state → back click flow', () => {

    test('link click → openSidePanel(B) + navStateUpdate → back ボタン enabled', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await openSidePanel(page, '# A\n\n[Go to B](B.md)\n', FILE_A, 'A.md');

        // Initial: back disabled
        const before = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const nb = sp?.querySelector('[data-action="navigateBack"]') as HTMLButtonElement;
            return { disabled: nb?.disabled };
        });
        expect(before.disabled).toBe(true);

        // Simulate link click → host message posted (sidePanelOpenLink with current path A.md)
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const a = sp?.querySelector('.editor[contenteditable] a[href]');
            (a as HTMLElement)?.click();
        });
        await page.waitForTimeout(150);

        const linkMessages = await page.evaluate(() => {
            return (((window as any).__testApi.messages || []) as any[])
                .filter(m => m.type === 'sidePanelOpenLink')
                .map(m => ({ href: m.href, sidePanelFilePath: m.sidePanelFilePath }));
        });
        expect(linkMessages).toHaveLength(1);
        expect(linkMessages[0].href).toBe('B.md');
        expect(linkMessages[0].sidePanelFilePath).toBe(FILE_A);

        // Simulate extension's response: openSidePanel(B.md) + navStateUpdate(canGoBack=true)
        await openSidePanel(page, '# B\n', FILE_B, 'B.md');
        await sendNavStateUpdate(page, true, false);

        const after = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const nb = sp?.querySelector('[data-action="navigateBack"]') as HTMLButtonElement;
            const nf = sp?.querySelector('[data-action="navigateForward"]') as HTMLButtonElement;
            const filename = sp?.querySelector('.side-panel-filename')?.textContent;
            return {
                backDisabled: nb?.disabled, backOpacity: nb?.style.opacity,
                forwardDisabled: nf?.disabled, forwardOpacity: nf?.style.opacity,
                filename
            };
        });
        // 切替後は B.md が表示され、back ボタンは enabled (canGoBack=true)
        expect(after.filename).toBe('B.md');
        expect(after.backDisabled).toBe(false);
        expect(after.backOpacity).toBe('1');
        expect(after.forwardDisabled).toBe(true);
    });

    test('back ボタンクリック → sidePanelNavigateBack 発火 (currentFilePath 付き)', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await openSidePanel(page, '# B\n', FILE_B, 'B.md');
        await sendNavStateUpdate(page, true, false);

        await page.evaluate(() => { (window as any).__testApi.messages = []; });

        // Click back
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const nb = sp?.querySelector('[data-action="navigateBack"]') as HTMLButtonElement;
            nb?.click();
        });
        await page.waitForTimeout(150);

        const messages = await page.evaluate(() => {
            return (((window as any).__testApi.messages || []) as any[])
                .filter(m => m.type === 'sidePanelNavigateBack');
        });
        expect(messages).toHaveLength(1);
        expect(messages[0].sidePanelFilePath).toBe(FILE_B);
    });

    test('panel switch (openSidePanel A→B) で notifySidePanelClosed は発火しない (history 保護)', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await openSidePanel(page, '# A\n', FILE_A, 'A.md');
        await page.evaluate(() => { (window as any).__testApi.messages = []; });

        // Switch to B (this is what extension does on link click)
        await openSidePanel(page, '# B\n', FILE_B, 'B.md');

        const messages = await page.evaluate(() => {
            return (((window as any).__testApi.messages || []) as any[])
                .filter(m => m.type === 'sidePanelClosed');
        });
        // sidePanelClosed must NOT fire on switch — that would clear back stack
        expect(messages).toHaveLength(0);
    });

    test('明示的 close (× ボタン) では notifySidePanelClosed が発火する', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await openSidePanel(page, '# A\n', FILE_A, 'A.md');
        await page.evaluate(() => { (window as any).__testApi.messages = []; });

        // Click × close button
        await page.evaluate(() => {
            const closeBtn = document.querySelector('.side-panel-close') as HTMLButtonElement;
            closeBtn?.click();
        });
        await page.waitForTimeout(400);

        const messages = await page.evaluate(() => {
            return (((window as any).__testApi.messages || []) as any[])
                .filter(m => m.type === 'sidePanelClosed');
        });
        expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    test('forward navigation も同様に動作', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await openSidePanel(page, '# A\n', FILE_A, 'A.md');
        // Simulate user navigated A→B→back to A — now canGoForward=true
        await sendNavStateUpdate(page, false, true);

        const before = await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const nf = sp?.querySelector('[data-action="navigateForward"]') as HTMLButtonElement;
            return { disabled: nf?.disabled, opacity: nf?.style.opacity };
        });
        expect(before.disabled).toBe(false);
        expect(before.opacity).toBe('1');

        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const nf = sp?.querySelector('[data-action="navigateForward"]') as HTMLButtonElement;
            nf?.click();
        });
        await page.waitForTimeout(150);

        const messages = await page.evaluate(() => {
            return (((window as any).__testApi.messages || []) as any[])
                .filter(m => m.type === 'sidePanelNavigateForward');
        });
        expect(messages).toHaveLength(1);
        expect(messages[0].sidePanelFilePath).toBe(FILE_A);
    });
});
