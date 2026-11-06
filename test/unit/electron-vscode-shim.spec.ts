/**
 * spec 20261106-1312-electron-vscode-shim — TASK 1 (the vscode API shim of the desktop app, ADR-0013).
 *
 * AC-2: the shim behaves like VS Code for what the extension's Notes code relies on — Uri,
 *       workspace.fs, getConfiguration defaults / persistence, TextDocument applyEdit / save /
 *       onDidChangeTextDocument (fired BEFORE applyEdit resolves), globalState persistence; plus the
 *       real bundle (out/extension.js) activating on the shim, every vscode member it uses existing,
 *       and an md save from the Notes webview going through TextDocument → disk.
 * AC-3: the webview resource resolver serves only files inside the panel's roots (outside, '..',
 *       encoded '..', symlink escapes, missing, directories → null = 404); the panel session's request
 *       guard gives the panel document and resources to the panel only (never to sandboxed frames).
 * Desktop shell: a packaged app ignores the switches that change its code or profile.
 *
 * Node-side only (no browser). Imports the shim's TypeScript sources directly; the shim's npm
 * dependencies (vscode-uri, chokidar, jsonc-parser) are root devDependencies too, so the extension's
 * own `npm install` is enough to run this file (electron/node_modules is used first when present).
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
    createVscodeShim,
    createHeadlessHost,
    resolveResourceRequest,
    webviewResourcePath,
    contentTypeFor,
    cloneWebviewMessage,
    WEBVIEW_CSP_SOURCE,
    type ShimHost,
    type VscodeShim,
} from '../../electron/src/vscode-shim/index';
import { GUARDED_URL_PATTERNS, mayLoadInPanelSession } from '../../electron/src/main/request-guard';
import { resolveLaunchOptions } from '../../electron/src/main/launch-options';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SHIM_DIR = path.join(REPO_ROOT, 'electron', 'src', 'vscode-shim');
const BUNDLE_PATH = path.join(REPO_ROOT, 'out', 'extension.js');

function mkTmp(prefix = 'fx-shim-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}

/** A shim on the repo's real package.json (contributed defaults) with a temp userData folder. */
function makeShim(userDataDir: string, overrides: Partial<ShimHost> = {}): VscodeShim & { host: ReturnType<typeof createHeadlessHost> } {
    const host = createHeadlessHost(overrides);
    const shim = createVscodeShim({ extensionRoot: REPO_ROOT, userDataDir, host });
    return Object.assign(shim, { host });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('electron vscode shim — AC-2 (behaves like VS Code)', () => {
    test("AC-2 the shim runs on the extension's own install: every npm package it imports is a root devDependency (electron/package.json's range) and resolves from the repo root", () => {
        const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        const electronPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'electron', 'package.json'), 'utf8'));
        const declared: Record<string, string> = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const builtin = new Set<string>(require('module').builtinModules);
        const imported = new Set<string>();
        for (const f of fs.readdirSync(SHIM_DIR).filter((n) => n.endsWith('.ts'))) {
            // comments stripped: they mention require('vscode') (what the shim stands in for)
            const src = fs.readFileSync(path.join(SHIM_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            for (const m of src.matchAll(/(?:\bfrom\s+|\brequire\(\s*)['"]([^'"]+)['"]/g)) {
                const spec = m[1];
                if (spec.startsWith('.') || spec.startsWith('node:') || builtin.has(spec)) {
                    continue;
                }
                imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
            }
        }
        // the scan sees the shim's imports (and the shim never imports 'electron')
        expect([...imported].sort()).toEqual(['chokidar', 'jsonc-parser', 'vscode-uri']);
        for (const name of imported) {
            expect(declared[name], `${name} must be in the root package.json (same range as electron/package.json)`).toBe(electronPkg.dependencies[name]);
            // resolving from the repo root never looks into electron/node_modules
            let resolved = '';
            try {
                resolved = require.resolve(name, { paths: [REPO_ROOT] });
            } catch (err) {
                resolved = `not found: ${String(err).split('\n')[0]}`;
            }
            expect(resolved.startsWith(path.join(REPO_ROOT, 'node_modules') + path.sep), `${name} → ${resolved}`).toBe(true);
        }
    });

    test('AC-2 Uri: file / parse / joinPath / with / fsPath / toString and the webview resource form match VS Code', () => {
        const ud = mkTmp();
        const shim = makeShim(ud);
        try {
            const vscode = shim.api as any;
            const u = vscode.Uri.file('/Users/a b/c#d.md');
            expect(u.scheme).toBe('file');
            expect(u.path).toBe('/Users/a b/c#d.md');
            expect(u.fsPath).toBe('/Users/a b/c#d.md');
            expect(u.toString()).toBe('file:///Users/a%20b/c%23d.md');
            expect(u instanceof vscode.Uri).toBe(true);
            // joinPath = posix join on .path: normalizes '..', does not decode
            expect(vscode.Uri.joinPath(vscode.Uri.file('/a/b'), '..', 'c d', 'e.md').fsPath).toBe('/a/c d/e.md');
            expect(vscode.Uri.joinPath(vscode.Uri.file('/a/b'), 'x%20y.md').toString()).toBe('file:///a/b/x%2520y.md');
            // VS Code quirk relied on by the viewer export (Uri.file of a bare name)
            expect(vscode.Uri.file('a.pdf').path).toBe('/a.pdf');
            const p = vscode.Uri.parse('https://example.com/x/y?q=1#frag');
            expect([p.scheme, p.authority, p.path, p.query, p.fragment]).toEqual(['https', 'example.com', '/x/y', 'q=1', 'frag']);
            // with({ path }) keeps a trailing slash (sidePanelManager builds a dir base this way)
            expect(vscode.Uri.file('/notes/n1').with({ path: '/notes/n1/' }).path).toBe('/notes/n1/');

            // webview: VS Code's exact resource URL and CSP source (the webview code depends on them)
            const panel = vscode.window.createWebviewPanel('fractal.notes', 'Notes: n1', vscode.ViewColumn.One, { enableScripts: true });
            const w = panel.webview.asWebviewUri(vscode.Uri.file('/Users/a b/日本.png'));
            expect(w.toString()).toBe('https://file%2B.vscode-resource.vscode-cdn.net/Users/a%20b/%E6%97%A5%E6%9C%AC.png');
            expect(`${panel.webview.asWebviewUri(vscode.Uri.file('/x'))}/cmaps/`).toBe('https://file%2B.vscode-resource.vscode-cdn.net/x/cmaps/');
            const web = vscode.Uri.parse('https://example.com/a.png');
            expect(panel.webview.asWebviewUri(web)).toBe(web);
            expect(panel.webview.cspSource).toBe("'self' https://*.vscode-cdn.net");
            expect(WEBVIEW_CSP_SOURCE).toBe("'self' https://*.vscode-cdn.net");
            panel.dispose();
        } finally {
            shim.controller.dispose();
            rmrf(ud);
        }
    });

    test('AC-2 workspace.fs: readFile / writeFile (mkdirp) / stat / readDirectory / createDirectory / delete (+useTrash) / copy / rename', async () => {
        const tmp = mkTmp();
        const trashDir = path.join(tmp, 'trash');
        fs.mkdirSync(trashDir);
        const trashed: string[] = [];
        const shim = makeShim(path.join(tmp, 'ud'), {
            shell: {
                openExternal: async () => undefined,
                openPath: async () => '',
                showItemInFolder: () => undefined,
                trashItem: async (p: string) => {
                    trashed.push(p);
                    fs.renameSync(p, path.join(trashDir, path.basename(p)));
                },
            },
        });
        try {
            const vscode = shim.api as any;
            const wfs = vscode.workspace.fs;
            const file = vscode.Uri.file(path.join(tmp, 'deep', 'er', 'a.txt'));
            await wfs.writeFile(file, Buffer.from('héllo', 'utf8'));
            const bytes: Uint8Array = await wfs.readFile(file);
            expect(bytes).toBeInstanceOf(Uint8Array);
            expect(new TextDecoder().decode(bytes)).toBe('héllo');

            const st = await wfs.stat(file);
            expect(st.type).toBe(vscode.FileType.File);
            expect(st.size).toBe(Buffer.byteLength('héllo'));
            expect((await wfs.stat(vscode.Uri.file(path.join(tmp, 'deep')))).type).toBe(vscode.FileType.Directory);

            await wfs.createDirectory(vscode.Uri.file(path.join(tmp, 'm', 'n', 'o')));
            expect(fs.statSync(path.join(tmp, 'm', 'n', 'o')).isDirectory()).toBe(true);
            const listing = await wfs.readDirectory(vscode.Uri.file(path.join(tmp, 'deep', 'er')));
            expect(listing).toEqual([['a.txt', vscode.FileType.File]]);

            // missing file → FileSystemError FileNotFound (stat, readFile and delete)
            const missing = vscode.Uri.file(path.join(tmp, 'nope.txt'));
            await expect(wfs.stat(missing)).rejects.toMatchObject({ code: 'FileNotFound' });
            await expect(wfs.readFile(missing)).rejects.toMatchObject({ code: 'FileNotFound' });
            await expect(wfs.delete(missing)).rejects.toMatchObject({ code: 'FileNotFound' });

            // copy / rename: FileExists unless overwrite
            const b = vscode.Uri.file(path.join(tmp, 'b.txt'));
            await wfs.copy(file, b);
            await expect(wfs.copy(file, b)).rejects.toMatchObject({ code: 'FileExists' });
            await wfs.writeFile(b, Buffer.from('B'));
            await wfs.copy(file, b, { overwrite: true });
            expect(fs.readFileSync(b.fsPath, 'utf8')).toBe('héllo');
            const c = vscode.Uri.file(path.join(tmp, 'moved', 'c.txt'));
            await wfs.rename(b, c);
            expect(fs.existsSync(b.fsPath)).toBe(false);
            expect(fs.readFileSync(c.fsPath, 'utf8')).toBe('héllo');
            await wfs.writeFile(b, Buffer.from('B2'));
            await expect(wfs.rename(b, c)).rejects.toMatchObject({ code: 'FileExists' });
            await wfs.rename(b, c, { overwrite: true });
            expect(fs.readFileSync(c.fsPath, 'utf8')).toBe('B2');

            // delete: a non-empty folder needs recursive; useTrash goes through the injected trash
            const dir = vscode.Uri.file(path.join(tmp, 'deep'));
            await expect(wfs.delete(dir)).rejects.toBeTruthy();
            expect(fs.existsSync(dir.fsPath)).toBe(true);
            await wfs.delete(dir, { recursive: true });
            expect(fs.existsSync(dir.fsPath)).toBe(false);
            await wfs.delete(c, { useTrash: true });
            expect(trashed).toEqual([c.fsPath]);
            expect(fs.existsSync(c.fsPath)).toBe(false);
            expect(fs.readFileSync(path.join(trashDir, 'c.txt'), 'utf8')).toBe('B2');
        } finally {
            shim.controller.dispose();
            rmrf(tmp);
        }
    });

    test('AC-2 getConfiguration: contributed defaults beat the caller default, settings.json (JSONC) overrides, update persists and fires before resolving', async () => {
        const ud = mkTmp();
        fs.writeFileSync(
            path.join(ud, 'settings.json'),
            '{\n    // my comment\n    "fractal.theme": "dark",\n    "fractal.resourceRoots": ["/data"],\n}\n'
        );
        const shim = makeShim(ud);
        let shim2: ReturnType<typeof makeShim> | undefined;
        try {
            const vscode = shim.api as any;
            const cfg = vscode.workspace.getConfiguration('fractal');
            // package.json contributes.configuration default wins over the caller's default (VS Code)
            expect(cfg.get('fontSize', 99)).toBe(12);
            expect(cfg.get('imageMaxWidth', 1)).toBe(400);
            expect(cfg.get('viewerHtmlAllowScripts', false)).toBe(true);
            expect(cfg.get('notContributedKey', 'caller')).toBe('caller');
            expect(cfg.get('notContributedKey')).toBeUndefined();
            // user settings (JSONC: comment + trailing comma) override defaults
            expect(cfg.get('theme', 'auto')).toBe('dark');
            expect(vscode.workspace.getConfiguration().get('fractal.theme')).toBe('dark');
            expect(cfg.has('fontSize')).toBe(true);
            expect(cfg.inspect('theme')).toMatchObject({ key: 'fractal.theme', defaultValue: 'auto', globalValue: 'dark' });
            // returned arrays are copies
            const roots = cfg.get('resourceRoots', []);
            roots.push('/mutated');
            expect(vscode.workspace.getConfiguration('fractal').get('resourceRoots')).toEqual(['/data']);

            const events: Array<{ target: boolean; all: boolean; theme: boolean }> = [];
            let resolved = false;
            const sub = vscode.workspace.onDidChangeConfiguration((e: any) => {
                events.push({
                    target: e.affectsConfiguration('fractal.translateTargetLang'),
                    all: e.affectsConfiguration('fractal'),
                    theme: e.affectsConfiguration('fractal.theme'),
                });
                expect(resolved).toBe(false);
            });
            await cfg.update('translateTargetLang', 'fr', vscode.ConfigurationTarget.Global);
            resolved = true;
            sub.dispose();
            expect(events).toEqual([{ target: true, all: true, theme: false }]);
            // the snapshot taken before the update keeps the old value (VS Code), a new one sees 'fr'
            expect(cfg.get('translateTargetLang')).toBe('ja');
            expect(vscode.workspace.getConfiguration('fractal').get('translateTargetLang')).toBe('fr');
            const text = fs.readFileSync(path.join(ud, 'settings.json'), 'utf8');
            expect(text).toContain('// my comment');
            expect(text).toContain('"fractal.translateTargetLang": "fr"');

            // Workspace target without a workspace rejects (VS Code); undefined removes the key
            await expect(cfg.update('fontSize', 14, vscode.ConfigurationTarget.Workspace)).rejects.toThrow(/no workspace/);
            await vscode.workspace.getConfiguration('fractal').update('theme', undefined, true);
            expect(vscode.workspace.getConfiguration('fractal').get('theme')).toBe('auto');

            // persisted: a new shim on the same userData reads it back
            shim2 = makeShim(ud);
            const vscode2 = shim2.api as any;
            expect(vscode2.workspace.getConfiguration('fractal').get('translateTargetLang')).toBe('fr');
            expect(vscode2.workspace.getConfiguration('fractal').get('theme')).toBe('auto');
        } finally {
            shim.controller.dispose();
            shim2?.controller.dispose();
            rmrf(ud);
        }
    });

    test('AC-2 getConfiguration: an external edit of settings.json fires onDidChangeConfiguration; a broken file keeps the last good values', async () => {
        const ud = mkTmp();
        fs.writeFileSync(path.join(ud, 'settings.json'), '{ "fractal.fontSize": 13 }\n');
        const shim = makeShim(ud);
        try {
            const vscode = shim.api as any;
            const seen: boolean[] = [];
            vscode.workspace.onDidChangeConfiguration((e: any) => seen.push(e.affectsConfiguration('fractal.fontSize')));
            await sleep(300); // the settings watcher is ready
            fs.writeFileSync(path.join(ud, 'settings.json'), '{ "fractal.fontSize": 16 }\n');
            for (let i = 0; i < 50 && seen.length === 0; i++) {
                await sleep(100);
            }
            expect(seen).toEqual([true]);
            expect(vscode.workspace.getConfiguration('fractal').get('fontSize')).toBe(16);
            fs.writeFileSync(path.join(ud, 'settings.json'), '{ "fractal.fontSize": 18, \n');
            await sleep(800);
            expect(vscode.workspace.getConfiguration('fractal').get('fontSize')).toBe(16);
            await expect(vscode.workspace.getConfiguration('fractal').update('theme', 'dark', true)).rejects.toThrow(/correct errors/);
            expect(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).toBe('{ "fractal.fontSize": 18, \n');
        } finally {
            shim.controller.dispose();
            rmrf(ud);
        }
    });

    test('AC-2 TextDocument: open / getText / positionAt / lineAt; applyEdit fires onDidChangeTextDocument BEFORE it resolves; save writes and clears isDirty', async () => {
        const tmp = mkTmp();
        const shim = makeShim(path.join(tmp, 'ud'));
        try {
            const vscode = shim.api as any;
            const mdPath = path.join(tmp, 'page.md');
            fs.writeFileSync(mdPath, '# Title\n\nline two\n');
            const uri = vscode.Uri.file(mdPath);
            const [doc, again] = await Promise.all([vscode.workspace.openTextDocument(uri), vscode.workspace.openTextDocument(uri)]);
            expect(again).toBe(doc);
            expect(await vscode.workspace.openTextDocument(mdPath)).toBe(doc);
            expect(vscode.workspace.textDocuments).toContain(doc);
            expect(doc.uri.toString()).toBe(uri.toString());
            expect(doc.fileName).toBe(mdPath);
            expect(doc.languageId).toBe('markdown');
            expect(doc.isDirty).toBe(false);
            expect(doc.isClosed).toBe(false);
            expect(doc.lineCount).toBe(4);
            expect(doc.lineAt(2).text).toBe('line two');
            expect(doc.lineAt(1).isEmptyOrWhitespace).toBe(true);
            expect(doc.positionAt(10)).toMatchObject({ line: 2, character: 1 });
            expect(doc.offsetAt(new vscode.Position(2, 1))).toBe(10);
            expect(doc.positionAt(10_000)).toMatchObject({ line: 3, character: 0 });
            expect(doc.getText(new vscode.Range(0, 2, 0, 7))).toBe('Title');

            // the managers' pattern (sidePanelManager / notesMdMainManager): the change event must arrive
            // while _isApplyingEdit is still true, i.e. before `await applyEdit` returns
            let isApplyingEdit = false;
            const order: string[] = [];
            const events: any[] = [];
            const sub = vscode.workspace.onDidChangeTextDocument((e: any) => {
                order.push('event');
                events.push({ applying: isApplyingEdit, n: e.contentChanges.length, text: e.document.getText(), same: e.document === doc });
            });
            const version0 = doc.version;
            isApplyingEdit = true;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), '# New\n\nbody\n');
            const pending = vscode.workspace.applyEdit(edit);
            order.push('returned');
            expect(await pending).toBe(true);
            isApplyingEdit = false;
            expect(order).toEqual(['event', 'returned']);
            expect(events).toEqual([{ applying: true, n: 1, text: '# New\n\nbody\n', same: true }]);
            expect(doc.getText()).toBe('# New\n\nbody\n');
            expect(doc.isDirty).toBe(true);
            expect(doc.version).toBeGreaterThan(version0);
            expect(fs.readFileSync(mdPath, 'utf8')).toBe('# Title\n\nline two\n'); // not written until save

            // full replace with positionAt(0)..positionAt(len) (external-change reconcile path)
            const e2 = new vscode.WorkspaceEdit();
            e2.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), '# Ext\n');
            expect(await vscode.workspace.applyEdit(e2)).toBe(true);
            expect(doc.getText()).toBe('# Ext\n');

            const saved: unknown[] = [];
            vscode.workspace.onDidSaveTextDocument((d: unknown) => saved.push(d));
            expect(await doc.save()).toBe(true);
            expect(fs.readFileSync(mdPath, 'utf8')).toBe('# Ext\n');
            expect(doc.isDirty).toBe(false);
            expect(saved).toEqual([doc]);

            // overlapping edits are rejected without changing anything
            const bad = new vscode.WorkspaceEdit();
            bad.replace(doc.uri, new vscode.Range(0, 0, 0, 4), 'a');
            bad.replace(doc.uri, new vscode.Range(0, 2, 0, 5), 'b');
            expect(await vscode.workspace.applyEdit(bad)).toBe(false);
            expect(doc.getText()).toBe('# Ext\n');
            sub.dispose();
            expect(events.length).toBe(2);

            // a missing file rejects
            await expect(vscode.workspace.openTextDocument(vscode.Uri.file(path.join(tmp, 'missing.md')))).rejects.toThrow(/cannot open/);
        } finally {
            shim.controller.dispose();
            rmrf(tmp);
        }
    });

    test('AC-2 TextDocument: CRLF documents keep CRLF (inserted line breaks converted), a UTF-8 BOM is hidden and written back, applyEdit opens unopened files', async () => {
        const tmp = mkTmp();
        const shim = makeShim(path.join(tmp, 'ud'));
        try {
            const vscode = shim.api as any;
            const crlf = path.join(tmp, 'crlf.md');
            fs.writeFileSync(crlf, 'a\r\nb\r\n');
            const d1 = await vscode.workspace.openTextDocument(vscode.Uri.file(crlf));
            expect(d1.eol).toBe(vscode.EndOfLine.CRLF);
            expect(d1.getText()).toBe('a\r\nb\r\n');
            const e1 = new vscode.WorkspaceEdit();
            e1.replace(d1.uri, new vscode.Range(0, 0, d1.lineCount, 0), 'x\ny\n');
            await vscode.workspace.applyEdit(e1);
            expect(d1.getText()).toBe('x\r\ny\r\n');
            await d1.save();
            expect(fs.readFileSync(crlf, 'utf8')).toBe('x\r\ny\r\n');

            const bom = path.join(tmp, 'bom.md');
            fs.writeFileSync(bom, '\uFEFF# B\n');
            const d2 = await vscode.workspace.openTextDocument(vscode.Uri.file(bom));
            expect(d2.getText()).toBe('# B\n');
            const e2 = new vscode.WorkspaceEdit();
            e2.insert(d2.uri, new vscode.Position(1, 0), 'more\n');
            await vscode.workspace.applyEdit(e2);
            await d2.save();
            expect(fs.readFileSync(bom, 'utf8')).toBe('\uFEFF# B\nmore\n');

            // applyEdit on a document nobody opened yet: opens it, event still before resolution
            const lazy = path.join(tmp, 'lazy.md');
            fs.writeFileSync(lazy, 'old\n');
            let fired = false;
            vscode.workspace.onDidChangeTextDocument(() => {
                fired = true;
            });
            const e3 = new vscode.WorkspaceEdit();
            e3.replace(vscode.Uri.file(lazy), new vscode.Range(0, 0, 1, 0), 'new\n');
            const p = vscode.workspace.applyEdit(e3).then((ok: boolean) => ({ ok, firedBefore: fired }));
            expect(await p).toEqual({ ok: true, firedBefore: true });
        } finally {
            shim.controller.dispose();
            rmrf(tmp);
        }
    });

    test('AC-2 TextDocument: re-opening a clean document whose file changed on disk shows the new content (a dirty one keeps its buffer)', async () => {
        const tmp = mkTmp();
        const shim = makeShim(path.join(tmp, 'ud'));
        try {
            const vscode = shim.api as any;
            const p = path.join(tmp, 'n.md');
            fs.writeFileSync(p, 'v1\n');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
            const changes: string[] = [];
            vscode.workspace.onDidChangeTextDocument((e: any) => changes.push(e.document.getText()));
            await sleep(20);
            fs.writeFileSync(p, 'v2 from outside\n');
            expect(await vscode.workspace.openTextDocument(vscode.Uri.file(p))).toBe(doc);
            expect(doc.getText()).toBe('v2 from outside\n');
            expect(doc.isDirty).toBe(false);
            expect(changes).toEqual(['v2 from outside\n']);
            // saving does not count as an external change
            const e1 = new vscode.WorkspaceEdit();
            e1.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), 'saved by me\n');
            await vscode.workspace.applyEdit(e1);
            await doc.save();
            await vscode.workspace.openTextDocument(vscode.Uri.file(p));
            expect(doc.getText()).toBe('saved by me\n');
            // a dirty buffer is never replaced from disk
            const e2 = new vscode.WorkspaceEdit();
            e2.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), 'unsaved\n');
            await vscode.workspace.applyEdit(e2);
            await sleep(20);
            fs.writeFileSync(p, 'v3 from outside\n');
            await vscode.workspace.openTextDocument(vscode.Uri.file(p));
            expect(doc.getText()).toBe('unsaved\n');
            expect(doc.isDirty).toBe(true);
        } finally {
            shim.controller.dispose();
            rmrf(tmp);
        }
    });

    test('AC-2 globalState: get / update / keys persist to userData/globalState.json and survive a restart; a corrupt file is kept aside', async () => {
        const ud = mkTmp();
        const s1 = makeShim(ud);
        let s2: ReturnType<typeof makeShim> | undefined;
        let s3: ReturnType<typeof makeShim> | undefined;
        try {
            const gs = s1.context.globalState;
            expect(gs.get('notesRegistries', ['default'])).toEqual(['default']);
            const value = ['/a/default.fractal'];
            await gs.update('notesRegistries', value);
            value.push('/mutated-after-update'); // object values are stored as a JSON copy
            await gs.update('activeNotesRegistry', '/a/default.fractal');
            await gs.update('notesDefaultFractalCreated', true);
            await gs.update('temp', 1);
            await gs.update('temp', undefined); // undefined removes the key
            expect(gs.get('notesRegistries')).toEqual(['/a/default.fractal']);
            expect([...gs.keys()].sort()).toEqual(['activeNotesRegistry', 'notesDefaultFractalCreated', 'notesRegistries']);
            const onDisk = JSON.parse(fs.readFileSync(path.join(ud, 'globalState.json'), 'utf8'));
            expect(onDisk).toEqual({
                notesRegistries: ['/a/default.fractal'],
                activeNotesRegistry: '/a/default.fractal',
                notesDefaultFractalCreated: true,
            });
            s1.controller.dispose();

            s2 = makeShim(ud);
            expect(s2.context.globalState.get('notesRegistries')).toEqual(['/a/default.fractal']);
            expect(s2.context.globalState.get('notesDefaultFractalCreated')).toBe(true);
            expect(s2.context.globalState.get('temp', 'gone')).toBe('gone');
            s2.controller.dispose();

            fs.writeFileSync(path.join(ud, 'globalState.json'), '{ broken');
            s3 = makeShim(ud);
            expect(s3.context.globalState.keys()).toEqual([]);
            expect(fs.readdirSync(ud).some((n) => n.startsWith('globalState.json.corrupt-'))).toBe(true);
        } finally {
            s1.controller.dispose();
            s2?.controller.dispose();
            s3?.controller.dispose();
            rmrf(ud);
        }
    });

    test('AC-2 events / commands / messages: EventEmitter order + error isolation, cancellation, registerCommand / executeCommand, built-ins, show*Message returns the clicked item', async () => {
        const ud = mkTmp();
        const asked: any[] = [];
        const shim = makeShim(ud, {
            ui: {
                showMessage: async (req) => {
                    asked.push(req);
                    return req.items.length > 1 ? 1 : undefined;
                },
                showOpenDialog: async () => ['/picked/a', '/picked/b'],
                showSaveDialog: async () => '/picked/out.png',
                showInputBox: async (req) => ((await req.validate('bad')) ? 'rejected' : 'ok'),
                showQuickPick: async (req) => [req.items.findIndex((i) => !i.separator && i.label === 'two')],
            },
        });
        try {
            const vscode = shim.api as any;
            const em = new vscode.EventEmitter();
            const got: string[] = [];
            em.event(() => got.push('a'));
            em.event(() => {
                throw new Error('listener failure');
            });
            const disposables: any[] = [];
            em.event((x: string) => got.push('c:' + x), undefined, disposables);
            em.fire('1');
            expect(got).toEqual(['a', 'c:1']);
            disposables.forEach((d) => d.dispose());
            em.fire('2');
            expect(got).toEqual(['a', 'c:1', 'a']);

            const cts = new vscode.CancellationTokenSource();
            let cancelled = 0;
            cts.token.onCancellationRequested(() => cancelled++);
            cts.cancel();
            cts.cancel();
            expect(cts.token.isCancellationRequested).toBe(true);
            expect(cancelled).toBe(1);

            const d = vscode.commands.registerCommand('fractal.test', (a: number, b: number) => a + b);
            expect(() => vscode.commands.registerCommand('fractal.test', () => 0)).toThrow(/already exists/);
            expect(await vscode.commands.executeCommand('fractal.test', 2, 3)).toBe(5);
            d.dispose();
            await expect(vscode.commands.executeCommand('fractal.test', 1, 1)).rejects.toThrow(/not found/);
            await expect(vscode.commands.executeCommand('no.such.command')).rejects.toThrow("command 'no.such.command' not found");
            expect(await vscode.commands.executeCommand('setContext', 'fractal.hasNotesRegistry', true)).toBeUndefined();
            expect(shim.controller.contextKeys().get('fractal.hasNotesRegistry')).toBe(true);
            expect(await vscode.commands.executeCommand('workbench.action.openSettings', 'fractal.resourceRoots')).toBeUndefined();
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file('/x/y.md'));
            expect(shim.host.records.showItemInFolder).toEqual(['/x/y.md']);
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file('/x/y.png'));
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file('/x/z.md'), 'default');
            expect(shim.host.records.openPath).toEqual(['/x/y.png', '/x/z.md']);

            // env.openExternal: http/https/mailto → browser, file → OS app, other schemes refused
            expect(await vscode.env.openExternal(vscode.Uri.parse('https://example.com/a b?x=1'))).toBe(true);
            expect(await vscode.env.openExternal(vscode.Uri.parse('mailto:a@b.c'))).toBe(true);
            expect(await vscode.env.openExternal(vscode.Uri.file('/x/doc.pdf'))).toBe(true);
            expect(await vscode.env.openExternal(vscode.Uri.parse('javascript:alert(1)'))).toBe(false);
            expect(await vscode.env.openExternal(vscode.Uri.parse('vscode://foo'))).toBe(false);
            expect(shim.host.records.openExternal).toEqual(['https://example.com/a%20b?x=1', 'mailto:a@b.c']);
            expect(shim.host.records.openPath).toContain('/x/doc.pdf');
            await vscode.env.clipboard.writeText('copied');
            expect(await vscode.env.clipboard.readText()).toBe('copied');
            expect(vscode.env.language).toBe('en');
            expect(vscode.env.remoteName).toBeUndefined();

            // messages: items come back as the same object; options object vs first item
            const item = { title: 'Remove from list' };
            expect(await vscode.window.showInformationMessage('m1', 'Keep', item)).toBe(item);
            expect(await vscode.window.showWarningMessage('m2', { modal: true, detail: 'd' }, 'Proceed', 'Other')).toBe('Other');
            expect(await vscode.window.showErrorMessage('m3')).toBeUndefined();
            expect(asked.map((r) => [r.severity, r.modal, r.detail, r.items.map((i: any) => i.title)])).toEqual([
                ['info', false, undefined, ['Keep', 'Remove from list']],
                ['warning', true, 'd', ['Proceed', 'Other']],
                ['error', false, undefined, []],
            ]);
            // dialogs / input / quick pick map back to Uris and the original item objects
            const opened = await vscode.window.showOpenDialog({ canSelectMany: true });
            expect(opened.map((u: any) => u.fsPath)).toEqual(['/picked/a', '/picked/b']);
            expect((await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('x.png') })).fsPath).toBe('/picked/out.png');
            expect(await vscode.window.showInputBox({ validateInput: (v: string) => (v === 'bad' ? 'no' : null) })).toBe('rejected');
            const items = [{ label: 'g', kind: vscode.QuickPickItemKind.Separator }, { label: 'one' }, { label: 'two', folderPath: '/2' }];
            expect(await vscode.window.showQuickPick(items, { placeHolder: 'p' })).toBe(items[2]);
            // withProgress runs the task synchronously and returns its result
            let ran = false;
            const r = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 't' }, async (progress: any) => {
                ran = true;
                progress.report({ message: 'x' });
                return 42;
            });
            expect(ran).toBe(true);
            expect(await r).toBe(42);

            // a failing UI never rejects into the extension: it reads as "dismissed" (VS Code never rejects these)
            const fail = () => {
                throw new Error('ui broke');
            };
            const broken = makeShim(path.join(ud, 'broken'), {
                log: { info: () => undefined, warn: () => undefined, error: () => undefined },
                ui: { showMessage: fail, showOpenDialog: fail, showSaveDialog: fail, showInputBox: fail, showQuickPick: fail } as unknown as ShimHost['ui'],
            });
            try {
                const bvs = broken.api as any;
                expect(await bvs.window.showOpenDialog({})).toBeUndefined();
                expect(await bvs.window.showSaveDialog({})).toBeUndefined();
                expect(await bvs.window.showInputBox({})).toBeUndefined();
                expect(await bvs.window.showQuickPick(['a', 'b'])).toBeUndefined();
                expect(await bvs.window.showErrorMessage('m', 'A')).toBeUndefined();
            } finally {
                broken.controller.dispose();
            }
        } finally {
            shim.controller.dispose();
            rmrf(ud);
        }
    });

    test('AC-2 webview panel: messages wait for contentReady, html no-op on same string, onDidDispose once, roots include app assets, payloads cloned like VS Code', async () => {
        const ud = mkTmp();
        const shim = makeShim(ud);
        try {
            const vscode = shim.api as any;
            const panel = vscode.window.createWebviewPanel('fractal.notes', 'Notes: n1', vscode.ViewColumn.One, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file('/notes/n1')],
            });
            const rec = shim.host.records.panels[0];
            expect(rec.init.viewType).toBe('fractal.notes');
            const ctl = panel.controller ?? rec.init.controller;
            panel.webview.html = '<html>1</html>';
            panel.webview.html = '<html>1</html>'; // identical → no reload
            expect(rec.loads).toEqual([1]);
            expect(ctl.html).toBe('<html>1</html>');
            const bytes = new Uint8Array([1, 2, 3]);
            const payload: any = { type: 'm1', drop: undefined, fn: () => 1, buf: Buffer.from('ab'), bytes, date: new Date(0) };
            expect(await panel.webview.postMessage(payload)).toBe(true);
            payload.type = 'mutated-after-post';
            await panel.webview.postMessage({ type: 'm2' });
            expect(rec.delivered).toEqual([]); // queued until the page is ready
            ctl.contentReady(0); // a stale generation does not flush
            expect(rec.delivered).toEqual([]);
            ctl.contentReady(1);
            expect(rec.delivered.map((m: any) => m.type)).toEqual(['m1', 'm2']);
            const m1: any = rec.delivered[0];
            expect('drop' in m1).toBe(false);
            expect('fn' in m1).toBe(false);
            expect(m1.buf).toEqual({ type: 'Buffer', data: [97, 98] });
            expect(m1.bytes).toBeInstanceOf(Uint8Array);
            expect(Array.from(m1.bytes)).toEqual([1, 2, 3]);
            expect(m1.date).toBe('1970-01-01T00:00:00.000Z');
            await panel.webview.postMessage({ type: 'm3' });
            expect(rec.delivered.length).toBe(3); // delivered directly once ready
            panel.webview.html = '<html>2</html>';
            await panel.webview.postMessage({ type: 'm4' });
            expect(rec.delivered.length).toBe(3);
            ctl.contentReady(2);
            expect(rec.delivered.length).toBe(4);

            // webview → host: typed arrays survive, handlers tracked for draining
            const received: any[] = [];
            let resolveHandler!: () => void;
            panel.webview.onDidReceiveMessage((m: any) => {
                received.push(m);
                return new Promise<void>((r) => {
                    resolveHandler = r;
                });
            });
            ctl.receiveMessage({ type: 'dropFilesImport', items: [{ kind: 'file', bytes: new Uint8Array([9, 8]) }] });
            expect(received[0].items[0].bytes).toBeInstanceOf(Uint8Array);
            let drained = false;
            const drain = ctl.drainMessageHandlers(2000).then(() => {
                drained = true;
            });
            await sleep(20);
            expect(drained).toBe(false);
            resolveHandler();
            await drain;
            expect(drained).toBe(true);

            // localResourceRoots + the app's read-only assets; the options setter does not reload
            expect(ctl.resourceRoots()).toEqual([
                '/notes/n1',
                path.join(REPO_ROOT, 'out', 'webview'),
                path.join(REPO_ROOT, 'media'),
                path.join(REPO_ROOT, 'vendor'),
            ]);
            panel.webview.options = { ...panel.webview.options, localResourceRoots: [...panel.webview.options.localResourceRoots, vscode.Uri.file('/other')] };
            expect(ctl.resourceRoots()).toContain('/other');
            expect(rec.loads).toEqual([1, 2]);
            expect(panel.notesFolder()).toBe('/notes/n1');

            const viewStates: boolean[] = [];
            panel.onDidChangeViewState((e: any) => viewStates.push(e.webviewPanel.active));
            ctl.setViewState({ active: false, visible: true });
            expect(panel.active).toBe(false);
            expect(viewStates).toEqual([false]);

            const disposed: string[] = [];
            panel.onDidDispose(() => disposed.push('first'));
            panel.onDidDispose(() => disposed.push('second'));
            const webview = panel.webview;
            ctl.disposeByUser();
            panel.dispose();
            expect(disposed).toEqual(['first', 'second']);
            expect(rec.destroyed).toBe(true);
            expect(await webview.postMessage({ type: 'late' })).toBe(false);
            expect(() => panel.webview).toThrow('Webview is disposed');
            expect(() => {
                webview.html = 'x';
            }).toThrow('Webview is disposed');
            expect(shim.controller.panels()).toEqual([]);

            // cloneWebviewMessage on its own (JSON semantics with binary kept)
            expect(cloneWebviewMessage({ a: [1, undefined], b: new ArrayBuffer(2) })).toEqual({ a: [1, null], b: new ArrayBuffer(2) });
        } finally {
            shim.controller.dispose();
            rmrf(ud);
        }
    });

    test("AC-2 webview panel: notesFolder() is the panel's note folder, also when the note is named like the app's own media / vendor folder or a settings resource root", async () => {
        const tmp = mkTmp();
        const shim = makeShim(path.join(tmp, 'ud'));
        try {
            const vscode = shim.api as any;
            const ext = vscode.Uri.file(REPO_ROOT);
            // the roots the extension gives a Notes panel (notesEditorProvider buildLocalResourceRoots):
            // [<ext>/media, <ext>/vendor, folder, ...fractal.resourceRoots (default: the home folder)]
            const createNotesPanel = (folder: string, roots: string[]) =>
                vscode.window.createWebviewPanel('fractal.notes', `Notes: ${path.basename(folder)}`, vscode.ViewColumn.One, {
                    enableScripts: true,
                    localResourceRoots: roots.map((r) => vscode.Uri.file(r)),
                });
            for (const name of ['media', 'vendor']) {
                const folder = path.join(tmp, 'notes', name);
                const panel = createNotesPanel(folder, [vscode.Uri.joinPath(ext, 'media').fsPath, vscode.Uri.joinPath(ext, 'vendor').fsPath, folder, os.homedir()]);
                expect(panel.notesFolder(), name).toBe(folder);
                panel.dispose();
            }

            // fractal.openNotesFolder(folder) binds the panel it creates (later, asynchronously) to that folder,
            // even when a settings root with the same name comes first
            const asked = path.join(tmp, 'a', 'data');
            const settingsRoot = path.join(tmp, 'b', 'data');
            fs.mkdirSync(asked, { recursive: true });
            vscode.commands.registerCommand('fractal.openNotesFolder', (folder: string) => {
                setTimeout(() => createNotesPanel(folder, [path.join(REPO_ROOT, 'media'), settingsRoot, folder]), 20);
            });
            const opened = (await shim.controller.openNotesFolder(asked, 3000)) as any;
            expect(opened?.notesFolder()).toBe(asked);
            // the folder is fixed at creation (later root changes do not move it)
            opened.webview.options = { ...opened.webview.options, localResourceRoots: [vscode.Uri.file(path.join(tmp, 'c', 'data'))] };
            expect(opened.notesFolder()).toBe(asked);

            // other panels, other titles: no note folder
            const viewer = vscode.window.createWebviewPanel('fractal.viewer', 'Notes: media', vscode.ViewColumn.One, {
                localResourceRoots: [vscode.Uri.file(path.join(tmp, 'x', 'media'))],
            });
            expect(viewer.notesFolder()).toBeUndefined();
            expect(createNotesPanel(path.join(tmp, 'y'), [REPO_ROOT]).notesFolder()).toBeUndefined();
        } finally {
            shim.controller.dispose();
            rmrf(tmp);
        }
    });

    test('AC-2 bundle coverage: every vscode API member out/extension.js uses exists on the shim', () => {
        expect(fs.existsSync(BUNDLE_PATH), 'out/extension.js is missing — run `npm run compile` at the repo root').toBe(true);
        const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
        // module-level bindings `X=__toESM(require("vscode"))` are scanned over the whole bundle;
        // a local `let r=require("vscode")` only in the few statements after it (short minified names
        // are reused by unrelated locals elsewhere, e.g. an S3 upload result's `r.Location`)
        const sources: Array<{ binding: string; text: string }> = [];
        for (const m of bundle.matchAll(/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(require\("vscode"\)\)/g)) {
            sources.push({ binding: m[1], text: bundle });
        }
        const moduleBindings = sources.length;
        for (const m of bundle.matchAll(/(?:let|var|const)\s+([A-Za-z_$][\w$]*)=require\("vscode"\)/g)) {
            sources.push({ binding: m[1], text: bundle.slice(m.index!, m.index! + 400) });
        }
        expect(moduleBindings, 'no require("vscode") bindings found — the bundle format changed').toBeGreaterThan(10);

        // the vscode API surface (@types/vscode), comments stripped so braces balance
        const dtsPath = require.resolve('@types/vscode/index.d.ts', { paths: [REPO_ROOT] });
        const dts = fs.readFileSync(dtsPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const blockAfter = (start: number): string => {
            const open = dts.indexOf('{', start);
            let depth = 0;
            for (let i = open; i < dts.length; i++) {
                if (dts[i] === '{') depth++;
                else if (dts[i] === '}' && --depth === 0) return dts.slice(open + 1, i);
            }
            return '';
        };
        const namespaces = new Map<string, Set<string>>();
        for (const m of dts.matchAll(/export namespace (\w+) \{/g)) {
            const body = blockAfter(m.index!);
            namespaces.set(m[1], new Set([...body.matchAll(/export (?:function|let|const) (\w+)/g)].map((x) => x[1])));
        }
        const classes = new Map<string, Set<string>>();
        for (const m of dts.matchAll(/export class (\w+)/g)) {
            const body = blockAfter(m.index!);
            classes.set(m[1], new Set([...body.matchAll(/static (?:readonly )?(\w+)/g)].map((x) => x[1])));
        }
        const enums = new Map<string, Set<string>>();
        for (const m of dts.matchAll(/export enum (\w+)/g)) {
            const body = blockAfter(m.index!);
            enums.set(m[1], new Set([...body.matchAll(/(\w+)\s*=/g)].map((x) => x[1])));
        }
        expect(namespaces.get('window')?.has('createWebviewPanel')).toBe(true);

        const ud = mkTmp();
        const shim = makeShim(ud);
        const vscode = shim.api as any;
        const has = (obj: unknown, key: string) => !!obj && (typeof obj === 'object' || typeof obj === 'function') && key in (obj as object);
        const used = new Set<string>();
        const missing: string[] = [];
        try {
            for (const { binding: b, text } of sources) {
                const re = new RegExp(`(?<![\\w$.])${b.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*))?(?:\\.([A-Za-z_$][\\w$]*))?`, 'g');
                for (const m of text.matchAll(re)) {
                    const [, first, second, third] = m;
                    // `x.Name.member` where member is not part of that vscode namespace / class / enum is an
                    // unrelated local that happens to share the minified name — not a vscode use
                    const known = namespaces.get(first) ?? classes.get(first) ?? enums.get(first);
                    if (known && second && !known.has(second) && !(classes.has(first) && second === 'prototype')) {
                        continue;
                    }
                    if (namespaces.has(first)) {
                        used.add(first);
                        if (!has(vscode, first)) missing.push(first);
                        if (second && namespaces.get(first)!.has(second)) {
                            // `in`: members whose value is legitimately undefined (activeTextEditor, remoteName…) still count
                            used.add(`${first}.${second}`);
                            if (!has(vscode[first], second)) missing.push(`${first}.${second}`);
                            if (third && ((first === 'workspace' && second === 'fs') || (first === 'env' && second === 'clipboard'))) {
                                used.add(`${first}.${second}.${third}`);
                                if (typeof vscode[first]?.[second]?.[third] !== 'function') missing.push(`${first}.${second}.${third}`);
                            }
                        }
                    } else if (classes.has(first)) {
                        used.add(first);
                        if (typeof vscode[first] !== 'function') missing.push(first);
                        if (second && classes.get(first)!.has(second)) {
                            used.add(`${first}.${second}`);
                            if (!has(vscode[first], second)) missing.push(`${first}.${second}`);
                        }
                    } else if (enums.has(first)) {
                        used.add(first);
                        if (!has(vscode, first)) missing.push(first);
                        if (second && enums.get(first)!.has(second)) {
                            used.add(`${first}.${second}`);
                            if (!has(vscode[first], second)) missing.push(`${first}.${second}`);
                        }
                    }
                }
            }
        } finally {
            shim.controller.dispose();
            rmrf(ud);
        }
        // the scan really sees the Notes surface (guards against a vacuous pass)
        for (const k of ['window.createWebviewPanel', 'workspace.applyEdit', 'workspace.openTextDocument', 'workspace.fs.delete', 'env.clipboard.writeText', 'commands.registerCommand', 'TreeItem', 'Uri.joinPath', 'ViewColumn.One']) {
            expect(used.has(k), `scanner did not find ${k}`).toBe(true);
        }
        expect([...new Set(missing)].sort()).toEqual([]);
        // own properties (esbuild __toESM copies only own property names)
        for (const ns of [...used].filter((k) => !k.includes('.'))) {
            expect(Object.prototype.hasOwnProperty.call(vscode, ns), `${ns} must be an own property`).toBe(true);
        }
    });

    test('AC-2 bundle activation: out/extension.js activates on the shim, opens a Notes panel, and an md save from the webview reaches the disk through TextDocument (child process, temp HOME)', async () => {
        test.setTimeout(120000);
        expect(fs.existsSync(BUNDLE_PATH), 'out/extension.js is missing — run `npm run compile` at the repo root').toBe(true);
        expect(fs.existsSync(path.join(REPO_ROOT, 'out', 'webview', 'editor.js')), 'out/webview is missing — run `npm run compile`').toBe(true);
        const tmp = mkTmp('fx-shim-boot-');
        try {
            const home = path.join(tmp, 'home');
            const note = path.join(tmp, 'notes', 'n1');
            fs.mkdirSync(home, { recursive: true });
            fs.mkdirSync(note, { recursive: true });
            // bundle the shim (TypeScript) for a plain Node child process
            const entry = path.join(tmp, 'entry.ts');
            fs.writeFileSync(
                entry,
                `export { bootExtension } from ${JSON.stringify(path.join(SHIM_DIR, 'boot'))};\n` +
                    `export { createHeadlessHost } from ${JSON.stringify(path.join(SHIM_DIR, 'adapters'))};\n`
            );
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const esbuild = require('esbuild');
            esbuild.buildSync({
                entryPoints: [entry],
                outfile: path.join(tmp, 'shim.js'),
                bundle: true,
                platform: 'node',
                format: 'cjs',
                target: 'node20',
                external: ['electron'],
                // jsonc-parser's UMD build requires its parts through a factory argument esbuild cannot follow
                mainFields: ['module', 'main'],
                logLevel: 'silent',
            });
            const driver = path.join(tmp, 'driver.js');
            fs.writeFileSync(driver, DRIVER_SOURCE);
            const out = execFileSync(process.execPath, [driver, path.join(tmp, 'shim.js'), REPO_ROOT, path.join(tmp, 'userData'), note], {
                env: { ...process.env, HOME: home },
                encoding: 'utf8',
                timeout: 90000,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const line = out.split('\n').find((l) => l.startsWith('RESULT '));
            expect(line, `driver output:\n${out}`).toBeTruthy();
            const r = JSON.parse(line!.slice('RESULT '.length));
            expect(r.fatal).toBeUndefined();
            expect(r.errors).toEqual([]);
            expect(r.homedir).toBe(home);
            expect(r.fractalCommands).toEqual(expect.arrayContaining(['fractal.openNotesFolder', 'fractal.newNote', 'fractal.addNotesFolder', 'fractal.toggleSidebar']));
            expect(r.treeViews).toEqual(['notesExplorer', 'notesLists']);
            expect(r.customEditors).toEqual(expect.arrayContaining(['fractal.editor', 'fractal.outliner']));
            // ~/.fractal/default.fractal is created under the temp HOME (never the real one)
            expect(r.defaultFractal).toBe(true);
            // the Notes panel
            expect(r.panel.viewType).toBe('fractal.notes');
            expect(r.panel.title).toBe('Notes: n1');
            expect(r.panel.folder).toBe(note);
            expect(r.panel.loads).toEqual([1]);
            expect(r.panel.htmlHasBridge).toBe(true);
            expect(r.panel.htmlUsesResourceHost).toBe(true);
            expect(r.panel.roots).toEqual(expect.arrayContaining([note, home, path.join(REPO_ROOT, 'out', 'webview')]));
            expect(r.queuedBeforeReady).toBe(0);
            expect(r.deliveredAfterReady).toContain('translateLangSelected');
            expect(r.noteFiles).toEqual(expect.arrayContaining(['outline.note']));
            expect(r.noteFiles.some((n: string) => n.endsWith('.out'))).toBe(true);
            // webview → host: create an md page, then the md editor's auto-save (TextDocument path)
            expect(r.md.created).toBe(true);
            expect(r.md.openedAsTextDocument).toBe(true);
            expect(r.md.disk).toBe('# Page A\n\nhello from the shim\n');
            expect(r.md.docText).toBe('# Page A\n\nhello from the shim\n');
            expect(r.md.docDirty).toBe(false);
            // an external edit (e.g. an AI CLI) is picked up by the watchers and sent to the webview
            expect(r.md.externalUpdate).toBe('# Page A\n\nedited outside\n');
            // createFileSystemWatcher(RelativePattern(note, '*.out')) reports a .out created from outside
            expect(r.outWatcherRefresh).toBe(true);
            // a note folder named "media" (the extension lists <ext>/media first in the panel roots) is that note
            const mediaNote = path.join(tmp, 'notes', 'media');
            expect(r.mediaNote).toMatchObject({ opened: true, title: 'Notes: media', folder: mediaNote });
            expect(r.mediaNote.files).toContain('outline.note');
            expect(fs.existsSync(path.join(REPO_ROOT, 'media', 'outline.note'))).toBe(false);
        } finally {
            rmrf(tmp);
        }
    });
});

/** Runs in a child process (HOME = temp): boots the real bundle on the shim with a headless host. */
const DRIVER_SOURCE = String.raw`
const fs = require('fs'); const os = require('os'); const path = require('path');
const [shimBundle, repoRoot, userDataDir, note] = process.argv.slice(2);
const { bootExtension, createHeadlessHost } = require(shimBundle);
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); } return fn(); }
(async () => {
  const host = createHeadlessHost({ log: { info() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) } });
  const ext = await bootExtension({ extensionRoot: repoRoot, userDataDir, host });
  const vscode = ext.api;
  const panel = await ext.controller.openNotesFolder(note, 20000);
  if (!panel) throw new Error('no Notes panel');
  const rec = host.records.panels.find((p) => p.init.panelId === panel.panelId);
  const queuedBeforeReady = rec.delivered.length;
  panel.controller.contentReady(panel.controller.generation);
  const deliveredAfterReady = rec.delivered.map((m) => m && m.type);
  const html = panel.controller.html;
  // webview → host: New page (md) in the tree
  panel.controller.receiveMessage({ type: 'notesCreateMarkdownFile', title: 'Page A' });
  const upd = await waitFor(() => rec.delivered.find((m) => m && m.type === 'updateData' && m.kind === 'md'), 10000);
  const mdPath = upd && upd.filePath;
  const doc = await waitFor(() => mdPath && vscode.workspace.textDocuments.find((d) => d.fileName === mdPath), 10000);
  const content = '# Page A\n\nhello from the shim\n';
  panel.controller.receiveMessage({ type: 'notesSaveCurrentMd', content, fileChangeId: upd && upd.fileChangeId });
  await panel.controller.drainMessageHandlers(5000);
  await waitFor(() => mdPath && fs.existsSync(mdPath) && fs.readFileSync(mdPath, 'utf8') === content, 5000);
  const disk = mdPath && fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
  const docText = doc ? doc.getText() : null; const docDirty = doc ? doc.isDirty : null;
  // external edit → hybrid watcher (chokidar + fs.watchFile) → applyEdit + save → updateData externalUpdate
  await sleep(1200);
  const before = rec.delivered.length;
  if (mdPath) fs.writeFileSync(mdPath, '# Page A\n\nedited outside\n');
  const ext1 = await waitFor(() => rec.delivered.slice(before).find((m) => m && m.type === 'updateData' && m.kind === 'md' && m.externalUpdate), 8000);
  // a .out added from outside → the note folder's '*.out' watcher (chokidar only, no polling) → tree refresh
  await sleep(300);
  const beforeOut = rec.delivered.length;
  fs.writeFileSync(path.join(note, 'external.out'), JSON.stringify({ version: 1, rootIds: [], nodes: {} }));
  const outEvent = await waitFor(() => rec.delivered.slice(beforeOut).find((m) => m && m.type === 'notesFileListChanged'), 8000);
  // a note folder named like the app's own media folder (its roots are [<ext>/media, <ext>/vendor, folder, ~])
  const mediaNote = path.join(path.dirname(note), 'media');
  fs.mkdirSync(mediaNote, { recursive: true });
  const mediaPanel = await ext.controller.openNotesFolder(mediaNote, 8000);
  const result = {
    errors, homedir: os.homedir(),
    fractalCommands: (await vscode.commands.getCommands()).filter((c) => c.startsWith('fractal.')),
    treeViews: [...ext.controller.treeViews().keys()].sort(),
    customEditors: [...ext.controller.customEditors().keys()],
    defaultFractal: fs.existsSync(path.join(os.homedir(), '.fractal', 'default.fractal')),
    panel: { viewType: panel.viewType, title: panel.title, folder: panel.notesFolder(), loads: rec.loads, roots: panel.controller.resourceRoots(),
      htmlHasBridge: html.includes('acquireVsCodeApi'), htmlUsesResourceHost: html.includes('https://file%2B.vscode-resource.vscode-cdn.net/') },
    queuedBeforeReady, deliveredAfterReady,
    noteFiles: fs.readdirSync(note),
    md: { created: !!mdPath && fs.existsSync(mdPath), openedAsTextDocument: !!doc, disk, docText, docDirty, externalUpdate: ext1 ? ext1.markdown : null },
    outWatcherRefresh: !!outEvent,
    mediaNote: { opened: !!mediaPanel, title: mediaPanel ? mediaPanel.title : null, folder: mediaPanel ? mediaPanel.notesFolder() : null, files: fs.readdirSync(mediaNote) },
  };
  for (const p of ext.controller.panels()) p.dispose();
  await ext.deactivate();
  process.stdout.write('RESULT ' + JSON.stringify(result) + '\n');
  process.exit(0);
})().catch((e) => { process.stdout.write('RESULT ' + JSON.stringify({ fatal: String(e && e.stack || e), errors }) + '\n'); process.exit(0); });
`;

test.describe('electron vscode shim — AC-3 (resources only from inside the roots)', () => {
    test('AC-3 resolveResourceRequest: inside a root resolves; outside, "..", encoded "..", symlink escapes, missing, directories → null', () => {
        const base = mkTmp('fx-shim-res-'); // under os.tmpdir() (/var → /private/var on macOS: realpath on both sides)
        try {
            const root = path.join(base, 'root');
            const outside = path.join(base, 'outside');
            const sibling = path.join(base, 'root-x');
            fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
            fs.mkdirSync(outside);
            fs.mkdirSync(sibling);
            fs.writeFileSync(path.join(root, 'a.png'), 'png');
            fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b');
            fs.writeFileSync(path.join(root, '日本 語#1.md'), 'ja');
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
            fs.writeFileSync(path.join(sibling, 'evil.txt'), 'evil');
            fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-out.txt'));
            fs.symlinkSync(outside, path.join(root, 'dirlink'));
            fs.symlinkSync(path.join(root, 'a.png'), path.join(root, 'link-in.png'));
            const real = (p: string) => fs.realpathSync.native(p);
            const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
            const roots = [root];

            // inside → the real path to serve
            expect(resolveResourceRequest(enc(path.join(root, 'a.png')), roots)).toBe(real(path.join(root, 'a.png')));
            expect(resolveResourceRequest(enc(path.join(root, 'sub', 'b.txt')), roots)).toBe(real(path.join(root, 'sub', 'b.txt')));
            expect(resolveResourceRequest(enc(path.join(root, '日本 語#1.md')), roots)).toBe(real(path.join(root, '日本 語#1.md')));
            expect(resolveResourceRequest(enc(path.join(root, 'a.png')) + '?v=123#x', roots)).toBe(real(path.join(root, 'a.png')));
            expect(resolveResourceRequest(enc(path.join(root, 'link-in.png')), roots)).toBe(real(path.join(root, 'a.png')));
            expect(resolveResourceRequest(enc(path.join(root, 'a.png')), [{ fsPath: root, scheme: 'file' }])).toBe(real(path.join(root, 'a.png')));
            expect(resolveResourceRequest(enc(path.join(real(root), 'a.png')), roots)).toBe(real(path.join(root, 'a.png')));

            // outside the roots
            expect(resolveResourceRequest(enc(path.join(outside, 'secret.txt')), roots)).toBeNull();
            expect(resolveResourceRequest(enc(path.join(sibling, 'evil.txt')), roots)).toBeNull(); // "/root-x" is not inside "/root"
            // '..' in any spelling
            expect(resolveResourceRequest(`${enc(root)}/../outside/secret.txt`, roots)).toBeNull();
            expect(resolveResourceRequest(`${enc(root)}/sub/../a.png`, roots)).toBeNull();
            expect(resolveResourceRequest(`${enc(root)}/%2e%2e/outside/secret.txt`, roots)).toBeNull();
            expect(resolveResourceRequest(`${enc(root)}/..%2foutside%2fsecret.txt`, roots)).toBeNull();
            expect(resolveResourceRequest(`${enc(root)}/%2E%2E%2Foutside%2Fsecret.txt`, roots)).toBeNull();
            expect(resolveResourceRequest(`${enc(root)}/sub/..%5C..%5Coutside%5Csecret.txt`, roots)).toBeNull();
            // symlinks that leave the root
            expect(resolveResourceRequest(enc(path.join(root, 'link-out.txt')), roots)).toBeNull();
            expect(resolveResourceRequest(enc(path.join(root, 'dirlink', 'secret.txt')), roots)).toBeNull();
            // not a servable file
            expect(resolveResourceRequest(enc(path.join(root, 'missing.png')), roots)).toBeNull();
            expect(resolveResourceRequest(enc(path.join(root, 'sub')), roots)).toBeNull();
            expect(resolveResourceRequest(enc(root), roots)).toBeNull();
            // malformed input
            expect(resolveResourceRequest(`${enc(root)}/a.png%00.txt`, roots)).toBeNull();
            expect(resolveResourceRequest(`${enc(root)}/%E0%A4%A`, roots)).toBeNull();
            expect(resolveResourceRequest('a.png', roots)).toBeNull();
            expect(resolveResourceRequest('', roots)).toBeNull();
            // no usable root
            expect(resolveResourceRequest(enc(path.join(root, 'a.png')), [])).toBeNull();
            expect(resolveResourceRequest(enc(path.join(root, 'a.png')), [path.join(base, 'does-not-exist'), 'relative/root'])).toBeNull();
            expect(resolveResourceRequest(enc(path.join(root, 'a.png')), [{ fsPath: root, scheme: 'https' }])).toBeNull();
        } finally {
            rmrf(base);
        }
    });

    test('AC-3 webview resource URLs: only the vscode-resource host maps to a path, asWebviewUri output resolves inside the panel roots and nowhere else', () => {
        const base = mkTmp('fx-shim-res2-');
        const shim = makeShim(path.join(base, 'ud'));
        try {
            const vscode = shim.api as any;
            const note = path.join(base, 'note');
            fs.mkdirSync(path.join(note, 'images'), { recursive: true });
            const img = path.join(note, 'images', 'a b#1 日本.png');
            fs.writeFileSync(img, 'img');
            fs.writeFileSync(path.join(base, 'outside.txt'), 'x');
            const panel = vscode.window.createWebviewPanel('fractal.notes', 'Notes: note', vscode.ViewColumn.One, {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(note)],
            });
            const ctl = shim.host.records.panels[0].init.controller;
            const urlFor = (p: string) => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString();

            // what the page requests (Chromium canonicalizes %2B to '+', both must map)
            const u = urlFor(img);
            expect(webviewResourcePath(u)).toBe(new URL(u).pathname);
            expect(webviewResourcePath(u.replace('file%2B.', 'file+.'))).toBe(new URL(u).pathname);
            expect(resolveResourceRequest(webviewResourcePath(u)!, ctl.resourceRoots())).toBe(fs.realpathSync.native(img));
            // a file outside the panel roots → 404
            expect(resolveResourceRequest(webviewResourcePath(urlFor(path.join(base, 'outside.txt')))!, ctl.resourceRoots())).toBeNull();
            // the app's own viewer modules are always servable (packaged .app outside $HOME)
            const viewer = path.join(REPO_ROOT, 'out', 'webview', 'viewer-text.mjs');
            if (fs.existsSync(viewer)) {
                expect(resolveResourceRequest(webviewResourcePath(urlFor(viewer))!, ctl.resourceRoots())).toBe(fs.realpathSync.native(viewer));
            }
            // other hosts / schemes are not resources
            expect(webviewResourcePath('https://example.com/Users/x.png')).toBeNull();
            expect(webviewResourcePath('https://evil.vscode-cdn.net/Users/x.png')).toBeNull();
            expect(webviewResourcePath('https://vscode-resource.vscode-cdn.net/Users/x.png')).toBeNull();
            expect(webviewResourcePath('http://file+.vscode-resource.vscode-cdn.net/Users/x.png')).toBeNull();
            expect(webviewResourcePath('fractal-res://panel-1/index.html')).toBeNull();
            expect(webviewResourcePath('not a url')).toBeNull();
            // content types the page needs (module scripts, css, fonts, wasm)
            expect(contentTypeFor('/x/viewer-text.mjs')).toMatch(/^text\/javascript/);
            expect(contentTypeFor('/x/katex.min.css')).toMatch(/^text\/css/);
            expect(contentTypeFor('/x/KaTeX_Main.woff2')).toBe('font/woff2');
            expect(contentTypeFor('/x/a.wasm')).toBe('application/wasm');
            expect(contentTypeFor('/x/a.PNG')).toBe('image/png');
            expect(contentTypeFor('/x/noext')).toBe('application/octet-stream');
            panel.dispose();
        } finally {
            shim.controller.dispose();
            rmrf(base);
        }
    });

    test("AC-3 panel session guard: the panel's document and resources only for the panel's window and origin; a sandboxed frame (origin 'null') gets neither", () => {
        const panel = { origin: 'fractal-res://panel-1', webContentsId: 7, alive: true };
        const doc = 'fractal-res://panel-1/index.html?gen=1';
        const res = 'https://file+.vscode-resource.vscode-cdn.net/Users/a/note/images/x.png';
        // webContentsId null = the request carries none; p null = no panel owns the session
        const may = (url: string, resourceType: string, frameOrigin: string | null, webContentsId: number | null = 7, p: typeof panel | null = panel) =>
            mayLoadInPanelSession({ url, resourceType, frameOrigin, webContentsId: webContentsId ?? undefined }, p ?? undefined);
        expect(GUARDED_URL_PATTERNS).toEqual(['https://*.vscode-cdn.net/*', 'fractal-res://*/*']);

        // the window's own top-level load (its frame still has the initial opaque origin) and reload
        expect(may(doc, 'mainFrame', 'null')).toBe(true);
        expect(may(doc, 'mainFrame', 'fractal-res://panel-1')).toBe(true);
        // the page itself and its same-origin frames / workers
        expect(may(doc, 'xhr', 'fractal-res://panel-1')).toBe(true);
        expect(may(res, 'image', 'fractal-res://panel-1')).toBe(true);
        expect(may(res, 'script', 'fractal-res://panel-1', null)).toBe(true);

        // a sandboxed viewer iframe: fetch / XHR, its own navigation, images, workers — the document embeds the note
        for (const type of ['xhr', 'subFrame', 'image', 'script', 'other']) {
            expect(may(doc, type, 'null'), `document ← ${type}`).toBe(false);
            expect(may(res, type, 'null'), `resource ← ${type}`).toBe(false);
        }
        // no frame, another window, another panel, a disposed panel, no panel
        expect(may(doc, 'xhr', null)).toBe(false);
        expect(may(res, 'image', null)).toBe(false);
        expect(may(doc, 'mainFrame', 'null', 8)).toBe(false);
        expect(may(doc, 'mainFrame', 'null', null)).toBe(false);
        expect(may(res, 'image', 'fractal-res://panel-1', 8)).toBe(false);
        expect(may(doc, 'xhr', 'fractal-res://panel-2')).toBe(false);
        expect(may(res, 'image', 'fractal-res://panel-2')).toBe(false);
        expect(may(doc, 'mainFrame', 'null', 7, { ...panel, alive: false })).toBe(false);
        expect(may(res, 'image', 'fractal-res://panel-1', 7, { ...panel, alive: false })).toBe(false);
        expect(may(doc, 'mainFrame', 'null', 7, null)).toBe(false);
        // a top-level navigation is a document of the panel only on its own scheme
        expect(may(res, 'mainFrame', 'null')).toBe(false);
        expect(may('not a url', 'mainFrame', 'null')).toBe(false);
    });
});

test.describe('electron desktop shell — development / test switches', () => {
    test('a packaged app ignores the switches that change its code or profile or open it to the DevTools protocol; unpackaged runs and the E2E build honor what they need', () => {
        const base = {
            argv: ['/Applications/Fractal.app/Contents/MacOS/Fractal'] as string[],
            env: {} as Record<string, string>,
            resourcesPath: '/Applications/Fractal.app/Contents/Resources',
            mainDir: '/repo/electron/out/main',
        };
        // Chromium's own parse of the command line (main.ts passes app.commandLine.hasSwitch)
        const debugging = new Set(['remote-debugging-port', 'remote-debugging-pipe']);
        const hostile = {
            argv: [...base.argv, '--fractal-user-data=/tmp/other-profile', '--fractal-open-note=/notes/n1', '--remote-debugging-port=0', '--remote-debugging-pipe'],
            env: { FRACTAL_EXTENSION_ROOT: '/tmp/other-code', FRACTAL_USER_DATA: '/tmp/other-profile-2' },
            hasChromiumSwitch: (name: string) => debugging.has(name),
        };
        const bundled = '/Applications/Fractal.app/Contents/Resources/ext';
        // the release build: only the note to open is taken; the DevTools protocol switches are removed (spec 20261106-1312 D4b)
        expect(resolveLaunchOptions({ ...base, ...hostile, isPackaged: true, testBuild: false })).toEqual({
            extensionRoot: bundled,
            userData: undefined,
            devProfile: false,
            openNote: '/notes/n1',
            removeSwitches: ['remote-debugging-port', 'remote-debugging-pipe'],
            ignored: ['FRACTAL_EXTENSION_ROOT', '--fractal-user-data', 'FRACTAL_USER_DATA', '--remote-debugging-port', '--remote-debugging-pipe'],
        });
        // only what was given is removed / logged
        expect(resolveLaunchOptions({ ...base, hasChromiumSwitch: (n: string) => n === 'remote-debugging-pipe', isPackaged: true, testBuild: false })).toMatchObject({
            removeSwitches: ['remote-debugging-pipe'],
            ignored: ['--remote-debugging-pipe'],
        });
        // the E2E build: the profile switch too (each test runs on a temp profile) and the DevTools protocol (Playwright
        // drives the pages through --remote-debugging-port=0), never another extension
        expect(resolveLaunchOptions({ ...base, ...hostile, isPackaged: true, testBuild: true })).toEqual({
            extensionRoot: bundled,
            userData: '/tmp/other-profile',
            devProfile: false,
            openNote: '/notes/n1',
            removeSwitches: [],
            ignored: ['FRACTAL_EXTENSION_ROOT'],
        });
        expect(resolveLaunchOptions({ ...base, env: { FRACTAL_USER_DATA: '/tmp/p' }, isPackaged: true, testBuild: true }).userData).toBe('/tmp/p');
        // an unpackaged dev run: everything
        expect(resolveLaunchOptions({ ...base, ...hostile, isPackaged: false, testBuild: false })).toEqual({
            extensionRoot: '/tmp/other-code',
            userData: '/tmp/other-profile',
            devProfile: false,
            openNote: '/notes/n1',
            removeSwitches: [],
            ignored: [],
        });
        // defaults
        expect(resolveLaunchOptions({ ...base, isPackaged: false, testBuild: false })).toEqual({
            extensionRoot: '/repo',
            userData: undefined,
            devProfile: true,
            openNote: undefined,
            removeSwitches: [],
            ignored: [],
        });
        expect(resolveLaunchOptions({ ...base, isPackaged: true, testBuild: false })).toEqual({
            extensionRoot: bundled,
            userData: undefined,
            devProfile: false,
            openNote: undefined,
            removeSwitches: [],
            ignored: [],
        });
    });
});
