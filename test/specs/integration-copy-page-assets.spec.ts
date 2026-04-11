/**
 * FR-2 / v7.2 copyPageAssets Integration Test
 *
 * copyPageAssets() の既存実装 (paste-asset-handler.ts) を検証。
 * 4 ケース:
 *   1. srcPagesDir === destPagesDir で page + md本文画像が複製される
 *   2. cross-outliner (srcPagesDir !== destPagesDir) で動作する
 *   3. 画像参照のない .md でも .md だけ複製される
 *   4. node.images[] と併用で両方複製される
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyPageAssets } from '../../src/shared/paste-asset-handler';

test.describe('FR-2 / v7.2 copyPageAssets Integration', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-page-assets-'));
    });

    test.afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('基本: srcPagesDir === destPagesDir で page + md本文画像が複製される', () => {
        // Setup: src pagesDir に page1.md と images/foo.png
        const outDir = tmpDir;
        const pagesDir = path.join(tmpDir, 'pages');
        const imagesDir = path.join(pagesDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        const fooPath = path.join(imagesDir, 'foo.png');
        fs.writeFileSync(fooPath, 'fake png data');

        const page1Path = path.join(pagesDir, 'page1.md');
        fs.writeFileSync(page1Path, '# Test\n\n![](images/foo.png)\n');

        // Execute
        const result = copyPageAssets({
            srcOutDir: outDir,
            srcPagesDir: pagesDir,
            destOutDir: outDir,
            destPagesDir: pagesDir,
            sourcePageId: 'page1',
            newPageId: 'page2',
            nodeImages: []
        });

        // Assert: page2.md が作成される
        const page2Path = path.join(pagesDir, 'page2.md');
        expect(fs.existsSync(page2Path)).toBeTruthy();

        // Assert: page2.md の本文で画像参照が rewrite されている
        const page2Content = fs.readFileSync(page2Path, 'utf8');
        expect(page2Content).toContain('copy-page2-foo.png');
        expect(page2Content).not.toContain('](images/foo.png)');

        // Assert: 複製画像が物理存在
        const copiedFooPath = path.join(imagesDir, 'copy-page2-foo.png');
        expect(fs.existsSync(copiedFooPath)).toBeTruthy();

        // Assert: 元の page1.md と foo.png も存続 (1画像=1所有者)
        expect(fs.existsSync(page1Path)).toBeTruthy();
        expect(fs.existsSync(fooPath)).toBeTruthy();
    });

    test('cross-outliner: srcPagesDir !== destPagesDir', () => {
        // src と dest が異なる outliner
        const srcOutDir = path.join(tmpDir, 'src');
        const srcPagesDir = path.join(srcOutDir, 'pages');
        const srcImagesDir = path.join(srcPagesDir, 'images');
        fs.mkdirSync(srcImagesDir, { recursive: true });

        const destOutDir = path.join(tmpDir, 'dest');
        const destPagesDir = path.join(destOutDir, 'pages');
        fs.mkdirSync(destPagesDir, { recursive: true });

        const srcFooPath = path.join(srcImagesDir, 'foo.png');
        fs.writeFileSync(srcFooPath, 'fake png data');

        const srcPage1Path = path.join(srcPagesDir, 'page1.md');
        fs.writeFileSync(srcPage1Path, '# Src\n\n![](images/foo.png)\n');

        // Execute
        copyPageAssets({
            srcOutDir,
            srcPagesDir,
            destOutDir,
            destPagesDir,
            sourcePageId: 'page1',
            newPageId: 'page2',
            nodeImages: []
        });

        // Assert: dest 側に page2.md と画像が存在
        const destPage2Path = path.join(destPagesDir, 'page2.md');
        expect(fs.existsSync(destPage2Path)).toBeTruthy();

        const destImagesDir = path.join(destPagesDir, 'images');
        const destFooPath = path.join(destImagesDir, 'copy-page2-foo.png');
        expect(fs.existsSync(destFooPath)).toBeTruthy();

        // src 側の元ファイルも存続
        expect(fs.existsSync(srcFooPath)).toBeTruthy();
        expect(fs.existsSync(srcPage1Path)).toBeTruthy();
    });

    test('画像参照なし page でも .md だけ複製される', () => {
        const outDir = tmpDir;
        const pagesDir = path.join(tmpDir, 'pages');
        fs.mkdirSync(pagesDir, { recursive: true });

        const page1Path = path.join(pagesDir, 'page1.md');
        fs.writeFileSync(page1Path, '# No images\n\nJust text.\n');

        copyPageAssets({
            srcOutDir: outDir,
            srcPagesDir: pagesDir,
            destOutDir: outDir,
            destPagesDir: pagesDir,
            sourcePageId: 'page1',
            newPageId: 'page2',
            nodeImages: []
        });

        const page2Path = path.join(pagesDir, 'page2.md');
        expect(fs.existsSync(page2Path)).toBeTruthy();

        const page2Content = fs.readFileSync(page2Path, 'utf8');
        expect(page2Content).toContain('Just text');
    });

    test('node.images[] と併用: isPage + node.images[] 両方複製される', () => {
        const outDir = tmpDir;
        const pagesDir = path.join(tmpDir, 'pages');
        const imagesDir = path.join(pagesDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        const nodeImagePath = path.join(imagesDir, 'node-img.png');
        fs.writeFileSync(nodeImagePath, 'node img data');

        const page1Path = path.join(pagesDir, 'page1.md');
        fs.writeFileSync(page1Path, '# Page\n\nNo md images.\n');

        const result = copyPageAssets({
            srcOutDir: outDir,
            srcPagesDir: pagesDir,
            destOutDir: outDir,
            destPagesDir: pagesDir,
            sourcePageId: 'page1',
            newPageId: 'page2',
            nodeImages: ['pages/images/node-img.png']
        });

        // node images も複製されたか確認 (result.newNodeImages)
        expect(result.newNodeImages).toBeDefined();
        expect(result.newNodeImages.length).toBe(1);
        expect(result.newNodeImages[0]).toContain('copy-page2-node-img.png');

        // 複製ファイルが物理存在
        const copiedNodeImgPath = path.join(imagesDir, 'copy-page2-node-img.png');
        expect(fs.existsSync(copiedNodeImgPath)).toBeTruthy();
    });
});
