/**
 * outliner-s3-sync-utils.ts — vscode 不依存の pure 関数群
 *
 * 左サイドパネル sync (notes-s3-sync.ts / s3-per-file-sync.ts) が使う pure 関数群。
 * Playwright Node.js 環境で unit test 可能。
 */

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}

/**
 * AWS CLI に渡す env vars 構築 (notes-s3-sync.ts / s3-per-file-sync.ts 共通)
 */
export function getAwsEnv(creds: AwsCredentials): NodeJS.ProcessEnv {
    return {
        ...process.env,
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        AWS_DEFAULT_REGION: creds.region,
    };
}

/**
 * ファイルの size + mtime 情報
 */
export interface FileInfo {
    mtime: Date;
    size: number;
}

/**
 * sync 方向の判定ロジック (true newer-wins、tolerance window 付き)
 *
 * @param s3Info S3 上のファイル情報 (なければ null)
 * @param localInfo ローカルのファイル情報 (なければ null)
 * @param toleranceSec mtime 比較の tolerance 秒数 (default 5、upload 完了直後の re-download 抑止用)
 *
 * 判定:
 * - 両方なし → skip
 * - S3 のみ → download
 * - local のみ → upload
 * - 両方あり、|s3.mtime - local.mtime| <= tolerance → skip (upload 直後の wasteful 転送回避)
 * - 両方あり、s3 newer → download
 * - 両方あり、local newer → upload
 */
export function decideSyncDirection(
    s3Info: FileInfo | null,
    localInfo: FileInfo | null,
    toleranceSec: number = 5,
): 'upload' | 'download' | 'skip' {
    if (!s3Info && !localInfo) return 'skip';
    if (!s3Info) return 'upload';
    if (!localInfo) return 'download';

    // size 違いは内容違いを意味するので mtime tolerance を無視して newer-wins
    if (s3Info.size !== localInfo.size) {
        const deltaMs = s3Info.mtime.getTime() - localInfo.mtime.getTime();
        if (deltaMs >= 0) return 'download';
        return 'upload';
    }

    // 同 size の時のみ mtime tolerance で skip 判定
    const deltaMs = s3Info.mtime.getTime() - localInfo.mtime.getTime();
    const deltaSec = Math.abs(deltaMs) / 1000;
    if (deltaSec <= toleranceSec) return 'skip';
    if (deltaMs > 0) return 'download';
    return 'upload';
}

/**
 * S3 Bucket Path をパース
 *
 * "my-bucket/notes/path"  → { bucket: "my-bucket", prefix: "notes/path/" }
 * "my-bucket"             → { bucket: "my-bucket", prefix: "" }
 * "s3://my-bucket/notes/" → { bucket: "my-bucket", prefix: "notes/" }
 */
export function parseBucketPath(bucketPath: string): { bucket: string; prefix: string } {
    const cleaned = bucketPath.trim().replace(/^s3:\/\//, '').replace(/\/+$/, '');
    const slashIdx = cleaned.indexOf('/');
    if (slashIdx === -1) {
        return { bucket: cleaned, prefix: '' };
    }
    return {
        bucket: cleaned.substring(0, slashIdx),
        prefix: cleaned.substring(slashIdx + 1) + '/',
    };
}
