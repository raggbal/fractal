/**
 * 新規タブで開く修飾キー — sprint 20260727-174934 / **rev3: sprint 20260906-024639（ADRL-0112）**
 * TC-CT-01〜06 + TC-CT-07〜14 (testcases.md §C)
 *
 * ★ **rev3（ADRL-0112 / 裁定 R1・R12・R13）**: 「新規タブで開く」の修飾を
 *   **cmd+shift+click（Windows/Linux: ctrl+shift+click）**に振り替えた。3 面共通:
 *     ①note ツリーの**行全体**（md / .out / file / linkedfd）②outliner の 📄/📎 アイコン
 *     ③md 本文の全 `<a href>`（main / sidepanel 共通）
 *   cmd/ctrl **単独**は面ごとの従来の意味に戻る: tree = 単品トグル選択（ADRL-0111 のまま）/
 *   outliner アイコン・md リンク = 通常 open。shift **単独**は範囲選択のみで open を発火させない。
 *
 * FR-CT-01/02 rev2: note tree の行を cmd+shift+click → md/.out は bridge.openFileInTab、
 *              file は bridge.openTreeFileInTab（id のみ）、linkedfd は tabManager.openInNewTab。
 *   （rev2 = 2026-09-04 の「cmd/ctrl+click は単品トグル選択」は**維持**。rev3 はタブ経路を
 *     cmd+shift へ**追加**したもので、cmd 単独の意味は変えない。）
 * FR-CT-03 rev2: outliner page アイコンの cmd/ctrl+**shift**+click → openPageInTab {pageId}。
 *           cmd/ctrl 単独・修飾なしは従来どおり openPageInSidePanel。
 * FR-CT-05 rev2: md の `<a href>` は cmd/ctrl+**shift**+click で openLinkInTab、単独は openLink。
 *
 * standalone-notes.html: file panel bridge は個別 mock（openFileInTab → notesMessages に
 * {type:'openFileInTab'} で記録 = build-standalone-notes.js:213）。outliner bridge は
 * factory 経由なので openPageInTab は __testApi.messages に {type:'openPageInTab'} で記録される。
 * host 側 routing（Notes=webviewTab / Single=vscode.openWith）は vscode transitive import のため
 * ソース contract 検証（TC-CT-06。notes-open-in-tab-routing.spec.ts の確立パターン）。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const fileList = [
    { filePath: '/test/note.md', title: 'Doc', id: 'mdDoc' },
    { filePath: '/test/plan.out', title: 'Plan', id: 'outPlan' },
    // rev3: file item / linkedfd 行も 3 面の対象（TC-CT-08 / TC-CT-09）
    { filePath: '', title: 'spec.pdf', id: 'fileAtt', kind: 'file' },
    { filePath: '', title: 'Docs', id: 'linkFd', kind: 'folder', broken: false },
];
const structure = {
    version: 1,
    rootIds: ['mdDoc', 'outPlan', 'fileAtt', 'linkFd'],
    items: {
        mdDoc: { type: 'file', id: 'mdDoc', title: 'Doc', ext: 'md' },
        outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out' },
        fileAtt: { type: 'file', id: 'fileAtt', title: 'spec.pdf', ext: 'file', filename: 'spec.pdf' },
        linkFd: { type: 'file', id: 'linkFd', title: 'Docs', ext: 'folder' },
    },
};

test.describe('file tree cmd+click (FR-CT-01/02)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready !== undefined);
        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, '/test/plan.out', structure);
        }, { fileList, structure });
        await page.waitForSelector('[data-item-id="mdDoc"]');
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
    });

    async function clickItem(
        page: import('@playwright/test').Page,
        itemId: string,
        opts: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
    ) {
        await page.evaluate(({ itemId, opts }) => {
            const el = document.querySelector(`[data-item-id="${itemId}"]`) as HTMLElement;
            el.dispatchEvent(new MouseEvent('click', {
                bubbles: true, metaKey: !!opts.metaKey, ctrlKey: !!opts.ctrlKey, shiftKey: !!opts.shiftKey,
            }));
        }, { itemId, opts });
        await page.waitForTimeout(50);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
    }

    /** tabManager の openInNewTab 呼び出しを記録する（linkedfd の新規タブは webview 完結で host に飛ばない）。 */
    async function spyTabManager(page: import('@playwright/test').Page) {
        await page.evaluate(() => {
            const w = window as any;
            w.__tabCalls = [];
            const tm = w.__notesTabManager || (w.__notesTabManager = {});
            const orig = tm.openInNewTab;
            tm.openInNewTab = function (fileKey: string, kind: string, title: string, extra: any) {
                w.__tabCalls.push({ fileKey, kind, title, extra });
                if (typeof orig === 'function') { /* 実タブは開かない（記録のみ） */ }
                return null;
            };
        });
    }
    function tabCalls(page: import('@playwright/test').Page) {
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__tabCalls || [])));
    }

    test('rev: TC-CT-01 (rev3): md item **cmd 単独** click → 選択トグル（openFileInTab も openFile も非発火）', async ({ page }) => {
        // ユーザー裁定 2026-09-04（手動テスト (1)）: cmd/ctrl+click は note ツリーの不連続選択に割り当て直す。
        // webview 内タブで開く経路は右クリック「Open in new tab」（TC-OT-01/02）に一本化。
        const msgs = await clickItem(page, 'mdDoc', { metaKey: true });
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length, '旧 FR-CT-01（cmd+click でタブ）が残っている').toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(0);
        const selected = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected')).map((el) => (el as HTMLElement).dataset.fileId));
        expect(selected).toEqual(['mdDoc']);
    });

    test('TC-CT-02 regression: 通常 click → openFile（従来どおり）・openFileInTab 非発火', async ({ page }) => {
        const msgs = await clickItem(page, 'mdDoc', {});
        expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(0);
    });

    // ── rev3（ADRL-0112）: cmd+shift+click = 新規タブ ──

    test('TC-CT-07 md 行を cmd+shift+click → openFileInTab（メインペイン差替は非発火）', async ({ page }) => {
        const msgs = await clickItem(page, 'mdDoc', { metaKey: true, shiftKey: true });
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length, 'webview 内タブ経路が 1 回').toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab')[0].filePath).toBe('/test/note.md');
        expect(msgs.filter((m: any) => m.type === 'openFile').length, 'メインペイン差替は起きない').toBe(0);
        // 選択は 1 件に置き換わる（focus も移る）
        const selected = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected')).map((el) => (el as HTMLElement).dataset.fileId));
        expect(selected).toEqual(['mdDoc']);
    });

    test('TC-CT-07b .out 行も ctrl+shift+click で openFileInTab', async ({ page }) => {
        const msgs = await clickItem(page, 'outPlan', { ctrlKey: true, shiftKey: true });
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab')[0].filePath).toBe('/test/plan.out');
    });

    test('TC-CT-08 file 行を ctrl+shift+click → openTreeFileInTab（id のみ・絶対パス無し）', async ({ page }) => {
        const msgs = await clickItem(page, 'fileAtt', { ctrlKey: true, shiftKey: true });
        const hit = msgs.filter((m: any) => m.type === 'openTreeFileInTab');
        expect(hit.length, 'file は id ベースの新 bridge').toBe(1);
        expect(hit[0].id).toBe('fileAtt');
        expect(Object.keys(hit[0]).sort(), 'payload は type + id のみ（絶対パスを載せない）').toEqual(['id', 'type']);
        // 旧経路（md/.out 用の filePath bridge）に流していない
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openTreeFileExternal').length, '通常 open も起きない').toBe(0);
    });

    test('TC-CT-09 linkedfd 行を cmd+shift+click → tabManager.openInNewTab(folder)', async ({ page }) => {
        await spyTabManager(page);
        await clickItem(page, 'linkFd', { metaKey: true, shiftKey: true });
        const calls = await tabCalls(page);
        expect(calls.length, 'folder タブが 1 回').toBe(1);
        expect(calls[0].fileKey).toBe('linkFd');
        expect(calls[0].kind).toBe('folder');
    });

    test('TC-CT-11 shift 単独 click は範囲選択のみ（open が 1 度も発火しない）', async ({ page }) => {
        await clickItem(page, 'mdDoc', {});           // anchor を作る（ここでは openFile が 1 回飛ぶ）
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        const msgs = await clickItem(page, 'fileAtt', { shiftKey: true });
        // ★ counterfactual: pointerup 保険の shiftKey ガードが無いと openTreeFileExternal / openFile が飛ぶ
        expect(msgs.filter((m: any) => m.type === 'openFile').length, 'shift 範囲選択で open しない').toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openTreeFileExternal').length).toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(0);
        const selected = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected')).map((el) => (el as HTMLElement).dataset.fileId));
        expect(selected, 'mdDoc..fileAtt の連続範囲').toEqual(['mdDoc', 'outPlan', 'fileAtt']);
    });

    test('TC-CT-12 file 行の cmd 単独 click は単品トグル選択（タブ非発火）', async ({ page }) => {
        const msgs = await clickItem(page, 'fileAtt', { metaKey: true });
        expect(msgs.filter((m: any) => m.type === 'openTreeFileInTab').length, 'タブは開かない').toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openTreeFileExternal').length, '通常 open もしない').toBe(0);
        const selected = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected')).map((el) => (el as HTMLElement).dataset.fileId));
        expect(selected).toEqual(['fileAtt']);
    });

    test('rev: TC-CT-03b (rev3): ctrl 単独 (win/linux) も同じくトグル。.out も対象（開かない）', async ({ page }) => {
        const msgs = await clickItem(page, 'outPlan', { ctrlKey: true });
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(0);
        const selected = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected')).map((el) => (el as HTMLElement).dataset.fileId));
        expect(selected).toEqual(['outPlan']);
    });
});

