/**
 * TC-RMT-01..03 — Explorer uri-list D&D の vscode-remote scheme 受理（sprint 20260820-034017 FR-RMT-01）
 *
 * vscode server / Remote では Explorer drag の URI が `vscode-remote://authority/path` になる。
 * URI→fs パス変換は host 正典 `droppedUriToFsPath`（drop-import.ts）に集約:
 *   file: → url.fileURLToPath / vscode-remote: → path 成分 decode（+Windows ドライブ先頭スラッシュ剥がし）/ 他 → null。
 * 前提: extension host と Explorer 対象は同一マシン（vscode server / Remote-SSH の標準構成）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

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
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

/** サーバローカル fs パス → vscode-remote URI（vscode server の Explorer drag が載せる形） */
function toRemoteUri(fsPath: string, authority = 'ssh-remote%2Btesthost'): string {
    return 'vscode-remote://' + authority + fsPath.split(path.sep).map(encodeURIComponent).join('/');
}

test('TC-RMT-01 droppedUriToFsPath: file:/vscode-remote: を fs パス化・他/不正は null', () => {
    const di = requireWithVscodeStub('../../src/shared/drop-import');
    expect(typeof di.droppedUriToFsPath, 'droppedUriToFsPath の export 不在').toBe('function');
    // file: = fileURLToPath 同値（従来経路 byte 不変）
    expect(di.droppedUriToFsPath('file:///tmp/a.md')).toBe(path.sep === '/' ? '/tmp/a.md' : '\\tmp\\a.md');
    // vscode-remote: = path 成分 decode（authority は無視）
    expect(di.droppedUriToFsPath('vscode-remote://ssh-remote%2Bhost/tmp/b.md')).toBe('/tmp/b.md');
    // percent-encoded パス（スペース・日本語）
    expect(di.droppedUriToFsPath('vscode-remote://ssh-remote%2Bhost/tmp/my%20doc%20%E3%83%A1%E3%83%A2.md')).toBe('/tmp/my doc メモ.md');
    // Windows リモート変種: ドライブレターの先頭スラッシュ剥がし
    expect(di.droppedUriToFsPath('vscode-remote://wsl%2Bubuntu/C:/x/y.md')).toBe('C:/x/y.md');
    // query/fragment は path 成分に含めない（URL.pathname 意味論 — QUAL-2 両側 pin の host 側）
    expect(di.droppedUriToFsPath('vscode-remote://ssh-remote%2Bhost/tmp/c.md?query=1#frag')).toBe('/tmp/c.md');
    // encoded path separator（%2F/%5C）は拒否 — file: の Node 組込みガード（fileURLToPath throw）と対称（SEC-1）
    expect(di.droppedUriToFsPath('vscode-remote://ssh-remote%2Bhost/home/user/..%2F..%2Fetc%2Fpasswd')).toBeNull();
    expect(di.droppedUriToFsPath('vscode-remote://ssh-remote%2Bhost/home/a%5Cb.md')).toBeNull();
    // 他 scheme / 不正 URI は null
    expect(di.droppedUriToFsPath('http://example.com/a.md')).toBeNull();
    expect(di.droppedUriToFsPath('vscode-vfs://github/repo/a.md')).toBeNull();
    expect(di.droppedUriToFsPath('not a uri')).toBeNull();
});

test('TC-RMT-02 tree host: vscode-remote URI で md/file が copy-in 登録・他 scheme は従来どおり silent skip', () => {
    const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const note = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-note-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-ext-'));
    fs.writeFileSync(path.join(ext, 'doc.md'), '# Remote Doc\nbody\n', 'utf8');
    fs.writeFileSync(path.join(ext, 'sheet.pdf'), 'PDFBIN', 'utf8');
    const fm = new NotesFileManager(note);
    fm.getStructure();
    const posted: any[] = [];

    mh.registerExternalDroppedUris(
        fm,
        [
            toRemoteUri(path.join(ext, 'doc.md')),
            'http://example.com/x.md', // 他 scheme → 従来どおり silent skip（index 非消費）
            toRemoteUri(path.join(ext, 'sheet.pdf')),
        ],
        null, 0,
        { postMessage: (m: any) => posted.push(m) } as any
    );

    const items: any[] = Object.values(fm.getStructure().items);
    const md = items.find((it: any) => it.ext === 'md');
    const file = items.find((it: any) => it.ext === 'file');
    expect(md, 'vscode-remote の .md が登録されない').toBeTruthy();
    expect(md.title).toBe('Remote Doc');
    expect(file, 'vscode-remote の file が登録されない').toBeTruthy();
    expect(file.filename).toBe('sheet.pdf');
    // copy-in（元ファイル不変）
    expect(fs.readFileSync(path.join(ext, 'doc.md'), 'utf8')).toContain('# Remote Doc');
    // http は登録されていない（2 件のみ）
    expect(items.filter((it: any) => it.type === 'file').length).toBe(2);
});

