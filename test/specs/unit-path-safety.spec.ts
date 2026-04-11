/**
 * Path Safety Unit Tests
 *
 * Tests for path traversal vulnerability protection (T-2.31)
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as os from 'os';
import { safeResolveUnderDir } from '../../src/shared/path-safety';

test.describe('Path Safety - safeResolveUnderDir', () => {
    const baseDir = path.join(os.tmpdir(), 'test-base-dir');

    test('should accept valid relative path', () => {
        const result = safeResolveUnderDir(baseDir, 'images/test.png');
        expect(result).toBeTruthy();
        expect(result).toBe(path.join(baseDir, 'images', 'test.png'));
    });

    test('should accept subdirectory path', () => {
        const result = safeResolveUnderDir(baseDir, './subdir/../images/test.png');
        expect(result).toBeTruthy();
        expect(path.relative(baseDir, result)).not.toMatch(/^\.\./);
    });

    test('should reject absolute path', () => {
        const result = safeResolveUnderDir(baseDir, '/etc/passwd');
        expect(result).toBeNull();
    });

    test('should reject path with leading ..', () => {
        const result = safeResolveUnderDir(baseDir, '../outside/file.txt');
        expect(result).toBeNull();
    });

    test('should reject path with .. in the middle escaping baseDir', () => {
        const result = safeResolveUnderDir(baseDir, 'images/../../etc/passwd');
        expect(result).toBeNull();
    });

    test('should reject path equal to ..', () => {
        const result = safeResolveUnderDir(baseDir, '..');
        expect(result).toBeNull();
    });

    test('should reject Windows absolute path', () => {
        const result = safeResolveUnderDir(baseDir, 'C:\\Windows\\System32\\config');
        expect(result).toBeNull();
    });

    test('should handle empty path', () => {
        const result = safeResolveUnderDir(baseDir, '');
        expect(result).toBe(baseDir);
    });

    test('should handle dot path', () => {
        const result = safeResolveUnderDir(baseDir, '.');
        expect(result).toBe(baseDir);
    });
});
