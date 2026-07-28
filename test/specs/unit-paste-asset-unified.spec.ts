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

test.describe('ClipboardStore non-consumption (sprint 20260728-200503 — 旧 DOD-R12 を改訂)', () => {
    // 旧 DOD-R12 は「cut の cross message 処理後に consumeIfCut でストアを消す」ことを契約に
    // していたが、paste は node ごとに 1 message のため、1 個目の処理でストアを消すと
    // 2 個目以降の全 asset が store miss → silent no-op になるデータ整合バグ（cross-note
    // 全選択 paste で 1 個目の md だけ複製され以降全滅）を生んでいた。
    // 新契約: cross handler はストアを消費しない（次の copy/cut の save で上書き）。
    test('host handlers do NOT consume the store (multi-node paste keeps store alive)', async ({ page }) => {
        const fs = require('fs');
        const path = require('path');
        for (const rel of ['../../src/outlinerProvider.ts', '../../src/shared/notes-message-handler.ts']) {
            const content = fs.readFileSync(path.join(__dirname, rel), 'utf-8');
            // counterfactual: consumeIfCut 呼び出しが復活したら RED
            expect(content).not.toContain('consumeIfCut(');
        }
        // Store 本体からも one-shot 消費 API が消えている（コメント内の言及は許容）
        const storeSrc = fs.readFileSync(
            path.join(__dirname, '../../src/shared/outliner-clipboard-store.ts'), 'utf-8');
        expect(storeSrc).not.toMatch(/static\s+consumeIfCut/);
    });

    // ★番人（実挙動）: 「asset を持つ node 2 個以上」の cross paste 相当の連続 handler 呼び出しで
    //   2 個目以降も store が生きて実体コピーされる。counterfactual: one-shot 消費があると
    //   2 個目が store miss で dest に実体が作られず RED（今回の実バグの最小再現）。
    test('multi-asset cross paste: 2nd+ assets are copied (store survives 1st message)', async ({ page }) => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const ROOT = path.resolve(__dirname, '../..');
        // out/ の compiled store + handler 相当を直接駆動（vscode 非依存の純部分）
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { OutlinerClipboardStore } = require(path.join(ROOT, 'out/shared/outliner-clipboard-store.js'));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pah = require(path.join(ROOT, 'out/shared/paste-asset-handler.js'));

        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-cnp-src-'));
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-cnp-dest-'));
        try {
            fs.mkdirSync(path.join(src, 'images'));
            fs.writeFileSync(path.join(src, 'p1.md'), '# One\n');
            fs.writeFileSync(path.join(src, 'p2.md'), '# Two\n');
            fs.writeFileSync(path.join(src, 'images', 'pic.png'), 'PNG');

            OutlinerClipboardStore.save({
                plainText: 'n1\nn2\nn3', isCut: true,
                nodes: [], sourcePagesDirPath: src, sourceImagesDirPath: path.join(src, 'images'),
                sourceFileDirPath: path.join(src, 'files'), sourceOutDir: src,
            });

            // message[0]: page md（cut 経路 = 同名コピー）
            const clip1 = OutlinerClipboardStore.get('n1\nn2\nn3');
            expect(clip1).toBeTruthy();
            pah.handlePageAssets({
                srcOutDir: clip1.sourceOutDir, srcPagesDir: clip1.sourcePagesDirPath,
                destOutDir: dest, destPagesDir: dest,
                pageId: 'p1', newPageId: null, nodeImages: [], sameDirSkip: true,
            });
            // （旧実装はここで consumeIfCut → store null 化していた）

            // message[1]: 2 個目の page md — store が生きていること
            const clip2 = OutlinerClipboardStore.get('n1\nn2\nn3');
            expect(clip2).toBeTruthy();   // ★ counterfactual: 旧実装なら null = RED
            pah.handlePageAssets({
                srcOutDir: clip2.sourceOutDir, srcPagesDir: clip2.sourcePagesDirPath,
                destOutDir: dest, destPagesDir: dest,
                pageId: 'p2', newPageId: null, nodeImages: [], sameDirSkip: true,
            });

            // message[2]: 画像
            const clip3 = OutlinerClipboardStore.get('n1\nn2\nn3');
            expect(clip3).toBeTruthy();
            pah.moveImageAssets({
                srcOutDir: clip3.sourceOutDir, srcPagesDir: clip3.sourcePagesDirPath,
                destOutDir: dest, destPagesDir: dest,
                nodeImages: ['images/pic.png'],
            });

            // 全 asset が dest に実体化されている（今回の実バグでは p2/pic が欠落していた）
            expect(fs.existsSync(path.join(dest, 'p1.md'))).toBe(true);
            expect(fs.existsSync(path.join(dest, 'p2.md'))).toBe(true);
            expect(fs.existsSync(path.join(dest, 'images', 'pic.png'))).toBe(true);
        } finally {
            fs.rmSync(src, { recursive: true, force: true });
            fs.rmSync(dest, { recursive: true, force: true });
        }
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
