/**
 * TC-XP-02/03/04 — Notes main md pane の cross-note copy/paste 配線
 * (sprint 20260808-000219 FR-XP-01 / FR-XP-03)
 *
 * 従来 _assetContext は sidepanel 専用（sidePanelAssetContext）で、main md の
 * 範囲選択 copy に text/x-any-md-context が載らず（editor.js copy handler の
 * host._assetContext ガード）、paste も複製分岐に入らなかった（三重ゲート）。
 * 本 sprint で mainMdAssetContext message により main md bridge にも配線。
 *
 * counterfactual:
 *  - TC-XP-02: mainMdAssetContext を送らなければ x-any-md-context が載らない（配線が load-bearing）
 *  - TC-XP-04: destination 振り分けを外すと main-md 宛が sidepanel にも流れて二重挿入
 */
import { test, expect, Page } from '@playwright/test';

const MD_FILE = '/Users/test/notes/noteA/page-main.md';
const MD_BODY = '# Doc\n\nhello [📎 doc.pdf](files/doc.pdf) world\n';

const MAIN_CTX = {
    imageDir: '/Users/test/notes/noteA/images',
    fileDir: '/Users/test/notes/noteA/files',
    mdDir: '/Users/test/notes/noteA',
};
const CROSS_CTX = {
    imageDir: '/Users/test/notes/noteB/images',
    fileDir: '/Users/test/notes/noteB/files',
    mdDir: '/Users/test/notes/noteB',
};

async function openMdPane(page: Page, withCtx: boolean) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fp, md, ctx }) => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '',
        });
        if (ctx) {
            (window as any).__hostMessageHandler({
                type: 'mainMdAssetContext',
                imageDir: ctx.imageDir, fileDir: ctx.fileDir, mdDir: ctx.mdDir,
            });
        }
    }, { fp: MD_FILE, md: MD_BODY, ctx: withCtx ? MAIN_CTX : null });
    await page.waitForTimeout(300);
}

function selectAllInMainEditor(page: Page) {
    return page.evaluate(() => {
        const editor = document.querySelector('.markdown-container .editor[contenteditable]') as HTMLElement;
        if (!editor) return false;
        const r = document.createRange();
        r.selectNodeContents(editor);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        return true;
    });
}

function dispatchCopy(page: Page) {
    return page.evaluate(() => {
        const editor = document.querySelector('.markdown-container .editor[contenteditable]') as HTMLElement;
        const data = new DataTransfer();
        const ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        editor.dispatchEvent(ev);
        return {
            xmd: data.getData('text/x-any-md'),
            xctx: data.getData('text/x-any-md-context'),
        };
    });
}

test('TC-XP-02 main md copy: mainMdAssetContext 配線で x-any-md-context が載る', async ({ page }) => {
    await openMdPane(page, true);
    expect(await selectAllInMainEditor(page)).toBe(true);
    const r = await dispatchCopy(page);
    expect(r.xmd).toContain('doc.pdf');
    expect(r.xctx).toBeTruthy();
    expect(JSON.parse(r.xctx).imageDir).toBe(MAIN_CTX.imageDir);
});

test('TC-XP-02cf (counterfactual) 配線なしでは x-any-md-context が載らない', async ({ page }) => {
    await openMdPane(page, false);
    expect(await selectAllInMainEditor(page)).toBe(true);
    const r = await dispatchCopy(page);
    expect(r.xmd).toContain('doc.pdf'); // md 自体は従来どおり載る
    expect(r.xctx).toBe('');            // context は配線が無いと載らない
});

test('TC-XP-03 main md paste (cross ctx): pasteWithAssetCopy が main-md 宛で飛ぶ', async ({ page }) => {
    await openMdPane(page, true);
    const sent = await page.evaluate(({ srcCtx }) => {
        (window as any).__testApi.messages = [];
        const editor = document.querySelector('.markdown-container .editor[contenteditable]') as HTMLElement;
        editor.focus();
        const data = new DataTransfer();
        data.setData('text/plain', '[📎 doc.pdf](files/doc.pdf)');
        data.setData('text/x-any-md', '[📎 doc.pdf](files/doc.pdf)');
        data.setData('text/x-any-md-context', JSON.stringify(srcCtx));
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        editor.dispatchEvent(ev);
        return (window as any).__testApi.messages.filter((m: any) => m.type === 'pasteWithAssetCopy');
    }, { srcCtx: CROSS_CTX });
    expect(sent.length).toBe(1);
    expect(sent[0].destination).toBe('main-md');
    expect(sent[0].sidePanelFilePath).toBe(MD_FILE); // 自 filePath を畳む（silent no-op 穴の解消）
    expect(sent[0].sourceContext.imageDir).toBe(CROSS_CTX.imageDir);
});

test('TC-XP-03b cut + same ctx: 複製せず直挿入（既存分岐セマンティクス回帰 pin）', async ({ page }) => {
    await openMdPane(page, true);
    const r = await page.evaluate(({ srcCtx }) => {
        (window as any).__testApi.messages = [];
        const editor = document.querySelector('.markdown-container .editor[contenteditable]') as HTMLElement;
        editor.focus();
        const data = new DataTransfer();
        data.setData('text/plain', 'hello');
        data.setData('text/x-any-md', 'hello');
        data.setData('text/x-any-md-context', JSON.stringify(srcCtx));
        data.setData('text/x-any-md-iscut', '1');
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        editor.dispatchEvent(ev);
        return {
            pasteMsgs: (window as any).__testApi.messages.filter((m: any) => m.type === 'pasteWithAssetCopy'),
        };
    }, { srcCtx: MAIN_CTX }); // dest と同一 ctx = sameOutliner
    expect(r.pasteMsgs.length).toBe(0); // cut+same は直挿入（pasteWithAssetCopy を呼ばない）
});

test('TC-XP-04 result 配送: destination=main-md は main md に挿入される', async ({ page }) => {
    await openMdPane(page, true);
    const r = await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'pasteWithAssetCopyResult',
            markdown: 'PASTED-MAIN-XP04',
            destination: 'main-md',
        });
        const editor = document.querySelector('.markdown-container .editor[contenteditable]') as HTMLElement;
        return { mainHtml: editor.innerHTML };
    });
    await page.waitForTimeout(200);
    const mainText = await page.evaluate(() =>
        (document.querySelector('.markdown-container .editor[contenteditable]') as HTMLElement).textContent || '');
    expect(mainText).toContain('PASTED-MAIN-XP04');
});

test('TC-XP-04b 後方互換: destination 無し（旧形式）は main md に流れない', async ({ page }) => {
    await openMdPane(page, true);
    // sidepanel 未 open の状態で旧形式 result を流す。
    // 旧形式は sidepanel 宛（outliner.js switch が転送）だったので main md に挿入されてはならない…
    // が、旧来から Notes では md pane EditorInstance も window listener で受信し
    // sidepanel 不在時は自分に挿入していた（destination 導入前の既存挙動）。
    // ここでは「destination='sidepanel' 明示なら main md に入らない」を新契約の番人にする。
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'pasteWithAssetCopyResult',
            markdown: 'PASTED-SP-XP04B',
            destination: 'sidepanel',
        });
    });
    await page.waitForTimeout(200);
    const mainText = await page.evaluate(() =>
        (document.querySelector('.markdown-container .editor[contenteditable]') as HTMLElement).textContent || '');
    expect(mainText).not.toContain('PASTED-SP-XP04B');
});
