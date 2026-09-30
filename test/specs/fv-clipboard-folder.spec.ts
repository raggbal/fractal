/**
 * TASK-11 — A-3: フォルダの clipboard 複製 / 右クリック Duplicate
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-06 / FR-FLV-15 rev2 / FR-CBD-07 / ADRL-0124
 *
 * TC-R3-1: linkedfd 面内 Cmd+C → Cmd+V でフォルダが複製される（**継ぎ目を通る**）
 * TC-R3-2: フォルダ行で Cmd+V するとその中に複製される
 * TC-R3-3: 複数フォルダ + ファイルの混在
 * TC-R3-4: 「フォルダは複製できません」通知が出ない
 * TC-DUP-1: 右クリック Duplicate でフォルダが複製される（host 側）
 *
 * 🔴 **host 関数を直接呼ぶだけの TC にしない**（ADRL-0124 の Consequences）:
 * 旧 TC が host 直呼びだったため webview→host の継ぎ目を通らず、到達不能な分岐を green のまま見逃した。
 * TC-R3-* は webview 層で貼り付けを発火して host bridge の呼び出しを観測する。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DISPATCHER_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/folder-view-dispatcher.js'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-folder-view.js'), 'utf8');
const MENU_PLACEMENT_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/menu-placement.js'), 'utf8');
const BATCH_JS = fs.readFileSync(path.join(__dirname, '../../src/shared/batch-payload.js'), 'utf8');
const FV_CLIP_ATTR = 'data-fractal-fv-clip';

async function mountFv(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:22px;}</style></head><body>'
        + '<div class="notes-main-wrapper" style="position:relative;height:600px;">'
        + '<div id="outlinerContainer">outliner</div><div id="markdownContainer" style="display:none">md</div>'
        + '</div></body></html>');
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {}; w.__calls = [];
        w.notesHostBridge = new Proxy({}, {
            get: (_t, prop: string) => (...args: any[]) => { w.__calls.push({ type: prop, args }); },
        });
    });
    for (const js of [BATCH_JS, MENU_PLACEMENT_JS, DISPATCHER_JS, VIEW_JS]) {
        await page.addScriptTag({ content: js });
    }
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.evaluate(() => {
        const entries: any[] = [
            { name: 'assets', relPath: 'assets', isDir: true },
            { name: 'docs', relPath: 'docs', isDir: true },
            { name: 'f1.txt', relPath: 'f1.txt', isDir: false },
        ];
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
}

/**
 * webview 層から貼り付けを発火する（継ぎ目を通る）。
 * 本番の paste 受け口は document レベル listener で `data-fractal-fv-clip` を読む（ADRL-0118）。
 *
 * 🔴 宛先は **選択行**から解決される（`resolveDstFromRel(selectedRel, isDir)`）— event target ではない。
 * フォルダ行を宛先にしたい場合は先にその行を click して選択する（実装を読んで確認した実挙動）。
 */
async function pasteInto(page: Page, relPaths: string[], selectRel: string | null) {
    if (selectRel) { await page.locator(`.fv-row[data-rel="${selectRel}"]`).click(); }
    return page.evaluate(({ rels, attr }) => {
        const w = window as any;
        w.__calls.length = 0;
        const meta = encodeURIComponent(JSON.stringify({ folderLinkId: 'fl1', relPaths: rels }));
        const html = `<div ${attr}="${meta}"></div>`;
        const target = document.querySelector('.notes-main-wrapper') as HTMLElement;
        const dt = new DataTransfer();
        dt.setData('text/html', html);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt } as any);
        target.dispatchEvent(ev);
        return { calls: w.__calls.slice(), prevented: ev.defaultPrevented };
    }, { rels: relPaths, attr: FV_CLIP_ATTR });
}

test.describe('TASK-11 A-3 フォルダの clipboard 複製（継ぎ目を通る）', () => {
    test('TC-R3-1: フォルダ 1 件の Cmd+V が host に届く（無反応でない）', async ({ page }) => {
        await mountFv(page);
        const { calls, prevented } = await pasteInto(page, ['assets'], null);
        const moves = calls.filter((c: any) => c.type === 'folderViewMove' || c.type === 'folderViewMoveBatch');
        expect(moves.length,
            'フォルダ 1 件の Cmd+V が host に 1 度も届いていない（旧実装は webview が dir を捨てて無反応）').toBeGreaterThan(0);
        expect(prevented, 'paste が preventDefault されていない（本番経路を通っていない）').toBe(true);
        // 複製モード（'copy'）で渡っている
        const args = moves[0].args as any[];
        expect(args[args.length - 1]).toBe('copy');
    });

    test('TC-R3-2: フォルダ行を選択して Cmd+V するとその中が宛先になる', async ({ page }) => {
        await mountFv(page);
        const { calls } = await pasteInto(page, ['f1.txt'], 'docs');
        const moves = calls.filter((c: any) => c.type === 'folderViewMove' || c.type === 'folderViewMoveBatch');
        expect(moves.length).toBeGreaterThan(0);
        // 宛先引数に 'docs' が含まれる（フォルダ行 = その中）
        expect(JSON.stringify(moves[0].args)).toContain('docs');
    });

    test('TC-R3-3: 複数フォルダ + ファイルの混在が全件 host に届く', async ({ page }) => {
        await mountFv(page);
        const { calls } = await pasteInto(page, ['assets', 'docs', 'f1.txt'], null);
        const batch = calls.filter((c: any) => c.type === 'folderViewMoveBatch');
        expect(batch.length, '複数件が batch で届いていない').toBe(1);
        expect((batch[0].args[1] as string[]).sort()).toEqual(['assets', 'docs', 'f1.txt']);
        expect(batch[0].args[3]).toBe('copy');
    });

    test('TC-R3-4: 拒否通知（notifyError）が 0 回', async ({ page }) => {
        await mountFv(page);
        const { calls } = await pasteInto(page, ['assets'], null);
        const errs = calls.filter((c: any) => c.type === 'notifyError');
        expect(errs.length, 'フォルダ複製で拒否通知が出た（dead branch が生きている）').toBe(0);
    });
});

