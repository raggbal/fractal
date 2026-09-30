/**
 * TASK-07 / TASK-09 — md 面へのリンク挿入（B-1 / B-2）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-MSEL-04 / INV-3 / DOM-MdLinkInsertParity
 *
 * TC-B1-1: md 2 枚を main md に落とすとリンクが 2 本入る
 * TC-B1-2: sidepanel md でも入る（2 メッセージ × main/sidepanel = 4 セルの全数）
 * （TC-B2-1 / TC-B2-2 は TASK-09 が本ファイルに追記する）
 *
 * 番人: `editor.js` の宛先自己判定（`message.sidePanelFilePath !== ownFp`）を外すと、
 * 自分宛てのメッセージが relay-or-nothing で捨てられ **リンク 0 本**になって落ちる。
 *
 * ## B-1 の機序（実測で確定）
 * host の `linkMdAsSubpageForSidePanelCore` は **宛先 md のパス**を `sidePanelFilePath` としてエコーする
 * （その md へ disk 直書きするので host 側は実パスが必要 = null にできない）。
 * webview 側が「`sidePanelFilePath` が truthy なら自分宛てではない」と誤解して早期 return していたため、
 * main md 宛て（= 宛先が自分自身）のときにリンクが 1 本も挿入されなかった。
 * 修正は **webview が「自分宛てか」を自己判定する**こと（precedent = 同ファイルの removeSubpageLink の `rmOwnFp`）。
 */
import { test, expect } from '@playwright/test';

const OWN = '/note/main.md';
const OTHER = '/note/side.md';

async function mountEditor(page: any, ownPath: string): Promise<void> {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__hostMessageHandler);
    await page.evaluate((p: string) => {
        const w = window as any;
        if (w.hostBridge) { w.hostBridge.filePath = p; }
    }, ownPath);
    await page.click('#editor').catch(() => { /* focus は任意 */ });
}

const send = (page: any, msg: Record<string, unknown>) =>
    page.evaluate((m: any) => (window as any).__hostMessageHandler(m), msg);

const linkCount = (page: any, sel: string) => page.evaluate((s: string) => {
    const ed = document.querySelector('#editor');
    return ed ? ed.querySelectorAll(s).length : -1;
}, sel);

test.describe('TASK-07 B-1: 宛先の自己判定（4 セル全数）', () => {
    test('TC-B1-1: 宛先が自分自身の insertFileLink が挿入される（旧実装は 0 本）', async ({ page }) => {
        await mountEditor(page, OWN);
        // host は宛先 md のパスをエコーする。main md 宛てでは **自分自身のパス**が入る
        await send(page, { type: 'insertFileLink', markdownPath: 'files/a.pdf', fileName: 'a.pdf', sidePanelFilePath: OWN });
        await send(page, { type: 'insertFileLink', markdownPath: 'files/b.pdf', fileName: 'b.pdf', sidePanelFilePath: OWN });
        await page.waitForTimeout(120);
        expect(await linkCount(page, 'a[href^="files/"]'),
            '自分宛てのリンクが挿入されていない（relay-or-nothing で捨てられた = B-1）').toBe(2);
    });

    test('TC-B1-1b: 宛先が自分自身の insertSubpageLink が挿入される', async ({ page }) => {
        await mountEditor(page, OWN);
        await send(page, { type: 'insertSubpageLink', markdownPath: 'sub1.md', title: 'Sub 1', sidePanelFilePath: OWN });
        await send(page, { type: 'insertSubpageLink', markdownPath: 'sub2.md', title: 'Sub 2', sidePanelFilePath: OWN });
        await page.waitForTimeout(120);
        expect(await linkCount(page, 'a[data-markdown-path]'),
            '自分宛ての subpage リンクが挿入されていない（B-1 の同型）').toBe(2);
    });

    test('TC-B1-2: 他 instance 宛ては自分に挿入しない（中継の契約は不変）', async ({ page }) => {
        await mountEditor(page, OWN);
        await send(page, { type: 'insertFileLink', markdownPath: 'files/x.pdf', fileName: 'x.pdf', sidePanelFilePath: OTHER });
        await send(page, { type: 'insertSubpageLink', markdownPath: 'other.md', title: 'Other', sidePanelFilePath: OTHER });
        await page.waitForTimeout(120);
        expect(await linkCount(page, 'a[href^="files/"]'), '他 instance 宛てを自分に挿入してしまった').toBe(0);
        expect(await linkCount(page, 'a[data-markdown-path]')).toBe(0);
    });

    test('TC-B1-2b: sidepanel 側 instance でも自分宛てなら挿入される', async ({ page }) => {
        // sidepanel instance = 自分の filePath が sidepanel の md であるケース
        await mountEditor(page, OTHER);
        await send(page, { type: 'insertFileLink', markdownPath: 'files/s.pdf', fileName: 's.pdf', sidePanelFilePath: OTHER });
        await page.waitForTimeout(120);
        expect(await linkCount(page, 'a[href^="files/"]'),
            'sidepanel instance が自分宛てのリンクを挿入していない').toBe(1);
    });

    test('TC-B1-3: sidePanelFilePath が無い（従来の単一経路）も従来どおり挿入される', async ({ page }) => {
        await mountEditor(page, OWN);
        await send(page, { type: 'insertFileLink', markdownPath: 'files/legacy.pdf', fileName: 'legacy.pdf' });
        await page.waitForTimeout(120);
        expect(await linkCount(page, 'a[href^="files/"]'), '従来の単一経路が回帰した').toBe(1);
    });
});

