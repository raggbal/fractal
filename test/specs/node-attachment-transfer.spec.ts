/**
 * TASK-15 — note ツリー側の drop 優先順位改訂（3 面共通 dispatch）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-NDA-01/02 / ADRL-0107）
 *
 * TC-NDA-01..10。
 *
 * 検証の層: 本 spec は **webview 受け手層**（notes-file-panel.js）を見る。
 * 「note ツリーに現れる item 数」の実体化は host 側（notes-message-handler.ts / TASK-16）が
 * 担うため、ここでは **bridge に渡る `assets` 件数 = 入力の添付数** の枚数対応で数える
 * （番人の形は design/tdd.md の「入力 N → 出力 N」を webview 層に射影したもの）。
 * host 側の着地は TC-NDA-13 が受け持つ（2026-09-04 R22: 直付き画像は転送対象外 — 旧「files/ 複製」は撤回）。
 *
 * 🔴 counterfactual: 受け手の優先順位を旧実装（`subtreePayload` 優先 /
 * `!outPayload && !subtreePayload` の前提条件つき）に戻すと、**送り手が subtree payload を
 * 常に併載する**ため添付分岐が一度も発火せず TC-NDA-02..08 が全部 RED になる。
 */
import { test, expect, Page } from '@playwright/test';

const ASSETS_MIME = 'application/x-fractal-out-node-assets';
const SUBTREE_MIME = 'application/x-fractal-out-node-subtree';

/** 併持 8 セル（design/system.md §2-2 の分岐表に 1:1）。 */
// ⚠️ `tc` は **静的な文字列**で持つ（テンプレートリテラルで組むと `tc-ledger-check.sh` の
// 静的 grep が末尾数字の欠けた ID を拾い、台帳照合が偽陽性になる — reviewer LEDG-2）
const CELLS = [
    { tc: 'TC-NDA-01', cell: 1, page: false, file: false, images: 0 },
    { tc: 'TC-NDA-02', cell: 2, page: false, file: false, images: 2 },
    { tc: 'TC-NDA-03', cell: 3, page: false, file: true, images: 0 },
    { tc: 'TC-NDA-04', cell: 4, page: false, file: true, images: 2 },
    { tc: 'TC-NDA-05', cell: 5, page: true, file: false, images: 0 },
    { tc: 'TC-NDA-06', cell: 6, page: true, file: false, images: 2 },
    { tc: 'TC-NDA-07', cell: 7, page: true, file: true, images: 0 },
    { tc: 'TC-NDA-08', cell: 8, page: true, file: true, images: 2 },
];

/** そのセルの添付総数（= 期待される assets 件数）。 */
function expectedCount(c: { page: boolean; file: boolean; images: number }): number {
    return (c.page ? 1 : 0) + (c.file ? 1 : 0);   // 2026-09-04 R22: 直付き画像は転送対象外（送り手が積まない）
}

/** そのセルの assets 配列（送り手 collectNodeAssets が積むものと同形）。 */
function assetsOf(c: { cell: number; page: boolean; file: boolean; images: number }): any[] {
    const out: any[] = [];
    if (c.page) { out.push({ kind: 'page', pageId: `page-${c.cell}` }); }
    if (c.file) { out.push({ kind: 'file', filePath: `files/spec-${c.cell}.pdf` }); }
    // 画像は payload に載せない（R22）
    return out;
}

/** md / file / folder が混在する note ツリー（3 面すべてを開ける形）。 */
const FILES = [
    { id: 'm1', filePath: '/n/pages/m1.md', title: 'note-1', type: 'file' },
    { id: 'm2', filePath: '/n/pages/m2.md', title: 'note-2', type: 'file' },
];
const STRUCTURE = {
    rootIds: ['m1', 'dir1', 'm2'],
    items: {
        m1: { type: 'file', id: 'm1', title: 'note-1', filePath: '/n/pages/m1.md' },
        m2: { type: 'file', id: 'm2', title: 'note-2', filePath: '/n/pages/m2.md' },
        dir1: { type: 'folder', id: 'dir1', title: 'folder-1', childIds: [], collapsed: false },
    },
};

async function setup(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => !!(window as any).__testApi, undefined, { timeout: 8000 });
    await page.evaluate((args) => {
        (window as any).__testApi.notesMessages.length = 0;
        (window as any).__testApi.initNotesPanel(args.files, args.files[0].filePath, args.structure);
    }, { files: FILES, structure: STRUCTURE });
    await page.waitForSelector('.file-panel-item', { timeout: 5000 });
}

