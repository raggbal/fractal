/**
 * DrawioWatcherRegistry unit tests (TC-10, TC-11)
 *
 * - TC-10: setReferences の双方向 Map 更新と diff add/remove
 * - TC-11: drawio change → debounce → onChange (200ms)
 *
 * 純 Node 実装のテスト。vscode に依存しないため createFileSystemWatcher を mock する。
 */

import { test, expect } from '@playwright/test';
import { DrawioWatcherRegistry, extractDrawioReferences } from '../../src/shared/drawioWatcher';

interface MockWatcher {
    path: string;
    onChangeHandlers: Array<() => void>;
    disposed: boolean;
    onDidChange(h: () => void): { dispose: () => void };
    dispose(): void;
    fire(): void;
}

function makeFactory() {
    const created: MockWatcher[] = [];
    const factory = (drawioPath: string) => {
        const w: MockWatcher = {
            path: drawioPath,
            onChangeHandlers: [],
            disposed: false,
            onDidChange(handler: () => void) {
                this.onChangeHandlers.push(handler);
                return {
                    dispose: () => {
                        const i = this.onChangeHandlers.indexOf(handler);
                        if (i >= 0) this.onChangeHandlers.splice(i, 1);
                    }
                };
            },
            dispose() { this.disposed = true; },
            fire() { for (const h of this.onChangeHandlers) h(); }
        };
        created.push(w);
        return w;
    };
    return { factory, created };
}

test.describe('DrawioWatcherRegistry — TC-10 setReferences 双方向 Map + diff', () => {
    test('TC-10: 1 回目で 2 件登録、2 回目で 1 件 dispose / 1 件 keep / 1 件 new', () => {
        const { factory, created } = makeFactory();
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: () => { /* not used in this test */ }
        });

        // 1 回目: foo, bar 両方追加
        reg.setReferences('/md/A.md', ['/foo.drawio.svg', '/bar.drawio.svg']);
        expect(reg._watcherCount()).toBe(2);
        expect(created.length).toBe(2);
        const snap1 = reg._snapshot();
        expect(Object.keys(snap1).sort()).toEqual(['/bar.drawio.svg', '/foo.drawio.svg']);
        expect(snap1['/foo.drawio.svg']).toEqual(['/md/A.md']);
        expect(snap1['/bar.drawio.svg']).toEqual(['/md/A.md']);

        // 2 回目: foo を外し、bar は維持、baz を新規追加
        reg.setReferences('/md/A.md', ['/bar.drawio.svg', '/baz.drawio.svg']);
        expect(reg._watcherCount()).toBe(2);
        const snap2 = reg._snapshot();
        expect(Object.keys(snap2).sort()).toEqual(['/bar.drawio.svg', '/baz.drawio.svg']);

        // foo の watcher は dispose されている、bar は同一 instance のまま
        const fooW = created.find(w => w.path === '/foo.drawio.svg');
        const barW = created.find(w => w.path === '/bar.drawio.svg');
        const bazW = created.find(w => w.path === '/baz.drawio.svg');
        expect(fooW?.disposed).toBe(true);
        expect(barW?.disposed).toBe(false);
        expect(bazW?.disposed).toBe(false);

        reg.disposeAll();
    });

    test('TC-10b: 複数 md が同じ drawio を参照していれば 1 つ抜けても watcher 残る', () => {
        const { factory, created } = makeFactory();
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: () => { /* unused */ }
        });
        reg.setReferences('/md/A.md', ['/x.drawio.svg']);
        reg.setReferences('/md/B.md', ['/x.drawio.svg']);
        expect(reg._watcherCount()).toBe(1);
        expect(created.length).toBe(1);
        const snap = reg._snapshot();
        expect(snap['/x.drawio.svg'].sort()).toEqual(['/md/A.md', '/md/B.md']);

        // A.md が参照を外す → watcher は残る
        reg.setReferences('/md/A.md', []);
        expect(reg._watcherCount()).toBe(1);
        expect(created[0].disposed).toBe(false);
        expect(reg._snapshot()['/x.drawio.svg']).toEqual(['/md/B.md']);

        // B.md も外す → watcher dispose
        reg.setReferences('/md/B.md', []);
        expect(reg._watcherCount()).toBe(0);
        expect(created[0].disposed).toBe(true);
    });

    test('removeMd で全参照解除', () => {
        const { factory, created } = makeFactory();
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: () => { /* unused */ }
        });
        reg.setReferences('/md/A.md', ['/p.drawio.svg', '/q.drawio.svg']);
        expect(reg._watcherCount()).toBe(2);
        reg.removeMd('/md/A.md');
        expect(reg._watcherCount()).toBe(0);
        for (const w of created) expect(w.disposed).toBe(true);
    });
});

