/**
 * note ファイルツリーのキーボード操作（↑↓ で移動 / Enter で決定）
 * sprint 20260906-024639-tree-keynav-opennew-modifier / FR-TKN-01..08 / NFR-TKN-01..03 / ADRL-0113
 *
 * TC-TKN-01..19。
 *
 * 設計（design/system.md §1）:
 *   - 行順配列は **2 本**（ADRL-0113）: `visibleItemIds`（選択・D&D の単一真実・不変）と
 *     ナビ専用 `navRowIds`（仮想フォルダのヘッダ行を含む）。走査根は `#notesFileList`（listEl）に限る。
 *   - focus ≡ selection（folder header に乗る場合のみ選択集合に入れない = FR-MSEL-05 優先）
 *   - ↑↓ は open 系を 1 つも呼ばない / Enter で kind 別に開く（既存経路の再利用）
 *
 * ★ DOM の実測（本 spec の前提）:
 *   `#notesFavoritesList` は `#notesFileList` の **兄弟**（notes-body-html.js:623 と :633）。
 *   検索結果 `#notesSearchResults` も別ペイン（`#filePanelContentSearch` 配下 / :637-646）。
 *   よって「listEl 起点で走査する」ことが Favorites / 検索結果を除外する実装上の根拠になる
 *   （TC-TKN-07 / TC-TKN-19 がその counterfactual）。
 *
 * TASK-01: fixture ヘルパ + スモーク。TASK-07: TC-TKN-01..19。
 */
import { test, expect, Page } from '@playwright/test';

/**
 * fixture（design/tdd.md E2E 後方追跡表 A-1）:
 *   ①5 行以上 ②仮想フォルダ 1 個（展開・中に item 2 個）③Favorites 1 件
 *   ④collapsed フォルダ 1 個 ⑤kind = md / .out / file / linkedfd の 4 種
 *
 * listEl の document 順（= 期待される navRowIds）:
 *   o1, m1, [folder:dir1], m3, m4, [folder:dirC], f1, fl1, m2
 *   （m5 は dirC が collapsed なので除外。Favorites の m1 複製は listEl 外なので入らない）
 */
export const STRUCTURE = {
    version: 1,
    rootIds: ['o1', 'm1', 'dir1', 'dirC', 'f1', 'fl1', 'm2'],
    favorites: ['m1'],
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1', ext: 'out' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md' },
        dir1: { type: 'folder', id: 'dir1', title: 'folder-open', childIds: ['m3', 'm4'], collapsed: false },
        m3: { type: 'file', id: 'm3', title: 'md3', ext: 'md' },
        m4: { type: 'file', id: 'm4', title: 'md4', ext: 'md' },
        dirC: { type: 'folder', id: 'dirC', title: 'folder-collapsed', childIds: ['m5'], collapsed: true },
        m5: { type: 'file', id: 'm5', title: 'md5', ext: 'md' },
        f1: { type: 'file', id: 'f1', title: 'file1', ext: 'file', filename: 'a.pdf' },
        fl1: { type: 'file', id: 'fl1', title: 'Docs', ext: 'folder' },
    },
};

export const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '/n/m3.md', title: 'md3', id: 'm3', kind: 'md' },
    { filePath: '/n/m4.md', title: 'md4', id: 'm4', kind: 'md' },
    { filePath: '/n/m5.md', title: 'md5', id: 'm5', kind: 'md' },
    { filePath: '', title: 'file1', id: 'f1', kind: 'file' },
    { filePath: '', title: 'Docs', id: 'fl1', kind: 'folder', broken: false },
];

/**
 * ハーネス（design/tdd.md）: `/standalone-notes.html` + `__testApi.initNotesPanel(...)`。
 * ハーネス bridge に無い 2 経路はここで spy を差す（bridge オブジェクトは init 後も同一参照で、
 * 呼び出しは `typeof bridge.x === 'function'` の遅延判定なので後付けでも効く）:
 *   - `openTreeFileExternal(id)`（file item の open。`__spy.attach` に記録）
 *   - `window.__folderViewDispatcher.showFolderView(id, title)`（linkedfd の open。`__spy.folderView`）
 */
