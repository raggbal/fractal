/**
 * File Import Core Unit Tests (v12)
 * - DOD-12-1: importFilesCore handles buffer arrays with collision suffix
 * - DOD-12-2: importMdFilesCore extracts H1, generates pageId, supports skipRelativeImages
 * - DOD-12-25: Path traversal prevention in importFilesCore
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// These imports will fail until the functions are implemented (RED phase)
import { importFilesCore } from '../../src/shared/file-import';
import { importMdFilesCore } from '../../src/shared/markdown-import';

test.describe('DOD-12-1: importFilesCore — buffer array input', () => {
    let tmpDir: string;
    let tmpOutDir: string;
    let tmpFileDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-core-test-'));
        tmpOutDir = tmpDir;
        tmpFileDir = path.join(tmpDir, 'files');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('importFilesCore copies buffer to file with original name', () => {
        const items = [
            { name: 'a.pdf', buffer: Buffer.from('PDF content') }
        ];

        const results = importFilesCore(items, tmpFileDir, tmpOutDir);

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('a.pdf');
        expect(results[0].filePath).toBe('files/a.pdf');

        // Check physical file exists
        const destPath = path.join(tmpFileDir, 'a.pdf');
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.readFileSync(destPath, 'utf-8')).toBe('PDF content');
    });

    test('importFilesCore handles multiple files', () => {
        const items = [
            { name: 'doc1.pdf', buffer: Buffer.from('doc1') },
            { name: 'doc2.xlsx', buffer: Buffer.from('doc2') }
        ];

        const results = importFilesCore(items, tmpFileDir, tmpOutDir);

        expect(results).toHaveLength(2);
        expect(results[0].title).toBe('doc1.pdf');
        expect(results[0].filePath).toBe('files/doc1.pdf');
        expect(results[1].title).toBe('doc2.xlsx');
        expect(results[1].filePath).toBe('files/doc2.xlsx');
    });

    test('importFilesCore adds suffix -1, -2 on collision', () => {
        const items1 = [{ name: 'report.pdf', buffer: Buffer.from('v1') }];
        const items2 = [{ name: 'report.pdf', buffer: Buffer.from('v2') }];
        const items3 = [{ name: 'report.pdf', buffer: Buffer.from('v3') }];

        importFilesCore(items1, tmpFileDir, tmpOutDir);
        const results2 = importFilesCore(items2, tmpFileDir, tmpOutDir);
        const results3 = importFilesCore(items3, tmpFileDir, tmpOutDir);

        expect(results2[0].filePath).toBe('files/report-1.pdf');
        expect(results3[0].filePath).toBe('files/report-2.pdf');

        // Verify physical files
        expect(fs.existsSync(path.join(tmpFileDir, 'report.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(tmpFileDir, 'report-1.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(tmpFileDir, 'report-2.pdf'))).toBe(true);
    });

    test('importFilesCore creates fileDir if not exists', () => {
        expect(fs.existsSync(tmpFileDir)).toBe(false);

        importFilesCore([{ name: 'test.txt', buffer: Buffer.from('x') }], tmpFileDir, tmpOutDir);

        expect(fs.existsSync(tmpFileDir)).toBe(true);
    });
});

test.describe('DOD-12-2: importMdFilesCore — content array input', () => {
    let tmpDir: string;
    let tmpPageDir: string;
    let tmpImageDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-core-test-'));
        tmpPageDir = path.join(tmpDir, 'pages');
        tmpImageDir = path.join(tmpDir, 'images');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('importMdFilesCore extracts H1 as title and generates pageId', () => {
        const items = [{
            name: 'doc.md',
            content: '# My Title\n\nBody text here.',
            sourceDir: ''
        }];

        const results = importMdFilesCore(items, tmpPageDir, tmpImageDir, { skipRelativeImages: true });

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('My Title');
        expect(results[0].pageId).toBeTruthy();
        expect(results[0].pageId).toMatch(/^[0-9a-f-]{36}$/); // UUID format

        // Verify page file created
        const pagePath = path.join(tmpPageDir, `${results[0].pageId}.md`);
        expect(fs.existsSync(pagePath)).toBe(true);
    });

    test('importMdFilesCore uses filename when H1 is missing', () => {
        const items = [{
            name: 'notes.md',
            content: 'Just some text without H1.',
            sourceDir: ''
        }];

        const results = importMdFilesCore(items, tmpPageDir, tmpImageDir, { skipRelativeImages: true });

        expect(results).toHaveLength(1);
        // Should use filename without extension as fallback
        expect(results[0].title).toBe('notes');
    });

    test('importMdFilesCore handles multiple files in order', () => {
        const items = [
            { name: 'a.md', content: '# Alpha\n\nbody', sourceDir: '' },
            { name: 'b.md', content: '# Beta\n\nbody', sourceDir: '' }
        ];

        const results = importMdFilesCore(items, tmpPageDir, tmpImageDir, { skipRelativeImages: true });

        expect(results).toHaveLength(2);
        expect(results[0].title).toBe('Alpha');
        expect(results[1].title).toBe('Beta');
    });

    test('importMdFilesCore with skipRelativeImages skips relative image paths', () => {
        const items = [{
            name: 'doc.md',
            content: '# Title\n\n![alt](./local-image.png)\n\n![alt2](https://example.com/remote.png)',
            sourceDir: ''
        }];

        const results = importMdFilesCore(items, tmpPageDir, tmpImageDir, { skipRelativeImages: true });

        expect(results).toHaveLength(1);
        // Content should preserve the original relative path (not copied) and URL
        const pagePath = path.join(tmpPageDir, `${results[0].pageId}.md`);
        const savedContent = fs.readFileSync(pagePath, 'utf-8');
        // Relative path should remain unchanged (not resolved/copied since sourceDir is empty)
        expect(savedContent).toContain('![alt](./local-image.png)');
        expect(savedContent).toContain('![alt2](https://example.com/remote.png)');
    });

    test('importMdFilesCore creates pageDir if not exists', () => {
        expect(fs.existsSync(tmpPageDir)).toBe(false);

        importMdFilesCore(
            [{ name: 'test.md', content: '# Test', sourceDir: '' }],
            tmpPageDir,
            tmpImageDir,
            { skipRelativeImages: true }
        );

        expect(fs.existsSync(tmpPageDir)).toBe(true);
    });
});

test.describe('DOD-12-25: importFilesCore — path traversal prevention', () => {
    let tmpDir: string;
    let tmpOutDir: string;
    let tmpFileDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-security-test-'));
        tmpOutDir = tmpDir;
        tmpFileDir = path.join(tmpDir, 'files');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('importFilesCore rejects path traversal with ../', () => {
        const items = [
            { name: '../evil.txt', buffer: Buffer.from('malicious') }
        ];

        expect(() => {
            importFilesCore(items, tmpFileDir, tmpOutDir);
        }).toThrow(/Invalid file name/);
    });

    test('importFilesCore rejects path traversal with absolute path', () => {
        const items = [
            { name: '/etc/passwd', buffer: Buffer.from('malicious') }
        ];

        expect(() => {
            importFilesCore(items, tmpFileDir, tmpOutDir);
        }).toThrow(/Invalid file name/);
    });

    test('importFilesCore rejects path traversal with embedded ../', () => {
        const items = [
            { name: 'foo/../../../etc/passwd', buffer: Buffer.from('malicious') }
        ];

        expect(() => {
            importFilesCore(items, tmpFileDir, tmpOutDir);
        }).toThrow(/Invalid file name/);
    });

    test('importFilesCore accepts normal filenames', () => {
        const items = [
            { name: 'normal-file.pdf', buffer: Buffer.from('content') }
        ];

        // Should not throw
        const results = importFilesCore(items, tmpFileDir, tmpOutDir);
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('normal-file.pdf');
    });

    test('importFilesCore accepts filenames with dots', () => {
        const items = [
            { name: 'file.v2.backup.pdf', buffer: Buffer.from('content') }
        ];

        // Should not throw - dots in filename are OK
        const results = importFilesCore(items, tmpFileDir, tmpOutDir);
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('file.v2.backup.pdf');
    });
});