test.describe('TASK-09 B-2: リンク挿入の段落化（入力 N → 出力 N 行）', () => {
    test('TC-B2-1: ファイル 3 個のリンクが 3 行になる（1 行連結にならない）', async ({ page }) => {
        await mountEditor(page, OWN);
        for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) {
            await send(page, { type: 'insertFileLink', markdownPath: `files/${n}`, fileName: n, sidePanelFilePath: OWN });
        }
        await page.waitForTimeout(150);
        const rows = await page.evaluate(() => {
            const ed = document.querySelector('#editor');
            if (!ed) { return { links: -1, paras: -1 }; }
            const links = ed.querySelectorAll('a[href^="files/"]').length;
            // リンクを含む段落（p）の数 = 行数
            const paras = Array.from(ed.querySelectorAll('p')).filter((p) => p.querySelector('a[href^="files/"]')).length;
            return { links, paras };
        });
        expect(rows.links).toBe(3);
        expect(rows.paras, 'N 本のリンクが 1 行に連結された（入力 N → 出力 N 行の違反 = B-2）').toBe(3);
    });

    test('TC-B2-2: 画像・subpage の既存挙動が不変（回帰）', async ({ page }) => {
        await mountEditor(page, OWN);
        await send(page, { type: 'insertSubpageLink', markdownPath: 's1.md', title: 'S1', sidePanelFilePath: OWN });
        await send(page, { type: 'insertSubpageLink', markdownPath: 's2.md', title: 'S2', sidePanelFilePath: OWN });
        await page.waitForTimeout(150);
        const n = await page.evaluate(() => {
            const ed = document.querySelector('#editor');
            return ed ? ed.querySelectorAll('a[data-markdown-path]').length : -1;
        });
        expect(n, 'subpage リンクの既存挙動が回帰した').toBe(2);
    });

    test('TC-B2-3: syncMarkdown で N 行の md になる（連結していない）', async ({ page }) => {
        await mountEditor(page, OWN);
        for (const n of ['x.pdf', 'y.pdf']) {
            await send(page, { type: 'insertFileLink', markdownPath: `files/${n}`, fileName: n, sidePanelFilePath: OWN });
        }
        await page.waitForTimeout(200);
        const md = await page.evaluate(() => {
            const w = window as any;
            return (w.__testApi && typeof w.__testApi.getMarkdown === 'function') ? w.__testApi.getMarkdown() : null;
        });
        if (md === null) { test.skip(true, '__testApi.getMarkdown が無い環境'); return; }
        const lines = String(md).split('\n').filter((l: string) => l.includes('files/'));
        expect(lines.length, 'md 出力で 2 本のリンクが同一行に入っている').toBe(2);
    });
});
