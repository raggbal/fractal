/**
 * TASK-11 — note ファイルツリーの連続範囲選択（新設）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MSEL-03/05 / NFR-MSEL-01 / ADRL-0108）
 *
 * TC-MSEL-09..12。
 *
 * 設計（design/system.md §3-1/§3-2）:
 *   - note ツリーには選択の概念が**無かった**（`currentFile` は「開いている」の意）
 *   - **描画順配列も存在しなかった**ので `renderIds` の走行中に `visibleItemIds` へ記録する
 *     （可視性ルールを再実装しない — 描画された順 = 可視順が定義）
 *   - **Favorites セクションは記録しない**（同一 id が 2 回入ると区間計算が壊れる）
 *   - click は**従来どおり開く** / cmd/ctrl+click は単品トグル（rev2 2026-09-04・旧 FR-CT-01 は右クリックへ）
 */
import { test, expect, Page } from '@playwright/test';

const STRUCTURE = {
    version: 1,
    rootIds: ['o1', 'm1', 'dir1', 'm2', 'm3', 'f1'],   // dir1 を範囲の内側に置く（TC-MSEL-12b の要）
    items: {
        o1: { type: 'file', id: 'o1', title: 'out1' },
        m1: { type: 'file', id: 'm1', title: 'md1', ext: 'md' },
        m2: { type: 'file', id: 'm2', title: 'md2', ext: 'md' },
        m3: { type: 'file', id: 'm3', title: 'md3', ext: 'md' },
        f1: { type: 'file', id: 'f1', title: 'file1', ext: 'file', filename: 'a.pdf' },
        dir1: { type: 'folder', id: 'dir1', title: 'folder1', childIds: ['m4'], collapsed: true },
        m4: { type: 'file', id: 'm4', title: 'md4', ext: 'md' },
    },
};
const FILES = [
    { filePath: '/n/o1.out', title: 'out1', id: 'o1', kind: 'out' },
    { filePath: '/n/m1.md', title: 'md1', id: 'm1', kind: 'md' },
    { filePath: '/n/m2.md', title: 'md2', id: 'm2', kind: 'md' },
    { filePath: '/n/m3.md', title: 'md3', id: 'm3', kind: 'md' },
    { filePath: '', title: 'file1', id: 'f1', kind: 'file' },
    { filePath: '/n/m4.md', title: 'md4', id: 'm4', kind: 'md' },
];

async function setup(page: Page, opts?: { favorites?: string[] }): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    // favorites は structure.favorites が単一真実（renderFavoritesSection が読む）
    const structure = opts?.favorites
        ? Object.assign({}, STRUCTURE, { favorites: opts.favorites })
        : STRUCTURE;
    await page.evaluate(({ files, structure: st }) => {
        (window as any).__testApi.initNotesPanel(files, '/n/o1.out', st);
    }, { files: FILES, structure });
    await page.waitForSelector('.file-panel-item', { timeout: 5000 });
}

function selectedIds(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.file-panel-item.file-panel-selected'))
            .map((el) => (el as HTMLElement).dataset.fileId || ''));
}

/**
 * host へ送られた notes message を取る（ハーネスは notesMessages に記録する）。
 * `.active` は host 応答（currentFile）で決まるためハーネスでは更新されない —
 * 「開いた」の検証は bridge 呼び出しの実測で行う。
 */
function messages(page: Page): Promise<any[]> {
    return page.evaluate(() => (window as any).__testApi.notesMessages.slice());
}

async function clearMessages(page: Page): Promise<void> {
    await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
}

async function clickItem(page: Page, id: string, mods?: { shift?: boolean; meta?: boolean }): Promise<void> {
    await page.evaluate(({ i, m }) => {
        const el = document.querySelector(`.file-panel-item[data-file-id="${i}"]`) as HTMLElement;
        if (!el) { throw new Error('item が無い: ' + i); }
        el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
            shiftKey: !!m?.shift, metaKey: !!m?.meta, ctrlKey: !!m?.meta,
        }));
    }, { i: id, m: mods || {} });
}