export async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate(({ files, structure }) => {
        const w = window as any;
        w.__spy = { attach: [], folderView: [], scrollIntoView: [] };
        w.notesHostBridge.openTreeFileExternal = function (id: string) { w.__spy.attach.push(id); };
        w.__folderViewDispatcher = w.__folderViewDispatcher || {};
        w.__folderViewDispatcher.showFolderView = function (id: string, title: string) {
            w.__spy.folderView.push({ id, title });
        };
        w.__navFixtureFiles = files;
        w.__navFixtureStructure = structure;
        w.__testApi.initNotesPanel(files, '/n/o1.out', structure);
    }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item[data-file-id="fl1"]', { timeout: 5000 });
    await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
}

/** listEl 配下の「行」の document 順（file item は id / 仮想フォルダは `folder:<id>`）。 */
export function domRowOrder(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const list = document.getElementById('notesFileList') as HTMLElement;
        const rows = list.querySelectorAll('.file-panel-item, .file-panel-folder > .file-panel-folder-header');
        const out: string[] = [];
        rows.forEach((el) => {
            const e = el as HTMLElement;
            if (e.classList.contains('file-panel-folder-header')) {
                const w = e.parentElement as HTMLElement;
                if (w.closest('.file-panel-folder.collapsed') !== w && w.closest('.file-panel-folder.collapsed')) { return; }
                out.push('folder:' + (w.dataset.folderId || ''));
                return;
            }
            if (e.dataset.favSection === '1') { return; }
            if (e.closest('.file-panel-folder.collapsed')) { return; }
            out.push(e.dataset.fileId || '');
        });
        return out;
    });
}

test.describe('note ツリー keynav — fixture（TASK-01）', () => {
    test('fixture スモーク: A-1 の 5 条件を満たす形で描画される', async ({ page }) => {
        await setup(page);

        // ① 5 行以上（listEl 配下の可視行）
        const rows = await domRowOrder(page);
        expect(rows.length, 'listEl 配下の可視行が 5 行以上').toBeGreaterThanOrEqual(5);
        expect(rows, 'document 順（collapsed 配下 m5 は含まない）').toEqual(
            ['o1', 'm1', 'folder:dir1', 'm3', 'm4', 'folder:dirC', 'f1', 'fl1', 'm2']);

        // ② 展開フォルダ 1 個（中に item 2 個）
        const openFolder = await page.evaluate(() => {
            const w = document.querySelector('#notesFileList .file-panel-folder[data-folder-id="dir1"]') as HTMLElement;
            return {
                exists: !!w,
                collapsed: !!w && w.classList.contains('collapsed'),
                children: w ? w.querySelectorAll('.file-panel-folder-children > .file-panel-item').length : -1,
            };
        });
        expect(openFolder, '展開フォルダ + 子 2 件').toEqual({ exists: true, collapsed: false, children: 2 });

        // ④ collapsed フォルダ 1 個
        const collapsed = await page.evaluate(() => {
            const w = document.querySelector('#notesFileList .file-panel-folder[data-folder-id="dirC"]') as HTMLElement;
            return { exists: !!w, collapsed: !!w && w.classList.contains('collapsed') };
        });
        expect(collapsed, 'collapsed フォルダ').toEqual({ exists: true, collapsed: true });

        // ③ Favorites 1 件（★ listEl の外 = #notesFavoritesList。ナビ配列に混ざらないことの前提）
        const fav = await page.evaluate(() => {
            const favList = document.getElementById('notesFavoritesList') as HTMLElement;
            const list = document.getElementById('notesFileList') as HTMLElement;
            return {
                favRows: favList.querySelectorAll('.file-panel-item[data-fav-section="1"]').length,
                insideList: list.contains(favList),
                favInsideList: list.querySelectorAll('[data-fav-section="1"]').length,
            };
        });
        expect(fav, 'Favorites 1 件 かつ listEl の外').toEqual({ favRows: 1, insideList: false, favInsideList: 0 });

        // ⑤ kind 4 種（md / out / file / linkedfd）
        const kinds = await page.evaluate(() => {
            const list = document.getElementById('notesFileList') as HTMLElement;
            const seen: Record<string, number> = {};
            list.querySelectorAll('.file-panel-item').forEach((el) => {
                const k = (el as HTMLElement).dataset.fileExt || '(none)';
                seen[k] = (seen[k] || 0) + 1;
            });
            return seen;
        });
        expect(Object.keys(kinds).sort(), 'kind 4 種が揃う').toEqual(['file', 'folder', 'md', 'out']);

        // spy が差せている（TASK-07 の TC-TKN-09/10 が使う）
        const spyReady = await page.evaluate(() => {
            const w = window as any;
            return typeof w.notesHostBridge.openTreeFileExternal === 'function'
                && typeof w.__folderViewDispatcher.showFolderView === 'function';
        });
        expect(spyReady, 'file / linkedfd の open spy が差せている').toBe(true);
    });
});

