/**
 * selfwrite-reconcile-notes — 自己保存の残響イベントで巻き戻さない（FR-LV-06 site 1 / FR-LV-07）
 * sprint 20260825-055613-livereload-selfsave-revert TASK-02
 *
 * ハーネス: test/unit/external-edit-reconcile.spec.ts の fake vscode/fs + Module._load stub 方式を
 * 複製し、doc.save() に saveDelay（disk 反映の遅れ）を追加（design/system/selfwrite-ledger.md §6）。
 *
 * TC-SWR-01: 遅延した自己保存イベントの reconcile が後続 handleSave（applyEdit 済み・disk 反映前）と
 *   重なっても、doc を旧 disk 内容へ巻き戻さない（stale updateData push = 0 件）。
 *   counterfactual: _reconcileExternal の isRecentSelfWrite 照合を外すと RED（修正前の実測 = 巻き戻り）。
 * TC-SWR-06: 台帳に無い内容（真の外部編集）は従来どおり適用される（FR-LV-07 回帰 pin）。
 * TC-SWR-07: reconcile 自身が適用した外部内容は台帳に記録され、その save の残響イベントが
 *   後続の自己編集と重なっても巻き戻さない（記録点の網羅番人 — 適用時 record を外すと RED）。
 */
import { test, expect } from '@playwright/test';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeVscodeEnv(initial: string) {
    const state = {
        diskContent: initial,
        docContent: initial,
        applyEditDelay: 0,
        saveDelay: 0,                 // doc.save() の擬似所要時間（disk 反映の遅れを作る）
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
        // 「掴まない」purge（require 前）+「残さない」purge（finally）を対で（generator_failures 2026-08-17）
        Object.keys(require.cache).filter((k) => k.includes('/src/shared/')).forEach((k) => { delete require.cache[k]; });
        const resolved = require.resolve(modulePath);
        delete require.cache[resolved];
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        Object.keys(require.cache).filter((k) => k.includes('/src/shared/')).forEach((k) => { delete require.cache[k]; });
    }
}

function collectMessages() {
    const messages: any[] = [];
    return {
        messages,
        host: {
            postMessage: (m: any) => { messages.push(m); return Promise.resolve(true); },
            asWebviewUri: (u: any) => ({ toString: () => `webview://${u.fsPath}` }),
        },
    };
}

const staleUpdates = (messages: any[]) =>
    messages.filter((m) => m.type === 'updateData' && m.kind === 'md' && m.externalUpdate);

test.describe('FR-LV-06 site 1: notesMdMainManager 自己保存残響の no-op', () => {

    test('TC-SWR-01: 遅延自己保存イベント × 後続 handleSave 中でも巻き戻さない', async () => {
        const env = makeFakeVscodeEnv('- item');
        const { NotesMdMainManager } = loadManagerWithStub('../../src/shared/notesMdMainManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new NotesMdMainManager(host);
        await mgr.setupFileWatcher('/fake/note/page.md');

        // save#1: 「- itemX」まで入力 → auto-save 完了（doc=disk='- itemX'・台帳に記録される）
        await mgr.handleSave('/fake/note/page.md', '- itemX');
        expect(env.state.diskContent).toBe('- itemX');

        // save#1 の disk 書き込みに対する watcher イベントが「遅れて」届く（fs.watchFile 1s polling 模擬）
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));

        // 直後: backspace で X を削除 → save#2 開始（doc は即 '- item'、disk 反映は 400ms 後）
        env.state.saveDelay = 400; // TASK-08: 実時間タイミングのマージン拡大（debounce100ms+wait200ms に対し ±200ms 級の両側余裕）
        const save2 = mgr.handleSave('/fake/note/page.md', '- item');
        await wait(200); // reconcile(+100ms) が disk='- itemX'(旧) を読む窓（save 完了 400ms より十分前）

        await save2;
        await wait(300);

        // 台帳照合により自己保存の残響は no-op: stale push なし・削除が維持される
        expect(staleUpdates(messages).length, '自己保存イベントで stale updateData が飛ばない').toBe(0);
        expect(env.state.docContent, 'backspace の削除結果（doc）').toBe('- item');
        expect(env.state.diskContent, 'backspace の削除結果（disk）').toBe('- item');
        mgr.disposeFileWatcher();
    });

    test('TC-SWR-06: 台帳に無い内容（真の外部編集）は従来どおり適用される', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { NotesMdMainManager } = loadManagerWithStub('../../src/shared/notesMdMainManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new NotesMdMainManager(host);
        await mgr.setupFileWatcher('/fake/note/page.md');

        await mgr.handleSave('/fake/note/page.md', 'MINE');
        // 外部編集: 台帳に無い内容へ disk が変わる
        env.state.diskContent = 'AI_EXTERNAL';
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        await wait(300);

        const ups = staleUpdates(messages);
        expect(ups.length, '外部編集は反映される').toBeGreaterThanOrEqual(1);
        expect(ups[ups.length - 1].markdown).toBe('AI_EXTERNAL');
        expect(env.state.docContent).toBe('AI_EXTERNAL');
        mgr.disposeFileWatcher();
    });

    test('TC-SWR-07: reconcile が適用した外部内容の save 残響 × 後続自己編集でも巻き戻さない', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { NotesMdMainManager } = loadManagerWithStub('../../src/shared/notesMdMainManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new NotesMdMainManager(host);
        await mgr.setupFileWatcher('/fake/note/page.md');

        // 外部編集を反映（reconcile が適用 + save → この内容が台帳に記録されるべき）
        env.state.diskContent = 'AI_EXTERNAL';
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        await wait(300);
        expect(env.state.docContent).toBe('AI_EXTERNAL');
        const pushesAfterApply = staleUpdates(messages).length;

        // reconcile 自身の save が生んだ残響イベントが遅れて届き、その間にユーザーが編集を進める
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 3000 }, { mtimeMs: 2000 }));
        env.state.saveDelay = 400; // TASK-08: 実時間タイミングのマージン拡大（debounce100ms+wait200ms に対し ±200ms 級の両側余裕）
        const save2 = mgr.handleSave('/fake/note/page.md', 'AI_EXTERNAL edited');
        await wait(200); // reconcile が disk='AI_EXTERNAL'(残響) vs doc='AI_EXTERNAL edited' を見る窓
        await save2;
        await wait(300);

        // 適用時 record が無いと、ここで 'AI_EXTERNAL' へ巻き戻る（counterfactual）
        expect(staleUpdates(messages).length, '残響イベントで再 push しない').toBe(pushesAfterApply);
        expect(env.state.docContent, 'ユーザー編集が維持される').toBe('AI_EXTERNAL edited');
        mgr.disposeFileWatcher();
    });
});