test.describe('outliner page icon cmd+click (FR-CT-03)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: { n1: { id: 'n1', parentId: null, text: 'paged node', children: [], isPage: true, pageId: 'pg-1' } },
            });
        });
        await page.waitForSelector('.outliner-page-icon');
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    });

    async function clickIcon(page: import('@playwright/test').Page, opts: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
        await page.evaluate((opts) => {
            const icon = document.querySelector('.outliner-page-icon') as HTMLElement;
            icon.dispatchEvent(new MouseEvent('click', {
                bubbles: true, metaKey: !!opts.metaKey, ctrlKey: !!opts.ctrlKey, shiftKey: !!opts.shiftKey,
            }));
        }, opts);
        await page.waitForTimeout(50);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
    }

    test('TC-CT-10 ★load-bearing (rev3): page icon **cmd+shift+click** → openPageInTab {pageId}・sidepanel 非発火', async ({ page }) => {
        const msgs = await clickIcon(page, { metaKey: true, shiftKey: true });
        const hit = msgs.filter((m: any) => m.type === 'openPageInTab');
        expect(hit.length).toBe(1);
        expect(hit[0].pageId).toBe('pg-1');
        expect(hit[0].nodeId).toBe('n1');
        expect(msgs.filter((m: any) => m.type === 'openPageInSidePanel').length).toBe(0);
    });

    test('TC-CT-10b ctrl+shift+click（win/linux）も同じ', async ({ page }) => {
        const msgs = await clickIcon(page, { ctrlKey: true, shiftKey: true });
        expect(msgs.filter((m: any) => m.type === 'openPageInTab').length).toBe(1);
    });

    test('rev: TC-CT-04 (rev3): page icon の **cmd 単独** click は通常 open（sidepanel）に戻る', async ({ page }) => {
        // ★ ADRL-0112 決定 2: cmd 単独が「何も起きない」面を作らない。
        // counterfactual: `&& e.shiftKey` を外すと openPageInTab が飛んで RED
        const msgs = await clickIcon(page, { metaKey: true });
        expect(msgs.filter((m: any) => m.type === 'openPageInTab').length, 'タブは開かない').toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openPageInSidePanel').length, '通常 open が 1 回').toBe(1);
    });

    test('TC-CT-05 regression: page icon 通常 click → openPageInSidePanel（従来どおり）', async ({ page }) => {
        const msgs = await clickIcon(page, {});
        expect(msgs.filter((m: any) => m.type === 'openPageInSidePanel').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openPageInTab').length).toBe(0);
    });
});

