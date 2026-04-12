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
import { buildLiveSetPass1, buildPass2LiveImages, listAllMd, listAllImages, walkRecursive, scanSingleNoteCore, buildAllNotesCleanupGrouped } from '../../src/shared/cleanup-core';

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

    test('v7.2: switchTab に s3 参照が残っていない', () => {
        const cmd = `grep -n "'s3'" "${projectRoot}/src/shared/notes-file-panel.js" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).toBe('');
    });

    test('v7.2: fractal.cleanUnusedFilesInCurrentNote コマンドが package.json に登録されている', () => {
        const cmd = `grep -n 'fractal.cleanUnusedFilesInCurrentNote' "${projectRoot}/package.json" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });

    test('v7.2: filePanelCleanupCurrent ボタンが notes-body-html.js に存在する', () => {
        const cmd = `grep -n 'filePanelCleanupCurrent' "${projectRoot}/src/shared/notes-body-html.js" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });

    test('v7.2: cleanupUnusedFilesCurrentNote bridge メソッドが notes-host-bridge.js に存在する', () => {
        const cmd = `grep -n 'cleanupUnusedFilesCurrentNote' "${projectRoot}/src/shared/notes-host-bridge.js" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).not.toBe('');
    });

    test('v7.2: i18n notesCleanUnusedCurrentNote キーが en/ja に存在する', () => {
        const en = execSync(`grep -n 'notesCleanUnusedCurrentNote' "${projectRoot}/src/i18n/locales/en.ts" || true`, { encoding: 'utf-8' }).trim();
        const ja = execSync(`grep -n 'notesCleanUnusedCurrentNote' "${projectRoot}/src/i18n/locales/ja.ts" || true`, { encoding: 'utf-8' }).trim();
        expect(en).not.toBe('');
        expect(ja).not.toBe('');
    });

    test('v7.2: Tools タブの CSS に border がない', () => {
        const cmd = `grep -A3 'file-panel-tools-section' "${projectRoot}/src/shared/notes-body-html.js" | grep 'border' || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();
        expect(output).toBe('');
    });

    test('DOD-24: src/ has no immediate delete APIs (unlinkSync, rmSync, rmdirSync)', () => {
        const cmd = `grep -rn 'unlinkSync\\|rmSync\\|rmdirSync' "${projectRoot}/src/" --include='*.ts' --include='*.js' | grep -v 'test/' | grep -v 'paste-asset-handler.ts' | grep -v 'notes-s3-sync.ts' || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();

        // 例外 (v7.1 DOD-24 の除外リスト):
        // - paste-asset-handler.ts: cross-outliner cut-paste の move semantics (実害ゼロ)
        // - notes-s3-sync.ts: S3 同期処理、リモートから再取得できる即時削除セマンティクス
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
        // Setup: node.images は outDir 基準 ('pages/images/live.png')
        // md 本文の ![](...) は mdDir 基準 ('images/aliveImg.png')
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId: 'p1', images: ['pages/images/live.png'] },
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
        // Setup: All files are alive. node.images は outDir 基準 ('pages/images/*')
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId: 'p1', images: ['pages/images/img1.png'] },
                b: { text: 'Node B', pageId: 'p2', images: ['pages/images/img2.png'] }
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

