/**
 * Sprint 20260817-053313-notetree-local-folder-view — HOST-A
 * フォルダリンク（tree 第 4 管理対象）のデータモデル・ガード・CRUD host 端。
 * TC-FLV-01..07（TASK-01）/ TC-FLV-02,03 bridge 面 + TC-FLV-18, TC-FLV-49（TASK-03）/ TC-FLV-19（TASK-10）
 *
 * vscode を top-level import するモジュール群を stub require する。
 * stub-require は「require 直前 purge（掴まない）+ finally purge（残さない）」の対称
 * （generator_failures 2026-08-17 — 同 worker 先行 spec の cache 汚染を双方向で遮断）。
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

function makeVscodeStub() {
    const calls: { fsDelete: any[]; openExternal: any[]; clipboard: any[] } = { fsDelete: [], openExternal: [], clipboard: [] };
    const stub = {
        workspace: {
            getConfiguration: () => ({ get: () => undefined }),
            fs: {
                delete: async (uri: any, opts: any) => { calls.fsDelete.push({ path: uri && uri.fsPath, opts }); },
            },
        },
        Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
        commands: { executeCommand: () => {} },
        window: {},
        env: {
            openExternal: async (uri: any) => { calls.openExternal.push(uri && uri.fsPath); },
            clipboard: { writeText: async (t: string) => { calls.clipboard.push(t); } },
        },
        ViewColumn: {},
        EventEmitter: class {},
    };
    return { stub, calls };
}

function requireWithVscodeStub(modulePath: string, stub?: any): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache(); // 掴まない: 先行 spec が別 stub 下で評価した cache を使わない
    Module._load = function (request: string) {
        if (request === 'vscode') { return stub || makeVscodeStub().stub; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        // 残さない: 本 spec の stub 下で評価した cache を後続 spec に渡さない
        // （NotesFileManager クラス参照は返り値として保持されるので purge 後も使える）
        purgeSrcCache();
    }
}

function loadManagerClass(stub?: any): any {
    return requireWithVscodeStub('../../src/shared/notes-file-manager', stub).NotesFileManager;
}

function makeTmpNote(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-note-'));
    return dir;
}

function makeTmpFolder(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-link-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\nbody\n');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'text');
    return dir;
}

function readNoteJson(noteDir: string): any {
    return JSON.parse(fs.readFileSync(path.join(noteDir, 'outline.note'), 'utf8'));
}

test.describe('folder link host (TASK-01: data model / guard / listFiles / sync / strip)', () => {

    test('TC-FLV-01: folder item を含まない outline.note の read→write byte 不変 + folder キー非出力', () => {
        const NotesFileManager = loadManagerClass();
        const noteDir = makeTmpNote();
        // 既存 note 相当: .out 1 本を置いて初回 load（孤児取り込み → save）
        fs.writeFileSync(path.join(noteDir, 'a.out'), JSON.stringify({ title: 'A', rootIds: [], nodes: {} }));
        const m1 = new NotesFileManager(noteDir);
        m1.loadStructure();
        const bytes1 = fs.readFileSync(path.join(noteDir, 'outline.note'), 'utf8');
        // 別インスタンスで read → write（loadStructure は sync + save を行う）
        const m2 = new NotesFileManager(noteDir);
        m2.loadStructure();
        const bytes2 = fs.readFileSync(path.join(noteDir, 'outline.note'), 'utf8');
        expect(bytes2).toBe(bytes1);
        // folder 系フィールドが「無ければ出さない」
        expect(bytes2).not.toContain('folderPath');
        expect(bytes2).not.toContain('"folder"');
    });

    test('TC-FLV-02: registerFolderLink が items に ext:folder + folderPath を登録し saveStructure する', () => {
        const NotesFileManager = loadManagerClass();
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const id = m.registerFolderLink(linkDir);
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
        const json = readNoteJson(noteDir);
        const item = json.items[id];
        expect(item).toBeTruthy();
        expect(item.type).toBe('file');
        expect(item.ext).toBe('folder');
        expect(item.folderPath).toBe(linkDir);
        expect(item.title).toBe(path.basename(linkDir));
        expect(json.rootIds).toContain(id);
        // 既存 item（無し）の構造は folder 追加で壊れない: items は folder 1 件のみ
        expect(Object.keys(json.items)).toHaveLength(1);
    });

    test('TC-FLV-03: guardFolderSelection — 自身/祖先/子孫/symlink 経由/重複を reject・無関係は許可', () => {
        const NotesFileManager = loadManagerClass();
        const noteDir = makeTmpNote();
        fs.mkdirSync(path.join(noteDir, 'inner'));
        const m = new NotesFileManager(noteDir);
        m.loadStructure();

        // 自身
        expect(m.guardFolderSelection(noteDir).ok).toBe(false);
        // 祖先（noteDir の親）
        expect(m.guardFolderSelection(path.dirname(noteDir)).ok).toBe(false);
        // 子孫（noteDir 内のサブフォルダ）
        expect(m.guardFolderSelection(path.join(noteDir, 'inner')).ok).toBe(false);
        // symlink 経由で mainFolder を指す（realpath 検査の番人）
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-sym-'));
        const link = path.join(outside, 'to-note');
        fs.symlinkSync(noteDir, link, 'dir');
        expect(m.guardFolderSelection(link).ok).toBe(false);
        // 実在しないパス
        expect(m.guardFolderSelection(path.join(outside, 'nope')).ok).toBe(false);
        // 無関係フォルダ → 許可
        const linkDir = makeTmpFolder();
        expect(m.guardFolderSelection(linkDir).ok).toBe(true);
        // 重複（登録済み folderPath）→ reject（symlink 経由の同一実体も）
        m.registerFolderLink(linkDir);
        const g = m.guardFolderSelection(linkDir);
        expect(g.ok).toBe(false);
        expect(g.reason).toBe('duplicate');
        const link2 = path.join(outside, 'to-linkdir');
        fs.symlinkSync(linkDir, link2, 'dir');
        expect(m.guardFolderSelection(link2).ok).toBe(false);
    });

    test('TC-FLV-04: syncStructureWithDisk 第 4 分岐 — 実体不在 folder item は温存（file item は除去 = sync 実走の対照）', () => {
        const NotesFileManager = loadManagerClass();
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const folderId = m.registerFolderLink(linkDir);
        // 対照: 実体無しの tree file item を structure に直置き（実体欠損 → sync が除去する側）
        const s = m.getStructure();
        s.items['ghostfile'] = { type: 'file', id: 'ghostfile', title: 'ghost', ext: 'file', filename: 'no-such-entity.bin' };
        s.rootIds.push('ghostfile');
        m.saveStructure();
        // リンク先実体を消す（broken 化）
        fs.rmSync(linkDir, { recursive: true, force: true });
        // 新インスタンスで load（syncStructureWithDisk が走る）
        const m2 = new NotesFileManager(noteDir);
        const s2 = m2.loadStructure();
        // counterfactual: 第 4 分岐が無ければ folder item は .out 扱い → toRemove で消える = 本 assert が RED
        expect(s2.items[folderId]).toBeTruthy();
        expect((s2.items[folderId] as any).ext).toBe('folder');
        // 対照: 実体欠損の file item は従来どおり除去（sync が実際に走った証明）
        expect(s2.items['ghostfile']).toBeFalsy();
    });

    test('TC-FLV-05: listFiles 第 4 経路 — 実在で broken:false・実体不在でも列挙 broken:true・絶対パス不含', () => {
        const NotesFileManager = loadManagerClass();
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const id = m.registerFolderLink(linkDir);
        let entries = m.listFiles();
        let e = entries.find((x: any) => x.id === id);
        expect(e).toBeTruthy();
        expect(e.kind).toBe('folder');
        expect(e.broken).toBe(false);
        expect(String(e.filePath || '')).not.toContain(linkDir);
        // 実体を消す → それでも列挙 + broken:true（file item の「非列挙」と真逆）
        fs.rmSync(linkDir, { recursive: true, force: true });
        entries = m.listFiles();
        e = entries.find((x: any) => x.id === id);
        expect(e).toBeTruthy();
        expect(e.kind).toBe('folder');
        expect(e.broken).toBe(true);
    });

    test('TC-FLV-06: getStructureForWebview strip — folderPath 不出 + broken 派生（counterfactual: strip 無しなら絶対パス露出）', () => {
        const NotesFileManager = loadManagerClass();
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const id = m.registerFolderLink(linkDir);
        const wv = m.getStructureForWebview();
        const payload = JSON.stringify(wv);
        // strip: 絶対パス（値）とキーの両方が現れない
        expect(payload).not.toContain(linkDir);
        expect(payload).not.toContain('folderPath');
        // broken 派生フラグが付与される
        expect((wv.items[id] as any).broken).toBe(false);
        expect((wv.items[id] as any).ext).toBe('folder');
        // 非破壊: 内部 structure は folderPath を保持したまま
        expect((m.getStructure().items[id] as any).folderPath).toBe(linkDir);
        // broken 側
        fs.rmSync(linkDir, { recursive: true, force: true });
        const wv2 = m.getStructureForWebview();
        expect((wv2.items[id] as any).broken).toBe(true);
    });

    test('TC-FLV-07: resolveFolderRoot — 正常/実体不在 null/非 folder item null/未知 id null', () => {
        const NotesFileManager = loadManagerClass();
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const id = m.registerFolderLink(linkDir);
        expect(m.resolveFolderRoot(id)).toBe(linkDir);
        expect(m.resolveFolderRoot('no-such-id')).toBeNull();
        // 非 folder item（md item を直置き）
        const s = m.getStructure();
        s.items['mditem'] = { type: 'file', id: 'mditem', title: 'md', ext: 'md' };
        expect(m.resolveFolderRoot('mditem')).toBeNull();
        // 実体不在 → null（broken）
        fs.rmSync(linkDir, { recursive: true, force: true });
        expect(m.resolveFolderRoot(id)).toBeNull();
        // フォルダでなくファイルを指す → null
        const filePath = path.join(os.tmpdir(), `flv-file-${Date.now()}.txt`);
        fs.writeFileSync(filePath, 'x');
        (s.items[id] as any).folderPath = filePath;
        expect(m.resolveFolderRoot(id)).toBeNull();
    });
});

function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => { messages.push(m); } }, messages };
}

function makeDeps() {
    const calls: { openDialog: any[]; inputBox: any[]; errors: string[]; infos: string[]; exec: any[]; clipboard: string[] } =
        { openDialog: [], inputBox: [], errors: [], infos: [], exec: [], clipboard: [] };
    let dialogResult: string | undefined;
    let inputResult: string | undefined;
    const deps = {
        showOpenDialog: async (opts: any) => { calls.openDialog.push(opts); return dialogResult ? [{ fsPath: dialogResult }] : undefined; },
        showInputBox: async (opts: any) => { calls.inputBox.push(opts); return inputResult; },
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        showInformationMessage: (msg: string) => { calls.infos.push(msg); },
        executeCommand: (cmd: string, arg: any) => { calls.exec.push({ cmd, path: arg && arg.fsPath }); },
        clipboardWriteText: (text: string) => { calls.clipboard.push(text); },
        uriFile: (p: string) => ({ fsPath: p }),
        t: (_key: string) => undefined as any, // i18n 未解決 → 英語フォールバック経路
    };
    return { deps, calls, setDialog: (p?: string) => { dialogResult = p; }, setInput: (v?: string) => { inputResult = v; } };
}

test.describe('folder link CRUD bridge host 端（TASK-03）', () => {

    test('TC-FLV-02 (bridge 面): folderLinkAdd — showOpenDialog 引数・登録・strip 済み broadcast・キャンセル副作用ゼロ', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const { deps, calls, setDialog } = makeDeps();
        const { sender, messages } = makeSender();

        // キャンセル → 副作用ゼロ
        setDialog(undefined);
        const idNone = await mod.folderLinkAdd(m, deps as any, sender as any);
        expect(idNone).toBeNull();
        expect(messages).toHaveLength(0);
        expect(Object.keys(readNoteJson(noteDir).items)).toHaveLength(0);
        // ダイアログ引数（notesFolderProvider.addFolder 踏襲）
        expect(calls.openDialog[0].canSelectFolders).toBe(true);
        expect(calls.openDialog[0].canSelectFiles).toBe(false);
        expect(calls.openDialog[0].canSelectMany).toBe(false);

        // 選択 → 登録 + broadcast（payload は strip 済み = 絶対パス不含）
        setDialog(linkDir);
        const id = await mod.folderLinkAdd(m, deps as any, sender as any);
        expect(typeof id).toBe('string');
        expect(readNoteJson(noteDir).items[id].folderPath).toBe(linkDir);
        const listMsg = messages.find((x) => x.type === 'notesFileListChanged');
        expect(listMsg).toBeTruthy();
        expect(JSON.stringify(listMsg)).not.toContain(linkDir);
        const entry = listMsg.fileList.find((f: any) => f.id === id);
        expect(entry.kind).toBe('folder');
    });

    test('TC-FLV-03 (bridge 面): add/relink 経由の自己参照・重複ガード発火 + relink 成功で showFolderView 指示', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const { deps, calls, setDialog } = makeDeps();
        const { sender, messages } = makeSender();

        // add: 自己参照（note 自身）→ エラー・登録なし
        setDialog(noteDir);
        expect(await mod.folderLinkAdd(m, deps as any, sender as any)).toBeNull();
        expect(calls.errors.length).toBeGreaterThan(0);
        expect(Object.keys(readNoteJson(noteDir).items)).toHaveLength(0);

        // add 成功 → 重複 add → 「登録済み」通知・二重登録なし
        setDialog(linkDir);
        const id = await mod.folderLinkAdd(m, deps as any, sender as any);
        expect(id).toBeTruthy();
        setDialog(linkDir);
        expect(await mod.folderLinkAdd(m, deps as any, sender as any)).toBeNull();
        expect(Object.keys(readNoteJson(noteDir).items)).toHaveLength(1);

        // relink: 子孫を選ぶ → ガード発火・folderPath 不変
        const errBefore = calls.errors.length;
        fs.mkdirSync(path.join(noteDir, 'kid'));
        setDialog(path.join(noteDir, 'kid'));
        expect(await mod.folderLinkRelink(m, id, deps as any, sender as any)).toBe(false);
        expect(calls.errors.length).toBeGreaterThan(errBefore);
        expect(readNoteJson(noteDir).items[id].folderPath).toBe(linkDir);

        // relink 成功 → folderPath 更新 + showFolderView 指示（絶対パス不含）
        const newDir = makeTmpFolder();
        setDialog(newDir);
        expect(await mod.folderLinkRelink(m, id, deps as any, sender as any)).toBe(true);
        expect(readNoteJson(noteDir).items[id].folderPath).toBe(newDir);
        const showMsg = messages.find((x) => x.type === 'showFolderView');
        expect(showMsg).toBeTruthy();
        expect(showMsg.folderLinkId).toBe(id);
        expect(JSON.stringify(showMsg)).not.toContain(newDir);
    });

    test('TC-FLV-18: 危険サイト防御 — moveFileItemToOtherNote は folder を reject / getFilePathById は .out パスを返さない', () => {
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const noteDir = makeTmpNote();
        const dstNote = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const id = m.registerFolderLink(linkDir);
        // #4: folder item を Move Other Note に流すと reject（.out 複製経路に落ちない）
        expect(m.moveFileItemToOtherNote(id, dstNote)).toBeNull();
        expect(fs.existsSync(path.join(dstNote, `${id}.out`))).toBe(false);
        expect(readNoteJson(noteDir).items[id]).toBeTruthy(); // 元は無傷
        // #5: fileId→パス解決が `<id>.out` の fake パスを返さない
        const p = m.getFilePathById(id);
        expect(p).not.toContain(`${id}.out`);
        expect(p).toBe('');
    });

    test('TC-FLV-49: remove/rename/reveal/copyPath の host 端 — fs 非接触の番人', async () => {
        const { stub, calls: vsCalls } = makeVscodeStub();
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler', stub);
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager', stub);
        const noteDir = makeTmpNote();
        const linkDir = makeTmpFolder();
        const m = new NotesFileManager(noteDir);
        m.loadStructure();
        const id = m.registerFolderLink(linkDir);
        const { deps, calls, setInput } = makeDeps();
        const { sender, messages } = makeSender();

        // (b) rename: title のみ・folderPath 不変・実フォルダ名不変（fs.rename 不発）
        setInput('New Title');
        await mod.folderLinkRename(m, id, deps as any, sender as any);
        const afterRename = readNoteJson(noteDir).items[id];
        expect(afterRename.title).toBe('New Title');
        expect(afterRename.folderPath).toBe(linkDir);
        expect(fs.existsSync(linkDir)).toBe(true); // 実フォルダは同名のまま存在

        // (c) reveal: revealFileInOS が folderPath で呼ばれる
        mod.folderLinkReveal(m, id, deps as any);
        expect(calls.exec.find((e: any) => e.cmd === 'revealFileInOS' && e.path === linkDir)).toBeTruthy();

        // (d) copyPath: clipboard に folderPath・webview 応答に folderPath 不含
        mod.folderLinkCopyPath(m, id, deps as any);
        expect(calls.clipboard).toContain(linkDir);
        expect(JSON.stringify(messages)).not.toContain(linkDir);

        // (a) remove: 台帳のみ除去。fs 削除系（workspace.fs.delete）不発・実フォルダ無傷
        //     counterfactual: 既存 Delete 経路（deleteTreeFile = trash）に合流させると vsCalls.fsDelete が積まれ RED
        mod.folderLinkRemove(m, id, sender as any);
        expect(readNoteJson(noteDir).items[id]).toBeFalsy();
        expect(fs.existsSync(linkDir)).toBe(true);
        expect(vsCalls.fsDelete).toHaveLength(0);
        const listMsg = messages.find((x) => x.type === 'notesFileListChanged');
        expect(listMsg).toBeTruthy();
    });

    test('TASK-03 配線: handleNotesMessage の case dispatch（6 message type → platform メソッド）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const handle = mod.handleNotesMessage;
        const received: string[] = [];
        // 明示メソッド recorder（Proxy 禁止 — generator_failures 2026-08-09）
        const platform: any = {
            addFolderLink: () => { received.push('addFolderLink'); },
            relinkFolderLink: (id: string) => { received.push('relinkFolderLink:' + id); },
            removeFolderLink: (id: string) => { received.push('removeFolderLink:' + id); },
            renameFolderLink: (id: string) => { received.push('renameFolderLink:' + id); },
            revealFolderLink: (id: string) => { received.push('revealFolderLink:' + id); },
            copyFolderLinkPath: (id: string) => { received.push('copyFolderLinkPath:' + id); },
        };
        const { sender } = makeSender();
        const fm: any = {};
        await handle({ type: 'addFolderLink' }, fm, sender, platform);
        await handle({ type: 'relinkFolderLink', id: 'i1' }, fm, sender, platform);
        await handle({ type: 'removeFolderLink', id: 'i2' }, fm, sender, platform);
        await handle({ type: 'renameFolderLink', id: 'i3' }, fm, sender, platform);
        await handle({ type: 'revealFolderLink', id: 'i4' }, fm, sender, platform);
        await handle({ type: 'copyFolderLinkPath', id: 'i5' }, fm, sender, platform);
        expect(received).toEqual([
            'addFolderLink', 'relinkFolderLink:i1', 'removeFolderLink:i2',
            'renameFolderLink:i3', 'revealFolderLink:i4', 'copyFolderLinkPath:i5',
        ]);
    });
});

// ── TC-FLV-19: Clean Notes / S3 非関与 regression（TASK-10 / FR-FLV-05・NFR-FLV-04） ──

test.describe('TC-FLV-19 — Clean Notes / S3 非関与', () => {

    test('folder link 追加前後で cleanup 候補・S3 walkLocalDir 列挙が同一（リンク先実フォルダを走査しない）', async () => {
        const noteDir = makeTmpNote();
        const NotesFileManager = loadManagerClass();
        const m = new NotesFileManager(noteDir);
        // note らしい中身: 登録 md 1 本（live）+ files/ 直下に orphan 1 本（候補に載る = 空同士の trivially equal を防ぐ）
        m.registerMarkdownFile('# Hello\nbody\n', 'Hello', null, 0);
        fs.mkdirSync(path.join(noteDir, 'files'), { recursive: true });
        fs.writeFileSync(path.join(noteDir, 'files', 'orphan.bin'), 'x');
        // リンク先実フォルダ（note の外）: md / 画像 / file 入り — 走査されたら候補や列挙に混入する
        const linkDir = makeTmpFolder();
        fs.writeFileSync(path.join(linkDir, 'img.png'), 'p');
        fs.writeFileSync(path.join(linkDir, 'stray.md'), '# stray\n');

        const cleanup = requireWithVscodeStub('../../src/shared/cleanup-core');
        const s3 = requireWithVscodeStub('../../src/s3-per-file-sync');
        const before = await cleanup.scanSingleNoteCore(noteDir);
        const beforeWalk = Array.from(s3.walkLocalDir(noteDir).keys()).sort();
        expect(JSON.stringify(before), '前提: 候補列挙が空でない（orphan.bin）').toContain('orphan.bin');
        expect(beforeWalk.length).toBeGreaterThan(0);

        // folder link 登録（structure に ext:'folder' + folderPath が入る）
        m.registerFolderLink(linkDir);

        const after = await cleanup.scanSingleNoteCore(noteDir);
        const afterWalk = Array.from(s3.walkLocalDir(noteDir).keys()).sort();
        // cleanup: 候補が追加前と同一（folder item・リンク先とも非関与）
        expect(after).toEqual(before);
        expect(JSON.stringify(after), 'リンク先の絶対パスが候補に現れない').not.toContain(linkDir);
        // S3: 転送対象列挙（相対パス集合）が同一 — リンク先の stray.md / img.png / doc.md が混入しない
        expect(afterWalk).toEqual(beforeWalk);
        for (const k of afterWalk) {
            expect(k.includes('stray.md') || k.includes('img.png'), `リンク先実体が転送対象に混入: ${k}`).toBe(false);
        }
    });
});
