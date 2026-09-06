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
import { runFolderImport, runSendToOutliner, FolderImportOutcome } from './folder-import';

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

/**
 * FR-SND-01/02 (§6-1): 「Outliner に送る」の VS Code 依存グルー。
 *
 * dialog は出さない（対象は linkedfd の選択集合で確定している）が、
 * **確認 modal / 上限通知 / 集計通知は Import folder と同一文言・同一閾値**を使う
 * （`runSendToOutliner` が内部で `runFolderImport` を呼ぶため自動的に共有される）。
 */
export async function runSendToOutlinerWithDialogs(
    target: FolderImportTarget,
    roots: string[]
): Promise<FolderImportOutcome> {
    return runSendToOutliner({
        pageDir: target.pageDir,
        imageDir: target.imageDir,
        fileDir: target.fileDir,
        outDir: target.outDir,
        roots,
        confirmLarge: async (totalCount: number) => {
            const proceed = t('importFolderConfirmProceed');
            const answer = await vscode.window.showWarningMessage(
                t('importFolderConfirm').replace('{count}', String(totalCount)),
                { modal: true },
                proceed
            );
            return answer === proceed;
        },
        notifyLimitExceeded: () => { vscode.window.showWarningMessage(t('importFolderTooMany')); },
        notifySkipped: (skipped: number) => {
            vscode.window.showWarningMessage(t('importFolderSkipped').replace('{count}', String(skipped)));
        },
    });
}

/**
 * NFR-MSEL-03 / NFR-I18N-01 (§4-4): batch 転送の**集計通知（1 回だけ）**。
 *
 * `runBatchTransfer(items, transferOne, { notifyOutcome })` の既定実装として使う
 * （アイテム毎にトーストを出さない — 200 件で 200 個の通知が出るのを防ぐ）。
 */
export function notifyBatchOutcome(outcome: { succeeded: number; skipped: number; failed: number }): void {
    if (outcome.failed === 0 && outcome.skipped === 0) { return; }   // 全成功は無音
    vscode.window.showWarningMessage(
        t('batchDndSummary')
            .replace('{count}', String(outcome.succeeded))
            .replace('{skipped}', String(outcome.skipped))
            .replace('{failed}', String(outcome.failed)));
}

/**
 * FR-SND-01 段 0（再オープン TASK-46 / design §6-1）: 「Outliner に送る」の**前提検査**（vscode 非依存・unit で叩く）。
 *
 * メインペインで開いているのが `.out` でなければ送り先が無い。初版の provider は無通知で早期 return して
 * 「無反応」に見えたため、判定をここに切り出し、provider は結果に応じて `sendToOutlinerNoOutline` を 1 回通知する。
 */
export function resolveSendToOutlinerTarget(
    currentFilePath: string | null | undefined
): { ok: true; outPath: string } | { ok: false; reason: 'no_outline' } {
    if (!currentFilePath || !/\.out$/i.test(currentFilePath)) { return { ok: false, reason: 'no_outline' }; }
    return { ok: true, outPath: currentFilePath };
}

/**
 * 2026-09-05（FR-DFI-01）: D&D で落とされたフォルダ群を Import folder と同じ経路で取り込み、
 * drop 位置（targetNodeId / position）付きの `importFolderResult` を webview へ返す。
 * closure 抑止・件数ゲート・随伴転送・FR-OIF-08 のリンク張り替えはすべて `runSendToOutliner` が担う（新規経路を書かない）。
 */
export async function importDroppedFoldersIntoOut(
    target: FolderImportTarget,
    dirs: string[],
    sender: { postMessage(msg: unknown): void },
    targetNodeId: string | null,
    position: string | null
): Promise<FolderImportOutcome | null> {
    if (!Array.isArray(dirs) || dirs.length === 0) { return null; }
    const outcome = await runSendToOutlinerWithDialogs(target, dirs);
    if (outcome.status !== 'imported') { return outcome; }
    sender.postMessage({
        type: 'importFolderResult',
        targetNodeId: targetNodeId ?? null,
        position: position ?? null,
        entries: outcome.entries,
        skipped: outcome.skipped,
    });
    return outcome;
}
