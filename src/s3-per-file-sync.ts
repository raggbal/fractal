/**
 * s3-per-file-sync.ts — per-file mtime newer-wins の sync engine
 *
 * `aws s3 sync` は size 差分で常に転送する仕様で、別マシン編集時に古い local が
 * S3 を上書きしてしまうため、ファイル単位で mtime 比較する true newer-wins 実装。
 *
 * outliner-toolbar-s3-sync (outliner 単位) と NT-09 (note 全体) の両方で利用。
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { AwsCredentials, FileInfo, decideSyncDirection, getAwsEnv } from './outliner-s3-sync-utils';

export interface S3Object {
    key: string;
    mtime: Date;
    size: number;
}

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
 * 大量ファイル時の性能のため、per-file `aws s3 cp` ではなく `aws s3 sync` を方向毎・チャンク毎
 * に呼ぶ。1 chunk = 最大 500 ファイル（argv 上限を考慮）。
 */
export async function syncDirectoryBidirectional(
    bucket: string,
    s3Prefix: string,
    localFolderPath: string,
    creds: AwsCredentials,
    onProgress?: (p: SyncDirectoryProgress) => void,
): Promise<SyncDirectoryResult> {
    const [s3Objects, localFiles] = await Promise.all([
        listS3Objects(bucket, s3Prefix, creds),
        Promise.resolve(walkLocalDir(localFolderPath)),
    ]);

    // S3 key を s3Prefix からの相対 path に変換
    const s3Map = new Map<string, FileInfo>();
    for (const obj of s3Objects) {
        if (!obj.key.startsWith(s3Prefix)) continue;
        const relPath = obj.key.substring(s3Prefix.length);
        if (!relPath) continue;  // prefix 自体 (folder marker) はスキップ
        s3Map.set(relPath, { mtime: obj.mtime, size: obj.size });
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

    // skip 判定ファイルの local mtime を S3 mtime に揃える (unfiltered download phase で
    // aws s3 sync が誤って再 download しないようにするため)
    for (const d of skipList) {
        if (!d.s3Info || !d.localInfo) continue;
        try {
            fs.utimesSync(path.join(localFolderPath, d.relPath), d.s3Info.mtime, d.s3Info.mtime);
        } catch {/* ignore */ }
    }

    const total = uploadList.length + downloadList.length;
    let processed = 0;

    // [Phase A] filtered upload — uploadList 限定で aws s3 sync (--exclude '*' --include)
    // (unfiltered upload にすると size 違いトリガーで Android 編集が上書きされるため filter 必須)
    if (uploadList.length > 0) {
        const srcDir = localFolderPath.endsWith(path.sep) ? localFolderPath : localFolderPath + path.sep;
        const destUri = s3Uri(bucket, s3Prefix);
        await runBatchedSync(srcDir, destUri, uploadList.map(d => d.relPath), creds, (relPath) => {
            processed++;
            onProgress?.({ processed, total, action: 'upload', relPath });
        });

        // upload 直後の local mtime を新 S3 LastModified に揃える
        // (次の Phase B unfiltered download で再 download されないようにするため)
        try {
            const refreshed = await listS3Objects(bucket, s3Prefix, creds);
            const refreshedMap = new Map<string, Date>();
            for (const obj of refreshed) {
                if (!obj.key.startsWith(s3Prefix)) continue;
                const rp = obj.key.substring(s3Prefix.length);
                if (!rp) continue;
                refreshedMap.set(rp, obj.mtime);
            }
            for (const d of uploadList) {
                const newMtime = refreshedMap.get(d.relPath);
                if (!newMtime) continue;
                try {
                    fs.utimesSync(path.join(localFolderPath, d.relPath), newMtime, newMtime);
                } catch {/* ignore */ }
            }
        } catch { /* re-list failure は致命的でない */ }
    }

    // [Phase B] unfiltered download — `aws s3 sync s3 local` 1 発 (10000+ 件でも fast)
    // skip 判定ファイルは事前 mtime align 済なので aws s3 sync は skip する。
    // upload 済ファイルも mtime align 済なので skip する。
    // 残るは「真に S3 newer」 = my downloadList のみ → これを aws s3 sync が parallel transfer。
    if (downloadList.length > 0) {
        const srcUri = s3Uri(bucket, s3Prefix);
        const destDir = localFolderPath.endsWith(path.sep) ? localFolderPath : localFolderPath + path.sep;
        await runUnfilteredSync(srcUri, destDir, creds, (relPath) => {
            processed++;
            onProgress?.({ processed, total, action: 'download', relPath });
        });

        // download 済ファイルの local mtime を S3 mtime に揃える
        for (const d of downloadList) {
            if (!d.s3Info) continue;
            try {
                fs.utimesSync(path.join(localFolderPath, d.relPath), d.s3Info.mtime, d.s3Info.mtime);
            } catch {/* ignore */ }
        }
    }

    return { uploaded: uploadList.length, downloaded: downloadList.length, skipped: skipList.length };
}

/**
 * filter 無しの `aws s3 sync src dest` を 1 発実行 (大量ファイル時の高速版)
 *
 * aws s3 sync は内部で 10 並列転送するので 10000 ファイルでも数分で完了。
 * filter 無しなので include pattern 評価のオーバーヘッドゼロ。
 */
async function runUnfilteredSync(
    src: string,
    dest: string,
    creds: AwsCredentials,
    onTransfer: (relPath: string) => void,
): Promise<void> {
    const env = getAwsEnv(creds);
    const args = ['s3', 'sync', src, dest];

    return new Promise((resolve, reject) => {
        const proc = spawn('aws', args, { env, stdio: 'pipe' });
        let stderr = '';
        proc.stdout.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter((l) => l.trim());
            for (const line of lines) {
                const m = line.match(/^(upload|download|copy):\s+(\S+)/i);
                if (m) {
                    const relPath = extractRelPathFromAwsLine(line, src, dest);
                    onTransfer(relPath);
                }
            }
        });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => reject(new Error(`aws s3 sync failed: ${err.message}`)));
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`aws s3 sync exited ${code}: ${stderr.trim()}`));
        });
    });
}