/** drop 面の指定。 */
type Surface = 'item' | 'children' | 'list';

/**
 * 添付 payload（+ 送り手が常に併載する subtree payload）を持つ drop を送る。
 *
 * ⚠️ `getData` は **`dragover`/`drop` の同期実行中しか読めない**ので、
 * DataTransfer を自前で組んで `drop` イベントに載せる（本番と同じ同期読み経路を通る）。
 *
 * @returns bridge に届いた notesRegisterNodeAssets メッセージ（無ければ null）
 */
async function dropAssets(page: Page, surface: Surface, assets: any[], opts?: { withSubtree?: boolean; withoutAssets?: boolean }):
    Promise<{ payload: any; parentId: string | null; index: number } | null> {
    return page.evaluate((a) => {
        const w = window as any;
        w.__testApi.notesMessages.length = 0;

        let target: HTMLElement | null = null;
        if (a.surface === 'item') {
            target = document.querySelector('.file-panel-item[data-item-id="m1"]') as HTMLElement;
        } else if (a.surface === 'children') {
            target = document.querySelector('.file-panel-folder-children') as HTMLElement;
        } else {
            target = document.getElementById('notesFileList');
        }
        if (!target) { return { error: `drop 面 ${a.surface} の要素が無い` } as any; }

        const dt = new DataTransfer();
        if (!a.withoutAssets) {
            dt.setData('application/x-fractal-out-node-assets',
                JSON.stringify({ v: 1, outFileKey: null, nodeId: 'src-node', assets: a.assets }));
        }
        if (a.withSubtree) {
            dt.setData('application/x-fractal-out-node-subtree', JSON.stringify({ nodeId: 'src-node' }));
        }

        const rect = target.getBoundingClientRect();
        const ev = new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
        });
        // childrenEl / listEl は `e.target !== el` で早期 return するので、その要素自身に dispatch する
        target.dispatchEvent(ev);

        const msgs = w.__testApi.notesMessages.filter((m: any) => m.type === 'notesRegisterNodeAssets');
        if (msgs.length === 0) { return null; }
        return { payload: msgs[0].payload, parentId: msgs[0].parentId, index: msgs[0].index };
    }, { surface, assets, withSubtree: opts?.withSubtree !== false, withoutAssets: !!opts?.withoutAssets }) as any;
}

test.describe('TC-NDA-01..08 併持 8 セルの添付が枚数どおり受理される（FR-NDA-01）', () => {
    for (const c of CELLS) {
        const n = expectedCount(c);
        test(`${c.tc} page=${c.page} file=${c.file} image=${c.images} → assets ${n} 件`, async ({ page }) => {
            await setup(page);
            const assets = assetsOf(c);
            expect(assets.length, 'テスト入力自体が壊れている').toBe(n);

            if (n === 0) {
                // TC-NDA-01: 添付ゼロ → payload が積まれない（送り手が積まないので受け手も発火しない）
                const got = await dropAssets(page, 'item', [], { withoutAssets: true });
                expect(got, '添付ゼロなのに添付経路が発火した（subtree 並べ替えを奪う）').toBeNull();
                return;
            }

            const got = await dropAssets(page, 'item', assets);
            expect(got, `cell ${c.cell}: 添付経路が発火しなかった `
                + '（subtree payload が併載されているので旧優先順位だとここで落ちる）').toBeTruthy();

            // ★ 枚数対応: 入力の添付数 = 受理された assets 件数
            expect(got!.payload.assets.length,
                `cell ${c.cell}: 期待 ${n} 件 / 実際 ${JSON.stringify(got!.payload.assets)}`).toBe(n);

            // kind 別の内訳も数える（「md item がある」だけの assert では画像欠落を見逃す）
            const byKind = (k: string) => got!.payload.assets.filter((x: any) => x.kind === k).length;
            expect(byKind('page'), `cell ${c.cell}: page の件数`).toBe(c.page ? 1 : 0);
            expect(byKind('file'), `cell ${c.cell}: file の件数`).toBe(c.file ? 1 : 0);
            expect(byKind('image'), `cell ${c.cell}: image は転送対象外（R22）`).toBe(0);

            // 所有の移し替え対象 node が host に伝わる
            expect(got!.payload.nodeId).toBe('src-node');
        });
    }
});

