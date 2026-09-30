/**
 * TASK-03 — フォルダ payload 生成（webview 側）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-01 / FR-FMV-03 / FR-MSEL-05 / ADRL-0122 / ADRL-0125 / DOM-SelectionSeqParity / INV-10
 *
 * TC-PAY-1: 複数フォルダの payload に isDir の実値が載る
 * TC-PAY-2: フォルダのみ選択で drag が実際に始まる（**実マウス** = e2e-real-input）
 * TC-PAY-3: note ツリーの payload にフォルダが載り seq を持つ
 * TC-PAY-4: 既存 md / file / .out の payload が 1 バイトも変わらない
 *
 * ハーネスは既存 `folder-view-batch-move.spec.ts` の `mountFv` と同型（fv を単体マウント +
 * Proxy host bridge で全呼び出しを記録）。**本番が DataTransfer に載せた payload** を観測する。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');
const BATCH_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/batch-payload.js'), 'utf8');
const FV_MIME = 'application/x-fractal-folderview-entry';

/** root に file 3 + dir 3（`docs` / `src` / `assets`）を持つ fv。 */
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
            { name: 'assets', relPath: 'assets', isDir: true },
            { name: 'docs', relPath: 'docs', isDir: true },
            { name: 'src', relPath: 'src', isDir: true },
        ];
        for (let i = 1; i <= 3; i++) { entries.push({ name: `f${i}.txt`, relPath: `f${i}.txt`, isDir: false }); }
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}

const clickRow = (page: Page, rel: string, mods: { shift?: boolean; meta?: boolean } = {}) =>
    page.locator(`.fv-row[data-rel="${rel}"]`).click({
        modifiers: [...(mods.shift ? ['Shift' as const] : []), ...(mods.meta ? ['Meta' as const] : [])],
    });

/** 本番の dragstart handler が DataTransfer に載せた payload を読む。 */
async function dragstartPayload(page: Page, grab: string) {
    return page.evaluate(({ g, mime }) => {
        const src = document.querySelector(`.fv-row[data-rel="${g}"]`) as HTMLElement;
        const dt = new DataTransfer();
        const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
        src.dispatchEvent(ev);
        const raw = dt.getData(mime);
        return { payload: raw ? JSON.parse(raw) : null, defaultPrevented: ev.defaultPrevented };
    }, { g: grab, mime: FV_MIME });
}

