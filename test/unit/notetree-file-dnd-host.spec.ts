/**
 * notetree-file-dnd-host.spec.ts — tree file item（ext:'file'）の host 側 D&D 経路
 *
 * sprint 20260809-031217-notetree-file-dnd / TASK-02。
 * design/system.md §4a-§4g / §4y / §4z / §8 / ADRL-B。
 *
 * 検証対象（behavioral + counterfactual。source-contract 文字列 assert は使わない）:
 *  - TC-TF-11 (FR-TF-03): treeFileImportIntoOut — .out rootIds 先頭に {text,isPage:false,pageId:null,filePath:'files/<name>'} unshift + tree エントリ除去 + files/ 実体不動（ADRL-B 所有移し替え）
 *  - TC-TF-12 (FR-TF-04): treeFileAttachIntoMd — 対象 md 末尾に [📎 <title>](files/<filename>) 追記 + tree 除去 + 実体不動。📎 prefix を実 parser（extractMarkdownFileLinks）で拾う
 *  - TC-TF-13 (FR-TF-05a): treeFileImportAtPosition — dropFilesResult 互換 postback（results[{kind:'file',ok,title,filePath}] + targetNodeId + position）+ tree 除去
 *  - TC-TF-14 (FR-TF-05b): treeFileRegisterFromOutNode — 共有 files/ 配下 → copy なし登録 + node.filePath null 化 / legacy 配下 → files/ へ copy(§4z uniquify) 登録
 *  - TC-TF-15 (FR-TF-06b): treeFileRegisterFromMdLink — href=files/x.pdf + sourceMdPath → 登録 + removeFileLink 送出。traversal href（../../etc/passwd・encode 済み）は拒否（counterfactual）
 *  - TC-TF-18 (FR-TF-01): registerExternalDroppedFileItem — bytes(base64) → files/ に byte 一致保存（0x00-0xFF binary safe round-trip）+ 50MB 超 skip+notify + md は null
 *  - TC-TF-19 (FR-TF-06a): treeFileAttachToMdEditor — insertFileLink（markdownPath=files/<filename>・fileName=title）送出 + tree 除去 + 実体不動。main=currentFile / sidepanel=sidePanelFilePath 分岐（sidepanel 時に main へ送らない = counterfactual）
 *  - TC-TF-20 (§4z): 衝突解決が shared 版 generateUniqueFileNamePreserving 経由 — 連続ドット正当名 archive..tar.gz が保持される（counterfactual: 独自 replace/local shadow だと RED）
 *  - TC-SF-02 (FR-TF-13): buildFileLinkMarkdown round-trip — sanitize 済み filename + `]` 入り title（→`］`）で実 parseMarkdownLinks/extractMarkdownFileLinks が期待通り（counterfactual: sanitize を外すと `]` でラベル切れ / `?` 入り filename で抽出尻切り）
 *  - TC-SF-03 (FR-TF-13): attach 時リネーム — 違反名実体 bad?name.pdf を attach すると sanitize 名にリネームされリンクと一致
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

// notes-message-handler.ts は mindmap-export-host 経由で `vscode` を transitive import する
// （module-load 時ではなく関数内で触るため、`require('vscode')` を stub すれば実 seam を require して
// 直接呼べる — pdf-export-host.spec.ts / translate-routing.spec.ts と同じ確立パターン）。
// ここで検証する seam 関数（treeFile*・buildFileLinkMarkdown・registerExternalDroppedFileItem）は
// いずれも pure fs で vscode を一切触らないため、空 stub で足りる。
// import は hoist されるため、この Module._load 差し替えは下の require より必ず先に走る。
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string) {
    if (request === 'vscode') {
        return {
            workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
            Uri: { file: (p: string) => ({ fsPath: p }) },
            commands: { executeCommand: () => {} },
            window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
            env: {},
            ViewColumn: {},
        };
    }
    // eslint-disable-next-line prefer-rest-params
    return origLoad.apply(this, arguments as any);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mh = require('../../src/shared/notes-message-handler');
const {
    buildFileLinkMarkdown,
    treeFileImportIntoOut,
    treeFileAttachIntoMd,
    treeFileAttachToMdEditor,
    treeFileImportAtPosition,
    treeFileRegisterFromOutNode,
    treeFileRegisterFromMdLink,
    registerExternalDroppedFileItem,
} = mh;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser = require('../../src/shared/markdown-link-parser');
const parseMarkdownLinks: (t: string) => Array<{ kind: string; alt: string; url: string }> = parser.parseMarkdownLinks;
const extractMarkdownFileLinks: (md: string) => string[] = parser.extractMarkdownFileLinks;

function mkNote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'notetree-file-dnd-'));
}
function cleanup(dir: string): void {
    if (dir && fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); }
}
/** files/ 配下に raw structure insert で違反名 file item を作る（registerTreeFile は sanitize するため） */
function rawInsertFileItem(fm: NotesFileManager, filename: string, title: string): string {
    const filesDir = fm.getMdFilesDirPath();
    fs.mkdirSync(filesDir, { recursive: true });
    const id = (NotesFileManager as any).generateOutlineId() as string;
    const structure = fm.getStructure();
    (structure.items as any)[id] = { type: 'file', id, title, ext: 'file', filename };
    structure.rootIds.push(id);
    fm.saveStructure();
    return id;
}
/** .out に filePath 付き node を注入する（legacy / 共有 files/ 両ケースの setup 用） */
function injectOutNode(outPath: string, nodeId: string, text: string, filePath: string): void {
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    data.nodes = data.nodes || {};
    data.rootIds = data.rootIds || [];
    data.nodes[nodeId] = { id: nodeId, parentId: null, children: [], text, tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath };
    data.rootIds.push(nodeId);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
}
function fileItems(fm: NotesFileManager): any[] {
    return Object.values(fm.getStructure().items).filter((it: any) => it.type === 'file' && it.ext === 'file');
}

