/**
 * s3-sdk-client.ts — @aws-sdk/client-s3 v3 wrapper (I/O 層のみ)
 *
 * `aws` CLI (spawn) を置き換える S3 操作の薄いラッパ。編成ロジック
 * (newer-wins / chunk / segment protection / fail-fast) は呼び出し側で不変に保つ。
 * vscode 非依存 (node 標準 + @aws-sdk のみ)。全関数 fail-fast (例外はそのまま throw)。
 * S3Client は引数注入で受け取り、unit で send を差し替えられる。
 *
 * 根拠: design/system.md §2 (DOM-S3SdkClient) / PoC s3-sdk-spike.ts。
 */
import {
    S3Client,
    HeadObjectCommand,
    GetObjectCommand,
    paginateListObjectsV2,
    type _Object as S3ContentObject,
    type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface S3SdkConfig {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}

/** 静的キー + region で S3Client を生成 (maxAttempts 3 = SDK 既定 retry)。 */
export function createS3(config: S3SdkConfig): S3Client {
    return new S3Client({
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
        maxAttempts: 3,
    });
}

/**
 * prefix 配下の全オブジェクトを列挙 (pagination は paginateListObjectsV2 が追従)。
 * 返り値は buildSyncPlan / decideSyncDirection が消費する形 (lastModified は Date)。
 */
export async function listAllObjects(
    s3: S3Client,
    bucket: string,
    prefix: string,
): Promise<Array<{ key: string; lastModified: Date; size: number }>> {
    const results: Array<{ key: string; lastModified: Date; size: number }> = [];
    const paginator = paginateListObjectsV2({ client: s3, pageSize: 1000 }, { Bucket: bucket, Prefix: prefix });
    for await (const page of paginator) {
        for (const obj of page.Contents ?? []) {
            const mapped = mapContentObject(obj);
            if (mapped) results.push(mapped);
        }
    }
    return results;
}

/** _Object → {key, lastModified: Date, size} の純変換 (Key 欠落は null)。 */
function mapContentObject(obj: S3ContentObject): { key: string; lastModified: Date; size: number } | null {
    if (!obj || typeof obj.Key !== 'string') return null;
    return {
        key: obj.Key,
        lastModified: obj.LastModified instanceof Date ? obj.LastModified : new Date(0),
        size: typeof obj.Size === 'number' ? obj.Size : 0,
    };
}

/**
 * 単一オブジェクトの head。存在しなければ null (404 / NotFound / NoSuchKey)。
 * それ以外のエラーはそのまま throw (fail-fast)。
 */
export async function headObject(
    s3: S3Client,
    bucket: string,
    key: string,
): Promise<{ lastModified: Date; size: number } | null> {
    try {
        const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
            lastModified: out.LastModified instanceof Date ? out.LastModified : new Date(0),
            size: typeof out.ContentLength === 'number' ? out.ContentLength : 0,
        };
    } catch (err: unknown) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        const name = e?.name ?? '';
        const status = e?.$metadata?.httpStatusCode;
        if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return null;
        throw err;
    }
}

/**
 * key の内容を destPath に保存。親 dir を mkdir -p し、GetObject の Body stream を
 * pipeline でファイルへ流し込む。
 */
export async function downloadToFile(
    s3: S3Client,
    bucket: string,
    key: string,
    destPath: string,
): Promise<void> {
    const parentDir = path.dirname(destPath);
    fs.mkdirSync(parentDir, { recursive: true });
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = out.Body as unknown as Readable;
    await pipeline(body, fs.createWriteStream(destPath));
}

/**
 * srcPath を key へアップロード。lib-storage の Upload を使い、>5MB は自動で
 * multipart に分割される (argv 上限を意識した chunk hack は不要)。
 */
export async function uploadFile(
    s3: S3Client,
    bucket: string,
    key: string,
    srcPath: string,
): Promise<void> {
    const upload = new Upload({
        client: s3,
        params: {
            Bucket: bucket,
            Key: key,
            Body: fs.createReadStream(srcPath),
        },
    });
    await upload.done();
}

/**
 * items を最大 limit 並列で fn に流す逐次プール。fail-fast:
 * 最初の reject 以降は新規 fn を開始せず、その例外を伝播する
 * (Promise.all 化すると全件開始してしまうため、逐次プールで縮退性を保つ)。
 */
export async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    let idx = 0;
    let failed = false;
    let firstError: unknown;
    const n = Math.max(1, Math.min(limit, items.length || 1));
    const worker = async (): Promise<void> => {
        // failed が立った後は新しい item を取り出さない (= 新規 fn を開始しない)
        while (idx < items.length && !failed) {
            const cur = items[idx++];
            try {
                await fn(cur);
            } catch (err) {
                if (!failed) {
                    failed = true;
                    firstError = err;
                }
                return;
            }
        }
    };
    const runners: Array<Promise<void>> = [];
    for (let i = 0; i < n; i++) runners.push(worker());
    await Promise.all(runners);
    if (failed) throw firstError;
}

/**
 * prefix 配下を全削除して削除件数を返す (rm -r 相当・ユーザー起動経路のみ)。
 * 列挙結果を batch 1000 件ずつまとめて一括削除する。
 * ★このラッパ内で削除 API を呼ぶのはこの関数のみ (sync 経路は削除を参照しない)。
 */
export async function deleteAllUnderPrefix(
    s3: S3Client,
    bucket: string,
    prefix: string,
): Promise<number> {
    // 削除コマンドは削除関数の中でだけ参照する (混入防止 gate 対応)
    const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    let deleted = 0;
    let batch: ObjectIdentifier[] = [];
    const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await s3.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch, Quiet: true },
        }));
        deleted += batch.length;
        batch = [];
    };
    const paginator = paginateListObjectsV2({ client: s3, pageSize: 1000 }, { Bucket: bucket, Prefix: prefix });
    for await (const page of paginator) {
        for (const obj of page.Contents ?? []) {
            if (typeof obj.Key === 'string') {
                batch.push({ Key: obj.Key });
                if (batch.length === 1000) await flush();
            }
        }
    }
    await flush();
    return deleted;
}
