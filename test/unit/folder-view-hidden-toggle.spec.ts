/**
 * TC-FLV-64..66 — fv 隠しファイル表示トグル（sprint 20260821-015014 FR-FLV-31）
 *
 * 既定 OFF = dotfile 非表示（FR-FLV-11 pin）。トグルで sidecar `.fractal-folderview.json` に
 * showHidden を upsert（expanded と共存・false はキー削除）。symlink はトグル無関係に常時除外
 * （NFR-FLV-01）。filter は host 一覧生成の一点（folderViewList / 操作後 echo 共通）。
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
    const state = requireWithVscodeStub('../../src/shared/folderview-state');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvhid-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvhid-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    fs.writeFileSync(path.join(root, 'visible.md'), '# V\n', 'utf8');
    fs.writeFileSync(path.join(root, '.fractal.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(root, '.hiddendir'), { recursive: true });
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    const lastList = () => messages.filter((x) => x.type === 'folderViewListResult').slice(-1)[0];
    return { mod, state, m, id, root, messages, sender, lastList };
}

test('TC-FLV-64 既定 OFF: dotfile 非表示（従来 pin）+ root 応答に showHidden:false 同梱', async () => {
    const { mod, m, id, sender, lastList } = setup();
    expect(await mod.folderViewList(m, id, '', sender as any)).toBe(true);
    const msg = lastList();
    const names = msg.entries.map((e: any) => e.name);
    expect(names).toContain('visible.md');
    expect(names).not.toContain('.fractal.json');
    expect(names).not.toContain('.hiddendir');
    expect(msg.showHidden).toBe(false);
});

test('TC-FLV-65 folderViewToggleHidden: sidecar upsert（expanded 共存）→ dotfile 表示 / 再トグルでキー削除', async () => {
    const { mod, state, m, id, root, sender, lastList } = setup();
    // expanded を先に保存（共存 upsert の番人）
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    state.saveFolderViewExpanded(root, ['sub']);

    expect(typeof mod.folderViewToggleHidden, 'folderViewToggleHidden export 不在').toBe('function');
    expect(await mod.folderViewToggleHidden(m, id, sender as any)).toBe(true);
    // sidecar: showHidden:true + expanded 保持
    const sidecar = JSON.parse(fs.readFileSync(path.join(root, '.fractal-folderview.json'), 'utf8'));
    expect(sidecar.showHidden).toBe(true);
    expect(sidecar.expanded).toEqual(['sub']);
    // toggle 自身が root list を再送 + dotfile が出る + showHidden:true
    const msg = lastList();
    expect(msg.relPath).toBe('');
    const names = msg.entries.map((e: any) => e.name);
    expect(names).toContain('.fractal.json');
    expect(names).toContain('.hiddendir');
    expect(msg.showHidden).toBe(true);
    // 再トグル → キー削除（残骸ゼロ）・expanded は保持・dotfile 消える
    expect(await mod.folderViewToggleHidden(m, id, sender as any)).toBe(true);
    const sidecar2 = JSON.parse(fs.readFileSync(path.join(root, '.fractal-folderview.json'), 'utf8'));
    expect('showHidden' in sidecar2).toBe(false);
    expect(sidecar2.expanded).toEqual(['sub']);
    expect(lastList().entries.map((e: any) => e.name)).not.toContain('.fractal.json');
});

test('TC-FLV-66 ON でも symlink は常時除外（NFR-FLV-01）+ subdir list / 操作後 echo も filter 共有', async () => {
    const { mod, state, m, id, root, sender, lastList } = setup();
    fs.symlinkSync(path.join(root, 'visible.md'), path.join(root, '.sym-hidden.md'));
    fs.symlinkSync(path.join(root, 'visible.md'), path.join(root, 'sym-plain.md'));
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', '.dot-in-sub'), 'x', 'utf8');
    state.saveFolderViewShowHidden(root, true);

    // root: dotfile は出るが symlink は dot/非 dot とも出ない
    expect(await mod.folderViewList(m, id, '', sender as any)).toBe(true);
    const names = lastList().entries.map((e: any) => e.name);
    expect(names).toContain('.fractal.json');
    expect(names).not.toContain('.sym-hidden.md');
    expect(names).not.toContain('sym-plain.md');
    // subdir list も同じ filter
    expect(await mod.folderViewList(m, id, 'sub', sender as any)).toBe(true);
    expect(lastList().entries.map((e: any) => e.name)).toContain('.dot-in-sub');
    // 操作後 echo（folderViewCreate → sendFolderViewList）も filter 共有 = dotfile が echo に出る
    const deps = {
        showErrorMessage: () => {}, t: () => undefined,
        showInputBox: async () => 'newdoc',
        trashDelete: async () => {}, toDisplayUri: (p: string) => p,
    };
    expect(await mod.folderViewCreate(m, id, '', 'md', deps as any, sender as any)).toBe(true);
    const echoNames = lastList().entries.map((e: any) => e.name);
    expect(echoNames).toContain('newdoc.md');
    expect(echoNames).toContain('.fractal.json');
});

test('TC-FLV-72 folderViewSearch の showHidden 追従（QUAL-2）: OFF で dotfile 非ヒット / ON で dot dir 配下含めヒット / symlink は ON でも非ヒット', async () => {
    const { mod, state, m, id, root, messages, sender } = setup();
    fs.mkdirSync(path.join(root, '.hdir'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hdir', 'inner-doc.md'), '# I\n', 'utf8');
    fs.symlinkSync(path.join(root, 'visible.md'), path.join(root, 'fractal-sym.md'));
    const lastSearch = () => messages.filter((x) => x.type === 'folderViewSearchResult').slice(-1)[0];

    // OFF（既定）: dotfile・dot dir 配下とも非ヒット（従来 pin）
    expect(await mod.folderViewSearch(m, id, 'fractal', sender as any)).toBe(true);
    expect(lastSearch().hits.map((h: any) => h.name)).toEqual([]);
    expect(await mod.folderViewSearch(m, id, 'inner-doc', sender as any)).toBe(true);
    expect(lastSearch().hits.length).toBe(0);

    // ON: dotfile がヒット + dot dir 配下も走査される
    state.saveFolderViewShowHidden(root, true);
    expect(await mod.folderViewSearch(m, id, 'fractal', sender as any)).toBe(true);
    const names = lastSearch().hits.map((h: any) => h.name);
    expect(names).toContain('.fractal.json');
    expect(names).not.toContain('fractal-sym.md'); // symlink は ON でも常時除外（NFR-FLV-01）
    expect(await mod.folderViewSearch(m, id, 'inner-doc', sender as any)).toBe(true);
    expect(lastSearch().hits.map((h: any) => h.relPath)).toContain('.hdir/inner-doc.md');
});
