/**
 * linkedfd 内一括移動 / 一括複製の host 端（FR-FMV-01/03 / FR-CBD-07 / NFR-FMV-01/02 / ADRL-0120）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove / TASK-08
 *
 * TC-FMV-09（件数ゲート）/ TC-FMV-10（集計通知 1 回）/ TC-FMV-11（sendFolderViewList の uniq）
 * + ADRL-0120 の `mode:'copy'`（TASK-17 の H が使う経路の host 側）。
 *
 * ハーネスは既存 `folder-view-fsops.spec.ts` と同型（vscode stub + 実 fs の tmp root）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;

function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: {}, env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

function setupLinked() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmv-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmv-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    return { mod, m, id, root };
}

function makeFvDeps() {
    const calls = { errors: [] as string[] };
    const deps = {
        showInputBox: async () => undefined,
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        t: (_k: string) => undefined as any,
        trashDelete: async () => { /* noop */ },
        openMdInSidePanel: () => { /* noop */ },
        openViewerPanel: () => { /* noop */ },
        openExternal: () => { /* noop */ },
        ensureResourceRoot: () => { /* noop */ },
        renameFs: (a: string, b: string) => { fs.renameSync(a, b); },
        revealInOS: () => { /* noop */ },
        clipboardWriteText: () => { /* noop */ },
    };
    return { deps, calls };
}

/** batch runner が使う deps（件数ゲート / 集計通知）。呼び出しを記録する */
function makeMoveDeps() {
    const calls = { confirmLarge: [] as number[], limitExceeded: [] as string[], outcome: [] as any[] };
    let approve = true;
    const moveDeps = {
        confirmLarge: (n: number) => { calls.confirmLarge.push(n); return approve; },
        notifyLimitExceeded: (e: string) => { calls.limitExceeded.push(e); },
        notifyOutcome: (o: any) => { calls.outcome.push(o); },
        // md 分岐（ADRL-0102）用。本 spec は .txt しか使わないので最小
        deleteFile: async () => { /* noop */ },
    };
    return { moveDeps, calls, setApprove: (v: boolean) => { approve = v; } };
}
const makeSender = () => { const messages: any[] = []; return { sender: { postMessage: (m: any) => messages.push(m) }, messages }; };

test('TC-FMV-11 集計通知 1 回 + sendFolderViewList は uniq して 1 回ずつ', async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps } = makeFvDeps();
    const { moveDeps, calls: mCalls } = makeMoveDeps();
    const { sender, messages } = makeSender();
    fs.mkdirSync(path.join(root, 'dst'));
    for (const f of ['a.txt', 'b.txt', 'c.txt']) { fs.writeFileSync(path.join(root, f), f); }

    const r = await mod.folderViewMoveBatch(m, id, ['a.txt', 'b.txt', 'c.txt'], 'dst', 'move',
        deps as any, sender as any, moveDeps as any);

    expect(r.verdict, '件数ゲートを通っていない（201 件未満なので ok のはず）').toBe('ok');
    expect(r.outcome.succeeded, '3 件すべてが移動していない').toBe(3);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
        expect(fs.existsSync(path.join(root, 'dst', f)), `${f} が移動していない`).toBe(true);
        expect(fs.existsSync(path.join(root, f)), `${f} が元の場所に残っている`).toBe(false);
    }
    // 🔴 sendFolderViewList は「src 親（''）+ dst」の 2 回だけ（per-item だと最大 2N = 6 回）
    const lists = messages.filter((x) => x.type === 'folderViewListResult');
    expect(lists.length, `再描画メッセージが uniq されていない（2N 回飛んでいる）: ${lists.length}`).toBe(2);
    const rels = lists.map((x) => x.relPath).sort();
    expect(rels, 'src 親と dst の 2 つになっていない').toEqual(['', 'dst']);
});