/**
 * host 側の実 fs 検証（webview の継ぎ目は上の describe が担保している）。
 * TC-R3-1h: H 経路でフォルダが実際に複製される（連番）
 * TC-DUP-1: 右クリック Duplicate でフォルダが複製される
 */
import * as os from 'os';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
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

function hostSetup() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h-root-'));
    fs.mkdirSync(path.join(root, 'tmpl', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmpl', 'a.txt'), 'A');
    fs.writeFileSync(path.join(root, 'tmpl', 'sub', 'b.txt'), 'B');
    fs.mkdirSync(path.join(root, 'dst'), { recursive: true });
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-note-'));
    const fm = new NotesFileManager(noteDir);
    fm.loadStructure();
    const linkId = fm.registerFolderLink(root);
    const errors: string[] = [];
    const deps = {
        showErrorMessage: (m: string) => errors.push(m),
        showInformationMessage: () => { /* noop */ },
        t: (k: string) => k,
        trashDelete: async () => { /* noop */ },
        toDisplayUri: (p: string) => p,
        confirmLarge: () => true,
        notifyLimitExceeded: () => { /* noop */ },
        notifyOutcome: () => { /* noop */ },
        renameFs: fs.renameSync,
    };
    return {
        mod, fm, linkId, root, errors, deps,
        sender: { postMessage: () => { /* noop */ } },
        cleanup: () => { for (const d of [root, noteDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } },
    };
}

test.describe('TASK-11 host 側の実 fs 検証', () => {
    test('TC-R3-1h: H（mode=copy）でフォルダが中身ごと複製される', async () => {
        const t = hostSetup();
        try {
            const ok = await t.mod.folderViewMove(
                t.fm, t.linkId, 'tmpl', 'dst', t.deps as any, t.sender, t.deps as any, 'copy');
            expect(ok, `フォルダの複製が失敗した: ${t.errors.join(' | ')}`).toBe(true);
            expect(fs.readFileSync(path.join(t.root, 'dst', 'tmpl', 'a.txt'), 'utf8')).toBe('A');
            expect(fs.readFileSync(path.join(t.root, 'dst', 'tmpl', 'sub', 'b.txt'), 'utf8')).toBe('B');
            // 元は残る（複製）
            expect(fs.existsSync(path.join(t.root, 'tmpl', 'a.txt'))).toBe(true);
            // 拒否通知が出ていない（dead branch が消えた）
            expect(t.errors).toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-DUP-1: 右クリック Duplicate でフォルダが連番で複製される', async () => {
        const t = hostSetup();
        try {
            const ok = await t.mod.folderViewDuplicate(t.fm, t.linkId, 'tmpl', t.deps as any, t.sender);
            expect(ok, `Duplicate が失敗した: ${t.errors.join(' | ')}`).toBe(true);
            // 同じ階層に連番で作られる（`tmpl-1`）
            const names = fs.readdirSync(t.root);
            expect(names.some((n) => /^tmpl-1$/.test(n)), `連番の複製が無い: ${names.join(',')}`).toBe(true);
            expect(fs.readFileSync(path.join(t.root, 'tmpl-1', 'sub', 'b.txt'), 'utf8')).toBe('B');
            expect(t.errors).toEqual([]);
        } finally { t.cleanup(); }
    });
    test('TC-DUP-2: Duplicate は 3 択を出さず連番固定（FR-CFL-02 の例外）', async () => {
        const t = hostSetup();
        try {
            const prompts: any[] = [];
            const depsWithPrompt = Object.assign({}, t.deps, {
                promptConflict: (name: string, count: number) => { prompts.push({ name, count }); return 'abort'; },
            });
            // 1 回目 → tmpl-1 / 2 回目 → tmpl-2（毎回衝突するが 3 択は出さない）
            await t.mod.folderViewDuplicate(t.fm, t.linkId, 'tmpl', depsWithPrompt as any, t.sender);
            await t.mod.folderViewDuplicate(t.fm, t.linkId, 'tmpl', depsWithPrompt as any, t.sender);
            expect(prompts, 'Duplicate で 3 択が出た（衝突が前提の操作なので連番固定が正）').toEqual([]);
            const names = fs.readdirSync(t.root).sort();
            expect(names.includes('tmpl-1')).toBe(true);
            expect(names.includes('tmpl-2'), `2 回目の連番が無い: ${names.join(',')}`).toBe(true);
        } finally { t.cleanup(); }
    });
});
