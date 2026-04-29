/**
 * TC-15: drawio.svg を含む MD の paste で fileDir に複製
 *
 * MD-41 拡張仕様 (testcases.md TC-15):
 * - source .md (`![](drawio/foo.drawio.svg)` を含む) → 別 .md に paste
 * - target の `fileDir/foo.drawio.svg` に複製される（imageDir ではない）
 * - paste 後の MD 本文は `![](relative/foo.drawio.svg)` で fileDir 経由
 *
 * 衝突時の suffix 位置 (TC-03 と同じ規則):
 * - foo.drawio.svg 衝突 → foo-1.drawio.svg (NOT foo.drawio-1.svg)
 *
 * 検証対象: copyMdPasteAssets() 関数 (src/shared/paste-asset-handler.ts)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

test.describe('TC-15: drawio.svg paste-asset → destFileDir 振り分け', () => {
    let tmpDir: string;
    let srcDir: string;
    let destDir: string;
    let srcDrawioDir: string;
    let destImageDir: string;
    let destFileDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-drawio-paste-test-'));
        srcDir = path.join(tmpDir, 'src');
        destDir = path.join(tmpDir, 'dest');
        srcDrawioDir = path.join(srcDir, 'drawio');
        destImageDir = path.join(destDir, 'images');
        destFileDir = path.join(destDir, 'files');

        fs.mkdirSync(srcDir, { recursive: true });
        fs.mkdirSync(srcDrawioDir, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });

        // Create source drawio.svg (dual-format SVG with mxfile content)
        fs.writeFileSync(
            path.join(srcDrawioDir, 'foo.drawio.svg'),
            '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile&gt;test&lt;/mxfile&gt;"></svg>'
        );
    });

    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('TC-15-1: drawio.svg は destFileDir にコピーされる（destImageDir には入らない）', () => {
        const markdown = '![](drawio/foo.drawio.svg)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: path.join(srcDir, 'images'),
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir,
            destMdDir: destDir
        });

        // drawio.svg は destFileDir にコピーされる
        expect(fs.existsSync(path.join(destFileDir, 'foo.drawio.svg'))).toBe(true);

        // destImageDir には作られない (drawio.svg は image 系から除外)
        expect(fs.existsSync(path.join(destImageDir, 'foo.drawio.svg'))).toBe(false);

        // 本文は fileDir 経由のパスに書き換え
        expect(result.rewrittenMarkdown).toContain('files/foo.drawio.svg');
    });

    test('TC-15-2: drawio.png も destFileDir 振り分け', () => {
        // .drawio.png 用の追加 fixture
        fs.writeFileSync(path.join(srcDrawioDir, 'bar.drawio.png'), 'png-data-bytes');
        const markdown = '![](drawio/bar.drawio.png)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: path.join(srcDir, 'images'),
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir,
            destMdDir: destDir
        });

        expect(fs.existsSync(path.join(destFileDir, 'bar.drawio.png'))).toBe(true);
        expect(fs.existsSync(path.join(destImageDir, 'bar.drawio.png'))).toBe(false);
        expect(result.rewrittenMarkdown).toContain('files/bar.drawio.png');
    });

    test('TC-15-3: 衝突時の suffix は多重拡張子の前に付く (foo-1.drawio.svg)', () => {
        // destFileDir に既存の foo.drawio.svg を置いておく
        fs.mkdirSync(destFileDir, { recursive: true });
        fs.writeFileSync(path.join(destFileDir, 'foo.drawio.svg'), 'EXISTING_BYTES');

        const markdown = '![](drawio/foo.drawio.svg)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: path.join(srcDir, 'images'),
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir,
            destMdDir: destDir
        });

        // 既存ファイルは保護される
        expect(fs.readFileSync(path.join(destFileDir, 'foo.drawio.svg'), 'utf8')).toBe('EXISTING_BYTES');

        // 新しい衝突回避ファイル名は foo-1.drawio.svg (NOT foo.drawio-1.svg)
        expect(fs.existsSync(path.join(destFileDir, 'foo-1.drawio.svg'))).toBe(true);
        expect(fs.existsSync(path.join(destFileDir, 'foo.drawio-1.svg'))).toBe(false);

        // 本文も新ファイル名に書き換え
        expect(result.rewrittenMarkdown).toContain('files/foo-1.drawio.svg');
        expect(result.rewrittenMarkdown).not.toContain('files/foo.drawio-1.svg');
    });

    test('TC-15-4: 衝突 2 連続 → foo-1.drawio.svg + foo-2.drawio.svg', () => {
        fs.mkdirSync(destFileDir, { recursive: true });
        fs.writeFileSync(path.join(destFileDir, 'foo.drawio.svg'), 'EXISTING_1');
        fs.writeFileSync(path.join(destFileDir, 'foo-1.drawio.svg'), 'EXISTING_2');

        const markdown = '![](drawio/foo.drawio.svg)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: path.join(srcDir, 'images'),
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir,
            destMdDir: destDir
        });

        expect(fs.existsSync(path.join(destFileDir, 'foo-2.drawio.svg'))).toBe(true);
        expect(result.rewrittenMarkdown).toContain('files/foo-2.drawio.svg');
    });

    test('TC-15-5: drawio + 通常画像が混在する MD でも振り分けが正しい', () => {
        // 通常画像も置く
        const srcImagesDir = path.join(srcDir, 'images');
        fs.mkdirSync(srcImagesDir, { recursive: true });
        fs.writeFileSync(path.join(srcImagesDir, 'photo.png'), 'png-bytes');

        const markdown = '![](images/photo.png)\n\n![](drawio/foo.drawio.svg)';

        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: srcDir,
            sourceImageDir: srcImagesDir,
            sourceFileDir: path.join(srcDir, 'files'),
            destImageDir,
            destFileDir,
            destMdDir: destDir
        });

        // 通常画像は destImageDir (copy-{ts}-photo.png) へ
        const imageFiles = fs.readdirSync(destImageDir);
        expect(imageFiles.some((n) => /^copy-\d+-photo\.png$/.test(n))).toBe(true);

        // drawio は destFileDir (元名のまま) へ
        expect(fs.existsSync(path.join(destFileDir, 'foo.drawio.svg'))).toBe(true);

        // それぞれ別の dir に振り分けられる (排他)
        expect(fs.existsSync(path.join(destImageDir, 'foo.drawio.svg'))).toBe(false);
        expect(fs.existsSync(path.join(destFileDir, 'photo.png'))).toBe(false);

        // 本文も両方書き換わる
        expect(result.rewrittenMarkdown).toContain('files/foo.drawio.svg');
        expect(result.rewrittenMarkdown).toMatch(/images\/copy-\d+-photo\.png/);
    });
});