function s3Uri(bucket: string, prefix: string): string {
    const cleaned = prefix.replace(/^\/+|\/+$/g, '');
    return cleaned ? `s3://${bucket}/${cleaned}/` : `s3://${bucket}/`;
}

/**
 * `aws s3 sync` を `--exclude '*' --include <relPath>` でファイル単位に絞って実行
 *
 * argv 上限 (macOS 1MB / Linux 130KB) を考慮して chunk 単位で複数回呼ぶ。
 * stdout を行単位 parse して progress 報告。
 */
async function runBatchedSync(
    src: string,
    dest: string,
    relPaths: string[],
    creds: AwsCredentials,
    onTransfer: (relPath: string) => void,
): Promise<void> {
    const BATCH_SIZE = 500;
    const env = getAwsEnv(creds);

    for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
        const batch = relPaths.slice(i, i + BATCH_SIZE);
        const args = ['s3', 'sync', src, dest, '--exclude', '*'];
        for (const rp of batch) {
            args.push('--include', rp);
        }

        await new Promise<void>((resolve, reject) => {
            const proc = spawn('aws', args, { env, stdio: 'pipe' });
            let stderr = '';
            proc.stdout.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n').filter((l) => l.trim());
                for (const line of lines) {
                    // "upload: ./local/path to s3://..." or "download: s3://... to ./local/path"
                    const m = line.match(/^(upload|download|copy):\s+(\S+)/i);
                    if (m) {
                        const relPath = extractRelPathFromAwsLine(line, src, dest);
                        onTransfer(relPath);
                    }
                }
            });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            proc.on('error', (err) => reject(new Error(`aws s3 sync failed: ${err.message}`)));
            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`aws s3 sync exited ${code}: ${stderr.trim()}`));
            });
        });
    }
}

function extractRelPathFromAwsLine(line: string, src: string, dest: string): string {
    // line 例: "upload: src_path to s3://..."
    // src_path は src directory 起点の相対 or 絶対 path
    const parts = line.split(/:\s+/, 2);
    if (parts.length < 2) return line.trim();
    const tail = parts[1].split(' to ', 2)[0].trim();
    // src を含めば取り除いて相対化
    const candidates = [src, src.replace(/\/$/, ''), './' + path.basename(src.replace(/\/$/, ''))];
    for (const c of candidates) {
        if (tail.startsWith(c)) {
            return tail.substring(c.length).replace(/^\/+/, '');
        }
    }
    return tail;
}

/**
 * 単一ファイルの転送実行 (decision に従って upload / download / skip)
 *
 * 転送後、local mtime を S3 LastModified に揃える (次回 sync の wasteful 転送防止)
 */
