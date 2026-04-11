/**
 * notesCleanupCommand.ts
 *
 * FR-5: Manual cleanup command for orphan files in Notes.
 *
 * 2-pass cleanup:
 *   Pass 1: .out → alive md + alive images (from node.images[])
 *   Pass 2: alive md → alive images (from ![](img) references)
 *   Result: orphan md + orphan images
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    listOutFiles as coreListOutFiles,
    listAllMd as coreListAllMd,
    listAllImages as coreListAllImages,
    buildLiveSetPass1 as coreBuildLiveSetPass1,
    buildPass2LiveImages
} from './shared/cleanup-core';

// Re-export for backward compatibility
export {
    listOutFiles,
    listAllMd,
    listAllImages,
    buildLiveSetPass1,
    walkRecursive
} from './shared/cleanup-core';

export interface NotesCleanupContext {
    mainFolderPath: string;  // .note のあるフォルダの絶対パス
}

export interface CleanupCandidate {
    absPath: string;
    relPath: string;
    type: 'orphan-md' | 'orphan-image';
    sizeBytes: number;
}

export async function runNotesCleanup(ctx: NotesCleanupContext): Promise<void> {
    const candidates = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Fractal: Clean Unused Files',
            cancellable: true
        },
        async (progress, token) => {
            progress.report({ message: 'Scanning .out files...', increment: 10 });
            const outFiles = await coreListOutFiles(ctx.mainFolderPath);
            if (token.isCancellationRequested) { return []; }

            progress.report({ message: 'Building reference graph...', increment: 20 });
            const { liveMd, liveImages: liveImagesPass1 } = await coreBuildLiveSetPass1(outFiles, ctx.mainFolderPath);
            if (token.isCancellationRequested) { return []; }

            progress.report({ message: 'Finding orphan .md files...', increment: 30 });
            const allMd = await coreListAllMd(ctx.mainFolderPath);
            const orphanMd = allMd.filter(p => !liveMd.has(p));
            if (token.isCancellationRequested) { return []; }

            progress.report({ message: 'Finding orphan images...', increment: 30 });
            // Pass 2: alive md からの image refs を加算
            const liveImages = await buildPass2LiveImages(liveMd, liveImagesPass1, ctx.mainFolderPath);

            const allImages = await coreListAllImages(ctx.mainFolderPath);
            const orphanImages = allImages.filter(p => !liveImages.has(p));
            if (token.isCancellationRequested) { return []; }

            progress.report({ message: 'Calculating sizes...', increment: 10 });
            const result: CleanupCandidate[] = [];
            for (const p of orphanMd) {
                result.push({
                    absPath: p,
                    relPath: path.relative(ctx.mainFolderPath, p),
                    type: 'orphan-md',
                    sizeBytes: fs.statSync(p).size
                });
            }
            for (const p of orphanImages) {
                result.push({
                    absPath: p,
                    relPath: path.relative(ctx.mainFolderPath, p),
                    type: 'orphan-image',
                    sizeBytes: fs.statSync(p).size
                });
            }
            return result;
        }
    );

    if (!candidates || candidates.length === 0) {
        vscode.window.showInformationMessage('No unused files found.');
        return;
    }

    // QuickPick 表示
    const selected = await showCleanupQuickPick(candidates);
    if (!selected || selected.length === 0) { return; }

    // ゴミ箱移動
    await applyCleanup(selected);
}

async function showCleanupQuickPick(candidates: CleanupCandidate[]): Promise<CleanupCandidate[] | null> {
    const totalBytes = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
    const totalMb = (totalBytes / 1024 / 1024).toFixed(2);

    interface CleanupQuickPickItem extends vscode.QuickPickItem {
        candidate: CleanupCandidate;
    }

    const items: CleanupQuickPickItem[] = candidates.map(c => ({
        label: `${c.type === 'orphan-md' ? '$(file-text)' : '$(file-media)'} ${c.relPath}`,
        description: formatBytes(c.sizeBytes),
        picked: true,  // デフォルト全選択
        candidate: c
    }));

    const quickPick = vscode.window.createQuickPick<CleanupQuickPickItem>();
    quickPick.title = `Found ${candidates.length} unused files (${totalMb} MB total)`;
    quickPick.placeholder = 'Select files to move to trash';
    quickPick.canSelectMany = true;
    quickPick.items = items;
    quickPick.selectedItems = items;  // デフォルト全選択

    // カスタムボタン: 全選択 / 全解除
    const selectAllBtn: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('check-all'),
        tooltip: 'Select All'
    };
    const deselectAllBtn: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('clear-all'),
        tooltip: 'Deselect All'
    };
    quickPick.buttons = [selectAllBtn, deselectAllBtn];

    return new Promise<CleanupCandidate[] | null>((resolve) => {
        quickPick.onDidTriggerButton(btn => {
            if (btn === selectAllBtn) {
                quickPick.selectedItems = quickPick.items;
            } else if (btn === deselectAllBtn) {
                quickPick.selectedItems = [];
            }
        });

        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems.map(i => i.candidate);
            quickPick.hide();
            resolve(selected.length > 0 ? selected : null);
        });

        quickPick.onDidHide(() => {
            resolve(null);
        });

        quickPick.show();
    });
}

async function applyCleanup(selected: CleanupCandidate[]): Promise<void> {
    let successCount = 0;
    let failCount = 0;
    let totalBytes = 0;

    for (const candidate of selected) {
        try {
            await vscode.workspace.fs.delete(
                vscode.Uri.file(candidate.absPath),
                { useTrash: true, recursive: false }
            );
            successCount++;
            totalBytes += candidate.sizeBytes;
        } catch (e) {
            failCount++;
            console.error('[Fractal] Failed to delete:', candidate.absPath, e);
        }
    }

    const message = failCount > 0
        ? `Moved ${successCount} files to trash (${formatBytes(totalBytes)}). ${failCount} failed.`
        : `Moved ${successCount} files to trash. Freed ${formatBytes(totalBytes)}.`;

    vscode.window.showInformationMessage(message);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
