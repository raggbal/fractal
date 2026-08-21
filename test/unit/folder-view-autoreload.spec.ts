/**
 * TC-FLV-68/69 — fv 自動リロード seam（sprint 20260821-015014 FR-FLV-33 / ADRL-FVR-1）
 *
 * fake fsNs（watch 記録 + cb 手動発火）+ 短 debounce の behavioral 検証。
 * one-shot 対配線（ensure/close/disposeAll）は ADRL-0074 が却下理由に挙げた失敗クラス — dispose 実測で pin。
 */
import { test, expect } from '@playwright/test';

// vscode 非依存（fs 注入 seam）— 直接 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createFolderViewAutoReload } = require('../../src/shared/folder-view-autoreload');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeFs() {
    const watches: {
        root: string; opts: any; cb: (e: string, f: string | null) => void; closed: number;
        listeners: { [ev: string]: ((e: unknown) => void)[] };
        emit: (ev: string, arg: unknown) => void;
    }[] = [];
    const fsNs = {
        watch(root: string, opts: any, cb: (e: string, f: string | null) => void) {
            const w = {
                root, opts, cb, closed: 0,
                listeners: {} as { [ev: string]: ((e: unknown) => void)[] },
                emit(ev: string, arg: unknown) { (w.listeners[ev] || []).forEach((l) => l(arg)); },
            };
            watches.push(w);
            // Node FSWatcher 同型: EventEmitter 風の on() を持つ handle
            return {
                close() { w.closed++; },
                on(ev: string, l: (e: unknown) => void) { (w.listeners[ev] = w.listeners[ev] || []).push(l); },
            };
        },
    };
    return { fsNs, watches };
}

test('TC-FLV-68 ensure 1 回性 + debounce 集約（同 dir 3 イベント → listDir 1 回 / 別 dir → unique 2 回）', async () => {
    const { fsNs, watches } = makeFakeFs();
    const calls: [string, string][] = [];
    const ar = createFolderViewAutoReload({ fsNs, listDir: (id: string, rel: string) => calls.push([id, rel]), debounceMs: 10 });

    ar.ensure('l1', '/r');
    expect(watches.length).toBe(1);
    expect(watches[0].root).toBe('/r');
    expect(watches[0].opts).toEqual({ recursive: true });
    ar.ensure('l1', '/r'); // 同 root 再 ensure = no-op
    expect(watches.length).toBe(1);

    // 同 dir 3 イベント（rename×2 + change）→ flush 1 回に集約
    watches[0].cb('rename', 'sub/x.md');
    watches[0].cb('rename', 'sub/y.md');
    watches[0].cb('change', 'sub/z.md');
    expect(calls.length).toBe(0); // debounce 中は未発火
    await sleep(50);
    expect(calls).toEqual([['l1', 'sub']]);

    // 別 dir 混在 → unique 2 dir（root 直下 = ''）
    calls.length = 0;
    watches[0].cb('rename', 'a/b.png');
    watches[0].cb('rename', 'top.md');
    watches[0].cb('rename', 'a/c.png');
    await sleep(50);
    expect(calls.sort()).toEqual([['l1', ''], ['l1', 'a']].sort());
    expect(calls.length).toBe(2);

    // ネスト dir の区切りは '/' 正規化
    calls.length = 0;
    watches[0].cb('rename', 'a/b/c/d.md');
    await sleep(50);
    expect(calls).toEqual([['l1', 'a/b/c']]);
});

test('TC-FLV-69 境界と one-shot 対配線: filename null → root / root 外相対は捨てる / close → dispose + 以後無視 / watch throw → 縮退 no-op / 別 root 張り替え / disposeAll', async () => {
    const { fsNs, watches } = makeFakeFs();
    const calls: [string, string][] = [];
    const warns: string[] = [];
    const ar = createFolderViewAutoReload({
        fsNs, listDir: (id: string, rel: string) => calls.push([id, rel]), debounceMs: 10,
        warn: (m: string) => warns.push(m),
    });

    ar.ensure('l1', '/r');
    // filename null → root '' フォールバック
    watches[0].cb('rename', null);
    await sleep(50);
    expect(calls).toEqual([['l1', '']]);
    // root 外相対（防御）→ 発火なし
    calls.length = 0;
    watches[0].cb('rename', '../evil.md');
    await sleep(50);
    expect(calls.length).toBe(0);

    // close → handle.close 実測 + 以後のイベント無視（counterfactual: ガード無しだと発火して RED）
    ar.close('l1');
    expect(watches[0].closed).toBe(1);
    watches[0].cb('rename', 'sub/x.md');
    await sleep(50);
    expect(calls.length).toBe(0);
    ar.close('l1'); // 二重 close 安全
    expect(watches[0].closed).toBe(1);

    // watch throw → warn + no-op 縮退（throw が呼び出し元へ漏れない）
    const throwingFs = { watch() { throw new Error('EMFILE'); } };
    const ar2 = createFolderViewAutoReload({ fsNs: throwingFs as any, listDir: () => {}, debounceMs: 10, warn: (m: string) => warns.push(m) });
    ar2.ensure('lx', '/rx'); // no throw
    expect(warns.length).toBe(1);
    ar2.close('lx'); // 未登録 close も安全

    // 別 root への ensure = 旧 watcher 張り替え（旧 close + 新 watch）
    ar.ensure('l2', '/r2');
    expect(watches.length).toBe(2);
    ar.ensure('l2', '/r2-moved');
    expect(watches.length).toBe(3);
    expect(watches[1].closed).toBe(1);

    // disposeAll → 残り全 close
    ar.disposeAll();
    expect(watches[2].closed).toBe(1);
});

test('TC-FLV-71 非同期 error イベント → warn + 監視 dispose + 以後無視（extension host を落とさない — QUAL-1）', async () => {
    const { fsNs, watches } = makeFakeFs();
    const calls: [string, string][] = [];
    const warns: string[] = [];
    const ar = createFolderViewAutoReload({
        fsNs, listDir: (id: string, rel: string) => calls.push([id, rel]), debounceMs: 10,
        warn: (m: string) => warns.push(m),
    });
    ar.ensure('l1', '/r');
    // watcher 稼働確認
    watches[0].cb('rename', 'sub/x.md');
    await sleep(50);
    expect(calls).toEqual([['l1', 'sub']]);
    calls.length = 0;
    // 非同期 'error'（監視 root の削除/権限変更等）→ warn + handle.close + 縮退
    watches[0].emit('error', new Error('EPERM: watch target removed'));
    expect(warns.length).toBe(1);
    expect(watches[0].closed).toBe(1);
    // 以後のイベントは無視（listDir 不発）
    watches[0].cb('rename', 'sub/y.md');
    await sleep(50);
    expect(calls.length).toBe(0);
    // error 後の再 ensure で復帰できる（新 watcher）
    ar.ensure('l1', '/r');
    expect(watches.length).toBe(2);
});
