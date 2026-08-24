/**
 * Sprint 20260817-053313-notetree-local-folder-view — HOST-B
 * folder view の fs 操作: 二段 clamp（TASK-02）+ bridge 台帳 #6-16 の host 端（TASK-04/05）。
 * TC-FLV-08, 09（TASK-02）/ TC-FLV-10..14, 20（TASK-04）/ TC-FLV-15..17, 47（TASK-05）
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

function requireWithVscodeStub(modulePath: string, stub?: any): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return stub || {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: {}, env: {}, ViewColumn: {}, EventEmitter: class {},
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
        // 残さない: 本 spec の stub 下で評価した cache を後続 spec に渡さない（掴まない側と対称 —
        // generator_failures 2026-08-17。返り値として保持した class/関数参照は purge 後も使える）
        purgeSrcCache();
    }
}

function makeRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flv-root-'));
}

test.describe('safeResolveUnderFolderRoot (TASK-02: 二段 clamp)', () => {

    test('TC-FLV-08: lexical clamp — ../ / 絶対パス / ..%2F 生文字列 / 正常相対', () => {
        const { safeResolveUnderFolderRoot } = requireWithVscodeStub('../../src/shared/path-safety');
        const root = makeRoot();
        fs.mkdirSync(path.join(root, 'sub'));
        fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x');

        // 正常相対 → 解決
        expect(safeResolveUnderFolderRoot(root, 'sub/a.txt')).toBe(path.join(root, 'sub', 'a.txt'));
        expect(safeResolveUnderFolderRoot(root, '')).toBe(root); // ルート自身
        // traversal → null（counterfactual: lexical clamp を外すと folderRoot 外を返す = RED）
        expect(safeResolveUnderFolderRoot(root, '../x')).toBeNull();
        expect(safeResolveUnderFolderRoot(root, 'sub/../../x')).toBeNull();
        expect(safeResolveUnderFolderRoot(root, '..')).toBeNull();
        // 絶対パス → null
        expect(safeResolveUnderFolderRoot(root, '/etc/passwd')).toBeNull();
        expect(safeResolveUnderFolderRoot(root, 'C:\\x')).toBeNull();
        // encode 済み traversal は decode されず生文字列として扱われる
        //（decodeURIComponent を挟まない — generator_failures 2026-08-05。decode すると `/` が復活し escape する）。
        // 既存 safeResolveUnderDir の保守的 clamp（`..` 始まりの名前は一律 reject）に合流して null
        //（本質 = folderRoot 外へ絶対に解決されないこと）
        expect(safeResolveUnderFolderRoot(root, '..%2F..%2Fetc')).toBeNull();
        // decode 済みの本物の traversal も当然 null
        expect(safeResolveUnderFolderRoot(root, decodeURIComponent('..%2F..%2Fetc'))).toBeNull();
    });

    test('TC-FLV-09a: realpath 実体検査（書き込み系）— symlink 越しの folderRoot 外書き込み・削除を遮断', () => {
        const { safeResolveUnderFolderRoot } = requireWithVscodeStub('../../src/shared/path-safety');
        const root = makeRoot();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-outside-'));
        fs.writeFileSync(path.join(outside, 'victim.txt'), 'precious');
        // folderRoot 内に外部 dir への symlink
        fs.symlinkSync(outside, path.join(root, 'esc'), 'dir');
        // symlink dir 越しの解決（既存ファイル / 新規作成先の両方）→ 遮断
        expect(safeResolveUnderFolderRoot(root, 'esc/victim.txt')).toBeNull();
        expect(safeResolveUnderFolderRoot(root, 'esc/new-file.txt')).toBeNull();
        expect(safeResolveUnderFolderRoot(root, 'esc')).toBeNull();
        // 外部ファイルへの symlink（ファイル型）も遮断
        fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(root, 'esc-file.txt'), 'file');
        expect(safeResolveUnderFolderRoot(root, 'esc-file.txt')).toBeNull();
        // 外部実体は無傷（解決が null なので触りようがない — sanity）
        expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('precious');
        // folderRoot 自体が symlink の場合も正しく動く（realpath 基準の包含判定）
        const rootLink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flv-rl-')), 'link');
        fs.symlinkSync(root, rootLink, 'dir');
        fs.mkdirSync(path.join(root, 'inner2'), { recursive: true });
        expect(safeResolveUnderFolderRoot(rootLink, 'inner2')).toBe(path.join(rootLink, 'inner2'));
    });

    test('TC-FLV-09b: realpath 実体検査（読み取り系）— symlink 経由の folderRoot 外読み出しを遮断', () => {
        const { safeResolveUnderFolderRoot } = requireWithVscodeStub('../../src/shared/path-safety');
        const root = makeRoot();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-outside-'));
        fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
        fs.symlinkSync(outside, path.join(root, 'link-dir'), 'dir');
        fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'), 'file');
        // 読み取り想定（open / registerToTree の source 読み）の解決も同関数を通る契約 —
        // symlink 経由は null（外部内容が note に複製されない / viewer に出ない）
        expect(safeResolveUnderFolderRoot(root, 'link-dir/secret.md')).toBeNull();
        expect(safeResolveUnderFolderRoot(root, 'link.md')).toBeNull();
        // 通常ファイルは読める（対照）
        fs.writeFileSync(path.join(root, 'ok.md'), '# ok');
        expect(safeResolveUnderFolderRoot(root, 'ok.md')).toBe(path.join(root, 'ok.md'));
    });
});

// ── TASK-04: folder view fs 操作 host 端（bridge 台帳 #6-12） ──

function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => { messages.push(m); } }, messages };
}

function makeFvDeps() {
    const calls: {
        inputBox: any[]; errors: string[]; trash: any[];
        openMd: string[]; openViewer: string[]; openExternal: string[]; resourceRoot: string[];
        reveal: string[]; clipboard: string[];
    } = { inputBox: [], errors: [], trash: [], openMd: [], openViewer: [], openExternal: [], resourceRoot: [], reveal: [], clipboard: [] };
    let inputResult: string | undefined;
    const deps = {
        showInputBox: async (opts: any) => { calls.inputBox.push(opts); return inputResult; },
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        t: (_key: string) => undefined as any,
        trashDelete: async (absPath: string, recursive: boolean) => { calls.trash.push({ absPath, recursive, useTrash: true }); },
        openMdInSidePanel: (absPath: string) => { calls.openMd.push(absPath); },
        openViewerPanel: (absPath: string) => { calls.openViewer.push(absPath); },
        openExternal: (absPath: string) => { calls.openExternal.push(absPath); },
        ensureResourceRoot: (rootAbs: string) => { calls.resourceRoot.push(rootAbs); },
        renameFs: (absSrc: string, absDst: string) => { fs.renameSync(absSrc, absDst); },
        revealInOS: (absPath: string) => { calls.reveal.push(absPath); },
        clipboardWriteText: (text: string) => { calls.clipboard.push(text); },
    };
    return { deps, calls, setInput: (v?: string) => { inputResult = v; } };
}

/** folder link 済みの note + fileManager を作る共通 setup */
function setupLinked(stub?: any) {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager', stub);
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler', stub);
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-note-'));
    const root = makeRoot();
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    return { mod, m, id, root, noteDir };
}