test.describe('TC-NDA-09 子孫の添付は運ばれない / outliner 内 drop は不変（FR-NDA-01/02）', () => {
    test('TC-NDA-09a 受け手は payload に載っている分だけを処理する（子孫を勝手に足さない）', async ({ page }) => {
        await setup(page);
        // 親のみの添付（送り手 = TC-NDA-12c で「子孫を積まない」ことを固定済み）
        const got = await dropAssets(page, 'item', [{ kind: 'file', filePath: 'files/parent.pdf' }]);
        expect(got!.payload.assets.length, '受け手が payload 外の添付を発明している').toBe(1);
        expect(got!.payload.assets[0].filePath).toBe('files/parent.pdf');
    });

    test('TC-NDA-09b outliner 内の drop は subtree 経路のまま（添付優先を全面適用していない）', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
        await page.evaluate(() => {
            const mk = (id: string, text: string, extra: any = {}) => Object.assign({
                id, parentId: null, children: [], text, collapsed: false, subtext: '',
                images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['a', 'b'],
                nodes: { a: mk('a', 'alpha', { filePath: 'files/a.pdf' }), b: mk('b', 'bravo') },
            });
        });
        await page.waitForSelector('.outliner-node', { timeout: 5000 });

        // outliner の drop ハンドラに添付 payload 付きの drop を送る。
        // 期待: **添付経路は存在しない**（= outliner 側は改訂していない）ので
        // 従来の並べ替え経路が動き、node 数が変わらない（添付が file item 化して増えたりしない）。
        const before = await page.evaluate(() => document.querySelectorAll('.outliner-node').length);
        await page.evaluate(() => {
            const src = document.querySelector('.outliner-node[data-id="a"]') as HTMLElement;
            const dst = document.querySelector('.outliner-node[data-id="b"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-out-node-assets',
                JSON.stringify({ v: 1, nodeId: 'a', assets: [{ kind: 'file', filePath: 'files/a.pdf' }] }));
            dt.setData('application/x-fractal-out-node-subtree', JSON.stringify({ nodeId: 'a' }));
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            const r = dst.getBoundingClientRect();
            dst.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.bottom - 2,
            }));
        });
        await page.waitForTimeout(120);
        const after = await page.evaluate(() => document.querySelectorAll('.outliner-node').length);
        expect(after, 'outliner 内 drop で node が増減した（添付優先を outliner にも適用してしまっている）')
            .toBe(before);
        // 添付は node に残っている（tree へ移し替えられていない）
        expect(await page.evaluate(() =>
            !!document.querySelector('.outliner-node[data-id="a"] .outliner-file-icon, '
                + '.outliner-node[data-id="a"] [class*="file"]')),
        'outliner 内 drop で node の file 添付が外れた').toBe(true);
    });
});

test.describe('TC-NDA-10 3 つの drop 面が同一の優先順位で受理する（FR-NDA-02）', () => {
    const cell8 = CELLS[7];

    for (const surface of ['item', 'children', 'list'] as Surface[]) {
        test(`TC-NDA-10 ${surface} 面で併持 2 件（page + file。画像は対象外 = R22）が受理される`, async ({ page }) => {
            await setup(page);
            const got = await dropAssets(page, surface, assetsOf(cell8));
            expect(got, `${surface} 面で添付経路が発火しない（面ごとに受理 MIME が非対称）`).toBeTruthy();
            expect(got!.payload.assets.length, `${surface} 面の枚数が違う`).toBe(2);
        });
    }

    test('TC-NDA-10b 挿入位置が面ごとに正しい（item = 兄弟 / children = フォルダ内末尾 / list = ルート末尾）', async ({ page }) => {
        await setup(page);
        const item = await dropAssets(page, 'item', assetsOf(cell8));
        const children = await dropAssets(page, 'children', assetsOf(cell8));
        const list = await dropAssets(page, 'list', assetsOf(cell8));

        // item 行: m1 の兄弟（= ルート直下）
        expect(item!.parentId, 'item 面が兄弟挿入になっていない').toBeNull();
        // childrenEl: そのフォルダ配下
        expect(children!.parentId, 'children 面がフォルダ配下になっていない').toBe('dir1');
        expect(children!.index, 'children 面がフォルダ内末尾でない').toBe(0);
        // listEl（余白）: ルート末尾
        expect(list!.parentId, 'list 面がルート直下になっていない').toBeNull();
        expect(list!.index, 'list 面がルート末尾でない').toBe(STRUCTURE.rootIds.length);
    });

    test('TC-NDA-10c 既存の 📎 file リンク経路が 3 面で不変（回帰）', async ({ page }) => {
        await setup(page);
        // outliner file node payload（既存 FR-TF-05b）を 3 面に送る。添付 payload は積まない。
        for (const surface of ['item', 'list'] as Surface[]) {
            const got = await page.evaluate((s) => {
                const w = window as any;
                w.__testApi.notesMessages.length = 0;
                const target = s === 'item'
                    ? document.querySelector('.file-panel-item[data-item-id="m1"]') as HTMLElement
                    : document.getElementById('notesFileList') as HTMLElement;
                const dt = new DataTransfer();
                dt.setData('application/x-fractal-out-node-file',
                    // readOutNodeFilePayload は outFileKey + nodeId の両方を要求する（:1101）
                    JSON.stringify({ outFileKey: 'work', nodeId: 'x', filePath: 'files/keep.pdf' }));
                const r = target.getBoundingClientRect();
                // 2026-09-04（TC-TGT-04）: md item の**中央帯**は「添付を md へ」に変わったため、item 面の
                // 兄弟登録の契約は**上帯（ratio 0.1）**で見る（list 面は従来どおり中央）
                const ratio = s === 'item' ? 0.1 : 0.5;
                target.dispatchEvent(new DragEvent('drop', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                    clientX: r.left + r.width / 2, clientY: r.top + r.height * ratio,
                }));
                return w.__testApi.notesMessages.filter((m: any) => m.type === 'notesRegisterFileFromOutNode').length;
            }, surface);
            expect(got, `${surface} 面で既存 📎 経路が壊れた（優先順位改訂の回帰）`).toBeGreaterThan(0);
        }
    });
});

