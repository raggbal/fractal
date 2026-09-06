/**
 * 2026-09-04 ユーザー裁定 — linkedfd（folder view）の cmd/ctrl+click 単品トグル選択（FR-MSEL-01 rev2 / ADRL-0111）
 * TC-MSEL-43..44。
 * 🔴 counterfactual: 実装前は cmd+click が selectRow（単一選択に置換）で不連続選択にならない。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');

async function mountFv(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:20px;}</style></head><body>'
        + '<div class="notes-main-wrapper" style="position:relative;height:600px;">'
        + '<div id="outlinerContainer">outliner</div><div id="markdownContainer" style="display:none">md</div>'
        + '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        w.__calls = [];
        w.notesHostBridge = new Proxy({}, { get: (_t, prop: string) => (...args: any[]) => { w.__calls.push({ type: prop, args }); } });
    });
    await page.addScriptTag({ content: MENU_PLACEMENT_JS });
    await page.addScriptTag({ content: DISPATCHER_JS });
    await page.addScriptTag({ content: VIEW_JS });
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.evaluate(() => {
        const entries: any[] = [{ name: 'dirA', relPath: 'dirA', isDir: true }];
        for (let i = 1; i <= 5; i++) { entries.push({ name: `f${i}.txt`, relPath: `f${i}.txt`, isDir: false }); }
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}
function selectedRels(page: Page): Promise<string[]> {
    return page.evaluate(() => Array.from(document.querySelectorAll('.fv-row.fv-selected')).map((el) => (el as HTMLElement).dataset.rel || ''));
}
async function clickRow(page: Page, rel: string, mods?: { shift?: boolean; meta?: boolean; ctrl?: boolean }): Promise<void> {
    await page.evaluate(({ r, m }) => {
        (document.querySelector(`.fv-row[data-rel="${r}"]`) as HTMLElement).dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, shiftKey: !!m?.shift, metaKey: !!m?.meta, ctrlKey: !!m?.ctrl,
        }));
    }, { r: rel, m: mods || {} });
}

test('TC-MSEL-43 cmd/ctrl+click で加算・除外。集合は描画順に正規化・フォルダも対象・開かない', async ({ page }) => {
    await mountFv(page);
    await clickRow(page, 'f2.txt');
    await clickRow(page, 'f4.txt', { meta: true });
    expect(await selectedRels(page)).toEqual(['f2.txt', 'f4.txt']);
    await clickRow(page, 'dirA', { ctrl: true });
    expect(await selectedRels(page), '描画順に正規化されていない').toEqual(['dirA', 'f2.txt', 'f4.txt']);
    await clickRow(page, 'f2.txt', { meta: true });
    expect(await selectedRels(page)).toEqual(['dirA', 'f4.txt']);
    const opened = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.type === 'folderViewOpen').length);
    expect(opened, 'cmd+click で開いた').toBe(0);
    // dir の cmd+click は展開もしない（chevron の副作用を付けない）
    const listCalls = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.type === 'folderViewList' && c.args[1] === 'dirA').length);
    expect(listCalls).toBe(0);
});

test('TC-MSEL-44 cmd+click 後の shift+click は直近のトグル行が anchor', async ({ page }) => {
    await mountFv(page);
    await clickRow(page, 'f1.txt');
    await clickRow(page, 'f3.txt', { meta: true });   // anchor = f3
    await clickRow(page, 'f5.txt', { shift: true });
    expect(await selectedRels(page)).toEqual(['f3.txt', 'f4.txt', 'f5.txt']);
});