export async function executeFileTransfer(
    decision: FileDecision,
    bucket: string,
    s3Key: string,
    localPath: string,
    creds: AwsCredentials,
): Promise<void> {
    if (decision.action === 'skip') return;
    if (decision.action === 'upload') {
        await s3Cp(localPath, `s3://${bucket}/${s3Key}`, creds);
        const newS3Info = await getS3ObjectInfo(bucket, s3Key, creds);
        if (newS3Info) {
            try {
                fs.utimesSync(localPath, newS3Info.mtime, newS3Info.mtime);
            } catch {
                /* mtime 同期失敗は致命的でない */
            }
        }
    } else if (decision.action === 'download') {
        const parentDir = path.dirname(localPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        await s3Cp(`s3://${bucket}/${s3Key}`, localPath, creds);
        const s3Info = await getS3ObjectInfo(bucket, s3Key, creds);
        if (s3Info) {
            try {
                fs.utimesSync(localPath, s3Info.mtime, s3Info.mtime);
            } catch {
                /* mtime 同期失敗は致命的でない */
            }
        }
    }
}

/**
 * `aws s3api head-object` で S3 オブジェクト情報を取得。存在しなければ null
 */
export async function getS3ObjectInfo(
    bucket: string,
    key: string,
    creds: AwsCredentials,
): Promise<FileInfo | null> {
    const env = getAwsEnv(creds);
    const args = ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--output', 'json'];

    return new Promise((resolve, reject) => {
        const proc = spawn('aws', args, { env, stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => reject(new Error(`aws s3api head-object failed: ${err.message}`)));
        proc.on('close', (code) => {
            if (code === 0) {
                try {
                    const data = JSON.parse(stdout);
                    resolve({
                        mtime: new Date(data.LastModified),
                        size: typeof data.ContentLength === 'number' ? data.ContentLength : 0,
                    });
                } catch (e) {
                    resolve(null);
                }
            } else if (
                stderr.includes('Not Found')
                || stderr.includes('NoSuchKey')
                || stderr.includes('does not exist')
                || code === 254
                || code === 255
            ) {
                resolve(null);
            } else {
                reject(new Error(`aws s3api head-object exited ${code}: ${stderr.trim()}`));
            }
        });
    });
}

/**
 * `aws s3api list-objects-v2` で S3 prefix 配下の全オブジェクトを取得 (pagination 対応)
 */
export async function listS3Objects(
    bucket: string,
    prefix: string,
    creds: AwsCredentials,
): Promise<S3Object[]> {
    const env = getAwsEnv(creds);
    const results: S3Object[] = [];
    let continuationToken: string | undefined;

    do {
        const args: string[] = [
            's3api', 'list-objects-v2',
            '--bucket', bucket,
            '--prefix', prefix,
            '--output', 'json',
        ];
        if (continuationToken) {
            args.push('--continuation-token', continuationToken);
        }

        const result: { Contents?: any[]; NextContinuationToken?: string; IsTruncated?: boolean } = await new Promise((resolve, reject) => {
            const proc = spawn('aws', args, { env, stdio: 'pipe' });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            proc.on('error', (err) => reject(new Error(`aws s3api list-objects-v2 failed: ${err.message}`)));
            proc.on('close', (code) => {
                if (code === 0) {
                    try {
                        const data = stdout.trim() ? JSON.parse(stdout) : {};
                        resolve(data);
                    } catch (e) {
                        resolve({});
                    }
                } else {
                    reject(new Error(`aws s3api list-objects-v2 exited ${code}: ${stderr.trim()}`));
                }
            });
        });

        const contents = Array.isArray(result.Contents) ? result.Contents : [];
        for (const obj of contents) {
            if (!obj || typeof obj.Key !== 'string') continue;
            results.push({
                key: obj.Key,
                mtime: new Date(obj.LastModified),
                size: typeof obj.Size === 'number' ? obj.Size : 0,
            });
        }
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return results;
}

/**
 * `aws s3 cp src dest` で単一ファイル転送
 */
export async function s3Cp(src: string, dest: string, creds: AwsCredentials): Promise<void> {
    const env = getAwsEnv(creds);
    const args = ['s3', 'cp', src, dest];

    return new Promise((resolve, reject) => {
        const proc = spawn('aws', args, { env, stdio: 'pipe' });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => reject(new Error(`aws s3 cp failed: ${err.message}`)));
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`aws s3 cp exited ${code}: ${stderr.trim()}`));
        });
    });
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
    if (!fs.existsSync(dirPath)) return result;

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

    recurse(dirPath, dirPath.length);
    return result;
}
