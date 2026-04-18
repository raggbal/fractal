/**
 * file-import.ts — File attachment import logic
 *
 * Copies files to fileDir preserving original filenames with collision suffix (-1, -2, etc.)
 * Returns relative paths from outDir for storage in node.filePath.
 */

import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export interface ImportedFile {
    title: string;       // Original filename (used as node text)
    filePath: string;    // Relative path from outDir to copied file
}

export interface ImportFileItem {
    name: string;        // Original filename
    buffer: Buffer;      // File content as Buffer
}

// ────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────

/**
 * Import files by copying them to fileDir with unique names.
 * Thin wrapper over importFilesCore for file path based input.
 *
 * @param filePaths  Array of absolute paths to source files
 * @param fileDir    Target directory for copied files
 * @param outDir     Base directory (for calculating relative paths)
 * @returns Array of ImportedFile results
 */
export function importFiles(
    filePaths: string[],
    fileDir: string,
    outDir: string
): ImportedFile[] {
    // Build items from file paths, skipping non-existent files
    const items: ImportFileItem[] = [];
    for (const sourcePath of filePaths) {
        if (!fs.existsSync(sourcePath)) {
            continue;
        }
        try {
            items.push({
                name: path.basename(sourcePath),
                buffer: fs.readFileSync(sourcePath)
            });
        } catch {
            // Skip on read failure
            continue;
        }
    }

    return importFilesCore(items, fileDir, outDir);
}

/**
 * Import files from buffer arrays (D&D support).
 * Core implementation shared by both path-based and buffer-based imports.
 *
 * @param items    Array of {name, buffer} items
 * @param fileDir  Target directory for copied files
 * @param outDir   Base directory (for calculating relative paths)
 * @returns Array of ImportedFile results
 * @throws Error if filename contains path traversal attempt
 */
export function importFilesCore(
    items: ImportFileItem[],
    fileDir: string,
    outDir: string
): ImportedFile[] {
    const results: ImportedFile[] = [];

    // Ensure fileDir exists
    if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
    }

    for (const item of items) {
        // Path traversal prevention: basename must equal original name
        const safeName = path.basename(item.name);
        if (safeName !== item.name || item.name.includes('..')) {
            throw new Error(`Invalid file name: ${item.name}`);
        }

        const uniqueName = generateUniqueFileName(fileDir, safeName);
        const destPath = path.join(fileDir, uniqueName);

        // Write file
        fs.writeFileSync(destPath, item.buffer);

        // Calculate relative path from outDir
        const relativePath = path.relative(outDir, destPath).replace(/\\/g, '/');

        results.push({
            title: safeName,
            filePath: relativePath
        });
    }

    return results;
}

// ────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────

/**
 * Generate unique filename preserving original name with collision suffix.
 * Examples: report.pdf, report-1.pdf, report-2.pdf
 *
 * @param targetDir  Directory to check for existing files
 * @param originalName  Original filename
 * @returns Unique filename
 */
function generateUniqueFileName(targetDir: string, originalName: string): string {
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);

    let candidate = originalName;
    let suffix = 0;

    while (fs.existsSync(path.join(targetDir, candidate))) {
        suffix++;
        candidate = `${baseName}-${suffix}${ext}`;
    }

    return candidate;
}
