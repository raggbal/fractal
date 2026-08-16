/**
 * external-edit-reconcile — sidepanel / notes の deferred reconcile（FR-LV-02/03, sprint 20260806-165116）
 *
 * 背景: watcher コールバック先頭の `if (_isApplyingEdit) return;` は、fractal 自身の保存窓に
 * 重なった外部イベントを同期的に捨てていた。fs.watchFile はエッジトリガ（再配送なし）のため
 * 捨てたイベントは次の disk 変化まで永久に沈黙し、直後の auto-save が AI 編集を上書きする
 * lost-update になっていた。修正 = `_pendingExternalCheck` に保留し、_isApplyingEdit が false に
 * 戻る全地点で照合を 1 回実行（deferred reconcile）+ onDidCreate も購読（atomic rename 検知）。
 *
 * SidePanelManager / NotesMdMainManager は vscode 依存のため、Module._load で fake vscode を
 * 注入して require する（先例: test/unit/bundle-smoke.spec.ts）。fs は drawioWatcher 経由の
 * watchFile/unwatchFile しか使われないため実 fs のままで安全（watch 対象は fake パス）。
 *
 * TC-LV-04 (load-bearing): 保存窓中の外部イベント → 保存完了後に照合が走り反映される。
 *   counterfactual = 早期 return のみ（pending なし旧実装）ではイベント永久消失。
 * TC-LV-05: reconcile 自身の applyEdit 中の第 2 イベント → 完了後再照合 → 差分なしで no-op 収束。
 * TC-LV-06: エラー経路（applyEdit throw）でも pending が flush される。
 * TC-LV-07: disposeFileWatcher で pending がリセットされる。
 * TC-LV-08: NotesMdMainManager でも TC-LV-04 同型（updateData externalUpdate:true）。
 * TC-LV-09 (回帰 pin): 自己保存のみでは postMessage が発火しない（差分チェック no-op）。
 * TC-LV-10: onDidCreate だけの発火（atomic rename 模擬）でも反映される。
 */
import { test, expect } from '@playwright/test';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fake vscode: TextDocument / workspace.fs.readFile / applyEdit / FSW を制御可能にする。
 * disk 内容は state.diskContent、TextDocument 内容は state.docContent が真実。
 * applyEdit は docContent を diskContent 側の引数で置き換える（実 applyEdit の挙動を模倣）。
 */
