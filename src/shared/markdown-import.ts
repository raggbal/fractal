/**
 * markdown-import.ts — .md ファイルのインポート処理（共通ロジック）
 *
 * outlinerProvider.ts / notes-message-handler.ts から呼ばれる。
 * webview側（editor-utils.js の normalizeMultiLineTableCells）と同等の変換ロジックを
 * Node.js 環境で実行するためのモジュール。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface ImportedMdFile {
    title: string;
    content: string;
    pageId: string;
}

export interface ImportMdOptions {
    /** H1 の代わりに使用するタイトル。指定時は H1 抽出をスキップする */
    title?: string;
    /** true の場合、相対画像パスの解決をスキップする（D&D 用） */
    skipRelativeImages?: boolean;
    /**
     * 📎 file リンクの複製先（note の `files/`）。
     *
     * **指定すると随伴転送の正典 `copyMdPasteAssets` に切り替わる**（FR-OIF-06 / sprint 20260901-075849）:
     * 画像だけでなく **📎 file リンクと subpage md リンクも複製 + リンク書換**され、
     * `restrictSourceRoots` による containment が効く。
     *
     * 未指定 = 従来の `processImages`（画像のみ・containment なし）で **byte 不変**。
     * 既存呼び出し面（drop-import）の挙動を変えないための opt-in。
     */
    fileDir?: string;
    /**
     * 資産の読取を許す root 集合（NFR-DCP-01）。`fileDir` 指定時のみ効く。
     * md 本文はディスク上の**非信頼入力**なので、絶対パス・境界外 `../` の参照は複製しない
     * （リンクは原文のまま温存）。
     */
    restrictSourceRoots?: string[];
}

export interface ImportMdItem {
    name: string;       // Original filename
    content: string;    // Markdown content
    sourceDir: string;  // Directory for resolving relative image paths (empty string to skip)
}

// ────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────

/**
 * .md ファイルをインポートし、ページファイルとして保存する。
 *
 * @param sourcePath  元の .md ファイルのフルパス
 * @param pageDir     ページファイルの保存先ディレクトリ
 * @param imageDir    画像ファイルのコピー先ディレクトリ
 * @param options     オプション（タイトル指定など）
 * @returns インポート結果（タイトル、変換後コンテンツ、pageId）
 */
export function importMdFile(
    sourcePath: string,
    pageDir: string,
    imageDir: string,
    options?: ImportMdOptions
): ImportedMdFile | null {
    // ファイル読み込み
    let rawContent: string;
    try {
        rawContent = fs.readFileSync(sourcePath, 'utf-8');
    } catch {
        return null;
    }

    // タイトル: オプション指定があればそれを使用、なければ H1 抽出
    const title = options?.title ?? extractH1Title(rawContent);

    // プレーンテキスト正規化
    let content = normalizeMarkdownPlainText(rawContent);

    // 画像処理
    const sourceDir = path.dirname(sourcePath);
    content = processImages(content, sourceDir, imageDir, pageDir);

    // pageId 生成
    const pageId = crypto.randomUUID();

    // ディレクトリ作成
    if (!fs.existsSync(pageDir)) {
        fs.mkdirSync(pageDir, { recursive: true });
    }

    // ページファイル保存
    const pagePath = path.join(pageDir, `${pageId}.md`);
    fs.writeFileSync(pagePath, content, 'utf-8');

    return { title, content, pageId };
}

/**
 * 複数の .md ファイルをインポートする。
 * Thin wrapper over importMdFilesCore for file path based input.
 */
export function importMdFiles(
    filePaths: string[],
    pageDir: string,
    imageDir: string,
    options?: ImportMdOptions
): ImportedMdFile[] {
    const results: ImportedMdFile[] = [];
    for (const fp of filePaths) {
        const result = importMdFile(fp, pageDir, imageDir, options);
        if (result) {
            results.push(result);
        }
    }
    return results;
}

/**
 * Import markdown files from content arrays (D&D support).
 * Core implementation for buffer-based imports.
 *
 * @param items    Array of {name, content, sourceDir} items
 * @param pageDir  Directory for page files
 * @param imageDir Directory for image files
 * @param options  Import options (skipRelativeImages for D&D)
 * @returns Array of ImportedMdFile results
 */
