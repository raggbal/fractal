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
 * H1-H6 を対象にアンカーIDを生成。CJK文字対応。
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
                .replace(/[^\w\s\u3000-\u9fff\u{20000}-\u{2fa1f}\-]/gu, '')
                .replace(/\s+/g, '-');
            toc.push({ level: match[1].length, text, anchor });
        }
    }
    return toc;
}
