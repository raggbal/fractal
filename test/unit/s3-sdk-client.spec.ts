/**
 * s3-sdk-client unit — @aws-sdk/client-s3 v3 ラッパ (SDK クライアント mock 注入)
 *
 * mock 方式: paginateListObjectsV2 / lib-storage Upload はどちらも
 *   `config.client instanceof S3Client` を要求する (createPaginator が throw / Upload が
 *   client.config を参照) ため、**実 S3Client を生成して .send を差し替える**方式で mock する。
 *   これにより SDK の pagination・multipart 分割ロジックを実物で走らせつつ、ネットワークは出さない。
 *
 * TC-SDK-01: listAllObjects 2 ページ pagination → 全件 {key, lastModified: Date, size}
 * TC-SDK-02: headObject 404 → null / 200 → 値
 * TC-SDK-03: uploadFile 6MB 超で lib-storage Upload = multipart 経由 (Create/UploadPart/Complete)
 * TC-SDK-04: downloadToFile がネスト dest の親を mkdir し内容バイト一致
 * TC-SDK-05: DeleteObjects 唯一性 gate (deleteAllUnderPrefix 関数内のみ + sync 経路に 0)
 * TC-SDK-06: runWithConcurrency fail-fast (reject 後に新規 fn を開始しない・例外伝播)
 * TC-SDK-07: deleteAllUnderPrefix 1500 keys → DeleteObjects 2 batch (1000/500)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { S3Client } from '@aws-sdk/client-s3';
import {
    createS3,
    listAllObjects,
    headObject,
    downloadToFile,
    uploadFile,
    deleteAllUnderPrefix,
    runWithConcurrency,
} from '../../src/shared/s3-sdk-client';

/** 実 S3Client を作り、send だけ差し替える (paginator/Upload の instanceof 要件を満たす)。 */
function mockS3(send: (cmd: any) => Promise<any>): S3Client {
    const s3 = createS3({ accessKeyId: 'AK', secretAccessKey: 'SK', region: 'us-east-1' });
    (s3 as any).send = send;
    return s3;
}

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 's3sdk-'));
}

test('TC-SDK-01 listAllObjects が 2 ページを追従し全件を {key,lastModified:Date,size} で返す', async () => {
    const lm1 = new Date('2026-01-01T00:00:00Z');
    const lm2 = new Date('2026-01-02T00:00:00Z');
    let calls = 0;
    const s3 = mockS3(async (cmd) => {
        calls++;
        const token = cmd.input.ContinuationToken;
        if (!token) {
            return { Contents: [{ Key: 'p/a.md', LastModified: lm1, Size: 10 }], IsTruncated: true, NextContinuationToken: 'TOK2' };
        }
        return { Contents: [{ Key: 'p/b.md', LastModified: lm2, Size: 20 }], IsTruncated: false };
    });

    const objs = await listAllObjects(s3, 'bucket', 'p/');

    expect(calls).toBe(2); // pagination が 2 ページ回った
    expect(objs).toHaveLength(2);
    expect(objs.map((o) => o.key)).toEqual(['p/a.md', 'p/b.md']);
    expect(objs[0].lastModified).toBeInstanceOf(Date);
    expect(objs[0].lastModified.getTime()).toBe(lm1.getTime());
    expect(objs[0].size).toBe(10);
    expect(objs[1].size).toBe(20);
    // buildSyncPlan 互換形状: 3 フィールドのみ
    expect(Object.keys(objs[0]).sort()).toEqual(['key', 'lastModified', 'size']);
});

test('TC-SDK-02 headObject は 404/NotFound を null に、200 を値に写す', async () => {
    // NotFound (name) → null
    const notFound = mockS3(async () => { throw Object.assign(new Error('Not Found'), { name: 'NotFound' }); });
    expect(await headObject(notFound, 'b', 'missing')).toBeNull();

    // $metadata 404 → null
    const meta404 = mockS3(async () => { throw Object.assign(new Error('nf'), { $metadata: { httpStatusCode: 404 } }); });
    expect(await headObject(meta404, 'b', 'missing2')).toBeNull();

    // 200 → 値
    const lm = new Date('2026-03-03T03:03:03Z');
    const ok = mockS3(async () => ({ LastModified: lm, ContentLength: 42 }));
    const info = await headObject(ok, 'b', 'present');
    expect(info).not.toBeNull();
    expect(info!.lastModified.getTime()).toBe(lm.getTime());
    expect(info!.size).toBe(42);

    // それ以外のエラーは throw (fail-fast)
    const boom = mockS3(async () => { throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); });
    await expect(headObject(boom, 'b', 'x')).rejects.toThrow(/AccessDenied/);
});

