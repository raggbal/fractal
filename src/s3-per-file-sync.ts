/**
 * s3-per-file-sync.ts — per-file mtime newer-wins の sync engine
 *
 * `aws s3 sync` は size 差分で常に転送する仕様で、別マシン編集時に古い local が
 * S3 を上書きしてしまうため、ファイル単位で mtime 比較する true newer-wins 実装。
 *
 * I/O 層は @aws-sdk/client-s3 v3 ラッパ (s3-sdk-client) に委譲する。編成ロジック
 * (newer-wins 判定 / mtime align / fail-fast) は不変。左サイドパネル sync (note 全体) で利用。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AwsCredentials, FileInfo, decideSyncDirection } from './outliner-s3-sync-utils';
import {
    createS3,
    listAllObjects,
    headObject,
    downloadToFile,
    uploadFile,
    runWithConcurrency,
} from './shared/s3-sdk-client';

/** 転送の並列上限 (旧 aws s3 sync の内部並列 10 に相当する軽い並列度)。 */
const TRANSFER_CONCURRENCY = 8;

export interface FileDecision {
    action: 'upload' | 'download' | 'skip';
    /** s3Prefix / localFolderPath からの相対 path */
    relPath: string;
    s3Info: FileInfo | null;
    localInfo: FileInfo | null;
}

export interface SyncDirectoryProgress {
    processed: number;
    total: number;
    action: 'upload' | 'download';
    relPath: string;
}

export interface SyncDirectoryResult {
    uploaded: number;
    downloaded: number;
    skipped: number;
}

/**
 * S3 prefix 配下と local folder を per-file mtime 比較で双方向 sync
 *
 * - 両方ある + s3 newer → download
 * - 両方ある + local newer → upload
 * - 両方ある + 同一時刻 (tolerance 5s) → skip
 * - S3 のみ → download
 * - local のみ → upload
 *
 * `--delete` 不使用（片側にしかないファイルは保持）
 *
 * 転送は s3-sdk-client (uploadFile = lib-storage / downloadToFile = GetObject stream) を
 * runWithConcurrency で並列駆動する (最初の失敗で fail-fast)。
 */
export async function syncDirectoryBidirectional(
    bucket: string,
    s3Prefix: string,
    localFolderPath: string,
    creds: AwsCredentials,
    onProgress?: (p: SyncDirectoryProgress) => void,
): Promise<SyncDirectoryResult> {
    const s3 = createS3(creds);

    const [s3Objects, localFiles] = await Promise.all([
        listAllObjects(s3, bucket, s3Prefix),
        Promise.resolve(walkLocalDir(localFolderPath)),
    ]);

    // S3 key を s3Prefix からの相対 path に変換
    const s3Map = new Map<string, FileInfo>();
    for (const obj of s3Objects) {
        if (!obj.key.startsWith(s3Prefix)) continue;
        const relPath = obj.key.substring(s3Prefix.length);
        if (!relPath) continue;  // prefix 自体 (folder marker) はスキップ
        s3Map.set(relPath, { mtime: obj.lastModified, size: obj.size });
    }

    // 全 relPath を集合化、per-file 判定
    const allRelPaths = new Set<string>([...s3Map.keys(), ...localFiles.keys()]);
    const uploadList: FileDecision[] = [];
    const downloadList: FileDecision[] = [];
    const skipList: FileDecision[] = [];

    for (const relPath of allRelPaths) {
        const s3Info = s3Map.get(relPath) || null;
        const localInfo = localFiles.get(relPath) || null;
        const action = decideSyncDirection(s3Info, localInfo);
        const dec: FileDecision = { action, relPath, s3Info, localInfo };
        if (action === 'upload') uploadList.push(dec);
        else if (action === 'download') downloadList.push(dec);
        else skipList.push(dec);
    }

    // 注: 旧 CLI 実装は Phase B の unfiltered `aws s3 sync` が skip 判定ファイルを誤って
    // 再 download しないよう、skip ファイルの local mtime を事前に S3 mtime へ揃えていた。
    // SDK 化後は Phase B が「算出済み downloadList だけ」を狙って download するため、その
    // 事前 align は不要 (外部から観測されない内部最適化だった) — 削除。

    const total = uploadList.length + downloadList.length;
    let processed = 0;

    // [Phase A] filtered upload — uploadList 限定で並列 upload
    // (unfiltered upload にすると size 違いトリガーで別マシン編集が上書きされるため filter 必須)
    if (uploadList.length > 0) {
        await runWithConcurrency(uploadList, TRANSFER_CONCURRENCY, async (d) => {
            const key = s3Prefix + d.relPath;
            const localPath = path.join(localFolderPath, d.relPath);
            await uploadFile(s3, bucket, key, localPath);

            // upload 直後の local mtime を新 S3 LastModified に揃える (不変)
            // (次の Phase B download 判定と次回 sync で再転送されないようにするため)
            const info = await headObject(s3, bucket, key);
            if (info) {
                try {
                    fs.utimesSync(localPath, info.lastModified, info.lastModified);
                } catch {/* mtime 同期失敗は致命的でない */ }
            }

            processed++;
            onProgress?.({ processed, total, action: 'upload', relPath: d.relPath });
        });
    }

    // [Phase B] download — 「真に S3 newer」= downloadList のみを並列 download
    if (downloadList.length > 0) {
        await runWithConcurrency(downloadList, TRANSFER_CONCURRENCY, async (d) => {
            const key = s3Prefix + d.relPath;
            const localPath = path.join(localFolderPath, d.relPath);
            await downloadToFile(s3, bucket, key, localPath);

            // download 済ファイルの local mtime を S3 mtime に揃える (不変)
            if (d.s3Info) {
                try {
                    fs.utimesSync(localPath, d.s3Info.mtime, d.s3Info.mtime);
                } catch {/* mtime 同期失敗は致命的でない */ }
            }

            processed++;
            onProgress?.({ processed, total, action: 'download', relPath: d.relPath });
        });
    }

    return { uploaded: uploadList.length, downloaded: downloadList.length, skipped: skipList.length };
}

// ────────────────────────────────────────────────
// Local fs helpers
// ────────────────────────────────────────────────

export function getLocalFileInfo(filePath: string): FileInfo | null {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return null;
        return { mtime: stat.mtime, size: stat.size };
    } catch {
        return null;
    }
}

export function walkLocalDir(dirPath: string): Map<string, FileInfo> {
    const result = new Map<string, FileInfo>();
    // 末尾スラッシュを正規化してから baseLen を取る（BUG-3）。
    // 末尾 `/` 付きだと baseLen が 1 過大になり substring(baseLen+1) で relPath 先頭が欠落する。
    // upload/download の srcDir 補正（endsWith(path.sep)）と対称にする。
    const base = dirPath.replace(/[/\\]+$/, '');
    if (!fs.existsSync(base)) return result;

    function recurse(currentPath: string, baseLen: number) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relPath = fullPath.substring(baseLen + 1).split(path.sep).join('/');
            if (entry.isDirectory()) {
                recurse(fullPath, baseLen);
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(fullPath);
                    result.set(relPath, { mtime: stat.mtime, size: stat.size });
                } catch {
                    /* skip unreadable file */
                }
            }
        }
    }

    recurse(base, base.length);
    return result;
}
