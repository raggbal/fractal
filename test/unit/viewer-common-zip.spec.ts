/**
 * viewer-common-zip.spec.ts — viewer-zip 基盤（src/webview/viewer-common/zip.mjs）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-01。
 * 検証（behavioral + counterfactual）:
 *  - TC-VEX-04: 合成 zip（stored + deflate 混在）の entries/readEntry 正常系 /
 *               PK magic 不一致（CFB 先頭）→ NOT_ZIP / ZIP64 sentinel → ZIP64_UNSUPPORTED
 *  - TC-VEX-05: zip ガード①宣言 uncompressedSize > 上限 → 読む前 reject
 *               （spy 代替: 圧縮データを壊しておく — inflate が走れば別 code になる構造で「未実行」を behavioral に証明）
 *  - TC-VEX-06: zip ガード②宣言詐称（小さい宣言・実展開が上限超）→ 累積カウント cancel + reject。
 *               counterfactual: 上限を Infinity 注入すると同じ zip が成功する（ガードが失敗の原因であることの証明）
 *  - TC-VEX-07: zip ガード③累積展開量（ファイル単位 budget・注入で縮小）→ 超過後の readEntry reject
 *
 * fixture は spec 内合成（TC-DS-42 手法 — 巨大バイナリを commit しない）。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as zlib from 'zlib';

const MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-common', 'zip.mjs');
const loadZip = async () => await import(/* webpackIgnore: true */ MOD);

// ── 最小 zip 合成（central directory + local header 手書き） ──
interface SynthEntry { name: string; data: Buffer; method: 0 | 8; declaredUncompressed?: number }
function buildZip(entries: SynthEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const compressed = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
        const declared = e.declaredUncompressed !== undefined ? e.declaredUncompressed : e.data.length;
        const loc = Buffer.alloc(30);
        loc.writeUInt32LE(0x04034b50, 0);
        loc.writeUInt16LE(20, 4); // version
        loc.writeUInt16LE(e.method, 8);
        loc.writeUInt32LE(compressed.length, 18);
        loc.writeUInt32LE(declared, 22);
        loc.writeUInt16LE(nameBuf.length, 26);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(e.method, 10);
        cen.writeUInt32LE(compressed.length, 20);
        cen.writeUInt32LE(declared, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt32LE(offset, 42);
        locals.push(loc, nameBuf, compressed);
        centrals.push(cen, nameBuf);
        offset += 30 + nameBuf.length + compressed.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
const toU8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

test.describe('TC-VEX-04: zip 正常系と非 zip 拒否', () => {
    test('stored + deflate 混在の entries/readEntry', async () => {
        const { openZip } = await loadZip();
        const zip = buildZip([
            { name: 'a.txt', data: Buffer.from('hello stored'), method: 0 },
            { name: 'dir/b.xml', data: Buffer.from('<x>日本語</x>'), method: 8 },
        ]);
        const z = await openZip(toU8(zip));
        const names = [...z.entries().keys()];
        expect(names).toEqual(['a.txt', 'dir/b.xml']);
        expect(Buffer.from(await z.readEntry('a.txt')).toString('utf8')).toBe('hello stored');
        expect(Buffer.from(await z.readEntry('dir/b.xml')).toString('utf8')).toBe('<x>日本語</x>');
    });
    test('PK magic 不一致（CFB 先頭バイト）→ NOT_ZIP', async () => {
        const { openZip } = await loadZip();
        const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
        await expect(openZip(toU8(cfb))).rejects.toMatchObject({ code: 'NOT_ZIP' });
    });
    test('ZIP64 sentinel → ZIP64_UNSUPPORTED', async () => {
        const { openZip } = await loadZip();
        const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0 }]);
        // EOCD の totalEntries を 0xffff に書き換え（sentinel）
        zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
        await expect(openZip(toU8(zip))).rejects.toMatchObject({ code: 'ZIP64_UNSUPPORTED' });
    });
});

test.describe('TC-VEX-05: ガード① 宣言サイズ事前検証（inflate 未実行）', () => {
    test('宣言 > 上限は読む前に reject（壊れ deflate でも corrupt にならない = inflate 未到達の証明）', async () => {
        const { openZip } = await loadZip();
        // 圧縮データはデタラメ（inflate すれば必ず失敗する）。宣言だけ巨大。
        const zip = buildZip([{ name: 'bomb.bin', data: Buffer.from('not-deflate!!'), method: 8, declaredUncompressed: 200 * 1024 * 1024 }]);
        const z = await openZip(toU8(zip));
        await expect(z.readEntry('bomb.bin')).rejects.toMatchObject({ code: 'ENTRY_TOO_LARGE' });
    });
});

test.describe('TC-VEX-06: ガード② 宣言詐称は累積カウントで打ち切り', () => {
    const makeForged = () => {
        // 実体 2MB のゼロ（高圧縮）・宣言は 100 バイトに詐称
        return buildZip([{ name: 'forged.bin', data: Buffer.alloc(2 * 1024 * 1024), method: 8, declaredUncompressed: 100 }]);
    };
    test('注入上限 64KB で ENTRY_TOO_LARGE（cancel）', async () => {
        const { openZip } = await loadZip();
        const z = await openZip(toU8(makeForged()), { maxEntryBytes: 64 * 1024 });
        await expect(z.readEntry('forged.bin')).rejects.toMatchObject({ code: 'ENTRY_TOO_LARGE' });
    });
    test('counterfactual: 上限 Infinity なら同じ zip が成功（ガードが原因であることの証明）', async () => {
        const { openZip } = await loadZip();
        const z = await openZip(toU8(makeForged()), { maxEntryBytes: Infinity, maxTotalBytes: Infinity });
        const out = await z.readEntry('forged.bin');
        expect(out.byteLength).toBe(2 * 1024 * 1024);
    });
});

test.describe('TC-VEX-07: ガード③ ファイル単位の累積展開量 budget', () => {
    test('budget 1MB 注入 — 600KB×3 エントリの 2 個目以降で reject', async () => {
        const { openZip } = await loadZip();
        const e = (n: string): SynthEntry => ({ name: n, data: Buffer.alloc(600 * 1024, 0x61), method: 8 });
        const zip = buildZip([e('e1'), e('e2'), e('e3')]);
        const z = await openZip(toU8(zip), { maxTotalBytes: 1024 * 1024 });
        expect((await z.readEntry('e1')).byteLength).toBe(600 * 1024);
        await expect(z.readEntry('e2')).rejects.toMatchObject({ code: 'ZIP_BUDGET_EXCEEDED' });
        await expect(z.readEntry('e3')).rejects.toMatchObject({ code: 'ZIP_BUDGET_EXCEEDED' });
    });
});
