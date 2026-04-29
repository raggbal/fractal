/**
 * NT-17 配慮テスト (TC-16, TC-17)
 *
 * - TC-16: 参照されている drawio.svg が orphan-file として誤検出されないこと
 * - TC-17: 参照されていない drawio.svg は orphan-file として検出されること
 *
 * `buildPass2LiveFiles` の `![](*.drawio.svg / *.drawio.png)` 認識を検証する。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanSingleNoteCore } from '../../src/shared/cleanup-core';

test.describe('NT-17 drawio coexist (TC-16 / TC-17)', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-nt17-'));
    });

    test.afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    function writeOut(outFile: string, pageId: string): void {
        const outData = {
            title: 'Test',
            pageDir: './pages',
            nodes: {
                a: { text: 'Node A', pageId }
            }
        };
        fs.writeFileSync(outFile, JSON.stringify(outData, null, 2), 'utf8');
    }

    // 構造: tmpDir/{ test.out, pages/{p1.md, files/foo.drawio.svg} }
    // pages/files/ 配下に drawio asset を置くことで safeResolveUnderDir(pagesDir, 'files/x') が成功する
    // → buildPass2LiveImages / buildPass2LiveFiles が relative paths を解決できる

    test('TC-16: ![](files/foo.drawio.svg) で参照される drawio.svg は orphan として検出されない', async () => {
        const outFile = path.join(tmpDir, 'test.out');
        writeOut(outFile, 'p1');
        const pagesDir = path.join(tmpDir, 'pages');
        fs.mkdirSync(pagesDir);
        // alive md が drawio.svg を ![]() で参照
        fs.writeFileSync(path.join(pagesDir, 'p1.md'), '# Hello\n\n![](files/foo.drawio.svg)\n', 'utf8');

        const filesDir = path.join(pagesDir, 'files');
        fs.mkdirSync(filesDir);
        fs.writeFileSync(path.join(filesDir, 'foo.drawio.svg'), '<svg/>', 'utf8');

        const candidates = await scanSingleNoteCore(tmpDir);
        // foo.drawio.svg は liveImages にあるので orphan-image にはならない
        // また buildPass2LiveFiles の drawio 認識 (TASK-09) で liveFiles にも入る
        const orphan = candidates.find(c => c.absPath.endsWith('foo.drawio.svg'));
        expect(orphan).toBeUndefined();
    });

    test('TC-17: 参照されていない drawio.svg は orphan として検出される', async () => {
        const outFile = path.join(tmpDir, 'test.out');
        writeOut(outFile, 'p1');
        const pagesDir = path.join(tmpDir, 'pages');
        fs.mkdirSync(pagesDir);
        // alive md は drawio.svg を参照していない
        fs.writeFileSync(path.join(pagesDir, 'p1.md'), '# Hello\n', 'utf8');

        const filesDir = path.join(pagesDir, 'files');
        fs.mkdirSync(filesDir);
        fs.writeFileSync(path.join(filesDir, 'orphan.drawio.svg'), '<svg/>', 'utf8');

        const candidates = await scanSingleNoteCore(tmpDir);
        const orphan = candidates.find(c => c.absPath.endsWith('orphan.drawio.svg'));
        // 既存仕様: drawio.svg は .svg 拡張子のため listAllImages に含まれ、
        // 参照されていなければ orphan-image として検出される
        expect(orphan).toBeDefined();
        expect(['orphan-image', 'orphan-file']).toContain(orphan?.type);
    });

    test('drawio.png でも同様に参照あり時は orphan 検出されない', async () => {
        const outFile = path.join(tmpDir, 'test.out');
        writeOut(outFile, 'p1');
        const pagesDir = path.join(tmpDir, 'pages');
        fs.mkdirSync(pagesDir);
        fs.writeFileSync(path.join(pagesDir, 'p1.md'), '# Hello\n\n![](files/diag.drawio.png)\n', 'utf8');

        const filesDir = path.join(pagesDir, 'files');
        fs.mkdirSync(filesDir);
        fs.writeFileSync(path.join(filesDir, 'diag.drawio.png'), 'png-binary', 'utf8');

        const candidates = await scanSingleNoteCore(tmpDir);
        const orphan = candidates.find(c => c.absPath.endsWith('diag.drawio.png'));
        expect(orphan).toBeUndefined();
    });

    // TASK-09 ガード: buildPass2LiveFiles が drawio.svg / drawio.png を ![]() 構文から
    // 認識して liveFiles に含めることで、drawio.svg が files/ 配下に置かれた場合の
    // orphan-file 誤判定を防ぐ。
    test('TASK-09: ![](files/foo.drawio.svg) は liveFiles にも追加される（直接検証）', async () => {
        const outFile = path.join(tmpDir, 'test.out');
        writeOut(outFile, 'p1');
        const pagesDir = path.join(tmpDir, 'pages');
        fs.mkdirSync(pagesDir);
        fs.writeFileSync(path.join(pagesDir, 'p1.md'), '![](files/foo.drawio.svg)', 'utf8');

        const filesDir = path.join(pagesDir, 'files');
        fs.mkdirSync(filesDir);
        const drawioPath = path.join(filesDir, 'foo.drawio.svg');
        fs.writeFileSync(drawioPath, '<svg/>', 'utf8');

        // buildPass2LiveFiles を直接呼んで内部 set を確認
        const { buildLiveSetPass1, buildPass2LiveFiles } = await import('../../src/shared/cleanup-core');
        const { liveMd, liveFiles: lf1 } = await buildLiveSetPass1([outFile], tmpDir);
        const liveFiles = await buildPass2LiveFiles(liveMd, lf1, tmpDir);
        expect(liveFiles.has(drawioPath)).toBe(true);
    });
});
