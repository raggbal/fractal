/**
 * TC-FTM-01/02（host 側）— +file ボタン + New link folder（sprint 20260818-183407 FR-FTM-01/02）
 * ハーネス: 実 fs (mkdtemp) + NotesFileManager 直駆動（dailynotes-flat-archive precedent）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
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
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showWarningMessage: () => {} },
                env: { clipboard: { writeText: () => {} } },
                ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

function mkNote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-'));
}
const noopSender = { postMessage: () => {} } as any;

test('TC-FTM-01a addTreeFilesFromPaths: .md は md item / 他は file item として登録（+file ダイアログ確定経路）', () => {
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    expect(typeof mod.addTreeFilesFromPaths).toBe('function');

    const note = mkNote();
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-ext-'));
    fs.writeFileSync(path.join(ext, 'doc.md'), '# Doc Title\nbody\n');
    fs.writeFileSync(path.join(ext, 'sheet.pdf'), 'PDFBIN');

    const fm = new NotesFileManager(note);
    mod.addTreeFilesFromPaths(fm, [path.join(ext, 'doc.md'), path.join(ext, 'sheet.pdf')], noopSender);

    const items = fm.getStructure().items;
    const kinds = Object.values(items).map((it: any) => it.ext);
    expect(kinds).toContain('md');
    expect(kinds).toContain('file');
    // md は H1 title・file は元名保持で files/ に実体
    const mdItem: any = Object.values(items).find((it: any) => it.ext === 'md');
    expect(mdItem.title).toBe('Doc Title');
    const fileItem: any = Object.values(items).find((it: any) => it.ext === 'file');
    expect(fileItem.filename).toBe('sheet.pdf');
    expect(fs.existsSync(path.join(note, 'files', 'sheet.pdf'))).toBe(true);
});

test('TC-FTM-01b addTreeFilesFromPaths: 空配列 = 副作用ゼロ（キャンセル経路・台帳 byte 不変）', () => {
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const note = mkNote();
    const fm = new NotesFileManager(note);
    fm.getStructure(); // 初期化
    const before = fs.existsSync(path.join(note, 'outline.note')) ? fs.readFileSync(path.join(note, 'outline.note'), 'utf8') : null;
    mod.addTreeFilesFromPaths(fm, [], noopSender);
    const after = fs.existsSync(path.join(note, 'outline.note')) ? fs.readFileSync(path.join(note, 'outline.note'), 'utf8') : null;
    expect(after).toBe(before);
});

test('TC-FTM-02u registerFolderLink(parentId): サブフォルダ配下へ登録・省略は root（従来互換）', () => {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const note = mkNote();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-target-'));
    const fm = new NotesFileManager(note);
    fm.createFolder('sub', null, null);
    const folderId = (Object.values(fm.getStructure().items) as any[]).find((it) => it.type === 'folder' && it.title === 'sub').id;
    // 従来互換（root）
    const id1 = fm.registerFolderLink(target);
    expect(fm.getStructure().rootIds).toContain(id1);
    const target2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-target2-'));
    const id2 = fm.registerFolderLink(target2, folderId);
    expect((fm.getStructure().items[folderId] as any).childIds).toContain(id2);
    expect(fm.getStructure().rootIds).not.toContain(id2);
});

test('TC-FTM-02h folderLinkAdd(parentId): ダイアログ確定でその場所に登録', async () => {
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const note = mkNote();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-target3-'));
    const fm = new NotesFileManager(note);
    fm.createFolder('sub', null, null);
    const folderId = (Object.values(fm.getStructure().items) as any[]).find((it) => it.type === 'folder' && it.title === 'sub').id;
    const deps = {
        showOpenDialog: async () => [{ fsPath: target }],
        t: (k: string) => k,
        showWarningMessage: () => {},
        uriFile: (p: string) => ({ fsPath: p }),
    };
    const id = await mod.folderLinkAdd(fm, deps as any, noopSender, folderId);
    expect(id).toBeTruthy();
    expect((fm.getStructure().items[folderId] as any).childIds).toContain(id);
});

// ─── TC-FTM-03/04/05/06: tree item Duplicate（FR-FTM-03・TASK-15） ───

test('TC-FTM-03 md item Duplicate: 実体 + 本文 asset を複製し元と分離（元削除でも複製無傷）', () => {
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    expect(typeof mod.duplicateTreeItemCore).toBe('function');
    const note = mkNote();
    const fm = new NotesFileManager(note);
    fs.mkdirSync(path.join(note, 'images'), { recursive: true });
    fs.writeFileSync(path.join(note, 'images', 'pic.png'), 'PNG');
    const mdId = fm.registerMarkdownFile('# Doc\n![i](images/pic.png)\n', 'Doc', null, 0);
    mod.duplicateTreeItemCore(fm, mdId, noopSender);

    const items: any = fm.getStructure().items;
    const mdItems = Object.values(items).filter((it: any) => it.ext === 'md');
    expect(mdItems.length).toBe(2);
    const dupItem: any = mdItems.find((it: any) => it.id !== mdId);
    // 台帳位置 = 元の直後
    const roots = fm.getStructure().rootIds;
    expect(roots.indexOf(dupItem.id)).toBe(roots.indexOf(mdId) + 1);
    // 実体分離: 複製 md は複製画像を参照（元画像を共有しない）
    const dupBody = fs.readFileSync(fm.getMdFilePath(dupItem.id), 'utf8');
    expect(dupBody).toContain('images/pic-1.png');
    expect(fs.existsSync(path.join(note, 'images', 'pic-1.png'))).toBe(true);
    // 元 md 削除でも複製無傷
    fs.rmSync(fm.getMdFilePath(mdId));
    expect(fs.readFileSync(fm.getMdFilePath(dupItem.id), 'utf8')).toContain('# Doc');
});

test('TC-FTM-08 md item Duplicate: 本文 subpage も再帰複製（mainFolder 境界の貫通 — ADRL-0078 改訂版）', () => {
    // 2026-08-19 再オープン（手動テスト指摘）: subpage/file/image の再帰複製
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const note = mkNote();
    const fm = new NotesFileManager(note);
    fs.mkdirSync(path.join(note, 'images'), { recursive: true });
    fs.writeFileSync(path.join(note, 'images', 'deep.png'), 'DEEP');
    fs.writeFileSync(path.join(note, 'sub.md'), '# Sub\n![d](images/deep.png)\n');
    const mdId = fm.registerMarkdownFile('# Doc\n[[Sub]](sub.md)\n', 'Doc', null, 0);
    mod.duplicateTreeItemCore(fm, mdId, noopSender);

    const items: any = fm.getStructure().items;
    const dupItem: any = Object.values(items).find((it: any) => it.ext === 'md' && it.id !== mdId);
    const dupBody = fs.readFileSync(fm.getMdFilePath(dupItem.id), 'utf8');
    // subpage は複製され新名を指す・subpage の画像も複製（再帰）
    expect(dupBody).toContain('(sub-1.md)');
    expect(fs.readFileSync(path.join(note, 'sub-1.md'), 'utf8')).toContain('images/deep-1.png');
    expect(fs.existsSync(path.join(note, 'images', 'deep-1.png'))).toBe(true);
    // 元は不変
    expect(fs.readFileSync(fm.getMdFilePath(mdId), 'utf8')).toContain('(sub.md)');
});

test('TC-FTM-04 out item Duplicate: page md/file/images の deep copy（複製側編集が元に非影響）', () => {
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const note = mkNote();
    const fm = new NotesFileManager(note);
    fs.writeFileSync(path.join(note, 'pgA.md'), '# PageA\n');
    fs.mkdirSync(path.join(note, 'files'), { recursive: true });
    fs.writeFileSync(path.join(note, 'files', 'att.bin'), 'BIN');
    fs.writeFileSync(path.join(note, 'myout.out'), JSON.stringify({
        version: 1, title: 'My Out', rootIds: ['n1', 'n2'],
        nodes: {
            n1: { id: 'n1', text: 'p', isPage: true, pageId: 'pgA', children: [] },
            n2: { id: 'n2', text: 'f', filePath: 'files/att.bin', children: [] },
        },
    }));
    const st = fm.getStructure();
    st.items['myout'] = { type: 'file', id: 'myout', title: 'My Out' } as any;
    st.rootIds.push('myout');
    fm.saveStructure();

    mod.duplicateTreeItemCore(fm, 'myout', noopSender);
    const items: any = fm.getStructure().items;
    const dupItem: any = Object.values(items).find((it: any) => it.id !== 'myout' && it.type === 'file' && !it.ext);
    expect(dupItem).toBeTruthy();
    const dupOut = JSON.parse(fs.readFileSync(path.join(note, `${dupItem.id}.out`), 'utf8'));
    expect(dupOut.nodes.n1.pageId).toBe('pgA-1');
    expect(dupOut.nodes.n2.filePath).toBe('files/att-1.bin');
    expect(fs.existsSync(path.join(note, 'pgA-1.md'))).toBe(true);
    // 複製側 page md を編集しても元不変
    fs.writeFileSync(path.join(note, 'pgA-1.md'), 'EDITED');
    expect(fs.readFileSync(path.join(note, 'pgA.md'), 'utf8')).toBe('# PageA\n');
});

test('TC-FTM-05 file item Duplicate: files/ uniquify 複製 + 元の直後に新 item', () => {
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const note = mkNote();
    const fm = new NotesFileManager(note);
    const fid = fm.registerTreeFile('doc.pdf', 'doc.pdf', null, 0, Buffer.from('PDF'));
    mod.duplicateTreeItemCore(fm, fid, noopSender);
    const items: any = fm.getStructure().items;
    const dup: any = Object.values(items).find((it: any) => it.ext === 'file' && it.id !== fid);
    expect(dup).toBeTruthy();
    expect(dup.filename).toBe('doc-1.pdf');
    expect(fs.readFileSync(path.join(note, 'files', 'doc-1.pdf'), 'utf8')).toBe('PDF');
    const roots = fm.getStructure().rootIds;
    expect(roots.indexOf(dup.id)).toBe(roots.indexOf(fid) + 1);
});

test('TC-FTM-06 Duplicate 後の liveFiles 整合: 元・複製双方の実体が liveFiles に入る（Clean Notes 非回収）', () => {
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const cleanup = requireWithVscodeStub('../../src/shared/cleanup-core');
    const note = mkNote();
    const fm = new NotesFileManager(note);
    const fid = fm.registerTreeFile('keep.pdf', 'keep.pdf', null, 0, Buffer.from('K'));
    mod.duplicateTreeItemCore(fm, fid, noopSender);
    const liveFiles = new Set<string>();
    cleanup.addNotesFilesToLiveSet(fm.getStructure(), note, liveFiles);
    const paths = Array.from(liveFiles);
    expect(paths.some((p) => p.endsWith('keep.pdf'))).toBe(true);
    expect(paths.some((p) => p.endsWith('keep-1.pdf'))).toBe(true);
});

// ─── TC-BLD-01: 本番 inline 配線の番人（NFR-BAT-05・sprint 20260818-183407 最終 regression） ───

test('TC-BLD-01 本番 notes webview に whole-word.js が inline され +file ボタンが HTML に含まれる', () => {
    const { getNotesWebviewContent } = requireWithVscodeStub('../../src/notesWebviewContent');
    const html: string = getNotesWebviewContent(
        {
            asWebviewUri: (u: any) => 'vscode-resource://' + ((u && u.fsPath) || String(u)),
            cspSource: 'vscode-webview:',
        } as any,
        { fsPath: path.join(__dirname, '../../') } as any,
        {
            webviewMessages: {}, fontSize: 14, theme: 'light', toolbarMode: 'full',
            showTranslateButtons: false, showOpenInTextEditor: false, enableDebugLogging: false,
            documentBaseUri: '', folderName: 'note',
        } as any,
        {
            jsonContent: JSON.stringify({ version: 1, rootIds: [], nodes: {} }),
            currentFilePath: '/x/a.out', currentFileTitle: 'a', fileChangeId: 0,
            fileList: [], structure: { version: 1, rootIds: [], items: {} },
            history: [], historyPanelCollapsed: true, historyPanelHeight: 120,
            initialMd: null, noteFolderName: 'note', noteSidePanelWidth: null,
            noteSidePanelOutlineWidth: null, panelCollapsed: false, panelWidth: null,
        } as any
    );
    // FR-MLG-02: whole-word.js の本番 inline（counterfactual: 登録漏れ = harness だけ動く silent no-op — generator_failures 2026-08-17）
    expect(html.includes('buildWholeWordRegex'), 'whole-word.js の本番 inline').toBe(true);
    // FR-FTM-01: +file ボタンが本番 HTML に含まれる
    expect(html.includes('filePanelAddFileEntity'), '+file ボタンの本番 HTML').toBe(true);
});
