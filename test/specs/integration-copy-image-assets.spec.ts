/**
 * Integration test for copyImageAssets (T-3.12, FR-2)
 *
 * Tests main's existing copyImageAssets() which implements:
 * - srcPagesDir === destPagesDir でも常に新 filename で物理コピーする
 * - 1画像=1所有者 ポリシーを実現する
 *
 * DoD: DOD-3, DOD-5
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyImageAssets } from '../../src/shared/paste-asset-handler';

test.describe('Integration: copyImageAssets', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-image-assets-'));
    });

    test.afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('DOD-3: srcPagesDir === destPagesDir でも新 filename で物理コピーされる', () => {
        // Arrange: tmpDir に images/foo.png を作成
        const imagesDir = path.join(tmpDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        const srcImagePath = path.join(imagesDir, 'foo.png');
        fs.writeFileSync(srcImagePath, 'fake png data');

        const newNodeId = 'n1';
        const nodeImages = ['images/foo.png'];

        // Act: copyImageAssets を呼ぶ (srcPagesDir === destPagesDir)
        const result = copyImageAssets({
            srcPagesDir: tmpDir,
            destPagesDir: tmpDir,
            newNodeId: newNodeId,
            srcOutDir: tmpDir,
            destOutDir: tmpDir,
            nodeImages: nodeImages
        });

        // Assert: 戻り値の新 filename が 'images/copy-{newNodeId}-foo.png' 形式
        expect(result.newNodeImages).toHaveLength(1);
        expect(result.newNodeImages[0]).toMatch(/images\/copy-n1-foo\.png/);

        // Assert: 新ファイルが物理存在する
        const newImagePath = path.join(tmpDir, result.newNodeImages[0]);
        expect(fs.existsSync(newImagePath)).toBe(true);

        // Assert: 元ファイルも存在する (コピーであって移動ではない)
        expect(fs.existsSync(srcImagePath)).toBe(true);

        // Assert: 内容が同一
        const srcContent = fs.readFileSync(srcImagePath, 'utf-8');
        const destContent = fs.readFileSync(newImagePath, 'utf-8');
        expect(destContent).toBe(srcContent);
    });

    test('DOD-5: 入力 nodeImages !== 戻り値 newNodeImages (1画像=1所有者)', () => {
        // Arrange
        const imagesDir = path.join(tmpDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        const srcImagePath = path.join(imagesDir, 'original.png');
        fs.writeFileSync(srcImagePath, 'original content');

        const inputNodeImages = ['images/original.png'];
        const newNodeId = 'n2';

        // Act
        const result = copyImageAssets({
            srcPagesDir: tmpDir,
            destPagesDir: tmpDir,
            newNodeId: newNodeId,
            srcOutDir: tmpDir,
            destOutDir: tmpDir,
            nodeImages: inputNodeImages
        });

        // Assert: 入力配列 !== 戻り値配列 (要素レベルで比較)
        expect(result.newNodeImages).not.toEqual(inputNodeImages);
        expect(result.newNodeImages[0]).not.toBe(inputNodeImages[0]);

        // Assert: 両ファイルが物理存在する (複製が成功している)
        expect(fs.existsSync(srcImagePath)).toBe(true);
        const newImagePath = path.join(tmpDir, result.newNodeImages[0]);
        expect(fs.existsSync(newImagePath)).toBe(true);
    });

    test('複数画像の物理複製が正しく動作する', () => {
        // Arrange: 2つの画像を用意
        const imagesDir = path.join(tmpDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        fs.writeFileSync(path.join(imagesDir, 'img1.png'), 'image1');
        fs.writeFileSync(path.join(imagesDir, 'img2.jpg'), 'image2');

        const nodeImages = ['images/img1.png', 'images/img2.jpg'];
        const newNodeId = 'n3';

        // Act
        const result = copyImageAssets({
            srcPagesDir: tmpDir,
            destPagesDir: tmpDir,
            newNodeId: newNodeId,
            srcOutDir: tmpDir,
            destOutDir: tmpDir,
            nodeImages: nodeImages
        });

        // Assert: 2つの新ファイル名が生成される
        expect(result.newNodeImages).toHaveLength(2);
        expect(result.newNodeImages[0]).toMatch(/images\/copy-n3-img1\.png/);
        expect(result.newNodeImages[1]).toMatch(/images\/copy-n3-img2\.jpg/);

        // Assert: 全ファイルが物理存在する (元2つ + コピー2つ = 4ファイル)
        const files = fs.readdirSync(imagesDir);
        expect(files).toHaveLength(4);
        expect(files).toContain('img1.png');
        expect(files).toContain('img2.jpg');
        expect(files).toContain('copy-n3-img1.png');
        expect(files).toContain('copy-n3-img2.jpg');
    });

    test('nodeImages が空の場合は newNodeImages も空', () => {
        // Act
        const result = copyImageAssets({
            srcPagesDir: tmpDir,
            destPagesDir: tmpDir,
            newNodeId: 'n4',
            srcOutDir: tmpDir,
            destOutDir: tmpDir,
            nodeImages: []
        });

        // Assert
        expect(result.newNodeImages).toEqual([]);
    });
});
