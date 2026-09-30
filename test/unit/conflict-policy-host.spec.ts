/**
 * TASK-12 — 同名衝突の 3 択（host 側）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-CFL-01/02/03/04 / ADRL-0123 / ADRL-0129 / INV-7 / INV-8 / INV-12
 *
 * TC-CFL-2: 衝突ありで 1 回だけ問い合わせる
 * TC-CFL-3: 「中止」で 1 件も動かない（部分適用が起きない）
 * TC-CFL-4: 「別名」でフォルダが連番になる
 * TC-CFL-5: ドットを含むフォルダ名は拡張子と見ない
 * TC-CFL-6: 「上書き」は trash 経由
 * TC-CFL-7: ファイルの衝突でも全体中止
 * TC-CFL-8: 管理下（note ツリー）宛ては問わない
 * TC-CFL-11: 宛先一覧が読めないとき drop 全体を中止する
 *
 * 番人: 事前衝突判定（`detectNameConflicts` + batch 冒頭の 1 回問い）を外すと
 * TC-CFL-2 / TC-CFL-3 / TC-CFL-7 / TC-CFL-11 が落ちる。
 */
import { test, expect } from '@playwright/test';
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
const fx = require('../fixtures/folder-payload/index');

function setup(policy: 'abort' | 'overwrite' | 'rename' | null) {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const cf = fx.makeNameConflict();
    const note = fx.makeLinkedNote(NotesFileManager, cf.root);
    const calls: any = { prompt: [], error: [], trash: [], info: [] };
    const deps = {
        showErrorMessage: (m: string) => calls.error.push(m),
        showInformationMessage: (m: string) => calls.info.push(m),
        t: (k: string) => k,
        trashDelete: async (p: string, rec: boolean) => {
            calls.trash.push({ p, rec });
            fs.rmSync(p, { recursive: true, force: true });   // trash の代替（テストでは実削除）
        },
        toDisplayUri: (p: string) => p,
        confirmLarge: () => true,
        notifyLimitExceeded: () => { /* noop */ },
        notifyOutcome: () => { /* noop */ },
        renameFs: fs.renameSync,
        promptConflict: policy === null
            ? undefined
            : (name: string, count: number) => { calls.prompt.push({ name, count }); return policy; },
    };
    return { mod, fm: note.fm, linkId: note.folderLinkId, root: cf.root, deps, calls,
             sender: { postMessage: () => { /* noop */ } },
             cleanup: () => { note.cleanup(); cf.cleanup(); } };
}

