/**
 * TOC (Table of Contents) Extraction Utilities
 *
 * Pure functions for extracting headings from Markdown text.
 * Separated from SidePanelManager to enable unit testing without vscode dependency.
 */

export interface TocItem {
    level: number;
    text: string;
    anchor: string;
}

/**
 * Markdown テキストから目次を抽出する (pure function)。
 * H1-H6 を対象にアンカーIDを生成。
 * FR-MLG-01 (sprint 20260818-183407): 文字クラスを Unicode property ベースに拡張
 * （ハングル・アクセント Latin・半角カナ・全角英数を保持）。旧クラス
 * [^\w\s　-鿿\u{20000}-\u{2fa1f}\-] の保持域は新クラスの部分集合 = 既存アンカー byte 互換。
 * ミラー: outliner.js / editor.js の TOC 生成 + editor.js scrollToAnchor slug（4 サイト対称 — 片側更新禁止）。
 */
export function extractToc(markdown: string): TocItem[] {
    const lines = markdown.split('\n');
    const toc: TocItem[] = [];
    let inCodeBlock = false;
    for (const line of lines) {
        if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
        if (inCodeBlock) continue;
        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (match) {
            const text = match[2].trim();
            const anchor = text.toLowerCase()
                .replace(/[^\p{L}\p{N}_\s\-]/gu, '')
                .replace(/\s+/g, '-');
            toc.push({ level: match[1].length, text, anchor });
        }
    }
    return toc;
}
