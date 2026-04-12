/**
 * Markdown Directive Extraction and Manipulation
 *
 * DEPRECATED: Per-file directives have been removed.
 * This file is kept for backward compatibility but all functions return null/no-op.
 */

/**
 * @deprecated No longer extracts IMAGE_DIR from markdown
 */
export function extractImageDir(content: string): string | null {
    return null;
}

/**
 * @deprecated No longer extracts FORCE_RELATIVE_PATH from markdown
 */
export function extractForceRelativePath(content: string): boolean | null {
    return null;
}

/**
 * @deprecated No longer extracts FILE_DIR from markdown
 */
export function extractFileDir(content: string): string | null {
    return null;
}

/**
 * @deprecated No longer extracts FORCE_RELATIVE_FILE_PATH from markdown
 */
export function extractForceRelativeFilePath(content: string): boolean | null {
    return null;
}

/**
 * @deprecated No-op, directives are no longer written
 */
export function removeAllDirectives(content: string): string {
    return content;
}
