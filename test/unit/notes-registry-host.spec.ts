/**
 * spec 20261026-1845-fractal-file-views — NotesFolderProvider / NotesListsProvider（default.fractal の初回作成・作成・切替・解除・ビュー）。
 * vscode を stub require する（test/unit/folder-link-host.spec.ts と同じ「require 直前 purge + finally purge」）。
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

/** ダイアログの答えを順に返す stub。答えが尽きたら undefined（= キャンセル） */
function makeVscodeStub() {
    const answers = { openDialog: [] as (string | undefined)[], inputBox: [] as (string | undefined)[], quickPick: [] as ((items: any[]) => any)[], info: [] as (string | undefined)[], warn: [] as (string | undefined)[] };
    const shown = { info: [] as string[], warn: [] as string[], error: [] as string[], context: {} as Record<string, unknown> };
    class EventEmitter { private ls: any[] = []; event = (l: any) => { this.ls.push(l); return { dispose() {} }; }; fire(v: any) { this.ls.forEach(l => l(v)); } }
    class TreeItem { constructor(public label: string, public collapsibleState: number) {} }
    const stub = {
        EventEmitter,
        TreeItem,
        TreeItemCollapsibleState: { None: 0 },
        ThemeIcon: class { constructor(public id: string) {} },
        DataTransferItem: class { constructor(public value: any) {} },
        RelativePattern: class { constructor(public base: any, public pattern: string) {} },
        Uri: { file: (p: string) => ({ fsPath: p }) },
        workspace: {},
        commands: { executeCommand: async (cmd: string, key: string, value: unknown) => { if (cmd === 'setContext') shown.context[key] = value; } },
        window: {
            showOpenDialog: async () => { const a = answers.openDialog.shift(); return a === undefined ? undefined : [{ fsPath: a }]; },
            showInputBox: async (opts: any) => {
                const a = answers.inputBox.shift();
                if (a !== undefined && opts.validateInput && opts.validateInput(a)) return undefined; // 検証エラーは確定できない
                return a;
            },
            showQuickPick: async (items: any[]) => { const f = answers.quickPick.shift(); return f ? f(items) : undefined; },
            showInformationMessage: async (m: string) => { shown.info.push(m); return answers.info.shift(); },
            showWarningMessage: async (m: string) => { shown.warn.push(m); return answers.warn.shift(); },
            showErrorMessage: async (m: string) => { shown.error.push(m); return undefined; },
        },
    };
    return { stub, answers, shown };
}

function loadProvider(stub: any): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') return stub;
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../../src/notesFolderProvider');
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

function makeContext(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        store,
        globalState: {
            get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
            update: async (k: string, v: unknown) => { store.set(k, v); },
        },
    };
}