test.describe('FR-7 All Notes Cleanup Mode (v7.2)', () => {
    let tmpRoot: string;
    let note1: string;
    let note2: string;

    test.beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'all-notes-test-'));
        note1 = path.join(tmpRoot, 'note1');
        note2 = path.join(tmpRoot, 'note2');
        fs.mkdirSync(note1);
        fs.mkdirSync(note2);
    });

    test.afterEach(() => {
        if (tmpRoot && fs.existsSync(tmpRoot)) {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    /**
     * Helper: setup a note with .out, alive md, orphan md, alive image, orphan image
     * 実際の保存形式: node.images は outDir 基準の相対パス
     * (notesEditorProvider.ts:298 の path.relative(outDir, destPath) に準拠)
     */
    function setupNote(mainFolderPath: string, opts: {
        outFileName: string;
        aliveMdId: string;
        orphanMdName: string;
        aliveImageName: string;
        orphanImageName: string;
    }): void {
        const outFile = path.join(mainFolderPath, opts.outFileName);
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                // images は outDir 基準 → 'pages/images/xxx.png' (not './images/xxx.png')
                a: { text: 'Node A', pageId: opts.aliveMdId, images: [`pages/images/${opts.aliveImageName}`] }
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        const pagesDir = path.join(mainFolderPath, 'pages');
        const imagesDir = path.join(pagesDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        // alive md
        fs.writeFileSync(path.join(pagesDir, `${opts.aliveMdId}.md`), 'alive page\n', 'utf8');
        // orphan md (not referenced by any node.pageId)
        fs.writeFileSync(path.join(pagesDir, opts.orphanMdName), 'orphan page\n', 'utf8');
        // alive image
        fs.writeFileSync(path.join(imagesDir, opts.aliveImageName), 'alive img', 'utf8');
        // orphan image
        fs.writeFileSync(path.join(imagesDir, opts.orphanImageName), 'orphan img', 'utf8');
    }

    test('DOD-37: runNotesCleanup が mainFolderPaths 配列の全 note をスキャンする', async () => {
        // Setup 2 notes with orphans
        setupNote(note1, {
            outFileName: 'a.out',
            aliveMdId: 'p1',
            orphanMdName: 'orphan1.md',
            aliveImageName: 'live1.png',
            orphanImageName: 'unused1.png'
        });
        setupNote(note2, {
            outFileName: 'b.out',
            aliveMdId: 'p2',
            orphanMdName: 'orphan2.md',
            aliveImageName: 'live2.png',
            orphanImageName: 'unused2.png'
        });

        // Execute
        const grouped = await buildAllNotesCleanupGrouped([note1, note2]);

        // Verify: 2 note 分の Map エントリが存在
        expect(grouped.size).toBe(2);
        expect(grouped.has(note1)).toBe(true);
        expect(grouped.has(note2)).toBe(true);

        // 各 note に orphan md と orphan image が検出される
        const note1Candidates = grouped.get(note1)!;
        expect(note1Candidates.length).toBe(2); // orphan1.md + unused1.png
        expect(note1Candidates.some(c => c.type === 'orphan-md' && c.relPath.includes('orphan1.md'))).toBe(true);
        expect(note1Candidates.some(c => c.type === 'orphan-image' && c.relPath.includes('unused1.png'))).toBe(true);

        const note2Candidates = grouped.get(note2)!;
        expect(note2Candidates.length).toBe(2);
        expect(note2Candidates.some(c => c.relPath.includes('orphan2.md'))).toBe(true);
        expect(note2Candidates.some(c => c.relPath.includes('unused2.png'))).toBe(true);

        // alive ファイルは候補に含まれない (false positive 0、DOD-31 とも重複検証)
        for (const candidates of grouped.values()) {
            expect(candidates.every(c => !c.relPath.includes('live'))).toBe(true);
            expect(candidates.every(c => !c.relPath.endsWith('p1.md'))).toBe(true);
            expect(candidates.every(c => !c.relPath.endsWith('p2.md'))).toBe(true);
        }
    });

    test('DOD-38: 複数 note の候補が note ごとに Map エントリとして grouping される', async () => {
        // 3 notes 用意、うち 1 つは orphan なし
        setupNote(note1, {
            outFileName: 'a.out',
            aliveMdId: 'p1',
            orphanMdName: 'orphan1.md',
            aliveImageName: 'live1.png',
            orphanImageName: 'unused1.png'
        });
        // note2 は orphan なし
        const outFile2 = path.join(note2, 'clean.out');
        fs.writeFileSync(outFile2, JSON.stringify({
            title: 'Clean',
            pageDir: './pages',
            nodes: { x: { text: 'x', pageId: 'xp1' } }
        }, null, 2), 'utf8');
        const pagesDir2 = path.join(note2, 'pages');
        fs.mkdirSync(pagesDir2);
        fs.writeFileSync(path.join(pagesDir2, 'xp1.md'), 'alive', 'utf8');

        // Execute
        const grouped = await buildAllNotesCleanupGrouped([note1, note2]);

        // orphan があった note のみ Map に入る
        expect(grouped.size).toBe(1);
        expect(grouped.has(note1)).toBe(true);
        expect(grouped.has(note2)).toBe(false);

        // showCleanupQuickPickGrouped で Separator を作る時の前提: 各 key が note ごとに分離されている
        const keys = Array.from(grouped.keys());
        expect(keys.length).toBe(1);
        expect(keys[0]).toBe(note1);
    });

    test('DOD-39: 空の mainFolderPaths 配列で Map が空になる', async () => {
        // Execute: empty array
        const grouped = await buildAllNotesCleanupGrouped([]);

        // Verify: Map size is 0 (UI 側で 'No registered notes found.' 通知の条件)
        expect(grouped.size).toBe(0);
    });

    test('DOD-39 (extended): 存在しない note フォルダを混ぜても他は処理継続', async () => {
        // Setup: note1 は存在、/nonexistent は存在しない
        setupNote(note1, {
            outFileName: 'a.out',
            aliveMdId: 'p1',
            orphanMdName: 'orphan1.md',
            aliveImageName: 'live1.png',
            orphanImageName: 'unused1.png'
        });

        const nonexistent = path.join(tmpRoot, 'nonexistent');

        // Execute: 存在しないパスを混ぜる
        const grouped = await buildAllNotesCleanupGrouped([note1, nonexistent]);

        // Verify: note1 は正常処理、nonexistent は Map に入らない (orphan なし扱い)
        expect(grouped.size).toBe(1);
        expect(grouped.has(note1)).toBe(true);
        expect(grouped.has(nonexistent)).toBe(false);
    });

    test('REGRESSION: Notes mode で node.images が outDir 基準で保存されている時、alive 画像が orphan 誤判定されない', async () => {
        // Notes mode の実際のファイル配置を再現:
        // - outFile: {mainFolderPath}/{id}.out
        // - pageDir: ./{id} (i.e. {mainFolderPath}/{id})
        // - 画像: {mainFolderPath}/{id}/images/image_*.png
        // - node.images: ["{id}/images/image_*.png"] (outDir 基準で保存されている)
        //
        // 以前のバグ: buildLiveSetPass1 が pageDirAbs 基準を最初に試すため、
        // {id}/images/* を {mainFolderPath}/{id}/{id}/images/* と誤 resolve し、
        // 本物の alive 画像が orphan 誤判定されて削除された

        const outlinerId = 'mnu1u5test';
        const outFile = path.join(note1, `${outlinerId}.out`);
        const idDir = path.join(note1, outlinerId);
        const imagesDir = path.join(idDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        // 複数の alive 画像 (ノード A に添付された 3 枚の画像)
        const aliveImg1 = path.join(imagesDir, 'image_1775894889362.png');
        const aliveImg2 = path.join(imagesDir, 'image_1775894896857.png');
        const aliveImg3 = path.join(imagesDir, 'image_1775894920120.png');
        fs.writeFileSync(aliveImg1, 'img1 data', 'utf8');
        fs.writeFileSync(aliveImg2, 'img2 data', 'utf8');
        fs.writeFileSync(aliveImg3, 'img3 data', 'utf8');

        // .out: pageDir: './{id}', node.images は outDir 基準の相対パス (実際の保存形式)
        const outData = {
            title: 'Regression test',
            pageDir: `./${outlinerId}`,
            rootIds: ['nodeA'],
            nodes: {
                nodeA: {
                    id: 'nodeA',
                    text: 'Node with multiple images',
                    images: [
                        `${outlinerId}/images/image_1775894889362.png`,
                        `${outlinerId}/images/image_1775894896857.png`,
                        `${outlinerId}/images/image_1775894920120.png`
                    ],
                    childIds: []
                }
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        // Execute
        const candidates = await scanSingleNoteCore(note1);

        // Verify: 全ての alive 画像は orphan 候補に含まれない
        const orphanImagePaths = candidates
            .filter(c => c.type === 'orphan-image')
            .map(c => c.absPath);

        expect(orphanImagePaths).not.toContain(aliveImg1);
        expect(orphanImagePaths).not.toContain(aliveImg2);
        expect(orphanImagePaths).not.toContain(aliveImg3);

        // さらに strict: orphan image candidates は 0 件であるべき
        expect(orphanImagePaths.length).toBe(0);
    });

    test('scanSingleNoteCore 単体動作: 1 note を直接スキャン', async () => {
        setupNote(note1, {
            outFileName: 'a.out',
            aliveMdId: 'p1',
            orphanMdName: 'orphan1.md',
            aliveImageName: 'live1.png',
            orphanImageName: 'unused1.png'
        });

        const candidates = await scanSingleNoteCore(note1);

        // orphan md + orphan image = 2 件
        expect(candidates.length).toBe(2);
        const relPaths = candidates.map(c => c.relPath);
        expect(relPaths.some(p => p.includes('orphan1.md'))).toBe(true);
        expect(relPaths.some(p => p.includes('unused1.png'))).toBe(true);
    });
});

test.describe('v8 File Attachment Cleanup', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-cleanup-test-'));
    });

    test.afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('DOD-18: buildLiveSetPass1 tracks node.filePath in liveFiles', async () => {
        // Setup: .out with node.filePath
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            nodes: {
                a: { text: 'Node A', filePath: 'files/report.pdf' },
                b: { text: 'Node B', filePath: 'files/data.xlsx' },
                c: { text: 'Node C' } // no filePath
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        // Create physical files
        const filesDir = path.join(tmpDir, 'files');
        fs.mkdirSync(filesDir);
        fs.writeFileSync(path.join(filesDir, 'report.pdf'), 'pdf content', 'utf8');
        fs.writeFileSync(path.join(filesDir, 'data.xlsx'), 'xlsx content', 'utf8');
        fs.writeFileSync(path.join(filesDir, 'orphan.doc'), 'orphan file', 'utf8');

        // Execute
        const { liveFiles } = await buildLiveSetPass1([outFile], tmpDir);

        // Verify: liveFiles contains paths from node.filePath
        expect(liveFiles.has(path.join(filesDir, 'report.pdf'))).toBe(true);
        expect(liveFiles.has(path.join(filesDir, 'data.xlsx'))).toBe(true);
        expect(liveFiles.has(path.join(filesDir, 'orphan.doc'))).toBe(false);
    });

    test('DOD-19: Pass 2 tracks [📎 filename](path) links in alive MDs', async () => {
        // Setup: .out with pageId → alive md with file link
        // Note: Use files within pages directory to avoid ../ which safeResolveUnderDir rejects
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId: 'p1' }
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        const pagesDir = path.join(tmpDir, 'pages');
        const filesDir = path.join(pagesDir, 'files'); // files/ inside pages/
        fs.mkdirSync(pagesDir);
        fs.mkdirSync(filesDir);

        // Alive md with file link (relative path within pages directory)
        const mdContent = '# Page 1\n\nSee attached: [📎 document.pdf](files/document.pdf)';
        fs.writeFileSync(path.join(pagesDir, 'p1.md'), mdContent, 'utf8');

        // Physical files
        fs.writeFileSync(path.join(filesDir, 'document.pdf'), 'pdf data', 'utf8');
        fs.writeFileSync(path.join(filesDir, 'unused.txt'), 'unused file', 'utf8');

        // Execute Pass 1
        const { liveMd: liveMdPass1, liveFiles: liveFilesPass1 } = await buildLiveSetPass1([outFile], tmpDir);

        // Pass 2: buildPass2LiveFiles
        const { buildPass2LiveFiles } = await import('../../src/shared/cleanup-core');
        const liveFilesPass2 = await buildPass2LiveFiles(liveMdPass1, liveFilesPass1, tmpDir);

        // Verify: liveFiles includes file from markdown link
        expect(liveFilesPass2.has(path.join(filesDir, 'document.pdf'))).toBe(true);
        expect(liveFilesPass2.has(path.join(filesDir, 'unused.txt'))).toBe(false);
    });

    test('DOD-20: Orphan files detected when not referenced', async () => {
        // Setup
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            nodes: {
                a: { text: 'Node A', filePath: 'files/alive.pdf' }
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        const filesDir = path.join(tmpDir, 'files');
        fs.mkdirSync(filesDir);
        fs.writeFileSync(path.join(filesDir, 'alive.pdf'), 'alive', 'utf8');
        fs.writeFileSync(path.join(filesDir, 'orphan1.doc'), 'orphan 1', 'utf8');
        fs.writeFileSync(path.join(filesDir, 'orphan2.xlsx'), 'orphan 2', 'utf8');

        // Execute
        const candidates = await scanSingleNoteCore(tmpDir);

        // Verify: orphan files detected
        const orphanFiles = candidates.filter(c => c.type === 'orphan-file');
        expect(orphanFiles.length).toBe(2);

        const orphanPaths = orphanFiles.map(c => c.relPath);
        expect(orphanPaths.some(p => p.includes('orphan1.doc'))).toBe(true);
        expect(orphanPaths.some(p => p.includes('orphan2.xlsx'))).toBe(true);
        expect(orphanPaths.some(p => p.includes('alive.pdf'))).toBe(false);
    });

    test('DOD-20 (extended): File links in MD + node.filePath both tracked', async () => {
        // Setup: combined scenario
        const outFile = path.join(tmpDir, 'test.out');
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId: 'p1', filePath: 'files/attached.pdf' }
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');

        const pagesDir = path.join(tmpDir, 'pages');
        const filesDir = path.join(tmpDir, 'files');
        fs.mkdirSync(pagesDir);
        fs.mkdirSync(filesDir);

        // MD with file link (safe relative path without ..)
        fs.writeFileSync(
            path.join(pagesDir, 'p1.md'),
            'Content: [📎 linked.xlsx](files/linked.xlsx)',
            'utf8'
        );

        // Also create files/linked.xlsx inside pages for the MD link to resolve
        const pageFilesDir = path.join(pagesDir, 'files');
        fs.mkdirSync(pageFilesDir);
        fs.writeFileSync(path.join(pageFilesDir, 'linked.xlsx'), 'linked from md', 'utf8');

        // Physical files at root level
        fs.writeFileSync(path.join(filesDir, 'attached.pdf'), 'attached', 'utf8');
        fs.writeFileSync(path.join(filesDir, 'orphan.doc'), 'orphan', 'utf8');

        // Execute
        const candidates = await scanSingleNoteCore(tmpDir);

        // Verify: only orphan.doc is detected as orphan
        const orphanFiles = candidates.filter(c => c.type === 'orphan-file');
        expect(orphanFiles.length).toBe(1);
        expect(orphanFiles[0].relPath).toContain('orphan.doc');
    });
});