/**
 * TC-MSEL-06 (TASK-23 受け手) — fv 複数選択 payload を note ツリーが N 件として受ける
 * （FR-MSEL-02 / FR-MSEL-05 / NFR-MSEL-03 / §4-1）
 *
 * 送り手（fv の dragstart 契約）は `folder-view-range-select.spec.ts` の TC-MSEL-05..08 が担う。
 * ここでは **入力 N 件 → bridge 呼び出し N 回** の枚数対応と **集計通知 1 回**を見る。
 */
test.describe('TC-MSEL-06 fv 複数選択 → note ツリーの受け手（FR-MSEL-02）', () => {
    /** fv payload（新旧どちらの形も可）を item 行へ drop して bridge 呼び出しを回収する。 */
    async function dropFv(page: Page, payload: any): Promise<{ moves: any[]; batch: any[]; transferred: any[]; notices: any[] }> {
        return page.evaluate((p) => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const el = document.querySelector('.file-panel-item[data-item-id="m1"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-folderview-entry', JSON.stringify(p));
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + 2,
            }));
            // TASK-29: 複数は配列 bridge 1 回（`...Batch`）/ 単一は従来の単一 bridge
            const batch = w.__testApi.notesMessages.filter((m: any) => m.type === 'folderViewMoveToTreeBatch');
            const single = w.__testApi.notesMessages.filter((m: any) => m.type === 'folderViewMoveToTree');
            return {
                moves: single,
                batch,
                // 「実際に転送を依頼した件数」— 単一は 1 件 × N 呼び / 複数は items の長さ
                transferred: batch.length > 0 ? batch[0].items : single.map((m: any) => ({ relPath: m.relPath })),
                notices: w.__testApi.notesMessages.filter((m: any) => m.type === 'notifyError'),
            };
        }, payload);
    }

    /**
     * ⚠️ **期待値更新（TASK-29 / 許可: test_update）**: iteration 1 は「単一 bridge が N 回」を
     * 期待していたが、**それでは host 側の件数ゲートを迂回する**（reviewer SEC-1）。
     * 現契約は「複数 = 配列 bridge を **1 回**」。転送件数は `items` の長さで数える。
     */
    test('5 件の payload → 配列 bridge を 1 回・items が選択順', async ({ page }) => {
        await setup(page);
        const rels = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
        const got = await dropFv(page, {
            v: 1, folderLinkId: 'fl1',
            items: rels.map((relPath) => ({ folderLinkId: 'fl1', relPath, isDir: false })),
        });
        expect(got.batch.length,
            '配列 bridge が 1 回呼ばれていない — host 側の件数ゲートに到達できない').toBe(1);
        expect(got.transferred.map((x: any) => x.relPath), '選択順が崩れている').toEqual(rels);
        expect(got.moves.length, '単一版が N 回呼ばれている（上限ゲートを迂回）').toBe(0);
        expect(got.notices.length, 'フォルダを含まないのに通知が出た').toBe(0);
    });

    test('旧形式（単一 payload）は 1 回だけ呼ばれる（後方互換）', async ({ page }) => {
        await setup(page);
        const got = await dropFv(page, { folderLinkId: 'fl1', relPath: 'solo.txt', isDir: false });
        expect(got.moves.length).toBe(1);
        expect(got.moves[0].relPath).toBe('solo.txt');
    });

    test('TC-MSEL-07 受け手: フォルダ混在は file だけ転送し通知は 1 回だけ', async ({ page }) => {
        await setup(page);
        const got = await dropFv(page, {
            v: 1, folderLinkId: 'fl1',
            items: [
                { folderLinkId: 'fl1', relPath: 'dirA', isDir: true },
                { folderLinkId: 'fl1', relPath: 'f1.txt', isDir: false },
                { folderLinkId: 'fl1', relPath: 'dirB', isDir: true },
                { folderLinkId: 'fl1', relPath: 'f2.txt', isDir: false },
            ],
        });
        expect(got.transferred.map((x: any) => x.relPath), 'フォルダが転送された').toEqual(['f1.txt', 'f2.txt']);
        // NFR-MSEL-03: アイテム毎ではなく 1 回だけ
        expect(got.notices.length, `除外通知が ${got.notices.length} 回（1 回であるべき）`).toBe(1);
    });

    test('TC-MSEL-07b 送り手が数えた excludedDirs も 1 回の通知に合算される', async ({ page }) => {
        await setup(page);
        const got = await dropFv(page, {
            v: 1, folderLinkId: 'fl1', excludedDirs: 2,
            items: [{ folderLinkId: 'fl1', relPath: 'f1.txt', isDir: false }],
        });
        expect(got.moves.length).toBe(1);
        expect(got.notices.length, '送り手側の除外件数が通知されない').toBe(1);
    });

    test('フォルダのみの payload は転送 0 件 + 通知 1 回（部分実行しない）', async ({ page }) => {
        await setup(page);
        const got = await dropFv(page, {
            v: 1, folderLinkId: 'fl1',
            items: [
                { folderLinkId: 'fl1', relPath: 'dirA', isDir: true },
                { folderLinkId: 'fl1', relPath: 'dirB', isDir: true },
            ],
        });
        expect(got.transferred.length, 'フォルダが転送された').toBe(0);
        expect(got.notices.length).toBe(1);
    });
});

