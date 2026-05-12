/**
 * data-url-image-extractor — `data:image/...` URL を実体ファイル化する共有ヘルパー。
 *
 * 対応 MIME (image/png, image/jpeg, image/gif, image/webp, image/avif, image/apng,
 * image/svg+xml) すべての base64 形式と、image/svg+xml のテキスト形式 (utf8 / charset=utf-8 /
 * 直接 URL-encoded) をサポート。
 *
 * Filename 形式は editorProvider.ts の generateUniqueFileName と同じ:
 * - `${Date.now()}.${ext}`、衝突時 `${ts}-${0001}.${ext}`
 *
 * mime → ext マッピング: jpeg→jpg, svg+xml→svg, 他はそのまま。
 */

import * as fs from 'fs';
import * as path from 'path';

/** MIME image subtype → 拡張子マッピング */
export function mimeToExt(mimeSubtype: string): string {
    const lower = (mimeSubtype || '').toLowerCase();
    if (lower === 'jpeg') return 'jpg';
    if (lower === 'svg+xml' || lower === 'svg') return 'svg';
    // png, gif, webp, avif, apng はそのまま
    // 不正な文字を除去 (英数のみ残す)
    const cleaned = lower.replace(/[^a-z0-9]/g, '');
    return cleaned || 'png';
}

/**
 * 1 個の data URL を decode してバッファ + 拡張子を返す。
 * - base64 形式: image/<any>;base64,<b64>
 * - svg URL-encoded: image/svg+xml,<utf8 or URL-encoded SVG body>
 * - svg utf8: image/svg+xml;utf8,<...>
 * 不正な形式は null を返す。
 */
export function parseDataUrl(dataUrl: string): { ext: string; buffer: Buffer } | null {
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return null;

    // パターン 1: base64
    // 例: data:image/png;base64,iVBOR...
    //     data:image/svg+xml;base64,PHN2Zy...
    let m = dataUrl.match(/^data:image\/([a-zA-Z0-9+\-.]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/);
    if (m) {
        const ext = mimeToExt(m[1]);
        try {
            return { ext, buffer: Buffer.from(m[2], 'base64') };
        } catch {
            return null;
        }
    }

    // パターン 2: SVG (text 形式: utf8 / charset / URL-encoded)
    // 例: data:image/svg+xml,<svg ...>
    //     data:image/svg+xml;utf8,<svg ...>
    //     data:image/svg+xml;charset=utf-8,%3Csvg...
    m = dataUrl.match(/^data:image\/svg\+xml(?:;[^,]*)?,(.+)$/);
    if (m) {
        let body = m[1];
        try {
            body = decodeURIComponent(body);
        } catch {
            // 既に decode 済 or 不正 URL-encoded はそのまま使う
        }
        return { ext: 'svg', buffer: Buffer.from(body, 'utf8') };
    }

    return null;
}

/**
 * editorProvider.ts の generateUniqueFileName と同じ命名規則:
 * - `${Date.now()}.${ext}`、衝突時 `${ts}-${0001}.${ext}`
 */
export function generateUniqueImageName(imageDir: string, ext: string): string {
    const timestamp = Date.now();
    const baseName = `${timestamp}.${ext}`;
    if (!fs.existsSync(path.join(imageDir, baseName))) return baseName;
    let counter = 1;
    while (true) {
        const newName = `${timestamp}-${counter.toString().padStart(4, '0')}.${ext}`;
        if (!fs.existsSync(path.join(imageDir, newName))) return newName;
        counter++;
    }
}

/**
 * data URL を見つけるための正規表現。
 * Body は MD/HTML delimiter (`)` `"` 空白 `<` `>`) で停止。
 * `'` は URL-encoded SVG 内で literal で登場するため含める
 * (HTML src='...' のレアケースでは末尾が乱れる)。
 */
const DATA_URL_RE = /(data:image\/[a-zA-Z0-9+\-.]+(?:;[a-zA-Z0-9-]+(?:=[^;,]*)?)*?(?:;base64)?,[^)"\s<>]+)/g;

/**
 * Markdown / HTML 文字列内の data:image/... を実体ファイル化し、相対パスに置換した文字列を返す。
 *
 * @param content    対象テキスト (MD or HTML)
 * @param imageDir   画像保存先ディレクトリ (絶対 path)
 * @param mdFileDir  MD ファイル自身のディレクトリ (相対 path 計算基準)
 * @returns 置換後の content と保存件数
 */
export function processDataUrlsInContent(
    content: string,
    imageDir: string,
    mdFileDir: string
): { newContent: string; savedCount: number } {
    if (!content || content.indexOf('data:image/') < 0) {
        return { newContent: content, savedCount: 0 };
    }

    if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true });
    }

    // 同一 data URL が複数回登場した場合は 1 度だけ書き込み、同じ相対 path に置換
    const seen = new Map<string, string>();
    let savedCount = 0;

    const newContent = content.replace(DATA_URL_RE, (match) => {
        if (seen.has(match)) return seen.get(match)!;
        const parsed = parseDataUrl(match);
        if (!parsed) return match;
        const fileName = generateUniqueImageName(imageDir, parsed.ext);
        const absPath = path.join(imageDir, fileName);
        try {
            fs.writeFileSync(absPath, parsed.buffer);
        } catch {
            return match;
        }
        savedCount++;
        const rel = path.relative(mdFileDir, absPath).replace(/\\/g, '/');
        seen.set(match, rel);
        return rel;
    });

    return { newContent, savedCount };
}
