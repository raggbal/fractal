/**
 * Markdown 本文から画像参照の相対パスを抽出する共通ユーティリティ。
 * - `![alt](path)` Markdown 記法
 * - `<img src="path">` HTML タグ
 * http(s):/ data:/ file: および絶対パスは除外（ローカル相対のみ対象）。
 * クエリ/フラグメントは除去する。
 */

const MD_IMG_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /<img\s+[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi;

export function extractMarkdownImagePaths(md: string): string[] {
    const results = new Set<string>();
    const push = (p: string): void => {
        if (!p) return;
        const trimmed = p.trim().replace(/^<|>$/g, '');
        if (!trimmed) return;
        if (/^(https?:|data:|file:)/i.test(trimmed)) return;
        if (trimmed.startsWith('/')) return;
        const cleaned = trimmed.split(/[?#]/)[0];
        if (cleaned) results.add(cleaned);
    };
    let m: RegExpExecArray | null;
    MD_IMG_RE.lastIndex = 0;
    while ((m = MD_IMG_RE.exec(md)) !== null) push(m[1]);
    HTML_IMG_RE.lastIndex = 0;
    while ((m = HTML_IMG_RE.exec(md)) !== null) push(m[1]);
    return Array.from(results);
}