/** 要素へ直接 keydown を dispatch する（実フォーカス依存を避ける確立パターン = folder-view-range-select.spec.ts:77-83）。 */
async function keydown(page: Page, key: string, opts?: { isComposing?: boolean; onInput?: boolean }): Promise<void> {
    await page.evaluate(({ k, o }) => {
        const list = document.getElementById('notesFileList') as HTMLElement;
        const target: HTMLElement = o?.onInput
            ? (document.querySelector('#notesFileList input') as HTMLElement) || list
            : list;
        const ev: any = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        if (o?.isComposing) { Object.defineProperty(ev, 'isComposing', { value: true }); }
        target.dispatchEvent(ev);
    }, { k: key, o: opts || {} });
}

function selectedRows(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const list = document.getElementById('notesFileList') as HTMLElement;
        const out: string[] = [];
        list.querySelectorAll('.file-panel-selected').forEach((el) => {
            const e = el as HTMLElement;
            if (e.classList.contains('file-panel-folder-header')) {
                out.push('folder:' + ((e.parentElement as HTMLElement).dataset.folderId || ''));
            } else {
                out.push(e.dataset.fileId || '');
            }
        });
        return out;
    });
}

function msgs(page: Page): Promise<any[]> {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
}
function spies(page: Page): Promise<any> {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__spy)));
}
async function clearAll(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as any;
        w.__testApi.notesMessages.length = 0;
        w.__spy.attach.length = 0;
        w.__spy.folderView.length = 0;
    });
}
async function clickRow(page: Page, id: string): Promise<void> {
    await page.evaluate((i) => {
        const el = document.querySelector(`#notesFileList .file-panel-item[data-file-id="${i}"]`) as HTMLElement;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }, id);
}

