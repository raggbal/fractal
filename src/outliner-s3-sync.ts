/**
 * outliner-s3-sync.ts — outliner editor toolbar の同期ボタン用の sync エンジン
 *
 * NT-09 の note 全体 sync (`notes-s3-sync.ts`) と並存し、outliner 単位 (<id>.out + <id>/)
 * を AWS CLI ベースで双方向同期する。
 *
 * 旧設計は `aws s3 sync` を使っていたが、これは「size 差分で常に転送」する仕様で
 * 真の mtime newer-wins ができず、別マシン編集時に古いローカルが S3 を上書きする
 * バグが発生した。現在は per-file mtime 比較 + `aws s3 cp` で本物の newer-wins を実装。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    AwsCredentials,
    FileInfo,
    TargetTextDocPaths,
    computeTargetTextDocPaths,
    computeSyncFolderPaths,
    isTargetTextDoc,
    decideSyncDirection,
    parseBucketPath,
} from './outliner-s3-sync-utils';
import {
    getS3ObjectInfo,
    getLocalFileInfo,
    executeFileTransfer,
    syncDirectoryBidirectional,
    SyncDirectoryProgress,
} from './s3-per-file-sync';
import { showSyncConflictDialog } from './sync-conflict-dialog';
export {
    AwsCredentials,
    FileInfo,
    TargetPaths,
    TargetTextDocPaths,
    computeTargetPaths,
    computeTargetTextDocPaths,
    computeSyncFolderPaths,
    normalizeBucketUri,
    normalizeLocalUri,
    isTargetTextDoc,
    buildSyncCommandArgs,
    decideSyncDirection,
    parseBucketPath,
    isS3BucketPathSet,
    pathBelongsToSyncingOutliner,
} from './outliner-s3-sync-utils';

export interface OutlinerS3SyncProgress {
    phase: 'preparing' | 'locking' | 'flushing' | 'comparing' | 'transferring'
        | 'reverting' | 'reiniting' | 'success' | 'error' | 'cancelled';
    message: string;
}

export interface OutlinerS3SyncProvider {
    setSyncInProgress(outlinerId: string, value: boolean): void;
    isSyncInProgress(outlinerId: string): boolean;
}

export interface OutlinerS3SyncOptions {
    outlinerId: string;
    localDir: string;            // outline.note 格納フォルダ absolute path
    bucketPath: string;          // outline.note.s3BucketPath
    panel: vscode.WebviewPanel;
    provider: OutlinerS3SyncProvider;
    s3Config: AwsCredentials;
    onProgress: (p: OutlinerS3SyncProgress) => void;
    /** v0.207.41: sync 競合判定モード
     *  - 'auto' (default): mtime newer-wins で自動判定、dialog 出さない
     *  - 'confirm': size 違いがあれば毎回 user 確認 dialog */
    conflictMode?: 'auto' | 'confirm';
}

const inflight = new Map<string, Promise<void>>();

export class OutlinerS3SyncCoordinator {
    static isRunning(outlinerId: string): boolean {
        return inflight.has(outlinerId);
    }

    static async run(opts: OutlinerS3SyncOptions): Promise<void> {
        if (inflight.has(opts.outlinerId)) {
            // silent return (mutex)
            return;
        }
        const promise = doRun(opts);
        inflight.set(opts.outlinerId, promise);
        try {
            await promise;
        } finally {
            inflight.delete(opts.outlinerId);
        }
    }
}

