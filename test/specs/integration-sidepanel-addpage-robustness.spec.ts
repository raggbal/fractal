/**
 * Side panel cmd+/ Add Page (simple flow) — 挿入失敗 regression
 *
 * バグ症状: cmd+/ → Add Page で link が「挿入されない時がある」
 *
 * 失敗モード（修正前）:
 *   1. selection が editor 外 (panel header / file panel / body 等) にある時
 *      apRange.insertNode(marker) が editor 外に marker を置く →
 *      handlePageCreatedAtPath が editor.querySelector で marker を見つけられない →
 *      fallback も同じく editor 外の selection で insertNode → link 不在に見える
 *   2. marker race (rapid cmd+/) で marker が消えた時、fallback の selection が editor 外なら link 不在
 *
 * 修正後の契約:
 *   - marker insert 時、selection が editor 外なら **必ず** editor 末尾に新規 <p> として marker を作る
 *   - handlePageCreatedAtPath で marker 不在 + selection が editor 外なら link は editor 末尾に <p>append
 *   - どのケースでも `editor.querySelectorAll('a[href]')` に link が **少なくとも 1 つ** 入る
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

async function triggerCmdSlashAddPage(page: Page) {
    await page.evaluate(() => {
        const inst = (window as any).EditorInstance?.getActiveInstance?.();
        if (!inst) throw new Error('no active instance');
        inst._handleGlobalShortcut(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }));
    });
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
}

// v15+: addPage modal で OK して host call を発火
async function confirmAddPageModal(page: Page, linkName = 'untitled') {
    await page.evaluate((name) => {
        const overlay: any = document.querySelector('.rename-link-modal-overlay');
        if (!overlay) return;
        const input: any = overlay.querySelector('input[type="text"]');
        input.value = name;
        const okBtn = Array.from(overlay.querySelectorAll('button')).reverse()[0] as HTMLButtonElement;
        okBtn.click();
    }, linkName);
    await page.waitForTimeout(120);
}

async function respondPageCreated(page: Page, relativePath: string) {
    await page.evaluate((rel) => {
        (window as any).__hostMessageHandler({
            type: 'sidePanelMessage',
            data: { type: 'pageCreatedAtPath', relativePath: rel }
        });
    }, relativePath);
    await page.waitForTimeout(150);
}

async function getSidePanelLinks(page: Page) {
    return await page.evaluate(() => {
        const sp = document.querySelector('.side-panel');
        const editor: any = sp?.querySelector('.editor[contenteditable]');
        if (!editor) return { err: 'no editor' };
        return {
            anchors: Array.from(editor.querySelectorAll('a[href]')).map((a: any) => ({
                href: a.getAttribute('href'),
                text: a.textContent
            })),
            markersLeft: editor.querySelectorAll('span[data-page-insert-marker]').length,
            html: editor.innerHTML.slice(0, 800)
        };
    });
}

test.describe('side panel cmd+/ Add Page robustness', () => {

    test('cursor in side panel: marker insert + modal OK + replace で link 1 件', async ({ page }) => {
        await openSidePanelMd(page, '# Hello\n\nSome content\n\n');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await triggerCmdSlashAddPage(page);
        await confirmAddPageModal(page); // OK with default 'untitled'
        await respondPageCreated(page, 'pages/normal.md');
        const r = await getSidePanelLinks(page);
        if ('err' in r) throw new Error(r.err);
        expect(r.anchors.length).toBeGreaterThanOrEqual(1);
        expect(r.anchors.find((a) => a.href === 'pages/normal.md')).toBeTruthy();
        expect(r.markersLeft).toBe(0);
    });

    test('selection が editor 外 (sidepanel header focus): link が editor 内に必ず入る', async ({ page }) => {
        await openSidePanelMd(page, '# Hello\n\n');
        await page.evaluate(() => {
            const filename = document.querySelector('.side-panel-filename') as HTMLElement | null;
            if (filename) filename.focus();
            const sel = window.getSelection();
            sel?.removeAllRanges();
            if (filename) {
                const r = document.createRange();
                r.selectNodeContents(filename);
                r.collapse(true);
                sel?.addRange(r);
            }
        });
        await triggerCmdSlashAddPage(page);
        await confirmAddPageModal(page);
        await respondPageCreated(page, 'pages/header-case.md');
        const r = await getSidePanelLinks(page);
        if ('err' in r) throw new Error(r.err);
        expect(r.anchors.find((a) => a.href === 'pages/header-case.md')).toBeTruthy();
        expect(r.markersLeft).toBe(0);
    });

    test('selection 完全になし (rangeCount 0): link が editor 末尾に append される', async ({ page }) => {
        await openSidePanelMd(page, '# Hello\n\n');
        await page.evaluate(() => { window.getSelection()?.removeAllRanges(); });
        await triggerCmdSlashAddPage(page);
        await confirmAddPageModal(page);
        await respondPageCreated(page, 'pages/no-sel.md');
        const r = await getSidePanelLinks(page);
        if ('err' in r) throw new Error(r.err);
        expect(r.anchors.find((a) => a.href === 'pages/no-sel.md')).toBeTruthy();
        expect(r.markersLeft).toBe(0);
    });

    test('rapid cmd+/ × 2 → 後の modal が前を置換 → 1 link のみ挿入', async ({ page }) => {
        await openSidePanelMd(page, '# Hello\n\n');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await triggerCmdSlashAddPage(page);
        await triggerCmdSlashAddPage(page); // 2 回目: modal が再表示 (前 modal は破棄)
        await confirmAddPageModal(page, 'final');
        await respondPageCreated(page, 'pages/final.md');
        const r = await getSidePanelLinks(page);
        if ('err' in r) throw new Error(r.err);
        expect(r.anchors.find((a) => a.href === 'pages/final.md')).toBeTruthy();
        // 二度目のモーダルでのみ host call → link は 1 件のみ
        expect(r.anchors.length).toBe(1);
        expect(r.markersLeft).toBe(0);
    });

    test('host response が marker insert より先に来た時 (fast roundtrip / fallback path)', async ({ page }) => {
        await openSidePanelMd(page, '# Hello\n\n');
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel');
            const editor: any = sp?.querySelector('.editor[contenteditable]');
            editor.focus();
        });
        // marker insert を skip して直接 host response (marker 不在 path)
        await respondPageCreated(page, 'pages/orphan.md');
        const r = await getSidePanelLinks(page);
        if ('err' in r) throw new Error(r.err);
        expect(r.anchors.find((a) => a.href === 'pages/orphan.md')).toBeTruthy();
    });
});