test.describe('note ツリーの連続範囲選択（FR-MSEL-03）', () => {
    test('TC-MSEL-09 修飾なし click は従来どおり開き、選択も 1 件になる', async ({ page }) => {
        await setup(page);
        await clearMessages(page);

        await clickItem(page, 'm1');
        expect(await selectedIds(page), 'click で選択 1 件').toEqual(['m1']);
        // 従来挙動（開く）が壊れていない: openFile が 1 回飛ぶ
        await page.waitForTimeout(150);
        const msgs = await messages(page);
        expect(msgs.filter((m) => m.type === 'openFile').length,
            'click で openFile が飛んでいない（従来挙動の回帰）').toBe(1);
    });

    test('TC-MSEL-10 shift+click で範囲選択され、ファイルは開かない', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clearMessages(page);

        await clickItem(page, 'f1', { shift: true });
        // 可視の描画順（o1, m1, m2, m3, f1 — 折りたたみ配下の m4 は除く）の m1..f1 = 4 件
        expect(await selectedIds(page)).toEqual(['m1', 'm2', 'm3', 'f1']);
        // shift+click では開かない（openFile も openAttachExternal も飛ばない）
        await page.waitForTimeout(150);
        const msgs = await messages(page);
        expect(msgs.filter((m) => m.type === 'openFile' || m.type === 'openAttachExternal').length,
            'shift+click でファイルが開かれた').toBe(0);
    });

    test('TC-MSEL-10b shift+click は anchor を跨いで反対側へも伸びる', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm3');
        await clickItem(page, 'o1', { shift: true });
        expect(await selectedIds(page)).toEqual(['o1', 'm1', 'm2', 'm3']);
    });

    test('TC-MSEL-10c 範囲確定後にテキスト範囲が残っていない（NFR-MSEL-01）', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await page.evaluate(() => {
            const el = document.querySelector('.file-panel-item[data-file-id="m2"]') as HTMLElement;
            const r = document.createRange(); r.selectNodeContents(el);
            const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
        });
        expect(await page.evaluate(() => window.getSelection()!.rangeCount)).toBeGreaterThan(0);
        await clickItem(page, 'm3', { shift: true });
        expect(await page.evaluate(() => window.getSelection()!.rangeCount),
            'removeAllRanges() が呼ばれていない').toBe(0);
    });

    test('TC-MSEL-11 (rev2 2026-09-04) cmd/ctrl+click は単品トグル選択（開かない）', async ({ page }) => {
        // ユーザー裁定 2026-09-04（手動テスト (1)）: 不連続選択を cmd/ctrl+click に割り当てる（ADRL-0108 を supersede）。
        // 詳細は notetree-toggle-select-dnd.spec.ts（TC-MSEL-33）。ここでは範囲選択との共存だけ見る。
        await setup(page);
        await clearMessages(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'm3', { meta: true });
        expect(await selectedIds(page), 'cmd+click で不連続選択にならない').toEqual(['m1', 'm3']);
        await page.waitForTimeout(100);
        const msgs = await messages(page);
        expect(msgs.filter((m: any) => m.type === 'openFileInTab').length, 'cmd+click が旧 FR-CT-01（タブで開く）のまま').toBe(0);
    });

    test('TC-MSEL-12 Favorites セクションの行は visibleItemIds に二重登録されない', async ({ page }) => {
        // m1 を favorite にすると Favorites と通常ツリーの両方に描画される
        await setup(page, { favorites: ['m1'] });
        const favCount = await page.locator('.file-panel-item[data-fav-section="1"]').count();
        expect(favCount, '前提: Favorites セクションに m1 が描画されている（0 だとこの TC が空回りする）').toBe(1);

        // 通常ツリー側の m1 を anchor に o1..m2 を選ぶ。
        // Favorites が visibleItemIds に混ざっていると区間がずれる（id が 2 回入るため）
        await clickItem(page, 'o1');
        await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('.file-panel-item[data-file-id="m2"]'))
                .filter((e) => !(e as HTMLElement).dataset.favSection);
            (els[0] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        });
        const sel = await selectedIds(page);
        // 期待: o1, m1, m2（重複なし・順序どおり）
        expect(sel.filter((x) => x === 'm1').length,
            'm1 が 2 回選択されている = Favorites が描画順配列に混ざっている').toBeLessThanOrEqual(1);
        expect(sel.slice(0, 3)).toEqual(['o1', 'm1', 'm2']);
    });

    test('TC-MSEL-12b 折りたたまれた folder の子は選択範囲に入らない', async ({ page }) => {
        await setup(page);
        // 前提の確認: createFolderElement は collapsed でも renderIds(childIds) を**常に呼ぶ**ため
        // m4 は DOM に存在する（折りたたみは CSS .file-panel-folder.collapsed で隠すだけ）。
        // → 「renderIds 走行中に記録する」方式では非表示の子が選択範囲に混ざる。
        //   実装は描画後に DOM の可視性から作り直すことでこれを避けている。
        const inDom = await page.locator('.file-panel-item[data-file-id="m4"]').count();
        expect(inDom, '前提: m4 は DOM には存在する（CSS で隠れているだけ）').toBe(1);
        const isHidden = await page.evaluate(() => {
            const el = document.querySelector('.file-panel-item[data-file-id="m4"]') as HTMLElement;
            return !!el.closest('.file-panel-folder.collapsed');
        });
        expect(isHidden, '前提: m4 は collapsed 配下にある').toBe(true);

        // 全体を範囲選択しても非表示の m4 は入らない
        await clickItem(page, 'o1');
        await clickItem(page, 'f1', { shift: true });
        expect(await selectedIds(page), '非表示の m4 が選択に混ざっている').not.toContain('m4');
        expect(await selectedIds(page)).toEqual(['o1', 'm1', 'm2', 'm3', 'f1']);
    });
});

/**
 * TC-MSEL-13..18 (TASK-24) — note ツリー複数選択 → 3 面 D&D
 * （FR-MSEL-04 / §4-1 §4-2）
 *
 * 本 spec は **送り手（dragstart の payload）と受け手の呼び出し回数**を見る。
 * 「note ツリー側 3 件残存」（TC-MSEL-13 の後半）は host 層の複製化 = TC-DCP-05/06 が番人。
 *
 * 🔴 counterfactual: 受け手を `items` 非対応（旧形式のみ）に戻すと N=1 に縮退して RED。
 */
