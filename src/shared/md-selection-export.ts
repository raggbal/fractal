/**
 * md-selection-export — md エディタで範囲選択した md / subpage / file リンクの Export（vscode 非依存の core）。
 *
 * outliner の 2 つの Export と同じ意味:
 *   - Export bundle: 選択範囲そのものを 1 本の md（`<md名>-selection.md`）にし、リンク先 md と画像・添付を
 *     1 フォルダに集めてリンクを書き換える（md-export-core.exportBundle をそのまま使う）。
 *   - Export folder: 選択した箇条書きの入れ子をディレクトリ木にし、リンク先の実体（md + その画像・添付 /
 *     添付ファイル）をリンク名で書き出す（folder-export.runFolderExport をそのまま使う）。
 * リンク先の解決は呼び出し側の provider が clamp 付きで渡す（Copy Path と同じ resolver）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ExportNode } from './folder-export';
import { handlePageAssets } from './paste-asset-handler';

// markdown-link-parser は UMD（require で取得。md-export-core と同じ）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkParser = require('./markdown-link-parser');

export interface MdLinkResolvers {
    /** md / subpage リンク → 絶対パス（clamp 外は null） */
    resolveMd(url: string): string | null;
    /** 添付リンク → 絶対パス（clamp 外は null） */
    resolveFile(url: string): string | null;
}

export interface MdSelectionExportTree {
    tree: ExportNode[];
    /** ExportNode.pageId（key）→ リンク先 md の絶対パス */
    mdByKey: Map<string, string>;
    /** 出力対象のリンク数（0 なら何も書き出さない） */
    linkCount: number;
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

interface LinkTok { kind: string; alt: string; url: string; isSubpage?: boolean }

/** 表示名: 先頭の 📎 / 拡張子別アイコンと空白を落とす（file リンクの label は `📎 report.pdf` 形式） */
function cleanLabel(alt: string): string {
    return String(alt || '').replace(/^[^\p{L}\p{N}_.([{-]+\s*/u, '').trim() || String(alt || '').trim();
}

/**
 * 選択範囲の md から Export folder の node 木を作る。
 * - 箇条書きの字下げが入れ子（子を持つ node はフォルダになる。outliner の Export folder と同じ）
 * - 1 行に複数リンクがあれば兄弟の node。字下げの子は先頭のリンクにぶら下げる
 * - リンクの無い行は、配下にリンクがあるときだけフォルダとして残す
 * - 外部 URL・アンカー・画像・解決できない（clamp 外 / 実体なし）リンクは対象外
 */
export function buildMdSelectionExportTree(markdown: string, r: MdLinkResolvers): MdSelectionExportTree {
    const mdByKey = new Map<string, string>();
    let linkCount = 0;
    const roots: ExportNode[] = [];
    const stack: { indent: number; node: ExportNode }[] = [];

    for (const raw of String(markdown || '').split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const m = LIST_ITEM.exec(raw);
        const indent = m ? m[1].replace(/\t/g, '    ').length : 0;
        const content = m ? m[2] : raw.trim();

        const nodes: ExportNode[] = [];
        const toks = linkParser.parseMarkdownLinks(content) as LinkTok[];
        for (const t of toks) {
            if (t.kind !== 'link' || !t.url || EXTERNAL_URL.test(t.url)) continue;
            const bare = t.url.split(/[?#]/)[0];
            if (/\.md$/i.test(bare)) {
                const abs = r.resolveMd(t.url);
                if (!abs || !fs.existsSync(abs)) continue;
                const key = String(mdByKey.size);
                mdByKey.set(key, abs);
                nodes.push({ text: cleanLabel(t.alt) || path.basename(abs, '.md'), pageId: key, children: [] });
            } else {
                const abs = r.resolveFile(t.url);
                if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
                nodes.push({ text: cleanLabel(t.alt) || path.basename(abs), filePath: abs, children: [] });
            }
            linkCount++;
        }
        // リンクの無い行は「フォルダ候補」（最後に配下のリンクが無ければ刈る）
        if (nodes.length === 0) {
            const text = content.replace(/[*_`~#>]/g, '').trim();
            if (!text) continue;
            nodes.push({ text, children: [] });
        }

        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
        const siblings = stack.length > 0 ? (stack[stack.length - 1].node.children as ExportNode[]) : roots;
        siblings.push(...nodes);
        // 一覧でない行（段落）は入れ子の親にしない
        if (m) stack.push({ indent, node: nodes[0] });
    }

    const prune = (list: ExportNode[]): ExportNode[] => list
        .map((n) => ({ ...n, children: prune(n.children || []) }))
        .filter((n) => !!n.pageId || !!n.filePath || (n.children as ExportNode[]).length > 0);
    return { tree: prune(roots), mdByKey, linkCount };
}

/**
 * runFolderExport の exportMd に差す adapter。pageId は mdByKey の key で、リンク先 md を
 * そのディレクトリを pages dir として handlePageAssets（正典）で複製する（画像・添付も一緒に）。
 */
export function makeMdSelectionExportMd(mdByKey: Map<string, string>): typeof handlePageAssets {
    return (opts) => {
        const abs = mdByKey.get(String(opts.pageId));
        if (!abs) return { newNodeImages: [] };
        const dir = path.dirname(abs);
        return handlePageAssets({
            ...opts,
            srcOutDir: dir,
            srcPagesDir: dir,
            pageId: path.basename(abs, path.extname(abs)),
        });
    };
}

/** Export bundle の仮 root（選択範囲の md を置く場所。元の md と同じ dir — 相対リンクの基準を揃える） */
export function selectionBundleRootPath(mdFilePath: string): string {
    const stem = path.basename(mdFilePath).replace(/\.md$/i, '') || 'selection';
    return path.join(path.dirname(mdFilePath), `${stem}-selection.md`);
}
