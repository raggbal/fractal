/**
 * Unit tests for unified paste-asset-handler functions (v9.1 refactoring)
 * Tests handlePageAssets, handleImageAssets, handleFileAsset
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    handlePageAssets,
    handleImageAssets,
    handleFileAsset,
    // Legacy wrappers
    copyPageAssets,
    movePageAssets,
    copyImageAssets,
    moveImageAssets,
    copyFileAsset,
    moveFileAsset
} from '../../src/shared/paste-asset-handler';

// Use unique test dir per worker to avoid parallel test interference
const testDir = path.join(__dirname, '../.test-unified-assets-' + (process.env.TEST_WORKER_INDEX || '0'));

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanupTestDir(): void {
    if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
}

test.describe('handlePageAssets', () => {
    test.beforeEach(() => {
        cleanupTestDir();
        ensureDir(testDir);
    });

    test.afterEach(() => {
        cleanupTestDir();
    });

    test('should copy without rename when newPageId is null (DOD-R1)', () => {
        // Arrange: setup source with .md and images
        const srcPagesDir = path.join(testDir, 'src/pages');
        const srcOutDir = path.join(testDir, 'src');
        const destPagesDir = path.join(testDir, 'dest/pages');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcPagesDir);
        const srcImagesDir = path.join(srcPagesDir, 'images');
        ensureDir(srcImagesDir);

        const pageId = 'page-123';
        fs.writeFileSync(path.join(srcPagesDir, `${pageId}.md`), '# Test\n![img](images/test.png)');
        fs.writeFileSync(path.join(srcImagesDir, 'test.png'), 'fake image data');

        // Act: call with newPageId=null (cut behavior)
        const result = handlePageAssets({
            srcOutDir,
            srcPagesDir,
            destOutDir,
            destPagesDir,
            pageId,
            newPageId: null,
            nodeImages: ['pages/images/test.png'],
            sameDirSkip: false
        });

        // Assert: files copied with same basename (no prefix)
        const destMdPath = path.join(destPagesDir, `${pageId}.md`);
        const destImgPath = path.join(destPagesDir, 'images/test.png');
        expect(fs.existsSync(destMdPath)).toBe(true);
        expect(fs.existsSync(destImgPath)).toBe(true);
        expect(result.newNodeImages).toEqual(['pages/images/test.png']);
    });

    test('should copy with rename when newPageId is set (DOD-R2)', () => {
        // Arrange
        const srcPagesDir = path.join(testDir, 'src/pages');
        const srcOutDir = path.join(testDir, 'src');
        const destPagesDir = path.join(testDir, 'dest/pages');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcPagesDir);
        const srcImagesDir = path.join(srcPagesDir, 'images');
        ensureDir(srcImagesDir);

        const sourcePageId = 'page-123';
        const newPageId = 'page-456';
        fs.writeFileSync(path.join(srcPagesDir, `${sourcePageId}.md`), '# Test\n![img](images/test.png)');
        fs.writeFileSync(path.join(srcImagesDir, 'test.png'), 'fake image data');

        // Act: call with newPageId set (copy behavior)
        const result = handlePageAssets({
            srcOutDir,
            srcPagesDir,
            destOutDir,
            destPagesDir,
            pageId: sourcePageId,
            newPageId,
            nodeImages: ['pages/images/test.png'],
            sameDirSkip: false
        });

        // Assert: files copied with copy-{newPageId}- prefix
        const destMdPath = path.join(destPagesDir, `${newPageId}.md`);
        const destImgPath = path.join(destPagesDir, 'images', `copy-${newPageId}-test.png`);
        expect(fs.existsSync(destMdPath)).toBe(true);
        expect(fs.existsSync(destImgPath)).toBe(true);
        expect(result.newNodeImages[0]).toContain(`copy-${newPageId}-test.png`);
    });

    test('should return no-op when sameDirSkip=true and same dir (DOD-R3)', () => {
        // Arrange: same source and dest
        const pagesDir = path.join(testDir, 'pages');
        const outDir = testDir;
        ensureDir(pagesDir);
        const imagesDir = path.join(pagesDir, 'images');
        ensureDir(imagesDir);

        const pageId = 'page-123';
        fs.writeFileSync(path.join(pagesDir, `${pageId}.md`), '# Test');
        fs.writeFileSync(path.join(imagesDir, 'test.png'), 'fake');

        const nodeImages = ['pages/images/test.png'];

        // Act: same dir + sameDirSkip=true
        const result = handlePageAssets({
            srcOutDir: outDir,
            srcPagesDir: pagesDir,
            destOutDir: outDir,
            destPagesDir: pagesDir,
            pageId,
            newPageId: null,
            nodeImages,
            sameDirSkip: true
        });

        // Assert: original nodeImages returned unchanged
        expect(result.newNodeImages).toEqual(nodeImages);
    });
});

test.describe('handleImageAssets', () => {
    test.beforeEach(() => {
        cleanupTestDir();
        ensureDir(testDir);
    });

    test.afterEach(() => {
        cleanupTestDir();
    });

    test('should copy without rename when renamePrefix is null (DOD-R4)', () => {
        // Arrange
        const srcPagesDir = path.join(testDir, 'src/pages');
        const srcOutDir = path.join(testDir, 'src');
        const destPagesDir = path.join(testDir, 'dest/pages');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcPagesDir);
        const srcImagesDir = path.join(srcPagesDir, 'images');
        ensureDir(srcImagesDir);

        fs.writeFileSync(path.join(srcImagesDir, 'image1.png'), 'fake1');

        // Act: renamePrefix=null (cut behavior)
        const result = handleImageAssets({
            srcOutDir,
            srcPagesDir,
            destOutDir,
            destPagesDir,
            renamePrefix: null,
            nodeImages: ['pages/images/image1.png'],
            sameDirSkip: false
        });

        // Assert: same basename
        const destImgPath = path.join(destPagesDir, 'images/image1.png');
        expect(fs.existsSync(destImgPath)).toBe(true);
        expect(result.newNodeImages).toEqual(['pages/images/image1.png']);
    });

    test('should copy with prefix when renamePrefix is set (DOD-R5)', () => {
        // Arrange
        const srcPagesDir = path.join(testDir, 'src/pages');
        const srcOutDir = path.join(testDir, 'src');
        const destPagesDir = path.join(testDir, 'dest/pages');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcPagesDir);
        const srcImagesDir = path.join(srcPagesDir, 'images');
        ensureDir(srcImagesDir);

        fs.writeFileSync(path.join(srcImagesDir, 'image1.png'), 'fake1');

        // Act: renamePrefix set (copy behavior)
        const renamePrefix = 'copy-abc-';
        const result = handleImageAssets({
            srcOutDir,
            srcPagesDir,
            destOutDir,
            destPagesDir,
            renamePrefix,
            nodeImages: ['pages/images/image1.png'],
            sameDirSkip: false
        });

        // Assert: prefixed name
        const destImgPath = path.join(destPagesDir, 'images', `${renamePrefix}image1.png`);
        expect(fs.existsSync(destImgPath)).toBe(true);
        expect(result.newNodeImages[0]).toContain(`${renamePrefix}image1.png`);
    });
});

test.describe('ClipboardStore consumption (DOD-R12)', () => {
    test('host handler calls consumeIfCut only when isCut=true', async ({ page }) => {
        // This is a source-code verification test
        // Read the outlinerProvider.ts to verify the pattern
        const fs = require('fs');
        const path = require('path');
        const providerPath = path.join(__dirname, '../../src/outlinerProvider.ts');
        const providerContent = fs.readFileSync(providerPath, 'utf-8');

        // Verify handlePageAssetsCross handler
        const handlePageAssetsCrossMatch = providerContent.match(
            /case\s+'handlePageAssetsCross'[\s\S]*?if\s*\(\s*message\.isCut\s*\)\s*\{[\s\S]*?consumeIfCut\s*\(\s*message\.clipboardPlainText\s*\)/
        );
        expect(handlePageAssetsCrossMatch).toBeTruthy();

        // Verify handleFileAssetCross handler
        const handleFileAssetCrossMatch = providerContent.match(
            /case\s+'handleFileAssetCross'[\s\S]*?if\s*\(\s*message\.isCut\s*\)\s*\{[\s\S]*?consumeIfCut\s*\(\s*message\.clipboardPlainText\s*\)/
        );
        expect(handleFileAssetCrossMatch).toBeTruthy();

        // Verify copyImagesCross handler (should also have the same pattern)
        const copyImagesCrossMatch = providerContent.match(
            /case\s+'copyImagesCross'[\s\S]*?if\s*\(\s*message\.isCut\s*\)\s*\{[\s\S]*?consumeIfCut\s*\(\s*message\.clipboardPlainText\s*\)/
        );
        expect(copyImagesCrossMatch).toBeTruthy();
    });
});

test.describe('handleFileAsset', () => {
    test.beforeEach(() => {
        cleanupTestDir();
        ensureDir(testDir);
    });

    test.afterEach(() => {
        cleanupTestDir();
    });

    test('should copy with original name when useCollisionSuffix=false (DOD-R6)', () => {
        // Arrange
        const srcFileDir = path.join(testDir, 'src/files');
        const srcOutDir = path.join(testDir, 'src');
        const destFileDir = path.join(testDir, 'dest/files');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcFileDir);

        const fileName = 'report.pdf';
        fs.writeFileSync(path.join(srcFileDir, fileName), 'fake pdf');

        // Act: useCollisionSuffix=false (cut behavior)
        const result = handleFileAsset({
            srcOutDir,
            srcFileDir,
            destOutDir,
            destFileDir,
            filePath: `files/${fileName}`,
            useCollisionSuffix: false,
            sameDirSkip: false
        });

        // Assert: original name
        const destFilePath = path.join(destFileDir, fileName);
        expect(fs.existsSync(destFilePath)).toBe(true);
        expect(result.newFilePath).toBe(`files/${fileName}`);
    });

    test('should add collision suffix when useCollisionSuffix=true (DOD-R7)', () => {
        // Arrange
        const srcFileDir = path.join(testDir, 'src/files');
        const srcOutDir = path.join(testDir, 'src');
        const destFileDir = path.join(testDir, 'dest/files');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcFileDir);
        ensureDir(destFileDir);

        const fileName = 'report.pdf';
        fs.writeFileSync(path.join(srcFileDir, fileName), 'fake pdf');
        // Pre-create collision
        fs.writeFileSync(path.join(destFileDir, fileName), 'existing');

        // Act: useCollisionSuffix=true (copy behavior)
        const result = handleFileAsset({
            srcOutDir,
            srcFileDir,
            destOutDir,
            destFileDir,
            filePath: `files/${fileName}`,
            useCollisionSuffix: true,
            sameDirSkip: false
        });

        // Assert: collision suffix added
        const destFilePath = path.join(destFileDir, 'report-1.pdf');
        expect(fs.existsSync(destFilePath)).toBe(true);
        expect(result.newFilePath).toBe('files/report-1.pdf');
    });
});

test.describe('Legacy wrapper functions', () => {
    test.beforeEach(() => {
        cleanupTestDir();
        ensureDir(testDir);
    });

    test.afterEach(() => {
        cleanupTestDir();
    });

    test('should produce same results via copyPageAssets wrapper (DOD-R8)', () => {
        // Arrange
        const srcPagesDir = path.join(testDir, 'src/pages');
        const srcOutDir = path.join(testDir, 'src');
        const destPagesDir = path.join(testDir, 'dest/pages');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcPagesDir);
        const srcImagesDir = path.join(srcPagesDir, 'images');
        ensureDir(srcImagesDir);

        const sourcePageId = 'page-123';
        const newPageId = 'page-456';
        fs.writeFileSync(path.join(srcPagesDir, `${sourcePageId}.md`), '# Test');
        fs.writeFileSync(path.join(srcImagesDir, 'test.png'), 'fake');

        // Act: call legacy wrapper
        const result = copyPageAssets({
            srcOutDir,
            srcPagesDir,
            destOutDir,
            destPagesDir,
            sourcePageId,
            newPageId,
            nodeImages: ['pages/images/test.png']
        });

        // Assert: produces same result as handlePageAssets with newPageId set
        const destImgPath = path.join(destPagesDir, 'images', `copy-${newPageId}-test.png`);
        expect(fs.existsSync(destImgPath)).toBe(true);
        expect(result.newNodeImages[0]).toContain(`copy-${newPageId}-test.png`);
    });

    test('should produce same results via movePageAssets wrapper (DOD-R8)', () => {
        // Arrange
        const srcPagesDir = path.join(testDir, 'src/pages');
        const srcOutDir = path.join(testDir, 'src');
        const destPagesDir = path.join(testDir, 'dest/pages');
        const destOutDir = path.join(testDir, 'dest');
        ensureDir(srcPagesDir);
        const srcImagesDir = path.join(srcPagesDir, 'images');
        ensureDir(srcImagesDir);

        const pageId = 'page-123';
        fs.writeFileSync(path.join(srcPagesDir, `${pageId}.md`), '# Test');
        fs.writeFileSync(path.join(srcImagesDir, 'test.png'), 'fake');

        // Act: call legacy wrapper
        const result = movePageAssets({
            srcOutDir,
            srcPagesDir,
            destOutDir,
            destPagesDir,
            pageId,
            nodeImages: ['pages/images/test.png']
        });

        // Assert: produces same result as handlePageAssets with newPageId=null
        const destImgPath = path.join(destPagesDir, 'images/test.png');
        expect(fs.existsSync(destImgPath)).toBe(true);
        expect(result.newNodeImages).toEqual(['pages/images/test.png']);
    });
});
