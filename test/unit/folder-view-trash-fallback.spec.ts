/**
 * TC-FLV-74 — 移動系 source 除去の完全削除フォールバック（sprint 20260821-015014 FR-FLV-34 / ADRL-FVR-2）
 *
 * trash 不能環境（vscode server 等）で「移動が複製になる」縮退の解消。
 * (a) trash throw + deleteFile 成功 → 移動成立・エラー通知なし
 * (b) 両方 throw → 従来トースト + source 温存（データロスなし）
 * (c) deleteFile 未注入（後方互換・既存 TC-ACC の trash pin と同型）→ 従来どおり
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

function setup(): any {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvtf-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvtf-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    fs.writeFileSync(path.join(root, 'doc.md'), '# Doc\n', 'utf8');
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    return { mod, m, id, root, noteDir, sender };
}

test('TC-FLV-74a trash throw + deleteFile 成功 → 移動成立・エラー通知なし（フォールバック）', async () => {
    const { mod, m, id, root, noteDir, sender } = setup();
    const errors: string[] = [];
    const deleted: string[] = [];
    const deps = {
        showErrorMessage: (msg: string) => { errors.push(msg); },
        t: () => undefined,
        trashDelete: async () => { throw new Error('EPERM: trash unavailable (server)'); },
        deleteFile: async (absPath: string) => { deleted.push(absPath); fs.unlinkSync(absPath); },
        toDisplayUri: (p: string) => p,
    };
    expect(await mod.folderViewMoveToTree(m, id, 'doc.md', null, 0, deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(noteDir, 'doc.md'))).toBe(true);   // 複製成立
    expect(deleted).toEqual([path.join(root, 'doc.md')]);              // フォールバックが srcAbs で発火
    expect(fs.existsSync(path.join(root, 'doc.md'))).toBe(false);      // 移動成立（元は消える）
    expect(errors.length).toBe(0);                                     // エラー通知なし
});

test('TC-FLV-74b trash + deleteFile 両方 throw → 従来トースト + source 温存', async () => {
    const { mod, m, id, root, noteDir, sender } = setup();
    const errors: string[] = [];
    const deps = {
        showErrorMessage: (msg: string) => { errors.push(msg); },
        t: () => undefined,
        trashDelete: async () => { throw new Error('EPERM'); },
        deleteFile: async () => { throw new Error('EACCES'); },
        toDisplayUri: (p: string) => p,
    };
    expect(await mod.folderViewMoveToTree(m, id, 'doc.md', null, 0, deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(noteDir, 'doc.md'))).toBe(true);    // 複製は成立
    expect(fs.existsSync(path.join(root, 'doc.md'))).toBe(true);       // source 温存（データロスなし）
    expect(errors.length).toBeGreaterThanOrEqual(1);                   // 従来トースト
    expect(errors[0]).toContain('doc.md');
});

test('TC-FLV-74c deleteFile 未注入（後方互換）→ 従来どおりトースト + 温存', async () => {
    const { mod, m, id, root, noteDir, sender } = setup();
    const errors: string[] = [];
    const deps = {
        showErrorMessage: (msg: string) => { errors.push(msg); },
        t: () => undefined,
        trashDelete: async () => { throw new Error('EPERM'); },
        toDisplayUri: (p: string) => p,
    };
    expect(await mod.folderViewMoveToTree(m, id, 'doc.md', null, 0, deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(noteDir, 'doc.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'doc.md'))).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);
});