test('TC-FMV-10 per-item 通知を抑止して集計 1 回にする（トースト洪水を作らない）', async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps, calls } = makeFvDeps();
    const { moveDeps, calls: mCalls } = makeMoveDeps();
    const { sender } = makeSender();
    fs.mkdirSync(path.join(root, 'dst'));
    for (const f of ['a.txt', 'b.txt', 'c.txt']) { fs.writeFileSync(path.join(root, f), f); }
    // dst に同名 b.txt を置いて 1 件だけ衝突させる（folderViewNameConflict を誘発）
    fs.writeFileSync(path.join(root, 'dst', 'b.txt'), 'existing');

    const r = await mod.folderViewMoveBatch(m, id, ['a.txt', 'b.txt', 'c.txt'], 'dst', 'move',
        deps as any, sender as any, moveDeps as any);

    expect(r.outcome.succeeded, '衝突しなかった 2 件が移動していない').toBe(2);
    // 既存 `runBatchTransfer` の分類契約: **`ok:false` → skipped（+ reason）/ 例外 → failed**。
    // 名前衝突は「実行したが受理されなかった」= skipped 側に入る（第 3 の分類を発明しない）。
    expect(r.outcome.skipped, '衝突した 1 件が skipped に計上されていない').toBe(1);
    expect(r.outcome.failed, '例外でもないのに failed に計上された').toBe(0);
    expect(r.outcome.reasons, '理由が集計されていない（集計通知に出せない）').toHaveProperty('transfer_failed', 1);
    // 🔴 per-item の showErrorMessage が抑止されている（3 件回して 1 件失敗 → 0 回）
    expect(calls.errors, `per-item トーストが出ている（集計通知 1 回に委ねるはず）: ${JSON.stringify(calls.errors)}`).toEqual([]);
    // 集計通知は runBatchTransfer が 1 回だけ出す
    expect(mCalls.outcome.length, '集計通知が 1 回でない').toBe(1);
    // 衝突した実体は無傷
    expect(fs.readFileSync(path.join(root, 'dst', 'b.txt'), 'utf8'), '衝突先が上書きされた').toBe('existing');
    expect(fs.existsSync(path.join(root, 'b.txt')), '衝突した source が消えた').toBe(true);
});

test('TC-FMV-09 件数ゲートを通る（>2000 は 0 件処理で中断 / 201-2000 は確認 modal）', async () => {
    // >2000 = abort（0 件処理）
    {
        const { mod, m, id, root } = setupLinked();
        const { deps } = makeFvDeps();
        const { moveDeps, calls: mCalls } = makeMoveDeps();
        const { sender } = makeSender();
        fs.mkdirSync(path.join(root, 'dst'));
        const ids: string[] = [];
        for (let i = 0; i < 2001; i++) { const f = `f${i}.txt`; fs.writeFileSync(path.join(root, f), 'x'); ids.push(f); }
        const r = await mod.folderViewMoveBatch(m, id, ids, 'dst', 'move', deps as any, sender as any, moveDeps as any);
        expect(r.verdict, '>2000 で中断していない').toBe('abort');
        expect(r.outcome.succeeded, '中断なのに移動が起きた（0 件処理でない）').toBe(0);
        expect(mCalls.limitExceeded, '上限超過の通知が出ていない').toEqual(['too_many']);
        expect(fs.readdirSync(path.join(root, 'dst')).length, '出力先に何か移動した').toBe(0);
    }
    // 201〜2000 = 確認 modal。キャンセルで 0 件処理
    {
        const { mod, m, id, root } = setupLinked();
        const { deps } = makeFvDeps();
        const { moveDeps, calls: mCalls, setApprove } = makeMoveDeps();
        const { sender } = makeSender();
        setApprove(false);
        fs.mkdirSync(path.join(root, 'dst'));
        const ids: string[] = [];
        for (let i = 0; i < 250; i++) { const f = `g${i}.txt`; fs.writeFileSync(path.join(root, f), 'x'); ids.push(f); }
        const r = await mod.folderViewMoveBatch(m, id, ids, 'dst', 'move', deps as any, sender as any, moveDeps as any);
        expect(mCalls.confirmLarge, '201 件超で確認 modal が出ていない').toEqual([250]);
        expect(r.verdict, 'キャンセルが cancel になっていない').toBe('cancel');
        expect(fs.readdirSync(path.join(root, 'dst')).length, 'キャンセルなのに移動した（0 件処理でない）').toBe(0);
    }
});

test("ADRL-0120 mode:'copy' は source を残して uniquify 複製する（H の host 側）", async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps } = makeFvDeps();
    const { moveDeps } = makeMoveDeps();
    const { sender } = makeSender();
    fs.mkdirSync(path.join(root, 'dst'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'body');
    fs.writeFileSync(path.join(root, 'dst', 'a.txt'), 'existing');   // 同名あり → uniquify

    const r = await mod.folderViewMoveBatch(m, id, ['a.txt'], 'dst', 'copy',
        deps as any, sender as any, moveDeps as any);

    expect(r.outcome.succeeded, 'copy が成功していない').toBe(1);
    expect(fs.existsSync(path.join(root, 'a.txt')), "mode:'copy' なのに source が消えた（INV-3 違反）").toBe(true);
    expect(fs.readFileSync(path.join(root, 'dst', 'a.txt'), 'utf8'), '同名を上書きした（uniquify されていない）').toBe('existing');
    const names = fs.readdirSync(path.join(root, 'dst'));
    expect(names.length, 'uniquify した複製が作られていない').toBe(2);
    expect(names.some((n) => n !== 'a.txt' && /\.txt$/.test(n)), `uniquify 名が生成されていない: ${names.join(',')}`).toBe(true);
});

