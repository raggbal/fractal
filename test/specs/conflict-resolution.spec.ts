/**
 * TASK-12 — 転送中の排他（進行中フラグ）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * INV-11 / DOM-InProgressGate / DOM-InProgressScope（design-review SYS-2 / TDD-3）
 *
 * TC-CONC-1: 転送中の 2 回目の drop を受理しない
 * TC-CONC-2: 進行中フラグは面単位で、完了後に解除される
 *
 * 番人: `fvBeginTransfer` のガードを外すと TC-CONC-1 が落ちる。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');
const BATCH_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/batch-payload.js'), 'utf8');
const FV_MIME = 'application/x-fractal-folderview-entry';

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
            { name: 'docs', relPath: 'docs', isDir: true },
            { name: 'src', relPath: 'src', isDir: true },
        ];
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}

/** dragstart → drop を発火（host bridge 呼び出しを観測）。 */
async function dnd(page: Page, grab: string, dropOn: string) {
    return page.evaluate(({ g, d, mime }) => {
        const w = window as any;
        const src = document.querySelector(`.fv-row[data-rel="${g}"]`) as HTMLElement;
        const dst = document.querySelector(`.fv-row[data-rel="${d}"]`) as HTMLElement;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const r = dst.getBoundingClientRect();
        const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
        return w.__calls.slice();
    }, { g: grab, d: dropOn, mime: FV_MIME });
}

test.describe('TASK-12 転送中の排他（進行中フラグ）', () => {
    test('TC-CONC-1: 転送中の 2 回目の drop を受理しない', async ({ page }) => {
        await mountFv(page);
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        // 1 回目（host からの一覧再送はまだ来ない = 転送中）
        const first = await dnd(page, 'docs', 'archive');
        const firstMoves = first.filter((c: any) => /^folderViewMove/.test(c.type));
        expect(firstMoves.length, '1 回目が host に届いていない').toBeGreaterThan(0);
        // 2 回目（完了通知が来る前）
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        const second = await dnd(page, 'src', 'archive');
        const secondMoves = second.filter((c: any) => /^folderViewMove/.test(c.type));
        expect(secondMoves.length,
            '転送中の 2 回目の drop が受理された（同一宛先への同時複製で連番が二重発生しうる = INV-11 違反）').toBe(0);
    });

    test('TC-CONC-2: 完了（host の一覧再送）でフラグが解除され次の drop が通る', async ({ page }) => {
        await mountFv(page);
        await dnd(page, 'docs', 'archive');
        // host が一覧を返す = 転送完了
        await page.evaluate(() => {
            window.postMessage({
                type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
                entries: [
                    { name: 'archive', relPath: 'archive', isDir: true },
                    { name: 'src', relPath: 'src', isDir: true },
                ],
            }, '*');
        });
        await page.waitForTimeout(80);
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        const after = await dnd(page, 'src', 'archive');
        const moves = after.filter((c: any) => /^folderViewMove/.test(c.type));
        expect(moves.length, '完了後もフラグが残って次の drop が通らない').toBeGreaterThan(0);
    });
});

/**
 * sprint 20260930-192647-linkedfd-conflict-rename-and-paste-sibling — FR-FVT-01（転送中フラグは結末によらず解除）
 * TC-FVT-03: folderViewTransferDone（一覧再送なし）で解除される
 * TC-FVT-04: 別 linkedfd 宛ての完了通知では解除しない（面単位）
 * TC-FVT-06: bridge 関数が無いとき dispatch はその場で解除する
 */
test.describe('転送完了通知で進行中フラグを解除（FR-FVT-01）', () => {
    async function movesOf(page: Page, grab: string, dropOn: string) {
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        const c = await dnd(page, grab, dropOn);
        return c.filter((x: any) => /^folderViewMove/.test(x.type)).length;
    }

    test('TC-FVT-03: folderViewTransferDone だけで解除され次の drop が通る', async ({ page }) => {
        await mountFv(page);
        expect(await movesOf(page, 'docs', 'archive')).toBeGreaterThan(0);
        await page.evaluate(() => { window.postMessage({ type: 'folderViewTransferDone', folderLinkId: 'fl1' }, '*'); });
        await page.waitForTimeout(80);
        expect(await movesOf(page, 'src', 'archive'), '完了通知で解除されていない').toBeGreaterThan(0);
    });

    test('TC-FVT-04: 別 linkedfd 宛ての完了通知では解除しない', async ({ page }) => {
        await mountFv(page);
        expect(await movesOf(page, 'docs', 'archive')).toBeGreaterThan(0);
        await page.evaluate(() => { window.postMessage({ type: 'folderViewTransferDone', folderLinkId: 'other' }, '*'); });
        await page.waitForTimeout(80);
        expect(await movesOf(page, 'src', 'archive'), '別面の完了通知で解除された').toBe(0);
    });

    test('TC-FVT-06: bridge 関数が無いとき dispatch はその場でフラグを解除する', async ({ page }) => {
        await mountFv(page);
        // folderViewMove / folderViewMoveBatch を持たない bridge に差し替えて 1 回目を dispatch
        await page.evaluate(() => {
            const w = window as any;
            w.__savedBridge = w.notesHostBridge;
            w.notesHostBridge = { notifyError: () => { /* noop */ } };
        });
        await dnd(page, 'docs', 'archive');
        await page.evaluate(() => { const w = window as any; w.notesHostBridge = w.__savedBridge; });
        expect(await movesOf(page, 'src', 'archive'), 'bridge 不在の 1 回目でフラグが残った').toBeGreaterThan(0);
    });
});
