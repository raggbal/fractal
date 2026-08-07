/**
 * external-edit-standalone — standalone md の外部変更検知 seam（FR-LV-01, sprint 20260806-165116）
 *
 * setupExternalMdWatcher（src/shared/external-md-watcher.ts）を fake vscode/fs 注入で
 * behavioral に駆動する（先例: test/unit/hybrid-watcher.spec.ts）。
 *
 * TC-LV-01 (load-bearing): FSW が一切 fire しない環境（workspace 外の模擬）でも
 *   fs.watchFile ポーリングで onFsEvent が届く。counterfactual = 素の FSW onDidChange 単独
 *   （旧実装相当 = ポーリング no-op + onDidCreate 非購読）では届かない。
 * TC-LV-02: onDidCreate だけが発火する状況（atomic rename 模擬）でも届く。
 * TC-LV-03: seam の dispose が FSW/polling/debounce timer を全て解放する。
 */
import { test, expect } from '@playwright/test';
import { setupExternalMdWatcher } from '../../src/shared/external-md-watcher';

type FsListener = (curr: { mtimeMs: number }, prev: { mtimeMs: number }) => void;

/** FSW を手動発火できる fake vscode */
function makeFakeVscode() {
    const handlers = { change: [] as Array<() => void>, create: [] as Array<() => void> };
    const disposed = { fsw: false };
    return {
        ns: {
            workspace: {
                createFileSystemWatcher: () => ({
                    onDidChange: (h: () => void) => { handlers.change.push(h); return { dispose: () => {} }; },
                    onDidCreate: (h: () => void) => { handlers.create.push(h); return { dispose: () => {} }; },
                    dispose: () => { disposed.fsw = true; },
                }),
            },
            RelativePattern: class { constructor(_base: any, _pattern: string) {} } as any,
            Uri: { file: (p: string) => ({ fsPath: p }) },
        },
        handlers,
        disposed,
    };
}

function makeFakeFs() {
    const state = { listener: null as FsListener | null, unwatched: false };
    return {
        ns: {
            watchFile: (_p: string, _o: { interval: number }, l: FsListener) => { state.listener = l; },
            unwatchFile: (_p: string, _l: (...args: any[]) => void) => { state.unwatched = true; },
        },
        state,
    };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('setupExternalMdWatcher (FR-LV-01)', () => {

    test('TC-LV-01: FSW が fire しない環境でもポーリングで onFsEvent が届く（load-bearing）', async () => {
        const { ns: vscodeNs } = makeFakeVscode();
        const { ns: fsNs, state } = makeFakeFs();
        let fired = 0;
        const w = setupExternalMdWatcher({
            filePath: '/outside/ws/page.md', vscodeNs, fsNs,
            onFsEvent: () => { fired++; }, debounceMs: 10,
        });
        expect(state.listener, 'fs.watchFile が登録される').not.toBeNull();
        // 外部編集（in-place 書き込み = mtime 遷移）を模擬
        state.listener!({ mtimeMs: 2000 }, { mtimeMs: 1000 });
        await wait(30);
        expect(fired, 'ポーリング経由で届く').toBe(1);
        w.dispose();

        // ★counterfactual: 旧実装相当（素の FSW onDidChange 単独 = ポーリングも onDidCreate も無い）
        // では、FSW が fire しない環境で外部編集イベントが一切届かない
        const cf = makeFakeVscode();
        let cfFired = 0;
        const rawFsw = cf.ns.workspace.createFileSystemWatcher();
        rawFsw.onDidChange(() => { cfFired++; });
        // 外部編集は起きたが FSW は沈黙（workspace 外 or atomic rename）→ 検知手段なし
        await wait(30);
        expect(cfFired, '旧実装相当では届かない = RED 相当').toBe(0);
    });

    test('TC-LV-02: onDidCreate だけの発火（atomic rename 模擬）でも届く', async () => {
        const { ns: vscodeNs, handlers } = makeFakeVscode();
        const { ns: fsNs } = makeFakeFs();
        let fired = 0;
        const w = setupExternalMdWatcher({
            filePath: '/ws/page.md', vscodeNs, fsNs,
            onFsEvent: () => { fired++; }, debounceMs: 10,
        });
        expect(handlers.create.length, 'onDidCreate が購読されている').toBeGreaterThanOrEqual(1);
        // Claude Code の atomic rename: FSW は onDidChange でなく onDidCreate を発火
        handlers.create.forEach((h) => h());
        await wait(30);
        expect(fired).toBe(1);
        w.dispose();
    });

    test('TC-LV-02b: 同一変更の二重検知（FSW + polling）は debounce で 1 回に集約', async () => {
        const { ns: vscodeNs, handlers } = makeFakeVscode();
        const { ns: fsNs, state } = makeFakeFs();
        let fired = 0;
        const w = setupExternalMdWatcher({
            filePath: '/ws/page.md', vscodeNs, fsNs,
            onFsEvent: () => { fired++; }, debounceMs: 20,
        });
        handlers.change.forEach((h) => h());
        state.listener!({ mtimeMs: 2000 }, { mtimeMs: 1000 });
        await wait(60);
        expect(fired, 'debounce 窓内の二重検知は 1 回').toBe(1);
        w.dispose();
    });

    test('TC-LV-03: dispose が FSW / polling / debounce timer を解放する', async () => {
        const { ns: vscodeNs, disposed, handlers } = makeFakeVscode();
        const { ns: fsNs, state } = makeFakeFs();
        let fired = 0;
        const w = setupExternalMdWatcher({
            filePath: '/ws/page.md', vscodeNs, fsNs,
            onFsEvent: () => { fired++; }, debounceMs: 10,
        });
        // debounce 中に dispose → 発火しない
        handlers.change.forEach((h) => h());
        w.dispose();
        await wait(30);
        expect(fired, 'dispose 後は debounce 済みイベントも発火しない').toBe(0);
        expect(disposed.fsw, 'FSW が dispose される').toBe(true);
        expect(state.unwatched, 'fs.unwatchFile が呼ばれる').toBe(true);
    });
});
