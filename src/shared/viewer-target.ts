/**
 * viewer-target.ts — file viewer の対象判定（唯一の判定点）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-01 / ADRL-0066 決定 4。
 * 全 open sink（vscode.env.openExternal を呼ぶ経路）はこの関数で viewer 対象を判定する —
 * 拡張子リストをインライン複製しない（「N 経路の一部にだけ配線」クラスの構造的防止）。
 *
 * スコープ外の明示（受容事項 4）: .svg（script 実行可能で html と同類の脅威）/
 * .mhtml / .xhtml / .md（既存 md editor の領分）は null。
 */

export type ViewerKind = 'html' | 'pdf';

/** 50MB 超は viewer を開かず OS 既定アプリへフォールバック（FR-FV-07 — FR-TF-01/FR-DS-07(d) と同閾値） */
export const VIEWER_SIZE_LIMIT = 50 * 1024 * 1024;

/**
 * @param filename ファイル名またはパス（basename の拡張子で判定・case-insensitive）
 * @returns 'html' | 'pdf' | null（null = viewer 対象外 → 従来どおり openExternal）
 */
export function isViewerTarget(filename: string): ViewerKind | null {
    const name = String(filename || '');
    const dot = name.lastIndexOf('.');
    if (dot < 0) { return null; }
    const ext = name.slice(dot).toLowerCase();
    if (ext === '.html' || ext === '.htm') { return 'html'; }
    if (ext === '.pdf') { return 'pdf'; }
    return null;
}