function makeFakeVscodeEnv(initial: string) {
    const state = {
        diskContent: initial,
        docContent: initial,
        applyEditDelay: 0,          // applyEdit の擬似所要時間（保存窓を作る）
        applyEditThrow: false,      // TC-LV-06: applyEdit を throw させる
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
        save: async () => { state.saveCount++; state.diskContent = state.docContent; return true; },
    };
    const vscodeNs: any = {
        Uri: {
            file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
        },
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
                if (state.applyEditThrow) { state.applyEditThrow = false; throw new Error('fake applyEdit failure'); }
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

/** Module._load で vscode / fs を stub して manager クラスを require する */
function loadManagerWithStub(modulePath: string, vscodeNs: any, fsNs: any): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request: string, ...rest: any[]) {
        if (request === 'vscode') { return vscodeNs; }
        if (request === 'fs' && rest[0] && String(rest[0].filename || '').includes('src/shared')) { return fsNs; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        const resolved = require.resolve(modulePath);
        // 依存モジュール（drawioWatcher 等）も stub された fs/vscode で再評価させる
        Object.keys(require.cache)
            .filter((k) => k.includes('/src/shared/'))
            .forEach((k) => { delete require.cache[k]; });
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        // stub 下で評価された /src/shared/ モジュールを cache から再 purge する。
        // これを残すと同一 Playwright worker で後続の spec が「fs が 2 メソッド stub のまま」の
        // paste-asset-handler 等を掴んで落ちる（sprint 20260815 iter6 gate NEW FAILS 3 の根因 —
        // TASK-19 / 許可: test_update。次の素の require は実 fs/vscode で再評価される）
        Object.keys(require.cache)
            .filter((k) => k.includes('/src/shared/'))
            .forEach((k) => { delete require.cache[k]; });
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

test.describe('SidePanelManager deferred reconcile (FR-LV-02/03)', () => {

    test('TC-LV-04: 保存窓中の外部イベントが保存完了後に照合・反映される（load-bearing）', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { SidePanelManager } = loadManagerWithStub('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new SidePanelManager(host, { logPrefix: '[T]' });
        await mgr.setupFileWatcher('/fake/note/page.md');

        // fractal の auto-save（handleSave）を遅延付きで開始 = _isApplyingEdit=true の保存窓を作る
        env.state.applyEditDelay = 100;
        const savePromise = mgr.handleSave('/fake/note/page.md', 'USER_SAVE');
        await wait(20); // 保存窓の最中

        // 外部編集: AI が disk を書き換え、watchFile イベントが発火（保存窓中 → 従来は握り潰し）
        env.state.diskContent = 'AI_EXTERNAL_EDIT_DURING_SAVE';
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        await savePromise;
        // handleSave 完了後: doc は USER_SAVE、disk は AI 内容（handleSave の doc.save が
        // diskContent を上書きするが、外部編集がその後に上書きしたシナリオを模擬）
        env.state.diskContent = 'AI_EXTERNAL_EDIT_DURING_SAVE';
        await wait(300); // pending flush の setTimeout(100) + reconcile 完了を待つ

        // 照合が走り、外部内容が doc に反映され webview へ update が飛ぶ
        const updates = messages.filter((m) => m.type === 'sidePanelMessage' && m.data?.type === 'update');
        expect(updates.length, '保存完了後に外部内容が反映される').toBeGreaterThanOrEqual(1);
        expect(updates[updates.length - 1].data.content).toBe('AI_EXTERNAL_EDIT_DURING_SAVE');
        expect(env.state.docContent).toBe('AI_EXTERNAL_EDIT_DURING_SAVE');
        mgr.disposeFileWatcher();
    });

    test('TC-LV-05: reconcile 中の第 2 イベント → 完了後再照合 → 差分なしで no-op 収束（update は 1 回）', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { SidePanelManager } = loadManagerWithStub('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new SidePanelManager(host, { logPrefix: '[T]' });
        await mgr.setupFileWatcher('/fake/note/page.md');

        env.state.applyEditDelay = 80; // reconcile の applyEdit を遅くして窓を作る
        env.state.diskContent = 'AI_EDIT_1';
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        await wait(150); // reconcile 開始・applyEdit 中
        // applyEdit 中に第 2 イベント（同一内容 = ポーリングの二重検知を模擬）
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 3000 }, { mtimeMs: 2000 }));
        await wait(400);

        const updates = messages.filter((m) => m.type === 'sidePanelMessage' && m.data?.type === 'update');
        expect(updates.length, '差分なしの再照合は no-op（update は 1 回だけ）').toBe(1);
        expect(env.state.docContent).toBe('AI_EDIT_1');
        mgr.disposeFileWatcher();
    });

    test('TC-LV-06: applyEdit throw のエラー経路でも pending が flush される', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { SidePanelManager } = loadManagerWithStub('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new SidePanelManager(host, { logPrefix: '[T]' });
        await mgr.setupFileWatcher('/fake/note/page.md');

        env.state.applyEditDelay = 80;
        env.state.applyEditThrow = true; // 第 1 照合の applyEdit を throw させる
        env.state.diskContent = 'AI_EDIT_ERR';
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        await wait(120); // applyEdit(throw 前の delay) 中に第 2 イベント → pending
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 3000 }, { mtimeMs: 2000 }));
        await wait(500);

        // 第 1 照合は throw したが、catch 内の flush が pending を照合し反映される
        const updates = messages.filter((m) => m.type === 'sidePanelMessage' && m.data?.type === 'update');
        expect(updates.length, 'エラー後も pending 照合で反映される').toBeGreaterThanOrEqual(1);
        expect(env.state.docContent).toBe('AI_EDIT_ERR');
        mgr.disposeFileWatcher();
    });

    test('TC-LV-07: disposeFileWatcher が pending をリセットする', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { SidePanelManager } = loadManagerWithStub('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new SidePanelManager(host, { logPrefix: '[T]' });
        await mgr.setupFileWatcher('/fake/note/page.md');

        // 保存窓で pending を立てたまま dispose
        env.state.applyEditDelay = 100;
        const savePromise = mgr.handleSave('/fake/note/page.md', 'USER_SAVE');
        await wait(20);
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        mgr.disposeFileWatcher();
        await savePromise;
        await wait(300);
        // dispose 後は stale 照合が走らない（watchedPath が undefined になり reconcile は早期 return。
        // pending もリセット済み）— update が飛ばないことを確認
        const updates = messages.filter((m) => m.type === 'sidePanelMessage' && m.data?.type === 'update');
        expect(updates.length).toBe(0);
    });

    test('TC-LV-09 (回帰 pin): 自己保存のみでは update が発火しない（差分チェック no-op）', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { SidePanelManager } = loadManagerWithStub('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new SidePanelManager(host, { logPrefix: '[T]' });
        await mgr.setupFileWatcher('/fake/note/page.md');

        // 自己保存 → doc と disk が同内容になった後、ポーリングが自己保存を検知して発火
        await mgr.handleSave('/fake/note/page.md', 'SELF_SAVE');
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        await wait(300);
        const updates = messages.filter((m) => m.type === 'sidePanelMessage' && m.data?.type === 'update');
        expect(updates.length, '自己保存の空振りは no-op').toBe(0);
        mgr.disposeFileWatcher();
    });

    test('TC-LV-10: onDidCreate だけの発火（atomic rename 模擬）でも反映される', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { SidePanelManager } = loadManagerWithStub('../../src/shared/sidePanelManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new SidePanelManager(host, { logPrefix: '[T]' });
        await mgr.setupFileWatcher('/fake/note/page.md');

        expect(env.state.fswCreateHandlers.length, 'onDidCreate が購読されている').toBeGreaterThanOrEqual(1);
        // Claude Code の atomic rename: FSW は onDidCreate のみ発火（watchFile は沈黙の想定）
        env.state.diskContent = 'AI_RENAME_WRITE';
        env.state.fswCreateHandlers.forEach((h) => h());
        await wait(300);
        const updates = messages.filter((m) => m.type === 'sidePanelMessage' && m.data?.type === 'update');
        expect(updates.length).toBeGreaterThanOrEqual(1);
        expect(env.state.docContent).toBe('AI_RENAME_WRITE');
        mgr.disposeFileWatcher();
    });
});

