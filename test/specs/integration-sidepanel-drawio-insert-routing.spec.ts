/**
 * Side panel cmd+/ → drawio insert routing regression
 *
 * BUG: side panel から cmd+/ → "Insert Drawio" を実行しても drawio.svg が挿入されないことがある。
 *
 * 【sprint 20260714 で受信ルーティングを刷新】
 *   旧: sidePanelImagePending フラグ（instance-local）で「次の insertImageHtml を sidepanel へ回す」判定。
 *   新: insertImageHtml/insertFileLink の宛先を message.sidePanelFilePath で判定（cross-instance 混線の恒久修正）。
 *       backend（requestCreateDrawio 等）は sidepanel 由来なら sidePanelFilePath を必ず stamp して発行する。
 *       受信側は message.sidePanelFilePath === 自分が管理する sidepanel の filePath のときだけ挿入する。
 *   → 本テストは「sidepanel 由来の insertImageHtml（sidePanelFilePath 付き）が sidepanel editor に挿入される」を検証する。
 *     test 1 は requestCreateDrawio が _onImageRequest を呼ぶ（既存の routing fix）ことを引き続き担保。
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

test('side panel insertImageHtml routes to side panel editor when sidePanelFilePath matches', async ({ page }) => {
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

    // Now simulate extension's insertImageHtml response — backend が sidepanel 由来の drawio に対して
    // sidePanelFilePath を stamp して発行する（新宛先判定契約）。受信側は filePath 一致で sidepanel へ挿入する。
    await page.evaluate(({ fp }) => {
        (window as any).__hostMessageHandler({
            type: 'insertImageHtml',
            markdownPath: 'files/diagram.drawio.svg',
            displayUri: 'http://localhost:3000/note1/files/diagram.drawio.svg',
            sidePanelFilePath: fp
        });
    }, { fp: FILE_PATH });
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