test.describe('note ツリー keynav — 移動（TASK-07 / FR-TKN-01..03）', () => {
    test('TC-TKN-01 ↓ で focus が 1 行下へ移り、open 系が 1 つも呼ばれない（右コンテンツ不変）', async ({ page }) => {
        await setup(page);
        await clickRow(page, 'm1');          // 起点（ここでは open される）
        await clearAll(page);
        await keydown(page, 'ArrowDown');
        // m1 の次は folder:dir1（ナビ配列は folder header を含む）
        expect(await selectedRows(page)).toEqual(['folder:dir1']);
        // ★ counterfactual: 移動で open 経路が動いていない
        const m = await msgs(page);
        const sp = await spies(page);
        expect(m.filter((x) => x.type === 'openFile').length, 'メインペイン差替が起きない').toBe(0);
        expect(m.filter((x) => x.type === 'toggleFolder').length, '展開トグルも起きない').toBe(0);
        expect(sp.attach.length, 'file の外部 open も起きない').toBe(0);
        expect(sp.folderView.length, 'フォルダビューも開かない').toBe(0);
        expect(m.length, 'bridge 呼び出しは 0 件（NFR-TKN-01: host 往復ゼロ）').toBe(0);
    });

    test('TC-TKN-02 focus 無しの ↓ は先頭行 / ↑ は末尾行から始まる', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');
        expect(await selectedRows(page), '先頭行 o1').toEqual(['o1']);
        await setup(page);
        await keydown(page, 'ArrowUp');
        expect(await selectedRows(page), '末尾行 m2').toEqual(['m2']);
    });

    test('TC-TKN-03 端で留まる（循環しない）', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');                 // o1
        await keydown(page, 'ArrowUp');                   // o1 のまま
        expect(await selectedRows(page)).toEqual(['o1']);
        for (let i = 0; i < 20; i++) { await keydown(page, 'ArrowDown'); }
        expect(await selectedRows(page), '末尾で留まる').toEqual(['m2']);
    });

    test('TC-TKN-04 複数選択中の ↓ は選択を 1 件に置き換える', async ({ page }) => {
        await setup(page);
        await clickRow(page, 'o1');
        await page.evaluate(() => {
            ['m1', 'f1'].forEach((i) => {
                const el = document.querySelector(`#notesFileList .file-panel-item[data-file-id="${i}"]`) as HTMLElement;
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
            });
        });
        expect((await selectedRows(page)).length, '3 件選択').toBe(3);
        await keydown(page, 'ArrowDown');
        expect((await selectedRows(page)).length, '1 件に置き換わる').toBe(1);
    });

    test('TC-TKN-05 仮想フォルダのヘッダ行を辿る（folder header → 子 item の順）', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');   // o1
        await keydown(page, 'ArrowDown');   // m1
        await keydown(page, 'ArrowDown');   // folder:dir1
        expect(await selectedRows(page)).toEqual(['folder:dir1']);
        await keydown(page, 'ArrowDown');   // m3（フォルダの子）
        expect(await selectedRows(page)).toEqual(['m3']);
    });

    test('TC-TKN-06 ↑↓ を繰り返しても visibleItemIds は不変 / navRowIds の部分列（ADRL-0113 の番人）', async ({ page }) => {
        await setup(page);
        const before = await domRowOrder(page);
        for (let i = 0; i < 10; i++) { await keydown(page, 'ArrowDown'); }
        for (let i = 0; i < 4; i++) { await keydown(page, 'ArrowUp'); }
        const after = await domRowOrder(page);
        expect(after, 'DOM の行順（= 両配列の素）が不変').toEqual(before);
        // 選択・D&D 用の配列（file item のみ）が folder 行を含んでいない
        const itemsOnly = after.filter((r) => r.indexOf('folder:') !== 0);
        expect(itemsOnly, 'visibleItemIds 相当は file item のみ')
            .toEqual(['o1', 'm1', 'm3', 'm4', 'f1', 'fl1', 'm2']);
        // 部分列関係（navRowIds ⊇ visibleItemIds）
        let k = 0;
        for (const r of after) { if (r === itemsOnly[k]) { k++; } }
        expect(k, 'visibleItemIds が navRowIds の部分列').toBe(itemsOnly.length);
    });

    test('TC-TKN-07 Favorites 行 / collapsed 配下には focus が止まらない', async ({ page }) => {
        await setup(page);
        const visited: string[] = [];
        for (let i = 0; i < 12; i++) {
            await keydown(page, 'ArrowDown');
            const sel = await selectedRows(page);
            if (sel[0]) { visited.push(sel[0]); }
        }
        // Favorites の m1 複製（listEl 外）や collapsed 配下の m5 は現れない
        expect(visited.filter((v) => v === 'm5').length, 'collapsed 配下は辿らない').toBe(0);
        const favFocused = await page.evaluate(() =>
            document.querySelectorAll('#notesFavoritesList .file-panel-selected').length);
        expect(favFocused, 'Favorites 行に選択が付かない').toBe(0);
    });

    test('TC-TKN-19 検索ペインの行はナビに混入しない（listEl 起点であることの counterfactual）', async ({ page }) => {
        await setup(page);
        // 検索ペインに「行」を注入（本番の検索結果と同じ .file-panel-item を別ペインに置く）
        await page.evaluate(() => {
            const res = document.getElementById('notesSearchResults') as HTMLElement;
            const row = document.createElement('div');
            row.className = 'file-panel-item';
            row.dataset.fileId = 'SEARCH-ROW';
            row.dataset.itemId = 'SEARCH-ROW';
            res.appendChild(row);
        });
        const visited: string[] = [];
        for (let i = 0; i < 12; i++) {
            await keydown(page, 'ArrowDown');
            const sel = await selectedRows(page);
            if (sel[0]) { visited.push(sel[0]); }
        }
        expect(visited.filter((v) => v === 'SEARCH-ROW').length, '検索結果行を辿らない').toBe(0);
        const searchSelected = await page.evaluate(() =>
            document.querySelectorAll('#notesSearchResults .file-panel-selected').length);
        expect(searchSelected).toBe(0);
    });
});

