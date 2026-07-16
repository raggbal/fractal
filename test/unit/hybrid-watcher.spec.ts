/**
 * hybrid-watcher — createHybridFileWatcher（FSW + fs.watchFile polling）の unit
 *
 * FR-LR-01/02/04: sidepanel md / notes メインペイン md の外部変更検知を
 * FSW 単独 → ハイブリッドに変えた（workspace 外ファイルでも fire させる）。
 * TC-LR-01 は「FSW が一切 fire しない環境（= workspace 外を模擬）でも
 * fs.watchFile ポーリングだけで onDidChange handler に届く」ことの load-bearing。
 * counterfactual: ポーリング（fsNs.watchFile）を no-op にすると handler は呼ばれない
 * （= FSW-only の旧実装相当では検知できない）。
 */
import { test, expect } from '@playwright/test';
import { createHybridFileWatcher } from '../../src/shared/drawioWatcher';

type FsListener = (curr: { mtimeMs: number }, prev: { mtimeMs: number }) => void;

/** FSW が一切 fire しない fake vscode（workspace 外ファイルの模擬） */
function makeSilentVscode() {
    const disposed = { fsw: false };
    return {
        ns: {
            workspace: {
                createFileSystemWatcher: () => ({
                    onDidChange: (_h: () => void) => ({ dispose: () => {} }),
                    onDidCreate: (_h: () => void) => ({ dispose: () => {} }),
                    dispose: () => { disposed.fsw = true; },
                }),
            },
            RelativePattern: class { constructor(_base: any, _pattern: string) {} } as any,
            Uri: { file: (p: string) => ({ fsPath: p }) },
        },
        disposed,
    };
}

test.describe('createHybridFileWatcher (FR-LR-01/02/04)', () => {
    test('TC-LR-01: FSW が fire しない環境でも fs.watchFile polling で onDidChange が届く（load-bearing）', () => {
        const { ns } = makeSilentVscode();
        let capturedListener: FsListener | null = null;
        let unwatchCalled = false;
        const fsNs = {
            watchFile: (_p: string, _o: { interval: number }, listener: FsListener) => {
                capturedListener = listener;
            },
            unwatchFile: (_p: string, _l: (...args: any[]) => void) => { unwatchCalled = true; },
        };

        const watcher = createHybridFileWatcher('/outside/ws/note/page.md', ns as any, fsNs);
        let fired = 0;
        watcher.onDidChange(() => { fired++; });

        // 外部編集を模擬: mtime が進む
        expect(capturedListener, 'watchFile listener が登録されている').not.toBeNull();
        capturedListener!({ mtimeMs: 2000 }, { mtimeMs: 1000 });
        expect(fired, 'ポーリング経由で onDidChange handler が発火').toBe(1);

        // mtime 不変（ポーリングの空振り）では発火しない
        capturedListener!({ mtimeMs: 2000 }, { mtimeMs: 2000 });
        expect(fired, 'mtime 不変では発火しない').toBe(1);

        // ★counterfactual: ポーリングを no-op にした watcher（= FSW-only の旧実装相当）では
        // 同じ外部編集イベント源が存在せず handler は永遠に呼ばれない
        const fsNoop = {
            watchFile: (_p: string, _o: { interval: number }, _l: FsListener) => { /* no-op = polling なし */ },
            unwatchFile: (_p: string, _l: (...args: any[]) => void) => {},
        };
        const fswOnly = createHybridFileWatcher('/outside/ws/note/page.md', ns as any, fsNoop);
        let firedFswOnly = 0;
        fswOnly.onDidChange(() => { firedFswOnly++; });
        // FSW は silent（workspace 外）・polling も無い → 発火手段ゼロ
        expect(firedFswOnly, 'counterfactual: FSW-only（polling 無効）では外部編集を検知できない').toBe(0);
        watcher.dispose();
        fswOnly.dispose();
        expect(unwatchCalled).toBe(true);
    });

    test('TC-LR-02: dispose で unwatchFile と FSW dispose の両方が呼ばれる（リーク防止）', () => {
        const { ns, disposed } = makeSilentVscode();
        let unwatchCalled = false;
        let capturedListener: FsListener | null = null;
        const fsNs = {
            watchFile: (_p: string, _o: { interval: number }, listener: FsListener) => {
                capturedListener = listener;
            },
            unwatchFile: (_p: string, _l: (...args: any[]) => void) => { unwatchCalled = true; },
        };
        const watcher = createHybridFileWatcher('/note/page.md', ns as any, fsNs);
        let fired = 0;
        watcher.onDidChange(() => { fired++; });

        watcher.dispose();
        expect(unwatchCalled, 'fs.unwatchFile が呼ばれる').toBe(true);
        expect(disposed.fsw, 'FSW.dispose が呼ばれる').toBe(true);

        // dispose 後は listener 配列がクリアされ、遅延発火しても handler に届かない
        capturedListener!({ mtimeMs: 3000 }, { mtimeMs: 1000 });
        expect(fired, 'dispose 後は発火しない').toBe(0);
    });
});