async function doRun(opts: OutlinerS3SyncOptions): Promise<void> {
    const targetTextDocPaths = computeTargetTextDocPaths(opts.outlinerId, opts.localDir);
    const { bucket, prefix } = parseBucketPath(opts.bucketPath);
    const s3OutKey = `${prefix}${opts.outlinerId}.out`;
    const localOutFile = path.join(opts.localDir, `${opts.outlinerId}.out`);
    // notes-flat-storage (2026-07-07): .out の pageDir="." なら flat レイアウト。
    // flat は共有 root（<localDir>）を、legacy は per-<id>/ フォルダを sync する。
    let isFlat = false;
    try {
        const outData = JSON.parse(fs.readFileSync(localOutFile, 'utf8'));
        const pd = typeof outData.pageDir === 'string' ? outData.pageDir.replace(/^\.\//, '').replace(/\/$/, '') : undefined;
        isFlat = pd === '' || pd === '.';
    } catch { /* 読めなければ legacy 扱い */ }
    const { s3FolderPrefix, localFolderPath } = computeSyncFolderPaths(opts.outlinerId, opts.localDir, prefix, isFlat);

    // Phase 1: webview lock
    opts.onProgress({ phase: 'locking', message: 'Locking editor…' });
    await lockWebview(opts.panel);

    // Phase 2: VSCode TextDocument flush
    opts.onProgress({ phase: 'flushing', message: 'Flushing dirty buffers…' });
    const dirtyDecision = await flushDirtyDocs(targetTextDocPaths);
    if (dirtyDecision === 'cancel') {
        await unlockWebview(opts.panel);
        opts.onProgress({ phase: 'cancelled', message: 'Sync cancelled' });
        return;
    }

    // Phase 3: provider flag ON
    opts.provider.setSyncInProgress(opts.outlinerId, true);

    try {
        // Phase 4: per-file mtime compare + transfer (true newer-wins)
        opts.onProgress({ phase: 'comparing', message: 'Comparing local and S3…' });

        // 4a: .out file (folder の外、parent 配下なので個別処理)
        const s3OutInfo = await getS3ObjectInfo(bucket, s3OutKey, opts.s3Config);
        const localOutInfo = getLocalFileInfo(localOutFile);
        let outAction = decideSyncDirection(s3OutInfo, localOutInfo);

        const sizeMismatch = !!(s3OutInfo && localOutInfo && s3OutInfo.size !== localOutInfo.size);
        console.log('[OutlinerS3Sync]', opts.outlinerId, '.out',
            'local:', localOutInfo ? `${localOutInfo.size}B mtime=${localOutInfo.mtime.toISOString()}` : 'null',
            'S3:', s3OutInfo ? `${s3OutInfo.size}B mtime=${s3OutInfo.mtime.toISOString()}` : 'null',
            'decision:', outAction);

        // v0.207.41: 'confirm' mode の時のみ size 差で user 確認 dialog (default 'auto' は出さない)。
        // 'auto' モードでは mtime newer-wins の自動判定をそのまま使う。
        const wantConfirm = (opts.conflictMode === 'confirm');
        if (wantConfirm && s3OutInfo && localOutInfo && sizeMismatch) {
            const localStr = `${localOutInfo.size}B  ${localOutInfo.mtime.toLocaleString()}`;
            const s3Str = `${s3OutInfo.size}B  ${s3OutInfo.mtime.toLocaleString()}`;
            const recommended: 'upload' | 'download' = (outAction === 'download') ? 'download' : 'upload';
            const choice = await showSyncConflictDialog({
                title: `Outliner sync (${opts.outlinerId}.out): 内容が違います`,
                localLabel: localStr,
                s3Label: s3Str,
                recommended,
            });
            if (choice === 'cancel') {
                opts.onProgress({ phase: 'cancelled', message: 'Sync cancelled by user' });
                await unlockWebview(opts.panel);
                return;
            }
            outAction = choice;
            console.log('[OutlinerS3Sync] User chose', choice, '(recommended was', recommended, ')');
        }

        opts.onProgress({ phase: 'transferring', message: `Syncing <id>.out (${outAction})…` });
        await executeFileTransfer(
            { action: outAction, relPath: '', s3Info: s3OutInfo, localInfo: localOutInfo },
            bucket, s3OutKey, localOutFile, opts.s3Config,
        );

        // 4b: <id>/ folder の中身を再帰的に bidirectional sync
        await syncDirectoryBidirectional(
            bucket, s3FolderPrefix, localFolderPath, opts.s3Config,
            (p: SyncDirectoryProgress) => {
                opts.onProgress({
                    phase: 'transferring',
                    message: `Syncing folder (${p.processed}/${p.total}) ${p.action}: ${p.relPath}`,
                });
            },
        );

        // Phase 5: revert TextDocuments
        opts.onProgress({ phase: 'reverting', message: 'Refreshing editors…' });
        await revertDocs(targetTextDocPaths);

        // Phase 6: re-init webview
        opts.onProgress({ phase: 'reiniting', message: 'Reloading editor…' });
        const newData = await readOutlinerFromDisk(localOutFile);
        await unlockAndReinit(opts.panel, newData);

        opts.onProgress({ phase: 'success', message: 'Sync complete' });
    } finally {
        // Phase 7: provider flag OFF
        opts.provider.setSyncInProgress(opts.outlinerId, false);
    }
}

// ────────────────────────────────────────────────
// Webview / TextDocument helpers
// ────────────────────────────────────────────────

async function lockWebview(panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.postMessage({ type: 'sync-lock' });
}

async function unlockWebview(panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.postMessage({ type: 'sync-applied', data: null, fileChangeId: -1 });
}

async function unlockAndReinit(panel: vscode.WebviewPanel, newData: any): Promise<void> {
    panel.webview.postMessage({
        type: 'sync-applied',
        data: newData,
        fileChangeId: Date.now(),
    });
}

export async function flushDirtyDocs(targets: TargetTextDocPaths): Promise<'continue' | 'cancel'> {
    const dirtyDocs = listDirtyDocs(targets);
    if (dirtyDocs.length === 0) return 'continue';

    const result = await vscode.window.showWarningMessage(
        'Unsaved changes detected',
        {
            modal: true,
            detail: `${dirtyDocs.length} file(s) have unsaved changes. How do you want to proceed?`,
        },
        'Save and continue',
        'Discard and continue',
        'Cancel sync',
    );

    if (!result || result === 'Cancel sync') return 'cancel';

    if (result === 'Save and continue') {
        for (const doc of dirtyDocs) {
            await doc.save();
        }
        return 'continue';
    }

    if (result === 'Discard and continue') {
        return 'continue';
    }

    return 'cancel';
}

function listDirtyDocs(targets: TargetTextDocPaths): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter((doc) => {
        if (!doc.isDirty) return false;
        return isTargetTextDoc(doc.uri.fsPath, targets);
    });
}

export async function revertDocs(targets: TargetTextDocPaths): Promise<void> {
    const docs = vscode.workspace.textDocuments.filter((doc) => isTargetTextDoc(doc.uri.fsPath, targets));
    for (const doc of docs) {
        try {
            await vscode.commands.executeCommand('workbench.action.files.revertResource', doc.uri);
        } catch {
            try {
                await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
            } catch {
                /* ignore */
            }
        }
    }
}

async function readOutlinerFromDisk(outFilePath: string): Promise<any> {
    const uri = vscode.Uri.file(outFilePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(text);
}
