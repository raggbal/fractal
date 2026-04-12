/**
 * Integration test for copyFileAsset / moveFileAsset (T-1.8, DOD-21)
 *
 * Tests file attachment copy/move operations:
 * - copyFileAsset: preserves original name with collision suffix
 * - moveFileAsset: renames (moves) file, same-dir is no-op
 *
 * DoD: DOD-21
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyFileAsset, moveFileAsset } from '../../src/shared/paste-asset-handler';

test.describe('Integration: copyFileAsset', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-file-assets-'));
    });

    test.afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('DOD-21: copyFileAsset copies file to destFileDir with original name preserved', () => {
        // Arrange: create src file
        const srcDir = path.join(tmpDir, 'src');
        const srcFileDir = path.join(srcDir, 'files');
        fs.mkdirSync(srcFileDir, { recursive: true });
        const srcFilePath = path.join(srcFileDir, 'report.pdf');
        fs.writeFileSync(srcFilePath, 'fake pdf data');

        const destDir = path.join(tmpDir, 'dest');
        const destFileDir = path.join(destDir, 'files');
        fs.mkdirSync(destFileDir, { recursive: true });

        // Act: copyFileAsset
        const result = copyFileAsset({
            srcOutDir: srcDir,
            srcFileDir: srcFileDir,
            destOutDir: destDir,
            destFileDir: destFileDir,
            filePath: 'files/report.pdf'
        });

        // Assert: newFilePath returned
        expect(result.newFilePath).toBe('files/report.pdf');

        // Assert: new file exists in dest
        const newFilePath = path.join(destFileDir, 'report.pdf');
        expect(fs.existsSync(newFilePath)).toBe(true);

        // Assert: source file still exists (copy, not move)
        expect(fs.existsSync(srcFilePath)).toBe(true);

        // Assert: content is identical
        const srcContent = fs.readFileSync(srcFilePath, 'utf-8');
        const destContent = fs.readFileSync(newFilePath, 'utf-8');
        expect(destContent).toBe(srcContent);
    });

    test('DOD-21: collision adds suffix (-1, -2, etc.)', () => {
        // Arrange: create src file and a pre-existing dest file
        const srcDir = path.join(tmpDir, 'src');
        const srcFileDir = path.join(srcDir, 'files');
        fs.mkdirSync(srcFileDir, { recursive: true });
        const srcFilePath = path.join(srcFileDir, 'data.xlsx');
        fs.writeFileSync(srcFilePath, 'original data');

        const destDir = path.join(tmpDir, 'dest');
        const destFileDir = path.join(destDir, 'files');
        fs.mkdirSync(destFileDir, { recursive: true });
        // Pre-existing file with same name
        fs.writeFileSync(path.join(destFileDir, 'data.xlsx'), 'existing data');

        // Act: copyFileAsset
        const result = copyFileAsset({
            srcOutDir: srcDir,
            srcFileDir: srcFileDir,
            destOutDir: destDir,
            destFileDir: destFileDir,
            filePath: 'files/data.xlsx'
        });

        // Assert: newFilePath has suffix
        expect(result.newFilePath).toBe('files/data-1.xlsx');

        // Assert: new file exists with suffix
        const newFilePath = path.join(destFileDir, 'data-1.xlsx');
        expect(fs.existsSync(newFilePath)).toBe(true);

        // Assert: original file in dest still exists
        expect(fs.existsSync(path.join(destFileDir, 'data.xlsx'))).toBe(true);

        // Assert: content is from source
        const srcContent = fs.readFileSync(srcFilePath, 'utf-8');
        const destContent = fs.readFileSync(newFilePath, 'utf-8');
        expect(destContent).toBe(srcContent);
    });

    test('multiple collisions add incrementing suffixes', () => {
        // Arrange: create src file and 2 pre-existing dest files
        const srcDir = path.join(tmpDir, 'src');
        const srcFileDir = path.join(srcDir, 'files');
        fs.mkdirSync(srcFileDir, { recursive: true });
        const srcFilePath = path.join(srcFileDir, 'file.txt');
        fs.writeFileSync(srcFilePath, 'source content');

        const destDir = path.join(tmpDir, 'dest');
        const destFileDir = path.join(destDir, 'files');
        fs.mkdirSync(destFileDir, { recursive: true });
        fs.writeFileSync(path.join(destFileDir, 'file.txt'), 'existing 0');
        fs.writeFileSync(path.join(destFileDir, 'file-1.txt'), 'existing 1');

        // Act: copyFileAsset
        const result = copyFileAsset({
            srcOutDir: srcDir,
            srcFileDir: srcFileDir,
            destOutDir: destDir,
            destFileDir: destFileDir,
            filePath: 'files/file.txt'
        });

        // Assert: newFilePath has suffix -2
        expect(result.newFilePath).toBe('files/file-2.txt');

        // Assert: new file exists
        const newFilePath = path.join(destFileDir, 'file-2.txt');
        expect(fs.existsSync(newFilePath)).toBe(true);

        // Assert: all 3 files exist
        expect(fs.existsSync(path.join(destFileDir, 'file.txt'))).toBe(true);
        expect(fs.existsSync(path.join(destFileDir, 'file-1.txt'))).toBe(true);
        expect(fs.existsSync(path.join(destFileDir, 'file-2.txt'))).toBe(true);
    });

    test('source file not found returns null', () => {
        // Arrange: destFileDir exists but source file doesn't
        const srcDir = path.join(tmpDir, 'src');
        const srcFileDir = path.join(srcDir, 'files');
        fs.mkdirSync(srcFileDir, { recursive: true });

        const destDir = path.join(tmpDir, 'dest');
        const destFileDir = path.join(destDir, 'files');
        fs.mkdirSync(destFileDir, { recursive: true });

        // Act: copyFileAsset with non-existent file
        const result = copyFileAsset({
            srcOutDir: srcDir,
            srcFileDir: srcFileDir,
            destOutDir: destDir,
            destFileDir: destFileDir,
            filePath: 'files/nonexistent.pdf'
        });

        // Assert: newFilePath is null
        expect(result.newFilePath).toBeNull();
    });
});

test.describe('Integration: moveFileAsset', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-file-assets-'));
    });

    test.afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('DOD-21: moveFileAsset moves file from src to dest', () => {
        // Arrange: create src file
        const srcDir = path.join(tmpDir, 'src');
        const srcFileDir = path.join(srcDir, 'files');
        fs.mkdirSync(srcFileDir, { recursive: true });
        const srcFilePath = path.join(srcFileDir, 'document.docx');
        fs.writeFileSync(srcFilePath, 'document content');

        const destDir = path.join(tmpDir, 'dest');
        const destFileDir = path.join(destDir, 'files');
        fs.mkdirSync(destFileDir, { recursive: true });

        // Act: moveFileAsset
        const result = moveFileAsset({
            srcOutDir: srcDir,
            srcFileDir: srcFileDir,
            destOutDir: destDir,
            destFileDir: destFileDir,
            filePath: 'files/document.docx'
        });

        // Assert: newFilePath returned
        expect(result.newFilePath).toBe('files/document.docx');

        // Assert: new file exists in dest
        const newFilePath = path.join(destFileDir, 'document.docx');
        expect(fs.existsSync(newFilePath)).toBe(true);

        // Assert: source file is gone (moved, not copied)
        expect(fs.existsSync(srcFilePath)).toBe(false);
    });

    test('DOD-21: same-dir move is no-op and returns original filePath', () => {
        // Arrange: create file in same dir for src and dest
        const sameDir = path.join(tmpDir, 'files');
        fs.mkdirSync(sameDir, { recursive: true });
        const filePath = path.join(sameDir, 'same.pdf');
        fs.writeFileSync(filePath, 'same dir file');

        // Act: moveFileAsset with srcFileDir === destFileDir
        const result = moveFileAsset({
            srcOutDir: tmpDir,
            srcFileDir: sameDir,
            destOutDir: tmpDir,
            destFileDir: sameDir,
            filePath: 'files/same.pdf'
        });

        // Assert: newFilePath is the same as original
        expect(result.newFilePath).toBe('files/same.pdf');

        // Assert: file still exists (no-op)
        expect(fs.existsSync(filePath)).toBe(true);
    });

    test('source file not found returns null', () => {
        // Arrange: destFileDir exists but source file doesn't
        const srcDir = path.join(tmpDir, 'src');
        const srcFileDir = path.join(srcDir, 'files');
        fs.mkdirSync(srcFileDir, { recursive: true });

        const destDir = path.join(tmpDir, 'dest');
        const destFileDir = path.join(destDir, 'files');
        fs.mkdirSync(destFileDir, { recursive: true });

        // Act: moveFileAsset with non-existent file
        const result = moveFileAsset({
            srcOutDir: srcDir,
            srcFileDir: srcFileDir,
            destOutDir: destDir,
            destFileDir: destFileDir,
            filePath: 'files/missing.txt'
        });

        // Assert: newFilePath is null
        expect(result.newFilePath).toBeNull();
    });
});
