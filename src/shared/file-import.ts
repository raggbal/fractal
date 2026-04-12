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

// ────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────

/**
 * Import files by copying them to fileDir with unique names.
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
    const results: ImportedFile[] = [];

    // Ensure fileDir exists
    if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
    }

    for (const sourcePath of filePaths) {
        if (!fs.existsSync(sourcePath)) {
            continue; // Skip non-existent files
        }

        const originalName = path.basename(sourcePath);
        const uniqueName = generateUniqueFileName(fileDir, originalName);
        const destPath = path.join(fileDir, uniqueName);

        // Copy file
        try {
            fs.copyFileSync(sourcePath, destPath);
        } catch {
            continue; // Skip on copy failure
        }

        // Calculate relative path from outDir
        const relativePath = path.relative(outDir, destPath).replace(/\\/g, '/');

        results.push({
            title: originalName,
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
