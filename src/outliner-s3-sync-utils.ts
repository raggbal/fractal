/**
 * outliner-s3-sync-utils.ts — vscode 不依存の pure 関数群
 *
 * outliner-s3-sync.ts から切り出して unit test 可能にする (Playwright Node.js 環境)。
 */
import * as path from 'path';

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

export interface TargetPaths {
    outFilePath: string;
    folderPath: string;  // <localDir>/<id>/ (末尾 sep 強制)
}

export interface TargetTextDocPaths {
    outFilePath: string;
    pagesDir: string;            // <localDir>/<id>/pages/ (末尾 sep 強制)
}

/**
 * sync 範囲のローカル path 集合 (TC-U-02)
 */
export function computeTargetPaths(outlinerId: string, localDir: string): TargetPaths {
    const outFilePath = path.join(localDir, `${outlinerId}.out`);
    const folderPath = path.join(localDir, outlinerId) + path.sep;
    return { outFilePath, folderPath };
}

/**
 * TextDocument flush 対象のテキスト系 path 集合 (TC-U-02 / M15)
 */
export function computeTargetTextDocPaths(outlinerId: string, localDir: string): TargetTextDocPaths {
    const outFilePath = path.join(localDir, `${outlinerId}.out`);
    const pagesDir = path.join(localDir, outlinerId, 'pages') + path.sep;
    return { outFilePath, pagesDir };
}

/**
 * S3 URI の正規化 (M3、末尾 slash 強制)
 */
export function normalizeBucketUri(bucketPath: string, outlinerId: string): { folderUri: string; parentUri: string } {
    const trimmed = bucketPath.trim().replace(/^s3:\/\//, '').replace(/\/+$/, '');
    return {
        folderUri: `s3://${trimmed}/${outlinerId}/`,
        parentUri: `s3://${trimmed}/`,
    };
}

/**
 * Local URI の正規化 (末尾 sep 強制)
 */
export function normalizeLocalUri(localDir: string, outlinerId: string): { folderPath: string; parentPath: string } {
    const folderPath = path.join(localDir, outlinerId) + path.sep;
    const parentPath = localDir.endsWith(path.sep) ? localDir : localDir + path.sep;
    return { folderPath, parentPath };
}

/**
 * 指定 path が target text-document の範囲か判定 (M7 / M15)
 */
export function isTargetTextDoc(filePath: string, targets: TargetTextDocPaths): boolean {
    if (filePath === targets.outFilePath) return true;
    if (filePath.startsWith(targets.pagesDir) && filePath.endsWith('.md')) return true;
    return false;
}

/**
 * (deprecated) `aws s3 sync` の引数構築。`aws s3 sync` は size 差分が転送発火条件に
 * 含まれるため真の mtime newer-wins 判定はできず、別マシン編集時に古いローカルが
 * S3 を上書きしてしまうバグの温床。
 *
 * 現在の実装は per-file mtime 比較 + aws s3 cp 経路を使っており、本関数はもう
 * 呼ばれていないが、unit test の互換性のため残置。
 */
export function buildSyncCommandArgs(p: {
    outlinerId: string;
    s3Folder: string;
    s3Parent: string;
    localFolder: string;
    localParent: string;
}): { downloadArgs: string[][]; uploadArgs: string[][] } {
    const downloadArgs: string[][] = [
        ['s3', 'sync', p.s3Folder, p.localFolder],
        ['s3', 'sync', p.s3Parent, p.localParent,
            '--exclude', '*', '--include', `${p.outlinerId}.out`],
    ];
    const uploadArgs: string[][] = [
        ['s3', 'sync', p.localFolder, p.s3Folder],
        ['s3', 'sync', p.localParent, p.s3Parent,
            '--exclude', '*', '--include', `${p.outlinerId}.out`],
    ];
    return { downloadArgs, uploadArgs };
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

/**
 * outline.note.s3BucketPath 判定 (TC-U-01)
 */
export function isS3BucketPathSet(value: string | null | undefined): boolean {
    if (!value) return false;
    return value.trim().length > 0;
}

/**
 * sync-in-progress flag 用の path 帰属判定 (M10)
 */
export function pathBelongsToSyncingOutliner(
    filePath: string,
    folderPath: string,
    syncingIds: Iterable<string>,
): boolean {
    for (const id of syncingIds) {
        const outFile = path.join(folderPath, `${id}.out`);
        const idFolder = path.join(folderPath, id) + path.sep;
        if (filePath === outFile) return true;
        if (filePath.startsWith(idFolder)) return true;
    }
    return false;
}
