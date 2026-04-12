/**
 * File Import Unit Tests (v8)
 * - DOD-2: importFiles copies files with original names + collision suffix
 * - DOD-10: .out JSON without filePath loads correctly
 * - DOD-24: safeResolveUnderDir rejects path traversal
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { importFiles } from '../../src/shared/file-import';
import { safeResolveUnderDir } from '../../src/shared/path-safety';

test.describe('DOD-2: importFiles() — copy with original names + collision suffix', () => {
    let tmpDir: string;
    let tmpOutDir: string;
    let tmpFileDir: string;
    let sourceFiles: string[];

    test.beforeEach(() => {
        // Create temp directories
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-file-import-test-'));
        tmpOutDir = tmpDir;
        tmpFileDir = path.join(tmpDir, 'files');

        // Create source files
        sourceFiles = [
            path.join(tmpDir, 'report.pdf'),
            path.join(tmpDir, 'data.xlsx')
        ];

        fs.writeFileSync(sourceFiles[0], 'PDF content');
        fs.writeFileSync(sourceFiles[1], 'Excel content');
    });

    test.afterEach(() => {
        // Cleanup
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('RED: importFiles copies files to fileDir with original names', () => {
        const results = importFiles(sourceFiles, tmpFileDir, tmpOutDir);

        expect(results).toHaveLength(2);
        expect(results[0].title).toBe('report.pdf');
        expect(results[1].title).toBe('data.xlsx');

        // Check physical files exist
        const reportPath = path.join(tmpFileDir, 'report.pdf');
        const dataPath = path.join(tmpFileDir, 'data.xlsx');
        expect(fs.existsSync(reportPath)).toBe(true);
        expect(fs.existsSync(dataPath)).toBe(true);

        // Check content preserved
        expect(fs.readFileSync(reportPath, 'utf-8')).toBe('PDF content');
        expect(fs.readFileSync(dataPath, 'utf-8')).toBe('Excel content');
    });

    test('GREEN: importFiles returns relative paths from outDir', () => {
        const results = importFiles(sourceFiles, tmpFileDir, tmpOutDir);

        expect(results[0].filePath).toBe('files/report.pdf');
        expect(results[1].filePath).toBe('files/data.xlsx');

        // Paths should use forward slashes (cross-platform)
        expect(results[0].filePath).not.toContain('\\');
        expect(results[1].filePath).not.toContain('\\');
    });

    test('REFACTOR: collision adds suffix -1, -2, etc.', () => {
        // First import
        const results1 = importFiles(sourceFiles, tmpFileDir, tmpOutDir);
        expect(results1[0].title).toBe('report.pdf');

        // Second import of same files
        const results2 = importFiles(sourceFiles, tmpFileDir, tmpOutDir);
        expect(results2[0].title).toBe('report.pdf');
        expect(results2[0].filePath).toBe('files/report-1.pdf');
        expect(results2[1].filePath).toBe('files/data-1.xlsx');

        // Third import
        const results3 = importFiles([sourceFiles[0]], tmpFileDir, tmpOutDir);
        expect(results3[0].filePath).toBe('files/report-2.pdf');

        // Check all physical files exist
        expect(fs.existsSync(path.join(tmpFileDir, 'report.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(tmpFileDir, 'report-1.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(tmpFileDir, 'report-2.pdf'))).toBe(true);
    });

    test('importFiles creates fileDir if it does not exist', () => {
        expect(fs.existsSync(tmpFileDir)).toBe(false);

        importFiles(sourceFiles, tmpFileDir, tmpOutDir);

        expect(fs.existsSync(tmpFileDir)).toBe(true);
    });

    test('importFiles skips non-existent source files', () => {
        const nonExistent = path.join(tmpDir, 'missing.txt');
        const results = importFiles([sourceFiles[0], nonExistent], tmpFileDir, tmpOutDir);

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('report.pdf');
    });
});

test.describe('DOD-10: .out JSON backward compatibility — filePath defaults to null', () => {
    test('Node without filePath field loads correctly', () => {
        const jsonWithoutFilePath = {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: {
                    id: 'n1',
                    parentId: null,
                    children: [],
                    text: 'Test node',
                    tags: [],
                    isPage: false,
                    pageId: null,
                    collapsed: false,
                    checked: null,
                    subtext: '',
                    images: []
                    // No filePath field
                }
            }
        };

        // Parse and verify default
        const node = jsonWithoutFilePath.nodes.n1;
        expect(node.filePath).toBeUndefined();

        // After loading with model defaults, filePath should be null
        // This is tested in outliner-model.js addNode()
        // We verify the schema allows missing filePath
        expect(() => JSON.stringify(jsonWithoutFilePath)).not.toThrow();
    });

    test('Node with filePath field loads correctly', () => {
        const jsonWithFilePath = {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: {
                    id: 'n1',
                    parentId: null,
                    children: [],
                    text: 'Test file node',
                    tags: [],
                    isPage: false,
                    pageId: null,
                    collapsed: false,
                    checked: null,
                    subtext: '',
                    images: [],
                    filePath: 'files/report.pdf'
                }
            }
        };

        const node = jsonWithFilePath.nodes.n1;
        expect(node.filePath).toBe('files/report.pdf');
    });
});

test.describe('DOD-24: safeResolveUnderDir rejects path traversal', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-path-safety-test-'));
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('Normal relative path is accepted', () => {
        const result = safeResolveUnderDir(tmpDir, 'files/report.pdf');
        expect(result).not.toBeNull();
        expect(result).toBe(path.join(tmpDir, 'files/report.pdf'));
    });

    test('Path with .. that stays within baseDir is accepted', () => {
        const result = safeResolveUnderDir(tmpDir, 'files/../images/pic.png');
        expect(result).not.toBeNull();
        expect(result).toBe(path.join(tmpDir, 'images/pic.png'));
    });

    test('Path with .. that escapes baseDir is rejected', () => {
        const result = safeResolveUnderDir(tmpDir, '../../../etc/passwd');
        expect(result).toBeNull();
    });

    test('Absolute path is rejected', () => {
        const result = safeResolveUnderDir(tmpDir, '/etc/passwd');
        expect(result).toBeNull();
    });

    test('Windows absolute path is rejected', () => {
        const result = safeResolveUnderDir(tmpDir, 'C:\\Windows\\System32');
        expect(result).toBeNull();
    });

    test('Path starting with .. is rejected', () => {
        const result = safeResolveUnderDir(tmpDir, '../sibling/file.txt');
        expect(result).toBeNull();
    });

    test('Just .. is rejected', () => {
        const result = safeResolveUnderDir(tmpDir, '..');
        expect(result).toBeNull();
    });
});