test.describe('folder view fs 操作 host 端（TASK-04）', () => {

    test('TC-FLV-10: folderViewList — 1 階層のみ readdir・隠し/symlink 除外・フォルダ先行名前昇順', async () => {
        const { mod, m, id, root } = setupLinked();
        fs.mkdirSync(path.join(root, 'bdir'));
        fs.mkdirSync(path.join(root, 'Adir'));
        fs.mkdirSync(path.join(root, 'bdir', 'nested')); // 子階層（読まれない）
        fs.writeFileSync(path.join(root, 'bdir', 'nested', 'deep.txt'), 'x');
        fs.writeFileSync(path.join(root, 'zfile.txt'), 'x');
        fs.writeFileSync(path.join(root, 'afile.txt'), 'x');
        fs.writeFileSync(path.join(root, '.hidden'), 'x');
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-out2-'));
        fs.symlinkSync(outside, path.join(root, 'symdir'), 'dir');

        const { sender, messages } = makeSender();
        // 1 階層のみの counterfactual: 子 dir を読み取り不能（chmod 000）にしても
        // ルートの list は成功する（再帰 readdir する実装なら EACCES で失敗/欠落 = RED）
        fs.chmodSync(path.join(root, 'bdir'), 0o000);
        try {
            await mod.folderViewList(m, id, '', sender as any);
        } finally { fs.chmodSync(path.join(root, 'bdir'), 0o755); }

        const msg = messages.find((x) => x.type === 'folderViewListResult');
        expect(msg).toBeTruthy();
        expect(msg.folderLinkId).toBe(id);
        expect(msg.relPath).toBe('');
        expect(msg.error).toBeFalsy(); // 子 dir が読めなくてもルート 1 階層は成功
        const names = msg.entries.map((e: any) => e.name);
        // フォルダ先行・名前昇順（case-insensitive）。隠し・symlink は不在。読めない子 dir も列挙はされる
        expect(names).toEqual(['Adir', 'bdir', 'afile.txt', 'zfile.txt']);
        expect(msg.entries[0].isDir).toBe(true);
        expect(JSON.stringify(msg)).not.toContain(root); // 絶対パス不含（relPath ベース）
    });

    test('TC-FLV-09c: 走査（list/search）が symlink を非追従（列挙されない・検索でも辿らない）', async () => {
        const { mod, m, id, root } = setupLinked();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-out3-'));
        fs.writeFileSync(path.join(outside, 'hit-secret.txt'), 'x');
        fs.symlinkSync(outside, path.join(root, 'symdir'), 'dir');
        fs.symlinkSync(path.join(outside, 'hit-secret.txt'), path.join(root, 'hit-link.txt'), 'file');
        fs.writeFileSync(path.join(root, 'hit-real.txt'), 'x');

        const { sender, messages } = makeSender();
        await mod.folderViewList(m, id, '', sender as any);
        const listMsg = messages.find((x) => x.type === 'folderViewListResult');
        expect(listMsg.entries.map((e: any) => e.name)).toEqual(['hit-real.txt']);

        await mod.folderViewSearch(m, id, 'hit', sender as any);
        const searchMsg = messages.find((x) => x.type === 'folderViewSearchResult');
        expect(searchMsg.hits.map((h: any) => h.name)).toEqual(['hit-real.txt']);
    });

    test('TC-FLV-11: folderViewSearch — 部分一致・祖先 relPath 付き・走査/ヒット上限で truncated', async () => {
        const { mod, m, id, root } = setupLinked();
        // 大規模 fixture（spec 内生成・commit しない）: 20 dir × 550 file = 11,000 エントリ
        for (let d = 0; d < 20; d++) {
            const dir = path.join(root, `dir${String(d).padStart(2, '0')}`);
            fs.mkdirSync(dir);
            for (let f = 0; f < 550; f++) {
                fs.writeFileSync(path.join(dir, `hit-${d}-${f}.txt`), '');
            }
        }
        const { sender, messages } = makeSender();
        // ヒット上限（500）で打ち切り
        await mod.folderViewSearch(m, id, 'HIT', sender as any); // case-insensitive
        const msg1 = messages.find((x) => x.type === 'folderViewSearchResult');
        expect(msg1.truncated).toBe(true);
        expect(msg1.hits.length).toBe(500);
        expect(msg1.hits[0].relPath).toContain('/'); // 祖先 dir 付き relPath
        // 走査上限（10,000）で打ち切り（0 ヒットでも truncated）
        messages.length = 0;
        await mod.folderViewSearch(m, id, 'zzz-no-match', sender as any);
        const msg2 = messages.find((x) => x.type === 'folderViewSearchResult');
        expect(msg2.truncated).toBe(true);
        expect(msg2.hits.length).toBe(0);
    });

    test('TC-FLV-12: create / rename — 同名エラー中断・clamp 経由', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps, calls, setInput } = makeFvDeps();
        const { sender, messages } = makeSender();

        // New Markdown
        setInput('memo');
        expect(await mod.folderViewCreate(m, id, '', 'md', deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'memo.md'))).toBe(true);
        // New Folder（サブフォルダ内）
        fs.mkdirSync(path.join(root, 'sub'));
        setInput('child');
        expect(await mod.folderViewCreate(m, id, 'sub', 'folder', deps as any, sender as any)).toBe(true);
        expect(fs.statSync(path.join(root, 'sub', 'child')).isDirectory()).toBe(true);
        // 同名 → エラー・作成なし
        setInput('memo');
        expect(await mod.folderViewCreate(m, id, '', 'md', deps as any, sender as any)).toBe(false);
        expect(calls.errors.length).toBeGreaterThan(0);
        // 不正名（traversal）→ 中断
        setInput('../evil');
        expect(await mod.folderViewCreate(m, id, '', 'md', deps as any, sender as any)).toBe(false);
        expect(fs.existsSync(path.join(path.dirname(root), 'evil.md'))).toBe(false);

        // rename（FR-FLV-28 改訂: newName 引数 — showInputBox は呼ばれない。許可: test_update / TASK-16）
        expect(await mod.folderViewRename(m, id, 'memo.md', 'memo2', deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'memo2'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'memo.md'))).toBe(false);
        // rename 同名衝突 → 中断（元名維持）
        fs.writeFileSync(path.join(root, 'other.txt'), 'x');
        expect(await mod.folderViewRename(m, id, 'memo2', 'other.txt', deps as any, sender as any)).toBe(false);
        expect(fs.existsSync(path.join(root, 'memo2'))).toBe(true);
        expect(fs.readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('x');
        // キャンセル = 副作用ゼロ
        const msgCount = messages.length;
        setInput(undefined);
        expect(await mod.folderViewCreate(m, id, '', 'md', deps as any, sender as any)).toBe(false);
        expect(messages.length).toBe(msgCount);

        // #17/#18: エントリの Reveal / Copy Path（clamp 経由・webview 応答なし = INV-4）
        expect(mod.folderViewRevealEntry(m, id, 'other.txt', deps as any)).toBe(true);
        expect(calls.reveal).toEqual([path.join(root, 'other.txt')]);
        expect(mod.folderViewCopyEntryPath(m, id, 'other.txt', deps as any)).toBe(true);
        expect(calls.clipboard).toEqual([path.join(root, 'other.txt')]);
        expect(mod.folderViewRevealEntry(m, id, '../evil', deps as any)).toBe(false);
        expect(mod.folderViewCopyEntryPath(m, id, '../evil', deps as any)).toBe(false);
        expect(messages.length).toBe(msgCount); // webview に絶対パスを返さない
    });

    test('TC-FLV-13: delete = trash 契約（useTrash 引数・recursive・fs.rmSync/unlinkSync 不発）', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps, calls } = makeFvDeps();
        const { sender } = makeSender();
        fs.writeFileSync(path.join(root, 'f.txt'), 'x');
        fs.mkdirSync(path.join(root, 'd'));
        fs.writeFileSync(path.join(root, 'd', 'in.txt'), 'x');

        // 恒久削除 API 不発の番人（挙動 pin）: trashDelete recorder は実削除しない no-op なので、
        // 削除後も実体が残っていれば「削除は注入 trash 経由のみ・直接 fs 削除経路なし」が成立
        //（counterfactual: 実装が fs.rmSync/unlinkSync を直接呼ぶと実体が消え RED）
        expect(await mod.folderViewDelete(m, id, 'f.txt', deps as any, sender as any)).toBe(true);
        expect(await mod.folderViewDelete(m, id, 'd', deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'f.txt'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'd', 'in.txt'))).toBe(true);
        expect(calls.trash).toEqual([
            { absPath: path.join(root, 'f.txt'), recursive: false, useTrash: true },
            { absPath: path.join(root, 'd'), recursive: true, useTrash: true },
        ]);
        // traversal → 中断・trash 不発
        expect(await mod.folderViewDelete(m, id, '../x', deps as any, sender as any)).toBe(false);
        expect(calls.trash).toHaveLength(2);
    });

    test('TC-FLV-14: move — rename 移動・同名/自己子孫/EXDEV エラー中断（copy+delete 不発）', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps, calls } = makeFvDeps();
        const { sender } = makeSender();
        fs.mkdirSync(path.join(root, 'dst'));
        fs.mkdirSync(path.join(root, 'mv-dir'));
        fs.writeFileSync(path.join(root, 'mv.txt'), 'body');

        // 正常移動
        expect(await mod.folderViewMove(m, id, 'mv.txt', 'dst', deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'dst', 'mv.txt'), 'utf8')).toBe('body');
        expect(fs.existsSync(path.join(root, 'mv.txt'))).toBe(false);
        // 同名衝突 → 中断（両実体無傷）
        fs.writeFileSync(path.join(root, 'mv.txt'), 'v2');
        expect(await mod.folderViewMove(m, id, 'mv.txt', 'dst', deps as any, sender as any)).toBe(false);
        expect(fs.readFileSync(path.join(root, 'mv.txt'), 'utf8')).toBe('v2');
        expect(fs.readFileSync(path.join(root, 'dst', 'mv.txt'), 'utf8')).toBe('body');
        // フォルダを自己子孫へ → no-op エラー
        fs.mkdirSync(path.join(root, 'mv-dir', 'inner'));
        expect(await mod.folderViewMove(m, id, 'mv-dir', 'mv-dir/inner', deps as any, sender as any)).toBe(false);
        expect(fs.existsSync(path.join(root, 'mv-dir'))).toBe(true);
        // EXDEV → エラー中断・copy+delete を試みない（fs 状態不変 — renameFs 注入 seam で再現）
        (deps as any).renameFs = () => { const e: any = new Error('EXDEV'); e.code = 'EXDEV'; throw e; };
        expect(await mod.folderViewMove(m, id, 'mv.txt', 'mv-dir', deps as any, sender as any)).toBe(false);
        expect(fs.readFileSync(path.join(root, 'mv.txt'), 'utf8')).toBe('v2'); // 元無傷
        expect(fs.existsSync(path.join(root, 'mv-dir', 'mv.txt'))).toBe(false); // copy 複製も無し
        expect(calls.errors.length).toBeGreaterThan(0);
    });

    test('TC-FLV-20: open 分岐 — md=sidepanel / pdf,html=viewer / 他=外部起動 + resourceRoot union・broken はエラー', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps, calls } = makeFvDeps();
        fs.writeFileSync(path.join(root, 'a.md'), '# a');
        fs.writeFileSync(path.join(root, 'b.pdf'), 'pdf');
        fs.writeFileSync(path.join(root, 'c.HTML'), '<html></html>'); // case-insensitive
        // 【許可: test_update】sprint 20260823-165314（FR-FV-01 改訂）: .txt は viewer 対象化。
        // 「他 = 外部起動」の番人は .zip（引き続き対象外）で維持。
        fs.writeFileSync(path.join(root, 'd.txt'), 'x');
        fs.writeFileSync(path.join(root, 'e.zip'), 'x');

        await mod.folderViewOpen(m, id, 'a.md', deps as any);
        await mod.folderViewOpen(m, id, 'b.pdf', deps as any);
        await mod.folderViewOpen(m, id, 'c.HTML', deps as any);
        await mod.folderViewOpen(m, id, 'd.txt', deps as any);
        await mod.folderViewOpen(m, id, 'e.zip', deps as any);
        expect(calls.openMd).toEqual([path.join(root, 'a.md')]);
        expect(calls.openViewer).toEqual([path.join(root, 'b.pdf'), path.join(root, 'c.HTML'), path.join(root, 'd.txt')]);
        expect(calls.openExternal).toEqual([path.join(root, 'e.zip')]);
        // 各 open 前に folderRoot が resourceRoots へ union されている
        expect(calls.resourceRoot.length).toBeGreaterThanOrEqual(5);
        expect(calls.resourceRoot[0]).toBe(root);
        // broken link → エラー応答・open 系不発
        fs.rmSync(root, { recursive: true, force: true });
        await mod.folderViewOpen(m, id, 'a.md', deps as any);
        expect(calls.errors.length).toBeGreaterThan(0);
        expect(calls.openMd).toHaveLength(1);
    });
});

