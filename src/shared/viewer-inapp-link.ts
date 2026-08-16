/**
 * viewer-inapp-link.ts — viewer ツールバー「In-App リンクをコピー」の逆引き（FR-FV-08 / FR-FV-09）
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-15。
 *
 * 共通化の判断（tasks.md TASK-15 注意の「3 箇所目まで書いた段階で共通化の可否を判断」）:
 * **共通化する**。逆引きは 3 系統（notesEditorProvider / outlinerProvider / fileViewerProvider）で
 * 必要になり、いずれも「note フォルダ + 実体パス → tree file id → buildFileLink」という同一手順。
 * 3 実装に散らすと「一部経路にだけ配線」クラス（generator_failures 頻出）を招く + md リンク文字列の
 * ラベルサニタイズ（`[` `]` 除去）が経路ごとにブレる。vscode 非依存（NotesFileManager /
 * flat-layout / inapp-link-utils はいずれも vscode を import しない）なので unit から直接叩ける。
 *
 * 不変条件 8（file link の path 解決は getTreeFilePath のみ）との関係: ここは**逆方向**
 * （実体パス → id）なので path 組み立てをしない。id は listFiles()（= getTreeFilePath 経由で
 * 実在確認済みの登録 item）から得るため、リンクに載る id は必ず note 内の実体を指す。
 */

import * as path from 'path';
import { NotesFileManager } from './notes-file-manager';
import { resolveMdFilesDir } from './flat-layout';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildFileLink } = require('./inapp-link-utils');

/** パス比較の正規化（同一実体を指す表記差を吸収。大文字小文字は OS 差があるため触らない） */
function samePath(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}

/**
 * note フォルダ内の tree file（ext:'file'）実体パスから In-App file link の md リンク文字列を作る。
 *
 * @param folder note フォルダ（mainFolder）の絶対パス
 * @param filePath files/ 配下の実体絶対パス
 * @returns `[title](fractal://note/{folder}/file/{id})` / null（その note の tree file でない）
 */
export function buildInAppFileLinkForFolder(folder: string, filePath: string): string | null {
    let entries;
    try {
        entries = new NotesFileManager(folder).listFiles();
    } catch {
        return null;
    }
    const hit = entries.find((e) => e.kind === 'file' && samePath(e.filePath, filePath));
    if (!hit) { return null; }
    // markdown リンクのラベル終端 `]` を壊さない（designer_failures 2026-07-26 / 2026-08-09）。
    const label = String(hit.title || hit.id).replace(/[[\]]/g, '');
    return '[' + label + '](' + buildFileLink(path.basename(folder), hit.id) + ')';
}

/**
 * 候補 note フォルダ群から実体パスの所属 note を逆引きして md リンク文字列を作る
 * （standalone 面 = document.uri しか無い文脈用）。
 *
 * 手順: 各 folder の `resolveMdFilesDir(folder)`（= files/ 共有置き場）と `dirname(filePath)` を
 * 比較 → 一致 folder で id を逆引き。どの files/ にも属さなければ null（呼び出し側が警告表示）。
 */
export function buildInAppFileLinkFromFolders(folders: string[], filePath: string): string | null {
    const dir = path.dirname(filePath);
    for (const folder of folders || []) {
        if (!folder) { continue; }
        let filesDir: string;
        try {
            filesDir = resolveMdFilesDir(folder);
        } catch {
            continue;
        }
        if (!samePath(filesDir, dir)) { continue; }
        const link = buildInAppFileLinkForFolder(folder, filePath);
        if (link) { return link; }
    }
    return null;
}
