/**
 * doc-search-panel.spec.ts — webview 検索 UI の Files セクション（fileType:'file'）
 *
 * sprint 20260813-133248-search-doc-content / TASK-08。
 * design/system.md §5 / testcases.md D 節 / ハーネス = notetree-file-panel.spec.ts 流儀
 * （実ソース notes-file-panel.js を setContent + addScriptTag — build 成果物非依存）。
 *
 * 検証対象:
 *  - TC-DS-19: fileType:'file' の Partial が Files セクションに表示（Outliner/Md に混入しない）+ 件数
 *  - TC-DS-20: Files 行クリック → openTreeFileExternal(fileId)（明示メソッド集合 fake — Proxy 禁止）
 *  - TC-DS-36: i18n 新キーが WebviewMessages interface + 7 locale 全部に存在（ソース検査）
 *  - TC-DS-37: 既存 TC-WV-06（Explore 名前検索）は notetree-file-panel.spec.ts 側で green 維持（regression）
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PANEL_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/notes-file-panel.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html.js');
const PANEL = generateNotesFilePanelHtml({ collapsed: false, messages: {} });

/**
 * 明示メソッド集合の fake bridge（recorder）で panel を初期化する。
 * ⚠️ Proxy fake（任意メソッド名に応答）は使わない — typeof ガード付き呼び出し
 * （openTreeFileExternal）の欠落を検出できない tautology になる（generator_failures 2026-08-09）。
 */
async function loadPanelWithExplicitBridge(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<style>' + PANEL.css + '</style>' +
        '</head><body>' + PANEL.html + '</body></html>');

    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        w.__calls = [];
        // 実 bridge（notes-host-bridge.js）が持つメソッドのうち panel 検索面が使う集合だけを明示定義。
        // openTreeFileExternal は実 bridge :554 に実在する（実在しないメソッドはここに書かない）。
        w.__makeExplicitBridge = function () {
            const rec = (type: string) => function () {
                const args = Array.prototype.slice.call(arguments);
                w.__calls.push({ type, args });
                if (type === 'onSearchStart') w.__onSearchStart = args[0];
                if (type === 'onSearchPartial') w.__onSearchPartial = args[0];
                if (type === 'onSearchEnd') w.__onSearchEnd = args[0];
            };
            return {
                onSearchStart: rec('onSearchStart'),
                onSearchPartial: rec('onSearchPartial'),
                onSearchEnd: rec('onSearchEnd'),
                openTreeFileExternal: rec('openTreeFileExternal'),
                openNoteFilesExternal: rec('openNoteFilesExternal'),   // rev.2（実 bridge に実在 — notes-host-bridge.js）
                jumpToNode: rec('jumpToNode'),
                jumpToMdPage: rec('jumpToMdPage'),
                openFile: rec('openFile'),
                search: rec('search'),
            };
        };
    });
    await page.addScriptTag({ content: PANEL_JS });
    await page.evaluate(() => {
        const w = window as any;
        w.notesFilePanel.init(
            w.__makeExplicitBridge(),
            [{ id: 'att1', filePath: '/n/files/meeting.docx', title: '会議資料', kind: 'file' }],
            null,
            { version: 1, rootIds: ['att1'], items: { att1: { type: 'file', id: 'att1', title: '会議資料' } } },
            null, 'MyNote');
        w.__calls = [];
    });
}

const FILE_RESULT = {
    fileId: 'files/meeting.docx',            // rev.2: files/ 相対パス同定
    fileTitle: '会議資料',
    fileType: 'file',
    matches: [
        { field: 'content', lineText: '吾輩は猫である。名前はまだ無い。', matchStart: 0, matchEnd: 2, lineNumber: 3 },
    ],
};

