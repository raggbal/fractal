/**
 * MD editor (page MD) ↔ MD editor cmd+c/x → cmd+v の全マトリクステスト
 *
 * 検証対象: copyMdPasteAssets (src/shared/paste-asset-handler.ts)
 *
 * シナリオ: 3 asset 型 × 3 location × 2 operation = 18 ケース
 * 加えて、フルパス化バグの再現テストも含む。
 *
 * 注意: 同 dir 判定は editor.js (webview) 側で行うため、L1 (同 outliner) では
 * そもそも copyMdPasteAssets が呼ばれない。本テストは host 側に到達した時点での
 * copyMdPasteAssets の挙動 (L2/L3 相当) と、絶対パス入力時の取り扱いを検証する。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

function setupTwoOutliners(parentDir: string) {
    // outliner1: /parent/note1/outline1/pages, /parent/note1/outline1/images, /parent/note1/outline1/files
    const note1 = path.join(parentDir, 'note1', 'outline1');
    const note1Pages = path.join(note1, 'pages');
    const note1Images = path.join(note1, 'images');
    const note1Files = path.join(note1, 'files');
    fs.mkdirSync(note1Pages, { recursive: true });
    fs.mkdirSync(note1Images, { recursive: true });
    fs.mkdirSync(note1Files, { recursive: true });

    const note2 = path.join(parentDir, 'note2', 'outline2');
    const note2Pages = path.join(note2, 'pages');
    const note2Images = path.join(note2, 'images');
    const note2Files = path.join(note2, 'files');
    fs.mkdirSync(note2Pages, { recursive: true });
    fs.mkdirSync(note2Images, { recursive: true });
    fs.mkdirSync(note2Files, { recursive: true });

    return {
        note1: { dir: note1, pagesDir: note1Pages, imageDir: note1Images, fileDir: note1Files },
        note2: { dir: note2, pagesDir: note2Pages, imageDir: note2Images, fileDir: note2Files }
    };
}

test.describe('MD editor cross-paste matrix — 画像', () => {
    let tmpDir: string;
    let dirs: ReturnType<typeof setupTwoOutliners>;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-cross-'));
        dirs = setupTwoOutliners(tmpDir);
        // src の image
        fs.writeFileSync(path.join(dirs.note1.imageDir, 'photo.png'), 'PHOTO_BYTES');
    });
    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('L2/L3 image copy: 別 outliner へ paste で dest の images/ に複製、相対パスで本文書き換え', () => {
        // src page MD: /note1/outline1/pages/page1.md → 画像参照は ../images/photo.png
        const markdown = '![alt](../images/photo.png)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        const destFiles = fs.readdirSync(dirs.note2.imageDir);
        expect(destFiles).toHaveLength(1);
        expect(destFiles[0]).toMatch(/^copy-\d+-photo\.png$/);
        // 結果 MD は dest の pages から images へ相対 (`../images/copy-...-photo.png`)
        expect(result.rewrittenMarkdown).toMatch(/!\[alt\]\(\.\.\/images\/copy-\d+-photo\.png\)/);
        // 絶対パスは絶対に含まれないこと
        expect(result.rewrittenMarkdown).not.toContain('/Users/');
        expect(result.rewrittenMarkdown).not.toContain(tmpDir);
        expect(result.rewrittenMarkdown).not.toContain('vscode-resource');
    });

    test('絶対パス入力でも dest に複製して相対パスに書き換える (フルパス化バグの根本対策)', () => {
        // ユーザーが見る現象: clipboard に `![](/Users/.../note1/.../images/photo.png)` が入った場合
        const absPath = path.join(dirs.note1.imageDir, 'photo.png');
        const markdown = `![alt](${absPath})`;
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // dest に複製される
        const destFiles = fs.readdirSync(dirs.note2.imageDir);
        expect(destFiles.length).toBeGreaterThanOrEqual(1);
        expect(destFiles.some((n) => n.includes('photo.png'))).toBe(true);
        // 結果 MD には絶対パスが残ってはいけない (相対パスに書き換え)
        expect(result.rewrittenMarkdown).not.toContain(absPath);
        expect(result.rewrittenMarkdown).not.toContain(tmpDir);
        expect(result.rewrittenMarkdown).toMatch(/photo\.png/);
    });

    test('vscode-resource:// 接頭辞付き絶対 URL も適切に処理される', () => {
        // cleanImageSrc がストリップ漏れすると、こういう形が入る可能性
        const markdown = `![alt](https://file+.vscode-resource.vscode-cdn.net${dirs.note1.imageDir}/photo.png)`;
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // 絶対 URL を残してはいけない
        expect(result.rewrittenMarkdown).not.toContain('vscode-resource');
        expect(result.rewrittenMarkdown).not.toContain(dirs.note1.imageDir);
    });
});

test.describe('MD editor cross-paste matrix — file ([📎](path))', () => {
    let tmpDir: string;
    let dirs: ReturnType<typeof setupTwoOutliners>;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-cross-file-'));
        dirs = setupTwoOutliners(tmpDir);
        fs.writeFileSync(path.join(dirs.note1.fileDir, 'doc.pdf'), 'PDF_BYTES');
    });
    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('L2/L3 file copy: 別 outliner へ paste で dest の files/ に複製', () => {
        const markdown = '[📎 doc.pdf](../files/doc.pdf)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        const destFiles = fs.readdirSync(dirs.note2.fileDir);
        expect(destFiles.length).toBeGreaterThanOrEqual(1);
        expect(destFiles.some((n) => n === 'doc.pdf' || /^doc-\d+\.pdf$/.test(n))).toBe(true);
        expect(result.rewrittenMarkdown).toMatch(/files\/doc/);
        expect(result.rewrittenMarkdown).not.toContain('/Users/');
        expect(result.rewrittenMarkdown).not.toContain(tmpDir);
    });
});

test.describe('MD editor cross-paste matrix — drawio.svg', () => {
    let tmpDir: string;
    let dirs: ReturnType<typeof setupTwoOutliners>;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-cross-drawio-'));
        dirs = setupTwoOutliners(tmpDir);
        fs.writeFileSync(
            path.join(dirs.note1.fileDir, 'foo.drawio.svg'),
            '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile&gt;test&lt;/mxfile&gt;"></svg>'
        );
    });
    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('L2/L3 drawio copy: 別 outliner へ paste で dest の files/ に複製、destImageDir には入らない', () => {
        const markdown = '![alt](../files/foo.drawio.svg)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // drawio は files/ に複製
        const destFiles = fs.readdirSync(dirs.note2.fileDir);
        expect(destFiles.some((n) => n === 'foo.drawio.svg' || /^foo-\d+\.drawio\.svg$/.test(n))).toBe(true);
        // images/ には入らない
        expect(fs.existsSync(path.join(dirs.note2.imageDir, 'foo.drawio.svg'))).toBe(false);
        // MD は相対パスで書き換え
        expect(result.rewrittenMarkdown).toMatch(/files\/foo[\d-]*\.drawio\.svg/);
        expect(result.rewrittenMarkdown).not.toContain('/Users/');
        expect(result.rewrittenMarkdown).not.toContain(tmpDir);
    });

    test('drawio 衝突 suffix は多重拡張子の前 (foo-1.drawio.svg)', () => {
        // dest にも既に同名がある
        fs.writeFileSync(path.join(dirs.note2.fileDir, 'foo.drawio.svg'), 'EXISTING');
        const markdown = '![alt](../files/foo.drawio.svg)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // 既存ファイルは保護
        expect(fs.readFileSync(path.join(dirs.note2.fileDir, 'foo.drawio.svg'), 'utf8')).toBe('EXISTING');
        // 新ファイルは foo-1.drawio.svg (NOT foo.drawio-1.svg)
        expect(fs.existsSync(path.join(dirs.note2.fileDir, 'foo-1.drawio.svg'))).toBe(true);
        expect(fs.existsSync(path.join(dirs.note2.fileDir, 'foo.drawio-1.svg'))).toBe(false);
        // MD も新ファイル名に書き換え
        expect(result.rewrittenMarkdown).toContain('foo-1.drawio.svg');
        expect(result.rewrittenMarkdown).not.toContain('foo.drawio-1.svg');
    });

    test('drawio 絶対パスでも dest fileDir に複製、相対パスに書き換え (フルパス化対策)', () => {
        const absPath = path.join(dirs.note1.fileDir, 'foo.drawio.svg');
        const markdown = `![alt](${absPath})`;
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        const destFiles = fs.readdirSync(dirs.note2.fileDir);
        expect(destFiles.some((n) => n.includes('foo.drawio.svg') || n.includes('foo-1.drawio.svg'))).toBe(true);
        expect(result.rewrittenMarkdown).not.toContain(absPath);
        expect(result.rewrittenMarkdown).not.toContain(tmpDir);
    });
});

test.describe('MD editor cross-paste matrix — markdown link [](*.md)', () => {
    let tmpDir: string;
    let dirs: ReturnType<typeof setupTwoOutliners>;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-paste-cross-mdlink-'));
        dirs = setupTwoOutliners(tmpDir);
        fs.writeFileSync(path.join(dirs.note1.pagesDir, 'memo.md'), 'MEMO_CONTENT');
    });
    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('[link](*.md) も dest に複製、相対パス書き換え', () => {
        const markdown = '関連: [memo](memo.md)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // dest pagesDir に複製される
        const destFiles = fs.readdirSync(dirs.note2.pagesDir);
        expect(destFiles.some((n) => n === 'memo.md' || /^memo-\d+\.md$/.test(n))).toBe(true);
        // 内容も保たれる
        const copied = destFiles.find((n) => n.startsWith('memo'))!;
        expect(fs.readFileSync(path.join(dirs.note2.pagesDir, copied), 'utf8')).toBe('MEMO_CONTENT');
        // markdown も書き換え
        expect(result.rewrittenMarkdown).toMatch(/\[memo\]\(memo[\d-]*\.md\)/);
    });

    test('[link](*.md) 衝突時は memo-1.md', () => {
        // dest にも既存
        fs.writeFileSync(path.join(dirs.note2.pagesDir, 'memo.md'), 'EXISTING');
        const markdown = '[memo](memo.md)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // 既存保護
        expect(fs.readFileSync(path.join(dirs.note2.pagesDir, 'memo.md'), 'utf8')).toBe('EXISTING');
        // 新名で複製
        expect(fs.existsSync(path.join(dirs.note2.pagesDir, 'memo-1.md'))).toBe(true);
        // markdown も書き換え
        expect(result.rewrittenMarkdown).toContain('memo-1.md');
        expect(result.rewrittenMarkdown).not.toContain('](memo.md)');
    });

    test('画像 ![](*.md) は md link ではなく image として扱われる (誤検出防止)', () => {
        // ![](memo.md) は image syntax なので md link 扱いにしない (image としても .md は普通存在しないが念のため)
        const markdown = '![](memo.md)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // image 経路で destImageDir/copy-{ts}-memo.md として複製される (誤って destPagesDir に複製されない)
        expect(fs.readdirSync(dirs.note2.pagesDir).some((n) => n.startsWith('memo'))).toBe(false);
    });

    test('[📎 ...](*.md) は file (📎) として files/ へ振り分け、md link 経路を通らない', () => {
        // 📎 prefix の場合は file 添付経路
        fs.writeFileSync(path.join(dirs.note1.fileDir, 'memo.md'), 'FILE_MEMO');
        const markdown = '[📎 memo](../files/memo.md)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        // files/ に複製
        expect(fs.readdirSync(dirs.note2.fileDir).some((n) => n.startsWith('memo'))).toBe(true);
        // md link 経路では複製されない (destPagesDir 直下に memo.md ができない)
        expect(fs.readdirSync(dirs.note2.pagesDir).some((n) => n.startsWith('memo'))).toBe(false);
    });

    test('http(s) の md link はスキップ', () => {
        const markdown = '[external](https://example.com/note.md)';
        const result = copyMdPasteAssets({
            markdown,
            sourceMdDir: dirs.note1.pagesDir,
            sourceImageDir: dirs.note1.imageDir,
            sourceFileDir: dirs.note1.fileDir,
            destImageDir: dirs.note2.imageDir,
            destFileDir: dirs.note2.fileDir,
            destMdDir: dirs.note2.pagesDir
        });
        expect(result.rewrittenMarkdown).toBe(markdown); // 変更なし
        expect(fs.readdirSync(dirs.note2.pagesDir).length).toBe(0);
    });
});

test.describe('handlePageAssets で page MD 内の [](*.md) リンクも複製される', () => {
    let tmpDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-page-mdlink-'));
    });
    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('isPage=true の page node copy で page MD 内 [](*.md) も destPagesDir に複製', async () => {
        const { handlePageAssets } = await import('../../src/shared/paste-asset-handler');
        const srcOut = path.join(tmpDir, 'src');
        const destOut = path.join(tmpDir, 'dest');
        const srcPages = path.join(srcOut, 'pages');
        const destPages = path.join(destOut, 'pages');
        fs.mkdirSync(srcPages, { recursive: true });
        fs.mkdirSync(destPages, { recursive: true });
        // page MD と参照先 .md
        fs.writeFileSync(path.join(srcPages, 'page-A.md'), '関連: [memo](memo.md)');
        fs.writeFileSync(path.join(srcPages, 'memo.md'), 'MEMO_BODY');

        const result = handlePageAssets({
            srcOutDir: srcOut,
            srcPagesDir: srcPages,
            destOutDir: destOut,
            destPagesDir: destPages,
            pageId: 'page-A',
            newPageId: 'page-B',
            nodeImages: [],
            sameDirSkip: false
        });

        // page MD が destPages/page-B.md に複製
        expect(fs.existsSync(path.join(destPages, 'page-B.md'))).toBe(true);
        // memo.md も destPages に複製 (元名のまま、衝突なし)
        expect(fs.existsSync(path.join(destPages, 'memo.md'))).toBe(true);
        // 内容保持
        expect(fs.readFileSync(path.join(destPages, 'memo.md'), 'utf8')).toBe('MEMO_BODY');
    });
});

test.describe('outliner ノード copy/paste — handleFileAsset の drawio 命名一貫性', () => {
    // outliner ノードに drawio が filePath として attach された状態の cross-outliner paste
    // 経路: outlinerProvider.ts case 'handleFileAssetCross' → handleFileAsset
    // bug: handleFileAsset:266 で generateUniqueFileNamePreserving を使い multi-ext 処理が無い
    let tmpDir: string;
    let srcOutDir: string;
    let destOutDir: string;
    let srcFileDir: string;
    let destFileDir: string;

    test.beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-handle-fileasset-'));
        srcOutDir = path.join(tmpDir, 'src');
        destOutDir = path.join(tmpDir, 'dest');
        srcFileDir = path.join(srcOutDir, 'files');
        destFileDir = path.join(destOutDir, 'files');
        fs.mkdirSync(srcFileDir, { recursive: true });
        fs.mkdirSync(destFileDir, { recursive: true });
        fs.writeFileSync(path.join(srcFileDir, 'foo.drawio.svg'), 'SRC_BYTES');
    });
    test.afterEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('handleFileAsset: drawio.svg 衝突 → foo-1.drawio.svg (TC-03 仕様)', async () => {
        const { handleFileAsset } = await import('../../src/shared/paste-asset-handler');
        // dest に既存
        fs.writeFileSync(path.join(destFileDir, 'foo.drawio.svg'), 'EXISTING');
        const result = handleFileAsset({
            srcOutDir,
            srcFileDir,
            destOutDir,
            destFileDir,
            filePath: 'files/foo.drawio.svg',
            useCollisionSuffix: true,
            sameDirSkip: false
        });
        // 既存保護
        expect(fs.readFileSync(path.join(destFileDir, 'foo.drawio.svg'), 'utf8')).toBe('EXISTING');
        // 新ファイル名: foo-1.drawio.svg (NOT foo.drawio-1.svg) — TC-03 仕様
        expect(fs.existsSync(path.join(destFileDir, 'foo-1.drawio.svg'))).toBe(true);
        expect(fs.existsSync(path.join(destFileDir, 'foo.drawio-1.svg'))).toBe(false);
        expect(result.newFilePath).toBe('files/foo-1.drawio.svg');
    });
});