/**
 * TC-MSEL-24/25 の実経路番人（TASK-29 / reviewer iteration 1 SEC-1）
 * — 件数上限ゲートが **実際の drop dispatch** を通ることを固定する。
 *
 * 🔴 iteration 1 の欠陥: TC-MSEL-24/25 は `runBatchTransfer` を直接 unit call するだけで、
 * その関数の呼び出し元が src 配下にゼロだった（= 上限ゲートは 1 度も通らない）。
 * 番人は「ゲートを持つ関数を呼ぶ側の実行経路」から踏まないと false-green になる
 * （generator_failures 2026-09-02）。
 *
 * 本 TC は webview 側の契約を見る: **drop 1 回 = bridge 呼び出し 1 回（items 配列）**。
 * host 側で `runBatchTransfer` を通ることは `test/unit/batch-dnd-host.spec.ts` が担う。
 */
test.describe('TC-MSEL-24/25 実経路: drop は配列 bridge を 1 回だけ呼ぶ（NFR-MSEL-02）', () => {
    /** fv payload を item 行へ drop して bridge 呼び出しを回収する。 */
    async function dropFvBatch(page: Page, count: number): Promise<any[]> {
        return page.evaluate((n) => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const el = document.querySelector('.file-panel-item[data-item-id="m1"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-folderview-entry', JSON.stringify({
                v: 1, folderLinkId: 'fl1',
                items: Array.from({ length: n }, (_, i) => ({ folderLinkId: 'fl1', relPath: `f${i}.txt`, isDir: false })),
            }));
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + 2,
            }));
            return w.__testApi.notesMessages.slice();
        }, count);
    }

    test('複数 drop は folderViewMoveToTreeBatch を 1 回（N 回ループしない）', async ({ page }) => {
        await setup(page);
        const msgs = await dropFvBatch(page, 5);
        const batch = msgs.filter((m: any) => m.type === 'folderViewMoveToTreeBatch');
        const single = msgs.filter((m: any) => m.type === 'folderViewMoveToTree');

        expect(batch.length,
            '配列 bridge が 1 回呼ばれていない — host 側の件数ゲート（checkBatchLimit）に到達できない')
            .toBe(1);
        expect(batch[0].items.map((x: any) => x.relPath), '選択順が崩れている')
            .toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
        expect(single.length,
            '単一版が N 回呼ばれている（webview が上限ゲートを迂回してループしている）').toBe(0);
    });

    test('単一 drop は従来の単一 bridge のまま（既存 TC を壊さない後方互換）', async ({ page }) => {
        await setup(page);
        const msgs = await page.evaluate(() => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const el = document.querySelector('.file-panel-item[data-item-id="m1"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-folderview-entry',
                JSON.stringify({ folderLinkId: 'fl1', relPath: 'solo.txt', isDir: false }));
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + 2,
            }));
            return w.__testApi.notesMessages.slice();
        });
        expect(msgs.filter((m: any) => m.type === 'folderViewMoveToTree').length, '単一版が呼ばれていない').toBe(1);
        expect(msgs.filter((m: any) => m.type === 'folderViewMoveToTreeBatch').length,
            '単一なのに配列版になった').toBe(0);
    });
});