export function importMdFilesCore(
    items: ImportMdItem[],
    pageDir: string,
    imageDir: string,
    options?: ImportMdOptions
): ImportedMdFile[] {
    const results: ImportedMdFile[] = [];

    // Ensure pageDir exists
    if (!fs.existsSync(pageDir)) {
        fs.mkdirSync(pageDir, { recursive: true });
    }

    for (const item of items) {
        // Title: use option if provided, otherwise extract H1, finally use filename without extension
        const h1Title = extractH1Title(item.content);
        const title = options?.title ?? (h1Title !== 'Untitled' ? h1Title : stripExtension(item.name));

        // Normalize markdown
        let content = normalizeMarkdownPlainText(item.content);

        // 資産の随伴。fileDir 指定時は随伴転送の正典へ、未指定時は従来の画像のみ処理へ。
        if (item.sourceDir && !options?.skipRelativeImages) {
            if (options?.fileDir) {
                // FR-OIF-06: 画像 / 📎 file / subpage md をまとめて複製 + リンク書換 + containment。
                // 旧 processImages は kind==='image' だけを処理し 📎/subpage を素通ししていたため、
                // md が pages/<uuid>.md に置かれると本文が元フォルダ基準を指してリンク切れになっていた。
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const pah = require('./paste-asset-handler');
                const res = pah.copyMdPasteAssets({
                    markdown: content,
                    sourceMdDir: item.sourceDir,
                    sourceImageDir: item.sourceDir,
                    sourceFileDir: item.sourceDir,
                    destImageDir: imageDir,
                    destFileDir: options.fileDir,
                    destMdDir: pageDir,
                    restrictSourceRoots: options.restrictSourceRoots,
                    // 起点 md の実パス: subpage の戻りリンク（循環）で起点自身を再複製しない（ADRL-0110 / TC-OIF-21）
                    sourceMdAbs: path.join(item.sourceDir, item.name),
                });
                content = res.rewrittenMarkdown;
            } else {
                content = processImages(content, item.sourceDir, imageDir, pageDir);
            }
        }
        // If skipRelativeImages is true or sourceDir is empty, leave relative paths as-is

        // Generate pageId
        const pageId = crypto.randomUUID();

        // Save page file
        const pagePath = path.join(pageDir, `${pageId}.md`);
        fs.writeFileSync(pagePath, content, 'utf-8');

        results.push({ title, content, pageId });
    }

    return results;
}

/**
 * Strip extension from filename.
 */
function stripExtension(filename: string): string {
    const ext = path.extname(filename);
    return ext ? filename.slice(0, -ext.length) : filename;
}

// ────────────────────────────────────────────
// Markdown normalization (plain text)
// ────────────────────────────────────────────

/**
 * プレーンテキスト Markdown の正規化処理。
 * editor-utils.js の normalizeMultiLineTableCells() と同等ロジック。
 */
export function normalizeMarkdownPlainText(text: string): string {
    return normalizeMultiLineTableCells(text);
}

/**
 * リッチテキスト（HTML）の Markdown 変換処理。
 * 将来の HTML D&D 対応用スタブ。
 * Turndown + エスケープ除去 + リスト空行除去を実装予定。
 */
export function normalizeMarkdownFromHtml(_html: string): string {
    // TODO: 将来実装
    return _html;
}

// ────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────

/**
 * Markdown テキストから最初の H1 テキストを抽出する。
 * H1 がなければ "Untitled" を返す。
 */
function extractH1Title(markdown: string): string {
    const match = markdown.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : 'Untitled';
}

/**
 * セル内改行テーブルの正規化。
 * editor-utils.js の normalizeMultiLineTableCells と同等ロジック。
 */