test.describe('note ツリー keynav — Enter（TASK-07 / FR-TKN-04）', () => {
    test('TC-TKN-08 md item で Enter → openFile が 1 回（右コンテンツが変わる）', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');   // o1
        await keydown(page, 'ArrowDown');   // m1
        await clearAll(page);
        await keydown(page, 'Enter');
        const m = await msgs(page);
        expect(m.filter((x) => x.type === 'openFile').length, 'Enter で 1 回開く').toBe(1);
        expect(m.filter((x) => x.type === 'openFile')[0].filePath).toBe('/n/m1.md');
    });

    test('TC-TKN-09 file item で Enter → 添付の外部 open（openFile は呼ばれない）', async ({ page }) => {
        await setup(page);
        // ★ click で到達すると click 自身が open し、`openAttachExternal` の 400ms 二重呼び出し dedup に
        //   掛かって Enter が無音になる（実装の既存仕様）。**キーボードだけで f1 まで降りる**（= ↑↓ は開かない証明も兼ねる）。
        for (let i = 0; i < 7; i++) { await keydown(page, 'ArrowDown'); }
        expect(await selectedRows(page), 'f1 に focus').toEqual(['f1']);
        await clearAll(page);
        await keydown(page, 'Enter');
        const sp = await spies(page);
        const m = await msgs(page);
        expect(sp.attach, 'openTreeFileExternal(id) が 1 回').toEqual(['f1']);
        expect(m.filter((x) => x.type === 'openFile').length, 'md 経路に流れていない').toBe(0);
    });

    test('TC-TKN-10 linkedfd 行で Enter → フォルダビューを開く', async ({ page }) => {
        await setup(page);
        await clickRow(page, 'fl1');
        await clearAll(page);
        await keydown(page, 'Enter');
        const sp = await spies(page);
        expect(sp.folderView.length, 'showFolderView が 1 回').toBe(1);
        expect(sp.folderView[0].id).toBe('fl1');
    });

    test('TC-TKN-11 folder header で Enter → toggleFolder が呼ばれる（2 回で展開↔折りたたみ）', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');   // o1
        await keydown(page, 'ArrowDown');   // m1
        await keydown(page, 'ArrowDown');   // folder:dir1
        await clearAll(page);
        await keydown(page, 'Enter');
        await keydown(page, 'Enter');
        const m = await msgs(page);
        const toggles = m.filter((x) => x.type === 'toggleFolder');
        expect(toggles.length, 'toggleFolder が 2 回').toBe(2);
        expect(toggles[0].folderId).toBe('dir1');
    });

    test('TC-TKN-12 IME 変換中の Enter では開かない', async ({ page }) => {
        await setup(page);
        // click で開くと openItemFile の currentFile ガードで 2 回目が抑止されるため、キーボードで到達する
        await keydown(page, 'ArrowDown');   // o1
        await keydown(page, 'ArrowDown');   // m1
        await clearAll(page);
        await keydown(page, 'Enter', { isComposing: true });
        const m = await msgs(page);
        expect(m.filter((x) => x.type === 'openFile').length, 'IME 中は open しない').toBe(0);
        // ★ counterfactual: ガードを外すと 1 回開く
        await keydown(page, 'Enter');
        expect((await msgs(page)).filter((x) => x.type === 'openFile').length, '通常 Enter なら開く').toBe(1);
    });

    test('TC-TKN-13 Enter → host 応答 → ↓ → Enter で 2 件目が開く（refocus がイベント駆動で効く）', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');   // o1
        await keydown(page, 'ArrowDown');   // m1
        await clearAll(page);
        await keydown(page, 'Enter');       // m1 を開く
        // 開いた先がフォーカスを奪う実機挙動を再現してから host 応答を流す
        await page.evaluate(() => {
            const other = document.querySelector('.markdown-container') as HTMLElement || document.body;
            other.setAttribute('tabindex', '0');
            other.focus();
            (window as any).__testApi.emitUpdateData(1, { kind: 'md', filePath: '/n/m1.md' });
        });
        await keydown(page, 'ArrowDown');   // folder:dir1 へ（focus がツリーに戻っていないと選択が動かない）
        expect(await selectedRows(page), '応答後も ↑↓ が効く').toEqual(['folder:dir1']);
        const focused = await page.evaluate(() => document.activeElement?.id || '');
        expect(focused, 'フォーカスがツリーに戻っている').toBe('notesFileList');
    });

    test('TC-TKN-14 rename 入力欄が起点の ↑↓ ではツリーの選択が動かない', async ({ page }) => {
        await setup(page);
        await clickRow(page, 'm1');
        const before = await selectedRows(page);
        // rename 入力を開く（dblclick）
        await page.evaluate(() => {
            const el = document.querySelector('#notesFileList .file-panel-item[data-file-id="m1"]') as HTMLElement;
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        });
        await page.waitForSelector('#notesFileList input', { timeout: 3000 });
        await keydown(page, 'ArrowDown', { onInput: true });
        expect(await selectedRows(page), '入力欄では nav が動かない').toEqual(before);
    });

    test('TC-TKN-18 focus 行が消えて再描画されても例外にならず先頭から再開できる', async ({ page }) => {
        await setup(page);
        await clickRow(page, 'm2');    // 末尾に focus
        // 外部削除相当: m2 を抜いた structure で再 init（renderTree が走り focus 行が消える）
        await page.evaluate(() => {
            const w = window as any;
            const files = (w.__navFixtureFiles || []).filter((f: any) => f.id !== 'm2');
            const st = w.__navFixtureStructure;
            const st2 = JSON.parse(JSON.stringify(st));
            st2.rootIds = st2.rootIds.filter((r: string) => r !== 'm2');
            delete st2.items.m2;
            w.__testApi.initNotesPanel(files, '/n/o1.out', st2);
        });
        await keydown(page, 'ArrowDown');
        const sel = await selectedRows(page);
        expect(sel.length, '例外なく focus が復帰する').toBe(1);
        expect(sel[0], '先頭行から再開').toBe('o1');
    });
});