// ── TASK-05: 面間 D&D host 端（bridge 台帳 #13-16・面間移動 = 複製成功→元 trash = INV-5） ──

function makeMoveDeps() {
    const calls: { errors: string[]; trash: any[]; display: string[] } = { errors: [], trash: [], display: [] };
    const deps = {
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        t: (_key: string) => undefined as any,
        // recorder（no-op — 実削除しない。削除後も実体が残っていれば「trash 経由のみ」が成立 = INV-5 番人）
        trashDelete: async (absPath: string, recursive: boolean) => { calls.trash.push({ absPath, recursive }); },
        toDisplayUri: (absPath: string) => { calls.display.push(absPath); return 'vscode-resource://' + absPath; },
    };
    return { deps, calls };
}

test.describe('面間 D&D host 端（TASK-05）', () => {

    test('TC-FLV-15: moveToTree — md/file 登録 + 元実体 trash・登録失敗/traversal/isDir は元不変', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps, calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        fs.writeFileSync(path.join(root, 'doc.md'), '# My Title\nbody\n');
        fs.writeFileSync(path.join(root, 'photo.bin'), 'bin');
        fs.mkdirSync(path.join(root, 'adir'));

        // .md → registerMarkdownFile 経路（title = H1）
        expect(await mod.folderViewMoveToTree(m, id, 'doc.md', null, 0, deps as any, sender as any)).toBe(true);
        const items: any = Object.values(m.getStructure().items).filter((it: any) => it.ext === 'md');
        expect(items).toHaveLength(1);
        expect(items[0].title).toBe('My Title');
        // 登録成功 → 元実体が trash recorder に積まれる（実体はまだ disk 上 = 直接削除経路なし）
        expect(calls.trash.some((t: any) => t.absPath === path.join(root, 'doc.md'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'doc.md'))).toBe(true);
        // broadcast（tree 再送）
        expect(messages.some((x) => x.type === 'notesFileListChanged')).toBe(true);

        // その他拡張子 → registerTreeFile 経路（files/ 複製）
        expect(await mod.folderViewMoveToTree(m, id, 'photo.bin', null, 0, deps as any, sender as any)).toBe(true);
        const fileItems: any = Object.values(m.getStructure().items).filter((it: any) => it.ext === 'file');
        expect(fileItems).toHaveLength(1);
        expect(fs.readFileSync(path.join(noteDir, 'files', fileItems[0].filename), 'utf8')).toBe('bin');
        expect(calls.trash.some((t: any) => t.absPath === path.join(root, 'photo.bin'))).toBe(true);

        // traversal → reject（counterfactual: clamp 外しで folderRoot 外読み = RED）・trash 不発
        const trashCount = calls.trash.length;
        expect(await mod.folderViewMoveToTree(m, id, '../etc', null, 0, deps as any, sender as any)).toBe(false);
        // isDir → reject 通知
        expect(await mod.folderViewMoveToTree(m, id, 'adir', null, 0, deps as any, sender as any)).toBe(false);
        expect(calls.trash.length).toBe(trashCount);

        // 登録失敗 → 元不変（INV-5: note 側書き込み不能を強制）
        fs.writeFileSync(path.join(root, 'doc2.md'), '# T2');
        fs.chmodSync(noteDir, 0o555);
        try {
            expect(await mod.folderViewMoveToTree(m, id, 'doc2.md', null, 0, deps as any, sender as any)).toBe(false);
        } finally { fs.chmodSync(noteDir, 0o755); }
        expect(fs.existsSync(path.join(root, 'doc2.md'))).toBe(true);
        expect(calls.trash.length).toBe(trashCount);
    });

    test('TC-FLV-16: moveIn — note item を dst へ複製 + 台帳除去 + note 側実体 trash・失敗時 note 不変・.out/folder reject', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps, calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        const mdId = m.registerMarkdownFile('# Doc\nbody\n', 'Doc', null, 0);
        const fileId = m.registerTreeFile('a.txt', 'a.txt', null, 0, Buffer.from('xx'));
        const fileEntity = m.getTreeFilePath(fileId) as string;
        fs.mkdirSync(path.join(root, 'dstd'));

        // md item → dst へ複製（title ベース名）+ 台帳除去 + 実体 trash（recorder）
        expect(await mod.folderViewMoveIn(m, id, 'dstd', 'md', mdId, deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'dstd', 'Doc.md'), 'utf8')).toContain('# Doc');
        expect(m.getStructure().items[mdId]).toBeFalsy();
        expect(calls.trash.some((t: any) => t.absPath.endsWith(`${mdId}.md`))).toBe(true);
        expect(messages.some((x) => x.type === 'notesFileListChanged')).toBe(true);

        // file item → 複製 + 台帳除去 + trash
        expect(await mod.folderViewMoveIn(m, id, 'dstd', 'file', fileId, deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'dstd', 'a.txt'), 'utf8')).toBe('xx');
        expect(m.getStructure().items[fileId]).toBeFalsy();
        expect(calls.trash.some((t: any) => t.absPath === fileEntity)).toBe(true);
        expect(fs.existsSync(fileEntity)).toBe(true); // recorder no-op = 直接削除経路なし

        // 同名 uniquify
        const mdId2 = m.registerMarkdownFile('# Doc2\n', 'Doc', null, 0);
        fs.writeFileSync(path.join(root, 'dstd', 'Doc.md'), 'occupied');
        expect(await mod.folderViewMoveIn(m, id, 'dstd', 'md', mdId2, deps as any, sender as any)).toBe(true);
        const dstNames = fs.readdirSync(path.join(root, 'dstd'));
        expect(dstNames.filter((n) => n.startsWith('Doc') && n.endsWith('.md')).length).toBe(2);

        // 複製失敗 → note 側台帳・実体とも不変（INV-5）
        const mdId3 = m.registerMarkdownFile('# Keep\n', 'Keep', null, 0);
        const trashCount = calls.trash.length;
        fs.chmodSync(path.join(root, 'dstd'), 0o555);
        try {
            expect(await mod.folderViewMoveIn(m, id, 'dstd', 'md', mdId3, deps as any, sender as any)).toBe(false);
        } finally { fs.chmodSync(path.join(root, 'dstd'), 0o755); }
        expect(m.getStructure().items[mdId3]).toBeTruthy();
        expect(fs.existsSync(m.getMdFilePath(mdId3))).toBe(true);
        expect(calls.trash.length).toBe(trashCount);

        // .out / folder item → reject 通知
        const errCount = calls.errors.length;
        expect(await mod.folderViewMoveIn(m, id, 'dstd', 'out', 'whatever', deps as any, sender as any)).toBe(false);
        expect(await mod.folderViewMoveIn(m, id, 'dstd', 'folder', id, deps as any, sender as any)).toBe(false);
        expect(calls.errors.length).toBeGreaterThan(errCount);
    });

    test('TC-FLV-17: moveIntoMd — 種別 3 分岐・保存先解決（note md / linked md）・uniquify 実名リンク・失敗時不変・self no-op', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps, calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        // note md target
        const noteMdId = m.registerMarkdownFile('# Target\n', 'Target', null, 0);
        const noteMd = m.getMdFilePath(noteMdId);
        // linked-folder md target
        fs.writeFileSync(path.join(root, 'linked.md'), '# Linked\n');
        const linkedMd = path.join(root, 'linked.md');
        // sources（folder view 内）
        fs.writeFileSync(path.join(root, 'n.md'), '# NoteDoc\n');
        fs.writeFileSync(path.join(root, 'p.png'), 'png');
        fs.writeFileSync(path.join(root, 'f.txt'), 'txt');
        fs.writeFileSync(path.join(root, 'p2.png'), 'png2');
        fs.writeFileSync(path.join(root, 'n2.md'), '# SameDir\n');

        // (a) md → note md: 対象 md dir へ移動 + insertSubpageLink（title = H1 正典）
        expect(await mod.folderViewMoveIntoMd(m, id, 'n.md', noteMd, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(noteMd), 'n.md'))).toBe(true);
        let msg = messages.find((x) => x.type === 'insertSubpageLink');
        expect(msg).toBeTruthy();
        expect(msg.title).toBe('NoteDoc');
        expect(msg.markdownPath).toBe('n.md');
        expect(msg.sidePanelFilePath).toBe(noteMd);
        expect(calls.trash.some((t: any) => t.absPath === path.join(root, 'n.md'))).toBe(true);

        // (b) md → linked md（同一 dir）: 移動なし・リンクのみ・trash 不発
        const trashCount = calls.trash.length;
        expect(await mod.folderViewMoveIntoMd(m, id, 'n2.md', linkedMd, deps as any, sender as any)).toBe(true);
        expect(calls.trash.length).toBe(trashCount); // 移動なし
        msg = messages.filter((x) => x.type === 'insertSubpageLink').pop();
        expect(msg.markdownPath).toBe('n2.md');
        expect(msg.sidePanelFilePath).toBe(linkedMd);

        // (c) 画像 → 保存先 images/（note md = note 共有 / linked md = md の隣）
        expect(await mod.folderViewMoveIntoMd(m, id, 'p.png', noteMd, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(noteMd), 'images', 'p.png'))).toBe(true);
        let imsg = messages.filter((x) => x.type === 'insertImageHtml').pop();
        expect(imsg.markdownPath).toBe('images/p.png');
        expect(imsg.sidePanelFilePath).toBe(noteMd);
        expect(await mod.folderViewMoveIntoMd(m, id, 'p2.png', linkedMd, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'images', 'p2.png'))).toBe(true); // md の隣（FR-SD-03 合流）

        // (d) その他 → files/ + insertFileLink
        expect(await mod.folderViewMoveIntoMd(m, id, 'f.txt', noteMd, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(noteMd), 'files', 'f.txt'))).toBe(true);
        const fmsg = messages.filter((x) => x.type === 'insertFileLink').pop();
        expect(fmsg.markdownPath).toBe('files/f.txt');

        // (e) 同名 uniquify + 実名リンク
        fs.writeFileSync(path.join(root, 'f.txt'), 'txt-2'); // 同名 source を再作成
        expect(await mod.folderViewMoveIntoMd(m, id, 'f.txt', noteMd, deps as any, sender as any)).toBe(true);
        const fmsg2 = messages.filter((x) => x.type === 'insertFileLink').pop();
        expect(fmsg2.markdownPath).not.toBe('files/f.txt'); // uniquify 済み実名
        expect(fs.existsSync(path.join(path.dirname(noteMd), fmsg2.markdownPath))).toBe(true);

        // (f) 移動（複製）失敗 → リンク挿入指示なし・元実体不変（INV-3/INV-5）
        fs.writeFileSync(path.join(root, 'g.txt'), 'g');
        const msgCount = messages.length;
        const trashCount2 = calls.trash.length;
        fs.chmodSync(path.join(path.dirname(noteMd), 'files'), 0o555);
        try {
            expect(await mod.folderViewMoveIntoMd(m, id, 'g.txt', noteMd, deps as any, sender as any)).toBe(false);
        } finally { fs.chmodSync(path.join(path.dirname(noteMd), 'files'), 0o755); }
        expect(messages.length).toBe(msgCount);
        expect(calls.trash.length).toBe(trashCount2);
        expect(fs.readFileSync(path.join(root, 'g.txt'), 'utf8')).toBe('g');

        // (g) 自分自身への drop → no-op
        expect(await mod.folderViewMoveIntoMd(m, id, 'linked.md', linkedMd, deps as any, sender as any)).toBe(false);
    });

    test('TC-FLV-47: moveFromMd — 📎/subpage の実体移動 + fs 正典リンク除去 + 元 trash・失敗時不変・self no-op・traversal reject', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps, calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        fs.mkdirSync(path.join(root, 'dst'));

        // note md source（📎 + subpage リンクを本文に持つ）
        const filesDir = path.join(noteDir, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'a.txt'), 'attach');
        fs.writeFileSync(path.join(noteDir, 'subpage-1.md'), '# Sub\n');
        const srcMdId = m.registerMarkdownFile(
            'body [📎 a.txt](files/a.txt) and [[Sub]](subpage-1.md) end\n', 'Src', null, 0);
        const srcMd = m.getMdFilePath(srcMdId);

        // (a) 📎 file リンク → dst へ複製 + fs 正典でリンク除去 + 元実体 trash + エコー
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'files/a.txt', sourceMdPath: srcMd, isSubpage: false }, deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'dst', 'a.txt'), 'utf8')).toBe('attach');
        expect(fs.readFileSync(srcMd, 'utf8')).not.toContain('files/a.txt'); // fs 正典（エコーだけで済ませない）
        expect(messages.some((x) => x.type === 'removeFileLink' && x.href === 'files/a.txt')).toBe(true);
        expect(calls.trash.some((t: any) => t.absPath === path.join(filesDir, 'a.txt'))).toBe(true);
        expect(fs.existsSync(path.join(filesDir, 'a.txt'))).toBe(true); // recorder no-op = 直接削除なし

        // (b) subpage リンク → md 実体を dst へ + リンク除去 + trash + removeSubpageLink エコー
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'subpage-1.md', sourceMdPath: srcMd, isSubpage: true }, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'dst', 'subpage-1.md'))).toBe(true);
        expect(fs.readFileSync(srcMd, 'utf8')).not.toContain('subpage-1.md');
        expect(messages.some((x) => x.type === 'removeSubpageLink' && x.href === 'subpage-1.md')).toBe(true);
        expect(calls.trash.some((t: any) => t.absPath === path.join(noteDir, 'subpage-1.md'))).toBe(true);

        // (c) linked-folder md がソースでも同経路（md 隣接 files/ の実体）
        fs.mkdirSync(path.join(root, 'files'));
        fs.writeFileSync(path.join(root, 'files', 'x.bin'), 'xbin');
        fs.writeFileSync(path.join(root, 'srcdoc.md'), 'see [📎 x.bin](files/x.bin)\n');
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'files/x.bin', sourceMdPath: path.join(root, 'srcdoc.md'), isSubpage: false }, deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'dst', 'x.bin'), 'utf8')).toBe('xbin');
        expect(fs.readFileSync(path.join(root, 'srcdoc.md'), 'utf8')).not.toContain('x.bin');

        // (d) 複製失敗 → md 本文・元実体とも不変（INV-3/INV-5）
        fs.writeFileSync(path.join(filesDir, 'keep.txt'), 'keep');
        const srcMdId2 = m.registerMarkdownFile('k [📎 keep.txt](files/keep.txt)\n', 'K', null, 0);
        const srcMd2 = m.getMdFilePath(srcMdId2);
        const msgCount = messages.length;
        fs.chmodSync(path.join(root, 'dst'), 0o555);
        try {
            expect(await mod.folderViewMoveFromMd(m, id, 'dst',
                { href: 'files/keep.txt', sourceMdPath: srcMd2, isSubpage: false }, deps as any, sender as any)).toBe(false);
        } finally { fs.chmodSync(path.join(root, 'dst'), 0o755); }
        expect(fs.readFileSync(srcMd2, 'utf8')).toContain('files/keep.txt'); // 本文不変
        expect(fs.existsSync(path.join(filesDir, 'keep.txt'))).toBe(true);
        expect(messages.length).toBe(msgCount);

        // (e) 自分自身（実体の現在地 = dst）への drop → no-op
        fs.writeFileSync(path.join(root, 'files', 'self.bin'), 's');
        fs.writeFileSync(path.join(root, 'selfsrc.md'), '[📎 self.bin](files/self.bin)\n');
        expect(await mod.folderViewMoveFromMd(m, id, 'files',
            { href: 'files/self.bin', sourceMdPath: path.join(root, 'selfsrc.md'), isSubpage: false }, deps as any, sender as any)).toBe(false);
        expect(fs.readFileSync(path.join(root, 'selfsrc.md'), 'utf8')).toContain('self.bin'); // リンク維持

        // (f) dst traversal → reject
        expect(await mod.folderViewMoveFromMd(m, id, '../evil',
            { href: 'files/a.txt', sourceMdPath: srcMd, isSubpage: false }, deps as any, sender as any)).toBe(false);
    });
});

