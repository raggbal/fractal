/**
 * TASK-02 — フォルダ複製エンジン + 走査専用モード
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-02 / FR-FDP-08 / NFR-FDP-01 / NFR-FDP-02 / NFR-FDP-05 / ADRL-0126 / ADRL-0127
 *
 * TC-ENG-1〜11 / TC-PERF-1 / TC-PERF-2 / TC-GATE-4 / TC-CON-4
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}
function engine(): any {
    purgeSrcCache();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../src/shared/folder-copy-engine');
}

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
/** 深さ 3・ファイル 7 個のツリーを作る。 */
function mkTree(root: string): void {
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.mkdirSync(path.join(root, 'd'), { recursive: true });
    fs.writeFileSync(path.join(root, 'f1.txt'), 'F1');
    fs.writeFileSync(path.join(root, 'f2.md'), '# F2');
    fs.writeFileSync(path.join(root, 'a', 'f3.txt'), 'F3');
    fs.writeFileSync(path.join(root, 'a', 'b', 'f4.txt'), 'F4');
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'f5.txt'), 'F5');
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'f6.txt'), 'F6');
    fs.writeFileSync(path.join(root, 'd', 'f7.txt'), 'F7');
}
/** n ファイルを深さ depth に散らして作る（大量ファイル用のインラインヘルパ）。 */
function mkMany(root: string, n: number, depth: number): void {
    let dir = root;
    for (let d = 0; d < depth; d++) { dir = path.join(dir, `L${d}`); }
    fs.mkdirSync(dir, { recursive: true });
    const per = Math.ceil(n / depth);
    let made = 0; let cur = root;
    for (let d = 0; d < depth && made < n; d++) {
        cur = path.join(cur, `L${d}`);
        fs.mkdirSync(cur, { recursive: true });
        for (let i = 0; i < per && made < n; i++) { fs.writeFileSync(path.join(cur, `f${i}.txt`), 'x'); made++; }
    }
}
function walkFiles(root: string): string[] {
    const out: string[] = [];
    const rec = (d: string, rel: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { rec(p, path.join(rel, e.name)); }
            else { out.push(path.join(rel, e.name)); }
        }
    };
    rec(root, '');
    return out.sort();
}


/**
 * event loop が実際に回ったか（= 制御が譲られたか）を測るプローブ。
 * `setImmediate` の自己再帰で tick を数える。**同期一括で走る実装では tick が 1 度も進まない**ので、
 * 壁時間の gap だけでは判別できないチャンク譲渡の有無を検出できる（番人の実効性を担保）。
 */
function startEventLoopProbe(): { stop: () => { ticks: number; maxGap: number } } {
    let ticks = 0; let stopped = false; let last = Date.now(); let maxGap = 0;
    const tick = () => {
        if (stopped) { return; }
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last); last = now; ticks++;
        setImmediate(tick);
    };
    setImmediate(tick);
    return { stop: () => { stopped = true; return { ticks, maxGap }; } };
}

