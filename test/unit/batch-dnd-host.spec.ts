/**
 * TASK-29 — 複数選択 D&D の host 側 batch 経路（件数上限ゲート + 集計通知 1 回）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit /
 *  FR-MSEL-02 / FR-MSEL-04 / **NFR-MSEL-02** / NFR-MSEL-03 / §4-3b §4-4）
 *
 * TC-MSEL-14（一部失敗 → 集計通知 1 回）/ TC-MSEL-24（2001 件で 0 件処理）/
 * TC-MSEL-25（201 件超の modal キャンセルで no-op）を **実経路**（host handler）から踏む。
 *
 * 🔴 reviewer iteration 1 SEC-1 の再発防止:
 * iteration 1 は同じ TC を `runBatchTransfer` の直接 unit call で書いたが、その関数の
 * 呼び出し元が src 配下にゼロで**上限ゲートが 1 度も通らなかった**（false-green）。
 * 本 spec は host の batch handler（= webview の配列 bridge を受ける口）を叩くので、
 * 配線が外れると RED になる。
 */
import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
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
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

/** deps。`trashDelete` は実際に unlink する（本番 `workspace.fs.delete` 相当）。 */
function makeDeps(opts?: { confirm?: boolean }) {
    const calls = {
        errors: [] as string[],
        trash: [] as string[],
        confirmLarge: [] as number[],
        limitExceeded: [] as string[],
        outcomes: [] as any[],
    };
    const deps = {
        showErrorMessage: (m: string) => { calls.errors.push(m); },
        t: (_k: string) => undefined as any,
        trashDelete: async (abs: string, recursive: boolean) => {
            calls.trash.push(abs);
            try { fs.rmSync(abs, { recursive, force: true }); } catch { /* best effort */ }
        },
        toDisplayUri: (abs: string) => 'vscode-resource://' + abs,
        // batch 用（§4-3b / §4-4）
        confirmLarge: (n: number) => { calls.confirmLarge.push(n); return opts?.confirm !== false; },
        notifyLimitExceeded: (e: string) => { calls.limitExceeded.push(e); },
        notifyOutcome: (o: any) => { calls.outcomes.push(o); },
    };
    return { deps, calls };
}
function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => messages.push(m) }, messages };
}

function setup() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdh-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdh-fv-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    const cleanup = () => {
        for (const d of [noteDir, root]) {
            try { fs.chmodSync(d, 0o755); } catch { /* ignore */ }
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    };
    // ⚠️ `registerFolderLink` は folder link 自身を tree item として登録する（= 転送前でも items が空でない）。
    // 件数は**絶対値ではなく baseline からの増分**で数える。
    const baseItems = Object.keys(m.getStructure().items).length;
    return { mod, m, id, root, noteDir, cleanup, baseItems };
}

