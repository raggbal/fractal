/**
 * v7 Cleanup Logic Unit Tests
 * - DOD-11: handleRemovePage has no workspace.fs.delete
 * - DOD-24: src/ has no unlinkSync/rmSync/rmdirSync
 * - DOD-15, 16, 31: FR-5 cleanup logic (Pass 1, Pass 2, false positive)
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { buildLiveSetPass1, buildPass2LiveImages, listAllMd, listAllImages, walkRecursive } from '../../src/shared/cleanup-core';

const projectRoot = path.resolve(__dirname, '../..');

test.describe('v7 Cleanup Logic - Static Verification', () => {
    test('DOD-11: handleRemovePage does not call workspace.fs.delete', () => {
        const cmd = `grep -n 'workspace.fs.delete' "${projectRoot}/src/outlinerProvider.ts" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' });

        // handleRemovePage 関数内 (L753-766 付近) に workspace.fs.delete があってはならない
        const lines = output.split('\n').filter(line => line.trim());
        const inHandleRemovePage = lines.some(line => {
            const lineNum = parseInt(line.split(':')[0], 10);
            return lineNum >= 753 && lineNum <= 770;
        });

        expect(inHandleRemovePage).toBe(false);
    });

    test('DOD-24: src/ has no immediate delete APIs (unlinkSync, rmSync, rmdirSync)', () => {
        const cmd = `grep -rn 'unlinkSync\\|rmSync\\|rmdirSync' "${projectRoot}/src/" --include='*.ts' --include='*.js' | grep -v 'test/' | grep -v 'paste-asset-handler.ts' || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();

        // paste-asset-handler.ts は例外 (cross-outliner cut-paste の move semantics)
        // notes-s3-sync.ts は v7.1 で vscode.workspace.fs.delete に修正済み
        expect(output).toBe('');
    });
});

test.describe('FR-5 Cleanup Logic - buildLiveSetPass1', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
    });

    test.afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('DOD-15: Pass 1 detects orphan md correctly', async () => {
        // Setup: .out with node.pageId='p1', and page files p1.md (alive), p2.md (orphan), p3.md (orphan)
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId: 'p1' },
                b: { text: 'Node B' } // no pageId
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        const pagesDir = path.join(tmpDir, 'pages');
        fs.mkdirSync(pagesDir);
        fs.writeFileSync(path.join(pagesDir, 'p1.md'), 'Alive page 1', 'utf8');
        fs.writeFileSync(path.join(pagesDir, 'p2.md'), 'Orphan page 2', 'utf8');
        fs.writeFileSync(path.join(pagesDir, 'p3.md'), 'Orphan page 3', 'utf8');

        // Execute
        const { liveMd } = await buildLiveSetPass1([outFile], tmpDir);

        // Verify
        const expectedAliveMd = path.join(pagesDir, 'p1.md');
        expect(liveMd.has(expectedAliveMd)).toBe(true);
        expect(liveMd.has(path.join(pagesDir, 'p2.md'))).toBe(false);
        expect(liveMd.has(path.join(pagesDir, 'p3.md'))).toBe(false);

        // Orphan detection
        const allMd = await listAllMd(tmpDir);
        const orphanMd = allMd.filter(p => !liveMd.has(p));
        expect(orphanMd).toContain(path.join(pagesDir, 'p2.md'));
        expect(orphanMd).toContain(path.join(pagesDir, 'p3.md'));
        expect(orphanMd.length).toBe(2);
    });

    test('DOD-16: Pass 2 detects orphan images correctly', async () => {
        // Setup: .out with node.images=['images/live.png'], alive md with ![](images/aliveImg.png), orphan md (p_orphan.md) with ![](images/orphanImg.png), unused.png
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId: 'p1', images: ['images/live.png'] },
                b: { text: 'Node B' } // no pageId - so p_orphan.md becomes orphan
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        const pagesDir = path.join(tmpDir, 'pages');
        const imagesDir = path.join(pagesDir, 'images');
        fs.mkdirSync(pagesDir);
        fs.mkdirSync(imagesDir);

        // alive md with image ref
        fs.writeFileSync(path.join(pagesDir, 'p1.md'), '# Page 1\n![](images/aliveImg.png)', 'utf8');
        // orphan md with image ref
        fs.writeFileSync(path.join(pagesDir, 'p_orphan.md'), '# Orphan Page\n![](images/orphanImg.png)', 'utf8');

        // Physical images
        fs.writeFileSync(path.join(imagesDir, 'live.png'), 'live', 'utf8');
        fs.writeFileSync(path.join(imagesDir, 'aliveImg.png'), 'aliveImg', 'utf8');
        fs.writeFileSync(path.join(imagesDir, 'orphanImg.png'), 'orphanImg', 'utf8');
        fs.writeFileSync(path.join(imagesDir, 'unused.png'), 'unused', 'utf8');

        // Execute Pass 1
        const { liveMd: liveMdPass1, liveImages: liveImagesPass1 } = await buildLiveSetPass1([outFile], tmpDir);

        // After Pass 1: liveMd has p1.md only, liveImages has live.png
        expect(liveMdPass1.has(path.join(pagesDir, 'p1.md'))).toBe(true);
        expect(liveImagesPass1.has(path.join(imagesDir, 'live.png'))).toBe(true);

        // Pass 2: Use buildPass2LiveImages
        const liveImagesPass2 = await buildPass2LiveImages(liveMdPass1, liveImagesPass1, tmpDir);

        // Verify
        expect(liveImagesPass2.has(path.join(imagesDir, 'live.png'))).toBe(true);
        expect(liveImagesPass2.has(path.join(imagesDir, 'aliveImg.png'))).toBe(true);
        expect(liveImagesPass2.has(path.join(imagesDir, 'orphanImg.png'))).toBe(false);
        expect(liveImagesPass2.has(path.join(imagesDir, 'unused.png'))).toBe(false);

        // Orphan detection
        const allImages = await listAllImages(tmpDir);
        const orphanImages = allImages.filter(p => !liveImagesPass2.has(p));
        expect(orphanImages).toContain(path.join(imagesDir, 'orphanImg.png'));
        expect(orphanImages).toContain(path.join(imagesDir, 'unused.png'));
        expect(orphanImages.length).toBe(2);
    });

    test('DOD-31: No false positives - alive files not detected as orphan', async () => {
        // Setup: All files are alive
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId: 'p1', images: ['images/img1.png'] },
                b: { text: 'Node B', pageId: 'p2', images: ['images/img2.png'] }
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        const pagesDir = path.join(tmpDir, 'pages');
        const imagesDir = path.join(pagesDir, 'images');
        fs.mkdirSync(pagesDir);
        fs.mkdirSync(imagesDir);

        fs.writeFileSync(path.join(pagesDir, 'p1.md'), '# Page 1\n![](images/img3.png)', 'utf8');
        fs.writeFileSync(path.join(pagesDir, 'p2.md'), '# Page 2', 'utf8');
        fs.writeFileSync(path.join(imagesDir, 'img1.png'), 'img1', 'utf8');
        fs.writeFileSync(path.join(imagesDir, 'img2.png'), 'img2', 'utf8');
        fs.writeFileSync(path.join(imagesDir, 'img3.png'), 'img3', 'utf8');

        // Execute
        const { liveMd, liveImages: liveImagesPass1 } = await buildLiveSetPass1([outFile], tmpDir);

        // Pass 2
        const liveImagesPass2 = await buildPass2LiveImages(liveMd, liveImagesPass1, tmpDir);

        // Verify: No orphans
        const allMd = await listAllMd(tmpDir);
        const orphanMd = allMd.filter(p => !liveMd.has(p));
        const allImages = await listAllImages(tmpDir);
        const orphanImages = allImages.filter(p => !liveImagesPass2.has(p));

        expect(orphanMd.length).toBe(0);
        expect(orphanImages.length).toBe(0);
    });

    test('DOD-18: walkRecursive scope restriction', async () => {
        // Setup
        const subDir = path.join(tmpDir, 'subdir');
        fs.mkdirSync(subDir);
        fs.writeFileSync(path.join(tmpDir, 'test.png'), 'test', 'utf8');
        fs.writeFileSync(path.join(subDir, 'nested.png'), 'nested', 'utf8');

        // Execute
        const result = walkRecursive(tmpDir, ['.png']);

        // Verify: all paths start with tmpDir
        for (const p of result) {
            expect(p.startsWith(tmpDir)).toBe(true);
        }
        expect(result).toContain(path.join(tmpDir, 'test.png'));
        expect(result).toContain(path.join(subDir, 'nested.png'));
    });
});