test.describe('NotesMdMainManager deferred reconcile (FR-LV-02/03)', () => {

    test('TC-LV-08: 保存窓中の外部イベントが保存完了後に照合・反映される（updateData externalUpdate）', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { NotesMdMainManager } = loadManagerWithStub('../../src/shared/notesMdMainManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new NotesMdMainManager(host);
        await mgr.setupFileWatcher('/fake/note/page.md');

        env.state.applyEditDelay = 100;
        const savePromise = mgr.handleSave('/fake/note/page.md', 'USER_SAVE');
        await wait(20);
        env.state.diskContent = 'AI_NOTES_EDIT';
        env.state.watchFileListeners.forEach((l) => l({ mtimeMs: 2000 }, { mtimeMs: 1000 }));
        await savePromise;
        env.state.diskContent = 'AI_NOTES_EDIT';
        await wait(300);

        const updates = messages.filter((m) => m.type === 'updateData' && m.kind === 'md' && m.externalUpdate);
        expect(updates.length, '保存完了後に外部内容が反映される').toBeGreaterThanOrEqual(1);
        expect(updates[updates.length - 1].markdown).toBe('AI_NOTES_EDIT');
        mgr.disposeFileWatcher();
    });

    test('TC-LV-10b: notes でも onDidCreate 購読（atomic rename 模擬）', async () => {
        const env = makeFakeVscodeEnv('ORIGINAL');
        const { NotesMdMainManager } = loadManagerWithStub('../../src/shared/notesMdMainManager', env.vscodeNs, env.fsNs);
        const { messages, host } = collectMessages();
        const mgr = new NotesMdMainManager(host);
        await mgr.setupFileWatcher('/fake/note/page.md');

        expect(env.state.fswCreateHandlers.length).toBeGreaterThanOrEqual(1);
        env.state.diskContent = 'AI_RENAME_NOTES';
        env.state.fswCreateHandlers.forEach((h) => h());
        await wait(300);
        const updates = messages.filter((m) => m.type === 'updateData' && m.kind === 'md' && m.externalUpdate);
        expect(updates.length).toBeGreaterThanOrEqual(1);
        expect(updates[updates.length - 1].markdown).toBe('AI_RENAME_NOTES');
        mgr.disposeFileWatcher();
    });
});
