/**
 * viewer-wiring.spec.ts — host sink 分岐の統合検証 + 分離番人 — TC-FV-32/33/36 + TC-FV-31
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-06（sink 分岐）+ TASK-07（分離番人）。
 * sidePanelManager.tryOpenViewerPanel を vscode モック注入で behavioral 検証（TC-FV-34 と同方式 —
 * notesEditorProvider / outlinerProvider / editorProvider 自体は vscode+panel 依存で unit 直起動
 * 不能のため、共有される判定+message 送信ロジック（tryOpenViewerPanel / isViewerTarget）と
 * 「全 sink が isViewerTarget を参照している」ことの合わせ技で担保。実 VS Code は手動検収）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

function loadWithVscodeMock(): { SidePanelManager: any } {
    const vscodeMock = {
        Uri: {
            file: (p: string) => ({ fsPath: p, path: p, with: () => ({}) }),
            parse: (s: string) => ({ toString: () => s }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath || '', ...parts) }),
        },
        env: { openExternal: async () => {} },
        commands: { executeCommand: async () => {} },
        workspace: {
            fs: { readFile: async () => Buffer.from('') },
            getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
            createFileSystemWatcher: () => ({ onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }),
        },
        window: { showErrorMessage: () => {} },
        RelativePattern: class {},
    };
    const origLoad = Module._load;
    Module._load = function (request: string, ...rest: unknown[]) {
        if (request === 'vscode') { return vscodeMock; }
        return origLoad.call(this, request, ...rest);
    };
    try {
        const modPath = require.resolve('../../src/shared/sidePanelManager');
        delete require.cache[modPath];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return { SidePanelManager: require('../../src/shared/sidePanelManager').SidePanelManager };
    } finally {
        Module._load = origLoad;
    }
}

test.describe('host sink 分岐（FR-FV-01/07, NFR-FV-01 / TASK-06）', () => {

    test('TC-FV-32: viewer 対象は viewer 系 message・対象外は従来経路（tryOpenViewerPanel の返り値契約）', async () => {
        const { SidePanelManager } = loadWithVscodeMock();
        const posted: any[] = [];
        const mgr = new SidePanelManager({
            postMessage: (m: any) => posted.push(m),
            asWebviewUri: (u: any) => ({ toString: () => `wv://${u.fsPath}` }),
        }, {});
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-w32-'));
        try {
            // 【許可: test_update】sprint 20260823-165314（FR-FV-01 改訂）: .docx は viewer 対象化 → true 側へ反転。
            // 「対象外 → 従来経路」の番人は .zip（引き続き対象外）で維持。
            for (const [name, expected] of [['a.html', true], ['b.pdf', true], ['c.docx', true], ['d.zip', false]] as const) {
                fs.writeFileSync(path.join(dir, name), 'x');
                const r = await mgr.tryOpenViewerPanel(path.join(dir, name));
                expect(r, `${name} → viewer=${expected}`).toBe(expected);
            }
            // viewer message の形（kind/fileUri/filePath が揃う）
            const kinds = posted.filter((m) => m.type === 'openViewerPanel').map((m) => m.kind).sort();
            expect(kinds).toEqual(['docx', 'html', 'pdf']);
            for (const m of posted) {
                expect(m.fileUri).toContain('wv://');
                expect(m.filePath).toBeTruthy();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('TC-FV-33: 50MB 超の viewer 対象はフォールバック（viewer 系 message を送らない）', async () => {
        const { SidePanelManager } = loadWithVscodeMock();
        const posted: any[] = [];
        const mgr = new SidePanelManager({
            postMessage: (m: any) => posted.push(m),
            asWebviewUri: (u: any) => ({ toString: () => `wv://${u.fsPath}` }),
        }, {});
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-w33-'));
        try {
            const huge = path.join(dir, 'huge.pdf');
            const fd = fs.openSync(huge, 'w');
            fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1);
            fs.closeSync(fd);
            const r = await mgr.tryOpenViewerPanel(huge);
            expect(r).toBe(false);
            expect(posted.filter((m) => m.type === 'openViewerPanel')).toEqual([]);
            // 境界: ちょうど 50MB は viewer 可
            const exact = path.join(dir, 'exact.pdf');
            const fd2 = fs.openSync(exact, 'w');
            fs.ftruncateSync(fd2, 50 * 1024 * 1024);
            fs.closeSync(fd2);
            expect(await mgr.tryOpenViewerPanel(exact)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('TC-FV-36: 縮退番人 — 表示処理が throw しても例外が漏れない（呼び出し元が openExternal に落とせる）', async () => {
        const { SidePanelManager } = loadWithVscodeMock();
        // postMessage が throw する host（viewer 表示処理の障害を模擬）
        const mgr = new SidePanelManager({
            postMessage: () => { throw new Error('viewer broken'); },
            asWebviewUri: (u: any) => ({ toString: () => `wv://${u.fsPath}` }),
        }, {});
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-w36-'));
        try {
            const pdf = path.join(dir, 'doc.pdf');
            fs.writeFileSync(pdf, 'x');
            // 全 sink は tryOpenViewerPanel を try/catch で包む設計（design §2 ARCH-5）。
            // handleOpenLink 経由（実際の sink #9 の縮退経路）で例外が漏れないことを検証
            let threw = false;
            try {
                await mgr.handleOpenLink(pdf, path.join(dir, 'current.md'));
            } catch { threw = true; }
            expect(threw, 'sink 経由で例外が漏れない（openExternal 縮退）').toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test.describe('ツールバー host 受け口（FR-FV-08 / TASK-15）', () => {

    test('TC-FV-53: viewType 選択ヘルパー — kind→viewType 明示マップ + 未知 kind throw', () => {
        // 共有ヘルパは viewer-target.ts（vscode 非依存 = 3 provider から import 可）
        // 【許可: test_update】sprint 20260823-165314（FR-FV-16 / ADRL-0093）:
        // 旧「未知 kind → fileViewerHtml へ寄せる」既定を廃止 — svg 等の html 面誤爆経路を塞ぐため throw に反転。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { viewerViewType } = require('../../src/shared/viewer-target');
        expect(viewerViewType('pdf')).toBe('fractal.fileViewer');
        expect(viewerViewType('html')).toBe('fractal.fileViewerHtml');
        expect(viewerViewType('docx')).toBe('fractal.fileViewerOffice');
        expect(() => viewerViewType(undefined as any)).toThrow();
    });

    test('TC-VEX-03: package.json customEditors — office=default / text,image=option の 3 viewType 構造', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require('../../package.json');
        const ces: any[] = pkg.contributes.customEditors;
        const byType = (vt: string) => ces.find((c) => c.viewType === vt);
        const office = byType('fractal.fileViewerOffice');
        expect(office.priority).toBe('default');
        expect(office.selector.map((s: any) => s.filenamePattern).sort()).toEqual(['*.docx', '*.pptx', '*.xlsx']);
        const text = byType('fractal.fileViewerText');
        expect(text.priority).toBe('option');
        expect(text.selector.map((s: any) => s.filenamePattern)).toContain('*.txt');
        const image = byType('fractal.fileViewerImage');
        expect(image.priority).toBe('option');
        expect(image.selector.map((s: any) => s.filenamePattern)).toContain('*.svg');
        // 既存 2 viewType の priority 不変（INV-6）
        expect(byType('fractal.fileViewer').priority).toBe('default');
        expect(byType('fractal.fileViewerHtml').priority).toBe('option');
    });

    test('TC-FV-52: notes-message-handler の 4 case が platform メソッドへ委譲する（未実装メソッドは no-op）', async () => {
        // notes-message-handler は transitive に vscode を import するが module-load 時には
        // 触らない（TC-PDF-64 と同じ前提）ため最小 stub で require できる
        const vscodeMock = {
            workspace: { getConfiguration: () => ({ get: () => undefined }) },
            Uri: { file: (p: string) => ({ fsPath: p }) },
            commands: { executeCommand: () => {} },
            window: {},
            env: {},
            ViewColumn: {},
        };
        const origLoad = Module._load;
        Module._load = function (request: string, ...rest: unknown[]) {
            if (request === 'vscode') { return vscodeMock; }
            return origLoad.call(this, request, ...rest);
        };
        let handleNotesMessage: any;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            handleNotesMessage = require('../../src/shared/notes-message-handler').handleNotesMessage;
        } finally {
            Module._load = origLoad;
        }

        const calls: Array<[string, unknown[]]> = [];
        // 明示メソッド集合の recorder（Proxy fake 禁止 — generator_failures 2026-08-09:
        // 任意メソッド名に応答する Proxy は「メソッド欠落で発火しない」防御を検出できない）
        const platform: any = {
            viewerOpenInNewTab: (...a: unknown[]) => { calls.push(['viewerOpenInNewTab', a]); },
            viewerCopyPath: (...a: unknown[]) => { calls.push(['viewerCopyPath', a]); },
            viewerCopyInAppLink: (...a: unknown[]) => { calls.push(['viewerCopyInAppLink', a]); },
            viewerExportFile: (...a: unknown[]) => { calls.push(['viewerExportFile', a]); },
        };
        const noopSender = { postMessage: () => {} };

        await handleNotesMessage({ type: 'viewerOpenInNewTab', filePath: '/tmp/n/files/a.pdf', kind: 'pdf' }, {} as any, noopSender as any, platform);
        await handleNotesMessage({ type: 'viewerCopyPath', filePath: '/tmp/n/files/a.pdf' }, {} as any, noopSender as any, platform);
        await handleNotesMessage({ type: 'viewerCopyInAppLink', filePath: '/tmp/n/files/a.pdf' }, {} as any, noopSender as any, platform);
        await handleNotesMessage({ type: 'viewerExportFile', filePath: '/tmp/n/files/a.pdf' }, {} as any, noopSender as any, platform);

        expect(calls.map((c) => c[0])).toEqual(['viewerOpenInNewTab', 'viewerCopyPath', 'viewerCopyInAppLink', 'viewerExportFile']);
        expect(calls[0][1]).toEqual(['/tmp/n/files/a.pdf', 'pdf']);
        expect(calls[1][1]).toEqual(['/tmp/n/files/a.pdf']);
        expect(calls[2][1]).toEqual(['/tmp/n/files/a.pdf']);
        expect(calls[3][1]).toEqual(['/tmp/n/files/a.pdf']);

        // platform が該当メソッドを持たない面（optional 委譲）は throw せず no-op
        let threw = false;
        try {
            await handleNotesMessage({ type: 'viewerCopyPath', filePath: '/tmp/x.pdf' }, {} as any, noopSender as any, {} as any);
        } catch { threw = true; }
        expect(threw, '未実装 platform でも例外を投げない').toBe(false);
    });
});

test.describe('分離番人（NFR-FV-02 / TASK-07）', () => {

    test('TC-FV-31: viewer 新規ファイル群から md 系への import/require/window 参照が 0 件', () => {
        const ROOT = path.join(__dirname, '..', '..');
        const viewerFiles = [
            'src/shared/viewer-target.ts',
            'src/fileViewerProvider.ts',
            'src/fileViewerContent.ts',
            'src/webview/file-viewer.js',
            'src/webview/viewer-side-panel.js',
            'src/shared/viewer-dispatcher.js',
        ];
        // 禁止参照: md 実装のモジュール（import/require）と window グローバル（TDD-1 — 既存コード
        // ベースの結合は window 経由が主流のため import grep だけでは素通しになる）。
        // md→viewer 方向の optional hook（__viewerSidePanel / __viewerDispatcher）は対象外。
        const forbidden = [
            /require\(['"][^'"]*(?:editor|outliner-cell|notes-md-dispatcher)[^'"]*['"]\)/,
            /import[^;]*from\s+['"][^'"]*(?:editor|outliner-cell|notes-md-dispatcher)[^'"]*['"]/,
            /window\.EditorInstance/,
            /window\.SidePanelHostBridge/,
            /window\.notesMdDispatcher/,
            /window\.notesMarkdownHostBridge/,
        ];
        for (const rel of viewerFiles) {
            const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const re of forbidden) {
                expect(re.test(content), `${rel} に禁止参照 ${re} が無い`).toBe(false);
            }
        }
    });
});

// ── sprint 20260823-165314-viewer-office-text-image TASK-06（TC-VEX-10/11） ──────────────
test.describe('viewer モジュール config 注入 + CSP 同期（NFR-VEX-06 / FR-FV-18）', () => {

    const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
    function purgeSrcCache(): void {
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
        }
    }
    function requireWithVscodeStub(modulePath: string): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Mod = require('module');
        const origLoad = Mod._load;
        purgeSrcCache();
        const stub = {
            workspace: { getConfiguration: () => ({ get: () => undefined }) },
            Uri: {
                file: (p: string) => ({ fsPath: p, toString: () => 'file://' + p }),
                joinPath: (base: any, ...parts: string[]) => {
                    const fsPath = path.join((base && base.fsPath) || '', ...parts);
                    return { fsPath, toString: () => 'file://' + fsPath };
                },
            },
            window: {}, env: {}, EventEmitter: class { },
        };
        Mod._load = function (request: string) {
            if (request === 'vscode') { return stub; }
            // eslint-disable-next-line prefer-rest-params
            return origLoad.apply(this, arguments as any);
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require(modulePath);
        } finally {
            Mod._load = origLoad;
            purgeSrcCache();
        }
    }
    const ROOT2 = path.join(__dirname, '..', '..');
    const webviewStub = {
        asWebviewUri: (u: any) => 'vscode-resource://' + ((u && u.fsPath) || String(u)),
        cspSource: 'vscode-webview:',
    };

    function buildStandaloneHtml(): string {
        const { getFileViewerHtml } = requireWithVscodeStub('../../src/fileViewerContent');
        return getFileViewerHtml(webviewStub, { fsPath: ROOT2 }, { fsPath: '/tmp/a.pdf' }, 'pdf');
    }
    function buildNotesHtml(): string {
        const { getNotesWebviewContent } = requireWithVscodeStub('../../src/notesWebviewContent');
        const config = {
            webviewMessages: {}, fontSize: 14, theme: 'light', toolbarMode: 'full',
            showTranslateButtons: false, showOpenInTextEditor: false, enableDebugLogging: false,
            documentBaseUri: '', folderName: 'note',
        };
        const initData = {
            jsonContent: JSON.stringify({ version: 1, rootIds: [], nodes: {} }),
            currentFilePath: '/x/a.out', currentFileTitle: 'a', fileChangeId: 0, fileList: [],
            structure: { version: 1, rootIds: [], items: {} }, history: [], historyPanelCollapsed: true,
            historyPanelHeight: 120, initialMd: null, noteFolderName: 'note',
            noteSidePanelWidth: null, noteSidePanelOutlineWidth: null,
        };
        return getNotesWebviewContent(webviewStub, { fsPath: ROOT2 }, config as any, initData as any);
    }
    function buildOutlinerHtml(): string {
        const { getOutlinerWebviewContent } = requireWithVscodeStub('../../src/outlinerWebviewContent');
        return getOutlinerWebviewContent(webviewStub, { fsPath: ROOT2 },
            JSON.stringify({ version: 1, rootIds: [], nodes: {} }), { webviewMessages: {} } as any, 'k1');
    }

    test('TC-VEX-10: 生成 HTML 3 面すべてに viewerModuleUris（5 kind）が注入される', () => {
        for (const [name, html] of [
            ['fileViewerContent', buildStandaloneHtml()],
            ['notesWebviewContent', buildNotesHtml()],
            ['outlinerWebviewContent', buildOutlinerHtml()],
        ] as const) {
            expect(html, `${name}: viewerModuleUris マーカー`).toContain('viewerModuleUris');
            for (const kind of ['text', 'image', 'docx', 'xlsx', 'pptx']) {
                expect(html, `${name}: viewer-${kind}.mjs の URI`).toContain(`viewer-${kind}.mjs`);
            }
        }
    });

    test('TC-VEX-11: CSP 4 箇所同期 — img-src blob:（4 箇所）+ fileViewerContent の font-src', () => {
        const standalone = buildStandaloneHtml();
        const cspOf = (html: string): string => {
            const m = /Content-Security-Policy" content="([^"]+)"/.exec(html);
            expect(m).not.toBeNull();
            return m![1];
        };
        const sCsp = cspOf(standalone);
        expect(/img-src[^;]*blob:/.test(sCsp), 'standalone img-src blob:').toBe(true);
        expect(/font-src[^;]*blob:/.test(sCsp), 'standalone font-src blob:').toBe(true);
        expect(sCsp.includes('unsafe-eval'), 'unsafe-eval を追加しない').toBe(false);
        for (const [name, html] of [['notes', buildNotesHtml()], ['outliner', buildOutlinerHtml()]] as const) {
            const c = cspOf(html);
            expect(/img-src[^;]*blob:/.test(c), `${name} img-src blob:`).toBe(true);
        }
        // 4 箇所目 = テストハーネス（build-standalone-viewer.js のソースが本番と同期しているか）
        const harness = fs.readFileSync(path.join(ROOT2, 'test', 'build-standalone-viewer.js'), 'utf8');
        expect(/img-src[^\n]*blob:/.test(harness), 'ハーネス CSP img-src blob:').toBe(true);
        expect(/font-src[^\n]*blob:/.test(harness), 'ハーネス CSP font-src blob:').toBe(true);
    });
});
