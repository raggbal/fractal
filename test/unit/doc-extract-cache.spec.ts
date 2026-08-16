/**
 * doc-extract-cache.spec.ts — 抽出テキストキャッシュ（doc-extract-cache.ts）
 *
 * sprint 20260813-133248-search-doc-content / TASK-04。
 * design/system.md §2 / ADRL-0058 / testcases.md B 節。
 *
 * 検証対象（behavioral + counterfactual）:
 *  - TC-DS-10: 2 回目 getOrExtract は抽出関数を呼ばない（counterfactual: mtime touch で再抽出）
 *  - TC-DS-11: mtime/size 変化で再抽出され新内容
 *  - TC-DS-12: skipReason truthy 番人 — skip 記録後の 2 回目も抽出関数が呼ばれない
 *  - TC-DS-13: cacheDir=null で例外なく都度抽出（fallback）
 *  - TC-DS-32: 50MB 超 → 抽出前に too_large（抽出関数が呼ばれない）
 *  - TC-DS-33: キャッシュファイルは cacheDir 配下（note フォルダ外 — NFR-DS-06）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { DocExtractCache } from '../../src/shared/doc-extract-cache';

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 抽出関数の呼び出し回数を記録する spy 付き cache を作る */
function mkCache(cacheDir: string | null) {
    const calls: string[] = [];
    const cache = new DocExtractCache(cacheDir, async (buf, ext) => {
        calls.push(ext);
        return { lines: [`extracted:${buf.length}`], truncated: false };
    });
    return { cache, calls };
}

test.describe('DocExtractCache（ADRL-0058）', () => {
    let dirs: string[] = [];
    const track = (d: string) => { dirs.push(d); return d; };
    test.afterEach(() => {
        for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
        dirs = [];
    });

    test('TC-DS-10: キャッシュヒット時は抽出関数を呼ばない（mtime touch で再抽出 = counterfactual）', async () => {
        const noteDir = track(mkTmp('doc-cache-note-'));
        const cacheDir = track(mkTmp('doc-cache-store-'));
        const file = path.join(noteDir, 'a.docx');
        fs.writeFileSync(file, 'dummy-docx-bytes');

        const { cache, calls } = mkCache(cacheDir);
        const r1 = await cache.getOrExtract(file);
        expect(r1.lines[0]).toContain('extracted:');
        expect(calls.length).toBe(1);

        const r2 = await cache.getOrExtract(file);      // 2 回目 = ヒット
        expect(r2.lines).toEqual(r1.lines);
        expect(calls.length).toBe(1);                    // 抽出は走らない

        // counterfactual: mtime を進めると再抽出
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(file, future, future);
        await cache.getOrExtract(file);
        expect(calls.length).toBe(2);
    });

    test('TC-DS-11: 内容更新（size 変化）で再抽出され新内容を返す', async () => {
        const noteDir = track(mkTmp('doc-cache-note-'));
        const cacheDir = track(mkTmp('doc-cache-store-'));
        const file = path.join(noteDir, 'b.xlsx');
        fs.writeFileSync(file, 'v1');

        const { cache, calls } = mkCache(cacheDir);
        const r1 = await cache.getOrExtract(file);
        expect(r1.lines[0]).toBe('extracted:2');

        fs.writeFileSync(file, 'v2-longer');             // size 変化
        const r2 = await cache.getOrExtract(file);
        expect(r2.lines[0]).toBe('extracted:9');
        expect(calls.length).toBe(2);
    });

    test('TC-DS-12: skipReason truthy 番人 — skip 記録後の 2 回目も抽出関数を呼ばない', async () => {
        const noteDir = track(mkTmp('doc-cache-note-'));
        const cacheDir = track(mkTmp('doc-cache-store-'));
        const file = path.join(noteDir, 'c.pdf');
        fs.writeFileSync(file, 'broken-pdf');

        const calls: string[] = [];
        const cache = new DocExtractCache(cacheDir, async (_buf, ext) => {
            calls.push(ext);
            return { lines: [], truncated: false, skipReason: 'pdf_no_text' };
        });
        const r1 = await cache.getOrExtract(file);
        expect(r1.skipReason).toBe('pdf_no_text');
        expect(calls.length).toBe(1);

        // counterfactual の核: skip 結果が falsy 記録だと毎回再抽出になる（CLI :445 と同型の穴）
        const r2 = await cache.getOrExtract(file);
        expect(r2.skipReason).toBe('pdf_no_text');
        expect(calls.length).toBe(1);                    // 再抽出ループしない
    });

    test('TC-DS-13: cacheDir=null は例外なく都度抽出（fallback 経路）', async () => {
        const noteDir = track(mkTmp('doc-cache-note-'));
        const file = path.join(noteDir, 'd.pptx');
        fs.writeFileSync(file, 'bytes');

        const { cache, calls } = mkCache(null);
        const r1 = await cache.getOrExtract(file);
        const r2 = await cache.getOrExtract(file);
        expect(r1.lines).toEqual(r2.lines);
        expect(calls.length).toBe(2);                    // キャッシュなし = 都度抽出
    });

    test('TC-DS-32: 50MB 超は抽出前に too_large（抽出関数が呼ばれない）', async () => {
        const noteDir = track(mkTmp('doc-cache-note-'));
        const cacheDir = track(mkTmp('doc-cache-store-'));
        const file = path.join(noteDir, 'huge.docx');
        // 実 50MB を書くのは重いので sparse: truncate でサイズだけ 50MB+1 にする
        const fd = fs.openSync(file, 'w');
        fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1);
        fs.closeSync(fd);

        const { cache, calls } = mkCache(cacheDir);
        const r = await cache.getOrExtract(file);
        expect(r.skipReason).toBe('too_large');
        expect(calls.length).toBe(0);                    // 読み込みも抽出もしない
    });

    test('TC-DS-33: キャッシュファイルは cacheDir 配下（note フォルダ外 — NFR-DS-06）', async () => {
        const noteDir = track(mkTmp('doc-cache-note-'));
        const cacheDir = track(mkTmp('doc-cache-store-'));
        const file = path.join(noteDir, 'e.docx');
        fs.writeFileSync(file, 'bytes');

        const { cache } = mkCache(cacheDir);
        await cache.getOrExtract(file);

        // note フォルダには何も書かれない
        expect(fs.readdirSync(noteDir)).toEqual(['e.docx']);
        // cacheDir にはエントリが書かれる
        const cached = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
        expect(cached.length).toBe(1);
    });
});