test.describe('TC-MSEL-13..18 note ツリー複数選択の D&D（FR-MSEL-04）', () => {
    const TREE_MD = 'application/x-fractal-tree-md';
    const TREE_FILE = 'application/x-fractal-tree-file';

    /** 選択内の行で dragstart を発火して payload を読む。 */
    async function fireDragstart(page: Page, id: string): Promise<{ types: string[]; md: any; file: any }> {
        return page.evaluate((i) => {
            const el = document.querySelector(`.file-panel-item[data-file-id="${i}"]`) as HTMLElement;
            const dt = new DataTransfer();
            el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const rd = (t: string) => { const r = dt.getData(t); return r ? JSON.parse(r) : null; };
            return {
                types: Array.from(dt.types),
                md: rd('application/x-fractal-tree-md'),
                file: rd('application/x-fractal-tree-file'),
            };
        }, id);
    }

    test('送り手: md 3 件選択 → tree-md payload に 3 件（選択順）', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'm3', { shift: true });   // m1, dir1, m2, m3（dir1 は folder）
        const sel = await selectedIds(page);
        expect(sel.length, `前提: 範囲選択されている（実際 ${sel.join(',')}）`).toBeGreaterThan(2);

        const r = await fireDragstart(page, 'm2');
        expect(r.types, `${TREE_MD} が積まれていない`).toContain(TREE_MD);
        expect(r.md.v, '複数形式のスキーマ版が無い').toBe(1);
        expect(r.md.items.map((x: any) => x.id), 'md item が選択順で載っていない')
            .toEqual(['m1', 'm2', 'm3']);
        // folder は tree-md/-file のどちらにも載らない（FR-MSEL-05）
        expect(JSON.stringify(r), 'folder item が payload に載った').not.toContain('dir1');
    });

    test('送り手: 種別ごとに別 MIME を積む（dragover で types 判定できるようにする）', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm1');
        await clickItem(page, 'f1', { shift: true });   // m1..f1 = md 3 + folder 1 + file 1
        const r = await fireDragstart(page, 'm2');
        expect(r.types, 'md の type が無い').toContain(TREE_MD);
        expect(r.types, 'file の type が無い').toContain(TREE_FILE);
        expect(r.md.items.map((x: any) => x.id)).toEqual(['m1', 'm2', 'm3']);
        expect(r.file.items.map((x: any) => x.id)).toEqual(['f1']);
    });

    test('送り手: 単一選択は従来形式のまま（既存の受け手 TC を壊さない）', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'm2');
        const r = await fireDragstart(page, 'm2');
        expect(r.md.items, '1 件選択で items 配列になっている').toBeUndefined();
        expect(r.md.id).toBe('m2');
        expect(r.md.filePath, '単一形式の filePath が落ちた（既存受け手が読む）').toBeTruthy();
    });

    /**
     * ⚠️ **期待値更新（TASK-29 / 許可: test_update）**: iteration 1 は「単一 bridge が N 回」を
     * 期待していたが、**それでは host 側の件数ゲートを迂回する**（reviewer SEC-1）。
     * 現契約は「複数 = 配列 bridge を **1 回**」。
     */
    test('TC-MSEL-13 受け手（linkedfd）: 配列 bridge を 1 回・items が選択順', async ({ page }) => {
        await setup(page);
        const got = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            // fv を表示して tree row に drop する
            w.__folderViewDispatcher.showFolderView('fl1', 'Docs');
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [
                { name: 'dirX', relPath: 'dirX', isDir: true },
            ] }, '*');
            return true;
        });
        expect(got).toBe(true);
        await page.waitForSelector('.fv-row', { timeout: 5000 });

        const calls = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const row = document.querySelector('.fv-row[data-rel="dirX"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-md',
                JSON.stringify({ v: 1, items: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }));
            const r = row.getBoundingClientRect();
            row.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            }));
            return {
                batch: w.__testApi.notesMessages.filter((m: any) => m.type === 'folderViewMoveInBatch'),
                single: w.__testApi.notesMessages.filter((m: any) => m.type === 'folderViewMoveIn'),
            };
        });
        expect(calls.batch.length,
            '配列 bridge が 1 回呼ばれていない — host 側の件数ゲートに到達できない').toBe(1);
        expect(calls.batch[0].items.map((x: any) => x.srcItemId), '選択順が崩れている')
            .toEqual(['m1', 'm2', 'm3']);
        expect(calls.batch[0].items.every((x: any) => x.srcKind === 'md'), 'srcKind が md でない').toBe(true);
        expect(calls.single.length, '単一版が N 回呼ばれている（上限ゲートを迂回）').toBe(0);
    });

    test('TC-MSEL-13b 受け手（linkedfd）: 旧形式は 1 回だけ（後方互換）', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [
                { name: 'dirX', relPath: 'dirX', isDir: true },
            ] }, '*');
        });
        await page.waitForSelector('.fv-row', { timeout: 5000 });
        const calls = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const row = document.querySelector('.fv-row[data-rel="dirX"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'f1' }));
            const r = row.getBoundingClientRect();
            row.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            }));
            return w.__testApi.notesMessages.filter((m: any) => m.type === 'folderViewMoveIn');
        });
        expect(calls.length).toBe(1);
        expect(calls[0].srcItemId).toBe('f1');
        expect(calls[0].srcKind).toBe('file');
    });
});

/**
 * TC-MSEL-15..18 (TASK-24 受け手) — outliner / md 本文への複数 drop
 * （FR-MSEL-04 / §4-1）
 *
 * outliner = **選択順に平らな兄弟 node ×N**（まとめ役 node なし）/
 * md = **N 行のリンク**（箇条書きにしない）。どちらも「既存の単一 drop の意味論を N 回適用」。
 */
