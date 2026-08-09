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
            // 元 node の filePath は null 化（所有移し替え）
            const after = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(after.nodes['n1'].filePath).toBe(null);
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
            const after = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(after.nodes['n1'].filePath).toBe(null);
        }
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
});