test.describe('host routing source-contract (TC-CT-06)', () => {
    const ROOT = path.resolve(__dirname, '../..');

    test('TC-CT-06 Notes handler: openPageInTab は webviewTab + sidepanel フォールバック / Single は vscode.openWith', () => {
        const notesSrc = fs.readFileSync(path.join(ROOT, 'src/shared/notes-message-handler.ts'), 'utf-8');
        const caseIdx = notesSrc.indexOf("case 'openPageInTab'");
        expect(caseIdx).toBeGreaterThan(-1);
        const caseBlock = notesSrc.slice(caseIdx, caseIdx + 700);
        expect(caseBlock).toContain('getPageFilePath(message.pageId)');   // パス解決は host
        expect(caseBlock).toContain('openFileInWebviewTab');              // webview 内タブ
        expect(caseBlock).toContain('else');                              // フォールバック分岐
        expect(caseBlock).toContain('openPageInSidePanel');

        const singleSrc = fs.readFileSync(path.join(ROOT, 'src/outlinerProvider.ts'), 'utf-8');
        const sIdx = singleSrc.indexOf("case 'openPageInTab'");
        expect(sIdx).toBeGreaterThan(-1);
        const sBlock = singleSrc.slice(sIdx, sIdx + 700);
        expect(sBlock).toContain('getPageFilePath(document, message.pageId)'); // provider 非対称の書き分け
        expect(sBlock).toContain("'vscode.openWith'");
        expect(sBlock).toContain("'fractal.editor'");
    });
});

