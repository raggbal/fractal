/**
 * notes-s3-sync.ts — S3 同期エンジン (@aws-sdk/client-s3 v3)
 *
 * VSCode固有（src/ 配置）。I/O 層は s3-sdk-client ラッパに委譲し、進捗を
 * コールバックで返す。認証情報は client 生成時に渡す。
 */
import * as path from 'path';
import * as fs from 'fs';
import { parseBucketPath } from './outliner-s3-sync-utils';
import { syncDirectoryBidirectional, SyncDirectoryProgress, walkLocalDir } from './s3-per-file-sync';
import { createS3, listAllObjects, uploadFile, downloadToFile, deleteAllUnderPrefix, runWithConcurrency } from './shared/s3-sdk-client';

export { getAwsEnv } from './outliner-s3-sync-utils';

/** 全消し再アップ / 全消しダウンロードの転送並列上限。 */
const TRANSFER_CONCURRENCY = 8;

export interface S3SyncProgress {
    phase: 'checking' | 'syncing' | 'uploading' | 'downloading' | 'deleting' | 'complete' | 'error';
    message: string;
    currentFile?: string;
    filesProcessed?: number;
}

export interface S3SyncConfig {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    bucketPath: string;   // "my-bucket/notes-backup"
    localPath: string;    // ノートフォルダの絶対パス
}

/**
 * AWS credentials のサブセット（bucketPath / localPath を含まない）
 */
export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}

export function s3Uri(config: S3SyncConfig): string {
    // bucketPath を parseBucketPath と同じ正規化に揃える:
    // `s3://` スキームを除去 + 末尾スラッシュ除去。末尾スラッシュは最後に付け直して
    // フォルダ全体の対象を確実にする。
    const bp = config.bucketPath.trim().replace(/^s3:\/\//, '').replace(/\/+$/, '');
    return `s3://${bp}/`;
}

/**
 * Sync (双方向): per-file mtime newer-wins、`--delete` 不使用
 *
 * per-file mtime 比較で別マシンの編集も取り込む (2026-05-08)。転送は s3-per-file-sync の
 * SDK エンジンに委譲する (編成ロジック不変)。
 */
export async function s3Sync(
    config: S3SyncConfig,
    onProgress: (p: S3SyncProgress) => void,
): Promise<void> {
    const { bucket, prefix } = parseBucketPath(config.bucketPath);
    const creds = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region };

    onProgress({ phase: 'syncing', message: 'Comparing local and S3...' });

    const result = await syncDirectoryBidirectional(
        bucket,
        prefix,
        config.localPath,
        creds,
        (p: SyncDirectoryProgress) => {
            const phase: S3SyncProgress['phase'] = p.action === 'upload' ? 'uploading' : 'downloading';
            onProgress({
                phase,
                message: `${p.action === 'upload' ? 'Uploading' : 'Downloading'} (${p.processed}/${p.total}): ${p.relPath}`,
                currentFile: p.relPath,
                filesProcessed: p.processed,
            });
        },
    );

    onProgress({
        phase: 'complete',
        message: `Sync complete. uploaded=${result.uploaded} downloaded=${result.downloaded} skipped=${result.skipped}`,
    });
}

/**
 * Remote Delete & Upload: S3のデータを全削除してからローカルをアップロード
 */
export async function s3RemoteDeleteAndUpload(
    config: S3SyncConfig,
    onProgress: (p: S3SyncProgress) => void,
): Promise<void> {
    const { bucket, prefix } = parseBucketPath(config.bucketPath);
    const s3 = createS3(config);

    // Phase 1: リモート全削除 (prefix 配下)
    onProgress({ phase: 'deleting', message: 'Deleting remote files...' });
    await deleteAllUnderPrefix(s3, bucket, prefix);

    // Phase 2: ローカルをアップロード (per-file 進捗を保つ)
    onProgress({ phase: 'uploading', message: 'Uploading local files...' });
    const localFiles = Array.from(walkLocalDir(config.localPath).keys());
    let uploaded = 0;
    await runWithConcurrency(localFiles, TRANSFER_CONCURRENCY, async (relPath) => {
        const key = prefix + relPath;
        const localPath = path.join(config.localPath, relPath);
        await uploadFile(s3, bucket, key, localPath);
        uploaded++;
        onProgress({
            phase: 'uploading',
            message: `uploading... (${uploaded} files)`,
            currentFile: relPath,
            filesProcessed: uploaded,
        });
    });

    onProgress({ phase: 'complete', message: 'Remote delete & upload complete.' });
}

/**
 * Local Delete & Download: ローカルを全削除してからS3をダウンロード
 */
export async function s3LocalDeleteAndDownload(
    config: S3SyncConfig,
    onProgress: (p: S3SyncProgress) => void,
): Promise<void> {
    const { bucket, prefix } = parseBucketPath(config.bucketPath);
    const s3 = createS3(config);

    // Phase 1: ローカルファイルを全削除（フォルダ自体は残す）
    onProgress({ phase: 'deleting', message: 'Deleting local files...' });
    deleteLocalFiles(config.localPath);

    // Phase 2: S3からダウンロード (per-file 進捗を保つ)
    onProgress({ phase: 'downloading', message: 'Downloading from S3...' });
    const objects = await listAllObjects(s3, bucket, prefix);
    const toDownload: string[] = [];
    for (const obj of objects) {
        if (!obj.key.startsWith(prefix)) continue;
        const relPath = obj.key.substring(prefix.length);
        if (!relPath) continue;  // prefix 自体 (folder marker) はスキップ
        toDownload.push(relPath);
    }
    let downloaded = 0;
    await runWithConcurrency(toDownload, TRANSFER_CONCURRENCY, async (relPath) => {
        const key = prefix + relPath;
        const localPath = path.join(config.localPath, relPath);
        await downloadToFile(s3, bucket, key, localPath);
        downloaded++;
        onProgress({
            phase: 'downloading',
            message: `downloading... (${downloaded} files)`,
            currentFile: relPath,
            filesProcessed: downloaded,
        });
    });

    onProgress({ phase: 'complete', message: 'Local delete & download complete.' });
}

/**
 * ローカルフォルダ内の全ファイル・サブフォルダを削除（ルートフォルダ自体は残す）
 */
function deleteLocalFiles(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(fullPath);
        }
    }
}