// ── TC-FLV-51（TASK-12 / reviewer iter1 SEC-1）: moveFromMd の source containment ──

test.describe('TC-FLV-51 — moveFromMd source containment（NFR-FLV-01）', () => {

    test('files/ 外の兄弟 reject（📎）・非 .md subpage reject・正常系は通る（counterfactual: base を dirname(md) に戻すと reject 側が通過し RED）', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps } = makeMoveDeps();
        const { sender, messages } = makeSender();
        fs.mkdirSync(path.join(root, 'dst'));

        const filesDir = path.join(noteDir, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'att.txt'), 'legit');
        fs.writeFileSync(path.join(noteDir, 'secret.txt'), 'SECRET');   // files/ 外の兄弟（非登録）
        fs.writeFileSync(path.join(noteDir, 'sub.md'), '# Sub\n');      // 兄弟 subpage md（正当）
        const srcMdId = m.registerMarkdownFile('body\n', 'Src', null, 0);
        const srcMd = m.getMdFilePath(srcMdId);

        // (a) 📎 filelink の href が files/ 外の兄弟 → reject（偽装 [📎 x](secret.txt) の exfiltrate+trash 封鎖）
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'secret.txt', sourceMdPath: srcMd, isSubpage: false }, deps as any, sender as any)).toBe(false);
        expect(fs.readFileSync(path.join(noteDir, 'secret.txt'), 'utf8'), '実体無傷').toBe('SECRET');
        expect(fs.existsSync(path.join(root, 'dst', 'secret.txt')), 'dst へ流出しない').toBe(false);
        expect(messages.some((x) => x.type === 'removeFileLink'), 'リンク除去エコーも飛ばない').toBe(false);

        // (d) subpage の href が非 .md → reject（[[x]](secret.txt) 偽装の封鎖）
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'secret.txt', sourceMdPath: srcMd, isSubpage: true }, deps as any, sender as any)).toBe(false);
        expect(fs.readFileSync(path.join(noteDir, 'secret.txt'), 'utf8')).toBe('SECRET');
        expect(fs.existsSync(path.join(root, 'dst', 'secret.txt'))).toBe(false);

        // (b) 正常系 📎: files/ 内の添付 → 移動成功（regression — TC-FLV-47 (a) と同義）
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'files/att.txt', sourceMdPath: srcMd, isSubpage: false }, deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'dst', 'att.txt'), 'utf8')).toBe('legit');

        // (c) 正常系 subpage: note 内の兄弟 .md → 移動成功
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'sub.md', sourceMdPath: srcMd, isSubpage: true }, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'dst', 'sub.md'))).toBe(true);

        // (e) note 外への traversal → reject（両種別）
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-sec-'));
        fs.writeFileSync(path.join(outside, 'ext.md'), '# ext\n');
        const relOut = path.relative(noteDir, path.join(outside, 'ext.md')).split(path.sep).join('/');
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: relOut, sourceMdPath: srcMd, isSubpage: true }, deps as any, sender as any)).toBe(false);
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: relOut, sourceMdPath: srcMd, isSubpage: false }, deps as any, sender as any)).toBe(false);
        expect(fs.existsSync(path.join(outside, 'ext.md'))).toBe(true);
    });
});