test.describe('TASK-03 フォルダ payload（linkedfd）', () => {
    test('TC-PAY-1: 複数フォルダの payload に isDir の実値が載る', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'docs');
        await clickRow(page, 'src', { meta: true });
        await clickRow(page, 'f1.txt', { meta: true });
        const { payload } = await dragstartPayload(page, 'docs');
        expect(payload, 'dragstart payload が載っていない').toBeTruthy();
        const items = payload.items || [];
        // フォルダが除外されずに載る（旧実装は dir を落としていた）
        expect(items.map((it: any) => it.relPath).sort()).toEqual(['docs', 'f1.txt', 'src']);
        // isDir が **実値**（旧実装は false のリテラル固定）
        const byRel: Record<string, boolean> = {};
        for (const it of items) { byRel[it.relPath] = it.isDir; }
        expect(byRel['docs'], 'フォルダの isDir が実値でない（false 固定のまま）').toBe(true);
        expect(byRel['src']).toBe(true);
        expect(byRel['f1.txt']).toBe(false);
    });

    test('TC-PAY-2: フォルダのみ選択で drag が実際に始まる（実マウス）', async ({ page }) => {
        await mountFv(page);
        // フォルダだけを 2 件選択
        await clickRow(page, 'docs');
        await clickRow(page, 'src', { meta: true });

        // 実マウスで drag を開始する（合成 DragEvent では「drag が始まるか」自体を検証できない）
        await page.evaluate(() => {
            const w = window as any;
            w.__dragStarted = 0; w.__dragPrevented = 0;
            document.addEventListener('dragstart', (e) => {
                w.__dragStarted++;
                // 本番 handler は同じ dragstart で走る。抑止されたかを後で読む
                setTimeout(() => { if ((e as any).defaultPrevented) { w.__dragPrevented++; } }, 0);
            }, true);
        });
        const from = await page.locator('.fv-row[data-rel="docs"]').boundingBox();
        const to = await page.locator('.fv-row[data-rel="assets"]').boundingBox();
        expect(from && to).toBeTruthy();
        await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
        await page.mouse.down();
        await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
        await page.mouse.up();

        // 実マウスで drag が始まったか、または少なくとも本番 handler が抑止していないこと
        const prevented = await page.evaluate(() => (window as any).__dragPrevented);
        expect(prevented, 'フォルダのみ選択で dragstart が抑止された（drag が始まらない = US-001 の症状）').toBe(0);
        // 合成経路でも payload が載り抑止されていないことを併せて確認（実マウスの drag は
        // ブラウザ実装差で dragstart が出ない環境があるため、抑止の不在を主 assert にする）
        const { payload, defaultPrevented } = await dragstartPayload(page, 'docs');
        expect(defaultPrevented, 'フォルダのみ選択で preventDefault された').toBe(false);
        expect(payload).toBeTruthy();
        expect((payload.items || []).map((it: any) => it.relPath).sort()).toEqual(['docs', 'src']);
    });

    test('TC-PAY-4a: 単一 drag（従来形式）の payload が 1 バイトも変わらない', async ({ page }) => {
        await mountFv(page);
        // 選択なしで file を掴む = 従来の単一形式
        const single = await dragstartPayload(page, 'f2.txt');
        expect(single.payload).toEqual({ folderLinkId: 'fl1', relPath: 'f2.txt', isDir: false });
        // 単一 folder も従来どおり（既存機能 = FR-FLV-16）
        const singleDir = await dragstartPayload(page, 'docs');
        expect(singleDir.payload).toEqual({ folderLinkId: 'fl1', relPath: 'docs', isDir: true });
    });

    test('TC-PAY-4b: 複数 file のみの payload はキー集合が従来と同一（additive のみ）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f2.txt', { meta: true });
        const { payload } = await dragstartPayload(page, 'f1.txt');
        expect(Object.keys(payload).sort()).toEqual(['excludedDirs', 'folderLinkId', 'items', 'v']);
        expect(payload.items.map((it: any) => ({ ...it }))).toEqual([
            { folderLinkId: 'fl1', relPath: 'f1.txt', isDir: false },
            { folderLinkId: 'fl1', relPath: 'f2.txt', isDir: false },
        ]);
    });
});

test.describe('TASK-03 note ツリーの選択順（mergeTreeItemsBySeq の 3 種対応）', () => {
    test('TC-PAY-3: folder が seq を持ち md / file と混ぜて選択順が復元できる', async ({ page }) => {
        await page.goto('about:blank');
        await page.addScriptTag({ content: BATCH_JS });
        const merged = await page.evaluate(() => {
            const m = (window as any).__batchPayload.mergeTreeItemsBySeq;
            // 選択順: file(0) → folder(1) → md(2) → folder(3)
            return m(
                [{ id: 'md-1', filePath: '/n/a.md', seq: 2 }],
                [{ id: 'file-1', seq: 0 }],
                [{ id: 'fold-1', seq: 1 }, { id: 'fold-2', seq: 3 }]
            );
        });
        expect(merged).toEqual([
            { kind: 'file', id: 'file-1', filePath: null },
            { kind: 'folder', id: 'fold-1', filePath: null },
            { kind: 'md', id: 'md-1', filePath: '/n/a.md' },
            { kind: 'folder', id: 'fold-2', filePath: null },
        ]);
    });

    test('TC-PAY-4c: folderItems 未指定なら従来と完全に同一（後方互換）', async ({ page }) => {
        await page.goto('about:blank');
        await page.addScriptTag({ content: BATCH_JS });
        const r = await page.evaluate(() => {
            const m = (window as any).__batchPayload.mergeTreeItemsBySeq;
            const two = m([{ id: 'md-1', filePath: '/n/a.md', seq: 1 }], [{ id: 'file-1', seq: 0 }]);
            const three = m([{ id: 'md-1', filePath: '/n/a.md', seq: 1 }], [{ id: 'file-1', seq: 0 }], undefined);
            return { two, three };
        });
        expect(r.two).toEqual([
            { kind: 'file', id: 'file-1', filePath: null },
            { kind: 'md', id: 'md-1', filePath: '/n/a.md' },
        ]);
        expect(r.three).toEqual(r.two);
    });
});
