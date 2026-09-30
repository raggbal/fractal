/**
 * TASK-08 — A-1: linkedfd 面内の複数フォルダ D&D 移動（+ 混在）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-04 / FR-FDP-07 / FR-FMV-02 / ADRL-0122 / DOM-FvMoveIds / DOM-FvMovePreflight
 *
 * TC-R1-1: 3 フォルダが全件移動する（bridge に全件が届く）
 * TC-R1-2: 移動先が選択フォルダの子孫なら 1 件も動かない
 * TC-R1-3: フォルダとファイルの混在が両方移動する
 * TC-MIX-1: 受け手が扱えない種別は除外件数を通知する（黙って落とさない）
 *
 * **継ぎ目を通る**: webview 層の drop を発火して host bridge の呼び出しを観測する
 * （host 関数を直接呼ぶ TC は過去に到達不能な分岐を green のまま見逃した = ADRL-0124 の Consequences）。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');
const BATCH_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/batch-payload.js'), 'utf8');
const FV_MIME = 'application/x-fractal-folderview-entry';

/** root に dir 4（`docs`/`src`/`assets`/`archive`）+ file 2。`docs/inner` も持つ。 */
async function mountFv(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:22px;}</style></head><body>'
        + '<div class="notes-main-wrapper" style="position:relative;height:600px;">'
        + '<div id="outlinerContainer">outliner</div><div id="markdownContainer" style="display:none">md</div>'
        + '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {}; w.__calls = [];
        w.notesHostBridge = new Proxy({}, {
            get: (_t, prop: string) => (...args: any[]) => { w.__calls.push({ type: prop, args }); },
        });
    });
    for (const js of [BATCH_JS, MENU_PLACEMENT_JS, DISPATCHER_JS, VIEW_JS]) {
        await page.addScriptTag({ content: js });
    }
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.evaluate(() => {
        const entries: any[] = [
            { name: 'archive', relPath: 'archive', isDir: true },
            { name: 'assets', relPath: 'assets', isDir: true },
            { name: 'docs', relPath: 'docs', isDir: true },
            { name: 'src', relPath: 'src', isDir: true },
            { name: 'f1.txt', relPath: 'f1.txt', isDir: false },
            { name: 'f2.txt', relPath: 'f2.txt', isDir: false },
        ];
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}

const clickRow = (page: Page, rel: string, mods: { meta?: boolean } = {}) =>
    page.locator(`.fv-row[data-rel="${rel}"]`).click({ modifiers: mods.meta ? ['Meta'] : [] });

/** webview の dragstart → drop を本番経路で発火し、host bridge 呼び出しを返す（継ぎ目を通る）。 */
async function dragAndDrop(page: Page, grab: string, dropOn: string) {
    return page.evaluate(({ g, d, mime }) => {
        const w = window as any;
        w.__calls.length = 0;
        const src = document.querySelector(`.fv-row[data-rel="${g}"]`) as HTMLElement;
        const dst = document.querySelector(`.fv-row[data-rel="${d}"]`) as HTMLElement;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const raw = dt.getData(mime);
        // drop は行の中央（フォルダ行の中 = そのフォルダへ移動）
        const r = dst.getBoundingClientRect();
        dst.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        }));
        dst.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        }));
        return { payload: raw ? JSON.parse(raw) : null, calls: w.__calls.slice() };
    }, { g: grab, d: dropOn, mime: FV_MIME });
}

test.describe('TASK-08 A-1 linkedfd 面内の複数フォルダ D&D', () => {
    test('TC-R1-1: 3 フォルダを選んで drop すると全件が batch で届く', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'docs');
        await clickRow(page, 'src', { meta: true });
        await clickRow(page, 'assets', { meta: true });
        const { payload, calls } = await dragAndDrop(page, 'docs', 'archive');
        expect((payload.items || []).map((i: any) => i.relPath).sort()).toEqual(['assets', 'docs', 'src']);
        const batch = calls.filter((c: any) => c.type === 'folderViewMoveBatch');
        expect(batch.length, 'batch bridge が 1 回でない（N 回ループはゲートを迂回する）').toBe(1);
        expect((batch[0].args[1] as string[]).sort(), '3 フォルダ全件が host に届いていない')
            .toEqual(['assets', 'docs', 'src']);
        expect(batch[0].args[2]).toBe('archive');
    });

    test('TC-R1-3: フォルダとファイルの混在が両方 batch に載る', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'docs');
        await clickRow(page, 'f1.txt', { meta: true });
        const { calls } = await dragAndDrop(page, 'docs', 'archive');
        const batch = calls.filter((c: any) => c.type === 'folderViewMoveBatch');
        expect(batch.length).toBe(1);
        expect((batch[0].args[1] as string[]).sort(), '混在でフォルダが落ちた（黙って置き去り = B-6）')
            .toEqual(['docs', 'f1.txt']);
    });

    test('TC-R1-2: 移動先が選択フォルダ自身なら 1 件も動かない（preflight）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'docs');
        await clickRow(page, 'src', { meta: true });
        // 選択に含まれる docs の上に drop = 自分自身が移動先
        const { calls } = await dragAndDrop(page, 'docs', 'docs');
        const batch = calls.filter((c: any) => c.type === 'folderViewMoveBatch' || c.type === 'folderViewMove');
        expect(batch.length, '自分自身への移動が host に届いた（preflight が効いていない）').toBe(0);
    });

    test('TC-NOTIFY-1w: フォルダ 1 件でも batch 経路を通る（集計通知の前提）', async ({ page }) => {
        await mountFv(page);
        // 選択なしでフォルダ 1 件を掴む = 単一 drag
        const { calls } = await dragAndDrop(page, 'docs', 'archive');
        const batch = calls.filter((c: any) => c.type === 'folderViewMoveBatch');
        const single = calls.filter((c: any) => c.type === 'folderViewMove');
        expect(batch.length, 'フォルダ 1 件が単数 bridge を直呼びしている（集計通知を迂回する）').toBe(1);
        expect(single.length).toBe(0);
    });

    test('TC-NOTIFY-2w: ファイル 1 件は従来どおり単数 bridge（既存 UX 不変）', async ({ page }) => {
        await mountFv(page);
        const { calls } = await dragAndDrop(page, 'f1.txt', 'archive');
        const single = calls.filter((c: any) => c.type === 'folderViewMove');
        const batch = calls.filter((c: any) => c.type === 'folderViewMoveBatch');
        expect(single.length, 'ファイル 1 件の単数経路が回帰した').toBe(1);
        expect(batch.length).toBe(0);
        // 引数は従来形式（第 4 引数を増やさない = 既存 spec の完全一致 assert を守る）
        expect(single[0].args).toEqual(['fl1', 'f1.txt', 'archive']);
    });
});
