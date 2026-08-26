/**
 * self-write-registry — 自己書き込み台帳（self-write ledger）
 *
 * FR-LV-06 (sprint 20260825-055613-livereload-selfsave-revert / ADRL-0098 amends ADRL-0045):
 * 外部変更の照合（reconcile）が「自分自身の保存の残響イベント」を外部編集と誤認して
 * document / webview を旧内容へ巻き戻す lost-update の防止。自分が document/disk へ
 * 書いた内容の正規化ハッシュを per-file・直近 16 世代のリングで保持し、reconcile は
 * disk から読んだ内容が台帳にあれば no-op にする（判定は内容照合 — タイミング・フラグで
 * イベントを捨てる旧構図は禁止 = エッジトリガ消失を再導入しない）。
 *
 * vscode / fs 非依存の pure モジュール（unit は stub 不要で直 require）。
 * 消費側: notesMdMainManager / sidePanelManager / editorProvider / outlinerProvider。
 */
import * as path from 'path';
import * as crypto from 'crypto';

/** per-file の保持世代数（固定値 — NFR-SWR-02。設定での変更手段は設けない） */
const MAX_GENERATIONS = 16;

/** canonicalPath → sha1 hex のリング（末尾が最新） */
const ledger = new Map<string, string[]>();

function keyOf(filePath: string): string {
    return path.resolve(filePath);
}

/** CRLF→LF 正規化後の sha1（editorProvider は CRLF 文書で \r\n 化した内容を書くため表記差を吸収） */
function hashOf(content: string): string {
    return crypto.createHash('sha1').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

/** 自分が document/disk へ書く内容を記録する（冪等 — 同一内容の再記録はリングを消費しない） */
export function recordSelfWrite(filePath: string, content: string): void {
    const key = keyOf(filePath);
    const hash = hashOf(content);
    let ring = ledger.get(key);
    if (!ring) {
        ring = [];
        ledger.set(key, ring);
    }
    const existing = ring.indexOf(hash);
    if (existing !== -1) {
        ring.splice(existing, 1); // 最新位置へ移動（重複で世代を消費しない）
    }
    ring.push(hash);
    if (ring.length > MAX_GENERATIONS) {
        ring.splice(0, ring.length - MAX_GENERATIONS); // 最古を破棄
    }
}

/** disk から読んだ内容が「直近の自己書き込み」か（true なら reconcile は no-op にする） */
export function isRecentSelfWrite(filePath: string, content: string): boolean {
    const ring = ledger.get(keyOf(filePath));
    if (!ring || ring.length === 0) { return false; }
    return ring.indexOf(hashOf(content)) !== -1;
}

/** watch 解除・panel dispose 契機で呼ぶ（メモリ解放） */
export function clearSelfWrites(filePath: string): void {
    ledger.delete(keyOf(filePath));
}
