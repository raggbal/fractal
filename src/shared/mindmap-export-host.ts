/**
 * mindmap-export-host — Mindmap エクスポート (exportMindmap) の host 側 vscode glue。
 *
 * 純粋部分 (payload→bytes + パス解決) は mindmap-export-prepare.ts に分離済み (単体テスト可能)。
 * ここは SaveDialog + workspace.fs.writeFile のみ。
 * Outliner Single (outlinerProvider) と Note (notes-message-handler) の両方から呼ぶ (#M2, 4-mode)。
 *
 * 仕様の正典: design/system/api.md
 */

import * as vscode from 'vscode';
import {
    prepareExport,
    FILTERS_BY_FORMAT,
    MindmapExportFormat,
    MindmapExportMessage
} from './mindmap-export-prepare';

export { MindmapExportFormat, MindmapExportMessage } from './mindmap-export-prepare';

export interface MindmapExportResult {
    ok: boolean;
    format: MindmapExportFormat;
    savedPath?: string;
    error?: string;
}

/**
 * exportMindmap メッセージを処理してファイルを保存する。
 * @param message webview からのメッセージ
 * @param baseDir 保存先の既定ディレクトリ (.out のあるディレクトリ)。
 * @returns 結果 (webview に mindmapExportDone として返せる)
 */
export async function handleExportMindmap(
    message: MindmapExportMessage,
    baseDir: string
): Promise<MindmapExportResult> {
    const format = message.format;
    const prepared = prepareExport(message, baseDir);
    if (!prepared) {
        return { ok: false, format, error: `unknown_format:${format}` };
    }

    const defaultUri = prepared.defaultPath ? vscode.Uri.file(prepared.defaultPath) : undefined;
    const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: FILTERS_BY_FORMAT[format]
    });
    if (!target) {
        return { ok: false, format, error: 'cancelled' };
    }

    try {
        await vscode.workspace.fs.writeFile(target, prepared.bytes);
        return { ok: true, format, savedPath: target.fsPath };
    } catch (e: any) {
        return { ok: false, format, error: String(e && e.message ? e.message : e) };
    }
}
