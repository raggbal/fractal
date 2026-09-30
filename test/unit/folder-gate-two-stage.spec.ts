/**
 * TASK-08 — 件数ゲートの 2 段化（walk → 実件数 → 既存ゲート）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-08 / NFR-FDP-05 / DOM-FvBatchGate
 *
 * TC-GATE-1: フォルダ 1 件でも中身の実件数でゲートに掛かる
 * TC-GATE-2: ≤200 は即実行で確認を出さない（既存 UX 不変）
 * TC-GATE-3: A-1（面内の移動）も実件数でゲートに掛かる
 *
 * 番人: ゲートに `items.length` を渡す実装に戻すと TC-GATE-1 / TC-GATE-3 が落ちる。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
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

function setupFv(fileCount: number) {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const large = fx.makeLargeFolder(fileCount, 10, 'big');
    fs.mkdirSync(path.join(large.root, 'dst'), { recursive: true });
    const note = fx.makeLinkedNote(NotesFileManager, large.root);
    return {
        mod, fm: note.fm, linkId: note.folderLinkId, root: large.root,
        cleanup: () => { note.cleanup(); large.cleanup(); },
    };
}

function makeDeps() {
    const calls: any = { confirmLarge: [], limitExceeded: [], outcome: [], info: [], error: [] };
    const deps = {
        showErrorMessage: (m: string) => calls.error.push(m),
        showInformationMessage: (m: string) => calls.info.push(m),
        t: (k: string) => k,
        trashDelete: async () => { /* noop */ },
        toDisplayUri: (p: string) => p,
        confirmLarge: (n: number) => { calls.confirmLarge.push(n); return false; },   // キャンセル = 0 件処理
        notifyLimitExceeded: (e: string) => calls.limitExceeded.push(e),
        notifyOutcome: (o: any) => calls.outcome.push(o),
        renameFs: fs.renameSync,
    };
    return { deps, calls };
}
const sender = () => { const msgs: any[] = []; return { s: { postMessage: (m: any) => msgs.push(m) }, msgs }; };

test.describe('TASK-08 件数ゲートの 2 段化', () => {
    test('TC-GATE-1: フォルダ 1 件でも中身 2500 ファイルとして上限中断に掛かる', async () => {
        const t = setupFv(2500);
        try {
            const { deps, calls } = makeDeps(); const { s } = sender();
            const r = await t.mod.folderViewMoveBatch(t.fm, t.linkId, ['big'], 'dst', 'move', deps as any, s, deps as any);
            // 2500 > 2000（上限）→ 中断・0 件処理
            expect(r.verdict, 'フォルダ 1 件を「1 件」と数えて上限を素通りした').toBe('abort');
            expect(calls.limitExceeded).toContain('too_many');
            expect(r.outcome.succeeded).toBe(0);
            // 原状不変（移動先に何も来ていない）
            expect(fs.readdirSync(path.join(t.root, 'dst'))).toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-GATE-2: 中身 50 ファイルのフォルダは確認を出さず即実行', async () => {
        const t = setupFv(50);
        try {
            const { deps, calls } = makeDeps(); const { s } = sender();
            const r = await t.mod.folderViewMoveBatch(t.fm, t.linkId, ['big'], 'dst', 'move', deps as any, s, deps as any);
            expect(r.verdict).toBe('ok');
            expect(calls.confirmLarge, '≤200 で確認 modal が出た（既存 UX が変わった）').toEqual([]);
            expect(fs.existsSync(path.join(t.root, 'dst', 'big'))).toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-GATE-3: 201〜2000 の範囲では実件数で確認 modal が出る（A-1 の面内移動）', async () => {
        const t = setupFv(300);
        try {
            const { deps, calls } = makeDeps(); const { s } = sender();
            const r = await t.mod.folderViewMoveBatch(t.fm, t.linkId, ['big'], 'dst', 'move', deps as any, s, deps as any);
            // confirmLarge が false を返すので cancel = 0 件処理
            expect(calls.confirmLarge.length, '実件数で確認 modal が出ていない').toBe(1);
            expect(calls.confirmLarge[0], '確認 modal に渡す件数が実ファイル数でない').toBe(300);
            expect(r.verdict).toBe('cancel');
            expect(fs.readdirSync(path.join(t.root, 'dst'))).toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-GATE-2b: ファイルのみの batch は従来どおり件数 = items.length', async () => {
        const t = setupFv(10);
        try {
            fs.writeFileSync(path.join(t.root, 'a.txt'), 'A');
            fs.writeFileSync(path.join(t.root, 'b.txt'), 'B');
            const { deps, calls } = makeDeps(); const { s } = sender();
            const r = await t.mod.folderViewMoveBatch(t.fm, t.linkId, ['a.txt', 'b.txt'], 'dst', 'move', deps as any, s, deps as any);
            expect(r.verdict).toBe('ok');
            expect(calls.confirmLarge).toEqual([]);
            expect(fs.existsSync(path.join(t.root, 'dst', 'a.txt'))).toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-NOTIFY-1: フォルダを含む転送は内訳を通知する（1 件でも）', async () => {
        const t = setupFv(7);
        try {
            const { deps, calls } = makeDeps(); const { s } = sender();
            await t.mod.folderViewMoveBatch(t.fm, t.linkId, ['big'], 'dst', 'move', deps as any, s, deps as any);
            expect(calls.info.length, 'フォルダを含む転送で内訳通知が出ていない（undo が無いため唯一の手がかり）').toBe(1);
            expect(calls.info[0]).toContain('folderTransferSummary');
        } finally { t.cleanup(); }
    });

    test('TC-NOTIFY-2: ファイルのみの転送は内訳通知を出さない（既存 UX 不変）', async () => {
        const t = setupFv(5);
        try {
            fs.writeFileSync(path.join(t.root, 'only.txt'), 'O');
            const { deps, calls } = makeDeps(); const { s } = sender();
            await t.mod.folderViewMoveBatch(t.fm, t.linkId, ['only.txt'], 'dst', 'move', deps as any, s, deps as any);
            expect(calls.info, 'ファイルのみで内訳通知が出た（毎回トーストは煩わしい）').toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-CON-2: checkBatchLimit の配線点が 2 箇所のまま（第 3 のゲートを作っていない）', () => {
        const files = ['shared/folder-import.ts', 'shared/notes-message-handler.ts', 'shared/folder-export.ts'];
        const calls: string[] = [];
        for (const f of files) {
            const body = fs.readFileSync(path.join(SRC_PREFIX, f), 'utf8');
            body.split('\n').forEach((line, i) => {
                if (/[^\w]checkBatchLimit\s*\(/.test(line) && !/export async function checkBatchLimit/.test(line)) {
                    calls.push(`${f}:${i + 1}`);
                }
            });
        }
        expect(calls.length, `ゲート配線点が増減した: ${calls.join(' | ')}`).toBe(2);
        // エンジンはゲートを呼ばない（純関数）
        const eng = fs.readFileSync(path.join(SRC_PREFIX, 'shared', 'folder-copy-engine.ts'), 'utf8');
        expect(/checkBatchLimit/.test(eng)).toBe(false);
    });
});
