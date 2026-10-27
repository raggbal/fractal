/**
 * md-save-guard — md 保存の直前の版の確認（spec 20261027-1700-mcp-full-ops D3 / AC-6）
 *
 * notesMdMainManager / sidePanelManager の handleSave が共通で使う（同型の経路を 1 か所で直す）。
 * ADRL-0045 の保留照合（watcher → reconcile）は残したまま、その前に保存が来たとき
 * （watcher の取りこぼし・atomic rename・保存窓）に外部の編集を上書きしないための最後の関所。
 *
 * base = 最後に読んだ / 書いた / 取り込んだ中身。disk がそこから変わっていて（自分の書き込みでもなく）、
 * 保存しようとしている内容とも違えば、まだ取り込んでいない外部変更がある。そのときは
 * external-merge の行単位 3-way（衝突は UI の行のあとに外部の行を並べて両方残す）で重ねた内容を保存する。
 */
import { isRecentSelfWrite } from './self-write-registry';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const externalMerge = require('./external-merge');

export interface MdSaveResolution {
    /** 実際に保存する内容 */
    content: string;
    /** 外部の変更を重ねたか（true なら呼び出し側は合成結果を webview へ送る） */
    merged: boolean;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

export function resolveMdSaveAgainstDisk(
    filePath: string,
    base: string | undefined,
    content: string,
    disk: string | null
): MdSaveResolution {
    if (base === undefined || disk === null) return { content, merged: false };
    const d = lf(disk);
    if (d === lf(base) || d === lf(content)) return { content, merged: false };
    if (isRecentSelfWrite(filePath, disk)) return { content, merged: false };
    const r = externalMerge.mergeText(lf(base), lf(content), d) as { text: string; conflicts: number };
    console.log(`[md-save-guard] ${filePath} changed externally before save — merged (AC-6) conflicts=${r.conflicts}`);
    return { content: r.text, merged: r.text !== lf(content) };
}