// ── 再オープン①（TASK-16）: 状態永続化 / H1 / rename シグネチャ ──

test.describe('TC-FLV-52 — 状態永続化 host 端（FR-FLV-26 / #6・#19）', () => {

    test('savedExpanded 同梱・実在フィルタ + prune・sidecar 4 性質・状態ファイル非表示', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps } = makeFvDeps();
        const { sender, messages } = makeSender();
        fs.mkdirSync(path.join(root, 'alive'));
        fs.mkdirSync(path.join(root, 'alive', 'deep'));

        // ① stateSave: 保存（相対のみ）+ 絶対/.. 開始は reject
        expect(await mod.folderViewStateSave(m, id, ['alive', 'alive/deep', '/etc', '../up'], deps as any, sender as any)).toBe(true);
        const stateFile = path.join(root, '.fractal-folderview.json');
        const saved1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(saved1.expanded.sort()).toEqual(['alive', 'alive/deep']);

        // ② 他キー保持 upsert（sidecar 4 性質）
        const withExtra = { ...saved1, custom: 'keep' };
        fs.writeFileSync(stateFile, JSON.stringify(withExtra));
        expect(await mod.folderViewStateSave(m, id, ['alive'], deps as any, sender as any)).toBe(true);
        const saved2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(saved2.custom, '他キー保持').toBe('keep');
        expect(saved2.expanded).toEqual(['alive']);

        // ③ list('') が savedExpanded を同梱 + 消滅 relPath は同梱から除外し prune 保存
        fs.writeFileSync(stateFile, JSON.stringify({ version: 1, expanded: ['alive', 'gone', 'alive/deep'] }));
        expect(await mod.folderViewList(m, id, '', sender as any)).toBe(true);
        const listMsg = messages.filter((x) => x.type === 'folderViewListResult').pop();
        expect(listMsg.savedExpanded.sort(), '実在 dir のみ同梱').toEqual(['alive', 'alive/deep']);
        const pruned = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(pruned.expanded.includes('gone'), '消滅分は prune 保存').toBe(false);
        // ⑤ 状態ファイル自身は entries に現れない（. 開始除外）
        expect(listMsg.entries.some((e: any) => e.name === '.fractal-folderview.json')).toBe(false);

        // ④ 空で削除（sidecar 4 性質）
        expect(await mod.folderViewStateSave(m, id, [], deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(stateFile), 'expanded 空 → ファイル削除').toBe(false);

        // ⑥ 書込不能でも throw しない（silent skip — counterfactual: 4 性質を外すと RED）
        fs.chmodSync(root, 0o555);
        try {
            expect(await mod.folderViewStateSave(m, id, ['alive'], deps as any, sender as any)).toBe(true);
        } finally { fs.chmodSync(root, 0o755); }

        // ⑦ 壊れた JSON は best-effort read（無視して savedExpanded 空・throw しない）
        fs.writeFileSync(stateFile, '{broken json');
        expect(await mod.folderViewList(m, id, '', sender as any)).toBe(true);
        const listMsg2 = messages.filter((x) => x.type === 'folderViewListResult').pop();
        expect(listMsg2.error).toBeFalsy();
    });
});

