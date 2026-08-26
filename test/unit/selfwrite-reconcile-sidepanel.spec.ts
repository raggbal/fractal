/**
 * selfwrite-reconcile-sidepanel — 自己保存の残響イベントで巻き戻さない（FR-LV-06 site 2）
 * sprint 20260825-055613-livereload-selfsave-revert TASK-03
 *
 * TC-SWR-02: 遅延した自己保存イベントの reconcile が後続 handleSave（applyEdit 済み・disk 反映前）と
 *   重なっても、doc を旧 disk 内容へ巻き戻さない（stale `sidePanelMessage type:'update'` push = 0 件）。
 *   counterfactual: _reconcileExternal の isRecentSelfWrite 照合を外すと RED。
 * ハーネス: external-edit-reconcile.spec.ts の fake vscode/fs + Module._load stub を複製し saveDelay を拡張。
 */
import { test, expect } from '@playwright/test';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeVscodeEnv(initial: string) {
    const state = {
        diskContent: initial,
        docContent: initial,
        applyEditDelay: 0,
        saveDelay: 0,
        saveCount: 0,
        fswChangeHandlers: [] as Array<() => void>,
        fswCreateHandlers: [] as Array<() => void>,
        watchFileListeners: [] as Array<(c: any, p: any) => void>,
    };
    const doc = {
        uri: { fsPath: '/fake/note/page.md', toString: () => 'file:///fake/note/page.md' },
        isClosed: false,
        getText: () => state.docContent,
        positionAt: (_n: number) => ({ line: 0, character: 0 }),
        lineCount: 1,
        save: async () => {
            if (state.saveDelay) { await wait(state.saveDelay); }
            state.saveCount++;
            state.diskContent = state.docContent;
            return true;
        },
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
            applyEdit: async (edit: any) => {
                if (state.applyEditDelay) { await wait(state.applyEditDelay); }
                if (edit._content !== null) { state.docContent = edit._content; }
                return true;
            },
            onDidChangeTextDocument: (_h: any) => ({ dispose: () => {} }),
            createFileSystemWatcher: () => ({
                onDidChange: (h: () => void) => { state.fswChangeHandlers.push(h); return { dispose: () => {} }; },
                onDidCreate: (h: () => void) => { state.fswCreateHandlers.push(h); return { dispose: () => {} }; },
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
    };
    return { vscodeNs, fsNs, state, doc };
}

function loadManagerWithStub(modulePath: string, vscodeNs: any, fsNs: any): any {
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request: string, ...rest: any[]) {
        if (request === 'vscode') { return vscodeNs; }
        if (request === 'fs' && rest[0] && String(rest[0].filename || '').includes('src/shared')) { return fsNs; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        Object.keys(require.cache).filter((k) => k.includes('/src/shared/')).forEach((k) => { delete require.cache[k]; });
        const resolved = require.resolve(modulePath);
        delete require.cache[resolved];
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        Object.keys(require.cache).filter((k) => k.includes('/src/shared/')).forEach((k) => { delete require.cache[k]; });
    }
}

const spUpdates = (messages: any[]) =>
    messages.filter((m) => m.type === 'sidePanelMessage' && m.data?.type === 'update');

test.describe('FR-LV-06 site 2: sidePanelManager 自己保存残響の no-op', () => {

    test('TC-SWR-02: 遅延自己保存イベント × 後続 handleSave 中でも巻き戻さない', async () => {
        const env = makeFakeVscodeEnv('- item');
        const { SidePanelManager } = loadManagerWithStub('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const messages: any[] = [];
        const host = {
            postMessage: (m: any) => { messages.push(m); return Promise.resolve(true); },
            asWebviewUri: (u: any) => ({ toString: () => `webview://${u.fsPath}` }),
        };
        const mgr = new SidePanelManager(host, { logPrefix: '[T]' });
        await mgr.setupFileWatcher('/fake/note/page.md');

        // save#1 完了（doc=disk='- itemX'・台帳記録）
        await mgr.handleSave('/fake/note/page.md', '- itemX');
        expect(env.state.diskContent).toBe('- itemX');

        // save#1 の残響イベントが遅延到着 → 直後に backspace 削除の save#2（disk 反映は 400ms 後）
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        env.state.saveDelay = 400; // TASK-08: 実時間タイミングのマージン拡大（debounce100ms+wait200ms に対し ±200ms 級の両側余裕）
        const save2 = mgr.handleSave('/fake/note/page.md', '- item');
        await wait(200);
        await save2;
        await wait(300);

        expect(spUpdates(messages).length, '自己保存イベントで stale update が飛ばない').toBe(0);
        expect(env.state.docContent, 'backspace の削除結果（doc）').toBe('- item');
        expect(env.state.diskContent, 'backspace の削除結果（disk）').toBe('- item');
        mgr.disposeFileWatcher();
    });
});
