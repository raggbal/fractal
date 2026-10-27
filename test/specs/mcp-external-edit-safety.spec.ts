/**
 * mcp-external-edit-safety — 外部（MCP 等）の書き込みを、画面の古い内容で上書きしない（AC-6）
 * spec: .harness/spec/20261027-1700-mcp-full-ops（D3 の拡張機能側）/ ADRL-0045 の保留照合の中で直す
 *
 * 守る規則（src/shared/external-merge.js が正典）:
 *  - UI の書き込みは「最後に読んだ / 書いた中身（基準）」に対する変更として扱う。書く直前に disk が
 *    基準から変わっていたら（＝自分以外が書いた）、disk の最新に UI の変更を重ねて書く（3-way マージ）。
 *  - outline.note: UI が触っていない項目（MCP が足した md など）は落とさない。
 *  - .out: 別のノードの変更は両方残す。同じノードの text / subtext を両方が変えたら、UI の内容を残し、
 *    外部の内容は直後の兄弟ノード（id = 元 id + '-ext' + hash）として残す（どちらも消さない）。
 *  - md: 行単位の 3-way マージ。同じ行を両方が変えたら、UI の行のあとに外部の行を並べて両方残す。
 *  - 自分の書き込みのはね返り（今と同じ内容）では再描画も undo の消去もしない。
 *
 * host 面（tmp dir + vscode stub）:
 *  (a) outline.note: 外部が md 項目を足したあと、UI がファイルを開く（history）/ 改名 → md 項目が残る
 *  (c) .out: 自分の書き込み直後（isWriting の 300ms 窓）の外部書き込みを拾う + 次の UI 保存で消さない
 *  (d) md: 保存待ちの編集があるときの外部編集 → notesMdMainManager / sidePanelManager とも両方残る
 * webview 面（standalone-notes.html）:
 *  (b) .out: 入力中に外部が別ノードを変える → 入力後、画面と送る内容（syncData）の両方に両方の変更
 *  (d) md: 入力中に外部が別の段落を変える → 画面と保存内容の両方に両方の変更
 *  (e) 自分の書き込みのはね返りで undo が消えない（.out / md）
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// host 面のハーネス（test/unit/folder-link-host.spec.ts / selfwrite-reconcile-notes.spec.ts と同型）
// ─────────────────────────────────────────────────────────────────────────────

function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}

function requireWithStubs(modulePath: string, vscodeNs: any, fsNs?: any): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache(); // 掴まない
    Module._load = function (request: string, ...rest: any[]) {
        if (request === 'vscode') { return vscodeNs; }
        if (fsNs && request === 'fs' && rest[0] && String(rest[0].filename || '').includes(`${path.sep}src${path.sep}shared${path.sep}`)
            && !String(rest[0].filename || '').includes('notes-file-manager')) {
            return fsNs;
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache(); // 残さない
    }
}

function loadNotesFileManager(): any {
    const stub = {
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        Uri: { file: (p: string) => ({ fsPath: p }) },
        window: {}, commands: {}, env: {},
    };
    return requireWithStubs('../../src/shared/notes-file-manager', stub).NotesFileManager;
}

function makeTmpNote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ac6-note-'));
}

function readJson(p: string): any {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** md 用の fake vscode（TextDocument は 1 つ・save で disk に書く・disk 読みは workspace.fs） */
function makeFakeMdEnv(filePath: string, initial: string) {
    const state = {
        diskContent: initial,
        docContent: initial,
        watchFileListeners: [] as Array<(c: any, p: any) => void>,
    };
    const doc = {
        uri: { fsPath: filePath, toString: () => `file://${filePath}` },
        isClosed: false,
        getText: () => state.docContent,
        positionAt: (_n: number) => ({ line: 0, character: 0 }),
        get lineCount() { return state.docContent.split('\n').length; },
        save: async () => { state.diskContent = state.docContent; return true; },
    };
    const vscodeNs: any = {
        Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
        Range: class { constructor(..._a: any[]) {} },
        WorkspaceEdit: class {
            _content: string | null = null;
            replace(_uri: any, _range: any, content: string) { this._content = content; }
        },
        workspace: {
            openTextDocument: async (_uri: any) => doc,
            fs: {
                readFile: async (_uri: any) => new TextEncoder().encode(state.diskContent),
                writeFile: async (_uri: any, buf: Uint8Array) => { state.diskContent = new TextDecoder().decode(buf); },
            },
            applyEdit: async (edit: any) => { if (edit._content !== null) { state.docContent = edit._content; } return true; },
            onDidChangeTextDocument: (_h: any) => ({ dispose: () => {} }),
            createFileSystemWatcher: () => ({
                onDidChange: (_h: () => void) => ({ dispose: () => {} }),
                onDidCreate: (_h: () => void) => ({ dispose: () => {} }),
                onDidDelete: (_h: () => void) => ({ dispose: () => {} }),
                dispose: () => {},
            }),
            getConfiguration: () => ({ get: (_k: string, d: any) => d }),
        },
        RelativePattern: class { constructor(_b: any, _p: string) {} },
        window: { showErrorMessage: () => {} },
    };
    const fsNs = {
        watchFile: (_p: string, _o: any, l: (c: any, p: any) => void) => { state.watchFileListeners.push(l); },
        unwatchFile: () => {},
        existsSync: () => false,
        readFileSync: () => '',
        statSync: () => ({ isFile: () => true }),
    };
    return { vscodeNs, fsNs, state };
}

