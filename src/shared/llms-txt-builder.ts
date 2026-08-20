/**
 * llms.txt-style markdown builder for outliner subtree copy feature.
 *
 * - 右クリックしたノードを root (H1) とし、再帰的に subtree を辿る
 * - 子ありノード: 見出し (深さに応じて H1〜H6, それを超えたら H6 据え置き)
 * - 添付 (mode に応じて pageId / filePath / 両方) を持つノードは bullet `[text](abs)` を出す
 *   - mode='md':   pageId のみ
 *   - mode='file': filePath のみ (pageId は完全無視)
 *   - mode='both': pageId と filePath の両方 (両方持つノードは 2 本 bullet)
 * - 添付なし & 子なし leaf: スキップ
 * - 添付・子孫のいずれにも contributing 要素を含まない subtree: 丸ごとスキップ
 */

export interface LlmsTxtTreeNode {
    id: string;
    text: string;
    pageId?: string | null;
    filePath?: string | null;
    children: LlmsTxtTreeNode[];
}

export type LlmsTxtMode = 'md' | 'file' | 'both';

export interface LlmsTxtResolvers {
    /** pageId → 絶対パス。存在しない / 解決失敗時は null */
    resolveMdPath(pageId: string): string | null;
    /** filePath (`.out` 相対) → 絶対パス。存在しない / unsafe 時は null */
    resolveFilePath(relPath: string): string | null;
}

interface PreparedNode {
    text: string;
    absPaths: string[];
    children: PreparedNode[];
    contributes: boolean;
}

function cleanText(raw: string): string {
    const stripped = (raw || '')
        .replace(/\s*[#@]\S+/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped || 'Untitled';
}

function prepare(node: LlmsTxtTreeNode, mode: LlmsTxtMode, resolvers: LlmsTxtResolvers): PreparedNode {
    const absPaths: string[] = [];
    const wantMd = mode === 'md' || mode === 'both';
    const wantFile = mode === 'file' || mode === 'both';
    if (wantMd && node.pageId) {
        const p = resolvers.resolveMdPath(node.pageId);
        if (p) absPaths.push(p);
    }
    if (wantFile && node.filePath) {
        const p = resolvers.resolveFilePath(node.filePath);
        if (p) absPaths.push(p);
    }
    const children = (node.children || []).map(c => prepare(c, mode, resolvers));
    const hasAttachment = absPaths.length > 0;
    const hasContributingDescendant = children.some(c => c.contributes);
    return {
        text: cleanText(node.text),
        absPaths,
        children,
        contributes: hasAttachment || hasContributingDescendant,
    };
}

function emit(node: PreparedNode, depth: number, lines: string[]): void {
    if (!node.contributes) return;

    const hasContributingChildren = node.children.some(c => c.contributes);
    const isRoot = depth === 1;

    // root 以外で contributing 子なし → bullet のみ (添付パスごとに 1 行)
    if (!isRoot && !hasContributingChildren) {
        for (const p of node.absPaths) {
            lines.push(`- [${node.text}](${p})`);
        }
        return;
    }

    // heading 行 (root は H1、それ以外は depth に応じて H1〜H6)
    // 注: node.text は prepare() の cleanText 済み（\s+ → ' ' で改行も空白化済み = FR-SE-03）
    const level = Math.min(Math.max(depth, 1), 6);
    lines.push(`${'#'.repeat(level)} ${node.text}`);
    lines.push('');

    // 自己 attachment があれば bullet 行 (添付パスごとに 1 行)
    if (node.absPaths.length > 0) {
        for (const p of node.absPaths) {
            lines.push(`- [${node.text}](${p})`);
        }
        lines.push('');
    }

    let bulletGroup = false;
    for (const c of node.children) {
        if (!c.contributes) continue;
        const isChildLeafLike = !c.children.some(cc => cc.contributes);
        if (isChildLeafLike) {
            emit(c, depth + 1, lines);
            bulletGroup = true;
        } else {
            if (bulletGroup) {
                lines.push('');
                bulletGroup = false;
            }
            emit(c, depth + 1, lines);
        }
    }
    if (bulletGroup) {
        lines.push('');
    }
}

/**
 * FR-OCM-02 (sprint 20260818-183407 / ADRL-0077): forest（複数 root）対応。
 * 各 root を H1 として連結し root 間は空行 1 つ。単一 root（旧形式 = 非配列）は
 * 要素 1 の forest と同一経路で、出力は従来と byte 一致（後方互換）。
 * 祖先包含重複排除（選択集合内の子孫 root 除外）は webview 側 buildLlmsTxtForest の責務。
 */
export function buildLlmsTxt(root: LlmsTxtTreeNode | LlmsTxtTreeNode[], mode: LlmsTxtMode, resolvers: LlmsTxtResolvers): string {
    const roots = Array.isArray(root) ? root : [root];
    const parts: string[] = [];
    for (const r of roots) {
        if (!r) continue;
        const prepared = prepare(r, mode, resolvers);
        if (!prepared.contributes) continue;
        const lines: string[] = [];
        emit(prepared, 1, lines);
        while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }
        parts.push(lines.join('\n'));
    }
    if (parts.length === 0) return '';
    return parts.join('\n\n') + '\n';
}
