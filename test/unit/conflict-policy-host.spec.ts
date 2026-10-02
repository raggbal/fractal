/**
 * 同名衝突の解決（host 側）— v1.3.16 の 3 択（TASK-12 / ADRL-0129）は ADRL-0132 で廃止
 * 元 sprint 20260910-053026-folder-payload-canon-multifolder-move / 改訂 sprint 20260930-192647-linkedfd-conflict-rename-and-paste-sibling
 *
 * 残置（test_update）:
 * TC-CFL-4: フォルダ move の同名は連番になる
 * TC-CFL-5: ドットを含むフォルダ名は拡張子と見ない
 * TC-CFL-8: 単数経路（方針の注入なし）でも同名は連番で移動する（旧: per-item 拒否）
 * TC-CFL-9: copy は連番固定
 * 削除（test_remove）: TC-CFL-1/2/3/6/7/11/11b — 問い合わせ・中止・上書き・事前衝突判定が無くなったため
 * （代替: test/unit/folder-view-name-canon.spec.ts の TC-FNM-06 / TC-FNM-09）
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

function setup() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const cf = fx.makeNameConflict();
    const note = fx.makeLinkedNote(NotesFileManager, cf.root);
    const calls: any = { error: [], trash: [], info: [] };
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
    };
    return { mod, fm: note.fm, linkId: note.folderLinkId, root: cf.root, deps, calls,
             sender: { postMessage: () => { /* noop */ } },
             cleanup: () => { note.cleanup(); cf.cleanup(); } };
}

test.describe('同名衝突は常に連番（host / ADRL-0132）', () => {
    test('TC-CFL-4: フォルダ move の同名は連番になる', async () => {
        const t = setup();
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

    test('TC-CFL-8: 同名衝突は拒否せず連番で移動する（旧: per-item 拒否 / ADRL-0132）', async () => {
        const t = setup();
        try {
            // docs は衝突しない / src は衝突する
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['docs', 'src'], 'archive', 'move', t.deps as any, t.sender, t.deps as any);
            expect(r.outcome.succeeded, '衝突した 1 件が連番で移動していない').toBe(2);
            expect(r.outcome.skipped).toBe(0);
            expect(fs.existsSync(path.join(t.root, 'archive', 'src-1', 'src.txt')), 'src-1 ができていない').toBe(true);
            // 黙って上書きはしない（既存の archive/src は無傷）
            expect(fs.existsSync(path.join(t.root, 'archive', 'src', 'existing.txt'))).toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-CFL-9: copy（clipboard / Duplicate）は連番固定', async () => {
        const t = setup();
        try {
            fs.writeFileSync(path.join(t.root, 'dup.txt'), 'NEW');
            fs.writeFileSync(path.join(t.root, 'archive', 'dup.txt'), 'OLD');
            const r = await t.mod.folderViewMoveBatch(
                t.fm, t.linkId, ['dup.txt'], 'archive', 'copy', t.deps as any, t.sender, t.deps as any);
            expect(r.outcome.succeeded).toBe(1);
            // 既存は無傷 + 連番で増える
            expect(fs.readFileSync(path.join(t.root, 'archive', 'dup.txt'), 'utf8')).toBe('OLD');
            expect(fs.readdirSync(path.join(t.root, 'archive')).filter((n) => /^dup/.test(n)).length).toBe(2);
        } finally { t.cleanup(); }
    });
});
