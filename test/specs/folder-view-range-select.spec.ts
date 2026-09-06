/**
 * TASK-10 — linkedfd（folder view）の連続範囲選択
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MSEL-01/05 / NFR-MSEL-01 / ADRL-0108）
 *
 * TC-MSEL-01..04。
 *
 * 設計（design/system.md §3-1/§3-2）:
 *   - `selection:Set` + `anchor` + `focusKey`（既存 `selectedRel` は **focus** として温存）
 *   - 範囲計算は既存 `visibleRows`（描画順 relPath 配列）の index 区間 — 新規の順序計算を書かない
 *   - 範囲確定のたびに `window.getSelection().removeAllRanges()`（Hard MUST）
 *   - cmd/ctrl+click は単品トグル（rev2 2026-09-04・ADRL-0111。旧 FR-CT-01 占有は解消）
 *   - フォルダは選択集合に入れるが D&D payload からは除外（FR-MSEL-05）
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');

/** 10 行（dir 2 + file 8）の fv を単体マウントする。 */
async function mountFv(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:20px;}</style></head><body>'
        + '<div class="notes-main-wrapper" style="position:relative;height:600px;">'
        + '<div id="outlinerContainer">outliner</div>'
        + '<div id="markdownContainer" style="display:none">md</div>'
        + '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};
        w.__calls = [];
        w.notesHostBridge = new Proxy({}, {
            get: (_t, prop: string) => (...args: any[]) => { w.__calls.push({ type: prop, args }); },
        });
    });
    await page.addScriptTag({ content: MENU_PLACEMENT_JS });
    await page.addScriptTag({ content: DISPATCHER_JS });
    await page.addScriptTag({ content: VIEW_JS });
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.evaluate(() => {
        const entries: any[] = [
            { name: 'dirA', relPath: 'dirA', isDir: true },
            { name: 'dirB', relPath: 'dirB', isDir: true },
        ];
        for (let i = 1; i <= 8; i++) {
            entries.push({ name: `f${i}.txt`, relPath: `f${i}.txt`, isDir: false });
        }
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
    const n = await page.locator('.fv-row').count();
    expect(n, '前提: 10 行が描画されている').toBe(10);
}

/** 選択中の relPath を描画順で返す。 */
function selectedRels(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.fv-row.fv-selected')).map((el) => (el as HTMLElement).dataset.rel || ''));
}

/** 行を click（修飾キー付き可）。 */
async function clickRow(page: Page, rel: string, mods?: { shift?: boolean; meta?: boolean }): Promise<void> {
    await page.evaluate(({ r, m }) => {
        const el = document.querySelector(`.fv-row[data-rel="${r}"]`) as HTMLElement;
        el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, shiftKey: !!m?.shift, metaKey: !!m?.meta, ctrlKey: !!m?.meta,
        }));
    }, { r: rel, m: mods || {} });
}

/** tree に keydown を送る。 */
async function key(page: Page, k: string, mods?: { shift?: boolean }): Promise<void> {
    await page.evaluate(({ kk, m }) => {
        const tree = document.querySelector('.fv-tree') as HTMLElement;
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: kk, bubbles: true, shiftKey: !!m?.shift }));
    }, { kk: k, m: mods || {} });
}

