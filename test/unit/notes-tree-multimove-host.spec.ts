/**
 * TASK-87 — note tree **内**の複数選択移動（host 端）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-TMV-01 / 裁定 R38）
 *
 * TC-TMV-01 複数を folder 内へ（順序保持・保存 1 回）
 * TC-TMV-02 同一親内の後方移動が anchor 意味論で「anchor の直前」に順序保持で入る
 * TC-TMV-03 番人: フォルダを自身 / 自身の子孫の中へは動かさない（他の item は動く）
 * TC-TMV-04 配線: host message `notesMoveItems` が moveItems を通り、file list を postback する
 *
 * 🔴 counterfactual: `moveItems` 実装前は `NotesFileManager.moveItems` が存在せず
 * TC-TMV-01..03 が TypeError で RED、`case 'notesMoveItems'` 未実装で TC-TMV-04 が
 * 「構造不変 + postback なし」で RED（= 複数選択しても 1 件しか動かなかったバグ本体）。
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
    purgeSrcCache();   // 掴まない
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
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally { Module._load = origLoad; purgeSrcCache(); }   // 残さない
}

function loadManagerClass(): any {
    return requireWithVscodeStub('../../src/shared/notes-file-manager').NotesFileManager;
}

function readNoteJson(noteDir: string): any {
    return JSON.parse(fs.readFileSync(path.join(noteDir, 'outline.note'), 'utf8'));
}

/**
 * 素の structure を outline.note に直書きして load する。
 * `.out` item は実体が無いと loadStructure の disk sync で落ちるので、
 * ここでは md / folder item だけで組む（移動の意味論は ext に依らない）。
 */
function makeNote(structure: any): { dir: string; m: any } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmv-note-'));
    for (const id of Object.keys(structure.items)) {
        const it = structure.items[id];
        if (it.type === 'file' && it.ext === 'md') {
            fs.writeFileSync(path.join(dir, `${id}.md`), `# ${it.title}\n`, 'utf8');
            it.filePath = path.join(dir, `${id}.md`);
        }
    }
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify(structure, null, 2), 'utf8');
    const NotesFileManager = loadManagerClass();
    const m = new NotesFileManager(dir);
    m.loadStructure();
    return { dir, m };
}

function md(id: string) { return { type: 'file', id, title: id, ext: 'md' }; }
function dir(id: string, childIds: string[]) { return { type: 'folder', id, title: id, childIds, collapsed: false }; }

