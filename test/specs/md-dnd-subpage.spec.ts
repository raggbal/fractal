/**
 * FR-B07 (sprint 20260804-145603) — md editor への外部 .md D&D を subpage 登録に変更
 *
 * webview 側: .md drop → saveMdAsSubpage（files/items チャネル）/ readAndInsertMdAsSubpage
 *（uri-list チャネル）を host に送る（従来の saveFileAndInsert = files/ 添付にしない）。
 * host 側: saveDroppedMdAsSubpage（md-subpage-utils.ts）が対象 md と同階層に一意名保存し
 * insertSubpageLink {markdownPath, title} を返す → webview が subpage リンク
 *（data-subpage=true・serialize で [[title]](file.md)）をカーソル位置に挿入。
 *
 * TC-B07-01  files チャネル: .md drop → saveMdAsSubpage 送出（saveFileAndInsert は送らない）
 * TC-B07-02  items チャネル: 同上（経路ごと handler 網羅の番人）
 * TC-B07-03  uri-list チャネル: readAndInsertMdAsSubpage 送出
 * TC-B07-04  insertSubpageLink 受信 → subpage リンク挿入・serialize が [[title]](file.md)
 * TC-B07-05  画像 D&D は従来どおり saveImageAndInsert（md 分岐が横取りしない = counterfactual）
 * TC-B07-06  非 md（.pdf）D&D は従来どおり saveFileAndInsert（添付）
 * TC-B07-07  (unit) saveDroppedMdAsSubpage: 同階層一意名保存・H1 タイトル・[] 除去・
 *            衝突時 -1 suffix。title が実パーサ（markdown-link-parser）で isSubpage 解析可能
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function bootEditor(page: import('@playwright/test').Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.locator('#editor').click();
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}

function mdFileDropEval(fileName: string, viaItemsOnly: boolean) {
    return `
        (function() {
            window.__testApi.messages.length = 0;
            const editor = document.getElementById('editor');
            const dt = new DataTransfer();
            const file = new File([new TextEncoder().encode('# Dropped Title\\n\\nbody')], ${JSON.stringify(fileName)}, { type: 'text/markdown' });
            dt.items.add(file);
            ${viaItemsOnly ? "Object.defineProperty(dt, 'files', { value: [], configurable: true });" : ''}
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            editor.dispatchEvent(ev);
        })()
    `;
}

test.describe('FR-B07: md editor への .md D&D subpage 化 (standalone-editor)', () => {
    test.beforeEach(async ({ page }) => { await bootEditor(page); });

    test('TC-B07-01 files チャネル: .md drop → saveMdAsSubpage（添付 saveFileAndInsert は送らない）', async ({ page }) => {
        await page.evaluate(mdFileDropEval('note.md', false));
        await page.waitForTimeout(300); // FileReader async
        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const sub = msgs.filter((m: any) => m.type === 'saveMdAsSubpage');
        expect(sub.length, 'saveMdAsSubpage が 1 回').toBe(1);
        expect(sub[0].fileName).toBe('note.md');
        expect(sub[0].dataUrl).toMatch(/^data:/);
        expect(msgs.filter((m: any) => m.type === 'saveFileAndInsert').length, '従来添付は送らない').toBe(0);
    });

    test('TC-B07-02 items チャネル: .md drop → saveMdAsSubpage（経路網羅の番人）', async ({ page }) => {
        await page.evaluate(mdFileDropEval('note.md', true));
        await page.waitForTimeout(300);
        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        expect(msgs.filter((m: any) => m.type === 'saveMdAsSubpage').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'saveFileAndInsert').length).toBe(0);
    });

    test('TC-B07-03 uri-list チャネル: .md path drop → readAndInsertMdAsSubpage', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            dt.setData('text/uri-list', 'file:///tmp/dropped%20note.md');
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            editor.dispatchEvent(ev);
        });
        await page.waitForTimeout(200);
        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const sub = msgs.filter((m: any) => m.type === 'readAndInsertMdAsSubpage');
        expect(sub.length).toBe(1);
        expect(sub[0].filePath).toBe('/tmp/dropped note.md');
        expect(msgs.filter((m: any) => m.type === 'readAndInsertFile').length).toBe(0);
    });

    test('TC-B07-04 insertSubpageLink 受信 → subpage リンク挿入・serialize が [[title]](file.md)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'insertSubpageLink',
                markdownPath: 'dropped-note.md',
                title: 'Dropped Title',
            });
        });
        await page.waitForTimeout(100);
        const link = page.locator('#editor a[data-subpage="true"]');
        await expect(link).toHaveCount(1);
        await expect(link).toHaveText('Dropped Title');
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('[[Dropped Title]](dropped-note.md)');
    });

    test('TC-B07-05 画像 D&D は従来どおり（md 分岐が横取りしない）', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            const file = new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' });
            dt.items.add(file);
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            editor.dispatchEvent(ev);
        });
        await page.waitForTimeout(300);
        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        expect(msgs.filter((m: any) => m.type === 'saveImageAndInsert').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'saveMdAsSubpage').length).toBe(0);
    });

    test('TC-B07-06 非 md（.pdf）D&D は従来どおり saveFileAndInsert（添付）', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            const file = new File([new Uint8Array([37, 80, 68, 70])], 'doc.pdf', { type: 'application/pdf' });
            dt.items.add(file);
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            editor.dispatchEvent(ev);
        });
        await page.waitForTimeout(300);
        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        expect(msgs.filter((m: any) => m.type === 'saveFileAndInsert').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'saveMdAsSubpage').length).toBe(0);
    });
});

test.describe('FR-B07 unit: saveDroppedMdAsSubpage (md-subpage-utils)', () => {
    // md-subpage-utils は TS（ts-node 非導入）なので shared-emit 済みの out/ を require する
    const utils = require('../../out/shared/md-subpage-utils');
    const linkParser = require('../../src/shared/markdown-link-parser');

    function mkTmp(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'md-subpage-'));
    }

    test('TC-B07-07a 同階層に保存・H1 タイトル・相対パス = ファイル名', () => {
        const dir = mkTmp();
        const target = path.join(dir, 'current.md');
        fs.writeFileSync(target, '# Current\n');
        const r = utils.saveDroppedMdAsSubpage(target, '# My Title\n\nbody', 'note.md');
        expect(r.relPath).toBe('note.md');
        expect(r.title).toBe('My Title');
        expect(fs.readFileSync(path.join(dir, 'note.md'), 'utf8')).toContain('# My Title');
    });

    test('TC-B07-07b 衝突時は一意名（-1 suffix）・H1 無しは stem タイトル', () => {
        const dir = mkTmp();
        const target = path.join(dir, 'current.md');
        fs.writeFileSync(target, '# Current\n');
        fs.writeFileSync(path.join(dir, 'note.md'), 'already exists');
        const r = utils.saveDroppedMdAsSubpage(target, 'no h1 body', 'note.md');
        expect(r.relPath).toBe('note-1.md');
        expect(r.title).toBe('note-1'); // H1 無し → 保存後 stem
        expect(fs.readFileSync(path.join(dir, 'note.md'), 'utf8')).toBe('already exists'); // 既存不変
    });

    test('TC-B07-07c title の [ ] 除去 → 実パーサで isSubpage 解析可能（designer_failures 2026-07-26 番人）', () => {
        const dir = mkTmp();
        const target = path.join(dir, 'current.md');
        fs.writeFileSync(target, '# Current\n');
        const r = utils.saveDroppedMdAsSubpage(target, '# Bad ]Title[ Here\n', 'x.md');
        expect(r.title).not.toMatch(/[\[\]]/);
        // 生成リンクを本体パーサに通して subpage として解析されることを確認
        const mdLink = '[[' + r.title + ']](' + r.relPath + ')';
        const parsed = linkParser.parseMarkdownLinks(mdLink);
        expect(parsed.length).toBe(1);
        expect(parsed[0].isSubpage).toBe(true);
        expect(parsed[0].alt).toBe(r.title);
        expect(parsed[0].url).toBe(r.relPath);
    });
});