test.describe('TASK-12 同名衝突の 3 択（host）', () => {
    test('TC-CFL-2: 3 件中 2 件目が衝突しても問い合わせは 1 回だけ', async () => {
        const t = setup('rename');
        try {
            await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['docs', 'src', 'assets'], 'archive', 'move',
                t.deps as any, t.sender, t.deps as any);
            expect(t.calls.prompt.length, 'per-item で問い返している（3 回聞かれる）').toBe(1);
            expect(t.calls.prompt[0].name).toBe('src');
            expect(t.calls.prompt[0].count).toBe(1);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-3: 「中止」で 1 件も動かない（部分適用が起きない = INV-7）', async () => {
        const t = setup('abort');
        try {
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['docs', 'src', 'assets'], 'archive', 'move',
                t.deps as any, t.sender, t.deps as any);
            expect(r.outcome.succeeded).toBe(0);
            // 3 件とも元の位置にある（旧実装は 1 件目が移動済みで戻せなかった）
            for (const n of ['docs', 'src', 'assets']) {
                expect(fs.existsSync(path.join(t.root, n)), `${n} が動いてしまった`).toBe(true);
            }
            expect(fs.existsSync(path.join(t.root, 'archive', 'docs'))).toBe(false);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-4: 「別名」でフォルダが連番になる', async () => {
        const t = setup('rename');
        try {
            await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['src'], 'archive', 'move', t.deps as any, t.sender, t.deps as any);
            const names = fs.readdirSync(path.join(t.root, 'archive'));
            expect(names.sort(), `連番で入っていない: ${names.join(',')}`).toEqual(['src', 'src-1']);
            // 既存の archive/src は残っている（上書きしていない）
            expect(fs.existsSync(path.join(t.root, 'archive', 'src', 'existing.txt'))).toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-5: ドットを含むフォルダ名は拡張子と見ない（assets.bak → assets.bak-1）', () => {
        const mod = requireWithVscodeStub('../../src/shared/paste-asset-handler');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-'));
        try {
            fs.mkdirSync(path.join(dir, 'assets.bak'), { recursive: true });
            const asDir = mod.generateUniqueFileNamePreserving(dir, 'assets.bak', { treatAsDir: true });
            expect(asDir, 'フォルダ名のドットが拡張子として切られた').toBe('assets.bak-1');
            // ファイルは従来どおり拡張子を保存する（回帰しない）
            fs.writeFileSync(path.join(dir, 'a.md'), 'x');
            expect(mod.generateUniqueFileNamePreserving(dir, 'a.md')).toBe('a-1.md');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('TC-CFL-6: 「上書き」は trash 経由で退避する（恒久削除を作らない = INV-8）', async () => {
        const t = setup('overwrite');
        try {
            await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['src'], 'archive', 'move', t.deps as any, t.sender, t.deps as any);
            expect(t.calls.trash.length, 'trash 経由で退避していない（直接削除した）').toBe(1);
            expect(t.calls.trash[0].rec, 'フォルダの退避で recursive が立っていない').toBe(true);
            // 置き換わっている（元 src の中身が来ている）
            expect(fs.existsSync(path.join(t.root, 'archive', 'src', 'src.txt'))).toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-7: ファイルの衝突でも全体中止（種別非依存）', async () => {
        const t = setup('abort');
        try {
            fs.writeFileSync(path.join(t.root, 'dup.txt'), 'NEW');
            fs.writeFileSync(path.join(t.root, 'archive', 'dup.txt'), 'OLD');
            fs.writeFileSync(path.join(t.root, 'other.txt'), 'O');
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['other.txt', 'dup.txt'], 'archive', 'move',
                t.deps as any, t.sender, t.deps as any);
            expect(r.outcome.succeeded).toBe(0);
            expect(fs.existsSync(path.join(t.root, 'other.txt')), '1 件目が動いてしまった').toBe(true);
            expect(fs.readFileSync(path.join(t.root, 'archive', 'dup.txt'), 'utf8')).toBe('OLD');
        } finally { t.cleanup(); }
    });

    test('TC-CFL-1: 衝突 0 件なら問い合わせない（既存 UX 不変）', async () => {
        const t = setup('rename');
        try {
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['docs', 'assets'], 'archive', 'move',
                t.deps as any, t.sender, t.deps as any);
            expect(t.calls.prompt, '衝突が無いのに modal が出た').toEqual([]);
            expect(r.outcome.succeeded).toBe(2);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-11: 宛先一覧が読めないとき「衝突なし」に倒さず中止する（INV-12）', () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const r = mod.detectNameConflicts(path.join(os.tmpdir(), 'no-such-dir-xyz'), ['/tmp/a.txt']);
        expect(r.readable, '読めない宛先を readable と判定した').toBe(false);
        expect(r.conflicts, '読めないのに「衝突なし」を返した（黙って上書きしうる）').toEqual([]);
    });

    test('TC-CFL-11b: 読めない宛先の batch は 0 件処理で中止する', async () => {
        const t = setup('rename');
        try {
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['docs'], 'no-such-dst', 'move',
                t.deps as any, t.sender, t.deps as any);
            expect(r.outcome.succeeded).toBe(0);
            expect(fs.existsSync(path.join(t.root, 'docs')), 'src が動いた').toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-8: promptConflict 未注入なら従来の per-item 拒否に落ちる（既存挙動を壊さない）', async () => {
        const t = setup(null);
        try {
            // docs は衝突しない / src は衝突する
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['docs', 'src'], 'archive', 'move', t.deps as any, t.sender, t.deps as any);
            // 🔴 未注入で**全体中止に倒さない**（既存挙動 = 衝突しなかった件は動く）
            expect(r.outcome.succeeded, '未注入で全体中止に倒して既存挙動を壊した').toBe(1);
            expect(r.outcome.skipped, '衝突した 1 件が skipped に計上されていない').toBe(1);
            // 黙って上書きはしない（既存の archive/src は無傷）
            expect(fs.existsSync(path.join(t.root, 'archive', 'src', 'existing.txt'))).toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-9: copy（clipboard / Duplicate）は 3 択を出さず連番固定', async () => {
        const t = setup('abort');   // 問われたら中止するはずの方針を注入しておく
        try {
            fs.writeFileSync(path.join(t.root, 'dup.txt'), 'NEW');
            fs.writeFileSync(path.join(t.root, 'archive', 'dup.txt'), 'OLD');
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['dup.txt'], 'archive', 'copy', t.deps as any, t.sender, t.deps as any);
            expect(t.calls.prompt, 'copy で 3 択が出た（FR-CFL-02 の例外に反する）').toEqual([]);
            expect(r.outcome.succeeded).toBe(1);
            // 既存は無傷 + 連番で増える
            expect(fs.readFileSync(path.join(t.root, 'archive', 'dup.txt'), 'utf8')).toBe('OLD');
            expect(fs.readdirSync(path.join(t.root, 'archive')).filter((n) => /^dup/.test(n)).length).toBe(2);
        } finally { t.cleanup(); }
    });
});
