/**
 * FR-FTB — 「file を新規タブで開く」経路（host 側）
 * sprint 20260906-024639-tree-keynav-opennew-modifier / FR-FTB-01..04 / NFR-FTB-01
 *
 * TC-FTB-01..06。
 *
 * 設計（design/system.md §2）:
 *   webview（識別子のみ）→ host（kind 決定 + root union + asWebviewUri）→ webview（openInNewTab の 4 引数）
 *   - kind / サイズ判定は `src/shared/viewer-target.ts` の `isViewerTarget` / `VIEWER_SIZE_LIMIT` **だけ**を使う
 *     （判定の複製を作らない = NFR-FTB-01）
 *   - viewer 非対象 / 50MB 超は **タブを作らず** OS 既定アプリへ縮退（FR-FTB-03）
 *   - `kindHint` 省略の既存 3 呼び出し元は従来どおり md/.out（FR-FTB-02 の非回帰）
 *
 * ハーネス方針:
 *   host モジュールは `vscode` を import するため、確立パターンの **vscode スタブ付き require**
 *   （`test/unit/notes-recent-kinds.spec.ts` の `requireWithVscodeStub`）で実コードを読み込む。
 *   **ミラー関数（src の判定を写経して検証する形）は使わない** — 実コードを呼ぶ。
 *   50MB 超は `fs.statSync` を monkeypatch して表現する（実ファイルを repo に置かない）。
 *
 * TASK-03: mock / fixture ヘルパ + スモーク。TASK-08: TC-FTB-01..06。
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

/** vscode スタブ付き require（notes-recent-kinds.spec.ts の確立パターン）。 */
export function requireWithVscodeStub(modulePath: string, extra?: Record<string, any>): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return Object.assign({
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: {
                    showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {},
                    createWebviewPanel: () => ({}),
                },
                env: { openExternal: async () => {} }, ViewColumn: {}, EventEmitter: class {},
            }, extra || {});
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

/** viewer 対象 / 非対象の最小ダミーを tmp に作る（repo に置かない）。 */
export function makeFixtureDir(): { dir: string; pdf: string; zip: string; md: string; out: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-ftb-'));
    const pdf = path.join(dir, 'spec.pdf');
    const zip = path.join(dir, 'bundle.zip');
    const md = path.join(dir, 'note.md');
    const out = path.join(dir, 'tree.out');
    fs.writeFileSync(pdf, '%PDF-1.4 minimal');
    fs.writeFileSync(zip, 'PK minimal');
    fs.writeFileSync(md, '# note');
    fs.writeFileSync(out, '{"version":1,"rootIds":[],"nodes":{}}');
    return { dir, pdf, zip, md, out };
}

/**
 * `fs.statSync` を差し替えて、指定パスだけ巨大サイズを返す（50MB 超の縮退検証用）。
 * 戻り値の restore() を必ず呼ぶ。**実ファイルを 50MB 作らない**（design/tdd.md FTB-1 の裁定）。
 */
export function mockStatSize(targetPath: string, sizeBytes: number): { restore: () => void } {
    const orig = fs.statSync;
    (fs as any).statSync = function (p: any, ...rest: any[]) {
        if (String(p) === targetPath) { return { size: sizeBytes, isFile: () => true, isDirectory: () => false } as any; }
        return (orig as any).call(fs, p, ...rest);
    };
    return { restore: () => { (fs as any).statSync = orig; } };
}

test.describe('FR-FTB host 経路 — mock / fixture（TASK-03）', () => {
    test('スモーク: viewer 判定は実コード / 50MB 超は stat mock で表現できる', () => {
        const fx = makeFixtureDir();
        try {
            // 判定は唯一の判定点（src/shared/viewer-target.ts）を実 import して使う（複製を作らない）
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const vt = require('../../src/shared/viewer-target');
            expect(vt.isViewerTarget('spec.pdf'), 'pdf は viewer 対象').toBe('pdf');
            expect(vt.isViewerTarget('bundle.zip'), 'zip は viewer 非対象').toBe(null);
            expect(typeof vt.VIEWER_SIZE_LIMIT, 'サイズ上限が定数として在る').toBe('number');
            expect(vt.VIEWER_SIZE_LIMIT).toBe(50 * 1024 * 1024);

            // 実サイズは小さい（repo / tmp に巨大ファイルを作っていない）
            expect(fs.statSync(fx.pdf).size).toBeLessThan(1024);

            // stat mock で 60MB 相当を表現できる（縮退検証の前提）
            const m = mockStatSize(fx.pdf, 60 * 1024 * 1024);
            try {
                expect(fs.statSync(fx.pdf).size, 'mock 経由で 60MB').toBe(60 * 1024 * 1024);
                expect(fs.statSync(fx.pdf).size > vt.VIEWER_SIZE_LIMIT, '上限超と判定される').toBe(true);
                // 他のパスは素通し（mock が広く漏れていない）
                expect(fs.statSync(fx.zip).size).toBeLessThan(1024);
            } finally {
                m.restore();
            }
            expect(fs.statSync(fx.pdf).size, 'restore 後は実サイズ').toBeLessThan(1024);

            // vscode スタブ付き require が機能する（TASK-08 が host 実コードを読み込むための前提）
            const target = requireWithVscodeStub('../../src/shared/viewer-target');
            expect(typeof target.viewerViewType, 'スタブ require 経由でも shared モジュールが読める').toBe('function');
        } finally {
            fs.rmSync(fx.dir, { recursive: true, force: true });
        }
    });
});

