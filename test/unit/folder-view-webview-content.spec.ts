/**
 * Sprint 20260817-053313-notetree-local-folder-view — TASK-11（reviewer iter1 QUAL-1）
 * TC-FLV-50: 本番 webview 配線の契約番人。
 *
 * notesWebviewContent.ts（本番 notes webview の HTML 生成 — standalone ハーネスとは別の
 * 手動 inline リスト）に folder-view 2 モジュールが nonce script として埋め込まれることを、
 * 生成 HTML を実際に作って assert する（counterfactual: inline 登録を外すと RED）。
 * standalone ハーネス側の登録は TC-FLV-44 ③④ が番人 — 本 TC は本番側の対。
 * generator_failures 2026-08-17「ハーネスにだけ登録し本番 inline を落とす」の再発防止。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;

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
    const stub = {
        workspace: { getConfiguration: () => ({ get: () => undefined }) },
        Uri: {
            file: (p: string) => ({ fsPath: p, toString: () => 'file://' + p }),
            joinPath: (base: any, ...parts: string[]) => {
                const fsPath = path.join((base && base.fsPath) || '', ...parts);
                return { fsPath, toString: () => 'file://' + fsPath };
            },
        },
        window: {},
        env: {},
        EventEmitter: class {},
    };
    Module._load = function (request: string) {
        if (request === 'vscode') { return stub; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        // 残さない: 本 spec の限定 stub 下で評価した cache を後続 spec に渡さない
        //（「掴まない（require 直前 purge）」と対 — generator_failures 2026-08-17 の対称防御）
        purgeSrcCache();
    }
}

test.describe('TC-FLV-50 — 本番 notes webview に folder-view 2 モジュールが inline される', () => {

    test('生成 HTML に __folderViewDispatcher / __folderView の定義が含まれる（viewer-dispatcher より後）', () => {
        const { getNotesWebviewContent } = requireWithVscodeStub('../../src/notesWebviewContent');
        const webview = {
            asWebviewUri: (u: any) => 'vscode-resource://' + ((u && u.fsPath) || String(u)),
            cspSource: 'vscode-webview:',
        };
        const extensionUri = { fsPath: ROOT };
        const config = {
            webviewMessages: {},
            fontSize: 14,
            theme: 'light',
            toolbarMode: 'full',
            showTranslateButtons: false,
            showOpenInTextEditor: false,
            enableDebugLogging: false,
            documentBaseUri: '',
            folderName: 'note',
        };
        const initData = {
            jsonContent: JSON.stringify({ version: 1, rootIds: [], nodes: {} }),
            currentFilePath: '/x/a.out',
            currentFileTitle: 'a',
            fileChangeId: 0,
            fileList: [],
            structure: { version: 1, rootIds: [], items: {} },
            history: [],
            historyPanelCollapsed: true,
            historyPanelHeight: 120,
            initialMd: null,
            noteFolderName: 'note',
            noteSidePanelWidth: null,
            noteSidePanelOutlineWidth: null,
            panelCollapsed: false,
            panelWidth: null,
        };
        const html: string = getNotesWebviewContent(webview as any, extensionUri as any, config as any, initData as any);
        expect(typeof html).toBe('string');
        expect(html.length).toBeGreaterThan(10000);
        // folder-view-dispatcher.js の定義（window.__folderViewDispatcher = { ... }）が inline されている
        expect(html.includes('window.__folderViewDispatcher'), 'folder-view-dispatcher.js の本番 inline').toBe(true);
        // notes-folder-view.js の定義（window.__folderView = { open, destroy }）が inline されている
        expect(html.includes('window.__folderView ='), 'notes-folder-view.js の本番 inline').toBe(true);
        // 読み込み順: viewer-dispatcher（排他 hook の参照先）より後（TASK-11 の宣言どおり）
        const viewerIdx = html.indexOf('window.__viewerDispatcher');
        const fvIdx = html.indexOf('window.__folderViewDispatcher');
        expect(viewerIdx, '前提: viewer-dispatcher が inline 済み').toBeGreaterThan(-1);
        expect(fvIdx).toBeGreaterThan(viewerIdx);
    });
});
