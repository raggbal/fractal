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
            for (const [name, expected] of [['a.html', true], ['b.pdf', true], ['c.docx', false], ['d.zip', false]] as const) {
                fs.writeFileSync(path.join(dir, name), 'x');
                const r = await mgr.tryOpenViewerPanel(path.join(dir, name));
                expect(r, `${name} → viewer=${expected}`).toBe(expected);
            }
            // viewer message の形（kind/fileUri/filePath が揃う）
            const kinds = posted.filter((m) => m.type === 'openViewerPanel').map((m) => m.kind).sort();
            expect(kinds).toEqual(['html', 'pdf']);
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
