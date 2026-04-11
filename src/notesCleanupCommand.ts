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
    mainFolderPaths: string[];  // .note のあるフォルダの絶対パス配列
}

export interface CleanupCandidate {
    absPath: string;
    relPath: string;
    type: 'orphan-md' | 'orphan-image';
    sizeBytes: number;
}

/**
 * 1 つの note フォルダをスキャンして orphan ファイルを検出する
 */
async function scanSingleNote(mainFolderPath: string): Promise<CleanupCandidate[]> {
    const outFiles = await coreListOutFiles(mainFolderPath);
    const { liveMd, liveImages: liveImagesPass1 } = await coreBuildLiveSetPass1(outFiles, mainFolderPath);

    // Pass 2: alive md からの image refs を加算
    const liveImages = await buildPass2LiveImages(liveMd, liveImagesPass1, mainFolderPath);

    const allMd = await coreListAllMd(mainFolderPath);
    const orphanMd = allMd.filter(p => !liveMd.has(p));

    const allImages = await coreListAllImages(mainFolderPath);
    const orphanImages = allImages.filter(p => !liveImages.has(p));

    const result: CleanupCandidate[] = [];
    for (const p of orphanMd) {
        result.push({
            absPath: p,
            relPath: path.relative(mainFolderPath, p),
            type: 'orphan-md',
            sizeBytes: fs.statSync(p).size
        });
    }
    for (const p of orphanImages) {
        result.push({
            absPath: p,
            relPath: path.relative(mainFolderPath, p),
            type: 'orphan-image',
            sizeBytes: fs.statSync(p).size
        });
    }
    return result;
}

export async function runNotesCleanup(ctx: NotesCleanupContext): Promise<void> {
    if (!ctx.mainFolderPaths || ctx.mainFolderPaths.length === 0) {
        vscode.window.showInformationMessage(
            'No registered notes found. Add a note folder in Activity Bar first.'
        );
        return;
    }

    const candidatesByNote = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Fractal: Clean Unused Files (All Notes)',
            cancellable: true
        },
        async (progress, token) => {
            const result = new Map<string, CleanupCandidate[]>();
            const total = ctx.mainFolderPaths.length;

            for (let i = 0; i < ctx.mainFolderPaths.length; i++) {
                if (token.isCancellationRequested) { return result; }

                const mainFolderPath = ctx.mainFolderPaths[i];
                const noteName = path.basename(mainFolderPath);
                progress.report({
                    message: `Scanning ${noteName} (${i + 1}/${total})`,
                    increment: 100 / total
                });

                try {
                    const candidates = await scanSingleNote(mainFolderPath);
                    if (candidates.length > 0) {
                        result.set(mainFolderPath, candidates);
                    }
                } catch (e) {
                    console.warn(`[Fractal] Failed to scan ${mainFolderPath}:`, e);
                }
            }

            return result;
        }
    );

    const totalCount = Array.from(candidatesByNote.values())
        .reduce((sum, arr) => sum + arr.length, 0);

    if (totalCount === 0) {
        vscode.window.showInformationMessage('No unused files found in any registered note.');
        return;
    }

    // QuickPick 表示 (grouped)
    const selected = await showCleanupQuickPickGrouped(candidatesByNote);
    if (!selected || selected.length === 0) { return; }

    // ゴミ箱移動
    await applyCleanup(selected);
}

/**
 * 全 note の orphan ファイルを note ごとにグルーピングして QuickPick に表示
 */
async function showCleanupQuickPickGrouped(
    candidatesByNote: Map<string, CleanupCandidate[]>
): Promise<CleanupCandidate[] | null> {
    interface CleanupQuickPickItem extends vscode.QuickPickItem {
        candidate?: CleanupCandidate;
    }

    const items: CleanupQuickPickItem[] = [];
    let totalBytes = 0;

    for (const [mainFolderPath, candidates] of candidatesByNote.entries()) {
        const noteName = path.basename(mainFolderPath);

        // Separator
        items.push({
            label: noteName,
            kind: vscode.QuickPickItemKind.Separator
        });

        // Candidates for this note
        for (const c of candidates) {
            const icon = c.type === 'orphan-md' ? '$(file-text)' : '$(file-media)';
            items.push({
                label: `${icon} ${c.relPath}`,
                description: formatBytes(c.sizeBytes),
                picked: true,
                candidate: c
            });
            totalBytes += c.sizeBytes;
        }
    }

    const totalCount = items.filter(i => i.candidate).length;

    const quickPick = vscode.window.createQuickPick<CleanupQuickPickItem>();
    quickPick.title = `Found ${totalCount} unused files in ${candidatesByNote.size} notes (${formatBytes(totalBytes)} total)`;
    quickPick.placeholder = 'Select files to move to trash';
    quickPick.canSelectMany = true;
    quickPick.items = items;
    // Separators を除いた item のみ selected に
    quickPick.selectedItems = items.filter(i => i.candidate);

    // 全選択 / 全解除 custom buttons
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
                quickPick.selectedItems = items.filter(i => i.candidate);
            } else if (btn === deselectAllBtn) {
                quickPick.selectedItems = [];
            }
        });

        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems
                .filter(i => i.candidate)
                .map(i => i.candidate!);
            quickPick.hide();
            resolve(selected.length > 0 ? selected : null);
        });

        quickPick.onDidHide(() => {
            resolve(null);
        });

        quickPick.show();
    });
}

// 旧 showCleanupQuickPick は削除 (単一 note 版は不要)

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
