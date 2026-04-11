/**
 * Path Safety Utilities
 *
 * Protects against path traversal attacks by validating relative paths
 * stay within a specified base directory.
 */

import * as path from 'path';

/**
 * Safely resolves a relative path under a base directory.
 *
 * Returns null if the path:
 * - Is absolute
 * - Contains .. that would escape the baseDir
 * - Normalizes to a path outside baseDir
 *
 * @param baseDir The base directory to resolve paths under
 * @param relPath The relative path to resolve
 * @returns Absolute path if safe, null if unsafe
 */
export function safeResolveUnderDir(baseDir: string, relPath: string): string | null {
    // Reject absolute paths (Unix and Windows)
    if (path.isAbsolute(relPath)) {
        return null;
    }

    // Also reject Windows absolute paths on non-Windows systems
    if (/^[a-zA-Z]:[/\\]/.test(relPath)) {
        return null;
    }

    // Normalize the path to resolve .. and .
    const normalized = path.normalize(relPath);

    // Reject paths that start with .. (would escape immediately)
    if (normalized.startsWith('..' + path.sep) || normalized === '..') {
        return null;
    }

    // Resolve to absolute path
    const absPath = path.resolve(baseDir, normalized);

    // Check if resolved path is still under baseDir
    const relToBase = path.relative(baseDir, absPath);

    // If relative path starts with .., the resolved path is outside baseDir
    if (relToBase.startsWith('..')) {
        return null;
    }

    return absPath;
}