function normalizeMultiLineTableCells(text: string): string {
    // Step 1: 平坦化解除 — | <br> | → |\n|
    text = text.replace(/\|\s*<br>\s*(?=\|)/gi, '|\n');

    // Step 2: 孤立セパレータ行除去
    const lines = text.split('\n');
    let result: string[] = [];
    let separatorSeen = false;
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const isTableRow = trimmed.charAt(0) === '|' && trimmed.charAt(trimmed.length - 1) === '|' && trimmed.length > 2;

        if (isTableRow) {
            // セパレータ行か判定
            let isSep = false;
            const inner = trimmed.slice(1, -1);
            const cells = inner.split('|');
            if (cells.length > 0) {
                isSep = true;
                for (const cell of cells) {
                    if (!/^\s*:?-+:?\s*$/.test(cell)) {
                        isSep = false;
                        break;
                    }
                }
            }

            if (isSep) {
                if (separatorSeen && inTable) {
                    continue; // 重複セパレータをスキップ
                }
                separatorSeen = true;
            }
            inTable = true;
        } else {
            inTable = false;
            separatorSeen = false;
        }

        result.push(lines[i]);
    }

    // Step 3: 折れた行結合
    const lines2 = result;
    result = [];
    let i2 = 0;

    while (i2 < lines2.length) {
        const trimmed2 = lines2[i2].trimEnd();

        if (trimmed2.length > 1 && trimmed2.charAt(0) === '|' && trimmed2.charAt(trimmed2.length - 1) !== '|') {
            let combined = trimmed2;
            let j = i2 + 1;
            let found = false;
            const maxJoin = 50;

            while (j < lines2.length && (j - i2) <= maxJoin) {
                const nextTrimmed = lines2[j].trimEnd();

                if (nextTrimmed === '') {
                    combined += '<br>';
                    j++;
                    continue;
                }

                combined += '<br>' + nextTrimmed;
                j++;

                if (nextTrimmed.charAt(nextTrimmed.length - 1) === '|') {
                    found = true;
                    break;
                }
            }

            if (found) {
                combined = combined.replace(/(<br>)+/g, '<br>');
                result.push(combined);
                i2 = j;
            } else {
                result.push(lines2[i2]);
                i2++;
            }
        } else {
            result.push(lines2[i2]);
            i2++;
        }
    }

    return result.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mdLinkParser = require('./markdown-link-parser');

/**
 * Markdown 内の画像参照を解析し、画像ファイルをコピーしてパスを書き換える。
 * balanced paren 対応 (画像ファイル名に () が含まれても正しく parse される)。
 */
function processImages(
    mdContent: string,
    sourceDir: string,
    imageDir: string,
    pageDir: string
): string {
    interface ParsedLink { kind: 'image' | 'link'; alt: string; url: string; start: number; end: number; }
    const links: ParsedLink[] = mdLinkParser.parseMarkdownLinks(mdContent);
    if (links.length === 0) return mdContent;

    // end 降順に処理すれば index ズレが発生しない
    const images = links.filter(l => l.kind === 'image').sort((a, b) => b.end - a.end);
    let result = mdContent;
    for (const img of images) {
        const alt = img.alt;
        const imgPath = img.url;
        let replacement = `![${alt}](${imgPath})`;

        // URL はスキップ
        if (!(imgPath.startsWith('http://') || imgPath.startsWith('https://'))) {
            const cleanPath = imgPath.split(/[?#]/)[0];
            let decodedPath: string;
            try {
                decodedPath = decodeURIComponent(cleanPath);
            } catch {
                decodedPath = cleanPath;
            }
            const absoluteImgPath = path.resolve(sourceDir, decodedPath);
            if (fs.existsSync(absoluteImgPath)) {
                if (!fs.existsSync(imageDir)) {
                    fs.mkdirSync(imageDir, { recursive: true });
                }
                const ext = path.extname(absoluteImgPath).toLowerCase().replace('jpeg', 'jpg') || '.png';
                const newFileName = `image_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
                const destPath = path.join(imageDir, newFileName);
                fs.copyFileSync(absoluteImgPath, destPath);
                const relativePath = path.relative(pageDir, destPath).replace(/\\/g, '/');
                replacement = `![${alt}](${relativePath})`;
            }
        }

        result = result.slice(0, img.start) + replacement + result.slice(img.end);
    }
    return result;
}
