/**
 * folder-import — outliner「Import folder...」の再帰列挙 + コピー統合
 * （DOM-FolderImportWalk / DOM-FolderImportPlan・FR-OIF-02/03/04）
 * Sprint 20260827-172802（ADRL-0103: 実体は note へコピー）。
 *
 * - 隠し「.」エントリ skip + symlink 非追従（fv listing = FR-FLV-11 と同一の dirent 意味論）
 * - 上限 maxFiles 2000 / maxDepth 20（fv-residual-refs walk と同じ定数系譜）— 超過は列挙段階で
 *   中断し {ok:false} を返す（コピー 0 = 原状不変。部分取り込みしない — FR-OIF-03）
 * - totalCount > 200（FOLDER_IMPORT_CONFIRM_THRESHOLD）は呼び出し側が確認 modal を出す
 * - 並び = フォルダ先行・名前昇順（fv listing と同じ — node 挿入順の決定論）
 */
import * as fs from 'fs';
import * as path from 'path';
import { importMdFilesCore, ImportMdItem, ImportedMdFile } from './markdown-import';
import { importFilesCore, ImportFileItem, ImportedFile } from './file-import';

export const FOLDER_IMPORT_MAX_FILES = 2000;
export const FOLDER_IMPORT_MAX_DEPTH = 20;
export const FOLDER_IMPORT_CONFIRM_THRESHOLD = 200;

export type FolderImportEntry =
    | { kind: 'dir'; name: string; children: FolderImportEntry[] }
    | { kind: 'md'; name: string; absPath: string }
    | { kind: 'file'; name: string; absPath: string };

export type WalkFolderResult =
    | { ok: true; entries: FolderImportEntry[]; fileCount: number; totalCount: number; unreadableDirs: number }
    | { ok: false; error: 'too_many' | 'too_deep' };

/** 上限超過による列挙中断（内部専用）。Error 派生にして stack trace を残す（no-throw-literal 準拠） */
class FolderImportAbort extends Error {
    constructor(public readonly reason: 'too_many' | 'too_deep') {
        super(`folder import aborted: ${reason}`);
        this.name = 'FolderImportAbort';
    }
}

export function walkFolderForImport(
    rootAbs: string,
    limits?: { maxFiles?: number; maxDepth?: number }
): WalkFolderResult {
    const maxFiles = limits?.maxFiles ?? FOLDER_IMPORT_MAX_FILES;
    const maxDepth = limits?.maxDepth ?? FOLDER_IMPORT_MAX_DEPTH;
    let fileCount = 0;
    let totalCount = 0;
    let unreadableDirs = 0;

    const walkDir = (dirAbs: string, depth: number): FolderImportEntry[] => {
        if (depth > maxDepth) { throw new FolderImportAbort('too_deep'); }
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch (e) {
            // 読めない dir は中身を落とすが、silent 消失させない（件数を呼び出し側の skip 集計へ）
            unreadableDirs++;
            console.warn('[Outliner] folder import: directory not readable — contents skipped:', dirAbs, e);
            return [];
        }
        // 隠し「.」+ symlink 除外（FR-FLV-11 意味論）→ フォルダ先行 + 大小文字を無視した昇順
        // （比較関数は precedent readFolderEntriesAt（notes-message-handler.ts）と同一 — fv 一覧と並びを揃える）
        const visible = dirents.filter((d) => !d.name.startsWith('.') && !d.isSymbolicLink());
        visible.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
            const an = a.name.toLowerCase(); const bn = b.name.toLowerCase();
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        const out: FolderImportEntry[] = [];
        for (const d of visible) {
            const abs = path.join(dirAbs, d.name);
            if (d.isDirectory()) {
                totalCount++;
                out.push({ kind: 'dir', name: d.name, children: walkDir(abs, depth + 1) });
            } else if (d.isFile()) {
                fileCount++; totalCount++;
                if (fileCount > maxFiles) { throw new FolderImportAbort('too_many'); }
                out.push(/\.md$/i.test(d.name)
                    ? { kind: 'md', name: d.name, absPath: abs }
                    : { kind: 'file', name: d.name, absPath: abs });
            }
            // socket/fifo 等はどれでもない → skip
        }
        return out;
    };

    try {
        const entries = walkDir(rootAbs, 1);
        return { ok: true, entries, fileCount, totalCount, unreadableDirs };
    } catch (e) {
        if (e instanceof FolderImportAbort) { return { ok: false, error: e.reason }; }
        throw e;
    }
}

// ────────────────────────────────────────────
// DOM-FolderImportPlan — コピー実行と results 契約（FR-OIF-02/04・design §A3）
// ────────────────────────────────────────────

/**
 * webview へ渡す階層 entries（walk entries とは別形 — absPath ではなく取り込み後の実体参照を持つ）。
 * message: { type:'importFolderResult', targetNodeId, entries, skipped }
 */
export type FolderImportResultEntry =
    | { kind: 'dir'; name: string; children: FolderImportResultEntry[] }
    | { kind: 'md'; name: string; pageId: string }      // pages/<pageId>.md（importMdFilesCore の結果）
    | { kind: 'file'; name: string; filePath: string }; // outDir 相対（importFilesCore の結果）