function collectHost() {
    const messages: any[] = [];
    return {
        messages,
        host: {
            postMessage: (m: any) => { messages.push(m); return Promise.resolve(true); },
            asWebviewUri: (u: any) => ({ toString: () => `webview://${u.fsPath}` }),
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) outline.note
// ─────────────────────────────────────────────────────────────────────────────

test.describe('AC-6 outline.note: 外部が足した項目を UI の書き込みで落とさない', () => {
    test('AC-6 (a) 外部が md 項目を足したあと、UI がファイルを開く（history）・改名しても md 項目が残る', async () => {
        const NotesFileManager = loadNotesFileManager();
        const dir = makeTmpNote();
        const fm = new NotesFileManager(dir);
        let redraws = 0;
        fm.setStructureMergedListener?.(() => { redraws++; });
        const outPath = fm.createFile('Outline A');
        const outId = path.basename(outPath, '.out');
        fm.getStructure();
        const noteFile = path.join(dir, 'outline.note');

        // 外部（MCP）: md を作って outline.note に登録する（UI のキャッシュは古いまま・watcher はまだ来ていない）
        const mdId = 'mcpmd1';
        fs.writeFileSync(fm.getMdFilePath(mdId), '# From MCP\n\nbody\n', 'utf8');
        const onDisk = readJson(noteFile);
        onDisk.items[mdId] = { type: 'file', id: mdId, title: 'From MCP', ext: 'md' };
        onDisk.rootIds.push(mdId);
        fs.writeFileSync(noteFile, JSON.stringify(onDisk, null, 2), 'utf8');

        // UI: ファイルを開く（Recent に積む = outline.note を書く）
        fm.recordFileHistory(outPath, 'main');
        let after = readJson(noteFile);
        expect(after.items[mdId], 'history を書いても MCP が足した md 項目が残る').toBeTruthy();
        expect(after.rootIds).toContain(mdId);
        expect((after.history || []).length, 'UI の変更（history）も入っている').toBeGreaterThanOrEqual(1);

        // UI: .out を改名（tree title を書く）
        fm.renameTitle(outPath, 'Outline A renamed');
        after = readJson(noteFile);
        expect(after.items[mdId], '改名しても md 項目が残る').toBeTruthy();
        expect(after.rootIds).toContain(mdId);
        expect(after.items[outId].title).toBe('Outline A renamed');

        // UI が開いたままの structure（getStructure）にも外部の項目が入っている（画面と disk がずれない）
        expect(fm.getStructure().items[mdId]).toBeTruthy();
        // 合成して書いたら tree の描き直しを頼む（合成後の watcher イベントは自分の書き込みと区別できない）
        await wait(20);
        expect(redraws, '合成したら tree を描き直す通知').toBeGreaterThanOrEqual(1);
    });

    test('AC-6 (a2) 外部がフォルダを作り項目を移した直後に UI がフォルダを作っても、外部の変更が残る', () => {
        const NotesFileManager = loadNotesFileManager();
        const dir = makeTmpNote();
        const fm = new NotesFileManager(dir);
        const outPath = fm.createFile('A');
        const outId = path.basename(outPath, '.out');
        fm.getStructure();
        const noteFile = path.join(dir, 'outline.note');

        // 外部: フォルダ X を作り A を中に移す
        const onDisk = readJson(noteFile);
        onDisk.items.fx = { type: 'folder', id: 'fx', title: 'X', childIds: [outId], collapsed: false };
        onDisk.rootIds = ['fx'];
        fs.writeFileSync(noteFile, JSON.stringify(onDisk, null, 2), 'utf8');

        // UI: 古いキャッシュのままフォルダ Y を作る
        fm.createFolder('Y');
        const after = readJson(noteFile);
        expect(after.items.fx, '外部のフォルダが残る').toBeTruthy();
        expect(after.items.fx.childIds).toContain(outId);
        expect(after.rootIds.filter((id: string) => id === outId).length, 'A は root に二重に出ない').toBe(0);
        const ys = Object.values(after.items).filter((it: any) => it.type === 'folder' && it.title === 'Y');
        expect(ys.length, 'UI のフォルダも作られている').toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) .out: 自分の書き込みの直後の外部書き込み
// ─────────────────────────────────────────────────────────────────────────────

function outData(n1: string, n2: string): any {
    return {
        version: 1,
        title: 'T',
        rootIds: ['n1', 'n2'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: n1, subtext: '', tags: [] },
            n2: { id: 'n2', parentId: null, children: [], text: n2, subtext: '', tags: [] },
        },
    };
}
const j = (d: any) => JSON.stringify(d, null, 2);

test.describe('AC-6 .out: 自分の書き込み直後（isWriting 窓）の外部書き込み', () => {
    test('AC-6 (c) isWriting 窓の外部書き込みを拾い、次の UI 保存でも消さない', async () => {
        const NotesFileManager = loadNotesFileManager();
        const dir = makeTmpNote();
        const outPath = path.join(dir, 'o1.out');
        fs.writeFileSync(outPath, j(outData('one', 'two')), 'utf8');
        const fm = new NotesFileManager(dir);
        const events: any[] = [];
        if (typeof fm.setExternalOutChangeListener === 'function') {
            fm.setExternalOutChangeListener((ev: any) => events.push(ev));
        }
        fm.openFile(outPath);

        // UI の保存（n1 を変える）→ disk に書いた直後は isWriting=true（300ms）
        fm.saveCurrentFile(j(outData('one-ui', 'two')));
        fm.flushSave();
        expect(fm.getIsWriting(), '自分の書き込みの直後').toBe(true);

        // 窓の中で外部（MCP）が n2 を変える
        fs.writeFileSync(outPath, j(outData('one-ui', 'two-mcp')), 'utf8');

        // watcher が来た（窓の中）→ 捨てずに拾う
        const picked = fm.reconcileExternalOutChange();
        expect(picked, 'isWriting 窓の外部書き込みも拾う').toBeTruthy();
        expect(picked.data.nodes.n2.text).toBe('two-mcp');
        expect(events.length, 'webview への通知が 1 回出る').toBe(1);

        // 通知の前に webview が送っていた古いモデル（n2 は two のまま）の syncData は、
        // 進めた fileChangeId で stale として落ちる（本番の handler 経路で確かめる）
        await wait(350);
        const handleNotesMessage = requireWithStubs('../../src/shared/notes-message-handler', {
            workspace: { getConfiguration: () => ({ get: () => undefined }) },
            Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
            commands: { executeCommand: () => {} },
            window: {}, env: {}, ViewColumn: {}, EventEmitter: class {},
        }).handleNotesMessage;
        const sender = { postMessage: () => {} };
        const platform = { showInformationMessage: () => {}, showErrorMessage: () => {} };
        const oldId = picked.fileChangeId - 1;
        await handleNotesMessage({ type: 'syncData', content: j(outData('one-ui2', 'two')), fileChangeId: oldId }, fm, sender, platform);
        fm.flushSave();
        expect(readJson(outPath).nodes.n2.text, '古いモデルの syncData で MCP の変更を消さない').toBe('two-mcp');

        // 通知を受けた webview が合成して送る内容（新しい fileChangeId）は書かれる
        await handleNotesMessage({ type: 'syncData', content: j(outData('one-ui2', 'two-mcp')), fileChangeId: picked.fileChangeId }, fm, sender, platform);
        fm.flushSave();
        const disk = readJson(outPath);
        expect(disk.nodes.n1.text, 'UI の変更').toBe('one-ui2');
        expect(disk.nodes.n2.text, 'MCP の変更が残る').toBe('two-mcp');
    });

    test('AC-6 (c2) watcher が来ないまま外部が書いても、UI の保存の直前に気づいて合成し webview に知らせる', () => {
        const NotesFileManager = loadNotesFileManager();
        const dir = makeTmpNote();
        const outPath = path.join(dir, 'o2.out');
        fs.writeFileSync(outPath, j(outData('one', 'two')), 'utf8');
        const fm = new NotesFileManager(dir);
        const events: any[] = [];
        fm.setExternalOutChangeListener?.((ev: any) => events.push(ev));
        fm.openFile(outPath);

        // 外部が n2 を変える（watcher は取りこぼした想定）
        fs.writeFileSync(outPath, j(outData('one', 'two-mcp')), 'utf8');
        // UI は古い基準のまま n1 を変えて保存
        fm.saveCurrentFile(j(outData('one-ui', 'two')));
        fm.flushSave();
        const disk = readJson(outPath);
        expect(disk.nodes.n1.text).toBe('one-ui');
        expect(disk.nodes.n2.text, '外部の変更を上書きしない').toBe('two-mcp');
        expect(events.length, '合成した内容を webview に知らせる').toBe(1);
        expect(events[0].data.nodes.n2.text).toBe('two-mcp');
        expect(events[0].data.nodes.n1.text).toBe('one-ui');
    });

    test('AC-6 (c3) 同じノードの text を両方が変えたら、UI の内容を残し外部の内容は直後の兄弟に残す', () => {
        const NotesFileManager = loadNotesFileManager();
        const dir = makeTmpNote();
        const outPath = path.join(dir, 'o3.out');
        fs.writeFileSync(outPath, j(outData('one', 'two')), 'utf8');
        const fm = new NotesFileManager(dir);
        fm.openFile(outPath);
        fs.writeFileSync(outPath, j(outData('one-mcp', 'two')), 'utf8');
        fm.saveCurrentFile(j(outData('one-ui', 'two')));
        fm.flushSave();
        const disk = readJson(outPath);
        expect(disk.nodes.n1.text, 'UI の入力が残る').toBe('one-ui');
        const idx = disk.rootIds.indexOf('n1');
        const copyId = disk.rootIds[idx + 1];
        expect(copyId, '直後に外部の内容のノード').toMatch(/^n1-ext/);
        expect(disk.nodes[copyId].text).toBe('one-mcp');
        expect(disk.rootIds[idx + 2]).toBe('n2');

        // 同じ合成をもう一度通しても、同じコピーが増えない（冪等）
        const again = fm.reconcileExternalOutChange?.();
        expect(again ?? null, '自分の書いた内容は外部変更ではない').toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) md host: 保存の直前に disk を確かめる
// ─────────────────────────────────────────────────────────────────────────────

const MD_BASE = '# Title\n\npara one\n\npara two\n\npara three\n';
const MD_EXT = '# Title\n\npara one EXT\n\npara two\n\npara three\n';      // 外部（MCP）: 1 段落目
const MD_UI = '# Title\n\npara one\n\npara two\n\npara three UI\n';       // UI: 3 段落目

test.describe('AC-6 md host: 保存待ちの編集があるときの外部編集', () => {
    test('AC-6 (d) notesMdMainManager: watcher の前に保存が来ても、外部の編集を上書きせず両方残す', async () => {
        const fp = '/fake/note/main.md';
        const env = makeFakeMdEnv(fp, MD_BASE);
        const { NotesMdMainManager } = requireWithStubs('../../src/shared/notesMdMainManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectHost();
        const mgr = new NotesMdMainManager(host);
        await mgr.setupFileWatcher(fp);

        env.state.diskContent = MD_EXT;            // 外部が書いた（watcher はまだ）
        await mgr.handleSave(fp, MD_UI);           // UI の保存（古い基準からの変更）
        expect(env.state.diskContent, 'disk に両方').toContain('para one EXT');
        expect(env.state.diskContent).toContain('para three UI');
        const ups = messages.filter((m) => m.type === 'updateData' && m.kind === 'md' && m.externalUpdate);
        expect(ups.length, '合成した内容を画面に送る').toBeGreaterThanOrEqual(1);
        expect(ups[ups.length - 1].markdown).toContain('para one EXT');
        expect(ups[ups.length - 1].markdown).toContain('para three UI');
        mgr.disposeFileWatcher();
    });

    test('AC-6 (d) sidePanelManager: 同じ規則（同型の経路）', async () => {
        const fp = '/fake/note/side.md';
        const env = makeFakeMdEnv(fp, MD_BASE);
        const { SidePanelManager } = requireWithStubs('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectHost();
        const mgr = new SidePanelManager(host, { logPrefix: '[t]' });
        await mgr.setupFileWatcher(fp);

        env.state.diskContent = MD_EXT;
        await mgr.handleSave(fp, MD_UI);
        expect(env.state.diskContent).toContain('para one EXT');
        expect(env.state.diskContent).toContain('para three UI');
        const ups = messages.filter((m) => m.type === 'sidePanelMessage' && m.data && m.data.type === 'update');
        expect(ups.length).toBeGreaterThanOrEqual(1);
        expect(ups[ups.length - 1].data.content).toContain('para one EXT');
        expect(ups[ups.length - 1].data.content).toContain('para three UI');
        mgr.disposeFileWatcher();
    });

    test('AC-6 (d) md: 外部の変更が届いたら、画面への通知に基準（externalBase）が付く', async () => {
        const fp = '/fake/note/main2.md';
        const env = makeFakeMdEnv(fp, MD_BASE);
        const { NotesMdMainManager } = requireWithStubs('../../src/shared/notesMdMainManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectHost();
        const mgr = new NotesMdMainManager(host);
        await mgr.setupFileWatcher(fp);
        env.state.diskContent = MD_EXT;
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2 }, { mtimeMs: 1 }));
        await wait(300);
        const ups = messages.filter((m) => m.type === 'updateData' && m.kind === 'md' && m.externalUpdate);
        expect(ups.length).toBe(1);
        expect(ups[0].markdown).toBe(MD_EXT);
        expect(ups[0].externalBase, '画面が 3-way で取り込めるよう、外部の変更の前の内容を付ける').toBe(MD_BASE);
        mgr.disposeFileWatcher();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// webview 面（standalone-notes.html）
// ─────────────────────────────────────────────────────────────────────────────

async function openNotes(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function nodeTexts(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('.outliner-node .outliner-text')).map((e) => e.textContent || ''));
}

function lastSync(page: Page) {
    return page.evaluate(() => {
        const ms = (window as any).__testApi.messages.filter((m: any) => m.type === 'syncData');
        return ms.length ? JSON.parse(ms[ms.length - 1].content) : null;
    });
}

test.describe('AC-6 .out webview: 入力中の外部変更', () => {
    test('AC-6 (b) 入力中に外部が別ノードを変える → 入力後、画面と送る内容の両方に両方の変更', async ({ page }) => {
        await openNotes(page);
        const base = outData('one', 'two');
        await page.evaluate((d) => (window as any).__testApi.initOutliner(d), base);
        const first = page.locator('.outliner-node .outliner-text').first();
        await first.click();
        await page.keyboard.press('End');
        await page.keyboard.type('X');

        // 入力中に host が外部変更を知らせる（NotesFileManager の通知と同じ形）
        const theirs = outData('one', 'two-mcp');
        await page.evaluate(({ data, baseStr, content }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'out', data, fileChangeId: 5, outFileKey: null,
                externalBase: baseStr, externalContent: content,
            });
        }, { data: theirs, baseStr: j(base), content: j(theirs) });

        // 入力中は画面の入力が消えない
        await page.waitForTimeout(150);
        expect((await nodeTexts(page))[0]).toContain('X');

        // idle（1.5s）後: 画面に両方
        await page.waitForTimeout(2200);
        const texts = await nodeTexts(page);
        expect(texts[0], '入力が残る').toBe('oneX');
        expect(texts[1], '外部の変更が画面に出る').toBe('two-mcp');
        // 送った内容（= disk に書かれる内容）にも両方
        const sent = await lastSync(page);
        expect(sent.nodes.n1.text).toBe('oneX');
        expect(sent.nodes.n2.text, '古いモデルで外部の変更を上書きしない').toBe('two-mcp');
    });

    test('AC-6 (b2) 入力が続いている間に送る内容にも外部の変更が入る（idle を待たない）', async ({ page }) => {
        await openNotes(page);
        const base = outData('one', 'two');
        await page.evaluate((d) => (window as any).__testApi.initOutliner(d), base);
        const first = page.locator('.outliner-node .outliner-text').first();
        await first.click();
        await page.keyboard.press('End');
        await page.keyboard.type('a');
        const theirs = outData('one', 'two-mcp');
        await page.evaluate(({ data, baseStr, content }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'out', data, fileChangeId: 6, outFileKey: null,
                externalBase: baseStr, externalContent: content,
            });
        }, { data: theirs, baseStr: j(base), content: j(theirs) });
        // syncData（1s debounce）は出るが idle（1.5s）にはならない間隔で打ち続け、その間の syncData を見る
        await page.waitForTimeout(1150);
        await page.keyboard.type('b');
        await page.waitForTimeout(1150);
        const sent = await lastSync(page);
        expect((await nodeTexts(page))[1], 'まだ入力中（idle 前）なので画面は取り込み前').toBe('two');
        expect(sent, '入力中にも syncData は出る').toBeTruthy();
        expect(sent.nodes.n2.text, '入力中に送る内容にも外部の変更が入る').toBe('two-mcp');
        expect(sent.nodes.n1.text).toContain('onea');
        expect(sent.nodes.n1.text).toContain('b');
    });

    test('AC-6 (e) .out: 自分の書き込みのはね返り（同じ内容）では undo が消えない', async ({ page }) => {
        await openNotes(page);
        const base = outData('one', 'two');
        await page.evaluate((d) => (window as any).__testApi.initOutliner(d), base);
        const first = page.locator('.outliner-node .outliner-text').first();
        await first.click();
        await page.keyboard.press('End');
        await page.keyboard.type('X');
        await page.waitForTimeout(1700); // syncData（1s）+ idle（1.5s）
        const sentRaw = await page.evaluate(() => {
            const ms = (window as any).__testApi.messages.filter((m: any) => m.type === 'syncData');
            return ms[ms.length - 1].content;
        });
        // host がはね返りを送ってきた（今の画面と同じ内容）
        await page.evaluate(({ raw, baseStr }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'out', data: JSON.parse(raw), fileChangeId: 7, outFileKey: null,
                externalBase: baseStr, externalContent: raw,
            });
        }, { raw: sentRaw, baseStr: j(base) });
        await page.waitForTimeout(200);
        await first.click();
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);
        expect((await nodeTexts(page))[0], 'undo が効く（はね返りで undo を消していない）').toBe('one');
    });
});

const MD_FILE = '/Users/test/notes/noteA/ac6.md';

async function openMdPane(page: Page, md: string) {
    await openNotes(page);
    await page.evaluate(({ fp, md }) => {
        (window as any).__hostMessageHandler({ type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '' });
    }, { fp: MD_FILE, md });
    await page.waitForTimeout(300);
}

function mdText(page: Page) {
    return page.evaluate(() => (document.querySelector('.markdown-container .editor') as HTMLElement | null)?.innerText || '');
}

function lastMdSave(page: Page) {
    return page.evaluate(() => {
        const ms = (window as any).__testApi.messages.filter((m: any) => m.type === 'notesSaveCurrentMd');
        return ms.length ? ms[ms.length - 1].content : null;
    });
}

test.describe('AC-6 md webview: 入力中の外部変更', () => {
    test('AC-6 (d) md: 入力中に外部が別の段落を変える → 画面と保存内容の両方に両方の変更', async ({ page }) => {
        await openMdPane(page, MD_BASE);
        const lastP = page.locator('.markdown-container .editor p', { hasText: 'para two' });
        await lastP.click();
        await page.keyboard.press('End');
        await page.keyboard.type('ZZ');

        await page.evaluate(({ fp, md, base }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '',
                externalUpdate: true, externalBase: base,
            });
        }, { fp: MD_FILE, md: MD_EXT, base: MD_BASE });
        await page.waitForTimeout(150);
        expect(await mdText(page), '入力中は入力が消えない').toContain('para twoZZ');

        await page.waitForTimeout(2300);
        const shown = await mdText(page);
        expect(shown, '入力が残る').toContain('para twoZZ');
        expect(shown, '外部の変更が画面に出る').toContain('para one EXT');
        const saved = await lastMdSave(page);
        expect(saved, '保存内容に入力').toContain('para twoZZ');
        expect(saved, '保存内容に外部の変更（古い内容で上書きしない）').toContain('para one EXT');
    });

    test('AC-6 (d2) md: 入力して blur しても外部の変更を捨てない（Fix A は基準がある時は合成に置き換える）', async ({ page }) => {
        await openMdPane(page, MD_BASE);
        const lastP = page.locator('.markdown-container .editor p', { hasText: 'para two' });
        await lastP.click();
        await page.keyboard.press('End');
        await page.keyboard.type('ZZ');
        await page.evaluate(({ fp, md, base }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '',
                externalUpdate: true, externalBase: base,
            });
        }, { fp: MD_FILE, md: MD_EXT, base: MD_BASE });
        await page.waitForTimeout(100);
        // blur（未同期の入力を flush する経路）
        await page.evaluate(() => (document.querySelector('.markdown-container .editor') as HTMLElement).blur());
        await page.waitForTimeout(300);
        const shown = await mdText(page);
        expect(shown).toContain('para twoZZ');
        expect(shown, 'blur でも外部の変更を捨てない').toContain('para one EXT');
        const saved = await lastMdSave(page);
        expect(saved).toContain('para twoZZ');
        expect(saved).toContain('para one EXT');
    });

    test('AC-6 (e) md: 自分の保存のはね返り（基準付き・同じ内容）では undo が消えない', async ({ page }) => {
        await openMdPane(page, MD_BASE);
        const lastP = page.locator('.markdown-container .editor p', { hasText: 'para two' });
        await lastP.click();
        await page.keyboard.press('End');
        await page.keyboard.type('ZZ');
        await page.waitForTimeout(2000);
        const saved = await lastMdSave(page);
        expect(saved).toContain('para twoZZ');
        await page.evaluate(({ fp, md, base }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '',
                externalUpdate: true, externalBase: base,
            });
        }, { fp: MD_FILE, md: saved, base: MD_BASE });
        await page.waitForTimeout(200);
        await lastP.click();
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        expect(await mdText(page), 'undo が効く').not.toContain('para twoZZ');
    });
});
