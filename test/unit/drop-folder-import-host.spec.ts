/**
 * 2026-09-05 FR-DFI-01 — フォルダ D&D → Import folder 経路の host 側
 * TC-DFI-05 partitionDroppedUris / TC-DFI-06 materializeDroppedFolder（clamp）/ TC-DFI-07 importDroppedFoldersIntoOut（position 付き結果・実体コピー）
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
        if (r === 'vscode') { return { workspace: { getConfiguration: () => ({ get: () => undefined }) }, Uri: { file: (p: string) => ({ fsPath: p }) }, commands: { executeCommand: () => {} }, window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: async () => undefined }, env: {}, ViewColumn: {}, EventEmitter: class {} }; }
        // eslint-disable-next-line prefer-rest-params
        return o.apply(this, arguments as any);
    };
    try { return require(m); } finally { Module._load = o; purge(); }
}
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('TC-DFI-05 partitionDroppedUris: ディレクトリ URI と それ以外を分ける（不明 URI は others）', () => {
    const { partitionDroppedUris } = req('../../src/shared/drop-import');
    const d = tmp('dfi-part-');
    fs.mkdirSync(path.join(d, 'folder A'));
    fs.writeFileSync(path.join(d, 'a.pdf'), 'x');
    try {
        const r = partitionDroppedUris([`file://${d}/folder%20A`, `file://${d}/a.pdf`, 'https://example.com/x', `file://${d}/missing`]);
        expect(r.dirs).toEqual([path.join(d, 'folder A')]);
        expect(r.others).toEqual([`file://${d}/a.pdf`, 'https://example.com/x', `file://${d}/missing`]);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('TC-DFI-06 materializeDroppedFolder: tmp に実体化。`..` / 絶対 relPath は捨てる', () => {
    const { materializeDroppedFolder } = req('../../src/shared/drop-import');
    const r = materializeDroppedFolder({ name: 'pro/j', files: [
        { relPath: 'index.md', kind: 'md', content: '# Index' },
        { relPath: 'sub/doc.pdf', kind: 'file', bytesBase64: Buffer.from('PDF').toString('base64') },
        { relPath: 'sub/pic.png', kind: 'image', dataUrl: 'data:image/png;base64,' + Buffer.from('PNG').toString('base64') },
        { relPath: '../escape.md', kind: 'md', content: 'x' },
        { relPath: '/abs.md', kind: 'md', content: 'x' },
    ] });
    try {
        expect(r).toBeTruthy();
        expect(path.basename(r!.root), 'フォルダ名の危険文字が置換される').toBe('pro_j');
        expect(fs.readFileSync(path.join(r!.root, 'index.md'), 'utf8')).toBe('# Index');
        expect(fs.readFileSync(path.join(r!.root, 'sub', 'doc.pdf'), 'utf8')).toBe('PDF');
        expect(fs.readFileSync(path.join(r!.root, 'sub', 'pic.png'), 'utf8')).toBe('PNG');
        expect(r!.written).toBe(3);
        expect(fs.existsSync(path.join(r!.tmpBase, 'escape.md')), '`..` が tmpBase へ抜けた').toBe(false);
        expect(fs.existsSync('/abs.md')).toBe(false);
    } finally { fs.rmSync(r!.tmpBase, { recursive: true, force: true }); }
});

test('TC-DFI-07 importDroppedFoldersIntoOut: Import folder 経路で取り込み、position 付き importFolderResult を返す（tmp は呼び出し側が消す）', async () => {
    const { importDroppedFoldersIntoOut } = req('../../src/shared/folder-import-host');
    const note = tmp('dfi-note-');
    const src = tmp('dfi-src-');
    fs.mkdirSync(path.join(src, 'proj', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'proj', 'index.md'), '# Index\n\n[[Sub]](sub/inner.md)\n', 'utf8');
    fs.writeFileSync(path.join(src, 'proj', 'sub', 'inner.md'), '# Inner\n', 'utf8');
    fs.writeFileSync(path.join(src, 'proj', 'sub', 'doc.pdf'), 'PDF', 'utf8');
    const outPath = path.join(note, 'w.out');
    fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: [], nodes: {} }));
    const posted: any[] = [];
    try {
        const outcome = await importDroppedFoldersIntoOut(
            { pageDir: note, imageDir: path.join(note, 'images'), fileDir: path.join(note, 'files'), outDir: note },
            [path.join(src, 'proj')], { postMessage: (m: any) => posted.push(m) }, 'n-target', 'after');
        expect(outcome.status).toBe('imported');
        const res = posted.filter((m) => m.type === 'importFolderResult');
        expect(res.length).toBe(1);
        expect(res[0]).toMatchObject({ targetNodeId: 'n-target', position: 'after' });
        expect(res[0].entries.length).toBe(1);
        expect(res[0].entries[0].kind).toBe('dir');
        expect(res[0].entries[0].name).toBe('proj');
        const names = res[0].entries[0].children.map((c: any) => c.name).sort();
        // closure 抑止（R1）: index.md の subpage inner.md は index に随伴し node にならない → dir 'sub' 配下は doc.pdf のみ
        expect(names).toEqual(['index.md', 'sub']);
        const sub = res[0].entries[0].children.find((c: any) => c.kind === 'dir');
        expect(sub.children.map((c: any) => c.name)).toEqual(['doc.pdf']);
        // 実体は note にコピーされ、src は不変
        expect(fs.existsSync(path.join(src, 'proj', 'index.md'))).toBe(true);
        expect(fs.readdirSync(path.join(note, 'files'))).toContain('doc.pdf');
    } finally {
        fs.rmSync(note, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
});