test.describe('webview Files セクション（FR-DS-05）', () => {

    test('TC-DS-19: fileType:file は Files セクションに表示・Outliner/Md に混入しない・件数反映', async ({ page }) => {
        await loadPanelWithExplicitBridge(page);
        const r = await page.evaluate((fileResult) => {
            const w = window as any;
            const input = document.getElementById('notesSearchInput') as HTMLInputElement;
            input.value = '吾輩';
            w.__onSearchStart(10);
            w.__onSearchPartial(10, fileResult);
            // out 結果も 1 件流し、セクションが分離されることを確認
            w.__onSearchPartial(10, {
                fileId: 'o9', fileTitle: 'Plan', fileType: 'out',
                matches: [{ field: 'text', lineText: '吾輩メモ', matchStart: 0, matchEnd: 2, nodeId: 'n1' }],
            });
            w.__onSearchEnd(10);
            const sections = Array.from(document.querySelectorAll('#notesSearchResults .file-panel-search-section'))
                .map((s) => ({
                    title: (s.querySelector('.file-panel-search-section-title')?.textContent || '').trim(),
                    visible: (s as HTMLElement).style.display !== 'none',
                    bodies: Array.from(s.querySelectorAll('.file-panel-search-file-header')).map((h) => (h.textContent || '').trim()),
                }));
            return sections;
        }, FILE_RESULT);

        // 4 セクション（Explore / Outliner / Markdown / Files）
        expect(r.length).toBe(4);
        const files = r.find((s) => s.title.indexOf('Files') !== -1);
        const outliner = r.find((s) => s.title.indexOf('Outliner') !== -1);
        const md = r.find((s) => s.title.indexOf('Markdown') !== -1);
        expect(files).toBeDefined();
        expect(files!.visible).toBe(true);
        expect(files!.bodies.some((b) => b.indexOf('会議資料') !== -1)).toBe(true);   // Files に配置
        expect(files!.title).toContain('(1)');                                        // 件数カウンタ
        expect(outliner!.bodies.some((b) => b.indexOf('会議資料') !== -1)).toBe(false); // 混入なし
        expect(md!.bodies.some((b) => b.indexOf('会議資料') !== -1)).toBe(false);
        expect(outliner!.bodies.some((b) => b.indexOf('Plan') !== -1)).toBe(true);    // out は従来どおり
    });

    test('TC-DS-49: Files 行クリック → openNoteFilesExternal(relPath)（rev.2・明示 fake・Proxy 禁止）', async ({ page }) => {
        await loadPanelWithExplicitBridge(page);
        const calls = await page.evaluate((fileResult) => {
            const w = window as any;
            const input = document.getElementById('notesSearchInput') as HTMLInputElement;
            input.value = '吾輩';
            w.__onSearchStart(11);
            w.__onSearchPartial(11, fileResult);
            const match = document.querySelector('#notesSearchResults .file-panel-search-match') as HTMLElement;
            match.click();
            return {
                open: w.__calls.filter((c: any) => c.type === 'openNoteFilesExternal'),
                legacy: w.__calls.filter((c: any) => c.type === 'openTreeFileExternal'),
            };
        }, FILE_RESULT);
        expect(calls.open.length).toBe(1);
        expect(calls.open[0].args[0]).toBe('meeting.docx');   // files/ prefix を剥いた相対パス
        expect(calls.legacy.length).toBe(0);                   // 旧 id ベース経路は使わない
    });

    test('TC-DS-36: i18n キーが WebviewMessages interface + 7 locale 全部に存在', () => {
        const key = 'notesSearchFilesResults';
        const i18nRoot = path.join(__dirname, '../../src/i18n');
        const files = [
            'messages.ts',
            'locales/en.ts', 'locales/ja.ts', 'locales/es.ts', 'locales/fr.ts',
            'locales/ko.ts', 'locales/zh-cn.ts', 'locales/zh-tw.ts',
        ];
        for (const f of files) {
            const src = fs.readFileSync(path.join(i18nRoot, f), 'utf8');
            expect(src.includes(key), `${f} must contain ${key}`).toBe(true);
        }
        // interface 側は WebviewMessages ブロック内にあること（Messages 側でなく）
        const messages = fs.readFileSync(path.join(i18nRoot, 'messages.ts'), 'utf8');
        const webviewBlock = messages.substring(messages.indexOf('interface WebviewMessages'));
        expect(webviewBlock.includes(key)).toBe(true);
    });
});
