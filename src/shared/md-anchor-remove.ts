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
