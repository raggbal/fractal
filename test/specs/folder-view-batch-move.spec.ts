/**
 * linkedfd 内一括移動（FR-FMV-01..04 / FR-MSEL-02/04 rev5 / DOM-LinkedfdBatchMoveContext）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove
 *
 * ## 修正前の実測（TASK-02 probe / TC-FMV-00）
 * | ケース | dragstart payload | host 呼び出し |
 * |---|---|---|
 * | 3 file 選択 → **選択内**を掴んで folder に drop | `{v:1, items:[3 件]}` | **folderViewMove 0 回** + `notifyError` 1 回 |
 * | 3 file 選択 → **選択外**を掴んで drop | 単一形式 | `folderViewMove` 1 回（既存契約・正常） |
 *
 * 原因: `notes-folder-view.js` の W1 ゲート `if (fv && fv.relPath !== undefined)` が**単数 payload 前提**で、
 * 複数 payload（top-level `relPath` を持たない）を素通りさせ不受理通知に落ちていた。
 * 全件は `fvDragSrc.relPaths` に既にあり `void src;` で捨てられていた。
 *
 * ハーネスは既存 `folder-view-range-select.spec.ts` の `mountFv` と同型（fv を単体マウント +
 * Proxy host bridge で**全呼び出しを記録**）。bridge 呼び出し回数と通知回数を直接観測できる。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');
const BATCH_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/batch-payload.js'), 'utf8');

/** root に file 4 + dir 2（`docs` / `p`）、`p/` に 1 file、`p/q/` を持つ fv */
async function mountFv(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:20px;}</style></head><body>'
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
            { name: 'docs', relPath: 'docs', isDir: true },
            { name: 'p', relPath: 'p', isDir: true },
        ];
        for (let i = 1; i <= 4; i++) { entries.push({ name: `f${i}.txt`, relPath: `f${i}.txt`, isDir: false }); }
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}

const clickRow = (page: Page, rel: string, mods: { shift?: boolean; meta?: boolean } = {}) =>
    page.locator(`.fv-row[data-rel="${rel}"]`).click({
        modifiers: [...(mods.shift ? ['Shift' as const] : []), ...(mods.meta ? ['Meta' as const] : [])],
    });

const api = (page: Page) => page.evaluate(() => {
    const fv = (window as any).__folderView;
    return { hasPreflight: typeof fv?.fvMovePreflight === 'function' };
});

/**
 * dragstart だけを発火して **本番が DataTransfer に載せた payload** を読む（TASK-24）。
 *
 * 移動対象の解決規則（掴んだ行が選択に含まれるか / フォルダ除外 / 描画順）は
 * `notes-folder-view.js` の dragstart handler が payload を組む時点で適用される。
 * drop 側（W1）はその payload を `extractBatchItems` で読むだけなので、
 * **payload が解決結果の単一真実**。ここを見るのが本番経路の観測になる。
 */
async function dragstartPayload(page: Page, grab: string) {
    return page.evaluate((g) => {
        const src = document.querySelector(`.fv-row[data-rel="${g}"]`) as HTMLElement;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const raw = dt.getData('application/x-fractal-folderview-entry');
        return raw ? JSON.parse(raw) : null;
    }, grab);
}

/**
 * TASK-24（reviewer iteration 1 DET-5 / QUAL-5）: 旧実装は `fvMoveIds` を `window.__folderView` に
 * 公開して spec から直叩きしていたが、**本番の drop 経路は `fvMoveIds` を一度も呼んでいなかった**
 * （`grep -n "fvMoveIds(" src/shared/notes-folder-view.js` のヒットが定義行だけ）。
 * 解決規則は dragstart handler が payload を組む時点で既に適用済みで、`fvMoveIds` はその規則の
 * **二重実装**だった（設計が禁じる「規則を複製しない」に反する）。関数を削除し、この describe は
 * **本番が DataTransfer に載せた payload** を観測する形に張り替えた。
 */
