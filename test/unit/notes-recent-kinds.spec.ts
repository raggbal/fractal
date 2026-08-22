/**
 * TC-RCT-01..03 — Recent の folder link / viewer file 統合（sprint 20260822-051129 FR-RCT）
 *
 * 記録（folderViewOpened / recordViewerFileHistory）・click（historyOpenFile の clamp + viewer 分岐）・
 * 後方互換（旧 openFile に新 kind パスが流れても落ちない）を host unit で検証。
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
                env: { openExternal: async () => {} }, ViewColumn: {}, EventEmitter: class {},
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
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    return { mod, m, id, root, noteDir, messages, sender };
}
const hist = (m: any) => (m.getStructure().history || []) as any[];

test('TC-RCT-01 folder link: folderViewOpened で kind=folder 記録（id=folderLinkId・絶対パス不含）+ 一覧 title 追従', async () => {
    const { mod, m, id, root, sender } = setup();
    // 新 message: folderViewOpened（dispatcher showFolderView が送る）
    await mod.handleNotesMessage({ type: 'folderViewOpened', id }, m as any, sender as any, {} as any);
    const h = hist(m);
    expect(h.length).toBe(1);
    expect(h[0].kind).toBe('folder');
    expect(h[0].id).toBe(id);                                  // folderLinkId（ADRL-0071 — path を webview に出さない）
    expect(JSON.stringify(h[0]).includes(root), 'entry に絶対パスが混入').toBe(false);
    expect(h[0].title).toBe(path.basename(root));
    // 重複 open は先頭移動（増えない）
    await mod.handleNotesMessage({ type: 'folderViewOpened', id }, m as any, sender as any, {} as any);
    expect(hist(m).length).toBe(1);
    // fresh title: link を rename すると一覧 title が追従
    (m.getStructure().items[id] as any).title = 'Renamed';
    const fresh = m.getHistoryWithFreshTitles();
    expect(fresh[0].title).toBe('Renamed');
});

test('TC-RCT-02 viewer file: fv open / historyOpenFile の記録 + clamp + viewer 分岐 + MAX 共有', async () => {
    const { mod, m, id, root, noteDir, sender } = setup();
    fs.writeFileSync(path.join(root, 'doc.pdf'), 'PDF', 'utf8');
    fs.writeFileSync(path.join(root, 'note.bin'), 'BIN', 'utf8');
    // (a) fv エントリ open（非 md）→ kind='file' 記録
    const deps = {
        showErrorMessage: () => {}, t: () => undefined,
        ensureResourceRoot: () => {}, openMdInSidePanel: async () => {},
        openViewerPanel: async () => {}, openExternal: async () => {},
    };
    expect(await mod.folderViewOpen(m, id, 'doc.pdf', deps as any)).toBe(true);
    let h = hist(m);
    expect(h.some((e) => e.kind === 'file' && e.id === path.join(root, 'doc.pdf')), 'fv open が記録されない').toBe(true);
    // (b) historyOpenFile: clamp（folder link root 配下 = 許可 / note・link 外 = 拒否）+ viewer/external 分岐
    const opened: string[] = [];
    const platform = {
        historyOpenFile: async (absPath: string) => { opened.push(absPath); },
    };
    await mod.handleNotesMessage(
        { type: 'historyOpenFile', filePath: path.join(root, 'doc.pdf') }, m as any, sender as any, platform as any);
    expect(opened).toEqual([path.join(root, 'doc.pdf')]);
    // clamp: note・link root 外は platform 不達
    await mod.handleNotesMessage(
        { type: 'historyOpenFile', filePath: '/etc/hosts' }, m as any, sender as any, platform as any);
    expect(opened.length).toBe(1);
    // (c) MAX 20 共有: 25 件 push で 20 に切られ最古が落ちる
    for (let i = 0; i < 25; i++) {
        m.pushHistory({ kind: 'file', id: `/x/f${i}.pdf`, title: `f${i}`, ts: i });
    }
    expect(hist(m).length).toBe(20);
    expect(hist(m).some((e) => e.id === '/x/f0.pdf')).toBe(false);
});

test('TC-RCT-03 後方互換: 旧 click 経路（notesOpenFile に pdf パス）で落ちない + 既存 md/out 記録不変', async () => {
    const { mod, m, root, noteDir, messages, sender } = setup();
    fs.writeFileSync(path.join(root, 'doc.pdf'), 'PDF', 'utf8');
    // 旧バージョン相当: kind='file' entry を openFile に流す → throw せず一覧再送で復元
    await mod.handleNotesMessage(
        { type: 'notesOpenFile', filePath: path.join(root, 'doc.pdf') }, m as any, sender as any, {} as any);
    expect(messages.length, '旧経路が silent に死んでいる（一覧復元等の応答なし）').toBeGreaterThanOrEqual(1);
    // 既存 md 記録の byte 不変（kind='note-md'）
    fs.writeFileSync(path.join(noteDir, 'a.md'), '# A\n', 'utf8');
    m.registerExistingMdFile('a', 'A', null, 0);
    await mod.handleNotesMessage({ type: 'notesOpenFile', filePath: path.join(noteDir, 'a.md') }, m as any, sender as any, {} as any);
    const h = hist(m);
    expect(h.some((e) => e.kind === 'note-md' && e.id === path.join(noteDir, 'a.md'))).toBe(true);
});

test('TC-RCT-04 本番配線: notesWebviewContent の history panel bridge subset に historyOpenFile がある（手書き subset 追加漏れの番人 — generator_failures 2026-08-09 クラス）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/notesWebviewContent.ts'), 'utf8');
    const start = src.indexOf('bridge: {');
    const end = src.indexOf('initialHistory:');
    expect(start).toBeGreaterThan(0);
    const bridgeBlock = src.slice(start, end);
    expect(bridgeBlock.includes('historyOpenFile'), 'history panel の bridge subset に historyOpenFile が無い（Recent file click が silent no-op）').toBe(true);
});