function sha(p: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test.describe('TC-MSEL-24 件数上限（2001 件で 0 件処理・実経路）', () => {
    test('fv→tree: 2001 件は 1 件も登録されず上限通知 1 回', async () => {
        const s = setup();
        const { deps, calls } = makeDeps();
        const { sender } = makeSender();
        try {
            const items: any[] = [];
            for (let i = 0; i < 2001; i++) {
                const rel = `f${i}.txt`;
                fs.writeFileSync(path.join(s.root, rel), 'x', 'utf8');
                items.push({ folderLinkId: s.id, relPath: rel });
            }
            await s.mod.folderViewMoveToTreeBatch(s.m, s.id, items, null, 0, deps as any, sender as any);

            // ★ 1 件も登録されない（部分実行しない）
            const registered = Object.keys(s.m.getStructure().items).length - s.baseItems;
            expect(registered, `2001 件で ${registered} item 登録された（部分実行）`).toBe(0);
            expect(calls.limitExceeded, `上限通知が 1 回でない: ${calls.limitExceeded.join(',')}`).toEqual(['too_many']);
            expect(calls.confirmLarge.length, '上限超過で confirm modal が出た').toBe(0);
            // 実体も作られない
            expect(fs.existsSync(path.join(s.noteDir, 'files')) ? fs.readdirSync(path.join(s.noteDir, 'files')) : [])
                .toEqual([]);
        } finally { s.cleanup(); }
    });

    test('tree→fv: 2001 件も同様に 0 件処理', async () => {
        const s = setup();
        const { deps, calls } = makeDeps();
        const { sender } = makeSender();
        try {
            const items: any[] = [];
            for (let i = 0; i < 2001; i++) {
                const fid = s.m.registerTreeFile(`t${i}.txt`, `t${i}.txt`, null, 0, Buffer.from('x'));
                items.push({ srcKind: 'file', srcItemId: fid });
            }
            const before = Object.keys(s.m.getStructure().items).length;
            await s.mod.folderViewMoveInBatch(s.m, s.id, '', items, deps as any, sender as any);

            expect(calls.limitExceeded, '上限通知が 1 回でない').toEqual(['too_many']);
            // fv 側に 1 件も複製されない
            expect(fs.readdirSync(s.root), `dest に複製された: ${fs.readdirSync(s.root).join(',')}`).toEqual([]);
            // note 側の台帳も不変
            expect(Object.keys(s.m.getStructure().items).length).toBe(before);
        } finally { s.cleanup(); }
    });
});

test.describe('TC-MSEL-25 確認 modal（201 件超・キャンセルで no-op・実経路）', () => {
    test('fv→tree: 201 件で modal → キャンセルなら 0 件', async () => {
        const s = setup();
        const { deps, calls } = makeDeps({ confirm: false });
        const { sender } = makeSender();
        try {
            const items: any[] = [];
            for (let i = 0; i < 201; i++) {
                const rel = `g${i}.txt`;
                fs.writeFileSync(path.join(s.root, rel), 'x', 'utf8');
                items.push({ folderLinkId: s.id, relPath: rel });
            }
            await s.mod.folderViewMoveToTreeBatch(s.m, s.id, items, null, 0, deps as any, sender as any);

            expect(calls.confirmLarge, `modal が 1 回でない / 件数違い: ${calls.confirmLarge.join(',')}`).toEqual([201]);
            expect(Object.keys(s.m.getStructure().items).length - s.baseItems,
                'キャンセルなのに登録された').toBe(0);
        } finally { s.cleanup(); }
    });

    test('fv→tree: 201 件で続行なら全件登録される', async () => {
        const s = setup();
        const { deps, calls } = makeDeps({ confirm: true });
        const { sender } = makeSender();
        try {
            const items: any[] = [];
            for (let i = 0; i < 201; i++) {
                const rel = `h${i}.txt`;
                fs.writeFileSync(path.join(s.root, rel), 'x', 'utf8');
                items.push({ folderLinkId: s.id, relPath: rel });
            }
            await s.mod.folderViewMoveToTreeBatch(s.m, s.id, items, null, 0, deps as any, sender as any);

            expect(calls.confirmLarge).toEqual([201]);
            const n = Object.keys(s.m.getStructure().items).length - s.baseItems;
            expect(n, `続行を選んだのに ${n} 件しか登録されない`).toBe(201);
        } finally { s.cleanup(); }
    });

    test('200 件以下は modal を出さずそのまま実行', async () => {
        const s = setup();
        const { deps, calls } = makeDeps();
        const { sender } = makeSender();
        try {
            const items: any[] = [];
            for (let i = 0; i < 200; i++) {
                const rel = `k${i}.txt`;
                fs.writeFileSync(path.join(s.root, rel), 'x', 'utf8');
                items.push({ folderLinkId: s.id, relPath: rel });
            }
            await s.mod.folderViewMoveToTreeBatch(s.m, s.id, items, null, 0, deps as any, sender as any);
            expect(calls.confirmLarge.length, '200 件で modal が出た（閾値は 200 超）').toBe(0);
            expect(Object.keys(s.m.getStructure().items).length - s.baseItems).toBe(200);
        } finally { s.cleanup(); }
    });
});

test.describe('TC-MSEL-14 一部失敗 → 集計通知 1 回（NFR-MSEL-03）', () => {
    test('5 件中 1 件が読取不能でも他 4 件は成功し、通知は 1 回だけ', async () => {
        const s = setup();
        const { deps, calls } = makeDeps();
        const { sender } = makeSender();
        try {
            const items: any[] = [];
            for (let i = 0; i < 5; i++) {
                const rel = `m${i}.txt`;
                fs.writeFileSync(path.join(s.root, rel), `DATA-${i}`, 'utf8');
                items.push({ folderLinkId: s.id, relPath: rel });
            }
            // #2 を読取不能にする
            const bad = path.join(s.root, 'm2.txt');
            fs.chmodSync(bad, 0o000);
            let readable = true;
            try { fs.readFileSync(bad); } catch { readable = false; }
            if (readable) { test.skip(true, 'chmod 000 が効かない環境（root 実行）'); }

            await s.mod.folderViewMoveToTreeBatch(s.m, s.id, items, null, 0, deps as any, sender as any);

            // 成功 4 / 失敗 1
            const fileItems = (Object.values(s.m.getStructure().items) as any[])
                .filter((it) => it.type === 'file' && it.ext === 'file');
            expect(fileItems.length, `成功 4 件でない（実際 ${fileItems.length}）— 1 件の失敗が他に波及した`).toBe(4);

            // ★ NFR-MSEL-03: 集計通知は **1 回だけ**（アイテム毎に出さない）
            expect(calls.outcomes.length,
                `集計通知が ${calls.outcomes.length} 回（1 回であるべき）`).toBe(1);
            expect(calls.outcomes[0].succeeded).toBe(4);
            expect(calls.outcomes[0].failed + calls.outcomes[0].skipped, '失敗 1 件が集計に出ていない').toBe(1);

            // FR-DCP-01: 複製なので linkedfd 側は 5 件すべて残る
            for (let i = 0; i < 5; i++) {
                expect(fs.existsSync(path.join(s.root, `m${i}.txt`)), `linkedfd の m${i}.txt が消えた`).toBe(true);
            }
            expect(calls.trash.length, 'fv→tree で trash が走った（複製化違反）').toBe(0);
        } finally {
            try { fs.chmodSync(path.join(s.root, 'm2.txt'), 0o644); } catch { /* ignore */ }
            s.cleanup();
        }
    });

    test('全成功なら集計通知を出さない（成功時のノイズを作らない）', async () => {
        const s = setup();
        const { deps, calls } = makeDeps();
        const { sender } = makeSender();
        try {
            const items: any[] = [];
            for (let i = 0; i < 3; i++) {
                const rel = `n${i}.txt`;
                fs.writeFileSync(path.join(s.root, rel), 'x', 'utf8');
                items.push({ folderLinkId: s.id, relPath: rel });
            }
            await s.mod.folderViewMoveToTreeBatch(s.m, s.id, items, null, 0, deps as any, sender as any);
            expect(calls.outcomes.length, '全成功で通知が出た').toBe(0);
            expect(Object.keys(s.m.getStructure().items).length - s.baseItems).toBe(3);
        } finally { s.cleanup(); }
    });

    test('🔴 1 件の失敗が他の item の source を消さない（禁止パターンの検出器）', async () => {
        const s = setup();
        const { deps } = makeDeps();
        const { sender } = makeSender();
        try {
            // tree→fv（移動ではなく複製だが、失敗の波及を見る）
            const ids: string[] = [];
            for (let i = 0; i < 3; i++) {
                ids.push(s.m.registerTreeFile(`p${i}.txt`, `p${i}.txt`, null, 0, Buffer.from(`P-${i}`)));
            }
            const shas = ids.map((id) => sha(s.m.getTreeFilePath(id)!));
            // dest を書込不能にして全件失敗させる
            fs.chmodSync(s.root, 0o500);
            let writable = true;
            try { fs.writeFileSync(path.join(s.root, '.probe'), 'x'); } catch { writable = false; }
            if (writable) { test.skip(true, 'chmod 500 が効かない環境（root 実行）'); }

            await s.mod.folderViewMoveInBatch(s.m, s.id, '',
                ids.map((id) => ({ srcKind: 'file', srcItemId: id })), deps as any, sender as any);

            // note 側は全件不変（台帳 + 実体の sha256）
            for (let i = 0; i < ids.length; i++) {
                expect(s.m.getStructure().items[ids[i]], `失敗時に台帳 item ${i} が除去された`).toBeTruthy();
                expect(sha(s.m.getTreeFilePath(ids[i])!), `失敗時に実体 ${i} が変わった`).toBe(shas[i]);
            }
        } finally {
            try { fs.chmodSync(s.root, 0o755); } catch { /* ignore */ }
            s.cleanup();
        }
    });
});

/**
 * TC-MSEL-24b / 24c（host 層）— note tree → outliner / md の件数ゲート
 * （TASK-35 / reviewer iteration 2 SEC-3）
 *
 * TASK-29 は fv⇄tree の 2 方向しか直さず、FR-MSEL-04 が定義する残り 2 面は N 回ループのままだった。
 * `runPlatformBatch` を通すことで 3 面すべてが同じゲートを共有する。
 *
 * 🔴 ここでは **platform 呼び出しが実際に何回起きたか**で数える（呼び出し回数 = 処理件数）。
 */
test.describe('TC-MSEL-24b / 24c 件数ゲート（note tree → outliner / md）', () => {
    function makeBatchDeps(opts?: { confirm?: boolean }) {
        const calls = { confirm: [] as number[], limit: [] as string[], outcomes: [] as any[] };
        return {
            calls,
            deps: {
                confirmLarge: (n: number) => { calls.confirm.push(n); return opts?.confirm !== false; },
                notifyLimitExceeded: (e: string) => { calls.limit.push(e); },
                notifyOutcome: (o: any) => { calls.outcomes.push(o); },
            },
        };
    }

    test('2001 件は 1 件も処理されず上限通知 1 回（runPlatformBatch）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { deps, calls } = makeBatchDeps();
        const items = Array.from({ length: 2001 }, (_, i) => String(i));
        let processed = 0;
        const r = await mod.runPlatformBatch(items, () => { processed += 1; }, deps);

        expect(r.verdict).toBe('abort');
        expect(processed, `2001 件で ${processed} 件処理された（部分実行）`).toBe(0);
        expect(calls.limit, `上限通知が 1 回でない: ${calls.limit.join(',')}`).toEqual(['too_many']);
        expect(calls.confirm.length, '上限超過で confirm modal が出た').toBe(0);
    });

    test('201 件で modal → キャンセルなら 0 件処理', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { deps, calls } = makeBatchDeps({ confirm: false });
        let processed = 0;
        const r = await mod.runPlatformBatch(
            Array.from({ length: 201 }, (_, i) => String(i)), () => { processed += 1; }, deps);
        expect(r.verdict).toBe('cancel');
        expect(processed, `キャンセルなのに ${processed} 件処理された`).toBe(0);
        expect(calls.confirm, 'modal が 1 回でない / 件数が違う').toEqual([201]);
    });

    test('201 件で続行なら全件処理される', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { deps, calls } = makeBatchDeps({ confirm: true });
        let processed = 0;
        await mod.runPlatformBatch(
            Array.from({ length: 201 }, (_, i) => String(i)), () => { processed += 1; }, deps);
        expect(processed, '続行を選んだのに全件処理されない').toBe(201);
        expect(calls.confirm).toEqual([201]);
    });

    test('200 件以下は modal を出さずそのまま実行', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { deps, calls } = makeBatchDeps();
        let processed = 0;
        await mod.runPlatformBatch(
            Array.from({ length: 200 }, (_, i) => String(i)), () => { processed += 1; }, deps);
        expect(processed).toBe(200);
        expect(calls.confirm.length, '200 件で modal が出た（閾値は 200 超）').toBe(0);
    });

    test('1 件の失敗が他に波及せず集計通知は 1 回だけ（NFR-MSEL-03）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { deps, calls } = makeBatchDeps();
        const done: string[] = [];
        await mod.runPlatformBatch(['a', 'bad', 'c'], (id: string) => {
            if (id === 'bad') { throw new Error('import failed'); }
            done.push(id);
        }, deps);
        expect(done, '失敗が他の item に波及した').toEqual(['a', 'c']);
        expect(calls.outcomes.length, `集計通知が ${calls.outcomes.length} 回（1 回であるべき）`).toBe(1);
        expect(calls.outcomes[0].succeeded).toBe(2);
        expect(calls.outcomes[0].failed).toBe(1);
    });

    test('🔴 deps 未注入なら安全側（上限で中断）に倒れる — 配線漏れが silent に通らない', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        let processed = 0;
        // confirmLarge を注入しない = 201 件超はキャンセル扱い（0 件処理）
        const r = await mod.runPlatformBatch(
            Array.from({ length: 201 }, (_, i) => String(i)), () => { processed += 1; }, {});
        expect(r.verdict, '未注入で ok に落ちた（ゲートを迂回している）').toBe('cancel');
        expect(processed, `未注入なのに ${processed} 件処理された`).toBe(0);
    });
});