test.describe('linkedfd の連続範囲選択（FR-MSEL-01）', () => {
    test('TC-MSEL-01 shift+click で anchor..target の範囲が選択される', async ({ page }) => {
        await mountFv(page);
        // 3 行目（f1.txt = index 2）を click → anchor
        await clickRow(page, 'f1.txt');
        expect(await selectedRels(page)).toEqual(['f1.txt']);

        // 7 行目（f5.txt = index 6）を shift+click → index 2..6 の 5 行
        await clickRow(page, 'f5.txt', { shift: true });
        expect(await selectedRels(page), 'visibleRows の index 区間で 5 行選択されるべき')
            .toEqual(['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
    });

    test('TC-MSEL-02 shift+↓ は伸長し shift+↑ は収縮する（anchor を跨がない範囲で）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        for (let i = 0; i < 4; i++) { await key(page, 'ArrowDown', { shift: true }); }
        expect(await selectedRels(page), 'shift+↓ ×4 で 5 行')
            .toEqual(['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);

        for (let i = 0; i < 2; i++) { await key(page, 'ArrowUp', { shift: true }); }
        expect(await selectedRels(page), 'shift+↑ ×2 で 3 行に縮む（伸長だけでなく収縮もする）')
            .toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
    });

    test('TC-MSEL-02b shift+↑ で anchor を跨ぐと反対側へ伸びる', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f5.txt');
        // anchor = f5。上へ 3 つ伸ばす
        for (let i = 0; i < 3; i++) { await key(page, 'ArrowUp', { shift: true }); }
        expect(await selectedRels(page)).toEqual(['f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
    });

    test('TC-MSEL-03 範囲確定後にテキスト範囲が残っていない（clipboard / D&D を奪われない）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        // 事前にテキスト範囲を作っておく（実装が removeAllRanges しないと残る）
        await page.evaluate(() => {
            const el = document.querySelector('.fv-row[data-rel="f3.txt"]') as HTMLElement;
            const r = document.createRange();
            r.selectNodeContents(el);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        expect(await page.evaluate(() => window.getSelection()!.rangeCount), '前提: テキスト範囲がある').toBeGreaterThan(0);

        await clickRow(page, 'f5.txt', { shift: true });
        expect(await page.evaluate(() => window.getSelection()!.rangeCount),
            'removeAllRanges() が呼ばれていない — テキスト範囲が残ると clipboard / D&D をブラウザ標準に奪われる')
            .toBe(0);
    });

    test('TC-MSEL-04 選択内の行を右クリックしても選択が維持される', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f5.txt', { shift: true });
        expect((await selectedRels(page)).length).toBe(5);

        // 選択内の行を右クリック → 維持
        await page.evaluate(() => {
            const el = document.querySelector('.fv-row[data-rel="f3.txt"]') as HTMLElement;
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));
        });
        expect(await selectedRels(page), '右クリックで 1 行に潰れてはいけない').toHaveLength(5);

        // 選択外の行を右クリック → その行のみ
        await page.evaluate(() => {
            const el = document.querySelector('.fv-row[data-rel="f8.txt"]') as HTMLElement;
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));
        });
        expect(await selectedRels(page), '選択外の右クリックはその行のみ').toEqual(['f8.txt']);
    });

    test('TC-MSEL-04b 修飾なし click は選択を 1 件にリセットし anchor を移す', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f5.txt', { shift: true });
        expect((await selectedRels(page)).length).toBe(5);

        await clickRow(page, 'f7.txt');
        expect(await selectedRels(page)).toEqual(['f7.txt']);
        // anchor が f7 に移っている（そこから shift+click すると f7..f8）
        await clickRow(page, 'f8.txt', { shift: true });
        expect(await selectedRels(page)).toEqual(['f7.txt', 'f8.txt']);
    });

    test('TC-MSEL-04c Esc で選択がクリアされる', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f5.txt', { shift: true });
        await key(page, 'Escape');
        expect(await selectedRels(page)).toEqual([]);
    });

    test('TC-MSEL-04d (rev2 2026-09-04) cmd/ctrl+click は単品トグル（不連続選択）', async ({ page }) => {
        // ユーザー裁定 2026-09-04（ADRL-0111）: 不連続選択を cmd/ctrl+click に割り当てる（ADRL-0108 を supersede）。
        // 詳細は folder-view-cmdclick-toggle.spec.ts（TC-MSEL-43/44）。ここでは範囲選択との共存だけ見る。
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f5.txt', { meta: true });
        expect(await selectedRels(page), 'cmd+click で不連続選択にならない').toEqual(['f1.txt', 'f5.txt']);
        await clickRow(page, 'f3.txt', { shift: true });   // anchor = f5 → f3..f5
        expect(await selectedRels(page)).toEqual(['f3.txt', 'f4.txt', 'f5.txt']);
    });

    test('TC-MSEL-05a フォルダは選択集合に入る（範囲の連続性を壊さない = FR-MSEL-05）', async ({ page }) => {
        await mountFv(page);
        // dirA(0) から f2.txt(3) まで = dir 2 件を含む 4 行
        await clickRow(page, 'dirA');
        await clickRow(page, 'f2.txt', { shift: true });
        expect(await selectedRels(page),
            'フォルダを飛ばすと anchor..focus の区間が不連続になり操作モデルが破綻する')
            .toEqual(['dirA', 'dirB', 'f1.txt', 'f2.txt']);
    });
});

/**
 * TC-MSEL-05..08 (TASK-23) — linkedfd 複数選択 → note ツリー D&D の送り手
 * （FR-MSEL-02 / FR-MSEL-05 / §4-1 §4-2）
 *
 * 本 spec は fv を単体マウントするので、**dragstart が積む payload**（送り手契約）を検証する。
 * note ツリー側の受け手（N 回の `folderViewMoveToTree` 呼び出し / 集計通知 1 回）は
 * `notes-file-panel.js` の `dispatchFolderViewEntryDrop` が担い、TC-MSEL-05b/06b で検証する。
 */
