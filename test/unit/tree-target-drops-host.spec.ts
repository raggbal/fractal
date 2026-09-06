/**
 * 2026-09-04（rc.7 手動テスト）— note tree の `.out` / md item を drop 先にする host 経路（disk 直書き）。
 * TC-TGT-07 outNodeAssetsAttachToMdItem / TC-TGT-08 importMdFileLinkIntoOutFile / TC-TGT-09 linkMdLinkIntoMdItem
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
        if (r === 'vscode') { return { workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } }, Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) }, commands: { executeCommand: () => {} }, window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} }, env: {}, ViewColumn: {}, EventEmitter: class {} }; }
        // eslint-disable-next-line prefer-rest-params
        return o.apply(this, arguments as any);
    };
    try { return require(m); } finally { Module._load = o; purge(); }
}
function setup() {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-host-'));
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    const fm = new NotesFileManager(dir); fm.loadStructure();
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    const mdId = (fp: string) => path.basename(fp, '.md');
    return { mh, fm, dir, sender, messages, mdId, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

test('TC-TGT-07 outNodeAssetsAttachToMdItem: page + file を対象 md 末尾へリンク化し node から外す。画像は対象外で node に残る（保存・updateData 1 回）', () => {
    const s = setup();
    try {
        fs.writeFileSync(path.join(s.dir, 'pg.md'), '# Page G\n', 'utf8');
        fs.writeFileSync(path.join(s.dir, 'files', 'a.pdf'), 'x', 'utf8');
        fs.writeFileSync(path.join(s.dir, 'images', 'i.png'), 'x', 'utf8');
        const outPath = path.join(s.dir, 'w.out');
        fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: ['na', 'nb', 'nc'], nodes: {
            na: { id: 'na', text: 'A', children: [], isPage: true, pageId: 'pg' },
            nb: { id: 'nb', text: 'B', children: [], filePath: 'files/a.pdf', images: ['images/i.png'] },
            nc: { id: 'nc', text: 'C', children: [] },
        } }, null, 2));
        const dst = s.fm.createMarkdownFile('Dst'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        s.fm.openFile(outPath);
        const ok = s.mh.outNodeAssetsAttachToMdItem(s.fm, s.sender, {
            v: 1, outFileKey: outPath, nodeId: 'na', assets: [],
            items: [{ nodeId: 'na', assets: [{ kind: 'page', pageId: 'pg' }] }, { nodeId: 'nb', assets: [{ kind: 'file', filePath: 'files/a.pdf' }, { kind: 'image', src: 'images/i.png' }] }],
        }, s.mdId(dst));
        expect(ok).toBe(true);
        const md = fs.readFileSync(dst, 'utf8');
        // 直付き画像は対象外（R22）→ md に画像リンクは書かず、nb は画像を持ったまま残る
        expect(md).toBe('# Dst\n[[Page G]](pg.md)\n[📎 B](files/a.pdf)\n');
        const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(out.nodes.na, '添付を失った子なし node は削除').toBeUndefined();
        expect(out.nodes.nb, '画像を持つ node は残る').toBeTruthy();
        expect(out.nodes.nb.filePath).toBeNull();
        expect(out.nodes.nb.images).toEqual(['images/i.png']);
        expect(out.nodes.nc.text).toBe('C');
        expect(s.messages.filter((m) => m.type === 'updateData').length).toBe(1);
        expect(fs.existsSync(path.join(s.dir, 'pg.md')), '実体は不動').toBe(true);
    } finally { s.cleanup(); }
});

test('TC-TGT-07b assets 空 + items なし（file アイコン単一 drag）は node の添付を .out から集める', () => {
    const s = setup();
    try {
        fs.writeFileSync(path.join(s.dir, 'files', 'a.pdf'), 'x', 'utf8');
        const outPath = path.join(s.dir, 'w.out');
        fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: ['nb'], nodes: { nb: { id: 'nb', text: 'B', children: [], filePath: 'files/a.pdf' } } }));
        const dst = s.fm.createMarkdownFile('Dst'); fs.writeFileSync(dst, '# Dst', 'utf8');
        expect(s.mh.outNodeAssetsAttachToMdItem(s.fm, s.sender, { v: 1, outFileKey: outPath, nodeId: 'nb', assets: [] }, s.mdId(dst))).toBe(true);
        expect(fs.readFileSync(dst, 'utf8')).toBe('# Dst\n[📎 B](files/a.pdf)\n');
    } finally { s.cleanup(); }
});

test('TC-TGT-08 importMdFileLinkIntoOutFile: 開いていない .out の root 先頭へ file node、元 md からリンク除去', () => {
    const s = setup();
    try {
        fs.writeFileSync(path.join(s.dir, 'files', 'doc.pdf'), 'x', 'utf8');
        const src = s.fm.createMarkdownFile('Src'); fs.writeFileSync(src, '# Src\n\n[📎 doc.pdf](files/doc.pdf)\n\ntail\n', 'utf8');
        const outPath = path.join(s.dir, 'w.out');
        fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: ['old'], nodes: { old: { id: 'old', text: 'old', children: [] } } }));
        s.fm.openFile(src);   // .out は開いていない
        const ok = s.mh.importMdFileLinkIntoOutFile(s.fm, s.sender, { href: 'files/doc.pdf', sourceMdPath: src }, 'w');
        expect(ok).toBe(true);
        const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(out.rootIds.length).toBe(2);
        expect(out.nodes[out.rootIds[0]]).toMatchObject({ text: 'doc.pdf', filePath: 'files/doc.pdf', isPage: false });
        expect(fs.readFileSync(src, 'utf8').includes('doc.pdf'), '元 md からリンクが除去されていない').toBe(false);
        expect(s.messages.filter((m) => m.type === 'updateData').length, '開いていない .out に updateData を送らない').toBe(0);
    } finally { s.cleanup(); }
});

test('TC-TGT-09 linkMdLinkIntoMdItem: subpage / 📎 リンクを対象 md へ移す（元 md からは除去・自分自身は no-op）', () => {
    const s = setup();
    try {
        fs.writeFileSync(path.join(s.dir, 'files', 'doc.pdf'), 'x', 'utf8');
        const sub = s.fm.createMarkdownFile('Sub'); fs.writeFileSync(sub, '# Sub Title\n', 'utf8');
        const src = s.fm.createMarkdownFile('Src');
        fs.writeFileSync(src, `# Src\n\n[[Sub Title]](${path.basename(sub)})\n[📎 doc.pdf](files/doc.pdf)\n`, 'utf8');
        const dst = s.fm.createMarkdownFile('Dst'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        expect(s.mh.linkMdLinkIntoMdItem(s.fm, s.sender, { href: path.basename(sub), sourceMdPath: src, title: 'Sub Title' }, 'subpage', s.mdId(dst))).toBe(true);
        expect(s.mh.linkMdLinkIntoMdItem(s.fm, s.sender, { href: 'files/doc.pdf', sourceMdPath: src }, 'file', s.mdId(dst))).toBe(true);
        expect(fs.readFileSync(dst, 'utf8')).toBe(`# Dst\n[[Sub Title]](${path.basename(sub)})\n[📎 doc.pdf](files/doc.pdf)\n`);
        const srcNow = fs.readFileSync(src, 'utf8');
        expect(srcNow.includes(path.basename(sub)), 'subpage リンクが元 md に残っている').toBe(false);
        expect(srcNow.includes('doc.pdf'), '📎 リンクが元 md に残っている').toBe(false);
        // 自分自身へは no-op
        expect(s.mh.linkMdLinkIntoMdItem(s.fm, s.sender, { href: path.basename(sub), sourceMdPath: dst }, 'subpage', s.mdId(dst))).toBe(false);
        expect(fs.existsSync(sub), '実体は不動').toBe(true);
    } finally { s.cleanup(); }
});