/**
 * TC-MSEL-26 — batch 4 経路の per-item 失敗が集計通知に届く（NFR-MSEL-03）
 * （TASK-38 / reviewer iteration 3 **QUAL3-1 ≡ SEC-5**）
 *
 * 🔴 **上の TC-MSEL-24b/24c との違い（これが本 TC の存在理由）**:
 * 24b/24c は `transferOne` に「必ず throw する自作ダミー callback」を渡して
 * `runBatchTransfer` の catch 機構だけを検証していた。だが**実配線されている `transferOne`**
 * （既存の単一 platform 関数）は `void` 返し + 内部 try/catch で失敗を握り潰すため
 * **throw しない** → ラッパーが常に `{ok:true}` を返し `outcome.failed/skipped` が恒久的に 0 →
 * 通知条件 `if (failed > 0 || skipped > 0)` が構造的に真にならず集計通知が発火しない。
 * ダミーは runner 単体の仕組みしか守らず、この配線の断裂を検出できなかった（false confidence）。
 *
 * 本 TC は **実際の seam 関数を `transferOne` に渡す**ので、委譲先が成否を返さない限り RED。
 *
 * 🔴 counterfactual: seam 関数の `return false` を `return;`（void）に戻すと
 * `notifyOutcome` が呼ばれず RED。
 *
 * ⚠️ **検証範囲の申告**: 4 経路のうち `notesImportMdIntoOut` は
 * `notesEditorProvider.ts` の巨大クロージャ内に定義されており（provider + panel + document の
 * フル stub なしに behavioral 起動不能 — designer_failures 2026-08-07 のクラス）、
 * behavioral に踏めるのは残り 3 経路の seam 関数。4 経路目は下の「配線の形」節で
 * 「batch handler が委譲先の返り値を捨てていない」ことを機械照合する。
 */
