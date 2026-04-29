/**
 * standalone editor MAIN view (not side panel) で cmd+/ Add Page が
 * **simple flow** で動作することを確認 (v15+ 仕様)。
 *
 * 旧仕様では useSimpleAddPage = IS_OUTLINER_PAGE || IS_SIDEPANEL だったため、
 * 通常 .md を standalone customEditor で開いた時は action panel (auto/at-path 二択 + name 確認)
 * の多段フローに入っていた。ユーザーから「cmd+/ → Add Page しても挿入されない」と報告され、
 * 全 context で simple flow を有効化。
 */
import { test, expect, Page } from '@playwright/test';

async function openStandaloneMd(page: Page, markdown: string) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((md) => {
        const setMarkdown = (window as any).__testApi.setMarkdown;
        if (typeof setMarkdown === 'function') setMarkdown(md);
    }, markdown);
    await page.waitForTimeout(200);
}

async function triggerCmdSlashAddPage(page: Page) {
    await page.evaluate(() => {
        const editor: any = document.querySelector('.editor[contenteditable]');
        editor?.focus();
        const inst = (window as any).EditorInstance?.getActiveInstance?.();
        if (!inst) throw new Error('no active instance');
        inst._handleGlobalShortcut(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }));
    });
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
}

// v15+: cmd+/ Add Page は modal でリンク名を入力させる。OK で host.createPageAuto が呼ばれる。
async function confirmAddPageModal(page: Page, linkName: string) {
    await page.evaluate((name) => {
        const overlay: any = document.querySelector('.rename-link-modal-overlay');
        if (!overlay) throw new Error('no addPage modal');
        const input: any = overlay.querySelector('input[type="text"]');
        input.value = name;
        const okBtn = Array.from(overlay.querySelectorAll('button')).reverse()[0] as HTMLButtonElement;
        okBtn.click();
    }, linkName);
    await page.waitForTimeout(150);
}

async function cancelAddPageModal(page: Page) {
    await page.evaluate(() => {
        const overlay: any = document.querySelector('.rename-link-modal-overlay');
        if (!overlay) return;
        const cancelBtn = overlay.querySelector('button') as HTMLButtonElement;
        cancelBtn.click();
    });
    await page.waitForTimeout(120);
}

async function respondPageCreated(page: Page, relativePath: string) {
    // Standalone editor main: pageCreatedAtPath comes directly (NOT wrapped in sidePanelMessage)
    await page.evaluate((rel) => {
        (window as any).__hostMessageHandler({
            type: 'pageCreatedAtPath',
            relativePath: rel
        });
    }, relativePath);
    await page.waitForTimeout(150);
}