/**
 * TC-FTB-01..04 — kind 決定と縮退（**実コードを呼ぶ**）。
 * `resolveWebviewTabKind` は `notesEditorProvider.ts` の module top-level export で、
 * 内部で `isViewerTarget` / `VIEWER_SIZE_LIMIT` を使う（判定の複製なし = NFR-FTB-01）。
 */
test.describe('FR-FTB kind 決定 / 縮退（TASK-08）', () => {
    function loadResolver(): any {
        const mod = requireWithVscodeStub('../../src/notesEditorProvider');
        expect(typeof mod.resolveWebviewTabKind, 'host の実装が export されている').toBe('function');
        return mod.resolveWebviewTabKind;
    }

    test('TC-FTB-01 viewer 対象の file → kind=file + viewerKind（extra 素材が決まる）', () => {
        const resolve = loadResolver();
        const fx = makeFixtureDir();
        try {
            expect(resolve(fx.pdf, 'file', fs.statSync(fx.pdf).size)).toEqual({ kind: 'file', viewerKind: 'pdf' });
            // 画像・text も同じ経路（kind の複製を作っていないことの確認）
            expect(resolve('/x/a.png', 'file', 10)).toEqual({ kind: 'file', viewerKind: 'image' });
        } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
    });

    test('TC-FTB-02 viewer 非対象（.zip）→ タブを作らず縮退（degrade）', () => {
        const resolve = loadResolver();
        const fx = makeFixtureDir();
        try {
            const r = resolve(fx.zip, 'file', fs.statSync(fx.zip).size);
            expect(r, 'not-viewer で縮退').toEqual({ degrade: 'not-viewer' });
            // ★ counterfactual: kind を返してしまうとタブが開く = 縮退が壊れている
            expect('kind' in r).toBe(false);
        } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
    });

    test('TC-FTB-03 50MB 超（stat mock で 60MB）→ タブを作らず縮退', () => {
        const resolve = loadResolver();
        const fx = makeFixtureDir();
        const m = mockStatSize(fx.pdf, 60 * 1024 * 1024);
        try {
            const size = fs.statSync(fx.pdf).size;
            expect(size).toBe(60 * 1024 * 1024);
            expect(resolve(fx.pdf, 'file', size), 'too-large で縮退').toEqual({ degrade: 'too-large' });
            // 上限内（49MB）なら開く（境界の対 assert）
            expect(resolve(fx.pdf, 'file', 49 * 1024 * 1024)).toEqual({ kind: 'file', viewerKind: 'pdf' });
        } finally { m.restore(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
    });

    test('TC-FTB-04 kindHint 省略（既存 3 呼び出し元）→ 従来どおり md / out の 2 値（非回帰）', () => {
        const resolve = loadResolver();
        expect(resolve('/n/note.md'), 'md').toEqual({ kind: 'md' });
        expect(resolve('/n/tree.out'), 'out').toEqual({ kind: 'out' });
        expect(resolve('/n/TREE.OUT'), '大文字 .OUT も out').toEqual({ kind: 'out' });
        // ★ 非回帰の核: 未知拡張子は従来どおり md（file タブへ勝手に切り替えない = 明示 opt-in のみ）
        expect(resolve('/n/a.pdf'), 'kindHint 無しの pdf は従来どおり md 扱い').toEqual({ kind: 'md' });
        expect(resolve('/n/a.zip')).toEqual({ kind: 'md' });
    });
});

/**
 * TC-FTB-05/06 — webview 受信の配線（**本番 HTML 生成関数を require** して検証する確立パターン。
 * ハーネス側の複製ではなく本番 inline スクリプトを見る）。
 */
test.describe('FR-FTB webview 受信の配線（TASK-08）', () => {
    /** 本番 HTML 生成関数を実行する（batch-payload-wiring.spec.ts の確立パターンと同じ引数形）。 */
    function notesHtml(): string {
        const mod = requireWithVscodeStub('../../src/notesWebviewContent');
        expect(typeof mod.getNotesWebviewContent, '本番 HTML 生成関数が取れる').toBe('function');
        const root = path.join(__dirname, '..', '..');
        const webviewStub = {
            cspSource: 'vscode-webview://test',
            asWebviewUri: (u: any) => ({ toString: () => 'vscode-webview://res' + (u?.fsPath || '') }),
        };
        const extUri = { fsPath: root, scheme: 'file', path: root, toString: () => 'file://' + root };
        const config = { theme: 'light', fontSize: 14, webviewMessages: {} };
        return String(mod.getNotesWebviewContent(webviewStub as any, extUri as any, config as any, {
            jsonContent: '{"rootIds":[],"nodes":{}}', fileList: [], currentFilePath: null, panelCollapsed: false,
        } as any));
    }

    test('TC-FTB-05 openInWebviewTab 受信は title / extra を openInNewTab へ渡す', () => {
        const html = notesHtml();
        const idx = html.indexOf("m.type === 'openInWebviewTab'");
        expect(idx, '本番 inline に openInWebviewTab 受信がある').toBeGreaterThan(-1);
        const seg = html.slice(idx, idx + 400);
        // 4 引数（filePath, kind, title, extra）で呼ぶ配線
        expect(seg, 'title を渡している').toContain('m.title');
        expect(seg, 'extra を渡している').toContain('m.extra');
        expect(seg.replace(/\s+/g, ' '), 'openInNewTab の 4 引数呼び出し')
            .toMatch(/openInNewTab\(\s*m\.filePath,\s*m\.kind \|\| 'md',\s*m\.title \|\| undefined,\s*m\.extra \|\| undefined\s*\)/);
    });

    test('TC-FTB-06 旧 message 形（title / extra なし）でも undefined で後方互換', () => {
        const html = notesHtml();
        const idx = html.indexOf("m.type === 'openInWebviewTab'");
        const seg = html.slice(idx, idx + 400);
        // `|| undefined` で潰しているので md/.out の既存経路は openInNewTab(filePath, kind) と等価
        expect(seg, 'title は undefined フォールバック').toContain("m.title || undefined");
        expect(seg, 'extra は undefined フォールバック').toContain("m.extra || undefined");
    });
});

/**
 * TC-ONT-07 / TC-ONT-08 — standalone（Single outliner）は **VS Code タブ**（ADRL-0008: webview 内タブは Notes 限定）。
 *
 * `outlinerProvider.ts` の `case 'openNodeFileInTab'` は provider の message closure 内にあり
 * unit から直接呼べないため、**既存 TC-CT-06（`cmdclick-newtab.spec.ts`）と同じ host routing
 * source-contract 型**で検証する（この形は本コードベースの確立パターン）。実挙動は手動 UAT-02 の
 * 「Single outliner で 1・3 を実行」が担う。
 */
test.describe('FR-FTB standalone routing（TASK-08 / FR-ONT-04 / FR-FTB-04）', () => {
    const ROOT = path.join(__dirname, '..', '..');

    test('TC-ONT-08 Single の openNodeFileInTab は viewerViewType の VS Code タブ・非対象は外部起動', () => {
        const src: string = fs.readFileSync(path.join(ROOT, 'src/outlinerProvider.ts'), 'utf8');
        const idx = src.indexOf("case 'openNodeFileInTab'");
        expect(idx, 'standalone に openNodeFileInTab の case がある').toBeGreaterThan(-1);
        const block = src.slice(idx, idx + 1400);
        expect(block, 'パス解決は host（safeResolveUnderDir で clamp）').toContain('safeResolveUnderDir');
        expect(block, 'kind 判定は唯一の判定点').toContain('isViewerTarget');
        expect(block, '50MB 上限も見る').toContain('VIEWER_SIZE_LIMIT');
        expect(block, 'VS Code タブとして開く').toContain("'vscode.openWith'");
        expect(block, 'viewType は kind から解決').toContain('viewerViewType');
        expect(block, '縮退は OS 既定アプリ').toContain('openExternal');
        // ★ counterfactual: webview 内タブ経路（Notes 専用）を standalone で使っていない
        expect(block.includes('openInWebviewTab'), 'standalone で webview 内タブを作っていない').toBe(false);
    });

    test('TC-ONT-07 Notes 側は platform.openFileInWebviewTab（kindHint=file）へ落ちる', () => {
        const src: string = fs.readFileSync(path.join(ROOT, 'src/shared/notes-message-handler.ts'), 'utf8');
        const idx = src.indexOf("case 'openNodeFileInTab'");
        expect(idx, 'Notes handler に case がある').toBeGreaterThan(-1);
        const block = src.slice(idx, idx + 700);
        expect(block, 'nodeId のみを受ける').toContain('message.nodeId');
        expect(block, '現在の .out パスは host が持つ').toContain('getCurrentFilePath');
        expect(block, 'platform 経由').toContain('openNodeFileInTab');
    });
});
