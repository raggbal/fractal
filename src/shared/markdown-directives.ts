/**
 * Markdown Directive Extraction and Manipulation
 *
 * Handles IMAGE_DIR, FORCE_RELATIVE_PATH, FILE_DIR, FORCE_RELATIVE_FILE_PATH directives
 * in markdown document footers.
 */

/**
 * ドキュメントからIMAGE_DIRディレクティブを抽出
 */
export function extractImageDir(content: string): string | null {
    // Match either at start of string or after a newline
    const pattern = /(?:^|\n)---\n(?:[\s\S]*?\n)?IMAGE_DIR:\s*([^\n]+)/;
    const match = content.match(pattern);
    if (match) {
        return match[1].trim();
    }
    return null;
}

/**
 * ドキュメントからFORCE_RELATIVE_PATHディレクティブを抽出
 */
export function extractForceRelativePath(content: string): boolean | null {
    // Match either at start of string or after a newline
    const pattern = /(?:^|\n)---\n(?:[\s\S]*?\n)?FORCE_RELATIVE_PATH:\s*(true|false)/i;
    const match = content.match(pattern);
    if (match) {
        return match[1].toLowerCase() === 'true';
    }
    return null;
}

/**
 * ドキュメントからFILE_DIRディレクティブを抽出
 */
export function extractFileDir(content: string): string | null {
    // Match either at start of string or after a newline
    const pattern = /(?:^|\n)---\n(?:[\s\S]*?\n)?FILE_DIR:\s*([^\n]+)/;
    const match = content.match(pattern);
    if (match) {
        return match[1].trim();
    }
    return null;
}

/**
 * ドキュメントからFORCE_RELATIVE_FILE_PATHディレクティブを抽出
 */
export function extractForceRelativeFilePath(content: string): boolean | null {
    // Match either at start of string or after a newline
    const pattern = /(?:^|\n)---\n(?:[\s\S]*?\n)?FORCE_RELATIVE_FILE_PATH:\s*(true|false)/i;
    const match = content.match(pattern);
    if (match) {
        return match[1].toLowerCase() === 'true';
    }
    return null;
}

/**
 * すべてのディレクティブブロックを削除
 */
export function removeAllDirectives(content: string): string {
    // Remove directive blocks at end of file (all 4 directive types)
    // This matches: optional newline + "---" + newline + one or more directive lines + trailing whitespace/newlines
    let result = content.replace(/\n---\n(?:(?:IMAGE_DIR:\s*[^\n]+|FORCE_RELATIVE_PATH:\s*(?:true|false)|FILE_DIR:\s*[^\n]+|FORCE_RELATIVE_FILE_PATH:\s*(?:true|false))\n?)+\s*$/gi, '');

    return result;
}
