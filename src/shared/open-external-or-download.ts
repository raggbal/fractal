/**
 * open-external-or-download — 非 viewer ファイルの「開く」正典（TASK-14 — sprint 20260822-051129）。
 *
 * desktop: vscode.env.openExternal（OS 既定アプリ）。
 * remote（vscode server / Remote-SSH — vscode.env.remoteName あり）: openExternal(file://server-path) は
 * クライアント側で開けず**無反応**になる（ユーザー実測 2026-08-23）→ webview 経由の
 * ブラウザダウンロード（<a download> click）にフォールバックする。
 * 依存注入 seam（vscode 非依存 — unit から behavioral 検証）。
 */
import * as path from 'path';

export interface OpenExternalDeps {
    isRemote: boolean;
    openExternal(absPath: string): Promise<void> | void;
    toWebviewUri(absPath: string): string;
    postMessage(msg: unknown): void;
    /** webview の localResourceRoots へ dir を許可（fv 等 note 外パス用 — 任意） */
    ensureResourceRoot?(dirAbs: string): void;
}

export async function openFileExternalOrDownload(deps: OpenExternalDeps, absPath: string): Promise<void> {
    if (!deps.isRemote) {
        await deps.openExternal(absPath);
        return;
    }
    try { deps.ensureResourceRoot?.(path.dirname(absPath)); } catch { /* 縮退 */ }
    deps.postMessage({
        type: 'triggerFileDownload',
        fileUri: deps.toWebviewUri(absPath),
        fileName: path.basename(absPath),
    });
}