function setup(initial: Record<string, unknown> = {}, defaultFile?: string) {
    const v = makeVscodeStub();
    const mod = loadProvider(v.stub);
    const ctx = makeContext(initial);
    const def = defaultFile || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nr-home-')), '.fractal', 'default.fractal');
    const provider = new mod.NotesFolderProvider(ctx, def);
    return { ...v, mod, ctx, provider, def };
}

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test.describe('NotesFolderProvider × .fractal', () => {
    test('AC-1 初回に default.fractal を作って旧 notesFolders を入れ、登録・アクティブにする。空でも作る。2 回目は作らない', async () => {
        const legacy = [tmp('nr-legacy-a-'), tmp('nr-legacy-b-')];
        const s1 = setup({ notesFolders: legacy });
        expect(s1.shown.context['fractal.hasNotesRegistry']).toBe(false);
        await s1.provider.initialize();
        expect(readJson(s1.def)).toEqual({ version: 1, notes: legacy });
        expect(s1.provider.getRegistries()).toEqual([s1.def]);
        expect(s1.provider.getActiveRegistry()).toBe(s1.def);
        expect(s1.provider.getFolders()).toEqual(legacy);
        expect(s1.ctx.store.get('notesRegistryInitialized')).toBe(true);
        expect(s1.shown.context['fractal.hasNotesRegistry']).toBe(true);

        // 旧が空でも作る
        const s2 = setup();
        await s2.provider.initialize();
        expect(readJson(s2.def)).toEqual({ version: 1, notes: [] });
        expect(s2.provider.getActiveRegistry()).toBe(s2.def);

        // 全部解除した後の起動では作り直さない（フラグ）
        await s2.provider.removeRegistry({ file: s2.def });
        fs.rmSync(s2.def);
        const again = new s2.mod.NotesFolderProvider(s2.ctx, s2.def);
        await again.initialize();
        expect(fs.existsSync(s2.def)).toBe(false);
        expect(again.getRegistries()).toEqual([]);

        // rc.8 で既に登録があれば作らない
        const old = path.join(tmp('nr-rc8-'), 'work-fractal-notes.json');
        fs.writeFileSync(old, JSON.stringify({ version: 1, name: 'work', title: '仕事', notes: ['/x'] }));
        const s3 = setup({ notesRegistries: [old], activeNotesRegistry: old });
        await s3.provider.initialize();
        expect(fs.existsSync(s3.def)).toBe(false);
        expect(s3.provider.getFolders()).toEqual(['/x']);
    });

    test('AC-2 default.fractal が既にあれば無い Note だけ足す。壊れていれば書かずに登録して警告。作成に失敗したらフラグを立てない', async () => {
        const home = tmp('nr-exist-');
        const def = path.join(home, '.fractal', 'default.fractal');
        fs.mkdirSync(path.dirname(def));
        fs.writeFileSync(def, JSON.stringify({ version: 1, notes: ['/other-ide'] }));
        const s1 = setup({ notesFolders: ['/mine', '/other-ide'] }, def);
        await s1.provider.initialize();
        expect(readJson(def).notes).toEqual(['/other-ide', '/mine']);
        expect(s1.provider.getFolders()).toEqual(['/other-ide', '/mine']);

        fs.writeFileSync(def, '{ broken');
        const s2 = setup({ notesFolders: ['/mine'] }, def);
        await s2.provider.initialize();
        expect(fs.readFileSync(def, 'utf8')).toBe('{ broken');
        expect(s2.provider.getRegistries()).toEqual([def]);
        expect(s2.shown.warn.length).toBe(1);
        expect(s2.ctx.store.get('notesFolders')).toEqual(['/mine']); // 旧の Note は消えない

        // 作れない（親が通常ファイル）→ フラグを立てない
        const blocker = path.join(tmp('nr-fail-'), 'file');
        fs.writeFileSync(blocker, 'x');
        const s3 = setup({ notesFolders: ['/mine'] }, path.join(blocker, '.fractal', 'default.fractal'));
        await s3.provider.initialize();
        expect(s3.ctx.store.get('notesRegistryInitialized')).toBeUndefined();
        expect(s3.provider.getRegistries()).toEqual([]);
        expect(s3.shown.warn.length).toBe(1);
    });

    test('AC-3 新規作成は 保存先 + name。不正な name・同名・キャンセルでは書かない。既存を追加・切替・解除', async () => {
        const dir = tmp('nr-create-');
        const { provider, answers, ctx, shown, mod, def } = setup();
        await provider.initialize();

        answers.openDialog.push(dir);
        answers.inputBox.push(undefined);
        expect(await provider.createRegistry()).toBe(false);
        answers.openDialog.push(dir);
        answers.inputBox.push('my work');
        expect(await provider.createRegistry()).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);

        answers.openDialog.push(dir);
        answers.inputBox.push('work');
        expect(await provider.createRegistry()).toBe(true);
        const work = path.join(dir, 'work.fractal');
        expect(readJson(work)).toEqual({ version: 1, notes: [] });
        expect(provider.getRegistries()).toEqual([def, work]);
        expect(ctx.store.get('activeNotesRegistry')).toBe(work);

        fs.writeFileSync(work, JSON.stringify({ version: 1, notes: ['/keep'] }));
        answers.openDialog.push(dir);
        answers.inputBox.push('work');
        expect(await provider.createRegistry()).toBe(false);
        expect(readJson(work).notes).toEqual(['/keep']);
        expect(shown.error.length).toBe(1);

        // Note の追加・並べ替え・削除はアクティブの .fractal に書かれ、notesFolders に写る
        const [a, b] = [tmp('nr-a-'), tmp('nr-b-')];
        for (const f of [a, b]) { answers.openDialog.push(f); await provider.addFolder(); }
        expect(readJson(work).notes).toEqual(['/keep', a, b]);
        await provider.handleDrop(new mod.NotesFolderItem('/keep'), { get: () => ({ value: [b] }) });
        expect(readJson(work).notes).toEqual([b, '/keep', a]);
        await provider.removeFolder(new mod.NotesFolderItem('/keep'));
        expect(readJson(work).notes).toEqual([b, a]);
        expect(ctx.store.get('notesFolders')).toEqual([b, a]);
        expect(readJson(def).notes).toEqual([]); // 他の .fractal には書かない

        // 既存を追加（.fractal / 形式違いは登録しない）
        const other = path.join(tmp('nr-open-'), 'home.fractal');
        fs.writeFileSync(other, JSON.stringify({ version: 1, notes: ['/h'] }));
        answers.openDialog.push(other);
        expect(await provider.openRegistry()).toBe(true);
        const bogus = path.join(tmp('nr-bogus-'), 'x.fractal');
        fs.writeFileSync(bogus, JSON.stringify({ name: 'x' }));
        answers.openDialog.push(bogus);
        expect(await provider.openRegistry()).toBe(false);
        expect(provider.getRegistries()).toEqual([def, work, other]);
        expect(provider.getFolders()).toEqual(['/h']);
        expect(provider.getAllFolders()).toEqual(['/h', b, a]);

        // 切替（Notes Lists の行クリック）・解除（行の ✕。ファイルは消さない）
        await provider.activateRegistry(work);
        expect(provider.getFolders()).toEqual([b, a]);
        await provider.removeRegistry({ file: work });
        expect(fs.existsSync(work)).toBe(true);
        expect(provider.getActiveRegistry()).toBe(def);
        await provider.removeRegistry({ file: def });
        await provider.removeRegistry({ file: other });
        expect(provider.getActiveRegistry()).toBeUndefined();
        expect(shown.context['fractal.hasNotesRegistry']).toBe(false);

        // 一覧が無いときの Note 追加は、先に既存を追加 / 新規作成を聞く
        answers.info.push(undefined);
        await provider.addFolder();
        expect(shown.info.some((m: string) => m.includes('.fractal'))).toBe(true);
    });

    test('AC-4 Notes Lists に登録した .fractal（アクティブに印・壊れたものに ⚠）、Notes の description はファイル名', async () => {
        const dir = tmp('nr-view-');
        const f1 = path.join(dir, 'a.fractal');
        const f2 = path.join(dir, 'b.fractal');
        fs.writeFileSync(f1, JSON.stringify({ version: 1, notes: ['/one'] }));
        fs.writeFileSync(f2, '{ broken');
        const { provider } = setup({ notesRegistries: [f1, f2], activeNotesRegistry: f1, notesRegistryInitialized: true });
        const view: any = {};
        provider.setTreeView(view);
        expect(view.description).toBe('a.fractal');
        const rows = provider.lists.getChildren();
        expect(rows.map((r: any) => r.label)).toEqual(['a.fractal', 'b.fractal']);
        expect(rows[0].description).toBe('●');
        expect(rows[0].iconPath.id).toBe('check');
        expect(rows[0].command.command).toBe('fractal.activateNotesRegistry');
        expect(rows[0].command.arguments).toEqual([f1]);
        expect(rows[1].iconPath.id).toBe('warning');
        expect(rows[1].tooltip).toContain('Invalid JSON');
        expect(rows.every((r: any) => r.contextValue === 'notesList')).toBe(true);
        expect(provider.getChildren().map((i: any) => i.folderPath)).toEqual(['/one']);
    });

    test('AC-5 views・メニュー・viewsWelcome のコマンドが extension.ts で登録され、Note 追加は notesExplorer、.fractal の操作は notesLists にだけ出る', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const ext = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
        expect(pkg.contributes.views['fractal-notes'].map((v: any) => v.id)).toEqual(['notesLists', 'notesExplorer']);
        for (const id of ['notesLists', 'notesExplorer']) expect(ext, id).toContain(`createTreeView('${id}'`);
        const declared = pkg.contributes.commands.map((c: any) => c.command);
        const menus = [...pkg.contributes.menus['view/title'], ...pkg.contributes.menus['view/item/context']];
        const inView = (id: string) => menus.filter((m: any) => m.when.includes(`view == ${id}`)).map((m: any) => m.command);
        expect(inView('notesExplorer').sort()).toEqual(['fractal.addNotesFolder', 'fractal.migrateToFlatLayout', 'fractal.removeNotesFolder']);
        expect(inView('notesLists').sort()).toEqual(['fractal.createNotesRegistry', 'fractal.openNotesRegistry', 'fractal.removeNotesRegistry']);
        const welcome = pkg.contributes.viewsWelcome.map((w: any) => w.contents).join('\n');
        const used = new Set<string>([...menus.map((m: any) => m.command), ...[...welcome.matchAll(/command:([\w.]+)/g)].map(m => m[1]), 'fractal.activateNotesRegistry', 'fractal.switchNotesRegistry']);
        for (const c of used) {
            expect(declared, c).toContain(c);
            expect(ext, c).toContain(`registerCommand('${c}'`);
        }
        expect(ext).toContain('notesFolderProvider.initialize()');
    });
});
