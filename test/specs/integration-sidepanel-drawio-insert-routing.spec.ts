/**
 * Side panel cmd+/ → drawio insert routing regression
 *
 * BUG: side panel から cmd+/ → "Insert Drawio" を実行しても drawio.svg が挿入されないことがある。
 *
 * 根本原因: SidePanelHostBridge.requestCreateDrawio() が _onImageRequest() を呼んでいなかった。
 *   その結果 sidePanelImagePending=true がセットされず、extension からの insertImageHtml response が
 *   main editor に流れて side panel editor へ届かない (marker も main editor に無いため fallback も失敗)。
 *
 * 修正: SidePanelHostBridge.requestCreateDrawio() で必ず _onImageRequest() を呼ぶ。
 */
import { test, expect, Page } from '@playwright/test';

const FILE_PATH = '/Users/raggbal/notes/A.md';
const DOC_BASE_URI = 'http://localhost:3000/note1/';

test('side panel requestCreateDrawio sets sidePanelImagePending=true (routing fix)', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);

    // Open a side panel with editor
    await page.evaluate(({ md, fp, doc }) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel',
            markdown: md,
            filePath: fp,
            fileName: 'A.md',
            toc: [],
            documentBaseUri: doc
        });
    }, { md: '# A\n\n', fp: FILE_PATH, doc: DOC_BASE_URI });
    await page.waitForTimeout(400);

    // Probe: side panel host bridge has _onImageRequest callback
    const probe = await page.evaluate(() => {
        const sp = document.querySelector('.side-panel');
        const editor: any = sp?.querySelector('.editor[contenteditable]');
        // Find the side panel EditorInstance via getActiveInstance
        editor?.focus();
        const inst = (window as any).EditorInstance?.getActiveInstance?.();
        const host: any = inst?.host;
        // Trigger requestCreateDrawio — must invoke _onImageRequest
        let imgRequestCalled = false;
        if (host && typeof host._onImageRequest !== 'undefined') {
            const orig = host._onImageRequest;
            host._onImageRequest = function() {
                imgRequestCalled = true;
                if (orig) orig.call(host);
            };
        }
        host.requestCreateDrawio();
        return { imgRequestCalled };
    });

    expect(probe.imgRequestCalled).toBe(true);
});

test('side panel insertImageHtml routes to side panel editor when sidePanelImagePending is set', async ({ page }) => {
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
    }, { md: '# A\n\n', fp: FILE_PATH, doc: DOC_BASE_URI });
    await page.waitForTimeout(400);

    // Set up: trigger requestCreateDrawio from side panel (this sets sidePanelImagePending=true)
    await page.evaluate(() => {
        const sp = document.querySelector('.side-panel');
        const editor: any = sp?.querySelector('.editor[contenteditable]');
        editor?.focus();
        // place cursor in side panel editor
        const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
        if (lastP) {
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const s = window.getSelection()!;
            s.removeAllRanges();
            s.addRange(r);
        }
        const inst = (window as any).EditorInstance?.getActiveInstance?.();
        // Trigger drawio insertion via dispatchToolbarAction → marker insert + requestCreateDrawio
        // (we simulate cmd+/ → palette → drawio entry; here directly fire the action)
        inst._handleGlobalShortcut(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }));
    });
    await page.waitForTimeout(150);

    // Filter palette to "drawio" and Enter
    await page.keyboard.type('drawio');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const stateAfterTrigger = await page.evaluate(() => {
        const sp = document.querySelector('.side-panel');
        const editor: any = sp?.querySelector('.editor[contenteditable]');
        return {
            hasMarkerInSidePanel: !!editor?.querySelector('span[data-drawio-insert-marker]'),
            hostMessages: ((window as any).__testApi.messages || [])
                .filter((m: any) => m.type === 'requestCreateDrawio')
                .map((m: any) => ({ type: m.type, sidePanelFilePath: m.sidePanelFilePath }))
        };
    });
    expect(stateAfterTrigger.hasMarkerInSidePanel).toBe(true);
    expect(stateAfterTrigger.hostMessages).toHaveLength(1);
    expect(stateAfterTrigger.hostMessages[0].sidePanelFilePath).toBe(FILE_PATH);

    // Now simulate extension's insertImageHtml response — main handler should
    // dispatch to side panel because sidePanelImagePending=true
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'insertImageHtml',
            markdownPath: 'files/diagram.drawio.svg',
            displayUri: 'http://localhost:3000/note1/files/diagram.drawio.svg'
        });
    });
    await page.waitForTimeout(200);

    const final = await page.evaluate(() => {
        const sp = document.querySelector('.side-panel');
        const editor: any = sp?.querySelector('.editor[contenteditable]');
        const imgs = editor?.querySelectorAll('img') || [];
        return {
            sidePanelImgCount: imgs.length,
            sidePanelImgPaths: Array.from(imgs).map((img: any) => img.dataset.markdownPath),
            markerLeft: !!editor?.querySelector('span[data-drawio-insert-marker]')
        };
    });
    // image MUST appear in side panel editor (not main)
    expect(final.sidePanelImgCount).toBe(1);
    expect(final.sidePanelImgPaths[0]).toBe('files/diagram.drawio.svg');
    expect(final.markerLeft).toBe(false);
});
