/**
 * 2026-09-04 手動テスト (1)(2) の直接修正 — host 側の新経路
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MSEL-04 rev3 / FR-SND-02 rev2）
 *
 * TC-MSEL-38: treeMdLinkIntoMd — 対象 md 末尾に `[[title]](rel.md)` を disk 直書きし、元 md を tree から除去（実体不動）
 * TC-MSEL-39: treeFileImportIntoOut / treeFileAttachIntoMd が成否 boolean を返す（batch 集計の材料）
 * TC-SND-16: prependImportEntriesToOutData — root 先頭に**選択順**で挿入・dir/md/file の写像が webview 版と同じ
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
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidh-note-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    const cleanup = () => { try { fs.rmSync(noteDir, { recursive: true, force: true }); } catch { /* ignore */ } };
    const mdId = (fp: string) => path.basename(fp, '.md');
    return { mod, m, noteDir, sender, messages, cleanup, mdId };
}

test.describe('TC-MSEL-38 treeMdLinkIntoMd（md → ツリー内 md item）', () => {
    test('対象 md 末尾に [[title]](rel) を追記し、元 md は tree から消えて実体は残る', () => {
        const s = setup();
        try {
            const srcPath = s.m.createMarkdownFile('Source Title');
            const dstPath = s.m.createMarkdownFile('Dest');
            const srcId = s.mdId(srcPath), dstId = s.mdId(dstPath);
            fs.writeFileSync(srcPath, '# Source Title\n\nbody\n', 'utf8');
            fs.writeFileSync(dstPath, '# Dest\n\ntext', 'utf8');   // 末尾改行なし → 追記時に補う
            const before = Object.keys(s.m.getStructure().items).length;

            const ok = s.mod.treeMdLinkIntoMd(s.m, s.sender, srcId, dstId);
            expect(ok).toBe(true);
            const dst = fs.readFileSync(dstPath, 'utf8');
            expect(dst, '末尾改行を補ってから 1 行追記').toBe(`# Dest\n\ntext\n[[Source Title]](${path.basename(srcPath)})\n`);
            expect(fs.existsSync(srcPath), '元 md 実体は不動（所有の移し替え）').toBe(true);
            expect(Object.keys(s.m.getStructure().items).length, '元 md が tree から除去されていない').toBe(before - 1);
            expect(s.messages.some((x) => x.type === 'notesFileListChanged'), 'ツリー再描画の通知が無い').toBe(true);
        } finally { s.cleanup(); }
    });

    test('自分自身 / 存在しない対象は false（batch 集計に失敗として届く）', () => {
        const s = setup();
        try {
            const a = s.m.createMarkdownFile('A');
            const aId = s.mdId(a);
            expect(s.mod.treeMdLinkIntoMd(s.m, s.sender, aId, aId)).toBe(false);
            expect(s.mod.treeMdLinkIntoMd(s.m, s.sender, aId, 'no-such-id')).toBe(false);
            expect(fs.readFileSync(a, 'utf8').includes('[['), '失敗時に本文へ書いてはいけない').toBe(false);
        } finally { s.cleanup(); }
    });
});

test.describe('TC-MSEL-39 単一関数の成否 boolean（NFR-MSEL-03）', () => {
    test('treeFileImportIntoOut: 成功 true / 不在 false。.out は開いていなくても JSON が更新される', () => {
        const s = setup();
        try {
            const outPath = s.m.createFile('Target');
            const outId = path.basename(outPath, '.out');
            const fid = s.m.registerTreeFile('r.pdf', 'r.pdf', null, 0, Buffer.from('x'));
            expect(s.mod.treeFileImportIntoOut(s.m, s.sender, fid, outId)).toBe(true);
            const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            const first = data.nodes[data.rootIds[0]];
            expect(first.filePath, 'root 先頭に file node が入っていない').toMatch(/r\.pdf$/);
            expect(s.mod.treeFileImportIntoOut(s.m, s.sender, 'no-such', outId)).toBe(false);
        } finally { s.cleanup(); }
    });

    test('treeFileAttachIntoMd: 成功 true / 不在 false', () => {
        const s = setup();
        try {
            const md = s.m.createMarkdownFile('M');
            const fid = s.m.registerTreeFile('r.pdf', 'r.pdf', null, 0, Buffer.from('x'));
            expect(s.mod.treeFileAttachIntoMd(s.m, s.sender, fid, s.mdId(md))).toBe(true);
            expect(fs.readFileSync(md, 'utf8')).toMatch(/\[📎 r\.pdf\]\(.*r\.pdf\)\n$/);
            expect(s.mod.treeFileAttachIntoMd(s.m, s.sender, 'no-such', s.mdId(md))).toBe(false);
        } finally { s.cleanup(); }
    });
});

test.describe('TC-SND-16 prependImportEntriesToOutData（開いていない .out へ host が直接積む）', () => {
    test('root 先頭に選択順・dir/md/file の写像が webview applySendToOutlinerResult と同じ', () => {
        const { prependImportEntriesToOutData } = requireWithVscodeStub('../../src/shared/folder-import');
        const data: any = { rootIds: ['old1'], nodes: { old1: { id: 'old1', parentId: null, children: [], text: 'existing' } } };
        const made = prependImportEntriesToOutData(data, [
            { kind: 'dir', name: 'docs', children: [
                { kind: 'md', name: 'inner.md', pageId: 'p-inner' },
                { kind: 'file', name: 'inner.pdf', filePath: 'files/inner.pdf' },
            ] },
            { kind: 'md', name: 'memo.md', pageId: 'p-memo' },
            { kind: 'file', name: 'memo.txt', filePath: 'files/memo.txt' },
        ]);
        expect(made).toBe(5);
        expect(data.rootIds.length).toBe(4);
        const top = data.rootIds.map((id: string) => data.nodes[id]);
        // ★ 選択順で先頭に並び、既存 root は最後尾に残る（unshift を N 回すると反転する）
        expect(top.map((n: any) => n.text)).toEqual(['docs', 'memo', 'memo.txt', 'existing']);
        expect(top[0].isPage).toBe(false); expect(top[0].filePath).toBeNull(); expect(top[0].children.length).toBe(2);
        const kids = top[0].children.map((id: string) => data.nodes[id]);
        expect(kids[0]).toMatchObject({ text: 'inner', isPage: true, pageId: 'p-inner', filePath: null, parentId: top[0].id });
        expect(kids[1]).toMatchObject({ text: 'inner.pdf', isPage: false, pageId: null, filePath: 'files/inner.pdf' });
        expect(top[1]).toMatchObject({ text: 'memo', isPage: true, pageId: 'p-memo', parentId: null });
        expect(top[2]).toMatchObject({ text: 'memo.txt', isPage: false, filePath: 'files/memo.txt' });
        // outliner-model.js と同じ必須フィールドが揃う（欠けると webview 側で undefined 参照になる）
        for (const n of Object.values(data.nodes) as any[]) {
            if (n.id === 'old1') { continue; }
            for (const k of ['id', 'parentId', 'children', 'text', 'tags', 'isPage', 'pageId', 'collapsed', 'checked', 'subtext', 'images', 'filePath']) {
                expect(Object.prototype.hasOwnProperty.call(n, k), `node.${k} が無い`).toBe(true);
            }
        }
    });

    test('entries が空なら不変・0', () => {
        const { prependImportEntriesToOutData } = requireWithVscodeStub('../../src/shared/folder-import');
        const data: any = { rootIds: ['a'], nodes: { a: { id: 'a' } } };
        expect(prependImportEntriesToOutData(data, [])).toBe(0);
        expect(data.rootIds).toEqual(['a']);
    });
});