test.describe('FR-FMV-01/03 移動対象の解決（dragstart payload = 単一真実）', () => {
    /**
     * 🔄 **期待反転**（sprint 20260910-053026 / TASK-14 / ADRL-0122 = test_update）
     *
     * 旧期待: 「フォルダは D&D 対象から除かれ、除外件数が分かる」。
     * 却下理由として「HTML DataTransfer にディレクトリを載せられない既存制約」が書かれていたが、
     * これは **OS からファイルを投入する channel 限定の制約**で、`setData(customMime, JSON)` に
     * 識別子を載せる本経路には掛からない（本番の単一フォルダ drag が反例）。
     * ADRL-0122 で裁定が覆り、フォルダは識別子として payload に載る（FR-FDP-01）。
     */
    test('TC-FMV-04 フォルダも D&D payload に載る（ADRL-0122 で反転）', async ({ page }) => {
        await mountFv(page);
        // 2 file + 1 folder を選択（フォルダは選択集合に入る）
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f2.txt', { meta: true });
        await clickRow(page, 'docs', { meta: true });
        const p = await dragstartPayload(page, 'f1.txt');
        expect(p, 'dragstart payload が載っていない').toBeTruthy();
        expect((p.items || []).map((it: any) => it.relPath).sort(),
            'フォルダが payload から除かれた（ADRL-0122 に反する）')
            .toEqual(['docs', 'f1.txt', 'f2.txt']);
        // isDir は実値（面を越える経路では payload が唯一の情報源）
        const byRel: Record<string, boolean> = {};
        for (const it of (p.items || [])) { byRel[it.relPath] = it.isDir; }
        expect(byRel['docs'], 'フォルダの isDir が実値でない').toBe(true);
        expect(byRel['f1.txt']).toBe(false);
        // 除外件数は「受け手が扱えない種別」用に残る（フォルダは通るので 0）
        expect(p.excludedDirs).toBe(0);
    });

    test('TC-FMV-04b 掴んだ行が選択に含まれるなら選択集合・含まれないなら 1 件（FR-OMV-01 と同一意味論）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f2.txt', { meta: true });
        await clickRow(page, 'f3.txt', { meta: true });
        const inSel = await dragstartPayload(page, 'f2.txt');
        expect((inSel.items || []).map((it: any) => it.relPath),
            '選択内を掴んだのに選択集合が payload に載らない').toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
        const outSel = await dragstartPayload(page, 'f4.txt');
        // 選択外は **従来の単数形式**（items を持たず top-level relPath）= §4-1 後方互換
        expect(outSel.items, '選択外を掴んだのに複数形式 payload になった（既存契約が変わる）').toBeUndefined();
        expect(outSel.relPath, '選択外を掴んだのにその 1 件が payload に載らない').toBe('f4.txt');
    });

    test('TC-FMV-04c 順序は既存 visibleRows（描画順）が単一真実', async ({ page }) => {
        await mountFv(page);
        // 逆順に選択しても描画順で返る（新規の順序計算を書いていない証拠）。
        // ⚠️ linkedfd の修飾なし click は **単一選択**（outliner の「クリア」とは意味が違う）。
        await clickRow(page, 'f3.txt');                       // = ['f3.txt']
        await clickRow(page, 'f1.txt', { meta: true });       // + f1
        await clickRow(page, 'f2.txt', { meta: true });       // + f2
        const p = await dragstartPayload(page, 'f1.txt');
        expect((p.items || []).map((it: any) => it.relPath),
            '選択順ではなく描画順で載っていない').toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
    });
});

test.describe('FR-FMV-02 fvMovePreflight — 全体拒否（INV-4）', () => {
    test('TC-FMV-05 移動先 = 既に同じ親 が混ざったら全体拒否', async ({ page }) => {
        await mountFv(page);
        expect((await api(page)).hasPreflight, '`__folderView.fvMovePreflight` が公開されていない（関数名 pin）').toBe(true);
        // f1..f3 は root 直下。dst='' （root）は「既に同じ親」なので全体拒否
        const r = await page.evaluate(() => (window as any).__folderView.fvMovePreflight(['f1.txt', 'f2.txt', 'f3.txt'], ''));
        expect(r.ok, '既に同じ親への移動が混ざっているのに許可された（no-op を実行しようとする）').toBe(false);
        expect(r.reason, '拒否理由が返らない（通知に出せない）').toBeTruthy();
    });

    test('TC-FMV-05b 1 件でも不正なら全体拒否（per-item 除外にしない = fs は部分適用を巻き戻せない）', async ({ page }) => {
        await mountFv(page);
        // docs 配下へ f1/f2 を移すのは正当。だが f1 自身が dst の場合は不正
        const okAll = await page.evaluate(() => (window as any).__folderView.fvMovePreflight(['f1.txt', 'f2.txt'], 'docs'));
        expect(okAll.ok, '全件正当なのに拒否された').toBe(true);
        const mixed = await page.evaluate(() => (window as any).__folderView.fvMovePreflight(['f1.txt', 'docs'], 'docs'));
        expect(mixed.ok, '1 件が「移動先 = 自分自身」なのに許可された（部分適用が起きる）').toBe(false);
    });

    test('TC-FMV-06 フォルダの自己子孫への移動は全体拒否', async ({ page }) => {
        await mountFv(page);
        const r = await page.evaluate(() => (window as any).__folderView.fvMovePreflight(['p'], 'p/q'));
        expect(r.ok, 'フォルダを自分の子孫へ移動できてしまう（fs が壊れる）').toBe(false);
        const r2 = await page.evaluate(() => (window as any).__folderView.fvMovePreflight(['p'], 'p'));
        expect(r2.ok, 'フォルダを自分自身へ移動できてしまう').toBe(false);
        // 兄弟フォルダへの移動は正当
        const r3 = await page.evaluate(() => (window as any).__folderView.fvMovePreflight(['p'], 'docs'));
        expect(r3.ok, '兄弟フォルダへの移動が拒否された（拒否が効きすぎている）').toBe(true);
    });
});

