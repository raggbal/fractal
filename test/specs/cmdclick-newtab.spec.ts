/**
 * cmd+click 新規タブ — sprint 20260727-174934
 * TC-CT-01〜06 (testcases.md §A)
 *
 * FR-CT-01/02: file tree item の cmd/ctrl+click → bridge.openFileInTab（webview 内タブ経路）。
 *              通常 click は従来どおり bridge.openFile。
 * FR-CT-03: outliner page アイコンの cmd/ctrl+click → openPageInTab {pageId}（パス解決は host）。
 *           通常 click は従来どおり openPageInSidePanel。
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
];
const structure = {
    version: 1,
    rootIds: ['mdDoc', 'outPlan'],
    items: {
        mdDoc: { type: 'file', id: 'mdDoc', title: 'Doc', ext: 'md' },
        outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out' },
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

    async function clickItem(page: import('@playwright/test').Page, itemId: string, opts: { metaKey?: boolean; ctrlKey?: boolean }) {
        await page.evaluate(({ itemId, opts }) => {
            const el = document.querySelector(`[data-item-id="${itemId}"]`) as HTMLElement;
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: !!opts.metaKey, ctrlKey: !!opts.ctrlKey }));
        }, { itemId, opts });
        await page.waitForTimeout(50);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
    }

    test('TC-CT-01 ★load-bearing: md item cmd+click → openFileInTab 発火・openFile 非発火', async ({ page }) => {
        const msgs = await clickItem(page, 'mdDoc', { metaKey: true });
        // counterfactual: 実装前は openFile 1 件 / openFileInTab 0 件 = RED
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab')[0].filePath).toBe('/test/note.md');
        expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(0);
    });

    test('TC-CT-02 regression: 通常 click → openFile（従来どおり）・openFileInTab 非発火', async ({ page }) => {
        const msgs = await clickItem(page, 'mdDoc', {});
        expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(0);
    });

    test('TC-CT-03 ctrlKey (win/linux) でも openFileInTab。.out も対象', async ({ page }) => {
        // .out は currentFile と同一だが cmd+click は currentFile ガードを通らず発火する
        const msgs = await clickItem(page, 'outPlan', { ctrlKey: true });
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab')[0].filePath).toBe('/test/plan.out');
        expect(msgs.filter((m: any) => m.type === 'openFile').length).toBe(0);
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

    async function clickIcon(page: import('@playwright/test').Page, opts: { metaKey?: boolean }) {
        await page.evaluate((opts) => {
            const icon = document.querySelector('.outliner-page-icon') as HTMLElement;
            icon.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: !!opts.metaKey }));
        }, opts);
        await page.waitForTimeout(50);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
    }

    test('TC-CT-04 ★load-bearing: page icon cmd+click → openPageInTab {pageId} 発火・sidepanel 非発火', async ({ page }) => {
        const msgs = await clickIcon(page, { metaKey: true });
        // counterfactual: 実装前は openPageInSidePanel が発火 = RED
        const hit = msgs.filter((m: any) => m.type === 'openPageInTab');
        expect(hit.length).toBe(1);
        expect(hit[0].pageId).toBe('pg-1');
        expect(hit[0].nodeId).toBe('n1');
        expect(msgs.filter((m: any) => m.type === 'openPageInSidePanel').length).toBe(0);
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