test('TC-SDK-03 uploadFile は 6MB 超で lib-storage Upload = multipart 経由で送る', async () => {
    const dir = mkTmp();
    const big = path.join(dir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0x37)); // 6MB > 5MB → multipart

    const seen: string[] = [];
    const s3 = mockS3(async (cmd) => {
        const name = cmd.constructor.name;
        seen.push(name);
        if (name === 'CreateMultipartUploadCommand') return { UploadId: 'uid-1' };
        if (name === 'UploadPartCommand') return { ETag: `"etag-${cmd.input.PartNumber}"` };
        if (name === 'CompleteMultipartUploadCommand') return { Location: 'loc' };
        if (name === 'PutObjectCommand') return { ETag: '"single"' };
        return {};
    });

    await uploadFile(s3, 'bucket', 'k/big.bin', big);

    // lib-storage Upload が使われた証拠 = multipart コマンド列 (単発 PutObject ではない)
    expect(seen).toContain('CreateMultipartUploadCommand');
    expect(seen).toContain('UploadPartCommand');
    expect(seen).toContain('CompleteMultipartUploadCommand');
    expect(seen).not.toContain('PutObjectCommand');
    expect(seen.filter((n) => n === 'UploadPartCommand').length).toBeGreaterThanOrEqual(2); // 6MB → 2 パート以上

    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-SDK-04 downloadToFile はネスト親 dir を mkdir し内容がバイト一致', async () => {
    const dir = mkTmp();
    const dest = path.join(dir, 'a', 'b', 'c', 'file.bin'); // 親 3 段は未作成
    const payload = Buffer.from('nested-download-payload-bytes', 'binary');

    const s3 = mockS3(async (cmd) => {
        expect(cmd.constructor.name).toBe('GetObjectCommand');
        return { Body: Readable.from(payload) };
    });

    await downloadToFile(s3, 'bucket', 'k/file.bin', dest);

    expect(fs.existsSync(path.dirname(dest))).toBe(true); // mkdir -p された
    const got = fs.readFileSync(dest);
    expect(Buffer.compare(got, payload)).toBe(0); // バイト一致

    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-SDK-05 DeleteObjects は deleteAllUnderPrefix 関数内のみ + sync 経路に Delete 0 (NFR-SDK-01 番人)', () => {
    const clientSrc = fs.readFileSync(path.join(__dirname, '../../src/shared/s3-sdk-client.ts'), 'utf8');

    // deleteAllUnderPrefix 関数ブロックの範囲を波括弧バランスで特定
    const declIdx = clientSrc.indexOf('export async function deleteAllUnderPrefix');
    expect(declIdx).toBeGreaterThanOrEqual(0);
    const bodyStart = clientSrc.indexOf('{', declIdx);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let bodyEnd = -1;
    for (let i = bodyStart; i < clientSrc.length; i++) {
        const ch = clientSrc[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { bodyEnd = i; break; }
        }
    }
    expect(bodyEnd).toBeGreaterThan(bodyStart);

    // "DeleteObject" 文字列 (import 名 DeleteObjectsCommand 含む) の全出現位置が
    // deleteAllUnderPrefix 関数ブロック [bodyStart, bodyEnd] 内に収まること
    const re = /DeleteObject/g;
    let m: RegExpExecArray | null;
    const positions: number[] = [];
    while ((m = re.exec(clientSrc)) !== null) positions.push(m.index);
    expect(positions.length).toBeGreaterThan(0); // 実装が存在する
    for (const pos of positions) {
        expect(pos).toBeGreaterThan(bodyStart);
        expect(pos).toBeLessThan(bodyEnd);
    }

    // sync 経路 (s3-per-file-sync.ts / notes-s3-sync.ts) に Delete 系 0 件
    for (const rel of ['../../src/s3-per-file-sync.ts', '../../src/notes-s3-sync.ts']) {
        const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        expect(src.includes('DeleteObject')).toBe(false);
    }
});

test('TC-SDK-06 runWithConcurrency は fail-fast (3 個目 reject 後に新規 fn を開始しない・例外伝播)', async () => {
    // counterfactual: Promise.all 化すると 10 件全て開始され started.length===10 で RED になる。
    // fail-fast の逐次プール(limit=3)なら、reject 検知後に新規 fn を開始しないので started < 10。
    const items = Array.from({ length: 10 }, (_, i) => i);
    const started: number[] = [];
    const REJECT_AT = 2; // 3 個目 (index 2)

    const err = await runWithConcurrency(items, 3, async (i) => {
        started.push(i);
        // 少し待ってから解決/reject し、プールの補充タイミングを観測可能にする
        await new Promise((r) => setTimeout(r, 5));
        if (i === REJECT_AT) throw new Error(`fail at ${REJECT_AT}`);
    }).then(() => null).catch((e) => e as Error);

    expect(err).toBeInstanceOf(Error); // 最初の例外が伝播
    expect(err!.message).toBe(`fail at ${REJECT_AT}`);
    // fail-fast: 全 10 件は開始されない (Promise.all 化なら 10 で RED)
    expect(started.length).toBeLessThan(items.length);
    // 3 並列なので初回バッチの 3 件 (0,1,2) は開始済み。REJECT は含まれる。
    expect(started).toContain(REJECT_AT);
});

test('TC-SDK-07 deleteAllUnderPrefix 1500 keys で DeleteObjects が 1000/500 の 2 batch', async () => {
    const keys = Array.from({ length: 1500 }, (_, i) => `p/obj-${i}.bin`);
    const deleteBatchSizes: number[] = [];
    let listCalls = 0;

    const s3 = mockS3(async (cmd) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectsV2Command') {
            listCalls++;
            // 1 ページに全 1500 件を返す (pagination なし)
            return { Contents: keys.map((k) => ({ Key: k, LastModified: new Date(), Size: 1 })), IsTruncated: false };
        }
        if (name === 'DeleteObjectsCommand') {
            deleteBatchSizes.push(cmd.input.Delete.Objects.length);
            return { Deleted: cmd.input.Delete.Objects };
        }
        return {};
    });

    const deleted = await deleteAllUnderPrefix(s3, 'bucket', 'p/');

    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(deleteBatchSizes).toEqual([1000, 500]); // batch 1000 上限で 2 回
    expect(deleted).toBe(1500);
});