test.describe('outliner file icon cmd+shift+click (FR-ONT-02 / FR-CT-03 rev2)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['nf'],
                nodes: {
                    nf: {
                        id: 'nf', parentId: null, text: 'attached', children: [], tags: [], subtext: '',
                        images: [], collapsed: false, checked: null, isPage: false, pageId: null,
                        filePath: 'files/spec.pdf',
                    },
                },
            });
        });
        await page.waitForSelector('.outliner-file-icon');
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    });

    async function clickFileIcon(page: import('@playwright/test').Page, opts: { metaKey?: boolean; shiftKey?: boolean }) {
        await page.evaluate((o) => {
            const icon = document.querySelector('.outliner-file-icon') as HTMLElement;
            icon.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: !!o.metaKey, shiftKey: !!o.shiftKey }));
        }, opts);
        await page.waitForTimeout(50);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
    }

    test('TC-ONT-05 📎 アイコン cmd+shift+click → openNodeFileInTab（nodeId のみ）', async ({ page }) => {
        const msgs = await clickFileIcon(page, { metaKey: true, shiftKey: true });
        const hit = msgs.filter((m: any) => m.type === 'openNodeFileInTab');
        expect(hit.length, '新規タブ経路が 1 回').toBe(1);
        expect(hit[0].nodeId).toBe('nf');
        expect(Object.keys(hit[0]).sort(), 'payload は type + nodeId のみ').toEqual(['nodeId', 'type']);
        expect(msgs.filter((m: any) => m.type === 'openAttachedFile').length, '通常 open は起きない').toBe(0);
    });

    test('TC-CT-13 📎 アイコンの cmd 単独 click は通常 open（openAttachedFile）に戻る', async ({ page }) => {
        const msgs = await clickFileIcon(page, { metaKey: true });
        expect(msgs.filter((m: any) => m.type === 'openNodeFileInTab').length, 'タブは開かない').toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openAttachedFile').length, '通常 open が 1 回').toBe(1);
    });
});

test.describe('md editor anchor cmd+shift+click (FR-CT-05 rev2)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.loadMarkdownPane !== undefined);
        await page.evaluate(() => {
            (window as any).__testApi.loadMarkdownPane('[link](./other.md)');
        });
        await page.waitForSelector('.markdown-container a[href]');
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    });

    async function clickAnchor(page: import('@playwright/test').Page, opts: { metaKey?: boolean; shiftKey?: boolean }) {
        await page.evaluate((o) => {
            const a = document.querySelector('.markdown-container a[href]') as HTMLElement;
            a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: !!o.metaKey, shiftKey: !!o.shiftKey }));
        }, opts);
        await page.waitForTimeout(50);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
    }

    test('TC-CT-15 md の <a href> を cmd+shift+click → openLinkInTab（全アンカー一律 = 裁定 R12）', async ({ page }) => {
        const msgs = await clickAnchor(page, { metaKey: true, shiftKey: true });
        expect(msgs.filter((m: any) => m.type === 'openLinkInTab').length, '新規タブ経路が 1 回').toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openLink').length, '通常 open は起きない').toBe(0);
    });

    test('TC-CT-14 md の <a href> の cmd 単独 click は通常 open（openLink）に戻る', async ({ page }) => {
        // ★ counterfactual: `&& e.shiftKey` を外すと openLinkInTab が飛んで RED
        const msgs = await clickAnchor(page, { metaKey: true });
        expect(msgs.filter((m: any) => m.type === 'openLinkInTab').length, 'タブは開かない').toBe(0);
        expect(msgs.filter((m: any) => m.type === 'openLink').length, '通常 open が 1 回').toBe(1);
    });
});