test.describe('DocExtractCache.evict（TASK-13 / SEC-3）', () => {
    test('TC-DS-44: evict 後にキャッシュファイル不在 + 次回 getOrExtract は再抽出', async () => {
        const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-evict-'));
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-evict-store-'));
        try {
            const file = path.join(noteDir, 'secret.docx');
            fs.writeFileSync(file, 'confidential-bytes');
            const calls: string[] = [];
            const cache = new DocExtractCache(cacheDir, async (buf, ext) => {
                calls.push(ext);
                return { lines: ['機密テキスト'], truncated: false };
            });
            await cache.getOrExtract(file);
            expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length).toBe(1);

            cache.evict(file);
            // 抽出済み本文テキストが globalStorage 相当から消える（SEC-3 の核）
            expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length).toBe(0);

            await cache.getOrExtract(file);              // 次回は再抽出
            expect(calls.length).toBe(2);

            // cacheDir=null でも evict は例外を出さない
            new DocExtractCache(null).evict(file);
        } finally {
            fs.rmSync(noteDir, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});

test.describe('キャッシュ二分（sprint 20260815 / FR-DS-04 rev.2 / NFR-DS-08）', () => {

    test('TC-DS-67: version bump 番人 — 旧 formatVersion:2 の unsupported_ext 記録が stale ヒットしない', async () => {
        const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-v3-'));
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-v3-store-'));
        try {
            const file = path.join(noteDir, 'memo.txt');
            fs.writeFileSync(file, '議事録テキスト');
            const st = fs.statSync(file);
            // 旧 version(2) キャッシュに unsupported_ext を truthy 記録した状態を再現
            const key = crypto.createHash('sha256').update(file).digest('hex').slice(0, 16);
            fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify({
                formatVersion: 2, mtimeMs: st.mtimeMs, size: st.size,
                result: { lines: [], truncated: false, skipReason: 'unsupported_ext' },
            }));
            const cache = new DocExtractCache(cacheDir);   // 正典 extractDocText で実抽出
            const r = await cache.getOrExtract(file);
            // counterfactual: CACHE_FORMAT_VERSION が 2 のままだと旧 skip が返り RED
            expect(r.skipReason).toBeUndefined();
            expect(r.lines.map((l) => l.text).join('')).toContain('議事録');
        } finally {
            fs.rmSync(noteDir, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test('TC-DS-67b: binary skip は記録される — 2 回目は抽出関数が呼ばれない（NFR-DS-02）', async () => {
        const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-bin-'));
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-bin-store-'));
        try {
            const file = path.join(noteDir, 'blob.bin');
            fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
            let calls = 0;
            const cache = new DocExtractCache(cacheDir, async () => {
                calls++;
                return { lines: [], truncated: false, skipReason: 'binary' as const };
            });
            await cache.getOrExtract(file);
            expect(calls).toBe(1);
            const second = await cache.getOrExtract(file);
            expect(calls, 'binary 判定はキャッシュされ再 sniff しない').toBe(1);
            expect(second.skipReason).toBe('binary');
            // mtime 変化で再判定
            fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
            await cache.getOrExtract(file);
            expect(calls).toBe(2);
        } finally {
            fs.rmSync(noteDir, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test('TC-DS-68: 秘密非複製番人 — テキスト本文がキャッシュ dir のどこにも書かれない（NFR-DS-08）', async () => {
        const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-sec-'));
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-sec-store-'));
        try {
            const marker = 'SECRETMARKER123XYZ';
            const file = path.join(noteDir, 'credentials.env');
            fs.writeFileSync(file, `API_KEY=${marker}\n`);
            const cache = new DocExtractCache(cacheDir);   // 正典 extractDocText（noCache 契約の実挙動）
            const r = await cache.getOrExtract(file);
            expect(r.skipReason).toBeUndefined();
            expect(r.lines.map((l) => l.text).join('')).toContain(marker);   // 検索自体は機能する
            // counterfactual: noCache 条件を外すと cacheDir に平文複製されて RED
            const leaked = fs.readdirSync(cacheDir)
                .map((f) => fs.readFileSync(path.join(cacheDir, f), 'utf8'))
                .some((content) => content.includes(marker));
            expect(leaked, 'テキスト本文が globalStorage キャッシュに平文複製されない').toBe(false);
        } finally {
            fs.rmSync(noteDir, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});

test.describe('キャッシュ形式 version（TASK-17 / FR-DS-09 / TC-DS-55）', () => {
    test('TC-DS-55: 旧形式（formatVersion なし = loc 導入前）のキャッシュは invalidate され再抽出', async () => {
        const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-fmt-'));
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-fmt-store-'));
        try {
            const file = path.join(noteDir, 'a.docx');
            fs.writeFileSync(file, 'bytes');
            const calls: string[] = [];
            const cache = new DocExtractCache(cacheDir, async (_buf, ext) => {
                calls.push(ext);
                return { lines: [{ text: 'new-format' }], truncated: false };
            });
            // 1 回目: 抽出してキャッシュ生成
            await cache.getOrExtract(file);
            expect(calls.length).toBe(1);
            // キャッシュを旧形式（formatVersion 欠落 + string[] lines）に書き換え
            const cacheFile = path.join(cacheDir, fs.readdirSync(cacheDir).find((f) => f.endsWith('.json')) as string);
            const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            delete entry.formatVersion;
            entry.result.lines = ['old-string-format'];
            fs.writeFileSync(cacheFile, JSON.stringify(entry));
            // 2 回目: 旧形式は miss 扱いで再抽出（stale な string[] を返さない）
            const r = await cache.getOrExtract(file);
            expect(calls.length).toBe(2);
            expect(r.lines[0]).toEqual({ text: 'new-format' });
        } finally {
            fs.rmSync(noteDir, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