export interface FolderImportDeps {
    /** showOpenDialog({canSelectFolders:true, canSelectFiles:false, canSelectMany:false})。undefined = キャンセル */
    pickFolder(): Promise<string | undefined> | string | undefined;
    /** totalCount > 閾値 の確認 modal（importFolderConfirm）。false = 取り込まない */
    confirmLarge(totalCount: number): Promise<boolean> | boolean;
    /** 上限超過の失敗通知（importFolderTooMany） */
    notifyLimitExceeded(error: 'too_many' | 'too_deep'): void;
    /** 個別失敗の集計通知（importFolderSkipped）。skipped > 0 のときだけ呼ぶ */
    notifySkipped(skipped: number): void;
    pageDir: string;
    imageDir: string;
    fileDir: string;
    outDir: string;
    /** 既定は既存 core そのまま（新規コピー/衝突ロジックを書かない）。unit が spy を差すために注入可 */
    importMd?(items: ImportMdItem[], pageDir: string, imageDir: string): ImportedMdFile[];
    importFile?(items: ImportFileItem[], fileDir: string, outDir: string): ImportedFile[];
    limits?: { maxFiles?: number; maxDepth?: number; confirmThreshold?: number };
}

export interface FolderImportOutcome {
    status: 'cancelled' | 'declined' | 'aborted' | 'imported';
    error?: 'too_many' | 'too_deep';
    entries: FolderImportResultEntry[];
    skipped: number;
}

/**
 * フォルダ選択 → 列挙 → 確認 → コピー を通す host 側オーケストレーション。
 * VS Code 依存（dialog / modal / 通知）は deps 注入。webview への 1 message 送信は呼び出し側
 * （status==='imported' のときだけ entries/skipped を post する）。
 *
 * - キャンセル: walk もコピーも通知も 0（FR-OIF-04・TC-OIF-08）
 * - 上限超過: 失敗通知 1 回・コピー 0 = 原状不変（部分取り込みしない — FR-OIF-03・TC-OIF-07）
 * - 個別失敗（読取/書込）: skip して他を続行し、件数を集計通知（FR-OIF-04・TC-OIF-03）
 */
export async function runFolderImport(deps: FolderImportDeps): Promise<FolderImportOutcome> {
    const rootAbs = await deps.pickFolder();
    if (!rootAbs) { return { status: 'cancelled', entries: [], skipped: 0 }; }

    const walked = walkFolderForImport(rootAbs, deps.limits);
    if (!walked.ok) {
        deps.notifyLimitExceeded(walked.error);
        return { status: 'aborted', error: walked.error, entries: [], skipped: 0 };
    }

    const threshold = deps.limits?.confirmThreshold ?? FOLDER_IMPORT_CONFIRM_THRESHOLD;
    if (walked.totalCount > threshold && !(await deps.confirmLarge(walked.totalCount))) {
        return { status: 'declined', entries: [], skipped: 0 };
    }

    const importMd = deps.importMd ?? importMdFilesCore;
    const importFile = deps.importFile ?? importFilesCore;
    // 列挙段階で中身を落とした dir も skip 件数に含める（部分成功を silent にしない — reviewer SECGOV-1）
    let skipped = walked.unreadableDirs;

    const warnSkipped = (absPath: string, reason: unknown): void => {
        console.warn('[Outliner] folder import: entry skipped:', absPath, reason);
    };

    // 走査順に 1 エントリずつコピー（個別失敗を skip に縮退させるため core 呼び出しも 1 件単位。
    // files/ の連番 uniquify は core 内蔵規則が逐次で効く — 新規衝突ロジックを書かない）
    const copyEntries = (entries: FolderImportEntry[]): FolderImportResultEntry[] => {
        const out: FolderImportResultEntry[] = [];
        for (const e of entries) {
            if (e.kind === 'dir') {
                out.push({ kind: 'dir', name: e.name, children: copyEntries(e.children) });
                continue;
            }
            try {
                if (e.kind === 'md') {
                    // core は content 文字列を取る（相対画像は sourceDir 起点で解決される）
                    const item: ImportMdItem = {
                        name: e.name,
                        content: fs.readFileSync(e.absPath, 'utf8'),
                        sourceDir: path.dirname(e.absPath),
                    };
                    const [imported] = importMd([item], deps.pageDir, deps.imageDir);
                    // 現行 core は 1 要素なら「throw か 1 件返す」の二択だが、空返しを取り込まないための契約ガード
                    if (!imported) { skipped++; warnSkipped(e.absPath, 'importMd returned no result'); continue; }
                    out.push({ kind: 'md', name: e.name, pageId: imported.pageId });
                } else {
                    const item: ImportFileItem = { name: e.name, buffer: fs.readFileSync(e.absPath) };
                    const [imported] = importFile([item], deps.fileDir, deps.outDir);
                    if (!imported) { skipped++; warnSkipped(e.absPath, 'importFile returned no result'); continue; }
                    out.push({ kind: 'file', name: e.name, filePath: imported.filePath });
                }
            } catch (err) {
                // 読取不能 / 書込失敗の 1 件は skip して他を続行（FR-OIF-04）。
                // 通知は件数のみなので、どのファイルが何で落ちたかはログに残す（silent 握り禁止）
                skipped++;
                warnSkipped(e.absPath, err);
            }
        }
        return out;
    };

    const copied = copyEntries(walked.entries);
    // 仕様変更 2026-08-29（ユーザー裁定）: **選んだフォルダ自身も node にする**（中身だけ並ぶと
    // どのフォルダを取り込んだのか分からないため）。webview 側は dir entry を通常 node + 子再帰で
    // 扱うので、既存 applyFolderImportResult の変更は不要。
    const rootName = path.basename(rootAbs) || rootAbs;
    const resultEntries: FolderImportResultEntry[] = [{ kind: 'dir', name: rootName, children: copied }];
    if (skipped > 0) { deps.notifySkipped(skipped); }
    return { status: 'imported', entries: resultEntries, skipped };
}
