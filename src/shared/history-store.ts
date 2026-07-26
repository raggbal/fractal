/**
 * history-store — note の「最近開いたファイル履歴」の純粋ロジック（FR-HP-02/03）。
 *
 * vscode / fs 非依存。NoteStructure.history に対する push（重複先頭移動 + 件数トリム）を担う。
 * 副作用（outline.note 保存）は NotesFileManager が持ち、本モジュールは配列操作のみ = test/unit で単体検証。
 */

// ★reopen 2026-07-23: page-md kind を廃止（page md も note-md・絶対パスで記録し全メインペイン openFile に統一）。
// 旧 page-md entry（legacy データ）は後方互換で読めるが型からは除外（描画は icon フォールバック、click は openFile で silent no-op）。
export type HistoryKind = 'note-md' | 'out';

export interface HistoryEntry {
    kind: HistoryKind;
    /** note-md/out: filePath（絶対）。page md も note-md・絶対パスで記録する（pageId は使わない）。 */
    id: string;
    title: string;
    /** open 時刻（host が Date.now() で付与）。 */
    ts: number;
}

export const HISTORY_MAX = 20;

/**
 * history 配列に entry を push する（最新が先頭）。
 * - 同一 (kind,id) の既存 entry は除去してから先頭に unshift（重複追加せず先頭に移動）。
 * - max 件でトリム（超過分の末尾＝最古を落とす）。
 * - 入力配列は変更せず新配列を返す（純粋）。
 */
export function pushHistoryEntry(
    list: HistoryEntry[] | undefined,
    entry: HistoryEntry,
    max: number = HISTORY_MAX,
): HistoryEntry[] {
    const base = Array.isArray(list) ? list : [];
    // 同一 (kind,id) を除去
    const filtered = base.filter((e) => !(e.kind === entry.kind && e.id === entry.id));
    // 先頭に追加
    const next = [entry, ...filtered];
    // max でトリム（先頭＝最新を残し、末尾＝最古を落とす）
    return next.length > max ? next.slice(0, max) : next;
}