test.describe('TC-MSEL-26 実 seam 関数の失敗が集計通知に届く（NFR-MSEL-03 / TASK-38）', () => {
    function mkNote(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'bdh-msel26-'));
    }
    function spy() {
        const msgs: any[] = [];
        return { sender: { postMessage: (m: any) => msgs.push(m) }, msgs };
    }
    function batchDeps() {
        const calls = { outcomes: [] as any[], confirm: [] as number[] };
        return {
            calls,
            deps: {
                confirmLarge: (n: number) => { calls.confirm.push(n); return true; },
                notifyLimitExceeded: () => { /* noop */ },
                notifyOutcome: (o: any) => { calls.outcomes.push(o); },
            },
        };
    }

    test('🔴 treeFileAttachToMdEditor: 3 件中 1 件が無効 id → 集計通知 1 回・succeeded 2 / 失敗 1', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const dir = mkNote();
        try {
            const fm = new NotesFileManager(dir);
            const mdId = fm.registerMarkdownFile('# Main\n', 'Main', null, 0);
            fm.openFile(fm.getMdFilePath(mdId));   // currentFile = 添付先
            const okA = fm.registerTreeFile('a.pdf', 'A', null, 0);
            const okB = fm.registerTreeFile('b.pdf', 'B', null, 0);
            const bogus = 'no-such-item-id';       // ← ensureSafeTreeFileName が falsy → 失敗

            const { sender } = spy();
            const { deps, calls } = batchDeps();
            // ★ ダミーではなく **実際の seam 関数** を transferOne に渡す（本 TC の要点）
            await mod.runPlatformBatch([okA, bogus, okB],
                (id: string) => mod.treeFileAttachToMdEditor(fm, sender, id, undefined), deps);

            expect(calls.outcomes.length,
                `集計通知が ${calls.outcomes.length} 回（1 回であるべき）— 委譲先が成否を返していない`).toBe(1);
            expect(calls.outcomes[0].succeeded, '成功件数が実態と一致しない').toBe(2);
            expect(calls.outcomes[0].failed + calls.outcomes[0].skipped, '失敗 1 件が集計に出ていない').toBe(1);
            // 成功した 2 件だけが台帳から除去されている（失敗 1 件は他に波及しない）
            expect(fm.getStructure().items[okA], 'okA が処理されていない').toBeUndefined();
            expect(fm.getStructure().items[okB], 'okB が処理されていない').toBeUndefined();
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('🔴 treeFileImportAtPosition: 無効 id が集計の失敗として数えられる', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const dir = mkNote();
        try {
            const fm = new NotesFileManager(dir);
            const outPath = fm.createFile('OutDoc', null);
            const outId = path.basename(outPath, '.out');
            const okA = fm.registerTreeFile('a.pdf', 'A', null, 0);

            const { sender } = spy();
            const { deps, calls } = batchDeps();
            await mod.runPlatformBatch([okA, 'bogus-id'],
                (id: string) => mod.treeFileImportAtPosition(fm, sender, id, outId, null, null), deps);

            expect(calls.outcomes.length, '集計通知が 1 回でない').toBe(1);
            expect(calls.outcomes[0].succeeded).toBe(1);
            expect(calls.outcomes[0].failed + calls.outcomes[0].skipped).toBe(1);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('🔴 linkMdAsSubpageForSidePanelCore: 存在しない md path が集計の失敗として数えられる', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const dir = mkNote();
        const dst = mkNote();
        try {
            const fm = new NotesFileManager(dir);
            const mdId = fm.registerMarkdownFile('# Doc\nbody', 'Doc', null, 0);
            const okPath = fm.getMdFilePath(mdId);
            const dstMd = path.join(dst, 'panel.md');
            fs.writeFileSync(dstMd, '# dst\n', 'utf8');
            const missing = path.join(dir, 'does-not-exist.md');

            const { sender } = spy();
            const { deps, calls } = batchDeps();
            await mod.runPlatformBatch([okPath, missing],
                (p: string) => mod.linkMdAsSubpageForSidePanelCore(
                    fm, sender, p, p === okPath ? mdId : null, dstMd), deps);

            expect(calls.outcomes.length, '集計通知が 1 回でない').toBe(1);
            expect(calls.outcomes[0].succeeded).toBe(1);
            expect(calls.outcomes[0].failed + calls.outcomes[0].skipped).toBe(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(dst, { recursive: true, force: true });
        }
    });

    test('全成功なら集計通知を出さない（成功時のノイズを作らない — 既存契約の維持）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const dir = mkNote();
        try {
            const fm = new NotesFileManager(dir);
            const mdId = fm.registerMarkdownFile('# Main\n', 'Main', null, 0);
            fm.openFile(fm.getMdFilePath(mdId));
            const ids = ['a.pdf', 'b.pdf'].map((n) => fm.registerTreeFile(n, n, null, 0));

            const { sender } = spy();
            const { deps, calls } = batchDeps();
            await mod.runPlatformBatch(ids,
                (id: string) => mod.treeFileAttachToMdEditor(fm, sender, id, undefined), deps);

            expect(calls.outcomes.length, '全成功で通知が出た').toBe(0);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('🔴 seam 関数が成否を返す契約になっている（void のままなら集計は原理的に不可能）', () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const dir = mkNote();
        try {
            const fm = new NotesFileManager(dir);
            const mdId = fm.registerMarkdownFile('# Main\n', 'Main', null, 0);
            fm.openFile(fm.getMdFilePath(mdId));
            const ok = fm.registerTreeFile('a.pdf', 'A', null, 0);
            const { sender } = spy();

            // 成功 → true / 失敗 → false（void を返していたら両方 undefined で RED）
            expect(mod.treeFileAttachToMdEditor(fm, sender, ok, undefined),
                'treeFileAttachToMdEditor が成功時に true を返さない').toBe(true);
            expect(mod.treeFileAttachToMdEditor(fm, sender, 'bogus', undefined),
                'treeFileAttachToMdEditor が失敗時に false を返さない').toBe(false);
            expect(mod.treeFileImportAtPosition(fm, sender, 'bogus', 'x', null, null),
                'treeFileImportAtPosition が失敗時に false を返さない').toBe(false);
            expect(mod.linkMdAsSubpageForSidePanelCore(fm, sender, path.join(dir, 'nope.md'), null,
                path.join(dir, 'dst.md')),
            'linkMdAsSubpageForSidePanelCore が失敗時に false を返さない').toBe(false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});

/**
 * TC-MSEL-26b — 配線の形: batch handler が委譲先の返り値を捨てていない
 * （TASK-38。behavioral に踏めない `notesImportMdIntoOut` 経路の受け皿）
 *
 * `notesEditorProvider.ts` の 4 batch handler は巨大クロージャ内のため behavioral 起動不能。
 * 「`transferOne` の中で委譲先を呼びっぱなしにして返り値を捨てる」形だけを機械的に禁じる。
 */
test.describe('TC-MSEL-26b batch handler が委譲先の成否を捨てていない（TASK-38）', () => {
    const PROVIDER = path.join(__dirname, '..', '..', 'src', 'notesEditorProvider.ts');

    test('🔴 4 つの batch handler の transferOne が委譲先の返り値を return している', () => {
        const src = fs.readFileSync(PROVIDER, 'utf8');
        // runPlatformBatch(...) の第 2 引数（アロー関数本体）を粗く取り出して
        // 「委譲先呼び出しの前に return / => が来ているか」を見る。
        const handlers = [
            { name: 'notesImportMdIntoOutBatch', callee: 'platform.notesImportMdIntoOut' },
            { name: 'notesImportTreeFileAtPositionBatch', callee: 'platform.notesImportTreeFileAtPosition' },
            { name: 'attachTreeFileToMdBatch', callee: 'treeFileAttachToMdEditor' },
            { name: 'linkMdAsSubpageBatch', callee: 'linkMdAsSubpageForSidePanelCore' },
        ];
        for (const h of handlers) {
            const at = src.indexOf(h.name + ':');
            expect(at, `${h.name} が provider に無い`).toBeGreaterThan(-1);
            // handler 宣言から 900 文字を窓にする（handler 1 個は数行）
            const win = src.slice(at, at + 900);
            const calleeAt = win.indexOf(h.callee);
            expect(calleeAt, `${h.name} が ${h.callee} を呼んでいない`).toBeGreaterThan(-1);
            // 委譲先呼び出しの直前 40 文字に return / => があること
            // （`await fn(...)` 単独 = 返り値を捨てている = 集計不能）
            const lead = win.slice(Math.max(0, calleeAt - 40), calleeAt);
            expect(/return\s+(await\s+)?$|=>\s*(await\s+)?$/.test(lead),
                `${h.name} が ${h.callee} の返り値を捨てている（lead=${JSON.stringify(lead)}）— `
                + '成否が runPlatformBatch に届かず集計通知が発火しない').toBe(true);
        }
    });

    test('🔴 batch 経路で per-item の個別 popup を出さない（トースト洪水の禁止 = NFR-MSEL-03）', () => {
        const src = fs.readFileSync(PROVIDER, 'utf8');
        // notesImportMdIntoOut の catch 内 showErrorMessage は batch 経路で抑止されている必要がある
        // （= 単一/batch を判別する引数でガードするか、catch から通知が消えている）
        const at = src.indexOf('notesImportMdIntoOut: async (');
        expect(at, 'notesImportMdIntoOut が provider に無い').toBeGreaterThan(-1);
        // 次の platform メンバー宣言までを関数本体の窓にする（固定長スライスだと catch まで届かない）
        const nextMember = src.indexOf('\n            // ──', at);
        const end = nextMember > at ? nextMember : at + 8000;
        const body = src.slice(at, end);
        const toastAt = body.indexOf('showErrorMessage');
        if (toastAt < 0) {
            // catch から通知が消えている = 集計通知に一本化された（合格）
            return;
        }
        // 通知が残っているなら、その直前 400 文字に batch 抑止のガードが必要
        const guardWin = body.slice(Math.max(0, toastAt - 400), toastAt);
        expect(/notifyPerItem|isBatch|suppressToast|silent/.test(guardWin),
            'notesImportMdIntoOut の catch が batch 経路でも無条件に showErrorMessage を出す '
            + '（NFR-MSEL-03 の「N 回のトースト洪水にしない」に反する）').toBe(true);
        // 併せて非 localize の英語ハードコードを禁じる（reviewer iteration 3 SEC-5 の付随指摘）
        expect(/showErrorMessage\('Failed to import \.md into outliner'\)/.test(body),
            'showErrorMessage が非 localize の英語ハードコードのまま（t() 経由にする）').toBe(false);
    });
});


/**
 * TC-MSEL-32（host 層）— 種別混在の結合 batch は**合計に対して 1 回**ゲートする（再オープン TASK-45 / design §4-2 rev2）
 *
 * 結合 handler 2 本（`notesImportTreeItemsBatch` / `attachTreeItemsToMdBatch`）は provider の巨大クロージャ内で
 * behavioral 起動不能（TC-MSEL-26b と同じ制約）。ここでは
 *   (a) runner が 300 件の混在配列に対して confirmLarge を **1 回・300 で**呼ぶこと（runner 契約）
 *   (b) provider の 2 handler が `runPlatformBatch(items,` を **1 回だけ**呼び、`transferOne` が `kind` で
 *       既存単一関数へ分岐し返り値を return していること（source pin — 分割呼びを字面で禁じる）
 * を pin する。webview 側が 1 回の結合 bridge を呼ぶことは E2E（notetree-range-select.spec TC-MSEL-32）が担う。
 */
test.describe('TC-MSEL-32 種別混在の結合 batch は合計で 1 回ゲート（TASK-45）', () => {
    test('(a) runner: md 150 + file 150 の混在 300 件で confirmLarge が 1 回・300', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const confirm: number[] = []; let processed = 0;
        const items = Array.from({ length: 300 }, (_, i) => ({ kind: i % 2 ? 'file' : 'md', id: String(i) }));
        await mod.runPlatformBatch(items, () => { processed += 1; return true; }, {
            confirmLarge: (n: number) => { confirm.push(n); return true; },
            notifyLimitExceeded: () => { /* noop */ }, notifyOutcome: () => { /* noop */ },
        });
        expect(confirm, 'confirm が合計 300 で 1 回でない（種別ごとに 150 だと素通り）').toEqual([300]);
        expect(processed).toBe(300);
    });

    test('(b) provider: 結合 handler 2 本が runPlatformBatch を 1 回・kind 分岐・返り値 return（source pin）', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'notesEditorProvider.ts'), 'utf8');
        for (const h of [
            { name: 'notesImportTreeItemsBatch', callees: ['platform.notesImportMdIntoOut', 'platform.notesImportTreeFileAtPosition'] },
            { name: 'attachTreeItemsToMdBatch', callees: ['linkMdAsSubpageForSidePanelCore', 'treeFileAttachToMdEditor'] },
        ]) {
            const at = src.indexOf(h.name + ':');
            expect(at, `${h.name} が provider に無い`).toBeGreaterThan(-1);
            const win = src.slice(at, at + 1200);
            expect((win.match(/runPlatformBatch\(/g) || []).length, `${h.name} が runPlatformBatch を 1 回でない（分割呼び = ゲートが割れる）`).toBe(1);
            expect(win.includes("kind === 'md'"), `${h.name} が kind で分岐していない`).toBe(true);
            for (const c of h.callees) { expect(win.includes(c), `${h.name} が ${c} を呼んでいない`).toBe(true); }
            // 委譲先の返り値を捨てていない（TASK-38 契約）: 三項式 / return / => の直後に呼ぶ
            expect(/(\?\s*(await\s+)?|:\s*(await\s+)?|=>\s*(await\s+)?|return\s+(await\s+)?)(platform\.notesImportMdIntoOut|platform\.notesImportTreeFileAtPosition|linkMdAsSubpageForSidePanelCore|treeFileAttachToMdEditor)(\?\.)?\(/.test(win),
                `${h.name} が委譲先の返り値を捨てている`).toBe(true);
        }
    });
});