test("TC-CBD-45 ADRL-0120 既定は 'move'（D&D の移動意味論が複製に化けない）", async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps } = makeFvDeps();
    const { moveDeps } = makeMoveDeps();
    const { sender } = makeSender();
    fs.mkdirSync(path.join(root, 'dst'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'body');
    // mode を渡さない = 既定 'move'
    expect(await mod.folderViewMove(m, id, 'a.txt', 'dst', deps as any, sender as any, moveDeps as any)).toBe(true);
    expect(fs.existsSync(path.join(root, 'a.txt')), "既定が 'copy' になっている（D&D が複製に化ける = TC-CBD-45 の趣旨）").toBe(false);
});

/**
 * TC-FMV-13 / TC-FMV-14（reviewer iteration 1 QUAL-6 / NFR-FMV-02 / TASK-18）
 *
 * `folderViewMoveBatch` は per-item 通知を止めるため `quietDeps`（`FolderViewDeps`）を作るが、
 * **同じ関数に渡すもう一方の `moveDeps`（`FolderMoveDeps`。独自に `showErrorMessage` を持つ）**を
 * wrap し忘れていた。md 分岐の随伴資産の部分失敗は `cleanupFvMoveSource(moveDeps, ...)` 経由で
 * 通知されるため、batch 実行中に per-item トーストが漏れる。
 *
 * さらに `cleanupFvMoveSource` は部分失敗でも `return;` するだけで `folderViewMove` は `true` を返すので、
 * **その item は集計上「成功」に数えられ失敗が利用者に届かない**。
 *
 * counterfactual（iteration 1 の実装で観測した値）:
 *   moveDeps.showErrorMessage 呼び出し = 1 回 / outcome = { succeeded: 3, skipped: 0 }
 */
function makeMoveDepsWithToast() {
    const calls = {
        confirmLarge: [] as number[], limitExceeded: [] as string[], outcome: [] as any[],
        errors: [] as string[],
    };
    const moveDeps = {
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        t: (_k: string) => undefined as any,
        trashDelete: async (p: string) => { fs.rmSync(p, { recursive: true, force: true }); },
        deleteFile: async (p: string) => { fs.rmSync(p, { recursive: true, force: true }); },
        toDisplayUri: (p: string) => p,
        confirmLarge: (n: number) => { calls.confirmLarge.push(n); return true; },
        notifyLimitExceeded: (e: string) => { calls.limitExceeded.push(e); },
        notifyOutcome: (o: any) => { calls.outcome.push(o); },
    };
    return { moveDeps, calls };
}

/** a.md（読取不能な随伴資産を持つ）+ b.md + c.md。a.md だけ copyFailed になる */
function mkMdBatchFixtureWithFailingAsset(root: string): () => void {
    fs.mkdirSync(path.join(root, 'dst'), { recursive: true });
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    const pdf = path.join(root, 'files', 'a.pdf');
    fs.writeFileSync(pdf, 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\n[📎 a.pdf](files/a.pdf)\n', 'utf8');
    fs.writeFileSync(path.join(root, 'b.md'), '# B\n', 'utf8');
    fs.writeFileSync(path.join(root, 'c.md'), '# C\n', 'utf8');
    fs.chmodSync(pdf, 0o000);   // source 読取不能 → copyFailed（既存 TC-ACD-01(b) と同じ誘発法）
    return () => { try { fs.chmodSync(pdf, 0o644); } catch { /* noop */ } };
}

test('TC-FMV-13 batch 中の md 部分失敗で per-item トーストが出ない（NFR-FMV-02）', async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps } = makeFvDeps();
    const { moveDeps, calls } = makeMoveDepsWithToast();
    const { sender } = makeSender();
    const restore = mkMdBatchFixtureWithFailingAsset(root);
    try {
        await mod.folderViewMoveBatch(m, id, ['a.md', 'b.md', 'c.md'], 'dst', 'move',
            deps as any, sender as any, moveDeps as any);
    } finally { restore(); }

    expect(calls.errors.length,
        `moveDeps.showErrorMessage が per-item で発火した（quietDeps が FolderViewDeps しか wrap していない）: ${JSON.stringify(calls.errors)}`)
        .toBe(0);
    // 集計通知の側は 1 回出る（失敗があるので notifyOutcome は呼ばれる）
    expect(calls.outcome.length, '集計通知が 1 回出ていない').toBe(1);
});

