// md-link-actions-host — md エディタのリンク右クリック（Reveal in Finder）と、選択範囲の
// Export bundle / Export folder の VS Code 依存部分。3 provider（notes / standalone md / outliner sidepanel）が共通で使う。
// リンクの解決（clamp root）は各 provider が Copy Path と同じものを resolvers で渡す。
import * as fs from 'fs';
import * as vscode from 'vscode';
import { t } from '../i18n/messages';
import { runExportBundle } from './export-bundle-host';
import { runFolderExportWithDialog } from './folder-export-host';
import { ExportOptions } from './md-export-core';
import {
    MdLinkResolvers, buildMdSelectionExportTree, makeMdSelectionExportMd, selectionBundleRootPath,
} from './md-selection-export';

/** md / subpage / file リンクのリンク先を OS のファイラで選択表示する。解決できない・実体が無いときは警告 */
export async function revealMdLinkTarget(href: string, kind: string, r: MdLinkResolvers): Promise<void> {
    const abs = kind === 'file' ? r.resolveFile(href) : (kind === 'md' ? r.resolveMd(href) : null);
    if (!abs || !fs.existsSync(abs)) {
        vscode.window.showWarningMessage(t('fileNotFoundOrUnsafe'));
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(abs));
}

/** 選択範囲を 1 本の md にした Export bundle（フォルダ選択 → md-export-core） */
export async function runExportMdSelectionBundle(mdFilePath: string, markdown: string, options: ExportOptions): Promise<void> {
    if (!mdFilePath || !markdown) return;
    await runExportBundle(selectionBundleRootPath(mdFilePath), options, markdown);
}

/** 選択範囲のリンク先を、箇条書きの入れ子どおりのフォルダ木に書き出す（Export folder と同じ出力・確認・通知） */
export async function runExportMdSelectionFolder(
    markdown: string,
    r: MdLinkResolvers,
    guard?: (destPath: string) => { ok: boolean; reason?: string },
): Promise<void> {
    const plan = buildMdSelectionExportTree(markdown, r);
    if (plan.linkCount === 0) {
        vscode.window.showWarningMessage(t('fileNotFoundOrUnsafe'));
        return;
    }
    await runFolderExportWithDialog({
        tree: plan.tree,
        // md は exportMd adapter が実パスから、file は絶対パスで複製するので src dir は使わない
        srcOutDir: '', srcPagesDir: '', srcFileDir: '', srcImageDir: '',
        guard,
        exportMd: makeMdSelectionExportMd(plan.mdByKey),
    });
}