// ───────────── W1 の drop 経路（FR-FMV-01/02/03 / NFR-FMV-01 / DOM-FvMoveDispatch） ─────────────

/** dragstart(grab) → dragover → drop(target) を同一 DataTransfer で通し、host 呼び出しを返す */
async function dragAndDrop(page: Page, grab: string, target: string) {
    return page.evaluate(({ g, t }) => {
        const w = window as any;
        w.__calls.length = 0;
        const src = document.querySelector(`.fv-row[data-rel="${g}"]`) as HTMLElement;
        const dstRow = document.querySelector(`.fv-row[data-rel="${t}"]`) as HTMLElement;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dstRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dstRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return w.__calls.slice();
    }, { g: grab, t: target });
}
const only = (calls: any[], type: string) => calls.filter((c) => c.type === type);

test.describe('FR-FMV-01 W1 の drop で複数選択の全件が移動する', () => {
    test('TC-FMV-01 3 件選択 → 選択内を掴んで folder に drop → 全件が batch 1 回で渡る', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f2.txt', { meta: true });
        await clickRow(page, 'f3.txt', { meta: true });
        const calls = await dragAndDrop(page, 'f2.txt', 'docs');

        // ★ counterfactual（TASK-02 probe の実測値）: **修正前はここが
        //    folderViewMove 0 回 + notifyError 1 回**（複数 payload が W1 の単数ゲートを素通りして
        //    不受理通知に落ちていた）。「1 件だけ移動」ではない。
        expect(only(calls, 'notifyError'), '不受理通知に落ちている（W1 のゲートが単数 payload 前提のまま）').toEqual([]);
        const batch = only(calls, 'folderViewMoveBatch');
        expect(batch.length, 'folderViewMoveBatch が 1 回で呼ばれていない').toBe(1);
        expect(batch[0].args[1], '3 件すべてが渡っていない（表示順）').toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
        expect(batch[0].args[2], 'drop 先ディレクトリが渡っていない').toBe('docs');
        expect(batch[0].args[3], "mode が 'move' で渡っていない（D&D は移動）").toBe('move');
        expect(only(calls, 'folderViewMove').length, '単数 bridge も呼ばれている（二重実行）').toBe(0);
    });

    test('TC-FMV-02 選択外を掴んだら 1 件だけ（既存契約・byte 不変）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f2.txt', { meta: true });
        await clickRow(page, 'f3.txt', { meta: true });
        const calls = await dragAndDrop(page, 'f4.txt', 'docs');
        const single = only(calls, 'folderViewMove');
        expect(single.length, '選択外 drag で単数 bridge が呼ばれていない').toBe(1);
        expect(single[0].args.slice(0, 3), '選択外の 1 件以外が渡っている').toEqual(['fl1', 'f4.txt', 'docs']);
        expect(only(calls, 'folderViewMoveBatch').length, '1 件なのに batch を呼んでいる（既存契約が変わる）').toBe(0);
    });

    test('TC-FMV-03 選択 0 件の単一 drag は既存の単数 bridge を通る', async ({ page }) => {
        await mountFv(page);
        const calls = await dragAndDrop(page, 'f1.txt', 'docs');
        expect(only(calls, 'folderViewMove').length, '選択 0 件の単一 drag が単数 bridge を通らない').toBe(1);
        expect(only(calls, 'folderViewMoveBatch').length).toBe(0);
    });

    test('TC-FMV-07 全件正当なら全件が渡る / TC-FMV-08 bridge は配列 1 回（SEC-1）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        for (const r of ['f2.txt', 'f3.txt', 'f4.txt']) { await clickRow(page, r, { meta: true }); }
        const calls = await dragAndDrop(page, 'f1.txt', 'docs');
        const batch = only(calls, 'folderViewMoveBatch');
        expect(batch.length, 'bridge が 1 回で呼ばれていない（N 回呼ぶと host の件数ゲートを構造的に迂回する）').toBe(1);
        expect(batch[0].args[1].length, '4 件すべてが 1 回の配列で渡っていない').toBe(4);
    });

    test('TC-FMV-05c 1 件でも不正なら drop 全体を拒否（0 件処理）', async ({ page }) => {
        await mountFv(page);
        // f1..f3 は root 直下 → root（余白）への drop は「既に同じ親」なので全体拒否
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f2.txt', { meta: true });
        await clickRow(page, 'f3.txt', { meta: true });
        const calls = await page.evaluate(() => {
            const w = window as any;
            w.__calls.length = 0;
            const src = document.querySelector('.fv-row[data-rel="f2.txt"]') as HTMLElement;
            const tree = document.querySelector('.fv-tree, [class*="fv-"]')!.parentElement as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            // 余白（行の外）に drop → resolveDropDst は root('') を返す
            const host = document.querySelector('#outlinerContainer')!.parentElement as HTMLElement;
            void host; void tree;
            const treeEl = (document.querySelector('.fv-row') as HTMLElement).parentElement as HTMLElement;
            treeEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
            treeEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return w.__calls.slice();
        });
        expect(only(calls, 'folderViewMoveBatch').length, '全体拒否のはずが batch を呼んでいる（部分適用が起きる）').toBe(0);
        expect(only(calls, 'folderViewMove').length, '全体拒否のはずが単数 bridge を呼んでいる').toBe(0);
        // 「既に同じ親」= 純粋な no-op。**既存の単一経路は無通知 return** なので、
        // 複数でもトーストを増やさない（毎回の誤操作でトーストが出るのは UX 回帰）。
        // 通知するのは self / descendant（fs が壊れる操作）だけ = TC-FMV-06b。
        expect(only(calls, 'notifyError').length, '純 no-op でトーストを出している（既存の単一経路は無通知）').toBe(0);
    });

    test('TC-FMV-06b フォルダを自己子孫へ drop したら全体拒否 + 通知 1 回', async ({ page }) => {
        await mountFv(page);
        // `p` を選択して `p` 自身に drop（自己）→ fs が壊れる操作なので通知する
        await clickRow(page, 'p');
        const calls = await dragAndDrop(page, 'p', 'p');
        expect(only(calls, 'folderViewMove').length, '自己への移動が実行された').toBe(0);
        expect(only(calls, 'folderViewMoveBatch').length).toBe(0);
        expect(only(calls, 'notifyError').length, '自己への移動で理由が通知されない').toBe(1);
    });
});

