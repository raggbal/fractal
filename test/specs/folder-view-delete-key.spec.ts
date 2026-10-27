/**
 * 2026-10-27 ユーザー要望 — linkedfd（folder view）で Delete / Backspace キーで選択を削除する。
 * 右クリックの Delete と同じ host 経路（folderViewDelete = ゴミ箱）。複数選択は全件、親子が両方選ばれたら親だけ。
 * 🔴 counterfactual: 実装前は Delete / Backspace で何も起きない（folderViewDelete が呼ばれない）。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');

async function mountFv(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:20px;}</style></head><body>'
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
        const entries = [{ name: 'dirA', relPath: 'dirA', isDir: true }, { name: 'f1.txt', relPath: 'f1.txt', isDir: false },
            { name: 'f2.txt', relPath: 'f2.txt', isDir: false }, { name: 'f3.txt', relPath: 'f3.txt', isDir: false }];
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}
const deletes = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.type === 'folderViewDelete').map((c: any) => c.args));
const clearCalls = (page: Page) => page.evaluate(() => { (window as any).__calls.length = 0; });

test('Delete / Backspace で選択中のファイルを削除する（右クリックの Delete と同じ経路）', async ({ page }) => {
    await mountFv(page);
    await page.locator('.fv-row[data-rel="f2.txt"]').click();
    await page.keyboard.press('Delete');
    expect(await deletes(page)).toEqual([['fl1', 'f2.txt']]);

    await clearCalls(page);
    await page.locator('.fv-row[data-rel="f1.txt"]').click();
    await page.keyboard.press('Backspace');
    expect(await deletes(page), 'mac の delete キー（Backspace）').toEqual([['fl1', 'f1.txt']]);

    await clearCalls(page);
    await page.locator('.fv-row[data-rel="f1.txt"]').click();
    await page.locator('.fv-row[data-rel="f3.txt"]').click({ modifiers: ['Meta'] });
    await page.keyboard.press('Meta+Backspace');
    expect(await deletes(page), '複数選択は全件').toEqual([['fl1', 'f1.txt'], ['fl1', 'f3.txt']]);
});

test('rename の入力中の Backspace では削除しない', async ({ page }) => {
    await mountFv(page);
    await page.locator('.fv-row[data-rel="f2.txt"]').click();
    await page.keyboard.press('Enter'); // インライン rename 開始
    await page.waitForSelector('.fv-rename-input');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    expect(await deletes(page)).toEqual([]);
});
