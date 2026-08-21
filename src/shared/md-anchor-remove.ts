/**
 * removeMdAnchorFromFile — 元 md からアンカーを fs 直接除去する pure ヘルパー。
 * (sprint 20260812-110538 再オープン①(2))
 *
 * 従来の webview エコー(removeFileLink/removeSubpageLink)は該当 md の EditorInstance が
 * 生存している時しか効かず、mindmap 表示中(main タブが .out)や未表示 md ではリンクが
 * 残った。fs が単一真実 — 開いている editor には従来エコー + FR-LV watcher でも反映される。
 *
 * vscode 非依存(fs のみ)— unit spec から直接 require 可能(flat-pathbuilder precedent)。
 */
import * as fs from 'fs';

/**
 * removeMdAnchorAndEcho — 移動系「source 除去」の 2 段（fs 正典 + webview エコー）を 1 関数に集約。
 * (sprint 20260819-210558 TASK-03)
 *
 * 旧: removeMdAnchorFromFile 直呼び + 隣接 postMessage の裸ペアが 7 サイトに分散し、
 * 片割れ漏れ（fs 除去なしのエコーのみ等）が経路追加のたびに再発した（2026-08-14 に 3 経路・
 * 2026-08-19 に 4 匹目を実測）。以後、md アンカーの source 除去は必ず本関数を通す
 * （TC-SRC-07 の grep 番人が裸ペア残存を検出する）。
 * @param kind 'subpage' → removeSubpageLink エコー / 'file' → removeFileLink エコー
 */
export function removeMdAnchorAndEcho(
    sourceMdPath: string,
    href: string,
    sender: { postMessage(msg: unknown): void },
    kind: 'subpage' | 'file'
): void {
    removeMdAnchorFromFile(sourceMdPath, href);
    sender.postMessage({
        type: kind === 'subpage' ? 'removeSubpageLink' : 'removeFileLink',
        href,
        sourceMdPath,
    });
}

export function removeMdAnchorFromFile(sourceMdPath: string, href: string): void {
    try {
        if (!sourceMdPath || !href || !fs.existsSync(sourceMdPath)) { return; }
        const content = fs.readFileSync(sourceMdPath, 'utf8');
        const esc = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // [[label]](href)(subpage)→ [label](href) の順で最初の 1 個だけ除去
        const reSub = new RegExp('\\[\\[[^\\]]*\\]\\]\\(' + esc + '\\)');
        const reLink = new RegExp('\\[[^\\]]*\\]\\(' + esc + '\\)');
        let next = content;
        if (reSub.test(next)) { next = next.replace(reSub, ''); }
        else if (reLink.test(next)) { next = next.replace(reLink, ''); }
        else { return; }
        fs.writeFileSync(sourceMdPath, next, 'utf8');
    } catch (e) {
        console.error('[Notes] removeMdAnchorFromFile error:', e);
    }
}