test.describe('TASK-02 フォルダ複製エンジン', () => {
    test('TC-ENG-1: 階層と内容を保って複製する', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            mkTree(src);
            const r = await copyFolderRecursive(path.join(src), dst, { destName: 'copied' });
            expect(r.ok).toBe(true);
            expect(r.copiedFiles).toBe(7);
            expect(r.failed).toHaveLength(0);
            expect(walkFiles(path.join(dst, 'copied'))).toEqual(walkFiles(src));
            expect(fs.readFileSync(path.join(dst, 'copied', 'a', 'b', 'c', 'f5.txt'), 'utf8')).toBe('F5');
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-2: symlink は skip し理由を集計に載せる（containment）', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-'); const outside = tmp('eng-out-');
        try {
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
            fs.writeFileSync(path.join(src, 'ok.txt'), 'OK');
            fs.symlinkSync(outside, path.join(src, 'link-out'), 'dir');
            const r = await copyFolderRecursive(src, dst, { destName: 'copied' });
            expect(r.ok).toBe(true);
            // symlink も参照先も宛先に無い
            expect(fs.existsSync(path.join(dst, 'copied', 'link-out'))).toBe(false);
            expect(walkFiles(path.join(dst, 'copied'))).toEqual(['ok.txt']);
            expect(r.skipped.some((s: any) => s.reason === 'symlink')).toBe(true);
        } finally { for (const d of [src, dst, outside]) { fs.rmSync(d, { recursive: true, force: true }); } }
    });

    test('TC-ENG-3: showHidden=false で dotfile を skip し件数を返す', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            fs.writeFileSync(path.join(src, 'v.txt'), 'V');
            fs.writeFileSync(path.join(src, '.hidden.txt'), 'H');
            const r = await copyFolderRecursive(src, dst, { destName: 'copied' });
            expect(fs.existsSync(path.join(dst, 'copied', '.hidden.txt'))).toBe(false);
            expect(r.skipped.filter((s: any) => s.reason === 'hidden')).toHaveLength(1);
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-4: showHidden=true で dotfile も複製する', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            fs.writeFileSync(path.join(src, 'v.txt'), 'V');
            fs.writeFileSync(path.join(src, '.hidden.txt'), 'H');
            const r = await copyFolderRecursive(src, dst, { destName: 'copied', showHidden: true });
            expect(fs.readFileSync(path.join(dst, 'copied', '.hidden.txt'), 'utf8')).toBe('H');
            expect(r.skipped.filter((s: any) => s.reason === 'hidden')).toHaveLength(0);
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-5: 上限超過は 0 件処理・原状不変（宛先に何も作らない）', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(src, `f${i}.txt`), 'x'); }
            const r = await copyFolderRecursive(src, dst, { destName: 'copied', maxFiles: 5 });
            expect(r.ok).toBe(false);
            expect(r.abort).toBe('too_many_files');
            expect(r.dstAbs).toBeNull();
            expect(fs.readdirSync(dst)).toEqual([]);   // 宛先に何も作られていない
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-6: 深さ超過も 0 件処理', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            fs.mkdirSync(path.join(src, 'a', 'b', 'c', 'd'), { recursive: true });
            fs.writeFileSync(path.join(src, 'a', 'b', 'c', 'd', 'deep.txt'), 'D');
            const r = await copyFolderRecursive(src, dst, { destName: 'copied', maxDepth: 2 });
            expect(r.ok).toBe(false);
            expect(r.abort).toBe('too_deep');
            expect(fs.readdirSync(dst)).toEqual([]);
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-7: 読めない子フォルダは落として続行し skip 集計に載る', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            fs.writeFileSync(path.join(src, 'ok.txt'), 'OK');
            fs.mkdirSync(path.join(src, 'bad'));
            fs.writeFileSync(path.join(src, 'bad', 'inner.txt'), 'I');
            const injected = {
                ...require('fs'),
                readdirSync: (p: any, o: any) => {
                    if (String(p).endsWith(`${path.sep}bad`)) { throw new Error('EACCES'); }
                    return fs.readdirSync(p, o);
                },
            };
            const r = await copyFolderRecursive(src, dst, { destName: 'copied', fs: injected as any });
            expect(r.ok).toBe(true);
            expect(fs.readFileSync(path.join(dst, 'copied', 'ok.txt'), 'utf8')).toBe('OK');
            expect(r.skipped.some((s: any) => s.reason === 'unreadable_dir')).toBe(true);
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-8: 個別ファイルの失敗は failed に載り例外を投げない・null を返さない', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            fs.writeFileSync(path.join(src, 'ok.txt'), 'OK');
            fs.writeFileSync(path.join(src, 'ng.txt'), 'NG');
            const injected = {
                ...require('fs'),
                copyFileSync: (a: any, b: any) => {
                    if (String(a).endsWith('ng.txt')) { throw new Error('EIO'); }
                    return fs.copyFileSync(a, b);
                },
            };
            const r = await copyFolderRecursive(src, dst, { destName: 'copied', fs: injected as any });
            expect(r).not.toBeNull();
            expect(r.copiedFiles).toBe(1);
            expect(r.failed).toHaveLength(1);
            expect(r.failed[0].reason).toBe('copy_failed');
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-9: 部分コピーの残骸を消さない', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            for (const n of ['1.txt', '2.txt', '3.txt']) { fs.writeFileSync(path.join(src, n), n); }
            const injected = {
                ...require('fs'),
                copyFileSync: (a: any, b: any) => {
                    if (String(a).endsWith('3.txt')) { throw new Error('EIO'); }
                    return fs.copyFileSync(a, b);
                },
            };
            const r = await copyFolderRecursive(src, dst, { destName: 'copied', fs: injected as any });
            expect(r.copiedFiles).toBe(2);
            // 残骸（成功した 2 件）が宛先に残っている
            expect(walkFiles(path.join(dst, 'copied'))).toEqual(['1.txt', '2.txt']);
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-ENG-10: 走査結果に総ファイル数と最大深さを返す', async () => {
        const { walkFolderCount } = engine();
        const src = tmp('eng-src-');
        try {
            mkTree(src);
            const p = await walkFolderCount(src);
            expect(p.ok).toBe(true);
            expect(p.totalFiles).toBe(7);
            expect(p.maxDepthSeen).toBe(3);
        } finally { fs.rmSync(src, { recursive: true, force: true }); }
    });

    test('TC-ENG-11: エンジンは件数ゲートを呼ばない（純関数）', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            mkTree(src);
            let gateCalls = 0;
            const gate = () => { gateCalls++; return true; };
            // opts に gate を混ぜても呼ばれない（エンジンの契約にゲートは存在しない）
            await copyFolderRecursive(src, dst, { destName: 'copied', checkBatchLimit: gate } as any);
            expect(gateCalls).toBe(0);
            // ソース上でも既存ゲート関数を参照していない（NFR-FDP-05: 配線点 2 箇所を増やさない）
            const code = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'folder-copy-engine.ts'), 'utf8');
            expect(/checkBatchLimit|runBatchTransfer|showErrorMessage|showWarningMessage/.test(code)).toBe(false);
            // 閾値定数を新しく export していない
            expect(/export const\s+\w*MAX_(FILES|DEPTH)/.test(code)).toBe(false);
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-GATE-4: 走査専用モードは fs に書き込まない', async () => {
        const { walkFolderCount } = engine();
        const src = tmp('eng-src-');
        try {
            mkTree(src);
            let writes = 0;
            const injected = {
                ...require('fs'),
                mkdirSync: (...a: any[]) => { writes++; return (fs.mkdirSync as any)(...a); },
                copyFileSync: (...a: any[]) => { writes++; return (fs.copyFileSync as any)(...a); },
            };
            const p = await walkFolderCount(src, { fs: injected as any });
            expect(p.ok).toBe(true);
            expect(writes).toBe(0);
        } finally { fs.rmSync(src, { recursive: true, force: true }); }
    });

    test('TC-PERF-1: 2000 ファイルの複製中に制御を譲る（NFR-FDP-01）', async () => {
        const { copyFolderRecursive } = engine();
        const src = tmp('eng-src-'); const dst = tmp('eng-dst-');
        try {
            mkMany(src, 2000, 10);
            const probe = startEventLoopProbe();
            const r = await copyFolderRecursive(src, dst, { destName: 'copied', maxFiles: 5000 });
            const { ticks, maxGap } = probe.stop();
            expect(r.ok).toBe(true);
            expect(r.copiedFiles).toBe(2000);
            // 🔴 チャンク譲渡が無いと本体は同期一括で走り切り event loop が 1 度も回らない（ticks=0）。
            //    maxGap だけでは 2000 件が 200ms 未満で終わるため判別できなかった（false-green を実測）。
            expect(ticks).toBeGreaterThanOrEqual(5);
            expect(maxGap).toBeLessThan(200);
        } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
    });

    test('TC-PERF-2: 走査専用モードも制御を譲る（5000 ファイル・NFR-FDP-01）', async () => {
        const { walkFolderCount } = engine();
        const src = tmp('eng-src-');
        try {
            mkMany(src, 5000, 10);
            const probe = startEventLoopProbe();
            const p = await walkFolderCount(src, { maxFiles: 9000 });
            const { ticks, maxGap } = probe.stop();
            expect(p.ok).toBe(true);
            expect(p.totalFiles).toBe(5000);
            expect(ticks).toBeGreaterThanOrEqual(5);
            expect(maxGap).toBeLessThan(200);
        } finally { fs.rmSync(src, { recursive: true, force: true }); }
    });

    test('TC-CON-4: 別デバイス移動の中断分岐がエンジンを参照していない（番人）', () => {
        const root = path.join(__dirname, '..', '..', 'src');
        const handler = fs.readFileSync(path.join(root, 'shared', 'notes-message-handler.ts'), 'utf8');
        // EXDEV 中断分岐の周辺に copyFolderRecursive が現れないこと（複製 + 削除の救済への流用禁止）
        const idx = handler.indexOf('EXDEV');
        expect(idx).toBeGreaterThan(-1);
        const around = handler.slice(Math.max(0, idx - 1200), idx + 1200);
        expect(around.includes('copyFolderRecursive')).toBe(false);
        // エンジン doc に禁止が明記されている
        const eng = fs.readFileSync(path.join(root, 'shared', 'folder-copy-engine.ts'), 'utf8');
        expect(eng.includes('禁止用途')).toBe(true);
    });
});
