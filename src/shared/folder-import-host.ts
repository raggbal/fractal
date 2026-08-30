/**
 * folder-import-host — Import folder の VS Code 依存グルー（フォルダ選択 dialog / 確認 modal / 通知）。
 * Sprint 20260827-172802（FR-OIF-01..04・design §A1/A3）。
 *
 * 2 つの host 面（outlinerProvider の standalone .out / notesEditorProvider の Notes mode）が
 * この 1 実装を共有し、面側は「パス 4 本の解決」と「webview への 1 message」だけを持つ
 * （面ごとに dialog/modal/通知を書き分けない = 「N 面の一部にだけ配線」の回避）。
 */
import * as vscode from 'vscode';
import { t } from '../i18n/messages';
import { runFolderImport, FolderImportOutcome } from './folder-import';

export interface FolderImportTarget {
    /** md 実体の置き場（pages/ — flat-layout は provider 側の getter が解決済み） */
    pageDir: string;
    /** md の相対画像コピー先 */
    imageDir: string;
    /** 添付ファイルの置き場（files/） */
    fileDir: string;
    /** filePath を相対化する基準（.out と同階層） */
    outDir: string;
}

/**
 * showOpenDialog（フォルダのみ・単一選択）→ 列挙 → 200 超確認 modal → コピー。
 * 戻り値の status が 'imported' のときだけ呼び出し側が importFolderResult を post する。
 */
export async function runFolderImportWithDialog(target: FolderImportTarget): Promise<FolderImportOutcome> {
    return runFolderImport({
        pageDir: target.pageDir,
        imageDir: target.imageDir,
        fileDir: target.fileDir,
        outDir: target.outDir,
        pickFolder: async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: false,
                canSelectFolders: true,
                title: 'Import folder',
            });
            return picked && picked.length > 0 ? picked[0].fsPath : undefined;
        },
        // 件数付き modal（precedent: flat migrate の showWarningMessage({modal:true})）。
        // キャンセル（Cancel / dismiss）は undefined が返るので取り込まない。
        confirmLarge: async (totalCount: number) => {
            const proceed = t('importFolderConfirmProceed');
            const answer = await vscode.window.showWarningMessage(
                t('importFolderConfirm').replace('{count}', String(totalCount)),
                { modal: true },
                proceed
            );
            return answer === proceed;
        },
        // 上限超過は件数/深さのどちらも同一文言（コピー 0 = 原状不変を伝える）
        notifyLimitExceeded: () => { vscode.window.showWarningMessage(t('importFolderTooMany')); },
        notifySkipped: (skipped: number) => {
            vscode.window.showWarningMessage(t('importFolderSkipped').replace('{count}', String(skipped)));
        },
    });
}