test.describe('DrawioWatcherRegistry — TC-11 debounce', () => {
    test('TC-11: 100ms 以内 5 連続発火 → 最後の発火から 200ms 後に 1 回だけ onChange', async () => {
        const { factory, created } = makeFactory();
        const calls: Array<{ path: string; mds: string[] }> = [];
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 200,
            onChange: (drawioPath, mdPaths) => {
                calls.push({ path: drawioPath, mds: mdPaths });
            }
        });
        reg.setReferences('/md/A.md', ['/foo.drawio.svg']);
        const w = created[0];

        // 5 連続発火 (each 20ms apart, all within 100ms)
        for (let i = 0; i < 5; i++) {
            w.fire();
            await new Promise(r => setTimeout(r, 20));
        }
        // まだ debounce 期間内なので呼ばれていない
        expect(calls.length).toBe(0);
        // 250ms 待つ
        await new Promise(r => setTimeout(r, 250));
        expect(calls.length).toBe(1);
        expect(calls[0].path).toBe('/foo.drawio.svg');
        expect(calls[0].mds).toEqual(['/md/A.md']);

        reg.disposeAll();
    });

    test('disposeAll で pending debounce timer はキャンセル', async () => {
        const { factory, created } = makeFactory();
        const calls: number[] = [];
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 200,
            onChange: () => { calls.push(1); }
        });
        reg.setReferences('/md/A.md', ['/foo.drawio.svg']);
        created[0].fire();
        // 即 disposeAll
        reg.disposeAll();
        await new Promise(r => setTimeout(r, 300));
        expect(calls.length).toBe(0);
    });
});

test.describe('extractDrawioReferences', () => {
    test('basic: drawio.svg / drawio.png を抽出、絶対パスに resolve', () => {
        const md = [
            '# Hello',
            '![](foo.drawio.svg)',
            '![alt text](sub/bar.drawio.png "title")',
            '![](other.png)',           // 通常画像は除外
            '![](baz.drawio)',          // .drawio (XML) は除外
            '![](https://x/y.drawio.svg)', // 外部 URL 除外
        ].join('\n');
        const refs = extractDrawioReferences(md, '/notes/n1');
        const expected = [
            '/notes/n1/foo.drawio.svg',
            '/notes/n1/sub/bar.drawio.png'
        ];
        expect(refs.sort()).toEqual(expected.sort());
    });

    test('absolute path はそのまま', () => {
        const md = '![](/abs/dir/d.drawio.svg)';
        const refs = extractDrawioReferences(md, '/notes/n1');
        expect(refs).toEqual(['/abs/dir/d.drawio.svg']);
    });

    test('?query / #fragment は strip', () => {
        const md = '![](a.drawio.svg?v=123)';
        const refs = extractDrawioReferences(md, '/notes/n1');
        expect(refs).toEqual(['/notes/n1/a.drawio.svg']);
    });

    test('空文字列で空配列', () => {
        expect(extractDrawioReferences('', '/x')).toEqual([]);
    });

    test('壊れたパースでも throw しない', () => {
        // 不完全な ![](...) を含む
        const md = '![alt](broken';
        expect(() => extractDrawioReferences(md, '/x')).not.toThrow();
    });
});