test.describe('TC-MSEL-15..18 outliner / md への複数 drop（FR-MSEL-04）', () => {
    /** 指定要素に tree payload を drop して host 呼び出しを回収する。 */
    async function dropOn(page: Page, selector: string, mime: string, payload: any, bucket: 'notes' | 'md'): Promise<any[]> {
        return page.evaluate((a) => {
            const w = window as any;
            const list = a.bucket === 'notes' ? w.__testApi.notesMessages : w.__testApi.messages;
            list.length = 0;
            const el = document.querySelector(a.selector) as HTMLElement;
            if (!el) { return [{ error: 'NO-ELEMENT: ' + a.selector }]; }
            const dt = new DataTransfer();
            dt.setData(a.mime, JSON.stringify(a.payload));
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.bottom - 2,
            }));
            return list.slice();
        }, { selector, mime, payload, bucket });
    }

    /**
     * ⚠️ **期待値更新（TASK-35 / 許可: test_update）**: iteration 1 は「単一 bridge が N 回」を
     * 期待していたが、**それでは host 側の件数ゲートを迂回する**（reviewer iteration 2 SEC-3）。
     * 現契約は「複数 = 配列 bridge を **1 回**」。転送件数は配列の長さで数える。
     */
    test('TC-MSEL-15 / TC-MSEL-16 outliner: md 3 件 → 配列 bridge 1 回・まとめ役を作らない', async ({ page }) => {
        await setup(page);
        // outliner を .out で初期化して node を出す
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['x'],
                nodes: { x: { id: 'x', parentId: null, children: [], text: 'node X', collapsed: false,
                    subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } },
            });
        });
        await page.waitForSelector('.outliner-node[data-id="x"]', { timeout: 5000 });

        const calls = await dropOn(page, '.outliner-node[data-id="x"]', 'application/x-fractal-tree-md',
            { v: 1, items: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }, 'notes');
        const batch = calls.filter((c: any) => c.type === 'notesImportMdIntoOutBatch');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない（件数ゲートに到達できない）').toBe(1);
        expect(batch[0].mdFileIds, '選択順が崩れている').toEqual(['m1', 'm2', 'm3']);
        // 3 件が同じ drop 位置（node X）に入る = 平らな兄弟 ×3（まとめ役 node を作らない）
        expect(batch[0].targetNodeId, 'drop 位置が 1 つに確定していない').toBe('x');
        expect(calls.filter((c: any) => c.type === 'notesImportMdIntoOut').length,
            '単一版が N 回呼ばれている（上限ゲートを迂回）').toBe(0);
    });

    test('TC-MSEL-15b outliner: file 3 件 → 配列 bridge 1 回', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['x'],
                nodes: { x: { id: 'x', parentId: null, children: [], text: 'node X', collapsed: false,
                    subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } },
            });
        });
        await page.waitForSelector('.outliner-node[data-id="x"]', { timeout: 5000 });

        const calls = await dropOn(page, '.outliner-node[data-id="x"]', 'application/x-fractal-tree-file',
            { v: 1, items: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] }, 'notes');
        const batch = calls.filter((c: any) => c.type === 'notesImportTreeFileAtPositionBatch');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない').toBe(1);
        expect(batch[0].ids).toEqual(['f1', 'f2', 'f3']);
        expect(calls.filter((c: any) => c.type === 'notesImportTreeFileAtPosition').length,
            '単一版が N 回呼ばれている').toBe(0);
    });

    test('TC-MSEL-15c outliner: 旧形式は 1 回だけ（後方互換）', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['x'],
                nodes: { x: { id: 'x', parentId: null, children: [], text: 'node X', collapsed: false,
                    subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } },
            });
        });
        await page.waitForSelector('.outliner-node[data-id="x"]', { timeout: 5000 });
        const calls = await dropOn(page, '.outliner-node[data-id="x"]', 'application/x-fractal-tree-md',
            { id: 'm1', filePath: '/n/m1.md' }, 'notes');
        expect(calls.filter((c: any) => c.type === 'notesImportMdIntoOut').length).toBe(1);
    });

    /** main md ペインを開く（既存 notes-tree-md-dnd-mdeditor.spec.ts と同一手順）。 */
    async function bootMdPane(page: Page): Promise<void> {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# Current\n\nbody\n',
                filePath: '/n/m1.md', documentBaseUri: '',
            });
        });
        await page.waitForSelector('.markdown-container .editor', { timeout: 5000 });
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    }

    /**
     * ⚠️ **期待値更新（TASK-35 / 許可: test_update）**: iteration 1 は「単一 bridge が N 回」を
     * 期待していたが、**それでは host 側の件数ゲートを迂回する**（reviewer iteration 2 SEC-3）。
     * 現契約は「複数 = 配列 bridge を **1 回**」。転送件数は配列の長さで数える。
     */
    test('TC-MSEL-17 / TC-MSEL-18 md 本文: md 3 件 → 配列 bridge 1 回（箇条書きにしない）', async ({ page }) => {
        await setup(page);
        await bootMdPane(page);

        const calls = await dropOn(page, '.markdown-container .editor',
            'application/x-fractal-tree-md',
            { v: 1, items: [
                { id: 'm1', filePath: '/n/m1.md' },
                { id: 'm2', filePath: '/n/m2.md' },
                { id: 'm3', filePath: '/n/m3.md' },
            ] }, 'md');
        const batch = calls.filter((c: any) => c.type === 'notesMdLinkMdAsSubpageBatch');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない').toBe(1);
        expect(batch[0].items.map((x: any) => x.filePath), '選択順が崩れている')
            .toEqual(['/n/m1.md', '/n/m2.md', '/n/m3.md']);
        // 箇条書きにしていない = filePath がそのまま渡る（`- ` を前置する経路が無い）
        for (const it of batch[0].items) {
            expect(String(it.filePath).startsWith('- '), '箇条書きの `- ` が混入している').toBe(false);
        }
        expect(calls.filter((c: any) => c.type === 'notesMdLinkMdAsSubpage').length,
            '単一版が N 回呼ばれている').toBe(0);
    });

    test('TC-MSEL-17b md 本文: file 3 件 → 配列 bridge 1 回', async ({ page }) => {
        await setup(page);
        await bootMdPane(page);

        const calls = await dropOn(page, '.markdown-container .editor',
            'application/x-fractal-tree-file',
            { v: 1, items: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] }, 'md');
        const batch = calls.filter((c: any) => c.type === 'attachTreeFileToMdBatch');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない').toBe(1);
        expect(batch[0].ids).toEqual(['f1', 'f2', 'f3']);
        expect(calls.filter((c: any) => c.type === 'attachTreeFileToMd').length,
            '単一版が N 回呼ばれている').toBe(0);
    });
});