test.describe('note tree 内の複数選択移動（FR-TMV-01 / TASK-87）', () => {

    test('TC-TMV-01 複数 item を folder の先頭へ順序保持で移動し、保存は 1 回だけ', () => {
        const { dir: noteDir, m } = makeNote({
            version: 1,
            rootIds: ['m1', 'm2', 'm3', 'd1'],
            items: { m1: md('m1'), m2: md('m2'), m3: md('m3'), d1: dir('d1', ['m9']), m9: md('m9') },
        });
        // 保存回数を数える（N 回移動 = N 回保存になっていないことの実測）
        let saves = 0;
        const origSave = m.saveStructure.bind(m);
        m.saveStructure = () => { saves++; return origSave(); };

        m.moveItems(['m1', 'm3'], 'd1', 0);

        const json = readNoteJson(noteDir);
        expect(json.items['d1'].childIds, 'd1 の先頭に選択順で入る').toEqual(['m1', 'm3', 'm9']);
        expect(json.rootIds, '移動元 root から 2 件抜ける').toEqual(['m2', 'd1']);
        expect(saves, '一括移動の保存は 1 回（moveItem の N 回呼びではない）').toBe(1);
    });

    test('TC-TMV-02 同一親内の後方移動は anchor（index 位置の非移動 item）の直前に順序保持で入る', () => {
        const { dir: noteDir, m } = makeNote({
            version: 1,
            rootIds: ['a', 'b', 'c', 'd', 'e'],
            items: { a: md('a'), b: md('b'), c: md('c'), d: md('d'), e: md('e') },
        });
        // a, b を「d の前」= 抜く前の index 3 へ。index を持ち回る実装だと 1 つずれる。
        m.moveItems(['a', 'b'], null, 3);
        expect(readNoteJson(noteDir).rootIds).toEqual(['c', 'a', 'b', 'd', 'e']);

        // 末尾（index = 長さ）へ落とすと末尾に付く
        m.moveItems(['c'], null, 5);
        expect(readNoteJson(noteDir).rootIds).toEqual(['a', 'b', 'd', 'e', 'c']);

        // 選択集合の上へ落とされた場合も、集合は後ろの非移動 item を anchor にして壊れない
        m.moveItems(['a', 'b'], null, 1);
        expect(readNoteJson(noteDir).rootIds).toEqual(['a', 'b', 'd', 'e', 'c']);
    });

    test('TC-TMV-03 番人: フォルダは自身 / 自身の子孫の中へ動かない（同時選択の他 item は動く）', () => {
        const { dir: noteDir, m } = makeNote({
            version: 1,
            rootIds: ['d1', 'm1'],
            items: { d1: dir('d1', ['d2', 'm2']), d2: dir('d2', ['m3']), m1: md('m1'), m2: md('m2'), m3: md('m3') },
        });
        // d1 を自身の子 d2 の中へ + m1 も一緒に選択 → d1 は残り、m1 だけ入る
        m.moveItems(['d1', 'm1'], 'd2', 0);
        let json = readNoteJson(noteDir);
        expect(json.items['d2'].childIds, 'm1 のみ d2 へ').toEqual(['m1', 'm3']);
        expect(json.rootIds, 'd1 は root に残る（循環を作らない）').toEqual(['d1']);
        expect(json.items['d1'].childIds, 'd1 の子は不変').toEqual(['d2', 'm2']);

        // 自分自身の中への移動も no-op
        m.moveItems(['d1'], 'd1', 0);
        json = readNoteJson(noteDir);
        expect(json.rootIds).toEqual(['d1']);
        expect(json.items['d1'].childIds).toEqual(['d2', 'm2']);

        // 存在しない id / 重複は黙って落ちる（構造は壊れない）
        m.moveItems(['nope', 'm2', 'm2'], null, 0);
        json = readNoteJson(noteDir);
        expect(json.rootIds).toEqual(['m2', 'd1']);
        expect(json.items['d1'].childIds).toEqual(['d2']);
    });

    test('TC-TMV-04 配線: host message notesMoveItems が moveItems を通り file list を postback する', async () => {
        const { dir: noteDir, m } = makeNote({
            version: 1,
            rootIds: ['m1', 'm2', 'd1'],
            items: { m1: md('m1'), m2: md('m2'), d1: dir('d1', []) },
        });
        const posted: any[] = [];
        const sender = { postMessage: (msg: any) => { posted.push(msg); } } as any;
        const platform = { showInformationMessage: () => {}, showErrorMessage: () => {} } as any;
        const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler').handleNotesMessage;

        await handleNotesMessage(
            { type: 'notesMoveItems', itemIds: ['m1', 'm2'], targetParentId: 'd1', index: 0 },
            m as any, sender, platform
        );

        expect(readNoteJson(noteDir).items['d1'].childIds, '2 件とも d1 へ入る').toEqual(['m1', 'm2']);
        expect(readNoteJson(noteDir).rootIds).toEqual(['d1']);
        expect(posted.some((p) => p && typeof p.type === 'string' && /fileList/i.test(p.type)),
            `structure 付き file list が postback される: ${posted.map((p) => p && p.type).join(',')}`).toBe(true);

        // itemIds 欠落（旧 webview からの誤配線）でも落ちない
        await handleNotesMessage(
            { type: 'notesMoveItems', targetParentId: null, index: 0 },
            m as any, sender, platform
        );
        expect(readNoteJson(noteDir).rootIds).toEqual(['d1']);
    });
});
