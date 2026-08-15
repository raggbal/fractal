/**
 * viewer-wiring-sidepanel.spec.ts — sink #9（sidePanelManager.handleOpenLink）の host 分岐 — TC-FV-34
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-04（design-review REQ-2/TDD-4 反映）。
 * sidePanelManager は vscode import を持つため直 import できない — tryOpenViewerPanel の
 * ロジック検証は「shared isViewerTarget + サイズ判定 + message 送信」の分岐を、
 * vscode モック注入済みの module 読み込みで behavioral に行う。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vscode モジュールを解決できないため、Module._load を差し替えて注入する（既存 precedent:
// vscode 依存 shared のテストで使われる require フック方式）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

function loadSidePanelManagerWithMock(): { SidePanelManager: any; openExternalCalls: string[] } {
    const openExternalCalls: string[] = [];
    const vscodeMock = {
        Uri: {
            file: (p: string) => ({ fsPath: p, path: p, with: () => ({ }) }),
            parse: (s: string) => ({ toString: () => s }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath || '', ...parts) }),
        },
        env: { openExternal: async (uri: any) => { openExternalCalls.push(uri.fsPath || String(uri)); } },
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
        // require キャッシュを消して再ロード
        const modPath = require.resolve('../../src/shared/sidePanelManager');
        delete require.cache[modPath];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('../../src/shared/sidePanelManager');
        return { SidePanelManager: mod.SidePanelManager, openExternalCalls };
    } finally {
        Module._load = origLoad;
    }
}

test.describe('sink #9: sidePanelManager.tryOpenViewerPanel（FR-FV-01/05 / TC-FV-34）', () => {

    test('TC-FV-34: viewer 対象 → openViewerPanel message / 対象外 → false（openExternal 経路へ）', async () => {
        const { SidePanelManager, openExternalCalls } = loadSidePanelManagerWithMock();
        const posted: any[] = [];
        const host = {
            postMessage: (m: any) => { posted.push(m); },
            asWebviewUri: (u: any) => ({ toString: () => `vscode-resource://${u.fsPath || u.path}` }),
        };
        const mgr = new SidePanelManager(host, {});

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-sink9-'));
        try {
            const pdf = path.join(dir, 'doc.pdf');
            fs.writeFileSync(pdf, 'x');
            const zip = path.join(dir, 'a.zip');
            fs.writeFileSync(zip, 'x');

            // viewer 対象 → true + openViewerPanel message
            const r1 = await mgr.tryOpenViewerPanel(pdf);
            expect(r1).toBe(true);
            const msg = posted.find((m) => m.type === 'openViewerPanel');
            expect(msg).toBeTruthy();
            expect(msg.kind).toBe('pdf');
            expect(msg.filePath).toBe(pdf);

            // 対象外 → false（呼び出し元が openExternal に落とす）
            const r2 = await mgr.tryOpenViewerPanel(zip);
            expect(r2).toBe(false);

            // 実体なし → false
            const r3 = await mgr.tryOpenViewerPanel(path.join(dir, 'ghost.html'));
            expect(r3).toBe(false);

            // 50MB 超 → false（フォールバック — sparse で作る）
            const huge = path.join(dir, 'huge.pdf');
            const fd = fs.openSync(huge, 'w');
            fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1);
            fs.closeSync(fd);
            const r4 = await mgr.tryOpenViewerPanel(huge);
            expect(r4).toBe(false);
            expect(openExternalCalls.length, 'tryOpenViewerPanel 自身は openExternal を呼ばない（呼び出し元の責務）').toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