test.describe('TC-FLV-58 — New Markdown の H1 初期内容（FR-FLV-15 改訂）', () => {

    test('入力名を H1 に書く（.md 付き入力でも stem）— 空ファイル生成に戻すと RED', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps, setInput } = makeFvDeps();
        const { sender } = makeSender();
        setInput('メモ');
        expect(await mod.folderViewCreate(m, id, '', 'md', deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'メモ.md'), 'utf8')).toBe('# メモ\n');
        setInput('note.md');
        expect(await mod.folderViewCreate(m, id, '', 'md', deps as any, sender as any)).toBe(true);
        expect(fs.readFileSync(path.join(root, 'note.md'), 'utf8'), '.md 付き入力でも H1 は stem').toBe('# note\n');
    });
});

test.describe('TC-FLV-55 — rename newName 引数（host 面 / FR-FLV-28）', () => {

    test('folderViewRename は newName を直接使い showInputBox を呼ばない', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps, calls } = makeFvDeps();
        const { sender } = makeSender();
        fs.writeFileSync(path.join(root, 'a.txt'), 'x');
        expect(await mod.folderViewRename(m, id, 'a.txt', 'b.txt', deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(true);
        expect(calls.inputBox.length, 'showInputBox 不呼出し（インライン rename が名前を確定済み）').toBe(0);
        // 空 / 不変 = no-op
        expect(await mod.folderViewRename(m, id, 'b.txt', '  ', deps as any, sender as any)).toBe(false);
        expect(await mod.folderViewRename(m, id, 'b.txt', 'b.txt', deps as any, sender as any)).toBe(false);
        expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(true);
    });
});

