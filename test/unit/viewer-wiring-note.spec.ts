/**
 * viewer-wiring-note.spec.ts — note 面 送信側不変の pin — TC-FV-23
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-05。
 * notesEditorProvider は vscode + panel 依存で unit 直起動不能（既存 spec 冒頭コメントの既知制約）
 * → TC-FV-23 は「送信側 message type 不変」（webview → host は viewer 対象でも従来どおり
 * openTreeFileExternal）を notetree-file-panel.spec.ts の loadPanel 流儀で検証する。
 * host 側分岐の behavioral 検証は TC-FV-32（TASK-06 / platform モック注入）が担う。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PANEL_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/notes-file-panel.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html.js');
const PANEL = generateNotesFilePanelHtml({ collapsed: false, messages: {} });

async function loadPanel(page: Page, fileList: any[], structure: any): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<style>' + PANEL.css + '</style>' +
        '<style>.file-panel-item{min-height:22px;}</style>' +
        '</head><body>' + PANEL.html + '</body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        w.__calls = [];
        w.__makeBridge = function () {
            const rec = (type: string) => function (...args: unknown[]) { w.__calls.push({ type, args }); };
            return new Proxy({}, {
                get(_t, prop) { return typeof prop === 'string' ? rec(prop) : undefined; },
            });
        };
    });
    await page.addScriptTag({ content: PANEL_JS });
    await page.evaluate(({ fileList, structure }) => {
        const w = window as any;
        w.notesFilePanel.init(w.__makeBridge(), fileList, null, structure, null, 'MyNote');
        w.__calls = [];
    }, { fileList, structure });
}

test.describe('note 面 送信側（FR-FV-01 / TC-FV-23）', () => {

    test('TC-FV-23: file item クリックの bridge 呼び出しは viewer 対象でも不変（判定は host 側）', async ({ page }) => {
        await loadPanel(page, [
            { id: 'v1', filePath: '/n/files/doc.pdf', title: 'doc.pdf', kind: 'file' },
            { id: 'z1', filePath: '/n/files/a.zip', title: 'a.zip', kind: 'file' },
        ], {
            version: 1, rootIds: ['v1', 'z1'],
            items: {
                v1: { type: 'file', id: 'v1', title: 'doc.pdf' },
                z1: { type: 'file', id: 'z1', title: 'a.zip' },
            },
        });
        const calls = await page.evaluate(() => {
            const w = window as any;
            (document.querySelector('[data-item-id="v1"]') as HTMLElement).click();
            (document.querySelector('[data-item-id="z1"]') as HTMLElement).click();
            return w.__calls;
        });
        const openCalls = calls.filter((c: any) => String(c.type).toLowerCase().includes('open'));
        // viewer 対象（.pdf）も対象外（.zip）も同じ従来 bridge 呼び出し（webview は viewer 判定しない —
        // これが既存 click 系 spec 5 本の無変更 green の根拠。host 分岐は TC-FV-32）
        expect(openCalls.map((c: any) => c.type)).toEqual(['openTreeFileExternal', 'openTreeFileExternal']);
        expect(openCalls.map((c: any) => c.args[0])).toEqual(['v1', 'z1']);
    });
});