/**
 * TC-FMV-16（TASK-24 / DET-5 の番人）: 移動対象の解決規則が **1 箇所** にしかないこと。
 *
 * iteration 1 は `fvMoveIds` を公開して spec が直叩きしていたが、本番の drop 経路は
 * dragstart payload（`extractBatchItems`）から解決しており `fvMoveIds` を一度も呼んでいなかった。
 * 「規則の二重実装 + 本番未配線」を構造的に禁じる。
 */
test.describe('TC-FMV-16 移動対象の解決規則は 1 箇所（二重実装を作らない）', () => {
    test('__folderView に解決関数を再公開していない', async ({ page }) => {
        await mountFv(page);
        const exposed = await page.evaluate(() => Object.keys((window as any).__folderView || {}));
        expect(exposed.includes('fvMoveIds'),
            '`fvMoveIds` が再公開されている（dragstart payload と規則が二重化し、'
            + '本番が payload 側を使う限りこちらは dead seam になる）').toBe(false);
        // 判断ロジックとして残す純関数は preflight だけ（W1 の drop からのみ呼ばれる）
        expect(exposed.includes('fvMovePreflight'), '`fvMovePreflight` の公開が失われた').toBe(true);
    });

    test('drop の移動件数は dragstart payload と一致する（解決は payload が単一真実）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f2.txt', { meta: true });
        await clickRow(page, 'f3.txt', { meta: true });

        const p = await dragstartPayload(page, 'f2.txt');
        const fromPayload = (p.items || []).map((it: any) => it.relPath);

        const calls = await dragAndDrop(page, 'f2.txt', 'docs');
        const batch = only(calls, 'folderViewMoveBatch');
        expect(batch.length, 'batch 呼び出しが 1 回でない').toBe(1);
        expect(batch[0].args[1],
            'drop が payload と違う集合を渡している（= どこかに 2 つ目の解決規則がある）')
            .toEqual(fromPayload);
    });
});