test.describe('note ツリー keynav — reveal / 実装規律（TASK-07 / FR-TKN-05 / NFR-TKN-02）', () => {
    test('TC-TKN-16 表示範囲外へ移動すると scrollIntoView({block:"nearest"}) が呼ばれる', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            const w = window as any;
            w.__spy.scrollIntoView = [];
            const orig = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function (arg: any) {
                w.__spy.scrollIntoView.push(arg);
                return orig.call(this, arg);
            };
        });
        await keydown(page, 'ArrowDown');
        const sp = await spies(page);
        expect(sp.scrollIntoView.length, 'focus 移動で reveal が走る').toBeGreaterThanOrEqual(1);
        expect(sp.scrollIntoView[0], 'block は nearest（画面が跳ねない）').toEqual({ block: 'nearest' });
    });

    test('TC-TKN-17 可視範囲内の移動ではスクロール位置が変わらない', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');
        const before = await page.evaluate(() => (document.getElementById('notesFileList') as HTMLElement).scrollTop);
        await keydown(page, 'ArrowDown');
        const after = await page.evaluate(() => (document.getElementById('notesFileList') as HTMLElement).scrollTop);
        expect(after, 'scrollTop 不変').toBe(before);
    });

    test('TC-TKN-15 実装に固定 setTimeout を使っていない（NFR-TKN-02）', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs2 = require('fs');
        const src: string = fs2.readFileSync(
            require('path').join(__dirname, '../../src/shared/notes-file-panel.js'), 'utf8');
        const navBlock = src.slice(src.indexOf('function rebuildNavRowIds'), src.indexOf('function openFolderView'));
        expect(navBlock.length, 'ナビ実装ブロックが取れている').toBeGreaterThan(500);
        expect(navBlock.includes('setTimeout('), 'ナビ実装に固定 timer が無い').toBe(false);
    });
});

/**
 * ユーザー裁定 2026-09-06（手動検収 A の 2 件）:
 *   ①キーボード移動を始めるとツリー領域に**青枠**（ブラウザ既定の focus ring）が出る → 不要
 *   ②↑↓ で**フォルダ行だけ選択色にならない**（クラスは付くが CSS が item 限定だった）
 * どちらも「見た目」の契約なので **computed style を実測**して pin する（クラス名の pin では ② を検出できない）。
 */