test.describe('tree file item host D&D 経路（seam）', () => {
    let dirs: string[] = [];
    const track = (d: string) => { dirs.push(d); return d; };
    const spy = () => { const msgs: any[] = []; return { sender: { postMessage: (m: any) => msgs.push(m) }, msgs }; };

    test.afterEach(() => { for (const d of dirs) { cleanup(d); } dirs = []; });
    test.afterAll(() => { Module._load = origLoad; });

    test('TC-TF-11: treeFileImportIntoOut — .out rootIds 先頭に file node unshift + tree 除去 + 実体不動', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const outPath = fm.createFile('OutDoc', null); // createFile は .out の path を返す
        const outId = path.basename(outPath, '.out');   // panel が渡す targetOutId = item id
        const fileId = fm.registerTreeFile('report.pdf', 'Report', null, 0);
        const entity = fm.getTreeFilePath(fileId) as string;
        fs.writeFileSync(entity, 'PDFBYTES');
        const entityBefore = fs.readFileSync(entity);

        const { sender } = spy();
        treeFileImportIntoOut(fm, sender, fileId, outId);

        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const headId = outData.rootIds[0];
        const node = outData.nodes[headId];
        expect(node.text).toBe('Report');
        expect(node.isPage).toBe(false);
        expect(node.pageId).toBe(null);
        expect(node.filePath).toBe('files/report.pdf');
        // tree エントリ除去
        expect(fm.getStructure().items[fileId]).toBeUndefined();
        // ADRL-B: files/ 実体は不動（所有移し替え）
        expect(fs.existsSync(entity)).toBe(true);
        expect(fs.readFileSync(entity).equals(entityBefore)).toBe(true);
    });

    test('TC-TF-12: treeFileAttachIntoMd — md 末尾に 📎 リンク追記 + tree 除去 + 実体不動', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const mdId = fm.registerMarkdownFile('# Doc\n\nbody\n', 'Doc', null, 0);
        const mdPath = fm.getMdFilePath(mdId);
        const fileId = fm.registerTreeFile('report.pdf', 'Report', null, 0);
        const entity = fm.getTreeFilePath(fileId) as string;
        fs.writeFileSync(entity, 'PDF');
        const before = fs.readFileSync(entity);

        const { sender } = spy();
        treeFileAttachIntoMd(fm, sender, fileId, mdId);

        const md = fs.readFileSync(mdPath, 'utf8');
        expect(md.includes('[📎 Report](files/report.pdf)')).toBe(true);
        // 実 parser で 📎 リンクとして拾える書式（cleanup extractMarkdownFileLinks 整合）
        expect(extractMarkdownFileLinks(md)).toContain('files/report.pdf');
        expect(fm.getStructure().items[fileId]).toBeUndefined();
        expect(fs.readFileSync(entity).equals(before)).toBe(true);
    });

    test('TC-TF-13: treeFileImportAtPosition — dropFilesResult 互換 postback + tree 除去', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const outPath = fm.createFile('OutDoc', null);
        const outId = path.basename(outPath, '.out');
        const fileId = fm.registerTreeFile('report.pdf', 'Report', null, 0);
        fs.writeFileSync(fm.getTreeFilePath(fileId) as string, 'PDF');

        const { sender, msgs } = spy();
        treeFileImportAtPosition(fm, sender, fileId, outId, 'node-42', 'child');

        const drop = msgs.find(m => m.type === 'dropFilesResult');
        expect(drop).toBeDefined();
        expect(drop.targetNodeId).toBe('node-42');
        expect(drop.position).toBe('child');
        expect(Array.isArray(drop.results)).toBe(true);
        const r = drop.results[0];
        expect(r.kind).toBe('file');
        expect(r.ok).toBe(true);
        expect(r.title).toBe('Report');
        expect(r.filePath).toBe('files/report.pdf');
        expect(fm.getStructure().items[fileId]).toBeUndefined();
    });

    test('TC-TF-14: treeFileRegisterFromOutNode — 共有 files/ 配下は copy なし登録+node null化 / legacy は copy+uniquify', () => {
        // branch A: node.filePath が共有 files/ 配下 → copy なし
        {
            const dir = track(mkNote());
            const fm = new NotesFileManager(dir);
            const filesDir = fm.getMdFilesDirPath();
            fs.mkdirSync(filesDir, { recursive: true });
            fs.writeFileSync(path.join(filesDir, 'report.pdf'), 'PDF');
            const outPath = fm.createFile('OutDoc', null);
            injectOutNode(outPath, 'n1', 'Report', 'files/report.pdf');

            const { sender } = spy();
            treeFileRegisterFromOutNode(fm, sender, { outFileKey: outPath, nodeId: 'n1' }, null, 0);

            const items = fileItems(fm);
            expect(items.length).toBe(1);
            expect(items[0].filename).toBe('report.pdf');
            // 共有 files/ 配下は重複コピーされない（files/ は report.pdf 1 個のまま）
            expect(fs.readdirSync(filesDir)).toEqual(['report.pdf']);
            // FR-TF-05b 改訂（2026-08-10）: 子なし node は node ごと削除（旧: filePath null 化 → 空 text node 残留が不自然）
            const after = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(after.nodes['n1']).toBeUndefined();
            expect(after.rootIds).not.toContain('n1');
        }
        // branch B: node.filePath が legacy per-id dir（files/ 配下でない）→ copy + uniquify
        {
            const dir = track(mkNote());
            const fm = new NotesFileManager(dir);
            const legacyDir = path.join(dir, 'oldassets');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, 'legacy.bin'), 'LEGACY');
            const outPath = fm.createFile('OutDoc', null);
            injectOutNode(outPath, 'n1', 'Legacy', 'oldassets/legacy.bin');

            const { sender } = spy();
            treeFileRegisterFromOutNode(fm, sender, { outFileKey: outPath, nodeId: 'n1' }, null, 0);

            const items = fileItems(fm);
            expect(items.length).toBe(1);
            expect(items[0].filename).toBe('legacy.bin');
            const filesDir = fm.getMdFilesDirPath();
            expect(fs.existsSync(path.join(filesDir, 'legacy.bin'))).toBe(true);
            expect(fs.readFileSync(path.join(filesDir, 'legacy.bin'), 'utf8')).toBe('LEGACY');
            // FR-TF-05b 改訂: legacy 経路でも子なし node は削除
            const after = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(after.nodes['n1']).toBeUndefined();
            expect(after.rootIds).not.toContain('n1');
        }
    });

    // TC-MX-01 (FR-TF-05b 改訂 2026-08-10): 子なし file node → tree 登録後に node 自体が消える
    //（counterfactual: filePath null 化のみの旧実装だと nodes['n1'] が残り RED）
    test('TC-MX-01: 子なし file node → 登録後に node が .out から完全に消える（nodes/rootIds/親children）', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const filesDir = fm.getMdFilesDirPath();
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'a.pdf'), 'A');
        const outPath = fm.createFile('OutDoc', null);
        // 親 node の子として file node を注入（rootIds 直下でない = 親 children からの除去を検証）
        const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        data.nodes = data.nodes || {}; data.rootIds = data.rootIds || [];
        data.nodes['parent'] = { id: 'parent', parentId: null, children: ['child-f'], text: 'P', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null };
        data.nodes['child-f'] = { id: 'child-f', parentId: 'parent', children: [], text: 'a.pdf', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: 'files/a.pdf' };
        data.rootIds.push('parent');
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');

        const { sender } = spy();
        treeFileRegisterFromOutNode(fm, sender, { outFileKey: outPath, nodeId: 'child-f' }, null, 0);

        expect(fileItems(fm).length).toBe(1);
        const after = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(after.nodes['child-f']).toBeUndefined();
        expect(after.nodes['parent'].children).not.toContain('child-f');
        expect(after.rootIds).not.toContain('child-f');
    });

    // TC-MX-02 (FR-TF-05b 改訂): 子ありの file node は従来どおり filePath null 化で温存（子の喪失防止）
    test('TC-MX-02: 子ありの file node → filePath null 化で node 温存・子は無傷', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const filesDir = fm.getMdFilesDirPath();
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'b.pdf'), 'B');
        const outPath = fm.createFile('OutDoc', null);
        const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        data.nodes = data.nodes || {}; data.rootIds = data.rootIds || [];
        data.nodes['f-with-kids'] = { id: 'f-with-kids', parentId: null, children: ['kid'], text: 'b.pdf', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: 'files/b.pdf' };
        data.nodes['kid'] = { id: 'kid', parentId: 'f-with-kids', children: [], text: 'memo', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null };
        data.rootIds.push('f-with-kids');
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');

        const { sender } = spy();
        treeFileRegisterFromOutNode(fm, sender, { outFileKey: outPath, nodeId: 'f-with-kids' }, null, 0);

        expect(fileItems(fm).length).toBe(1);
        const after = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(after.nodes['f-with-kids']).toBeDefined();
        expect(after.nodes['f-with-kids'].filePath).toBe(null);
        expect(after.nodes['f-with-kids'].children).toEqual(['kid']);
        expect(after.nodes['kid'].text).toBe('memo');
    });

    // TC-MX-05 (FR-TF-14 2026-08-10): insertNodeAtDropPosition — 位置指定挿入 / 省略時は先頭 unshift（後方互換）
    test('TC-MX-05: insertNodeAtDropPosition — before/after/child の位置挿入 + 省略時は rootIds 先頭（後方互換）', () => {
        const mk = () => ({
            nodes: {
                a: { id: 'a', parentId: null, children: ['a1'] },
                a1: { id: 'a1', parentId: 'a', children: [] },
                b: { id: 'b', parentId: null, children: [] },
            } as Record<string, any>,
            rootIds: ['a', 'b'],
        });
        const ins = (mh as any).insertNodeAtDropPosition;
        expect(typeof ins).toBe('function');

        // before
        let d = mk(); d.nodes['x'] = { id: 'x', parentId: null, children: [] };
        ins(d, 'x', 'b', 'before');
        expect(d.rootIds).toEqual(['a', 'x', 'b']);
        // after
        d = mk(); d.nodes['x'] = { id: 'x', parentId: null, children: [] };
        ins(d, 'x', 'a', 'after');
        expect(d.rootIds).toEqual(['a', 'x', 'b']);
        // child（先頭）+ parentId 設定
        d = mk(); d.nodes['x'] = { id: 'x', parentId: null, children: [] };
        ins(d, 'x', 'a', 'child');
        expect(d.nodes['a'].children).toEqual(['x', 'a1']);
        expect(d.nodes['x'].parentId).toBe('a');
        // 子階層の before（siblings = 親の children）
        d = mk(); d.nodes['x'] = { id: 'x', parentId: null, children: [] };
        ins(d, 'x', 'a1', 'before');
        expect(d.nodes['a'].children).toEqual(['x', 'a1']);
        expect(d.nodes['x'].parentId).toBe('a');
        // 省略（null/null）= 従来の先頭 unshift（後方互換 counterfactual）
        d = mk(); d.nodes['x'] = { id: 'x', parentId: null, children: [] };
        ins(d, 'x', null, null);
        expect(d.rootIds).toEqual(['x', 'a', 'b']);
        // 不明 target = 先頭 unshift にフォールバック
        d = mk(); d.nodes['x'] = { id: 'x', parentId: null, children: [] };
        ins(d, 'x', 'ghost', 'before');
        expect(d.rootIds).toEqual(['x', 'a', 'b']);
    });

    test('TC-TF-15: treeFileRegisterFromMdLink — files/x.pdf 登録+removeFileLink / traversal href 拒否', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const filesDir = fm.getMdFilesDirPath();
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'x.pdf'), 'XDATA');
        const sourceMdPath = path.join(dir, 'note1.md');
        fs.writeFileSync(sourceMdPath, '# note1\n\n[📎 X](files/x.pdf)\n', 'utf8');

        // 正常 href
        const { sender, msgs } = spy();
        treeFileRegisterFromMdLink(fm, sender, { href: 'files/x.pdf', sourceMdPath }, null, 0);

        const items = fileItems(fm);
        expect(items.length).toBe(1);
        expect(items[0].filename).toBe('x.pdf');
        expect(fs.existsSync(fm.getTreeFilePath(items[0].id) as string)).toBe(true);
        const rm = msgs.find(m => m.type === 'removeFileLink');
        expect(rm).toBeDefined();
        expect(rm.href).toBe('files/x.pdf');
        expect(rm.sourceMdPath).toBe(sourceMdPath);

        // counterfactual: 素の traversal href は拒否（item 追加なし・removeFileLink なし）
        const before = Object.keys(fm.getStructure().items).length;
        const s2 = spy();
        treeFileRegisterFromMdLink(fm, s2.sender, { href: '../../etc/passwd', sourceMdPath }, null, 0);
        expect(Object.keys(fm.getStructure().items).length).toBe(before);
        expect(s2.msgs.find(m => m.type === 'removeFileLink')).toBeUndefined();

        // counterfactual: encode 済み traversal も拒否（decodeURIComponent 後に / が生じる）
        const s3 = spy();
        treeFileRegisterFromMdLink(fm, s3.sender, { href: '..%2F..%2Fetc%2Fpasswd', sourceMdPath }, null, 0);
        expect(Object.keys(fm.getStructure().items).length).toBe(before);
        expect(s3.msgs.find(m => m.type === 'removeFileLink')).toBeUndefined();
    });

    test('TC-TF-18: registerExternalDroppedFileItem — binary round-trip + 50MB skip+notify + md は null', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);

        // 0x00-0xFF 全値の binary が byte 一致で保存される
        const buf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const id = registerExternalDroppedFileItem(fm, { kind: 'file', name: 'bin.dat', bytes: buf.toString('base64') }, null, 0, () => {});
        expect(id).toBeTruthy();
        const entity = fm.getTreeFilePath(id as string) as string;
        expect(fs.readFileSync(entity).equals(buf)).toBe(true);

        // 50MB 超は skip + notify（base64 長から decode 前に推定・巨大 Buffer を作らない）
        const notified: string[] = [];
        const bigB64 = 'A'.repeat(68 * 1024 * 1024); // 推定 ~53.5MB > 50MB
        const bigId = registerExternalDroppedFileItem(fm, { kind: 'file', name: 'big.bin', bytes: bigB64 }, null, 0, (n: string) => notified.push(n));
        expect(bigId).toBeNull();
        expect(notified).toContain('big.bin');
        expect(fileItems(fm).some((it: any) => it.filename === 'big.bin' || /^big/.test(it.filename))).toBe(false);

        // md item はこの関数では扱わない（従来経路）→ null
        const mdRes = registerExternalDroppedFileItem(fm, { kind: 'md', name: 'x.md', content: '# x' } as any, null, 0, () => {});
        expect(mdRes).toBeNull();
    });

    test('TC-TF-19: treeFileAttachToMdEditor — main=currentFile / sidepanel=sidePanelFilePath 分岐 + insertFileLink + tree 除去', () => {
        // main: sidePanelFilePath なし → currentFile 宛て・sidePanelFilePath フィールドなし
        {
            const dir = track(mkNote());
            const fm = new NotesFileManager(dir);
            const mdId = fm.registerMarkdownFile('# Main\n', 'Main', null, 0);
            const mdPath = fm.getMdFilePath(mdId);
            fm.openFile(mdPath); // currentFile = mdPath
            const fileId = fm.registerTreeFile('report.pdf', 'Report', null, 0);
            const entity = fm.getTreeFilePath(fileId) as string;
            const before = fs.readFileSync(entity);

            const { sender, msgs } = spy();
            treeFileAttachToMdEditor(fm, sender, fileId, undefined);

            const ins = msgs.find(m => m.type === 'insertFileLink');
            expect(ins).toBeDefined();
            expect(ins.markdownPath).toBe('files/report.pdf');
            expect(ins.fileName).toBe('Report'); // §4f: fileName=title
            // counterfactual: main は sidePanelFilePath フィールドを持たない（sidepanel 誤送出防止）
            expect('sidePanelFilePath' in ins).toBe(false);
            expect(fm.getStructure().items[fileId]).toBeUndefined();
            expect(fs.readFileSync(entity).equals(before)).toBe(true);
        }
        // sidepanel: sidePanelFilePath 指定 → その md 宛て・sidePanelFilePath フィールドあり
        {
            const dir = track(mkNote());
            const fm = new NotesFileManager(dir);
            const spId = fm.registerMarkdownFile('# SP\n', 'SP', null, 0);
            const spPath = fm.getMdFilePath(spId);
            // main は別 .out を開く（currentFile ≠ sp → sidepanel 分岐でないと壊れる setup）
            const outPath = fm.createFile('OutDoc', null);
            fm.openFile(outPath);
            const fileId = fm.registerTreeFile('report.pdf', 'Report', null, 0);

            const { sender, msgs } = spy();
            treeFileAttachToMdEditor(fm, sender, fileId, spPath);

            const ins = msgs.find(m => m.type === 'insertFileLink');
            expect(ins).toBeDefined();
            expect(ins.sidePanelFilePath).toBe(spPath); // sidepanel 宛て
            expect(ins.markdownPath).toBe('files/report.pdf');
            expect(ins.fileName).toBe('Report');
            expect(fm.getStructure().items[fileId]).toBeUndefined();
        }
    });

    test('TC-TF-20: registerExternalDroppedFileItem — 連続ドット名 archive..tar.gz が保持される（shared uniquify 経由）', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const id = registerExternalDroppedFileItem(fm, { kind: 'file', name: 'archive..tar.gz', bytes: Buffer.from('DATA').toString('base64') }, null, 0, () => {});
        expect(id).toBeTruthy();
        const item = fm.getStructure().items[id as string] as any;
        // 連続ドットは破壊されない（§4z: shared generateUniqueFileNamePreserving は厳密名 . / .. のみガード）
        expect(item.filename).toBe('archive..tar.gz');
        // counterfactual: global /\.\./g replace / local shadow だと 'archivetar.gz' に破壊される
        expect(item.filename).not.toBe('archivetar.gz');
        expect(path.basename(fm.getTreeFilePath(id as string) as string)).toBe('archive..tar.gz');
    });

    test('TC-SF-02: buildFileLinkMarkdown round-trip — sanitize 済み filename + `]` 入り title で実 parser が期待通り', () => {
        const title = 'Summary ]2026 report'; // `]` を含む（label 終端衝突文字）
        const relPath = 'files/report_v2.pdf'; // sanitize 済み（?#[] なし）
        const link = buildFileLinkMarkdown(title, relPath);
        const md = `intro\n\n${link}\n\nafter`;

        const links = parseMarkdownLinks(md);
        const fileLink = links.find(l => l.kind === 'link' && l.alt.trim().indexOf('📎') === 0);
        expect(fileLink).toBeDefined();
        expect((fileLink as any).url).toBe(relPath);          // url 完全一致（`]` で切れない）
        expect((fileLink as any).alt.includes(']')).toBe(false); // 半角 `]` は `］` に置換済み
        expect(extractMarkdownFileLinks(md)).toContain(relPath);

        // counterfactual (a): sanitize を外し title の `]` をそのまま流すとラベルが切れ url が取れない
        const rawLink = `[📎 ${title}](${relPath})`;
        const rawParsed = parseMarkdownLinks(`x ${rawLink} y`);
        const rawFileLink = rawParsed.find(l => l.kind === 'link' && l.alt.trim().indexOf('📎') === 0);
        expect((rawFileLink as any)?.url).not.toBe(relPath);
        expect(extractMarkdownFileLinks(`x ${rawLink} y`)).not.toContain(relPath);

        // counterfactual (b): `?` 入り filename は extractMarkdownFileLinks が split(/[?#]/) で尻切りする
        const rawName = 'report?v2.pdf';
        const sanitizedName = (NotesFileManager as any).sanitizeTreeFileName(rawName) as string; // 'report_v2.pdf'
        const goodLink = buildFileLinkMarkdown('Doc', `files/${sanitizedName}`);
        expect(extractMarkdownFileLinks(goodLink)).toContain(`files/${sanitizedName}`);
        const badLink = buildFileLinkMarkdown('Doc', `files/${rawName}`);
        expect(extractMarkdownFileLinks(badLink)).not.toContain(`files/${rawName}`);
        expect(extractMarkdownFileLinks(badLink)).toContain('files/report'); // 尻切りされた形
    });

    test('TC-SF-03: attach 時リネーム — 違反名実体 bad?name.pdf を attach すると sanitize 名にリネームされリンクと一致', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const mdId = fm.registerMarkdownFile('# Doc\n', 'Doc', null, 0);
        const mdPath = fm.getMdFilePath(mdId);
        const filesDir = fm.getMdFilesDirPath();
        const badPath = path.join(filesDir, 'bad?name.pdf');
        fs.writeFileSync(badPath, 'DATA');
        const badId = rawInsertFileItem(fm, 'bad?name.pdf', 'Bad');

        const { sender } = spy();
        treeFileAttachIntoMd(fm, sender, badId, mdId);

        const sanitized = 'bad_name.pdf';
        expect(fs.existsSync(path.join(filesDir, sanitized))).toBe(true); // sanitize 名にリネーム
        expect(fs.existsSync(badPath)).toBe(false);                        // 旧名は消えた
        const md = fs.readFileSync(mdPath, 'utf8');
        expect(md.includes(`files/${sanitized}`)).toBe(true);              // リンクが sanitize 名を参照
        expect(extractMarkdownFileLinks(md)).toContain(`files/${sanitized}`);
    });

    // ═══════════════════════════════════════════════════════════════════
    // 再オープン③ (2026-08-10): FR-TF-17 VS Code Explorer uri-list（TC-UL-03/04）
    // ═══════════════════════════════════════════════════════════════════

    test('TC-UL-03: registerExternalDroppedUris — md/file 振り分け・非 file: scheme/不存在/ディレクトリ skip・index 連番・postback 1 回', () => {
        const { registerExternalDroppedUris } = mh;
        expect(typeof registerExternalDroppedUris).toBe('function'); // 未実装なら即 RED

        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        // 外部ソース側（drop 元のファイル群）
        const srcDir = track(mkNote());
        const mdSrc = path.join(srcDir, 'Notes File.md');
        fs.writeFileSync(mdSrc, '# Hello\nbody', 'utf8');
        const pdfSrc = path.join(srcDir, 'Report.pdf');
        fs.writeFileSync(pdfSrc, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])); // binary
        const subDir = path.join(srcDir, 'a-directory');
        fs.mkdirSync(subDir);

        const { sender, msgs } = spy();
        const toUri = (p: string) => require('url').pathToFileURL(p).href;
        registerExternalDroppedUris(
            fm,
            [
                toUri(mdSrc),                          // → registerMarkdownFile
                'vscode-remote://wsl/etc/hosts',       // 非 file: scheme → skip
                toUri(path.join(srcDir, 'missing.txt')), // 不存在 → skip
                toUri(subDir),                         // ディレクトリ → skip
                toUri(pdfSrc),                         // → registerTreeFile
            ],
            null, 0, sender
        );

        const structure = fm.getStructure();
        const items = Object.values(structure.items) as any[];
        const mdItem = items.find((it) => it.ext === 'md');
        const fileItem = items.find((it) => it.ext === 'file');
        expect(mdItem).toBeTruthy();
        expect(mdItem.title).toBe('Hello'); // H1 から title（既存 md 経路 resolveSubpageTitle と同じ）
        expect(fileItem).toBeTruthy();
        expect(fileItem.filename).toBe('Report.pdf');
        // 実体 = files/ に byte 一致で保存（binary safe）
        const entity = fm.getTreeFilePath(fileItem.id) as string;
        expect(Buffer.compare(fs.readFileSync(entity), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))).toBe(0);
        // 挿入順 = uri 列挙順（md が index0・pdf が index1。skip 3 件は index を消費しない）
        expect(structure.rootIds.indexOf(mdItem.id)).toBe(0);
        expect(structure.rootIds.indexOf(fileItem.id)).toBe(1);
        // postback は 1 回（notesFileListChanged）
        expect(msgs.filter((m) => m.type === 'notesFileListChanged').length).toBe(1);
        // 元ファイルは不変（OS 側）
        expect(fs.existsSync(mdSrc)).toBe(true);
        expect(fs.existsSync(pdfSrc)).toBe(true);
    });

    test('TC-UL-04: registerExternalDroppedUris — 50MB 超も登録される（uri-list 経路は cap なし）', () => {
        const { registerExternalDroppedUris } = mh;
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const srcDir = track(mkNote());
        const bigSrc = path.join(srcDir, 'big.bin');
        // 51MB の sparse 書き（実 buffer は端点のみ — CI コスト最小化）
        const fd = fs.openSync(bigSrc, 'w');
        fs.ftruncateSync(fd, 51 * 1024 * 1024);
        fs.closeSync(fd);

        const { sender } = spy();
        const uri = require('url').pathToFileURL(bigSrc).href;
        registerExternalDroppedUris(fm, [uri], null, 0, sender);

        const fileItem = (Object.values(fm.getStructure().items) as any[]).find((it) => it.ext === 'file');
        expect(fileItem).toBeTruthy(); // counterfactual: buffered 経路の 50MB cap に誤合流すると skip = RED
        const entity = fm.getTreeFilePath(fileItem.id) as string;
        expect(fs.statSync(entity).size).toBe(51 * 1024 * 1024);
    });


    // ═══════════════════════════════════════════════════════════════════
    // 再オープン⑤ (2026-08-10): FR-TF-18 cross-note = source orphan 契約（TC-CN-06/07/08）
    // ═══════════════════════════════════════════════════════════════════

    test('TC-CN-07(tree-file): 別 note md への attach — dest コピー + dest 相対リンク + 元台帳除去 + 元実体温存', () => {
        const { treeFileAttachToMdEditor } = mh;
        const srcNote = track(mkNote());
        const dstNote = track(mkNote());
        const fm = new NotesFileManager(srcNote);
        const fileId = fm.registerTreeFile('report.pdf', 'Report', null, 0, Buffer.from('PDFDATA'));
        const srcEntity = fm.getTreeFilePath(fileId) as string;
        // 別 note の md（sidepanel で開いている想定）
        const dstMd = path.join(dstNote, 'target.md');
        fs.writeFileSync(dstMd, '# dst\n', 'utf8');

        const { sender, msgs } = spy();
        treeFileAttachToMdEditor(fm, sender, fileId, dstMd);

        // (a) dest note の files/ に実体コピー
        const dstFiles = path.join(dstNote, 'files');
        expect(fs.existsSync(path.join(dstFiles, 'report.pdf'))).toBe(true);
        expect(fs.readFileSync(path.join(dstFiles, 'report.pdf'), 'utf8')).toBe('PDFDATA');
        // (b) insertFileLink の markdownPath は dest 相対（`../` 跨ぎを含まない）
        const ins = msgs.find((m) => m.type === 'insertFileLink');
        expect(ins).toBeTruthy();
        expect(String(ins.markdownPath).includes('..')).toBe(false); // counterfactual: 跨ぎリンク方式だと ../ 混入 = RED
        expect(ins.markdownPath).toBe('files/report.pdf');
        // (c) 元台帳除去
        expect(fileItems(fm).length).toBe(0);
        // (d) 元実体は温存（source orphan 契約 — counterfactual: move 方式だと消えて RED）
        expect(fs.existsSync(srcEntity)).toBe(true);
    });

    test('TC-CN-08: 同一 note 内の attach は従来どおり所有移し替え（コピーなし・実体不動）', () => {
        const { treeFileAttachToMdEditor } = mh;
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const fileId = fm.registerTreeFile('doc.pdf', 'Doc', null, 0, Buffer.from('D'));
        const entity = fm.getTreeFilePath(fileId) as string;
        const md = path.join(dir, 'main.md');
        fs.writeFileSync(md, '# main\n', 'utf8');

        const { sender, msgs } = spy();
        treeFileAttachToMdEditor(fm, sender, fileId, md);

        const ins = msgs.find((m) => m.type === 'insertFileLink');
        expect(ins.markdownPath).toBe('files/doc.pdf');
        // コピーが発生していない（files/ には元の 1 実体のみ）
        const filesDir = path.dirname(entity);
        expect(fs.readdirSync(filesDir).length).toBe(1);
        expect(fs.existsSync(entity)).toBe(true);
        expect(fileItems(fm).length).toBe(0); // 移し替えで台帳は消える
    });


    test('TC-CN-06: tree md → 別 note sidepanel — 複製 + 元 tree item 除去（cmd+x 統一・旧 = 温存から変更）', () => {
        const { linkMdAsSubpageForSidePanelCore } = mh;
        const srcNote = track(mkNote());
        const dstNote = track(mkNote());
        const fm = new NotesFileManager(srcNote);
        const mdId = fm.registerMarkdownFile('# Doc\nbody', 'Doc', null, 0);
        const srcMdPath = fm.getMdFilePath(mdId);
        const dstMd = path.join(dstNote, 'panel.md');
        fs.writeFileSync(dstMd, '# dst\n', 'utf8');

        const { sender, msgs } = spy();
        linkMdAsSubpageForSidePanelCore(fm, sender, srcMdPath, mdId, dstMd);

        // 複製が dst md の隣にできる
        const ins = msgs.find((m) => m.type === 'insertSubpageLink');
        expect(ins).toBeTruthy();
        expect(String(ins.markdownPath).includes('..')).toBe(false);
        // 元 tree item 除去（counterfactual: 旧挙動 = 温存だと RED）
        const items = Object.values(fm.getStructure().items) as any[];
        expect(items.find((it) => it.id === mdId)).toBeFalsy();
        // 元 md 実体は温存（source orphan 契約）
        expect(fs.existsSync(srcMdPath)).toBe(true);
    });


    test('TC-CN-07(out-node-file): 別 note md への attach — dest コピー + 元 node 後始末 + 元実体温存', () => {
        const { attachOutNodeFileToMd } = mh;
        const srcNote = track(mkNote());
        const dstNote = track(mkNote());
        const fm = new NotesFileManager(srcNote);
        // src note に .out + file 添付 node（共有 files/ 配下の実体）
        const outPath = fm.createFile('OutDoc', null);
        const filesDir = fm.getMdFilesDirPath();
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'att.pdf'), 'ATT');
        injectOutNode(outPath, 'n1', 'att.pdf', path.relative(path.dirname(outPath), path.join(filesDir, 'att.pdf')));
        const dstMd = path.join(dstNote, 'panel.md');
        fs.writeFileSync(dstMd, '# dst\n', 'utf8');

        const { sender, msgs } = spy();
        attachOutNodeFileToMd(fm, sender, { outFileKey: outPath, nodeId: 'n1' }, dstMd);

        // dest コピー + dest 相対リンク
        expect(fs.existsSync(path.join(dstNote, 'files', 'att.pdf'))).toBe(true);
        const ins = msgs.find((m) => m.type === 'insertFileLink');
        expect(ins.markdownPath).toBe('files/att.pdf');
        expect(String(ins.markdownPath).includes('..')).toBe(false);
        // 元 node は子なし → 削除（FR-TF-05b 規約）
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(outData.nodes.n1).toBeUndefined();
        // 元実体温存（source orphan 契約）
        expect(fs.existsSync(path.join(filesDir, 'att.pdf'))).toBe(true);
    });

    test('TC-CN-07(md-filelink): 別 note md への attach — dest コピー + 元リンク除去 message + 元実体温存', () => {
        const { attachMdFileLinkToMd } = mh;
        const srcNote = track(mkNote());
        const dstNote = track(mkNote());
        const fm = new NotesFileManager(srcNote); // fileManager は受け側 note のものとは限らない — 関数は src md 基準で解決
        const srcMd = path.join(srcNote, 'src.md');
        fs.writeFileSync(srcMd, '[📎 x](files/x.pdf)\n', 'utf8');
        const srcFiles = path.join(srcNote, 'files');
        fs.mkdirSync(srcFiles, { recursive: true });
        fs.writeFileSync(path.join(srcFiles, 'x.pdf'), 'X');
        const dstMd = path.join(dstNote, 'panel.md');
        fs.writeFileSync(dstMd, '# dst\n', 'utf8');

        const { sender, msgs } = spy();
        attachMdFileLinkToMd(fm, sender, { href: 'files/x.pdf', sourceMdPath: srcMd }, dstMd);

        expect(fs.existsSync(path.join(dstNote, 'files', 'x.pdf'))).toBe(true);
        const ins = msgs.find((m) => m.type === 'insertFileLink');
        expect(ins.markdownPath).toBe('files/x.pdf');
        // 元リンク除去 message
        expect(msgs.find((m) => m.type === 'removeFileLink')).toBeTruthy();
        // 元実体温存
        expect(fs.existsSync(path.join(srcFiles, 'x.pdf'))).toBe(true);
    });


    test('TC-CN-04(cross-note): 別 note md の 📎 リンク → outliner 取込で dest files/ へコピー + 元実体温存', () => {
        const { importMdFileLinkIntoOut } = mh;
        const srcNote = track(mkNote());
        const dstNote = track(mkNote());
        const fm = new NotesFileManager(dstNote); // drop 先 .out の note
        const outPath = fm.createFile('OutDoc', null);
        const outId = path.basename(outPath, '.out');
        // src note の md + files/ 実体
        const srcMd = path.join(srcNote, 'src.md');
        fs.writeFileSync(srcMd, '[📎 y](files/y.pdf)\n', 'utf8');
        const srcFiles = path.join(srcNote, 'files');
        fs.mkdirSync(srcFiles, { recursive: true });
        fs.writeFileSync(path.join(srcFiles, 'y.pdf'), 'Y');

        const { sender, msgs } = spy();
        importMdFileLinkIntoOut(fm, sender, { href: 'files/y.pdf', sourceMdPath: srcMd }, outId, null, null);

        // dest note の files/ にコピー + dropFilesResult の filePath は dest 相対（../ 不含）
        expect(fs.existsSync(path.join(dstNote, 'files', 'y.pdf'))).toBe(true);
        const dr = msgs.find((m) => m.type === 'dropFilesResult');
        expect(dr).toBeTruthy();
        expect(String(dr.results[0].filePath).includes('..')).toBe(false);
        // 元リンク除去 message + 元実体温存
        expect(msgs.find((m) => m.type === 'removeFileLink')).toBeTruthy();
        expect(fs.existsSync(path.join(srcFiles, 'y.pdf'))).toBe(true);
    });

});