/**
 * TC-MSEL-24 実経路（tree→fv 方向）— TASK-29 / reviewer iteration 1 SEC-1
 *
 * note ツリーの複数選択を fv へ drop したとき、**配列 bridge を 1 回**呼ぶ
 * （N 回ループすると host 側の件数ゲートに到達できない）。
 */
test.describe('TC-MSEL-24 実経路: tree→fv も配列 bridge を 1 回（NFR-MSEL-02）', () => {
    async function showFv(page: Page): Promise<void> {
        await page.evaluate(() => {
            (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [
                { name: 'dirX', relPath: 'dirX', isDir: true },
            ] }, '*');
        });
        await page.waitForSelector('.fv-row[data-rel="dirX"]', { timeout: 5000 });
    }

    test('md 3 件の drop は folderViewMoveInBatch を 1 回（N 回ループしない）', async ({ page }) => {
        await setup(page);
        await showFv(page);
        const msgs = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const row = document.querySelector('.fv-row[data-rel="dirX"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-md',
                JSON.stringify({ v: 1, items: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }));
            const r = row.getBoundingClientRect();
            row.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            }));
            return w.__testApi.notesMessages.slice();
        });
        const batch = msgs.filter((m: any) => m.type === 'folderViewMoveInBatch');
        const single = msgs.filter((m: any) => m.type === 'folderViewMoveIn');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない — 件数ゲートに到達できない').toBe(1);
        expect(batch[0].items.map((x: any) => x.srcItemId), '選択順が崩れている').toEqual(['m1', 'm2', 'm3']);
        expect(batch[0].items.every((x: any) => x.srcKind === 'md'), 'srcKind が md でない').toBe(true);
        expect(single.length, '単一版が N 回呼ばれている（上限ゲートを迂回）').toBe(0);
    });

    test('単一 drop は従来の単一 bridge のまま（後方互換）', async ({ page }) => {
        await setup(page);
        await showFv(page);
        const msgs = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const row = document.querySelector('.fv-row[data-rel="dirX"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'f1' }));
            const r = row.getBoundingClientRect();
            row.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            }));
            return w.__testApi.notesMessages.slice();
        });
        expect(msgs.filter((m: any) => m.type === 'folderViewMoveIn').length, '単一版が呼ばれていない').toBe(1);
        expect(msgs.filter((m: any) => m.type === 'folderViewMoveInBatch').length, '単一なのに配列版').toBe(0);
    });
});

/**
 * TC-MSEL-24b / 24c 実経路（note tree → outliner / → md）— TASK-35 / reviewer iteration 2 SEC-3
 *
 * TASK-29 は fv⇄tree の 2 方向だけを直し、FR-MSEL-04 が定義する残り 2 面
 * （outliner / md）は N 回ループのままだった。**3 面すべてで配列 bridge 1 回**に揃える。
 *
 * 🔴 outliner 宛ては host 側 `notesImportMdIntoOut` が 1 回ごとに `.out` 全体を
 * read → parse → write するため、N 件 drop で O(N²) の I/O になる（上限ゲートが特に重要）。
 */