test.describe('note ツリー keynav — 見た目（FR-TKN-01 rev / FR-TKN-06 rev）', () => {
    test('TC-TKN-20 ツリーにフォーカスしても focus ring（青枠）が出ない', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');
        const r = await page.evaluate(() => {
            const list = document.getElementById('notesFileList') as HTMLElement;
            list.focus();
            const cs = getComputedStyle(list);
            return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, active: document.activeElement?.id };
        });
        expect(r.active, '前提: ツリーがフォーカスを持っている').toBe('notesFileList');
        // ★ counterfactual: `outline: none` を外すと 'auto' / '1px' が返って RED（実測値）
        expect(r.outlineStyle, 'focus ring が出ていない').toBe('none');
    });

    test('TC-TKN-21 フォルダ行が focus のとき item と同じ選択色になる', async ({ page }) => {
        await setup(page);
        await keydown(page, 'ArrowDown');   // o1（item）
        // ★ パネルは `transition: background-color 0.15s` を持つので、**着地を条件待ち**してから色を読む
        //   （即読みすると補間中の transparent を拾って偽陰性/偽陽性になる）
        const settled = (sel: string) => page.waitForFunction((s) => {
            const el = document.querySelector(s) as HTMLElement;
            return !!el && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)';
        }, sel, { timeout: 3000 });
        await settled('#notesFileList .file-panel-item[data-file-id="o1"]');
        const itemBg = await page.evaluate(() => getComputedStyle(
            document.querySelector('#notesFileList .file-panel-item[data-file-id="o1"]') as HTMLElement).backgroundColor);
        await keydown(page, 'ArrowDown');   // m1
        await keydown(page, 'ArrowDown');   // folder:dir1
        expect(await selectedRows(page), '前提: folder:dir1 が focus').toEqual(['folder:dir1']);
        await settled('#notesFileList .file-panel-folder[data-folder-id="dir1"] > .file-panel-folder-header');
        const r = await page.evaluate(() => {
            const focused = document.querySelector(
                '#notesFileList .file-panel-folder[data-folder-id="dir1"] > .file-panel-folder-header') as HTMLElement;
            const other = document.querySelector(
                '#notesFileList .file-panel-folder[data-folder-id="dirC"] > .file-panel-folder-header') as HTMLElement;
            return {
                focusedBg: getComputedStyle(focused).backgroundColor,
                otherBg: getComputedStyle(other).backgroundColor,
                hasClass: focused.classList.contains('file-panel-selected'),
            };
        });
        expect(r.hasClass, 'クラスが付いている').toBe(true);
        // ★ ここが本命: クラスだけでなく**実際に色が変わる**こと（旧実装は透明のままだった）
        expect(r.focusedBg, 'focus 中のフォルダ行が透明ではない').not.toBe('rgba(0, 0, 0, 0)');
        expect(r.focusedBg, '非 focus のフォルダ行とは違う色').not.toBe(r.otherBg);
        expect(r.focusedBg, 'item の選択色と同一の変数を使っている').toBe(itemBg);
    });

    test('TC-TKN-21b フォルダ行から離れると選択色が消える', async ({ page }) => {
        await setup(page);
        for (let i = 0; i < 3; i++) { await keydown(page, 'ArrowDown'); }   // folder:dir1
        await keydown(page, 'ArrowDown');                                   // m3（folder から離れる）
        await page.waitForFunction(() => {
            const fh = document.querySelector(
                '#notesFileList .file-panel-folder[data-folder-id="dir1"] > .file-panel-folder-header') as HTMLElement;
            return !!fh && getComputedStyle(fh).backgroundColor === 'rgba(0, 0, 0, 0)';
        }, undefined, { timeout: 3000 });
        const r = await page.evaluate(() => {
            const fh = document.querySelector(
                '#notesFileList .file-panel-folder[data-folder-id="dir1"] > .file-panel-folder-header') as HTMLElement;
            return { hasClass: fh.classList.contains('file-panel-selected'), bg: getComputedStyle(fh).backgroundColor };
        });
        expect(r.hasClass, 'クラスが外れる').toBe(false);
        expect(r.bg, '色も戻る').toBe('rgba(0, 0, 0, 0)');
    });
});
