/**
 * Drop Import Unit Tests (v12)
 * - DOD-12-4: processDropFilesImport handles mixed items and maintains order
 * - DOD-12-5: Partial failure results in ok:false entries
 * - DOD-12-6: classifyDroppedFile correctly identifies file types
 * - DOD-12-FR2-2: D&D uses shared core functions (importFilesCore, importMdFilesCore)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { processDropFilesImport, classifyDroppedFile, DropImportItem, processDropVscodeUrisImport } from '../../out/shared/drop-import';

test.describe('DOD-12-6: classifyDroppedFile — file type classification', () => {
    test('classifies .md files (case insensitive)', () => {
        expect(classifyDroppedFile({ name: 'doc.md' })).toBe('md');
        expect(classifyDroppedFile({ name: 'DOC.MD' })).toBe('md');
        expect(classifyDroppedFile({ name: 'notes.Md' })).toBe('md');
    });

    test('classifies image files (png, jpg, jpeg, gif, webp, svg, bmp)', () => {
        expect(classifyDroppedFile({ name: 'image.png' })).toBe('image');
        expect(classifyDroppedFile({ name: 'photo.PNG' })).toBe('image');
        expect(classifyDroppedFile({ name: 'pic.jpg' })).toBe('image');
        expect(classifyDroppedFile({ name: 'pic.JPG' })).toBe('image');
        expect(classifyDroppedFile({ name: 'pic.jpeg' })).toBe('image');
        expect(classifyDroppedFile({ name: 'anim.gif' })).toBe('image');
        expect(classifyDroppedFile({ name: 'modern.webp' })).toBe('image');
        expect(classifyDroppedFile({ name: 'vector.svg' })).toBe('image');
        expect(classifyDroppedFile({ name: 'old.bmp' })).toBe('image');
    });

    test('classifies other files as "file"', () => {
        expect(classifyDroppedFile({ name: 'report.pdf' })).toBe('file');
        expect(classifyDroppedFile({ name: 'data.xlsx' })).toBe('file');
        expect(classifyDroppedFile({ name: 'archive.zip' })).toBe('file');
        expect(classifyDroppedFile({ name: 'document.docx' })).toBe('file');
    });

    test('files without extension are classified as "file"', () => {
        expect(classifyDroppedFile({ name: 'README' })).toBe('file');
        expect(classifyDroppedFile({ name: 'Makefile' })).toBe('file');
    });

    test('.markdown and .mdown are classified as "file" (not md)', () => {
        // Per design.md: .md only for v12, variants are future expansion
        expect(classifyDroppedFile({ name: 'doc.markdown' })).toBe('file');
        expect(classifyDroppedFile({ name: 'notes.mdown' })).toBe('file');
    });
});

test.describe('DOD-12-4: processDropFilesImport — mixed items processing', () => {
    let tmpDir: string;
    let ctx: { fileDir: string; pageDir: string; imageDir: string; outDir: string };

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-drop-import-test-'));
        ctx = {
            fileDir: path.join(tmpDir, 'files'),
            pageDir: path.join(tmpDir, 'pages'),
            imageDir: path.join(tmpDir, 'images'),
            outDir: tmpDir
        };
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('processes single md file', async () => {
        const items: DropImportItem[] = [
            { kind: 'md', name: 'doc.md', content: '# Hello\n\nWorld' }
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].kind).toBe('md');
        expect(results[0].ok).toBe(true);
        if (results[0].ok && results[0].kind === 'md') {
            expect(results[0].title).toBe('Hello');
            expect(results[0].pageId).toBeTruthy();
        }
    });

    test('processes single image file', async () => {
        // Create a minimal valid PNG (1x1 pixel transparent)
        const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const items: DropImportItem[] = [
            { kind: 'image', name: 'test.png', dataUrl: pngDataUrl }
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].kind).toBe('image');
        expect(results[0].ok).toBe(true);
        if (results[0].ok && results[0].kind === 'image') {
            expect(results[0].imagePath).toMatch(/^images\/image_\d+_[a-z0-9]+\.png$/);
            expect(results[0].displayUri).toBeTruthy();
        }
    });

    test('processes single file (pdf)', async () => {
        const items: DropImportItem[] = [
            { kind: 'file', name: 'report.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) } // %PDF
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].kind).toBe('file');
        expect(results[0].ok).toBe(true);
        if (results[0].ok && results[0].kind === 'file') {
            expect(results[0].title).toBe('report.pdf');
            expect(results[0].filePath).toBe('files/report.pdf');
        }
    });

    test('processes mixed items maintaining original order', async () => {
        const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const items: DropImportItem[] = [
            { kind: 'md', name: 'first.md', content: '# First' },
            { kind: 'image', name: 'second.png', dataUrl: pngDataUrl },
            { kind: 'file', name: 'third.pdf', bytes: new Uint8Array([1, 2, 3]) }
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results).toHaveLength(3);
        expect(results[0].kind).toBe('md');
        expect(results[1].kind).toBe('image');
        expect(results[2].kind).toBe('file');

        // All should succeed
        expect(results.every(r => r.ok)).toBe(true);
    });

    test('handles multiple files of same type', async () => {
        const items: DropImportItem[] = [
            { kind: 'file', name: 'a.pdf', bytes: new Uint8Array([1]) },
            { kind: 'file', name: 'b.pdf', bytes: new Uint8Array([2]) },
            { kind: 'file', name: 'c.pdf', bytes: new Uint8Array([3]) }
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results).toHaveLength(3);
        expect(results.every(r => r.ok && r.kind === 'file')).toBe(true);
    });
});

test.describe('DOD-12-5: processDropFilesImport — partial failure handling', () => {
    let tmpDir: string;
    let ctx: { fileDir: string; pageDir: string; imageDir: string; outDir: string };

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-drop-import-test-'));
        ctx = {
            fileDir: path.join(tmpDir, 'files'),
            pageDir: path.join(tmpDir, 'pages'),
            imageDir: path.join(tmpDir, 'images'),
            outDir: tmpDir
        };
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('invalid image dataUrl results in ok:false', async () => {
        const items: DropImportItem[] = [
            { kind: 'image', name: 'bad.png', dataUrl: 'not-a-valid-data-url' }
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].ok).toBe(false);
        if (!results[0].ok) {
            expect(results[0].name).toBe('bad.png');
            expect(results[0].error).toBeTruthy();
        }
    });

    test('mix of success and failure maintains order', async () => {
        const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const items: DropImportItem[] = [
            { kind: 'md', name: 'good.md', content: '# Good' },
            { kind: 'image', name: 'bad.png', dataUrl: 'invalid' },
            { kind: 'file', name: 'good.pdf', bytes: new Uint8Array([1, 2, 3]) }
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results).toHaveLength(3);
        expect(results[0].ok).toBe(true);
        expect(results[0].kind).toBe('md');
        expect(results[1].ok).toBe(false);
        expect(results[1].kind).toBe('image');
        expect(results[2].ok).toBe(true);
        expect(results[2].kind).toBe('file');
    });
});

test.describe('DOD-12-FR2-2: Core function sharing verification', () => {
    let tmpDir: string;
    let ctx: { fileDir: string; pageDir: string; imageDir: string; outDir: string };

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-drop-import-test-'));
        ctx = {
            fileDir: path.join(tmpDir, 'files'),
            pageDir: path.join(tmpDir, 'pages'),
            imageDir: path.join(tmpDir, 'images'),
            outDir: tmpDir
        };
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('file collision handling uses same suffix logic as importFilesCore', async () => {
        // First import
        const items1: DropImportItem[] = [
            { kind: 'file', name: 'test.pdf', bytes: new Uint8Array([1]) }
        ];
        await processDropFilesImport(items1, ctx);

        // Second import should get suffix
        const items2: DropImportItem[] = [
            { kind: 'file', name: 'test.pdf', bytes: new Uint8Array([2]) }
        ];
        const results = await processDropFilesImport(items2, ctx);

        expect(results[0].ok).toBe(true);
        if (results[0].ok && results[0].kind === 'file') {
            expect(results[0].filePath).toBe('files/test-1.pdf');
        }
    });

    test('md import extracts H1 using same logic as importMdFilesCore', async () => {
        const items: DropImportItem[] = [
            { kind: 'md', name: 'test.md', content: '# My Custom Title\n\nBody content' }
        ];

        const results = await processDropFilesImport(items, ctx);

        expect(results[0].ok).toBe(true);
        if (results[0].ok && results[0].kind === 'md') {
            expect(results[0].title).toBe('My Custom Title');
        }
    });
});

// ============================================================================
// DOD-12-29/30: VSCode Explorer D&D 経路 (v12 拡張)
// ============================================================================

test.describe('DOD-12-29: processDropVscodeUrisImport uses existing importFiles/importMdFiles', () => {
    let tmpDir: string;
    let ctx: { fileDir: string; pageDir: string; imageDir: string; outDir: string };

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-vscode-uri-test-'));
        ctx = {
            fileDir: path.join(tmpDir, 'files'),
            pageDir: path.join(tmpDir, 'pages'),
            imageDir: path.join(tmpDir, 'images'),
            outDir: tmpDir
        };
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('processes file:// URIs and creates files using importFiles', async () => {
        // Create a test PDF file
        const testPdfPath = path.join(tmpDir, 'test.pdf');
        fs.writeFileSync(testPdfPath, '%PDF-1.4 test content');

        const uris = [`file://${testPdfPath}`];
        const results = await processDropVscodeUrisImport(uris, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].ok).toBe(true);
        if (results[0].ok && results[0].kind === 'file') {
            expect(results[0].title).toBe('test.pdf');
            expect(results[0].filePath).toBe('files/test.pdf');
        }

        // Verify physical file was created
        expect(fs.existsSync(path.join(ctx.fileDir, 'test.pdf'))).toBe(true);
    });

    test('processes .md URIs using importMdFiles with H1 extraction', async () => {
        // Create a test MD file
        const testMdPath = path.join(tmpDir, 'doc.md');
        fs.writeFileSync(testMdPath, '# My Document\n\nContent here');

        const uris = [`file://${testMdPath}`];
        const results = await processDropVscodeUrisImport(uris, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].ok).toBe(true);
        if (results[0].ok && results[0].kind === 'md') {
            expect(results[0].title).toBe('My Document');
            expect(results[0].pageId).toBeTruthy();
        }

        // Verify page file was created in pageDir
        const pageFiles = fs.readdirSync(ctx.pageDir);
        expect(pageFiles.length).toBe(1);
        expect(pageFiles[0]).toMatch(/\.md$/);
    });

    test('rejects non-file:// scheme URIs (e.g., vscode-remote://)', async () => {
        const uris = ['vscode-remote://ssh-remote/home/user/file.pdf'];
        const results = await processDropVscodeUrisImport(uris, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].ok).toBe(false);
        if (!results[0].ok) {
            expect(results[0].error).toMatch(/remote|unsupported/i);
        }
    });

    test('handles mixed URIs maintaining original order', async () => {
        // Create test files
        const pdfPath = path.join(tmpDir, 'a.pdf');
        const mdPath = path.join(tmpDir, 'b.md');
        const pngPath = path.join(tmpDir, 'c.png');

        fs.writeFileSync(pdfPath, '%PDF test');
        fs.writeFileSync(mdPath, '# Title\n\nBody');
        // Minimal PNG
        fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

        const uris = [
            `file://${pdfPath}`,
            `file://${mdPath}`,
            `file://${pngPath}`
        ];
        const results = await processDropVscodeUrisImport(uris, ctx);

        expect(results).toHaveLength(3);
        expect(results[0].kind).toBe('file');
        expect(results[1].kind).toBe('md');
        expect(results[2].kind).toBe('image');
    });
});

test.describe('DOD-12-30: Explorer path .md handles relative image references', () => {
    let tmpDir: string;
    let ctx: { fileDir: string; pageDir: string; imageDir: string; outDir: string };

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-vscode-uri-md-test-'));
        ctx = {
            fileDir: path.join(tmpDir, 'files'),
            pageDir: path.join(tmpDir, 'pages'),
            imageDir: path.join(tmpDir, 'images'),
            outDir: tmpDir
        };
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('relative image references in .md are copied and rewritten', async () => {
        // Create a subdirectory with an image
        const subDir = path.join(tmpDir, 'sub');
        fs.mkdirSync(subDir, { recursive: true });

        // Create a minimal PNG in sub directory
        const imgPath = path.join(subDir, 'pic.png');
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
        ]);
        fs.writeFileSync(imgPath, pngBytes);

        // Create MD file with relative image reference
        const mdPath = path.join(tmpDir, 'doc.md');
        fs.writeFileSync(mdPath, '# Hello\n\n![alt](sub/pic.png)\n\nMore text');

        const uris = [`file://${mdPath}`];
        const results = await processDropVscodeUrisImport(uris, ctx);

        expect(results).toHaveLength(1);
        expect(results[0].ok).toBe(true);

        if (results[0].ok && results[0].kind === 'md') {
            // The page should be created
            const pageFiles = fs.readdirSync(ctx.pageDir);
            expect(pageFiles.length).toBe(1);

            // Read the created page content
            const pageContent = fs.readFileSync(path.join(ctx.pageDir, pageFiles[0]), 'utf-8');

            // The image reference should be rewritten to point to images directory
            // (exact path depends on implementation, but should not be 'sub/pic.png')
            expect(pageContent).not.toContain('sub/pic.png');
        }
    });
});
