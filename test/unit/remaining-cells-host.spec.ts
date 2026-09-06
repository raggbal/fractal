/**
 * 2026-09-05 R24..R28 — host 側
 * TC-RC-07 registerFolderIntoTree / registerExternalDroppedUris(dir) / TC-RC-08 buildExportNodesFromOutData / TC-RC-09 expandDroppedPathsToFiles
 * TC-RC-10 folderViewMoveIntoMd({writeToDisk}) = 対象 md 末尾へ 📎 行・元は trash
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purge(): void { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; } } }
function req(m: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module'); const o = Module._load; purge();
    Module._load = function (r: string) {
        if (r === 'vscode') { return { workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } }, Uri: { file: (p: string) => ({ fsPath: p }) }, commands: { executeCommand: () => {} }, window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: async () => undefined }, env: {}, ViewColumn: {}, EventEmitter: class {} }; }
        // eslint-disable-next-line prefer-rest-params
        return o.apply(this, arguments as any);
    };
    try { return require(m); } finally { Module._load = o; purge(); }
}
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('TC-RC-07 registerFolderIntoTree: tree フォルダ + md/file + サブフォルダを index 位置に登録。dir URI の drop も同経路', () => {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const note = tmp('rc-note-'); const src = tmp('rc-src-');
    fs.mkdirSync(path.join(src, 'proj', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'proj', 'a.md'), '# A\n'); fs.writeFileSync(path.join(src, 'proj', 'b.pdf'), 'PDF');
    fs.writeFileSync(path.join(src, 'proj', 'sub', 'c.md'), '# C\n'); fs.writeFileSync(path.join(src, 'proj', '.hidden'), 'x');
    try {
        const fm = new NotesFileManager(note); fm.loadStructure();
        const m1 = path.basename(fm.createMarkdownFile('M1'), '.md'); const m2 = path.basename(fm.createMarkdownFile('M2'), '.md');
        const before = fm.getStructure().rootIds.slice();   // [m2, m1]（createMarkdownFile は先頭）
        const made = mh.registerFolderIntoTree(fm, path.join(src, 'proj'), null, 1);
        expect(made, 'フォルダ 1 + a.md + b.pdf + sub + c.md = 5').toBe(5);
        const st = fm.getStructure();
        expect(st.rootIds.length).toBe(3);
        const folderId = st.rootIds[1];
        expect((st.items[folderId] as any)).toMatchObject({ type: 'folder', title: 'proj' });
        const kids = (st.items[folderId] as any).childIds.map((id: string) => st.items[id] as any);
        expect(kids.map((k: any) => [k.type, k.title])).toEqual([['file', 'A'], ['file', 'b.pdf'], ['folder', 'sub']]);
        expect(kids[0].ext).toBe('md'); expect(kids[1].ext).toBe('file');
        const subKids = kids[2].childIds.map((id: string) => (st.items[id] as any).title);
        expect(subKids).toEqual(['C']);
        expect(st.rootIds[0]).toBe(before[0]); expect(st.rootIds[2]).toBe(before[1]);
        // 実体は note にコピー（src は不変）
        expect(fs.existsSync(path.join(src, 'proj', 'a.md'))).toBe(true);
        expect(fs.readdirSync(path.join(note, 'files'))).toContain('b.pdf');
        // dir URI も registerExternalDroppedUris で同経路
        const posted: any[] = [];
        const r = mh.registerExternalDroppedUris(fm, [`file://${src}/proj`], null, 0, { postMessage: (x: any) => posted.push(x) });
        expect(r.registered).toBe(1); expect(r.failed).toEqual([]);
        expect((fm.getStructure().items[fm.getStructure().rootIds[0]] as any)).toMatchObject({ type: 'folder', title: 'proj' });
    } finally { fs.rmSync(note, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test('TC-RC-08 buildExportNodesFromOutData: webview buildExportTree と同じ写像（子孫再帰・不在 id は落とす）', () => {
    const { buildExportNodesFromOutData } = req('../../src/shared/notes-message-handler');
    const out = { nodes: {
        a: { id: 'a', text: 'A', subtext: 's', children: ['a1'], isPage: true, pageId: 'p', images: ['images/i.png'] },
        a1: { id: 'a1', text: 'A1', children: [], filePath: 'files/f.pdf' },
        b: { id: 'b', text: 'B', children: [] },
    } };
    const t = buildExportNodesFromOutData(out, ['a', 'zzz', 'b']);
    expect(t.map((n: any) => n.text)).toEqual(['A', 'B']);
    expect(t[0]).toMatchObject({ text: 'A', subtext: 's', pageId: 'p', filePath: null, images: ['images/i.png'] });
    expect(t[0].children[0]).toMatchObject({ text: 'A1', pageId: null, filePath: 'files/f.pdf' });
});

test('TC-RC-09 expandDroppedPathsToFiles: dir を再帰展開（名前順・dotfile 除外・入力順保持）', () => {
    const { expandDroppedPathsToFiles } = req('../../src/shared/drop-import');
    const d = tmp('rc-exp-');
    fs.mkdirSync(path.join(d, 'f', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'f', 'b.md'), 'x'); fs.writeFileSync(path.join(d, 'f', 'a.txt'), 'x'); fs.writeFileSync(path.join(d, 'f', 'sub', 'c.png'), 'x'); fs.writeFileSync(path.join(d, 'f', '.DS_Store'), 'x'); fs.writeFileSync(path.join(d, 'z.pdf'), 'x');
    try {
        const files = expandDroppedPathsToFiles([path.join(d, 'z.pdf'), path.join(d, 'f'), path.join(d, 'missing')]);
        expect(files).toEqual([path.join(d, 'z.pdf'), path.join(d, 'f', 'a.txt'), path.join(d, 'f', 'b.md'), path.join(d, 'f', 'sub', 'c.png')]);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('TC-RC-10 folderViewMoveIntoMd({writeToDisk}): 対象 md（開いていない）末尾へ 📎 行、実体は note の files/ へ、元は trash', async () => {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const note = tmp('rc-note2-'); const root = tmp('rc-fv-');
    fs.writeFileSync(path.join(root, 'doc.pdf'), 'PDF');
    try {
        const fm = new NotesFileManager(note); fm.loadStructure();
        const linkId = fm.registerFolderLink(root);
        const dst = fm.createMarkdownFile('Dst'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        const trashed: string[] = []; const posted: any[] = [];
        const deps = { showErrorMessage: () => {}, t: () => undefined, trashDelete: async (p: string) => { trashed.push(p); fs.rmSync(p, { force: true }); }, toDisplayUri: (p: string) => p };
        const ok = await mh.folderViewMoveIntoMd(fm, linkId, 'doc.pdf', dst, deps, { postMessage: (x: any) => posted.push(x) }, { writeToDisk: true });
        expect(ok).toBe(true);
        expect(fs.readFileSync(dst, 'utf8')).toBe('# Dst\n[📎 doc.pdf](files/doc.pdf)\n');
        expect(posted.filter((m) => m.type === 'insertFileLink').length, '開いていない md へ editor 挿入を post してはいけない').toBe(0);
        expect(fs.existsSync(path.join(note, 'files', 'doc.pdf'))).toBe(true);
        expect(trashed).toEqual([path.join(root, 'doc.pdf')]);
    } finally { fs.rmSync(note, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});