test.describe('TC-MSEL-24b / 24c 実経路: outliner / md も配列 bridge を 1 回（NFR-MSEL-02）', () => {
    async function initOutlinerNode(page: Page): Promise<void> {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['x'],
                nodes: { x: { id: 'x', parentId: null, children: [], text: 'node X', collapsed: false,
                    subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } },
            });
        });
        await page.waitForSelector('.outliner-node[data-id="x"]', { timeout: 5000 });
    }

    /** 指定要素に payload を drop して bridge 呼び出しを回収する。 */
    async function dropOn(page: Page, selector: string, mime: string, payload: any, bucket: 'notes' | 'md'): Promise<any[]> {
        return page.evaluate((a) => {
            const w = window as any;
            const list = a.bucket === 'notes' ? w.__testApi.notesMessages : w.__testApi.messages;
            list.length = 0;
            const el = document.querySelector(a.selector) as HTMLElement;
            if (!el) { return [{ error: 'NO-ELEMENT: ' + a.selector }]; }
            const dt = new DataTransfer();
            dt.setData(a.mime, JSON.stringify(a.payload));
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.bottom - 2,
            }));
            return list.slice();
        }, { selector, mime, payload, bucket });
    }

    test('TC-MSEL-24b outliner: md 3 件 → notesImportMdIntoOutBatch を 1 回（N 回ループしない）', async ({ page }) => {
        await setup(page);
        await initOutlinerNode(page);
        const msgs = await dropOn(page, '.outliner-node[data-id="x"]', 'application/x-fractal-tree-md',
            { v: 1, items: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }, 'notes');
        const batch = msgs.filter((m: any) => m.type === 'notesImportMdIntoOutBatch');
        const single = msgs.filter((m: any) => m.type === 'notesImportMdIntoOut');
        expect(batch.length,
            '配列 bridge が 1 回呼ばれていない — host 側の件数ゲート（checkBatchLimit）に到達できない').toBe(1);
        expect(batch[0].mdFileIds, '選択順が崩れている').toEqual(['m1', 'm2', 'm3']);
        expect(single.length, '単一版が N 回呼ばれている（上限ゲートを迂回）').toBe(0);
    });

    test('TC-MSEL-24d outliner: file 3 件 → notesImportTreeFileAtPositionBatch を 1 回', async ({ page }) => {
        await setup(page);
        await initOutlinerNode(page);
        const msgs = await dropOn(page, '.outliner-node[data-id="x"]', 'application/x-fractal-tree-file',
            { v: 1, items: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] }, 'notes');
        const batch = msgs.filter((m: any) => m.type === 'notesImportTreeFileAtPositionBatch');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない').toBe(1);
        expect(batch[0].ids).toEqual(['f1', 'f2', 'f3']);
        expect(msgs.filter((m: any) => m.type === 'notesImportTreeFileAtPosition').length,
            '単一版が N 回呼ばれている').toBe(0);
    });

    test('TC-MSEL-24e outliner: 単一 drop は従来の単一 bridge のまま（後方互換）', async ({ page }) => {
        await setup(page);
        await initOutlinerNode(page);
        const msgs = await dropOn(page, '.outliner-node[data-id="x"]', 'application/x-fractal-tree-md',
            { id: 'm1', filePath: '/n/m1.md' }, 'notes');
        expect(msgs.filter((m: any) => m.type === 'notesImportMdIntoOut').length, '単一版が呼ばれていない').toBe(1);
        expect(msgs.filter((m: any) => m.type === 'notesImportMdIntoOutBatch').length, '単一なのに配列版').toBe(0);
    });

    test('TC-MSEL-24c md 本文: md 3 件 → linkMdAsSubpageBatch を 1 回', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# Current\n\nbody\n',
                filePath: '/n/m1.md', documentBaseUri: '',
            });
        });
        await page.waitForSelector('.markdown-container .editor', { timeout: 5000 });

        const msgs = await dropOn(page, '.markdown-container .editor', 'application/x-fractal-tree-md',
            { v: 1, items: [
                { id: 'm1', filePath: '/n/m1.md' },
                { id: 'm2', filePath: '/n/m2.md' },
                { id: 'm3', filePath: '/n/m3.md' },
            ] }, 'md');
        const batch = msgs.filter((m: any) => m.type === 'notesMdLinkMdAsSubpageBatch');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない').toBe(1);
        expect(batch[0].items.map((x: any) => x.filePath), '選択順が崩れている')
            .toEqual(['/n/m1.md', '/n/m2.md', '/n/m3.md']);
        expect(msgs.filter((m: any) => m.type === 'notesMdLinkMdAsSubpage').length,
            '単一版が N 回呼ばれている').toBe(0);
    });

    test('TC-MSEL-24f md 本文: file 3 件 → attachTreeFileToMdBatch を 1 回', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# Current\n\nbody\n',
                filePath: '/n/m1.md', documentBaseUri: '',
            });
        });
        await page.waitForSelector('.markdown-container .editor', { timeout: 5000 });
        const msgs = await dropOn(page, '.markdown-container .editor', 'application/x-fractal-tree-file',
            { v: 1, items: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] }, 'md');
        const batch = msgs.filter((m: any) => m.type === 'attachTreeFileToMdBatch');
        expect(batch.length, '配列 bridge が 1 回呼ばれていない').toBe(1);
        expect(batch[0].ids).toEqual(['f1', 'f2', 'f3']);
        expect(msgs.filter((m: any) => m.type === 'attachTreeFileToMd').length,
            '単一版が N 回呼ばれている').toBe(0);
    });
});

/**
 * TC-MSEL-28..32（再オープン 2026-09-03 / TASK-45 / design §4-2 rev2）— 種別混在は**結合 batch 1 回** + `.out` 除外
 *
 * iteration 1 の受け手は 3 面とも「md MIME があれば処理して return」の先勝ち分岐で、md + file の混在選択を
 * drop すると file 側が無音で落ちていた。再オープン初版の「per-kind batch 2 回」は件数ゲートが種別ごとの
 * サブ配列でしか効かない（design-review TDDR-2）ため、**両 MIME を `seq` 順に結合して結合 bridge を 1 回**にした。
 */
