/**
 * Markdown 本文から画像参照の相対パスを抽出する共通ユーティリティ。
 *
 * 実装は src/shared/markdown-link-parser.js (balanced paren 対応) に集約。
 * ここは薄い wrapper (TS 型付け + 単一エントリポイント維持) のみ。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser = require('./markdown-link-parser');

export function extractMarkdownImagePaths(md: string): string[] {
    return parser.extractImagePaths(md);
}
