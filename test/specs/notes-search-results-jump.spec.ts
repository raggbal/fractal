/**
 * Notes 左パネルの検索結果（Results タブ）
 *   - ファイル名（結果のグループ見出し）はリンク色（旧: オレンジの classForeground は見づらい）
 *   - 拡張子別アイコンがある添付（xlsx 等）はファイル名の前にアイコン（ツリーと同じ MarkdownLinkParser.fileIconGlyph）
 *   - 結果の一番上に、結果のある種別（Notes / Outliner / Markdown / Files）へ飛ぶリンク（件数つき）
 *
 * ハーネス: 現ソースの notes-body-html（CSS/HTML）+ markdown-link-parser.js + notes-file-panel.js を about:blank に載せ、
 * host 役のテストが onSearchStart / onSearchPartial を駆動する（notes-panel-notion-header.spec.ts の単体パネルと同型）。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const STRUCTURE = {
    version: 1,
    rootIds: ['budget'],
    items: { budget: { type: 'file', id: 'budget', title: 'Budget.xlsx' } },
};
const FILES = [{ filePath: '/notes/A/files/Budget.xlsx', title: 'Budget.xlsx', id: 'budget', kind: 'file' }];

async function bootPanel(page: Page): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html.js');
    const panel = generateNotesFilePanelHtml({ collapsed: false, messages: {} });
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + panel.css + '</style></head>' +
        '<body><div class="notes-layout" style="height:400px">' + panel.html + '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        const reg = (k: string) => function (fn: any) { w[k] = fn; };
        const noop = function () { /* recorder 不要 */ };
        w.__bridge = {
            onSearchStart: reg('__onSearchStart'), onSearchPartial: reg('__onSearchPartial'), onSearchEnd: reg('__onSearchEnd'),
            search: noop, jumpToNode: noop, jumpToMdPage: noop, openFile: noop, openNoteFilesExternal: noop,
            togglePanel: noop, savePanelWidth: noop, toggleFolder: noop,
        };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'src/shared/markdown-link-parser.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'src/shared/notes-file-panel.js'), 'utf8') });
    await page.evaluate((o) => {
        const w = window as any;
        w.notesFilePanel.init(w.__bridge, o.files, null, o.structure, null, 'MyNote');
    }, { files: FILES, structure: STRUCTURE });
}

/** 検索語 Budget で、Explore（名前）+ Outliner 3 グループ + Files 1 グループの結果を流す */
async function runSearch(page: Page): Promise<void> {
    await page.locator('#notesSearchInput').fill('Budget');
    await page.evaluate(() => {
        const w = window as any;
        w.__onSearchStart(1);
        for (let i = 0; i < 3; i++) {
            w.__onSearchPartial(1, {
                fileId: 'o' + i, fileTitle: 'Plan ' + i, fileType: 'out',
                matches: Array.from({ length: 8 }, (_, j) => ({ field: 'text', lineText: 'Budget line ' + j, nodeId: 'n' + j })),
            });
        }
        w.__onSearchPartial(1, {
            fileId: 'files/Budget.xlsx', fileTitle: 'Budget.xlsx', fileType: 'file',
            matches: [{ field: 'text', lineText: 'Budget total', loc: 'Sheet1!B2' }],
        });
        w.__onSearchEnd(1);
    });
}

test('結果のファイル名はリンク色（オレンジでない）で、xlsx の添付は名前の前にアイコン', async ({ page }) => {
    await bootPanel(page);
    await runSearch(page);
    const filesHeader = page.locator('#notesSearchResults .file-panel-search-file-header', { hasText: 'Budget.xlsx' });
    await expect(filesHeader).toHaveCount(1);
    const style = await filesHeader.evaluate((el) => ({
        color: getComputedStyle(el).color,
        first: (el.firstElementChild as HTMLElement | null)?.className || '',
        glyph: (el.firstElementChild as HTMLElement | null)?.textContent || '',
    }));
    expect(style.color).toBe('rgb(55, 148, 255)');           // --vscode-textLink-foreground の既定 #3794ff
    expect(style.first).toBe('file-panel-search-file-glyph');
    expect(style.glyph).toBe('📗');
    // .out の見出しにはアイコンを付けない
    const outHeader = page.locator('#notesSearchResults .file-panel-search-file-header', { hasText: 'Plan 0' });
    await expect(outHeader.locator('.file-panel-search-file-glyph')).toHaveCount(0);
    // Explore（名前一致）の添付にも同じアイコン
    const explore = page.locator('#notesSearchResults .file-panel-search-section').first().locator('.file-panel-search-match');
    await expect(explore.locator('.file-panel-search-file-glyph')).toHaveText('📗');
});

test('結果の一番上に種別へ飛ぶリンク（結果のある種別だけ・件数つき）、押すとその節の見出しまでスクロール', async ({ page }) => {
    await bootPanel(page);
    await runSearch(page);
    const results = page.locator('#notesSearchResults');
    const jump = results.locator('.file-panel-search-jump');
    expect(await results.evaluate((el) => (el.firstElementChild as HTMLElement).className)).toBe('file-panel-search-jump');
    await expect(jump.locator('.file-panel-search-jump-link')).toHaveText(['Notes (1)', 'Outliner (24)', 'Files (1)']);

    // 節の下に十分な結果がある Outliner へ（最後の節は下に余白が無く、見出しを上端まで上げられない）
    await jump.locator('.file-panel-search-jump-link', { hasText: 'Outliner' }).click();
    const outTitle = results.locator('.file-panel-search-section-title', { hasText: 'Outliner' });
    const pos = await page.evaluate(() => {
        const r = document.getElementById('notesSearchResults')!;
        const j = r.querySelector('.file-panel-search-jump') as HTMLElement;
        const titles = Array.from(r.querySelectorAll('.file-panel-search-section-title')) as HTMLElement[];
        const t = titles.find((x) => /Outliner/.test(x.textContent || ''))!;
        return { scrollTop: r.scrollTop, titleTop: t.getBoundingClientRect().top, jumpBottom: j.getBoundingClientRect().bottom };
    });
    expect(pos.scrollTop).toBeGreaterThan(0);
    // 見出しはリンク行のすぐ下（隠れない・離れすぎない。差は結果コンテナの padding 程度）
    expect(pos.titleTop).toBeGreaterThanOrEqual(pos.jumpBottom - 1);
    expect(pos.titleTop - pos.jumpBottom).toBeLessThanOrEqual(8);
    await expect(outTitle).toBeVisible();
    // リンク行は sticky でスクロール後も見えている
    await expect(jump).toBeInViewport();
});