test('TC-RMT-03 outliner host: vscode-remote URI が ok:true で分類・他 scheme は従来の明示エラー文言', async () => {
    const di = requireWithVscodeStub('../../src/shared/drop-import');
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-out-'));
    fs.writeFileSync(path.join(ext, 'note.md'), '# N\n', 'utf8');
    fs.writeFileSync(path.join(ext, 'att.bin'), 'BIN', 'utf8');
    // DropImportContext = 実 dir 群（processDropVscodeUrisImport は内部で実 import を走らせる）
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-dest-'));
    const ctx = {
        fileDir: path.join(dest, 'files'),
        pageDir: dest,
        imageDir: path.join(dest, 'images'),
        outDir: dest,
    };
    fs.mkdirSync(ctx.fileDir, { recursive: true });
    fs.mkdirSync(ctx.imageDir, { recursive: true });

    const results = await di.processDropVscodeUrisImport(
        [
            toRemoteUri(path.join(ext, 'note.md')),
            'http://example.com/y.md',
            toRemoteUri(path.join(ext, 'att.bin')),
        ],
        ctx
    );
    // vscode-remote 2 件は受理され実 import される（従来 = Unsupported URI scheme で全滅）
    expect(results[0]?.ok, 'vscode-remote .md が拒否された').toBe(true);
    expect(results[0]?.kind).toBe('md');
    expect(results[2]?.ok, 'vscode-remote file が拒否された').toBe(true);
    expect(fs.existsSync(path.join(ctx.fileDir, 'att.bin')), 'file 実体が fileDir へ import されていない').toBe(true);
    // 他 scheme は従来の明示エラー文言（面別拒否形の不変 pin）
    expect(results[1]?.ok).toBe(false);
    expect(String(results[1]?.error || '')).toContain('Unsupported URI scheme');
});

// ── TC-RMT-05（sprint 20260822-051129 TASK-10）: silent skip 撤廃 — 理由付き failed 返却 ──
test('TC-RMT-05 registerExternalDroppedUris が失敗を理由付きで返す（scheme / not-found / folder / 部分成功）', () => {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt5-note-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt5-src-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const ok = path.join(src, 'good.html');
    fs.writeFileSync(ok, '<html></html>', 'utf8');
    fs.mkdirSync(path.join(src, 'adir'), { recursive: true });
    const enc = (p: string) => 'vscode-remote://localhost:8801' + p.split(path.sep).map(encodeURIComponent).join('/');
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };

    const r = mod.registerExternalDroppedUris(m, [
        enc(ok),                                     // 成功
        'https://example.com/x.md',                  // scheme 不受理
        enc(path.join(src, 'missing.pdf')),          // not-found
        enc(path.join(src, 'adir')),                 // フォルダ
    ], null, 0, sender as any);

    expect(r && typeof r === 'object', '返り値が結果オブジェクトでない').toBe(true);
    expect(r.registered).toBe(1);                    // 部分成功（good.html は登録される）
    expect(Array.isArray(r.failed)).toBe(true);
    expect(r.failed.length).toBe(3);
    const joined = r.failed.join(' | ');
    expect(joined).toContain('x.md');                                  // scheme 不受理も名前が出る
    expect(joined).toContain('missing.pdf');
    expect(joined).toContain(path.join(src, 'missing.pdf'));           // not-found は解決後パス込み（診断の核心）
    expect(joined).toContain('adir');
    // 登録成功分の一覧更新は従来どおり
    expect(messages.some((x) => x.type === 'notesFileListChanged' || x.type === 'updateFileList')).toBe(true);
    expect(Object.values(m.getStructure().items).some((it: any) => it.title === 'good.html')).toBe(true);
});
