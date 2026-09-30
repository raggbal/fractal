/**
 * TASK-01 — note ツリーの自己ネストガード（B-3 / NFR-FDP-03 / INV-1）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 *
 * TC-INV1-1: フォルダを自分自身に移動しても台帳が不変
 * TC-INV1-2: 移動後も全項目が root から到達可能
 * TC-INV1-3: 複数移動の既存自己ガードが不変（回帰）
 *
 * 番人: `notes-file-manager.ts` の単数移動 `moveItem` から自己チェックを外すと落ちる。
 *
 * 背景（不可逆データ消失）: `moveItem` は子孫判定しか持たず `targetParentId === itemId` を
 * 見ていなかったため、フォルダを自分自身に drop すると親/rootIds から外れて自分の childIds に
 * 入り、**root からも親からも辿れない**状態が `saveStructure()` で永続化されていた。
 * この面には undo が無く（`undoStack` は notes-file-panel.js / notes-folder-view.js /
 * notes-file-manager.ts に 0 hit）fs 削除の救済も無いので復元手段がない。
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

function setup() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfguard-note-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const cleanup = () => { try { fs.rmSync(noteDir, { recursive: true, force: true }); } catch { /* ignore */ } };
    return { m, noteDir, cleanup };
}

/** outline.note の実バイト列（台帳が 1 バイトも変わっていないことの検証に使う）。 */
function ledgerBytes(noteDir: string): string {
    const p = path.join(noteDir, 'outline.note');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** rootIds から辿れる item id の集合（到達性）。 */
function reachableIds(structure: any): Set<string> {
    const seen = new Set<string>();
    const stack = [...structure.rootIds];
    let guard = 0;
    while (stack.length > 0 && guard++ < 10000) {
        const id = stack.pop() as string;
        if (seen.has(id)) { continue; }
        seen.add(id);
        const it = structure.items[id];
        if (it && it.type === 'folder') { stack.push(...it.childIds); }
    }
    return seen;
}

test.describe('TASK-01 note ツリーの自己ネストガード', () => {
    test('TC-INV1-1: フォルダを自分自身に移動しても台帳が 1 バイトも変わらない', () => {
        const { m, noteDir, cleanup } = setup();
        try {
            // F（子 2 個を持つフォルダ）を作る
            m.createFolder('F');
            const fId = Object.keys(m.getStructure().items).find(
                id => m.getStructure().items[id].title === 'F'
            ) as string;
            m.createFolder('child-1', fId);
            m.createFolder('child-2', fId);

            const before = ledgerBytes(noteDir);
            const beforeStruct = JSON.parse(JSON.stringify(m.getStructure()));
            expect((beforeStruct.items[fId] as any).childIds.length).toBe(2);

            // 自分自身に移動（= 自己ネスト）
            m.moveItem(fId, fId, 0);

            // 台帳が 1 バイトも変わっていない
            expect(ledgerBytes(noteDir)).toBe(before);
            // 構造も不変（F が rootIds に居て、childIds も 2 件のまま）
            const after = m.getStructure();
            expect(after.rootIds).toContain(fId);
            expect((after.items[fId] as any).childIds.length).toBe(2);
            expect((after.items[fId] as any).childIds).not.toContain(fId);
            // F 自身と配下が root から到達可能
            const reach = reachableIds(after);
            expect(reach.has(fId)).toBe(true);
            expect(Object.keys(after.items).every(id => reach.has(id))).toBe(true);
        } finally { cleanup(); }
    });

    test('TC-INV1-2: 正常な移動を 5 回連続しても全項目が root から到達可能', () => {
        const { m, cleanup } = setup();
        try {
            const ids: string[] = [];
            for (const t of ['A', 'B', 'C', 'D', 'E', 'F']) {
                m.createFolder(t);
                const id = Object.keys(m.getStructure().items).find(
                    x => m.getStructure().items[x].title === t
                ) as string;
                ids.push(id);
            }
            // A→B, B→C, C→D, D→E, E→F の順にネストさせる（すべて正常系）
            for (let i = 0; i < 5; i++) {
                m.moveItem(ids[i], ids[i + 1], 0);
                const st = m.getStructure();
                const reach = reachableIds(st);
                expect(Object.keys(st.items).every(id => reach.has(id))).toBe(true);
            }
        } finally { cleanup(); }
    });

    test('TC-INV1-3: 複数移動の既存自己ガードが不変（回帰）', () => {
        const { m, noteDir, cleanup } = setup();
        try {
            m.createFolder('G');
            const gId = Object.keys(m.getStructure().items).find(
                id => m.getStructure().items[id].title === 'G'
            ) as string;
            m.createFolder('g-child', gId);

            const before = ledgerBytes(noteDir);
            m.moveItems([gId], gId, 0);
            expect(ledgerBytes(noteDir)).toBe(before);
            const after = m.getStructure();
            expect(after.rootIds).toContain(gId);
            expect((after.items[gId] as any).childIds).not.toContain(gId);
        } finally { cleanup(); }
    });
});