test('TC-FMV-14 md 部分失敗は集計に載る（成功に数えない）', async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps } = makeFvDeps();
    const { moveDeps, calls } = makeMoveDepsWithToast();
    const { sender } = makeSender();
    const restore = mkMdBatchFixtureWithFailingAsset(root);
    let r: any;
    try {
        r = await mod.folderViewMoveBatch(m, id, ['a.md', 'b.md', 'c.md'], 'dst', 'move',
            deps as any, sender as any, moveDeps as any);
    } finally { restore(); }

    expect(r.outcome.succeeded,
        `部分失敗した a.md が成功に数えられている（succeeded=${r.outcome.succeeded} / 期待 2）`).toBe(2);
    expect(r.outcome.skipped + r.outcome.failed,
        '部分失敗が集計に 1 件も現れない（利用者が失敗を検知できない）').toBe(1);
    // データ保護（既存 FR-ACD-01 の全成功ゲート）は不変: 部分失敗した md と資産は source に残る
    expect(fs.existsSync(path.join(root, 'a.md')), '部分失敗で source md が消された（データロス）').toBe(true);
    expect(fs.existsSync(path.join(root, 'files', 'a.pdf')), '部分失敗で source 資産が消された').toBe(true);
});

/**
 * TC-FMV-15（reviewer iteration 1 SEC-3 / TASK-19）: linkedfd 内一括移動/複製の確認 modal 文言。
 *
 * `folderViewMoveBatch` が処理するのは FR-FMV-01（**同一 linkedfd 内**の複数選択 D&D 移動）と
 * FR-CBD-07（**同一 linkedfd 内**の clipboard 複製）で、どちらも「このフォルダから取り込む」動作ではない。
 * `folderMoveDeps`（`importFolderConfirm` = "Import {count} items from this folder?" / ボタン "Import"）を
 * 渡すと、実際には move/copy なのに Import と表示される。linkedfd 側の fs 移動・複製は **undo を持たない**ので
 * この modal が唯一の informed consent ゲートであり、文言の不正確さは governance 上の欠陥。
 *
 * provider の handler は巨大クロージャ内で behavioral 起動不能なため、
 * 既存 precedent（`batch-dnd-host.spec.ts` TC-MSEL-26b）と同じ **source guard** で配線を pin する。
 */
test('TC-FMV-15 folderViewMoveBatch の host wiring は Transfer 文言（platformBatchDeps）を渡す', () => {
    const PROVIDER = path.join(__dirname, '..', '..', 'src', 'notesEditorProvider.ts');
    const src = fs.readFileSync(PROVIDER, 'utf8');

    const at = src.indexOf('folderViewMoveBatch:');
    expect(at, 'folderViewMoveBatch の wiring が provider に無い').toBeGreaterThan(-1);
    const win = src.slice(at, at + 700);

    expect(win.includes('platformBatchDeps'),
        'folderViewMoveBatch が platformBatchDeps を渡していない（Import 文言のまま = SEC-3）')
        .toBe(true);
    expect(/\bfolderMoveDeps\b/.test(win.slice(0, win.indexOf('platformBatchDeps') + 'platformBatchDeps'.length)),
        'folderMoveDeps（Import 文言）をまだ渡している')
        .toBe(false);

    // platformBatchDeps 側が Transfer 系の i18n キーを使っていること（文言の実体）
    const pAt = src.indexOf('const platformBatchDeps');
    expect(pAt, 'platformBatchDeps の定義が無い').toBeGreaterThan(-1);
    const pWin = src.slice(pAt, pAt + 500);
    expect(pWin.includes('batchTransferConfirm'), 'platformBatchDeps が batchTransferConfirm を使っていない').toBe(true);
    expect(pWin.includes('batchTransferTooMany'), 'platformBatchDeps が batchTransferTooMany を使っていない').toBe(true);
    expect(pWin.includes('importFolderConfirm'), 'platformBatchDeps に Import 文言が混ざっている').toBe(false);
});

/**
 * TC-CBD-46（reviewer iteration 1 QUAL-1 / TASK-20）: `mode==='copy'` のフォルダ早期 return が無通知だった。
 *
 * `folderViewMove` の他の失敗分岐（`folderLinkBroken` / `folderViewMoveIntoSelf` /
 * `notifyOperationFailed` / `folderViewOperationFailed` / `folderViewNameConflict`）は**すべて通知する**のに
 * この分岐だけ黙って `return false` していた。`dispatchFvMove` は `ids.length === 1` のとき batch を
 * 経由せず単数 bridge を直接呼ぶため、**フォルダ 1 件だけを cmd+c → cmd+v すると集計通知も出ず完全に無反応**。
 * 既存 TC-CBD-43 は「2 file + 1 folder」= batch 経由なのでこの単一ケースを踏んでいない。
 *
 * counterfactual（iteration 1）: errors.length = 0（= 無反応）
 */