test.describe('TC-MSEL-05..08 複数選択 D&D の送り手契約（FR-MSEL-02/05）', () => {
    const FV_MIME = 'application/x-fractal-folderview-entry';

    /** 指定行で dragstart を発火し、積まれた payload を返す。 */
    async function fireDragstart(page: Page, rel: string): Promise<{ types: string[]; payload: any; prevented: boolean }> {
        return page.evaluate((r) => {
            const el = document.querySelector(`.fv-row[data-rel="${r}"]`) as HTMLElement;
            const dt = new DataTransfer();
            const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
            el.dispatchEvent(ev);
            const raw = dt.getData('application/x-fractal-folderview-entry');
            return { types: Array.from(dt.types), payload: raw ? JSON.parse(raw) : null, prevented: ev.defaultPrevented };
        }, rel);
    }

    test('TC-MSEL-05 5 ファイル選択 → payload に 5 件が選択順で載る', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f5.txt', { shift: true });
        expect((await selectedRels(page)).length, '前提: 5 行選択').toBe(5);

        const r = await fireDragstart(page, 'f3.txt');   // 選択内の行を drag
        expect(r.types, `${FV_MIME} が積まれていない`).toContain(FV_MIME);
        expect(r.payload.v, '複数形式のスキーマ版が無い').toBe(1);
        expect(r.payload.items.map((x: any) => x.relPath), '5 件が選択順で載っていない')
            .toEqual(['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
        // payload に絶対パスを載せない（INV-4 の維持）
        expect(JSON.stringify(r.payload), 'payload に絶対パスが混入').not.toMatch(/(^|")\//);
    });

    test('TC-MSEL-05b 単一選択のときは旧形式のまま（既存 TC を壊さない後方互換）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f2.txt');
        const r = await fireDragstart(page, 'f2.txt');
        expect(r.payload.items, '単一なのに items 配列になっている（受け手の既存 TC を壊す）').toBeUndefined();
        expect(r.payload.relPath).toBe('f2.txt');
        expect(r.payload.isDir).toBe(false);
    });

    test('TC-MSEL-05c 選択外の行を drag したらその 1 件だけ（選択は変えない）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f3.txt', { shift: true });    // f1..f3 を選択
        const r = await fireDragstart(page, 'f7.txt');       // 選択外
        expect(r.payload.relPath, '選択外 drag が選択集合を運んでいる').toBe('f7.txt');
        expect(r.payload.items).toBeUndefined();
        // 選択表示は変わらない
        expect(await selectedRels(page)).toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
    });

    test('TC-MSEL-07 選択にフォルダを含む → ファイルのみ載り除外件数が payload に出る', async ({ page }) => {
        await mountFv(page);
        // dirA(0) .. f2.txt(3) = dir 2 + file 2
        await clickRow(page, 'dirA');
        await clickRow(page, 'f2.txt', { shift: true });
        expect((await selectedRels(page)).length, '前提: 4 行選択（dir 2 + file 2）').toBe(4);

        const r = await fireDragstart(page, 'f1.txt');
        expect(r.payload.items.map((x: any) => x.relPath), 'フォルダが payload に載った')
            .toEqual(['f1.txt', 'f2.txt']);
        expect(r.payload.excludedDirs, '除外件数が payload に無い（集計通知に出せない）').toBe(2);
        expect(r.payload.items.every((x: any) => x.isDir === false), 'isDir:true が混入').toBe(true);
    });

    test('TC-MSEL-08 複数選択がフォルダのみ → preventDefault + 通知 1 回（無反応にしない）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'dirA');
        await clickRow(page, 'dirB', { shift: true });
        await page.evaluate(() => { (window as any).__calls.length = 0; });

        const r = await fireDragstart(page, 'dirA');
        expect(r.prevented, 'preventDefault されていない（drag が始まって無反応になる）').toBe(true);
        expect(r.types, 'フォルダのみなのに payload が積まれた').not.toContain(FV_MIME);

        const notices = await page.evaluate(() =>
            (window as any).__calls.filter((c: any) => c.type === 'notifyError'));
        expect(notices.length, `通知が 1 回でない（実際 ${notices.length} 回）`).toBe(1);
    });

    /**
     * 🔴 **単一フォルダ行の drag は従来どおり payload を積む**（回帰の番人）。
     *
     * **fv 内のフォルダ移動は既存機能**（ADRL-0102 / `onTreeDrop` の `fv.isDir` no-op ガードが受ける。
     * 本 sprint のスコープ外）。FR-MSEL-05 の「フォルダは D&D 対象外」を dragstart 全体に
     * 適用してしまうとこれを壊す（実装中に一度踏んで既存 TC-FLV-40 が RED になった）。
     */
    test('単一フォルダ行の drag は従来形式の payload を積む（fv 内フォルダ移動の回帰）', async ({ page }) => {
        await mountFv(page);
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        const r = await fireDragstart(page, 'dirA');   // 選択なしでフォルダ行を drag
        expect(r.prevented, 'フォルダ行の drag が preventDefault された（fv 内移動が不能になる）').toBe(false);
        expect(r.types, `フォルダ行で ${FV_MIME} が積まれていない`).toContain(FV_MIME);
        expect(r.payload, '従来形式（isDir:true）で積まれていない')
            .toEqual({ folderLinkId: 'fl1', relPath: 'dirA', isDir: true });
        const notices = await page.evaluate(() =>
            (window as any).__calls.filter((c: any) => c.type === 'notifyError'));
        expect(notices.length, '単一フォルダ drag で不要な通知が出た').toBe(0);
    });

    test('選択が 1 件だけのファイル行も従来形式（items 配列にしない）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f4.txt');
        const r = await fireDragstart(page, 'f4.txt');
        expect(r.payload.items, '1 件選択で items 配列になっている').toBeUndefined();
        expect(r.payload.relPath).toBe('f4.txt');
    });
});
