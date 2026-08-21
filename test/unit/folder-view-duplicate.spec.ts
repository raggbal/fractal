/**
 * TC-ACC-30 — linkedfd（folder view）の Duplicate host 実装（sprint 20260820-063902 FR-ACC-04・ADRL-ACC-3）
 *
 * md = duplicateMdEntity(abs, folderRoot)（同 dir 複製 + 隣接資産複製 + subpage 再帰 — fv レイアウト適合）
 * file = copyEntityWithUniquify 同 dir 複製 / dir = 非対応通知 / traversal = clamp 拒否。
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
                Uri: { file: (p: string) => ({ fsPath: p }) },
                commands: { executeCommand: () => {} },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

test('TC-ACC-30 folderViewDuplicate: md = 同 dir 随伴複製（subpage 再帰）/ file = 単体複製 / dir・traversal = 拒否', async () => {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    expect(typeof mod.folderViewDuplicate, 'folderViewDuplicate の export 不在').toBe('function');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvdup-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvdup-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    const errors: string[] = [];
    const deps = {
        showErrorMessage: (msg: string) => errors.push(msg),
        t: (_k: string) => undefined as any,
        trashDelete: async () => {},
        toDisplayUri: (p: string) => p,
    };
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    // fixture: 資産持ち md（fv 隣接レイアウト）
    fs.mkdirSync(path.join(root, 'images'), { recursive: true });
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    fs.writeFileSync(path.join(root, 'images', 'pic.png'), 'PNG', 'utf8');
    fs.writeFileSync(path.join(root, 'files', 'a.pdf'), 'PDF', 'utf8');
    fs.writeFileSync(path.join(root, 'sub.md'), '# Sub\n', 'utf8');
    fs.writeFileSync(path.join(root, 'main.md'), '# Main\n![i](images/pic.png)\n[📎 a.pdf](files/a.pdf)\n[[Sub]](sub.md)\n', 'utf8');

    // md Duplicate → 同 dir に main-1.md + 資産複製 + subpage 再帰・元不変
    expect(await mod.folderViewDuplicate(m, id, 'main.md', deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(root, 'main-1.md'))).toBe(true);
    const dupBody = fs.readFileSync(path.join(root, 'main-1.md'), 'utf8');
    expect(dupBody).toContain('images/pic-1.png');
    expect(dupBody).toContain('files/a-1.pdf');
    expect(dupBody).toContain('(sub-1.md)');
    expect(fs.existsSync(path.join(root, 'sub-1.md'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'main.md'), 'utf8')).toContain('images/pic.png');
    // list 更新が飛ぶ
    expect(messages.some((x) => x.type === 'folderViewListResult')).toBe(true);

    // file Duplicate → 同 dir に単体複製
    expect(await mod.folderViewDuplicate(m, id, 'files/a.pdf', deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(root, 'files', 'a-2.pdf')), 'file 単体複製（a-1 は md 随伴で消費済み → a-2）').toBe(true);

    // dir → 非対応通知 / traversal → 拒否（副作用ゼロ）
    fs.mkdirSync(path.join(root, 'adir'), { recursive: true });
    const errCount = errors.length;
    expect(await mod.folderViewDuplicate(m, id, 'adir', deps as any, sender as any)).toBe(false);
    expect(errors.length).toBe(errCount + 1);
    // traversal は clamp 拒否 + 副作用ゼロ（実在する root 外 md でも複製が湧かない — reviewer iter2 SEC-TEST-2）
    const outsideMd = path.join(path.dirname(root), 'outside.md');
    fs.writeFileSync(outsideMd, '# Out\n', 'utf8');
    const rootEntriesBefore = fs.readdirSync(root).sort();
    expect(await mod.folderViewDuplicate(m, id, '../outside.md', deps as any, sender as any)).toBe(false);
    // clamp を外すと outside-1.md（uniquify 複製）が湧く = RED になる counterfactual
    expect(fs.existsSync(path.join(path.dirname(root), 'outside-1.md'))).toBe(false);
    expect(fs.readFileSync(outsideMd, 'utf8')).toBe('# Out\n');
    expect(fs.readdirSync(root).sort()).toEqual(rootEntriesBefore);
});
