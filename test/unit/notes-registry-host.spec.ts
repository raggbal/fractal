/**
 * spec 20261026-1555-fractal-notes-json — NotesFolderProvider（Notes 一覧ファイルの作成・取り込み・切替・解除）。
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

function setup(initial: Record<string, unknown> = {}) {
    const v = makeVscodeStub();
    const mod = loadProvider(v.stub);
    const ctx = makeContext(initial);
    const provider = new mod.NotesFolderProvider(ctx);
    return { ...v, mod, ctx, provider };
}

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test.describe('NotesFolderProvider × Notes 一覧ファイル', () => {
    test('AC-2 保存先・name・title を指定すると作られて登録・アクティブになる。途中キャンセルでは何も書かない', async () => {
        const dir = tmp('nr-create-');
        const { provider, answers, ctx, shown } = setup();
        expect(shown.context['fractal.hasNotesRegistry']).toBe(false);

        // キャンセル（title で中断）→ 何も書かない
        answers.openDialog.push(dir);
        answers.inputBox.push('work', undefined);
        expect(await provider.createRegistry()).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);
        // 不正な name は確定できない
        answers.openDialog.push(dir);
        answers.inputBox.push('my work');
        expect(await provider.createRegistry()).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);

        answers.openDialog.push(dir);
        answers.inputBox.push('work', '仕事');
        expect(await provider.createRegistry()).toBe(true);
        const file = path.join(dir, 'work-fractal-notes.json');
        expect(readJson(file)).toEqual({ version: 1, name: 'work', title: '仕事', notes: [] });
        expect(ctx.store.get('notesRegistries')).toEqual([file]);
        expect(ctx.store.get('activeNotesRegistry')).toBe(file);
        expect(shown.context['fractal.hasNotesRegistry']).toBe(true);

        // 同名は上書きしない
        fs.writeFileSync(file, JSON.stringify({ version: 1, name: 'work', title: '仕事', notes: ['/keep'] }));
        answers.openDialog.push(dir);
        answers.inputBox.push('work', '別');
        expect(await provider.createRegistry()).toBe(false);
        expect(readJson(file).notes).toEqual(['/keep']);
        expect(shown.error.length).toBe(1);
    });

    test('AC-3 初回の新規作成で旧 notesFolders を取り込む。既存を開いたときは取り込まない。旧キーは残る', async () => {
        const legacy = [tmp('nr-legacy-a-'), tmp('nr-legacy-b-')];
        const dir = tmp('nr-import-');
        const s1 = setup({ notesFolders: legacy });
        s1.answers.openDialog.push(dir);
        s1.answers.inputBox.push('home', '個人');
        await s1.provider.createRegistry();
        const file = path.join(dir, 'home-fractal-notes.json');
        expect(readJson(file).notes).toEqual(legacy);
        expect(s1.provider.getFolders()).toEqual(legacy);
        expect(s1.ctx.store.get('notesFolders')).toEqual(legacy);
        expect(s1.shown.info.some((m: string) => m.includes('imported 2'))).toBe(true);

        // 2 つ目の新規作成では取り込まない
        s1.answers.openDialog.push(dir);
        s1.answers.inputBox.push('second', '2');
        await s1.provider.createRegistry();
        expect(readJson(path.join(dir, 'second-fractal-notes.json')).notes).toEqual([]);

        // 既存を開く: 取り込まない
        const other = path.join(tmp('nr-open-'), 'x-fractal-notes.json');
        fs.writeFileSync(other, JSON.stringify({ version: 1, name: 'x', title: 'X', notes: [] }));
        const s2 = setup({ notesFolders: legacy });
        s2.answers.openDialog.push(other);
        expect(await s2.provider.openRegistry()).toBe(true);
        expect(readJson(other).notes).toEqual([]);
        expect(s2.provider.getFolders()).toEqual([]);
        // 形式の違う json は登録しない
        const bogus = path.join(tmp('nr-bogus-'), 'package.json');
        fs.writeFileSync(bogus, JSON.stringify({ name: 'x' }));
        s2.answers.openDialog.push(bogus);
        expect(await s2.provider.openRegistry()).toBe(false);
        expect(s2.provider.getRegistries()).toEqual([other]);
    });

    test('AC-4 Note の追加・削除・並べ替えがアクティブの一覧に書かれ notesFolders に写る。壊れた一覧には書かない', async () => {
        const dir = tmp('nr-mutate-');
        const file = path.join(dir, 'w-fractal-notes.json');
        fs.writeFileSync(file, JSON.stringify({ version: 1, name: 'w', title: 'W', notes: [], extra: { keep: true } }));
        const { provider, answers, ctx, mod, shown } = setup({ notesRegistries: [file], activeNotesRegistry: file });
        const [a, b, c] = [tmp('nr-a-'), tmp('nr-b-'), tmp('nr-c-')];
        for (const f of [a, b, c]) { answers.openDialog.push(f); await provider.addFolder(); }
        expect(readJson(file).notes).toEqual([a, b, c]);
        expect(readJson(file).extra).toEqual({ keep: true });
        expect(ctx.store.get('notesFolders')).toEqual([a, b, c]);

        // 並べ替え: c を a の位置へ
        const dt = { get: () => ({ value: [c] }) };
        await provider.handleDrop(new mod.NotesFolderItem(a), dt);
        expect(readJson(file).notes).toEqual([c, a, b]);

        await provider.removeFolder(new mod.NotesFolderItem(a));
        expect(readJson(file).notes).toEqual([c, b]);
        expect(ctx.store.get('notesFolders')).toEqual([c, b]);

        // 別ウィンドウが書いた変更を潰さない（書く直前に読み直す）
        fs.writeFileSync(file, JSON.stringify({ version: 1, name: 'w', title: 'W', notes: [c, b, '/other-window'] }));
        answers.openDialog.push(a);
        await provider.addFolder();
        expect(readJson(file).notes).toEqual([c, b, '/other-window', a]);

        // 壊れた一覧には書かない（表示は最後に読めた中身のまま）
        fs.writeFileSync(file, '{ broken');
        answers.openDialog.push(tmp('nr-d-'));
        await provider.addFolder();
        expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
        expect(provider.getFolders()).toEqual([c, b, '/other-window', a]);
        expect(shown.warn.length).toBeGreaterThan(0);
    });

    test('AC-5 複数の一覧を切り替えると Note が入れ替わる。解除はファイルを消さない。リンク逆引きは和集合', async () => {
        const dir = tmp('nr-switch-');
        const [n1, n2, n3] = ['/notes/one', '/notes/two', '/notes/three'];
        const f1 = path.join(dir, 'a-fractal-notes.json');
        const f2 = path.join(dir, 'b-fractal-notes.json');
        fs.writeFileSync(f1, JSON.stringify({ version: 1, name: 'a', title: 'A', notes: [n1, n2] }));
        fs.writeFileSync(f2, JSON.stringify({ version: 1, name: 'b', title: 'B', notes: [n2, n3] }));
        const { provider, answers, ctx, shown } = setup({ notesRegistries: [f1, f2], activeNotesRegistry: f1 });
        const view: any = {};
        provider.setTreeView(view);
        expect(view.description).toBe('A');
        expect(provider.getChildren().map((i: any) => i.folderPath)).toEqual([n1, n2]);
        expect(provider.getAllFolders()).toEqual([n1, n2, n3]);

        answers.quickPick.push(items => items.find((i: any) => i.file === f2));
        await provider.switchRegistry();
        expect(provider.getChildren().map((i: any) => i.folderPath)).toEqual([n2, n3]);
        expect(ctx.store.get('activeNotesRegistry')).toBe(f2);
        expect(ctx.store.get('notesFolders')).toEqual([n2, n3]);
        expect(view.description).toBe('B');

        // アクティブを解除 → 残りの先頭へ。ファイルは消さない
        answers.quickPick.push(items => items.find((i: any) => i.file === f2));
        await provider.removeRegistry();
        expect(fs.existsSync(f2)).toBe(true);
        expect(provider.getRegistries()).toEqual([f1]);
        expect(provider.getActiveRegistry()).toBe(f1);
        expect(provider.getFolders()).toEqual([n1, n2]);

        // 最後の 1 つを解除 → 一覧なし（welcome）
        answers.quickPick.push(items => items.find((i: any) => i.file === f1));
        await provider.removeRegistry();
        expect(provider.getActiveRegistry()).toBeUndefined();
        expect(provider.getFolders()).toEqual([]);
        expect(shown.context['fractal.hasNotesRegistry']).toBe(false);
        expect(fs.existsSync(f1)).toBe(true);

        // 一覧が無いときの Note 追加は、先に既存を開く / 新規作成を聞く
        answers.info.push(undefined);
        await provider.addFolder();
        expect(shown.info.some((m: string) => m.includes('fractal-notes.json'))).toBe(true);
        expect(provider.getRegistries()).toEqual([]);
    });

    test('AC-6 package.json の一覧コマンドが extension.ts で登録され、view/title・viewsWelcome から呼べる', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const ext = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
        const cmds = ['fractal.switchNotesRegistry', 'fractal.openNotesRegistry', 'fractal.createNotesRegistry', 'fractal.removeNotesRegistry'];
        const declared = pkg.contributes.commands.map((c: any) => c.command);
        const viewTitle = pkg.contributes.menus['view/title'].filter((m: any) => m.when.includes('view == notesExplorer')).map((m: any) => m.command);
        for (const c of cmds) {
            expect(declared, c).toContain(c);
            expect(ext, c).toContain(`registerCommand('${c}'`);
            expect(viewTitle, c).toContain(c);
        }
        const welcome = pkg.contributes.viewsWelcome.filter((w: any) => w.view === 'notesExplorer').map((w: any) => w.contents).join('\n');
        for (const c of [...welcome.matchAll(/command:([\w.]+)/g)].map(m => m[1])) {
            expect(declared, c).toContain(c);
            expect(ext, c).toContain(`registerCommand('${c}'`);
        }
        expect(welcome).toContain('command:fractal.openNotesRegistry');
        expect(welcome).toContain('command:fractal.createNotesRegistry');
    });
});