test('TC-CBD-46 単一フォルダの H（mode copy）で無反応にならない', async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps, calls } = makeFvDeps();
    const { moveDeps } = makeMoveDepsWithToast();
    const { sender } = makeSender();
    fs.mkdirSync(path.join(root, 'srcdir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'srcdir', 'inner.txt'), 'x', 'utf8');
    fs.mkdirSync(path.join(root, 'dst'), { recursive: true });

    const ok = await mod.folderViewMove(m, id, 'srcdir', 'dst',
        deps as any, sender as any, moveDeps as any, 'copy');

    expect(ok, 'フォルダの copy は受理しない契約（ADRL-0120 の受容事項）なので false のはず').toBe(false);
    expect(calls.errors.length,
        'フォルダ skip が無通知（単一アイテム経路では集計通知も出ないので cmd+v が完全に無反応になる）')
        .toBe(1);
    // source は不変（skip なので何もしない）
    expect(fs.existsSync(path.join(root, 'srcdir', 'inner.txt')), 'source が触られた').toBe(true);
    expect(fs.existsSync(path.join(root, 'dst', 'srcdir')), 'フォルダが複製されてしまった').toBe(false);
});

/**
 * TC-CBD-44（reviewer iteration 1 DET-2 / TASK-26 / FR-CBD-07 / ADRL-0120）:
 * H（linkedfd 内 clipboard 複製）で md を複製すると**隣接資産も随伴**し、**source 側は完全に残る**。
 *
 * ADRL-0120 の実装は「md 分岐は `transferMdWithAssets` を通し、`mode==='copy'` では
 * `cleanupFvMoveSource` を呼ばない」形。`copyEntityWithUniquify`（非 md 分岐のコピー）で md を
 * 扱ってしまうと**資産を置いていく**誤実装になるので、その分岐ミスを検出する番人。
 */
test('TC-CBD-44 md の cross-dir 複製で隣接資産が随伴し source は残る', async () => {
    const { mod, m, id, root } = setupLinked();
    const { deps } = makeFvDeps();
    const { moveDeps } = makeMoveDepsWithToast();
    const { sender } = makeSender();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    fs.mkdirSync(path.join(root, 'images'), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', 'a.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(root, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\n![i](images/pic.png)\n[📎 a.pdf](files/a.pdf)\n', 'utf8');

    const ok = await mod.folderViewMove(m, id, 'a.md', 'docs',
        deps as any, sender as any, moveDeps as any, 'copy');
    expect(ok, 'md の copy が成立していない').toBe(true);

    // dst に md 本体
    expect(fs.existsSync(path.join(root, 'docs', 'a.md')), 'dst に md が出来ていない').toBe(true);
    // dst 配下のどこかに資産が随伴していること（配置は transferMdWithAssets の既存規則に委ねる）
    const walk = (dir: string, acc: string[] = []): string[] => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { walk(abs, acc); } else { acc.push(abs); }
        }
        return acc;
    };
    const dstFiles = walk(path.join(root, 'docs')).map((p) => path.basename(p));
    expect(dstFiles.includes('a.pdf'),
        `隣接ファイル資産が随伴していない（copyEntityWithUniquify で md を扱っている疑い）: ${JSON.stringify(dstFiles)}`)
        .toBe(true);
    // 画像は既存エンジンが `copy-<ts>-<name>` で uniquify するので**接尾一致**で見る
    // （命名規則そのものは本 TC の対象ではない。既存 makeUniqueImageCopier の契約に委ねる）
    expect(dstFiles.some((f) => /pic\.png$/.test(f)),
        `隣接画像が随伴していない: ${JSON.stringify(dstFiles)}`).toBe(true);

    // 🔴 複製なので source は md も資産も完全に残る（INV-3 / cleanupFvMoveSource を呼ばない）
    expect(fs.existsSync(path.join(root, 'a.md')), 'source md が消えた（copy が move に化けている）').toBe(true);
    expect(fs.existsSync(path.join(root, 'files', 'a.pdf')), 'source の資産が消えた').toBe(true);
    expect(fs.existsSync(path.join(root, 'images', 'pic.png')), 'source の画像が消えた').toBe(true);
});