test.describe('TC-NDA-16 谷間 drop は直近の線の位置へ（2026-09-04 rc.6「md が最後の行に落ちる」）', () => {
    /** item 上で dragover（線を出す）→ 行の隙間 = listEl / children 自身に drop する（本番で起きる実シーケンス）。 */
    async function hoverThenGapDrop(page: Page, hoverItemId: string, ratio: number, gap: 'list' | 'children') {
        return page.evaluate((a) => {
            const w = window as any;
            w.__testApi.notesMessages.length = 0;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-out-node-assets',
                JSON.stringify({ v: 1, outFileKey: null, nodeId: 'src-node', assets: [{ kind: 'file', filePath: 'files/a.pdf' }] }));
            dt.setData('application/x-fractal-out-node-subtree', JSON.stringify({ nodeId: 'src-node' }));
            const item = document.querySelector(`.file-panel-item[data-item-id="${a.hoverItemId}"]`) as HTMLElement;
            const r = item.getBoundingClientRect();
            item.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height * a.ratio,
            }));
            const gapEl = a.gap === 'list'
                ? document.getElementById('notesFileList') as HTMLElement
                : document.querySelector('.file-panel-folder-children') as HTMLElement;
            const gr = gapEl.getBoundingClientRect();
            gapEl.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt, clientX: gr.left + 10, clientY: gr.bottom - 2,
            }));
            const msgs = w.__testApi.notesMessages.filter((m: any) => m.type === 'notesRegisterNodeAssets');
            return msgs.length ? { parentId: msgs[0].parentId, index: msgs[0].index } : null;
        }, { hoverItemId, ratio, gap });
    }

    test('m1 の下半分で線を出してから listEl の隙間に drop → m1 の直後（index 1）。末尾（3）ではない', async ({ page }) => {
        await setup(page);
        const got = await hoverThenGapDrop(page, 'm1', 0.9, 'list');
        expect(got, '添付経路が発火しない').toBeTruthy();
        // counterfactual: 旧実装は listEl 谷間 = rootIds.length（= 3）固定 → RED
        expect(got!.parentId).toBeNull();
        expect(got!.index, '谷間 drop が末尾に落ちた（直近の線を見ていない）').toBe(1);
    });

    test('m2 の上半分で線を出してから listEl の隙間に drop → m2 の直前（index 2）', async ({ page }) => {
        await setup(page);
        const got = await hoverThenGapDrop(page, 'm2', 0.1, 'list');
        expect(got!.index).toBe(2);
    });

    test('線が無い（dragover を経ない）listEl 谷間 drop は従来どおり末尾', async ({ page }) => {
        await setup(page);
        const got = await dropAssets(page, 'list', [{ kind: 'file', filePath: 'files/a.pdf' }]);
        expect(got!.parentId).toBeNull();
        expect(got!.index).toBe(3);
    });

    test('children の隙間: 線が別階層（root の m2）なら採用せずフォルダ末尾（parentId=dir1, index 0）', async ({ page }) => {
        await setup(page);
        const got = await hoverThenGapDrop(page, 'm2', 0.1, 'children');
        expect(got!.parentId).toBe('dir1');
        expect(got!.index).toBe(0);
    });
});
