/**
 * folder-export-host — Export folder の VS Code 依存グルー（出力先 dialog / 確認 modal / 完了通知）。
 * Sprint 20260827-172802 第 2 ラウンド（FR-EXF-01/05・design §C5）。
 *
 * Import 側 `folder-import-host.ts` の対称。2 面（outlinerProvider の standalone `.out` /
 * notesEditorProvider の Notes mode）がこの 1 実装を共有し、面側は**パス 4 本の解決**だけを持つ。
 */
import * as vscode from 'vscode';
import { t } from '../i18n/messages';
import { runFolderExport, ExportNode, FolderExportOutcome } from './folder-export';

export interface FolderExportTarget {
    /** 出力する node 木（webview の buildExportTree が組んだ DOM-ExportPayload） */
    tree: ExportNode[];
    /** .out と同階層（node.filePath / node.images の相対基準） */
    srcOutDir: string;
    /** md 添付の実体 dir（pages/ 相当・flat note は getter が解決済み） */
    srcPagesDir: string;
    /** 添付ファイルの実体 dir（files/） */
    srcFileDir: string;
    /** node 直付き画像の実体 dir（images/） */
    srcImageDir: string;
    /**
     * 出力先の妥当性判定（Notes 面のみ渡す）。`fileManager.guardFolderSelection(dest)` の戻りをそのまま渡す。
     * standalone `.out` 面には同機構が無いため undefined（= ガードしない。面差は受容事項）。
     */
    guard?: (destPath: string) => { ok: boolean; reason?: string };
}

/**
 * guardFolderSelection の reason 別の扱い（design §C5）。
 * `invalid` / `self` / `ancestor` / `descendant` は拒否するが、**`duplicate` は拒否しない**
 * （duplicate は「その dir が folder link として既に登録済み」という export 先とは無関係な理由）。
 */
export function isExportDestinationRejected(guardResult?: { ok: boolean; reason?: string }): boolean {
    if (!guardResult || guardResult.ok) { return false; }
    return guardResult.reason !== 'duplicate';
}

/**
 * 出力先選択 → 200 超確認 → 出力 → 件数通知。
 * キャンセルは core を呼ばない（fs 書き込み 0 = 副作用ゼロ）。
 */
export async function runFolderExportWithDialog(target: FolderExportTarget): Promise<FolderExportOutcome> {
    return runFolderExport(target.tree, {
        srcOutDir: target.srcOutDir,
        srcPagesDir: target.srcPagesDir,
        srcFileDir: target.srcFileDir,
        srcImageDir: target.srcImageDir,
        pickDestination: async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Export here',
                title: 'Export folder',
            });
            const dest = picked && picked.length > 0 ? picked[0].fsPath : undefined;
            if (!dest) { return undefined; }
            // Notes 面のみ: note フォルダ自身/祖先/子孫への出力を拒否（duplicate は通す）
            if (target.guard) {
                const g = target.guard(dest);
                if (isExportDestinationRejected(g)) {
                    vscode.window.showErrorMessage(t('exportFolderInvalidDest') || 'Cannot export into the note folder.');
                    return undefined;
                }
            }
            return dest;
        },
        confirmLarge: async (totalCount: number) => {
            const proceed = t('exportFolderConfirmProceed');
            const answer = await vscode.window.showWarningMessage(
                t('exportFolderConfirm').replace('{count}', String(totalCount)),
                { modal: true },
                proceed
            );
            return answer === proceed;
        },
        notifyDone: (folders: number, files: number, skipped: number) => {
            const msg = t('exportFolderDone')
                .replace('{folders}', String(folders))
                .replace('{files}', String(files))
                .replace('{skipped}', String(skipped));
            vscode.window.showInformationMessage(msg);
        },
    });
}
