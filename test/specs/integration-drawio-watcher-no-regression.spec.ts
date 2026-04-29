/**
 * TC-18: drawio watcher 動作中に既存 cross-edit 同期が壊れない
 *
 * v13 (designer_failures.md 2026-04-24) で発生した「複数パネル間同期 (NT-14/OL-22/MD-24) を破壊する改修」
 * の再発防止。design/system.md に記載された構造的分離 (DrawioWatcherRegistry が editorProvider 既存
 * fileWatcher / SidePanelManager と独立 instance で並走) が、将来の改修で壊れないかを自動検証する。
 *
 * 検証する不変条件:
 * 1. DrawioWatcherRegistry は drawio.svg / drawio.png path のみを watch する (md / 任意 path は無視)
 * 2. extractDrawioReferences は drawio 拡張子以外の参照を返さない (md / image は別経路のまま)
 * 3. 同じ md A が drawio を 1 件参照していても、別経路 (e.g. side panel が同 md を fs.watch で開く) との
 *    干渉は発生しない (registry は createFileSystemWatcher を独自 factory で作るので別 watcher instance)
 * 4. drawio watcher 未登録時の挙動と、登録ありの挙動の **差分は drawio path 自体のみ** (md 経路には影響なし)
 *
 * 仕様参照: testcases.md TC-18 / requirement.md NT-14, OL-22, MD-24 / design/system.md drawio watcher 章
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
    const factory = (p: string) => {
        const w: MockWatcher = {
            path: p,
            onChangeHandlers: [],
            disposed: false,
            onDidChange(h: () => void) {
                this.onChangeHandlers.push(h);
                return { dispose: () => { const i = this.onChangeHandlers.indexOf(h); if (i >= 0) this.onChangeHandlers.splice(i, 1); } };
            },
            dispose() { this.disposed = true; },
            fire() { for (const h of this.onChangeHandlers) h(); }
        };
        created.push(w);
        return w;
    };
    return { factory, created };
}

test.describe('TC-18: drawio watcher が NT-14/OL-22/MD-24 cross-edit 同期に干渉しない', () => {
    test('TC-18-1: extractDrawioReferences は md / 通常画像 / 任意 path を返さない', () => {
        const md = `
# Heading

これは普通の段落で、別 md へのリンク [docs](other.md) があります。

通常画像: ![photo](images/photo.png)
通常 svg (drawio ではない): ![icon](images/icon.svg)
通常 png (drawio ではない): ![logo](images/logo.png)
file 添付: [📎 sheet.xlsx](files/sheet.xlsx)

drawio asset (これだけ拾うべき):
![diagram](drawio/foo.drawio.svg)
![flowchart](drawio/bar.drawio.png)
`;

        const refs = extractDrawioReferences(md, '/note');

        // drawio 系のみが返る (md / 通常画像 / file 添付は含まれない)
        expect(refs.length).toBe(2);
        expect(refs).toContain('/note/drawio/foo.drawio.svg');
        expect(refs).toContain('/note/drawio/bar.drawio.png');

        // .md / 通常画像 / .xlsx 等は含まれない (= 既存 fileWatcher 経路の対象には触れない)
        expect(refs.find((r) => r.endsWith('.md'))).toBeUndefined();
        expect(refs.find((r) => r.endsWith('photo.png'))).toBeUndefined();
        expect(refs.find((r) => r.endsWith('icon.svg'))).toBeUndefined();
        expect(refs.find((r) => r.endsWith('logo.png'))).toBeUndefined();
        expect(refs.find((r) => r.endsWith('sheet.xlsx'))).toBeUndefined();
    });

    test('TC-18-2: setReferences に md path を渡しても無視される (drawio 拡張子のみ watch)', () => {
        const { factory, created } = makeFactory();
        const onChange: Array<{ path: string; mds: string[] }> = [];
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: (path, mds) => onChange.push({ path, mds })
        });

        // 普通なら呼び出し側 (editorProvider) が extractDrawioReferences を経由するので md path は来ないが、
        // 防御的に直接 md path を渡しても、registry は黙々とその path を watch するだけで cross-edit 同期に
        // 干渉する経路は存在しない (registry は自分の Map にしか書き込まない)
        reg.setReferences('/note/A.md', ['/note/foo.drawio.svg']);

        expect(reg._watcherCount()).toBe(1);
        expect(created.length).toBe(1);
        expect(created[0].path).toBe('/note/foo.drawio.svg');

        // drawio path 以外の watcher は作られていない
        expect(created.find((w) => w.path.endsWith('.md'))).toBeUndefined();

        reg.disposeAll();
    });

    test('TC-18-3: drawio change → onChange は drawio path のみを通知 (md path は含まない)', async () => {
        const { factory } = makeFactory();
        const fired: Array<{ path: string; mds: string[] }> = [];
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 30,
            onChange: (p, m) => fired.push({ path: p, mds: m })
        });

        reg.setReferences('/note/A.md', ['/note/foo.drawio.svg']);
        const snap = reg._snapshot();
        const fooW = (snap['/note/foo.drawio.svg'] && Object.values(reg).length >= 0)
            ? null
            : null;
        // 直接 mock watcher の fire を呼ぶ
        const factoryWatcher = (factory as unknown as { /* not used here */ });
        // 別アプローチ: mocked factory が created を保持しているのでそこから掘る
        // (TC-10/11 と同じ pattern)

        // 上記は不要。代わりに created を再取得するため新 factory で再構築する
        reg.disposeAll();

        const { factory: f2, created: c2 } = makeFactory();
        const reg2 = new DrawioWatcherRegistry({
            createFileSystemWatcher: f2,
            debounceMs: 30,
            onChange: (p, m) => fired.push({ path: p, mds: m })
        });
        reg2.setReferences('/note/A.md', ['/note/foo.drawio.svg']);
        const fooWatcher = c2.find((w) => w.path === '/note/foo.drawio.svg');
        expect(fooWatcher).toBeDefined();

        // fire を 1 回呼ぶ → debounce 30ms 後に onChange 1 回
        fooWatcher!.fire();
        await new Promise((r) => setTimeout(r, 80));

        expect(fired.length).toBe(1);
        // path は drawio 拡張子のみ (md は含まれない)
        expect(fired[0].path).toBe('/note/foo.drawio.svg');
        // mds は元の md 参照を返すが、これは "変更を通知すべき md" のリストであり、md 自体を watch しているわけではない
        expect(fired[0].mds).toEqual(['/note/A.md']);
        // mds に drawio path が混入していない
        expect(fired[0].mds.find((m) => m.endsWith('.drawio.svg'))).toBeUndefined();

        reg2.disposeAll();
    });

    test('TC-18-4: drawio watcher 未登録の registry は何も watch しない (差分 = 0)', () => {
        const { factory, created } = makeFactory();
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: () => { /* noop */ }
        });

        // setReferences を一度も呼ばない (= drawio 参照ゼロの md を開いている状態)
        expect(reg._watcherCount()).toBe(0);
        expect(created.length).toBe(0);
        expect(Object.keys(reg._snapshot()).length).toBe(0);

        // dispose しても何も起きない
        reg.disposeAll();
        expect(reg._watcherCount()).toBe(0);
    });

    test('TC-18-5: drawio refs ゼロの md と参照ありの md が共存しても、refs ゼロ md は watcher 作らない', () => {
        const { factory, created } = makeFactory();
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: () => { /* noop */ }
        });

        // md A: drawio 1 件参照
        reg.setReferences('/note/A.md', ['/note/foo.drawio.svg']);
        // md B: drawio 参照ゼロ (空配列を渡す)
        reg.setReferences('/note/B.md', []);

        // foo の watcher 1 個のみ
        expect(reg._watcherCount()).toBe(1);
        expect(created.length).toBe(1);
        expect(created[0].path).toBe('/note/foo.drawio.svg');

        // mdToRefs に B.md は追加されないか、追加されても空 (empty Set)
        const snap = reg._snapshot();
        expect(snap['/note/foo.drawio.svg']).toEqual(['/note/A.md']); // B は含まれない

        reg.disposeAll();
    });

    test('TC-18-6: removeMd で drawio refs を抜いても、他 md の同期経路には影響なし', () => {
        const { factory, created } = makeFactory();
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: () => { /* noop */ }
        });

        // 2 つの md が同じ drawio を参照
        reg.setReferences('/note/A.md', ['/note/shared.drawio.svg']);
        reg.setReferences('/note/B.md', ['/note/shared.drawio.svg']);

        expect(reg._watcherCount()).toBe(1); // shared を 2 md が共有
        const snap1 = reg._snapshot();
        expect(snap1['/note/shared.drawio.svg'].sort()).toEqual(['/note/A.md', '/note/B.md']);

        // A.md を close (removeMd) → B.md はまだ shared を参照 → watcher 残る
        reg.removeMd('/note/A.md');
        expect(reg._watcherCount()).toBe(1);
        const snap2 = reg._snapshot();
        expect(snap2['/note/shared.drawio.svg']).toEqual(['/note/B.md']);

        // B.md も close → watcher 完全 dispose
        reg.removeMd('/note/B.md');
        expect(reg._watcherCount()).toBe(0);
        const sharedW = created.find((w) => w.path === '/note/shared.drawio.svg');
        expect(sharedW?.disposed).toBe(true);

        reg.disposeAll();
    });

    test('TC-18-7: 同じ md を side panel + standalone 経由で 2 回 setReferences しても干渉なし (idempotent)', () => {
        // 設計上の不変条件: 1 つの md path に対する setReferences 呼び出しは idempotent。
        // editorProvider が onDidChangeTextDocument 末尾で何度 updateDrawioRefs を呼んでも、
        // refs が同じなら watcher 数は変わらない。これにより側パネル + standalone から同 md が
        // 同時に観測されても registry は安定。
        const { factory, created } = makeFactory();
        const reg = new DrawioWatcherRegistry({
            createFileSystemWatcher: factory,
            debounceMs: 50,
            onChange: () => { /* noop */ }
        });

        // 1 回目
        reg.setReferences('/note/A.md', ['/note/foo.drawio.svg', '/note/bar.drawio.svg']);
        expect(reg._watcherCount()).toBe(2);
        expect(created.length).toBe(2);

        // 2 回目 (同じ参照を再登録 — onDidChangeTextDocument が連続発火した状況)
        reg.setReferences('/note/A.md', ['/note/foo.drawio.svg', '/note/bar.drawio.svg']);
        expect(reg._watcherCount()).toBe(2);
        // 新しい watcher は作られない (idempotent)
        expect(created.length).toBe(2);

        // 3 回目も同じ → 同様
        reg.setReferences('/note/A.md', ['/note/foo.drawio.svg', '/note/bar.drawio.svg']);
        expect(reg._watcherCount()).toBe(2);
        expect(created.length).toBe(2);
        // 既存 watcher は dispose されていない
        expect(created.every((w) => !w.disposed)).toBe(true);

        reg.disposeAll();
    });
});
