/**
 * 複製エンジンの images/ files/ は「実体をコピーするときだけ」作る（FR-ACC-02 の実装是正）
 * sprint 20260930-192647-linkedfd-conflict-rename-and-paste-sibling TASK-09（reviewer iter4 QUAL-4 の同型展開）
 *
 * src/shared/paste-asset-handler.ts の ensureDir を全件仕分けし、参照数ベースで事前作成していた
 * 6 箇所（handlePageAssets 画像 / 添付・handleImageAssets・handleFileAsset・buildOutlinerNodesPasteMd・
 * copyMdPasteAssets）を「実体が見つかった直後」に揃えた。ここでは linkedfd 以外の入口（outliner の
 * page md / ノード画像 / ノード添付の複製・貼り付け）を踏む。
 *
 * 番人: どれか 1 箇所でも参照数ベースの事前作成に戻すと、その TC が落ちる。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pah = require('../../src/shared/paste-asset-handler');

function dirs() {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-dst-'));
    return { src, dst, cleanup: () => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); } };
}

test.describe('複製エンジンの遅延 dir 作成（FR-ACC-02）', () => {
    test('TC-FNM-16: handlePageAssets — 壊れたリンクだけの page md を複製しても images/ files/ を作らない', () => {
        const d = dirs();
        try {
            fs.writeFileSync(path.join(d.src, 'p1.md'), '# P\n![](images/missing.png)\n[📎 r.pdf](files/missing.pdf)\n');
            pah.handlePageAssets({ srcOutDir: d.src, srcPagesDir: d.src, destOutDir: d.dst, destPagesDir: d.dst, pageId: 'p1', newPageId: 'p2', nodeImages: [] });
            expect(fs.existsSync(path.join(d.dst, 'p2.md')), 'page md が複製されていない').toBe(true);
            expect(fs.existsSync(path.join(d.dst, 'images')), '空の images/').toBe(false);
            expect(fs.existsSync(path.join(d.dst, 'files')), '空の files/').toBe(false);
        } finally { d.cleanup(); }
    });

    test('TC-FNM-17: handleImageAssets — 実体の無いノード画像だけなら images/ を作らない', () => {
        const d = dirs();
        try {
            pah.handleImageAssets({ srcOutDir: d.src, srcPagesDir: d.src, destOutDir: d.dst, destPagesDir: d.dst, renamePrefix: 'x-', nodeImages: ['images/missing.png'] });
            expect(fs.existsSync(path.join(d.dst, 'images')), '空の images/').toBe(false);
        } finally { d.cleanup(); }
    });

    test('TC-FNM-18: handleFileAsset — 実体の無い添付なら files/ を作らない', () => {
        const d = dirs();
        try {
            const filesDir = path.join(d.dst, 'files');
            const r = pah.handleFileAsset({ srcOutDir: d.src, srcFileDir: path.join(d.src, 'files'), destOutDir: d.dst, destFileDir: filesDir, filePath: 'files/missing.pdf', useCollisionSuffix: true });
            expect(r.newFilePath).toBeNull();
            expect(fs.existsSync(filesDir), '空の files/').toBe(false);
        } finally { d.cleanup(); }
    });

    test('TC-FNM-19: buildOutlinerNodesPasteMd — 実体の無いノード画像だけなら images/ を作らない', () => {
        const d = dirs();
        try {
            const destMd = path.join(d.dst, 'target.md');
            fs.writeFileSync(destMd, '# T\n');
            pah.buildOutlinerNodesPasteMd({
                nodes: [{ text: 'n', level: 0, images: ['images/missing.png'] }],
                srcOutDir: d.src, srcPagesDir: d.src, srcFileDir: path.join(d.src, 'files'),
                destMdPath: destMd, destFilesDir: path.join(d.dst, 'files'), destImagesDir: path.join(d.dst, 'images'),
            });
            expect(fs.existsSync(path.join(d.dst, 'images')), '空の images/').toBe(false);
        } finally { d.cleanup(); }
    });

    test('TC-FNM-16b: handlePageAssets — 実体がある画像・添付は従来どおり複製される（回帰 pin）', () => {
        const d = dirs();
        try {
            fs.mkdirSync(path.join(d.src, 'images')); fs.mkdirSync(path.join(d.src, 'files'));
            fs.writeFileSync(path.join(d.src, 'images', 'x.png'), 'IMG');
            fs.writeFileSync(path.join(d.src, 'files', 'r.pdf'), 'PDF');
            fs.writeFileSync(path.join(d.src, 'p1.md'), '# P\n![](images/x.png)\n[📎 r.pdf](files/r.pdf)\n');
            pah.handlePageAssets({ srcOutDir: d.src, srcPagesDir: d.src, destOutDir: d.dst, destPagesDir: d.dst, pageId: 'p1', newPageId: 'p2', nodeImages: [] });
            expect(fs.readdirSync(path.join(d.dst, 'images')).length).toBe(1);
            expect(fs.readdirSync(path.join(d.dst, 'files')).length).toBe(1);
        } finally { d.cleanup(); }
    });
});
