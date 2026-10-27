/**
 * history-store — note の「最近開いたファイル履歴」の純粋ロジック（FR-HP-02/03）。
 *
 * vscode / fs 非依存。NoteStructure.history に対する push（開いた順に積む + 件数トリム）を担う。
 * 副作用（outline.note 保存）は NotesFileManager が持ち、本モジュールは配列操作のみ = test/unit で単体検証。
 */

// ★reopen 2026-07-23: page-md kind を廃止（page md も note-md・絶対パスで記録し全メインペイン openFile に統一）。
// 旧 page-md entry（legacy データ）は後方互換で読めるが型からは除外（描画は icon フォールバック、click は openFile で silent no-op）。
// FR-RCT（sprint 20260822-051129）: folder = folder link（id = folderLinkId — 絶対パスを webview に出さない
// ADRL-0071 規約）/ file = viewer 対象・外部起動 file（id = 絶対パス）。
export type HistoryKind = 'note-md' | 'out' | 'folder' | 'file';

/**
 * spec 20261027-1142-recent-history-nav D2: 開いた場所。main = メインペイン（md / out / folder view / note 面 viewer /
 * kind='file' タブ）、side = sidepanel（md sidepanel / viewer sidepanel）。Back / Forward はこの場所で開き直す。
 * 旧 entry（pane 無し）は main とみなす（historyPaneOf）。ADRL-0001 の origin 判定とは別物（使わない）。
 */
export type HistoryPane = 'main' | 'side';

export interface HistoryEntry {
    kind: HistoryKind;
    /** note-md/out/file: filePath（絶対）。folder: folderLinkId。 */
    id: string;
    title: string;
    /** open 時刻（host が Date.now() で付与）。 */
    ts: number;
    /** D2: 開いた場所（無い旧 entry は main）。 */
    pane?: HistoryPane;
    /**
     * D5: 開けない（消えたファイル / folder link）。webview 送出時に host が付ける派生値で、outline.note には保存しない
     * （NotesFileManager.getHistoryWithFreshTitles）。Back / Forward はこの entry を飛ばす。
     */
    missing?: boolean;
}

/** D1: 上限 50（却下: 20 — 同じものも積むので戻れる範囲が短くなる）。 */
export const HISTORY_MAX = 50;

/** D2: entry の pane（無い旧 entry・不正値は main）。 */
export function historyPaneOf(entry: { pane?: unknown } | null | undefined): HistoryPane {
    return entry && entry.pane === 'side' ? 'side' : 'main';
}

/**
 * history 配列に entry を push する（最新が先頭）。
 * - spec 20261027-1142-recent-history-nav D1（FR-HP-02 の重複先頭移動を supersede）: 開いた順の記録。
 *   同じものでも積む（a→b→a は a>b>a）。直前（先頭）と同じ (kind,id) のときだけ 1 件にまとめる
 *   （先頭を新しい entry で置き換える = ts / pane / title は最新）。
 * - max 件でトリム（超過分の末尾＝最古を落とす）。
 * - 入力配列は変更せず新配列を返す（純粋）。
 */
export function pushHistoryEntry(
    list: HistoryEntry[] | undefined,
    entry: HistoryEntry,
    max: number = HISTORY_MAX,
): HistoryEntry[] {
    const base = Array.isArray(list) ? list : [];
    const top = base[0];
    // 直前と同じものだけまとめる（先頭を置き換え）。それ以外は先頭に積む
    const rest = (top && top.kind === entry.kind && top.id === entry.id) ? base.slice(1) : base;
    const next = [entry, ...rest];
    // max でトリム（先頭＝最新を残し、末尾＝最古を落とす）
    return next.length > max ? next.slice(0, max) : next;
}