// ── 再オープン①（TASK-17）: W2 trash 可視化 / W4 precedent 合流 / W6 通知 ──

test.describe('TC-FLV-60 — trash 失敗の可視化（W2 / D&D 統一原則改訂）', () => {

    test('trash throw → folderViewTrashFailed 通知・元残存・複製とリフレッシュは反映（counterfactual: silent catch では通知 0 で RED）', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        fs.writeFileSync(path.join(root, 'x.txt'), 'data');
        // trash が throw する deps（クラウドドライブ / 権限エラーの再現）
        const throwingDeps = {
            showErrorMessage: (msg: string) => { calls.errors.push(msg); },
            t: (key: string) => (key === 'folderViewTrashFailed' ? 'TRASH_FAILED: ' : undefined) as any,
            trashDelete: async () => { throw new Error('EPERM cloud'); },
        };
        expect(await mod.folderViewMoveToTree(m, id, 'x.txt', null, 0, throwingDeps as any, sender as any)).toBe(true);
        // ① 通知（folderViewTrashFailed キー経由の文言）
        expect(calls.errors.length, 'trash 失敗が通知される').toBeGreaterThan(0);
        expect(calls.errors.some((e: string) => e.startsWith('TRASH_FAILED')), '専用キーで通知').toBe(true);
        // ② 元は残る（完全削除フォールバックが無い）
        expect(fs.readFileSync(path.join(root, 'x.txt'), 'utf8')).toBe('data');
        // ③ 複製先（note 登録）は存在し、tree/list リフレッシュは送られる
        expect(messages.some((x) => x.type === 'notesFileListChanged' || x.type === 'fileListWithStructure' || x.type === 'notesFileList')).toBeTruthy();
        expect(messages.some((x) => x.type === 'folderViewListResult')).toBe(true);
    });
});

test.describe('TC-FLV-59 — W4: note md 宛て md 移動の precedent 合流と往復（FR-FLV-22 改訂）', () => {

    test('saveDroppedMdAsSubpage 合流・挿入→解決の往復・orphan 非該当・linked md 宛ては従来', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps, calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        // note md（登録済み）を対象に
        const targetId = m.registerMarkdownFile('# Target\n', 'Target', null, 0);
        const targetMd = m.getMdFilePath(targetId);
        // folder view 側の移動対象 md
        fs.writeFileSync(path.join(root, 'moved.md'), '# Moved Doc\nbody\n');

        expect(await mod.folderViewMoveIntoMd(m, id, 'moved.md', targetMd, deps as any, sender as any)).toBe(true);
        const ins = messages.find((x) => x.type === 'insertSubpageLink');
        expect(ins, 'subpage リンク挿入 message').toBeTruthy();
        // ① precedent 合流: 対象 md の隣に uniquify 配置・title は resolveSubpageTitle（H1）
        const placedAbs = path.join(path.dirname(targetMd), ins.markdownPath);
        expect(fs.existsSync(placedAbs), '対象 md の隣に実配置').toBe(true);
        expect(ins.title).toBe('Moved Doc');
        // ② 挿入 → 解決の往復（handleOpenLink 同型 = dirname(sidepanel md) 基準 join）
        const resolved = path.resolve(path.dirname(targetMd), ins.markdownPath);
        expect(fs.existsSync(resolved), '挿入された markdownPath が click 解決で実ファイルに到達').toBe(true);
        expect(fs.readFileSync(resolved, 'utf8')).toContain('# Moved Doc');
        // ⑤ 移動元は trash（recorder）
        expect(calls.trash.some((t: any) => t.absPath === path.join(root, 'moved.md'))).toBe(true);
        // ③ Clean Notes の orphan-md 候補に現れない（subpage リンク closure による live 化）
        // 対象 md に実際にリンク行を書いてから scan（実運用では webview 挿入 → 保存で本文に入る）
        fs.writeFileSync(targetMd, `# Target\n\n[[${ins.title}]](${ins.markdownPath})\n`);
        const cleanup = requireWithVscodeStub('../../src/shared/cleanup-core');
        const candidates = await cleanup.scanSingleNoteCore(noteDir);
        expect(
            candidates.some((c: any) => path.resolve(c.absPath) === path.resolve(placedAbs)),
            '移動された md が orphan-md 候補にならない（liveness = subpage リンク closure）'
        ).toBe(false);

        // ④ linked-folder md 宛ては従来（同 dir なら移動なし・相対リンク）
        fs.writeFileSync(path.join(root, 'lmd.md'), '# L\n');
        fs.writeFileSync(path.join(root, 'sib.md'), '# Sib\n');
        const msgCount = messages.length;
        expect(await mod.folderViewMoveIntoMd(m, id, 'sib.md', path.join(root, 'lmd.md'), deps as any, sender as any)).toBe(true);
        const ins2 = messages.slice(msgCount).find((x) => x.type === 'insertSubpageLink');
        expect(ins2.markdownPath).toBe('sib.md'); // 同 dir = 移動なし・相対のまま
        expect(fs.existsSync(path.join(root, 'sib.md'))).toBe(true);
    });
});