test.describe('TC-MSEL-28..32 種別混在は結合 batch 1 回 / .out は除外（FR-MSEL-04 rev2）', () => {
    // md: m1(seq0) m2(seq2) / file: f1(seq1) → 結合順は m1, f1, m2（選択順が種別を跨いで保たれる）
    const MIXED_MD = { v: 1, items: [{ id: 'm1', filePath: '/n/m1.md', seq: 0 }, { id: 'm2', filePath: '/n/m2.md', seq: 2 }] };
    const MIXED_FILE = { v: 1, items: [{ id: 'f1', seq: 1 }] };
    const EXPECTED_ORDER = [{ kind: 'md', id: 'm1' }, { kind: 'file', id: 'f1' }, { kind: 'md', id: 'm2' }];

    async function initOutlinerNode(page: Page): Promise<void> {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['x'],
                nodes: { x: { id: 'x', parentId: null, children: [], text: 'node X', collapsed: false,
                    subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } },
            });
        });
        await page.waitForSelector('.outliner-node[data-id="x"]', { timeout: 5000 });
    }

    /** 複数 MIME を 1 つの DataTransfer に積んで drop し、bridge 呼び出しを回収する。 */
    async function dropMulti(page: Page, selector: string, payloads: Record<string, any>, bucket: 'notes' | 'md', yAt: 'bottom' | 'center' = 'bottom'): Promise<any[]> {
        return page.evaluate((a) => {
            const w = window as any;
            const list = a.bucket === 'notes' ? w.__testApi.notesMessages : w.__testApi.messages;
            list.length = 0;
            const el = document.querySelector(a.selector) as HTMLElement;
            if (!el) { return [{ error: 'NO-ELEMENT: ' + a.selector }]; }
            const dt = new DataTransfer();
            for (const mime of Object.keys(a.payloads)) { dt.setData(mime, JSON.stringify(a.payloads[mime])); }
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: a.yAt === 'bottom' ? r.bottom - 2 : r.top + r.height / 2,
            }));
            return list.slice();
        }, { selector, payloads, bucket, yAt });
    }

    async function fireDragstart(page: Page, id: string): Promise<{ md: any; file: any }> {
        return page.evaluate((i) => {
            const el = document.querySelector(`.file-panel-item[data-file-id="${i}"]`) as HTMLElement;
            const dt = new DataTransfer();
            el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const rd = (t: string) => { const r = dt.getData(t); return r ? JSON.parse(r) : null; };
            return { md: rd('application/x-fractal-tree-md'), file: rd('application/x-fractal-tree-file') };
        }, id);
    }

    async function fireDragend(page: Page, id: string, dropEffect: 'copy' | 'none'): Promise<any[]> {
        return page.evaluate((a) => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const el = document.querySelector(`.file-panel-item[data-file-id="${a.id}"]`) as HTMLElement;
            const dt = new DataTransfer();
            dt.dropEffect = a.dropEffect as any;
            el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return w.__testApi.notesMessages.filter((m: any) => m.type === 'notifyError');
        }, { id, dropEffect });
    }

    test('送り手: 混在選択の各 item に seq が付き、.out はどの MIME にも載らない', async ({ page }) => {
        await setup(page);
        await clickItem(page, 'o1');
        await clickItem(page, 'f1', { shift: true });   // o1 .. f1（.out / md ×3 / folder / file）
        const got = await fireDragstart(page, 'm1');
        expect(got.md, 'md payload が無い').toBeTruthy();
        expect(got.file, 'file payload が無い').toBeTruthy();
        const mdIds = got.md.items.map((x: any) => x.id);
        const fileIds = got.file.items.map((x: any) => x.id);
        expect(mdIds).toEqual(['m1', 'm2', 'm3']);
        expect(fileIds).toEqual(['f1']);
        for (const it of [...got.md.items, ...got.file.items]) {
            expect(typeof it.seq, `seq が無い: ${JSON.stringify(it)}`).toBe('number');
        }
        // 選択順 = o1(0) m1(1) dir1(2) m2(3) m3(4) f1(5) → md の seq は昇順、file の seq は m3 より後
        expect(got.md.items.map((x: any) => x.seq)).toEqual([...got.md.items.map((x: any) => x.seq)].sort((a, b) => a - b));
        expect(got.file.items[0].seq).toBeGreaterThan(got.md.items[2].seq);
        // .out（o1）はどの payload にも入らない（R3）
        expect([...mdIds, ...fileIds]).not.toContain('o1');
    });

    test('TC-MSEL-31 .out を含む選択は drop 成立時に 1 回だけ通知・キャンセル時は 0 回', async ({ page }) => {
        // ⚠️ 合成 DataTransfer では `dropEffect` を設定できない（Chromium は drag 型でない DataTransfer の setter を無視）
        //    → 実 mouse drag で dragend を発火させる（TC-DCP-11 と同じ手法）
        await setup(page);
        await initOutlinerNode(page);
        const notifies = () => page.evaluate(() =>
            (window as any).__testApi.notesMessages.filter((m: any) => m.type === 'notifyError'));

        // (1) drop 成立: o1..f1 を選択 → m1 を outliner の node X へ実 drag → dropEffect = copy → 通知 1 回
        await clickItem(page, 'o1');
        await clickItem(page, 'f1', { shift: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        await page.dragAndDrop('.file-panel-item[data-file-id="m1"]', '.outliner-node[data-id="x"]');
        const ok = await notifies();
        expect(ok.length, `drop 成立で通知が ${ok.length} 回（1 回であるべき）`).toBe(1);
        expect(String(ok[0].message), '除外件数（1）が文言に無い').toMatch(/1/);
        // 結合 bridge も 1 回（.out は items に居ない）
        const combined = await page.evaluate(() =>
            (window as any).__testApi.notesMessages.filter((m: any) => m.type === 'notesImportTreeItemsBatch'));
        expect(combined.length).toBe(1);
        expect(combined[0].items.map((x: any) => x.id)).not.toContain('o1');

        // (2) キャンセル: dragover を preventDefault しない要素へ落とす → dropEffect = none → 通知なし
        await page.evaluate(() => {
            const z = document.createElement('div');
            z.id = 'no-drop-zone';
            z.style.cssText = 'position:fixed;left:0;top:0;width:60px;height:60px;z-index:99999;background:transparent;';
            document.body.appendChild(z);
        });
        await clickItem(page, 'o1');
        await clickItem(page, 'f1', { shift: true });
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        await page.dragAndDrop('.file-panel-item[data-file-id="m1"]', '#no-drop-zone');
        const none = await notifies();
        expect(none.length, 'キャンセル（不成立）なのに通知が出た').toBe(0);
    });

    test('TC-MSEL-28 outliner: md + file 混在 → notesImportTreeItemsBatch 1 回・seq 順・per-kind batch 0 回', async ({ page }) => {
        await setup(page);
        await initOutlinerNode(page);
        const msgs = await dropMulti(page, '.outliner-node[data-id="x"]', {
            'application/x-fractal-tree-md': MIXED_MD, 'application/x-fractal-tree-file': MIXED_FILE,
        }, 'notes');
        const combined = msgs.filter((m: any) => m.type === 'notesImportTreeItemsBatch');
        expect(combined.length, '結合 bridge が 1 回呼ばれていない（先勝ち分岐 or per-kind 2 回 = 件数ゲートが合計で効かない）').toBe(1);
        expect(combined[0].items.map((x: any) => ({ kind: x.kind, id: x.id })), 'seq 順に結合されていない').toEqual(EXPECTED_ORDER);
        expect(combined[0].targetNodeId).toBe('x');
        expect(msgs.filter((m: any) => m.type === 'notesImportMdIntoOutBatch' || m.type === 'notesImportTreeFileAtPositionBatch').length,
            'per-kind batch が呼ばれている（ゲートが種別ごとに割れる）').toBe(0);
        expect(msgs.filter((m: any) => m.type === 'notesImportMdIntoOut' || m.type === 'notesImportTreeFileAtPosition').length,
            '単一版が呼ばれている').toBe(0);
    });

    test('TC-MSEL-29 linkedfd: md + file 混在 → folderViewMoveInBatch 1 回・srcKind 混在・seq 順', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [
                { name: 'dirX', relPath: 'dirX', isDir: true },
            ] }, '*');
        });
        await page.waitForSelector('.fv-row[data-rel="dirX"]', { timeout: 5000 });
        const msgs = await dropMulti(page, '.fv-row[data-rel="dirX"]', {
            'application/x-fractal-tree-md': MIXED_MD, 'application/x-fractal-tree-file': MIXED_FILE,
        }, 'notes', 'center');
        const batch = msgs.filter((m: any) => m.type === 'folderViewMoveInBatch');
        expect(batch.length, '結合 bridge が 1 回でない').toBe(1);
        expect(batch[0].items.map((x: any) => ({ kind: x.srcKind, id: x.srcItemId }))).toEqual(EXPECTED_ORDER);
        expect(msgs.filter((m: any) => m.type === 'folderViewMoveIn').length, '単一版が呼ばれている').toBe(0);
    });

    test('TC-MSEL-30 md 本文: md + file 混在 → attachTreeItemsToMdBatch 1 回・seq 順', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# Current\n\nbody\n',
                filePath: '/n/m1.md', documentBaseUri: '',
            });
        });
        await page.waitForSelector('.markdown-container .editor', { timeout: 5000 });
        const msgs = await dropMulti(page, '.markdown-container .editor', {
            'application/x-fractal-tree-md': MIXED_MD, 'application/x-fractal-tree-file': MIXED_FILE,
        }, 'md');
        const combined = msgs.filter((m: any) => m.type === 'attachTreeItemsToMdBatch');
        expect(combined.length, '結合 bridge が 1 回でない（file 先勝ち return で md が落ちる）').toBe(1);
        expect(combined[0].items.map((x: any) => ({ kind: x.kind, id: x.id }))).toEqual(EXPECTED_ORDER);
        expect(combined[0].items[0].filePath, 'md item の filePath が落ちている（subpage リンクに必要）').toBe('/n/m1.md');
        expect(msgs.filter((m: any) => m.type === 'attachTreeFileToMdBatch' || m.type === 'notesMdLinkMdAsSubpageBatch' || m.type === 'linkMdAsSubpageBatch').length,
            'per-kind batch が呼ばれている').toBe(0);
    });

    test('TC-MSEL-30b sidepanel md: SidePanelHostBridge が attachTreeItemsToMdBatch を this.filePath 付きで委譲する（source pin）', async () => {
        // sidepanel はハーネスで開けないため、手書きクラス側の委譲 1 本を字面で pin する
        //（generator_failures 2026-08-09: main では動くが sidepanel だけ silent no-op になる再発クラス）
        const fs = require('fs'); const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'editor.js'), 'utf8');
        const cls = src.slice(src.indexOf('class SidePanelHostBridge'), src.indexOf('class SidePanelHostBridge') + 6000);
        expect(cls.includes('attachTreeItemsToMdBatch(items)'), 'SidePanelHostBridge に attachTreeItemsToMdBatch が無い').toBe(true);
        expect(cls.includes('this._mainHost.attachTreeItemsToMdBatch(items, this.filePath)'), 'this.filePath を積んで委譲していない').toBe(true);
    });

    test('TC-MSEL-32 件数ゲートは合計で 1 回: md 150 + file 150 → 結合 bridge 1 回に items 300', async ({ page }) => {
        await setup(page);
        await initOutlinerNode(page);
        const md = { v: 1, items: Array.from({ length: 150 }, (_, i) => ({ id: `md${i}`, filePath: `/n/md${i}.md`, seq: i * 2 })) };
        const file = { v: 1, items: Array.from({ length: 150 }, (_, i) => ({ id: `f${i}`, seq: i * 2 + 1 })) };
        const msgs = await dropMulti(page, '.outliner-node[data-id="x"]', {
            'application/x-fractal-tree-md': md, 'application/x-fractal-tree-file': file,
        }, 'notes');
        const combined = msgs.filter((m: any) => m.type === 'notesImportTreeItemsBatch');
        expect(combined.length, '結合 bridge が 1 回でない — host の件数ゲートが 300 を見られない').toBe(1);
        expect(combined[0].items.length, '合計 300 件が 1 回の呼び出しに載っていない').toBe(300);
        // 交互（md, file, md, …）= seq 順が種別を跨いで保たれる
        expect(combined[0].items.slice(0, 4).map((x: any) => x.kind)).toEqual(['md', 'file', 'md', 'file']);
    });
});
