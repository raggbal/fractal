/**
 * TASK-10 — B-5: batch 3 本の通知抑止の対称性
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * NFR-MSEL-03 / INV-9 / DOM-BatchQuietParity / MOD-BatchQuiet
 *
 * TC-B5-1: 3 件全成功で通知 0 回
 * TC-B5-2: 1 件失敗で集計通知 1 回
 * TC-B5-3: 一覧の再送も 1 回
 *
 * 番人: 通知抑止 3 点セット（quietDeps / quietSender / ループ後の 1 回送信）の
 * どれか 1 つを外すと落ちる。
 *
 * ## 対象は batch 3 本すべて
 * - `folderViewMoveBatch`（元から抑止あり = 正典）
 * - `folderViewMoveInBatch`（TASK-04 で適用）
 * - `folderViewMoveToTreeBatch`（TASK-10 で適用）
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

function deps() {
    const calls: any = { error: [], info: [], limit: [], outcome: [] };
    return {
        calls,
        d: {
            showErrorMessage: (m: string) => calls.error.push(m),
            showInformationMessage: (m: string) => calls.info.push(m),
            t: (k: string) => k,
            trashDelete: async () => { /* noop */ },
            toDisplayUri: (p: string) => p,
            confirmLarge: () => true,
            notifyLimitExceeded: (e: string) => calls.limit.push(e),
            notifyOutcome: (o: any) => calls.outcome.push(o),
            renameFs: fs.renameSync,
        },
    };
}
const sender = () => { const msgs: any[] = []; return { s: { postMessage: (m: any) => msgs.push(m) }, msgs }; };

function setup(files: string[]) {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const dot = fx.makeDotfiles();          // 使い捨ての実フォルダ root
    for (const f of files) { fs.writeFileSync(path.join(dot.root, f), f); }
    fs.mkdirSync(path.join(dot.root, 'dst'), { recursive: true });
    const note = fx.makeLinkedNote(NotesFileManager, dot.root);
    return { mod, fm: note.fm, linkId: note.folderLinkId, root: dot.root, cleanup: () => { note.cleanup(); dot.cleanup(); } };
}

test.describe('TASK-10 B-5 batch 3 本の通知抑止の対称性', () => {
    test('TC-B5-1: folderViewMoveToTreeBatch は 3 件全成功で通知 0 回', async () => {
        const t = setup(['a.txt', 'b.txt', 'c.txt']);
        try {
            const { d, calls } = deps(); const { s } = sender();
            const r = await t.mod.folderViewMoveToTreeBatch(
                t.fm, t.linkId, [{ relPath: 'a.txt' }, { relPath: 'b.txt' }, { relPath: 'c.txt' }],
                null, 0, d as any, s);
            expect(r.outcome.succeeded).toBe(3);
            expect(calls.error, 'per-item トーストが出た（トースト洪水 = NFR-MSEL-03 違反）').toEqual([]);
            expect(calls.outcome, '全成功なのに集計通知が出た').toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-B5-2: 1 件失敗で集計通知 1 回・per-item は 0 回', async () => {
        const t = setup(['a.txt', 'b.txt']);
        try {
            const { d, calls } = deps(); const { s } = sender();
            // 3 件目は存在しない relPath（失敗させる）
            const r = await t.mod.folderViewMoveToTreeBatch(
                t.fm, t.linkId, [{ relPath: 'a.txt' }, { relPath: 'nope.txt' }, { relPath: 'b.txt' }],
                null, 0, d as any, s);
            expect(r.outcome.succeeded).toBe(2);
            expect(r.outcome.skipped + r.outcome.failed).toBe(1);
            expect(calls.outcome.length, '集計通知が 1 回でない').toBe(1);
            expect(calls.error, 'per-item トーストが出た').toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-B5-3: 一覧の再送が 1 回（N 件でも増えない）', async () => {
        const t = setup(['a.txt', 'b.txt', 'c.txt']);
        try {
            const { d } = deps(); const { s, msgs } = sender();
            await t.mod.folderViewMoveToTreeBatch(
                t.fm, t.linkId, [{ relPath: 'a.txt' }, { relPath: 'b.txt' }, { relPath: 'c.txt' }],
                null, 0, d as any, s);
            const lists = msgs.filter((m: any) => m && m.type === 'folderViewListResult');
            expect(lists.length, `一覧再送が ${lists.length} 回（N 件ぶん飛んでいる）`).toBeLessThanOrEqual(1);
        } finally { t.cleanup(); }
    });

    test('TC-B5-4: batch 3 本すべてが通知抑止を持つ（source pin）', () => {
        const src = fs.readFileSync(path.join(SRC_PREFIX, 'shared', 'notes-message-handler.ts'), 'utf8');
        for (const fn of ['folderViewMoveBatch', 'folderViewMoveInBatch', 'folderViewMoveToTreeBatch']) {
            const i = src.indexOf(`export async function ${fn}`);
            expect(i, `${fn} が無い`).toBeGreaterThan(-1);
            const body = src.slice(i, i + 3200);
            expect(body.includes('quietDeps'), `${fn} に per-item トーストの抑止が無い`).toBe(true);
            expect(body.includes('quietSender'), `${fn} に一覧再送の抑止が無い`).toBe(true);
            expect(body.includes('folderViewListResult'), `${fn} が一覧再送をループ後にまとめていない`).toBe(true);
        }
    });
});