test.describe('TC-FLV-62 — W6 silent 棄却の廃止（FR-FLV-24 改訂）', () => {

    test('実体不在 / containment 棄却 / 拡張子棄却 → 通知。self drop のみ silent（counterfactual: silent return に戻すと RED）', async () => {
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        fs.mkdirSync(path.join(root, 'dst'));
        const filesDir = path.join(noteDir, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(noteDir, 'secret.txt'), 'S');
        fs.writeFileSync(path.join(filesDir, 'att.txt'), 'a');
        const srcMdId = m.registerMarkdownFile('body\n', 'Src', null, 0);
        const srcMd = m.getMdFilePath(srcMdId);

        // ① 実体不在（files/ 内の存在しない href）
        let n = calls.errors.length;
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'files/nothing.txt', sourceMdPath: srcMd, isSubpage: false }, deps as any, sender as any)).toBe(false);
        expect(calls.errors.length, '実体不在 → 通知').toBeGreaterThan(n);

        // ② containment 棄却（files/ 外の兄弟）
        n = calls.errors.length;
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'secret.txt', sourceMdPath: srcMd, isSubpage: false }, deps as any, sender as any)).toBe(false);
        expect(calls.errors.length, 'containment 棄却 → 通知').toBeGreaterThan(n);

        // ③ 拡張子棄却（subpage の非 .md）
        n = calls.errors.length;
        expect(await mod.folderViewMoveFromMd(m, id, 'dst',
            { href: 'secret.txt', sourceMdPath: srcMd, isSubpage: true }, deps as any, sender as any)).toBe(false);
        expect(calls.errors.length, '拡張子棄却 → 通知').toBeGreaterThan(n);

        // self drop（実体の現在地への drop）のみ silent no-op（regression）
        fs.mkdirSync(path.join(root, 'files'));
        fs.writeFileSync(path.join(root, 'files', 'x.bin'), 'x');
        fs.writeFileSync(path.join(root, 'srcdoc.md'), 'see [📎 x.bin](files/x.bin)\n');
        n = calls.errors.length;
        expect(await mod.folderViewMoveFromMd(m, id, 'files',
            { href: 'files/x.bin', sourceMdPath: path.join(root, 'srcdoc.md'), isSubpage: false }, deps as any, sender as any)).toBe(false);
        expect(calls.errors.length, 'self drop は通知なし').toBe(n);
    });
});

// ── 再オープン①（TASK-18）: sidepanel md の linkedFolderTitle 判定（host — FR-FLV-29） ──

test.describe('TC-FLV-61 — linkedFolderTitle 同梱（host 面）', () => {

    function makeSidePanelStub() {
        const stub = {
            workspace: {
                getConfiguration: () => ({ get: (_k: string, d: any) => d }),
                fs: { readFile: async (uri: any) => Buffer.from(fs.readFileSync(uri.fsPath)) },
                openTextDocument: async (_uri: any) => ({ getText: () => '', uri: _uri }),
                createFileSystemWatcher: () => ({ onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), dispose() {} }),
            },
            Uri: {
                file: (p: string) => ({
                    fsPath: p, path: p, scheme: 'file',
                    with: (o: any) => ({ fsPath: o.path ?? p, path: o.path ?? p, toString: () => 'vscode-resource://' + (o.path ?? p) }),
                    toString: () => 'file://' + p,
                }),
                joinPath: (base: any, ...parts: string[]) => {
                    const fsPath = path.join((base && base.fsPath) || '', ...parts);
                    return { fsPath, path: fsPath, toString: () => 'file://' + fsPath };
                },
                parse: (s2: string) => ({ fsPath: s2, toString: () => s2 }),
            },
            RelativePattern: class { constructor(..._a: any[]) {} },
            window: { showErrorMessage: (_m: string) => {} },
            env: { openExternal: async () => {} },
            commands: { executeCommand: () => {} },
            EventEmitter: class {},
        };
        return stub;
    }

    test('folderRoot 配下 md → linkedFolderTitle 同梱（絶対パス不含）/ note md → 同梱なし', async () => {
        const stub = makeSidePanelStub();
        const { SidePanelManager } = requireWithVscodeStub('../../src/shared/sidePanelManager', stub);
        const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flv-sp-'));
        const root = makeRoot();
        fs.writeFileSync(path.join(root, 'doc.md'), '# In Linked\n');
        fs.writeFileSync(path.join(noteDir, 'note.md'), '# Note md\n');

        const messages: any[] = [];
        const host = {
            postMessage: (m: any) => { messages.push(m); return Promise.resolve(true); },
            asWebviewUri: (u: any) => u,
        };
        // provider 配線相当: filePath が folderRoot（realpath）配下なら folder link title を返す
        const resolveLinkedFolderTitle = (fp: string) => {
            const rel = path.relative(fs.realpathSync(root), fs.realpathSync(fp));
            return (!rel.startsWith('..') && !path.isAbsolute(rel)) ? '資料' : undefined;
        };
        const sp = new SidePanelManager(host, { logPrefix: '[T]', resolveLinkedFolderTitle });

        await sp.openFile(path.join(root, 'doc.md'));
        const open1 = messages.find((m) => m.type === 'openSidePanel');
        expect(open1, 'openSidePanel message').toBeTruthy();
        expect(open1.linkedFolderTitle, 'リンクフォルダ内 md → title 同梱').toBe('資料');
        expect(JSON.stringify({ ...open1, markdown: '', documentBaseUri: '', filePath: '' })).not.toContain(root);

        messages.length = 0;
        await sp.openFile(path.join(noteDir, 'note.md'));
        const open2 = messages.find((m) => m.type === 'openSidePanel');
        expect(open2.linkedFolderTitle, 'note md → 同梱なし').toBeUndefined();
        try { sp.dispose?.(); } catch { /* ignore */ }
    });
});

// ── reviewer iter3（TASK-24）: QUAL-1 失敗パス + SEC-1 rename traversal ──

test.describe('TASK-24 — fs 失敗ガードと rename traversal 番人', () => {

    test('QUAL-1: note-md 宛て .md 移動の書込失敗 → 通知 + false + 挿入不送出 + 元実体無傷（counterfactual: 無 guard だと reject で RED）', async ({}, testInfo) => {
        testInfo.skip(process.getuid?.() === 0, 'root では chmod が効かない');
        const { mod, m, id, root, noteDir } = setupLinked();
        const { deps, calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        const targetId = m.registerMarkdownFile('# T\n', 'T', null, 0);
        const targetMd = m.getMdFilePath(targetId);
        fs.writeFileSync(path.join(root, 'src.md'), '# S\n');
        fs.chmodSync(path.dirname(targetMd), 0o555); // 書込不可（EACCES 再現）
        let result: any;
        try {
            result = await mod.folderViewMoveIntoMd(m, id, 'src.md', targetMd, deps as any, sender as any);
        } finally { fs.chmodSync(path.dirname(targetMd), 0o755); }
        expect(result, 'reject せず false を返す').toBe(false);
        expect(calls.errors.length, '失敗が通知される').toBeGreaterThan(0);
        expect(messages.some((x) => x.type === 'insertSubpageLink'), 'リンク挿入は送られない（INV-3）').toBe(false);
        expect(fs.existsSync(path.join(root, 'src.md')), '元実体は無傷（INV-5）').toBe(true);
        expect(calls.trash.length, '元の trash も呼ばれない').toBe(0);
    });

    test('SEC-1: folderViewRename の newName traversal → reject・実体無傷（counterfactual: clamp を外すと folderRoot 外に書けて RED）', async () => {
        const { mod, m, id, root } = setupLinked();
        const { deps, calls } = makeFvDeps();
        const { sender } = makeSender();
        fs.writeFileSync(path.join(root, 'safe.txt'), 'x');
        for (const evil of ['../evil.txt', 'a/../../evil.txt', '/tmp/abs-evil.txt']) {
            expect(await mod.folderViewRename(m, id, 'safe.txt', evil, deps as any, sender as any), evil).toBe(false);
        }
        expect(calls.errors.length, 'invalid 名の通知').toBeGreaterThan(0);
        expect(fs.existsSync(path.join(root, 'safe.txt')), '元実体無傷').toBe(true);
        expect(fs.existsSync(path.join(path.dirname(root), 'evil.txt')), 'folderRoot 外に書かれない').toBe(false);
    });
});