test.describe('Standalone editor main view — cmd+/ Add Page simple flow', () => {

    test('cursor in editor → marker insert → modal 表示 → OK で host.createPageAuto 呼び出し', async ({ page }) => {
        await openStandaloneMd(page, '# Hello\n\nbody\n\n');
        await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await triggerCmdSlashAddPage(page);
        // 段階1: marker 挿入済み + modal が表示される (host call はまだ)
        const beforeOk = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            return {
                hasMarker: !!editor?.querySelector('span[data-page-insert-marker]'),
                hasModal: !!document.querySelector('.rename-link-modal-overlay'),
                hostMessages: ((window as any).__testApi.messages || []).map((m: any) => m.type),
                actionPanelDisplay: (document.querySelector('.action-panel') as HTMLElement | null)?.style.display
            };
        });
        expect(beforeOk.hasMarker).toBe(true);
        expect(beforeOk.hasModal).toBe(true);
        expect(beforeOk.hostMessages).not.toContain('createPageAuto'); // モーダル OK 前は host call なし
        expect(beforeOk.actionPanelDisplay === 'flex' || beforeOk.actionPanelDisplay === 'block').toBe(false);

        // 段階2: modal で OK → host.createPageAuto 発火
        await confirmAddPageModal(page, 'My note');
        const afterOk = await page.evaluate(() => ({
            hostMessages: ((window as any).__testApi.messages || []).map((m: any) => m.type),
            modalGone: !document.querySelector('.rename-link-modal-overlay')
        }));
        expect(afterOk.hostMessages).toContain('createPageAuto');
        expect(afterOk.modalGone).toBe(true);
    });

    test('modal Cancel → marker 削除 + host call なし + link 不挿入', async ({ page }) => {
        await openStandaloneMd(page, '# Hello\n\n');
        await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await triggerCmdSlashAddPage(page);
        await cancelAddPageModal(page);
        const r = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            return {
                hasMarker: !!editor?.querySelector('span[data-page-insert-marker]'),
                anchors: Array.from(editor?.querySelectorAll('a[href]') || []).length,
                hostMessages: ((window as any).__testApi.messages || []).map((m: any) => m.type)
            };
        });
        expect(r.hasMarker).toBe(false); // cancel で marker 削除
        expect(r.anchors).toBe(0);
        expect(r.hostMessages).not.toContain('createPageAuto');
    });

    test('modal で linkName 入力 → host response で <a>{linkName}</a> 挿入 + h1 sync', async ({ page }) => {
        await openStandaloneMd(page, '# Hello\n\n');
        await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
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
        await confirmAddPageModal(page, 'My note');
        await respondPageCreated(page, 'pages/1234.md');
        const r = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            return {
                anchors: Array.from(editor?.querySelectorAll('a[href]') || []).map((a: any) => ({
                    href: a.getAttribute('href'),
                    text: a.textContent
                })),
                markersLeft: editor?.querySelectorAll('span[data-page-insert-marker]').length,
                updateH1Calls: ((window as any).__testApi.messages || []).filter((m: any) => m.type === 'updatePageH1')
            };
        });
        expect(r.anchors.find((a) => a.href === 'pages/1234.md' && a.text === 'My note')).toBeTruthy();
        expect(r.markersLeft).toBe(0);
        // linkName != 'untitled' なら H1 同期 message が host へ
        expect(r.updateH1Calls.length).toBeGreaterThanOrEqual(1);
    });

    test('modal で空入力 / "untitled" → fallback "untitled" link、H1 同期スキップ', async ({ page }) => {
        await openStandaloneMd(page, '# Hello\n\n');
        await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            editor.focus();
            const lastP = editor.querySelector('p:last-of-type') || editor.lastElementChild;
            const r = document.createRange();
            r.setStart(lastP, lastP.childNodes.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await triggerCmdSlashAddPage(page);
        await confirmAddPageModal(page, 'untitled'); // default 値そのまま
        await respondPageCreated(page, 'pages/u.md');
        const r = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            return {
                anchors: Array.from(editor?.querySelectorAll('a[href]') || []).map((a: any) => ({ href: a.getAttribute('href'), text: a.textContent })),
                updateH1Calls: ((window as any).__testApi.messages || []).filter((m: any) => m.type === 'updatePageH1')
            };
        });
        expect(r.anchors.find((a) => a.href === 'pages/u.md' && a.text === 'untitled')).toBeTruthy();
        // 'untitled' のままなら H1 同期は不要 (skip)
        expect(r.updateH1Calls.length).toBe(0);
    });

    test('selection が editor 外でも link が editor 内に必ず入る', async ({ page }) => {
        await openStandaloneMd(page, '# Hello\n\n');
        await page.evaluate(() => { window.getSelection()?.removeAllRanges(); });
        await triggerCmdSlashAddPage(page);
        await confirmAddPageModal(page, 'untitled');
        await respondPageCreated(page, 'pages/orphan.md');
        const r = await page.evaluate(() => {
            const editor: any = document.querySelector('.editor[contenteditable]');
            return {
                anchors: Array.from(editor?.querySelectorAll('a[href]') || []).map((a: any) => ({ href: a.getAttribute('href') })),
                markersLeft: editor?.querySelectorAll('span[data-page-insert-marker]').length
            };
        });
        expect(r.anchors.find((a) => a.href === 'pages/orphan.md')).toBeTruthy();
        expect(r.markersLeft).toBe(0);
    });
});
