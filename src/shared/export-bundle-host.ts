// export-bundle-host — md export bundle の VS Code 依存部分（フォルダ選択 + 実行 + 通知）。
// 3 provider（notes / standalone md / outliner sidepanel）が共通で使う（FR-EX-03）。
// root md 解決は各 provider が行い、ここには解決済みの絶対パスが渡る。
import * as vscode from 'vscode';
import { exportBundle, ExportOptions } from './md-export-core';
import { runOutlinerNodesExportBundle, OutlinerPasteNode } from './paste-asset-handler';

/**
 * フォルダ選択ダイアログを出し、選ばれたら root md を起点に bundle を出力する。
 * キャンセル時は何もしない（副作用ゼロ・NFR-EX-01）。
 */
export async function runExportBundle(rootMdAbs: string, options: ExportOptions): Promise<void> {
    if (!rootMdAbs) {
        vscode.window.showErrorMessage('Export failed: no file is open.');
        return;
    }
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Export here',
    });
    if (!picked || picked.length === 0) return; // キャンセル = 副作用ゼロ
    const dest = picked[0].fsPath;
    const result = exportBundle({ rootMdAbs, dest, options });
    if (result.ok) {
        vscode.window.showInformationMessage(
            `Exported ${result.mdCount} md, ${result.imageCount} images, ${result.fileCount} files → ${result.bundleDir}`);
    } else {
        vscode.window.showErrorMessage(`Export failed: ${result.error || 'unknown error'}`);
    }
}

/**
 * outliner node subtree の Export bundle (FR-EB)。フォルダ選択 → core 実行 → 通知。
 * キャンセル時は core を呼ばない（副作用ゼロ・FR-EB-02/NFR-04）。
 */
export async function runExportOutlinerNodesBundle(args: {
    nodeId: string;
    nodes: OutlinerPasteNode[];
    srcOutDir: string;
    srcPagesDir: string;
    srcFileDir: string;
}): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Export here',
    });
    if (!picked || picked.length === 0) return; // キャンセル = 副作用ゼロ
    const result = runOutlinerNodesExportBundle({ ...args, dest: picked[0].fsPath });
    if (result.ok) {
        vscode.window.showInformationMessage(`Exported node bundle → ${result.bundleDir}`);
    } else {
        vscode.window.showErrorMessage(`Export failed: ${result.error || 'unknown error'}`);
    }
}
