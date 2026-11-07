/**
 * Notes 左パネルの検索結果（Results タブ）
 *   - ファイル名（結果のグループ見出し）は fractal の青（--fr-color-primary-strong）。種別名（Outliner results 等）は
 *     灰色の文字 + 青の下線で見分ける（--vscode-textLink-foreground はテーマ次第で紫になるので使わない）
 *   - 拡張子別アイコンがある添付（xlsx 等）はファイル名の前にアイコン（ツリーと同じ MarkdownLinkParser.fileIconGlyph）、
 *     md / .out の見出しにはツリーと同じ種別アイコン（SVG）
 *   - リンク行の上に結果が覗く隙間を作らない（結果コンテナの上 padding 0）
 *   - 結果の一番上に、結果のある種別（Notes / Outliner / Markdown / Files）へ飛ぶリンク（件数つき）
 *
 * ハーネス: 現ソースの tokens.css + notes-body-html（CSS/HTML）+ markdown-link-parser.js + notes-file-panel.js を
 * about:blank に載せ、host 役のテストが onSearchStart / onSearchPartial を駆動する（notes-panel-notion-header.spec.ts の
 * 単体パネルと同型）。tokens.css は本番の webview と同じく panel の CSS より前に読む（色を token で解決して比べるため —
 * 2026-11 modern-2026。以前は tokens を読まず、CSS の fallback の色を見ていた）。
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
    const tokens = fs.readFileSync(path.join(ROOT, 'src/webview/tokens.css'), 'utf8');
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html data-fr-theme="light"><head><meta charset="utf-8"><style>' + tokens + '</style><style>' + panel.css + '</style></head>' +
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
            fileId: 'm1', fileTitle: 'Budget memo', fileType: 'md', mdFilePath: '/notes/A/memo.md',
            matches: [{ field: 'text', lineText: 'Budget memo line', lineNumber: 1 }],
        });
        w.__onSearchPartial(1, {
            fileId: 'files/Budget.xlsx', fileTitle: 'Budget.xlsx', fileType: 'file',
            matches: [{ field: 'text', lineText: 'Budget total', loc: 'Sheet1!B2' }],
        });
        w.__onSearchEnd(1);
    });
}

test('結果のファイル名は青・種別名は灰色 + 下線、xlsx は名前の前に絵文字アイコン・md / .out は種別アイコン', async ({ page }) => {
    await bootPanel(page);
    await runSearch(page);
    const filesHeader = page.locator('#notesSearchResults .file-panel-search-file-header', { hasText: 'Budget.xlsx' });
    await expect(filesHeader).toHaveCount(1);
    const style = await filesHeader.evaluate((el) => {
        // Fractal の青（--fr-color-primary-strong）を probe の要素で解決した値と比べる（値は tokens.css の 1 か所で決まる —
        // docs/design/modern-2026.md §10.5。2026-11 に #3994BC → #0256C3 へ。固定値にすると配色を変えるたびに test を直すことになる）
        const probe = document.createElement('div');
        probe.style.color = 'var(--fr-color-primary-strong)';
        document.body.appendChild(probe);
        const blue = getComputedStyle(probe).color;
        probe.remove();
        return {
            color: getComputedStyle(el).color,
            blue,
            first: (el.firstElementChild as HTMLElement | null)?.className || '',
            glyph: (el.firstElementChild as HTMLElement | null)?.textContent || '',
        };
    });
    // 前提: token が解決できていて、青である（B が R より十分大きい — 値そのものは tokens.css の 1 か所で決まる）
    const ch = style.blue.match(/\d+/g)!.map(Number);
    expect(ch[2] - ch[0], `--fr-color-primary-strong が青でない: ${style.blue}`).toBeGreaterThan(60);
    expect(style.color).toBe(style.blue);                    // ファイル名 = Fractal の青（--fr-color-primary-strong）
    expect(style.first).toBe('file-panel-search-file-glyph');
    expect(style.glyph).toBe('📗');
    // .out の見出しには .out の SVG アイコン（emoji ではない）
    const outHeader = page.locator('#notesSearchResults .file-panel-search-file-header', { hasText: 'Plan 0' });
    await expect(outHeader.locator('.file-panel-search-file-glyph')).toHaveCount(0);
    await expect(outHeader.locator('svg.file-panel-search-file-icon')).toHaveCount(1);
    // テーマのリンク色が紫でも、見出しと種別名は fractal の色のまま。種別名は見出しと違う色 + 下線
    await page.evaluate(() => document.documentElement.style.setProperty('--vscode-textLink-foreground', '#b180d7'));
    const cat = await page.locator('#notesSearchResults .file-panel-search-section-title', { hasText: 'Outliner' }).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, border: cs.borderBottomWidth + ' ' + cs.borderBottomStyle };
    });
    expect(await filesHeader.evaluate((el) => getComputedStyle(el).color)).toBe(style.blue);
    expect(style.blue).not.toBe('rgb(177, 128, 215)');       // VS Code のリンク色（紫）に引きずられない
    expect(cat.color).not.toBe(style.blue);
    expect(cat.color).not.toBe('rgb(177, 128, 215)');
    expect(cat.border).toBe('2px solid');
    const mdHeader = page.locator('#notesSearchResults .file-panel-search-file-header', { hasText: 'Budget memo' });
    await expect(mdHeader.locator('svg.file-panel-search-file-icon')).toHaveCount(1);
    // md と .out は別のアイコン
    const mdSvg = await mdHeader.locator('svg').evaluate((el) => el.innerHTML);
    const outSvg = await outHeader.locator('svg').evaluate((el) => el.innerHTML);
    expect(mdSvg).not.toBe(outSvg);
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
    await expect(jump.locator('.file-panel-search-jump-link')).toHaveText(['Notes (1)', 'Outliner (24)', 'Markdown (1)', 'Files (1)']);

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
    // リンク行は sticky でスクロール後も見えていて、その上に結果が覗く隙間が無い（上端に張り付く）
    await expect(jump).toBeInViewport();
    const gap = await page.evaluate(() => {
        const r = document.getElementById('notesSearchResults')!;
        const j = r.querySelector('.file-panel-search-jump') as HTMLElement;
        return j.getBoundingClientRect().top - r.getBoundingClientRect().top;
    });
    expect(gap).toBe(0);
});
