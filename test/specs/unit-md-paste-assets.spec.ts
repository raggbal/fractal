/**
 * MD Paste Assets Unit Tests (v9)
 * - DOD-5: copyMdPasteAssets copies images with rename prefix and rewrites paths
 * - DOD-6: skips images that don't exist at source
 * - DOD-7: handles multiple image links in one markdown
 * - DOD-8: copies file attachments with original name and collision suffix
 * - DOD-9: handles mixed image and file links
 * - DOD-19: creates destination directories if they don't exist
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

test.describe('DOD-5: copyMdPasteAssets copies images with rename prefix', () => {
    let tmpDir: string;
    let srcDir: string;
    let destDir: string;
    let srcImageDir: string;
    let destImageDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-test-'));
        srcDir = path.join(tmpDir, 'src');
        destDir = path.join(tmpDir, 'dest');
        srcImageDir = path.join(srcDir, 'images');
        destImageDir = path.join(destDir, 'images');

        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(srcImageDir, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });

        // Create source image
        fs.writeFileSync(path.join(srcImageDir, 'photo.png'), 'image data');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('RED: should copy image with copy-{timestamp}-{name} prefix and rewrite path', () => {
        const markdown = '![alt](images/photo.png)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: srcImageDir,
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir: path.join(destDir, 'files'),
            destMdDir: destDir
        });

        // Check markdown was rewritten
        expect(result.rewrittenMarkdown).toMatch(/!\[alt\]\(images\/copy-\d+-photo\.png\)/);

        // Check file was copied with timestamp prefix
        const destFiles = fs.readdirSync(destImageDir);
        expect(destFiles).toHaveLength(1);
        expect(destFiles[0]).toMatch(/^copy-\d+-photo\.png$/);

        // Check file content
        const copiedFile = path.join(destImageDir, destFiles[0]);
        expect(fs.readFileSync(copiedFile, 'utf8')).toBe('image data');
    });
});

test.describe('DOD-6: copyMdPasteAssets skips missing images', () => {
    let tmpDir: string;
    let srcDir: string;
    let destDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-test-'));
        srcDir = path.join(tmpDir, 'src');
        destDir = path.join(tmpDir, 'dest');

        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('RED: should preserve original path when source image does not exist', () => {
        const markdown = '![alt](images/missing.png)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: path.join(srcDir, 'images'),
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir: path.join(destDir, 'images'),
            destFileDir: path.join(destDir, 'files'),
            destMdDir: destDir
        });

        // Original path should be preserved
        expect(result.rewrittenMarkdown).toBe('![alt](images/missing.png)');
    });
});

test.describe('DOD-7: copyMdPasteAssets handles multiple image links', () => {
    let tmpDir: string;
    let srcDir: string;
    let destDir: string;
    let srcImageDir: string;
    let destImageDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-test-'));
        srcDir = path.join(tmpDir, 'src');
        destDir = path.join(tmpDir, 'dest');
        srcImageDir = path.join(srcDir, 'images');
        destImageDir = path.join(destDir, 'images');

        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(srcImageDir, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });

        // Create 3 source images
        fs.writeFileSync(path.join(srcImageDir, 'photo1.png'), 'data1');
        fs.writeFileSync(path.join(srcImageDir, 'photo2.jpg'), 'data2');
        fs.writeFileSync(path.join(srcImageDir, 'diagram.svg'), 'data3');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('RED: should copy all images with unique prefixes and rewrite all paths', () => {
        const markdown = `# Test
![photo1](images/photo1.png)
Some text
![photo2](images/photo2.jpg)
More text
![diagram](images/diagram.svg)`;

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: srcImageDir,
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir: path.join(destDir, 'files'),
            destMdDir: destDir
        });

        // All paths should be rewritten with copy- prefix
        expect(result.rewrittenMarkdown).toMatch(/!\[photo1\]\(images\/copy-\d+-photo1\.png\)/);
        expect(result.rewrittenMarkdown).toMatch(/!\[photo2\]\(images\/copy-\d+-photo2\.jpg\)/);
        expect(result.rewrittenMarkdown).toMatch(/!\[diagram\]\(images\/copy-\d+-diagram\.svg\)/);

        // All 3 files should be copied
        const destFiles = fs.readdirSync(destImageDir);
        expect(destFiles).toHaveLength(3);
        expect(destFiles.some(f => f.match(/^copy-\d+-photo1\.png$/))).toBe(true);
        expect(destFiles.some(f => f.match(/^copy-\d+-photo2\.jpg$/))).toBe(true);
        expect(destFiles.some(f => f.match(/^copy-\d+-diagram\.svg$/))).toBe(true);
    });
});

test.describe('DOD-8: copyMdPasteAssets copies file attachments', () => {
    let tmpDir: string;
    let srcDir: string;
    let destDir: string;
    let srcFileDir: string;
    let destFileDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-test-'));
        srcDir = path.join(tmpDir, 'src');
        destDir = path.join(tmpDir, 'dest');
        srcFileDir = path.join(srcDir, 'files');
        destFileDir = path.join(destDir, 'files');

        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(srcFileDir, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });

        // Create source file
        fs.writeFileSync(path.join(srcFileDir, 'doc.pdf'), 'pdf content');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('RED: should copy file with original name', () => {
        const markdown = '[📎 doc.pdf](files/doc.pdf)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: path.join(srcDir, 'images'),
            sourceFileDir: srcFileDir,
            destImageDir: path.join(destDir, 'images'),
            destFileDir,
            destMdDir: destDir
        });

        // Path should remain the same (original name)
        expect(result.rewrittenMarkdown).toBe('[📎 doc.pdf](files/doc.pdf)');

        // File should be copied
        expect(fs.existsSync(path.join(destFileDir, 'doc.pdf'))).toBe(true);
        expect(fs.readFileSync(path.join(destFileDir, 'doc.pdf'), 'utf8')).toBe('pdf content');
    });

    test('RED: should add collision suffix when file already exists', () => {
        // Create existing file in dest
        fs.mkdirSync(destFileDir, { recursive: true });
        fs.writeFileSync(path.join(destFileDir, 'doc.pdf'), 'existing');

        const markdown = '[📎 doc.pdf](files/doc.pdf)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: path.join(srcDir, 'images'),
            sourceFileDir: srcFileDir,
            destImageDir: path.join(destDir, 'images'),
            destFileDir,
            destMdDir: destDir
        });

        // Path should have collision suffix
        expect(result.rewrittenMarkdown).toBe('[📎 doc.pdf](files/doc-1.pdf)');

        // Both files should exist
        expect(fs.existsSync(path.join(destFileDir, 'doc.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(destFileDir, 'doc-1.pdf'))).toBe(true);
        expect(fs.readFileSync(path.join(destFileDir, 'doc-1.pdf'), 'utf8')).toBe('pdf content');
    });
});

test.describe('DOD-9: copyMdPasteAssets handles mixed image and file links', () => {
    let tmpDir: string;
    let srcDir: string;
    let destDir: string;
    let srcImageDir: string;
    let destImageDir: string;
    let srcFileDir: string;
    let destFileDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-test-'));
        srcDir = path.join(tmpDir, 'src');
        destDir = path.join(tmpDir, 'dest');
        srcImageDir = path.join(srcDir, 'images');
        destImageDir = path.join(destDir, 'images');
        srcFileDir = path.join(srcDir, 'files');
        destFileDir = path.join(destDir, 'files');

        fs.mkdirSync(srcImageDir, { recursive: true });
        fs.mkdirSync(srcFileDir, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });

        // Create assets
        fs.writeFileSync(path.join(srcImageDir, 'photo1.png'), 'image1');
        fs.writeFileSync(path.join(srcImageDir, 'photo2.jpg'), 'image2');
        fs.writeFileSync(path.join(srcFileDir, 'report.pdf'), 'pdf');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('RED: should copy all assets and rewrite paths correctly', () => {
        const markdown = `# Test
![image1](images/photo1.png)
[📎 report.pdf](files/report.pdf)
![image2](images/photo2.jpg)`;

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: srcImageDir,
            sourceFileDir: srcFileDir,
            destImageDir,
            destFileDir,
            destMdDir: destDir
        });

        // Images should have copy- prefix, file should keep name
        expect(result.rewrittenMarkdown).toMatch(/!\[image1\]\(images\/copy-\d+-photo1\.png\)/);
        expect(result.rewrittenMarkdown).toMatch(/!\[image2\]\(images\/copy-\d+-photo2\.jpg\)/);
        expect(result.rewrittenMarkdown).toContain('[📎 report.pdf](files/report.pdf)');

        // Check files were copied
        const imageFiles = fs.readdirSync(destImageDir);
        expect(imageFiles).toHaveLength(2);

        const destFiles = fs.readdirSync(destFileDir);
        expect(destFiles).toContain('report.pdf');
    });
});

test.describe('DOD-19: copyMdPasteAssets creates destination directories', () => {
    let tmpDir: string;
    let srcDir: string;
    let destDir: string;
    let srcImageDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-test-'));
        srcDir = path.join(tmpDir, 'src');
        destDir = path.join(tmpDir, 'dest');
        srcImageDir = path.join(srcDir, 'images');

        fs.mkdirSync(srcImageDir, { recursive: true });
        fs.writeFileSync(path.join(srcImageDir, 'photo.png'), 'data');
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('RED: should auto-create destImageDir and destFileDir if missing', () => {
        const markdown = '![photo](images/photo.png)';
        const destImageDir = path.join(destDir, 'images');
        const destFileDir = path.join(destDir, 'files');

        // Destination directories do not exist yet
        expect(fs.existsSync(destImageDir)).toBe(false);
        expect(fs.existsSync(destFileDir)).toBe(false);

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: srcImageDir,
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir,
            destMdDir: destDir
        });

        // Directories should be created
        expect(fs.existsSync(destImageDir)).toBe(true);

        // File should be copied
        const destFiles = fs.readdirSync(destImageDir);
        expect(destFiles).toHaveLength(1);
    });
});
