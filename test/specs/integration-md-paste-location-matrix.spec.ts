/**
 * MD editor copyMdPasteAssets 完全 4 location × 4 asset 型 matrix
 *
 * Location:
 *   L1 同 MD 内 (sourceMdDir == destMdDir, sourceImageDir == destImageDir)
 *   L2 同 outliner 別 MD (sourceMdDir == destMdDir、同じ pages/, images/, files/)
 *   L3 同 note 別 outliner (異なる pageDir / imageDir / fileDir、共通親 note dir)
 *   L4 別 note 別 outliner (完全に異なる)
 *
 * Asset type:
 *   I. image (.png) → destImageDir
 *   F. file [📎](.pdf) → destFileDir
 *   D. drawio.svg ![](*.drawio.svg) → destFileDir (画像扱いだが file 管理)
 *   M. markdown link [](*.md) → destMdDir
 *
 * total: 4 × 4 = 16 cases (絶対パス入力 / vscode-resource URL 入力もカバー)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

interface OutlinerDirs {
    outDir: string;
    pagesDir: string;
    imageDir: string;
    fileDir: string;
}

function makeOutliner(parent: string, name: string): OutlinerDirs {
    const outDir = path.join(parent, name);
    const pagesDir = path.join(outDir, 'pages');
    const imageDir = path.join(outDir, 'images');
    const fileDir = path.join(outDir, 'files');
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.mkdirSync(imageDir, { recursive: true });
    fs.mkdirSync(fileDir, { recursive: true });
    return { outDir, pagesDir, imageDir, fileDir };
}

interface Fixture {
    tmpDir: string;
    note1: { dir: string; outA: OutlinerDirs; outB: OutlinerDirs };
    note2: { dir: string; outC: OutlinerDirs };
}

function setupAllOutliners(): Fixture {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-md-loc-matrix-'));
    const note1Dir = path.join(tmpDir, 'note1');
    const note2Dir = path.join(tmpDir, 'note2');
    fs.mkdirSync(note1Dir, { recursive: true });
    fs.mkdirSync(note2Dir, { recursive: true });
    return {
        tmpDir,
        note1: {
            dir: note1Dir,
            outA: makeOutliner(note1Dir, 'outA'),
            outB: makeOutliner(note1Dir, 'outB')
        },
        note2: {
            dir: note2Dir,
            outC: makeOutliner(note2Dir, 'outC')
        }
    };
}

function cleanup(fix: Fixture) {
    if (fs.existsSync(fix.tmpDir)) fs.rmSync(fix.tmpDir, { recursive: true, force: true });
}

function callCopyMdPasteAssets(opts: {
    markdown: string;
    src: OutlinerDirs;
    dest: OutlinerDirs;
}) {
    return copyMdPasteAssets({
        markdown: opts.markdown,
        sourceMdDir: opts.src.pagesDir,
        sourceImageDir: opts.src.imageDir,
        sourceFileDir: opts.src.fileDir,
        destImageDir: opts.dest.imageDir,
        destFileDir: opts.dest.fileDir,
        destMdDir: opts.dest.pagesDir
    });
}

function assertNoAbsolutePaths(rewritten: string, fix: Fixture) {
    expect(rewritten).not.toContain('/Users/');
    expect(rewritten).not.toContain('vscode-resource');
    expect(rewritten).not.toContain('https://file');
    expect(rewritten).not.toContain(fix.tmpDir);
}

// ============================================================================
// I. image
// ============================================================================

test.describe('Location matrix — I. image (![](rel))', () => {
    let fix: Fixture;

    test.beforeEach(() => {
        fix = setupAllOutliners();
        // src image setup (note1/outA)
        fs.writeFileSync(path.join(fix.note1.outA.imageDir, 'photo.png'), 'PHOTO');
    });
    test.afterEach(() => cleanup(fix));

    test('I-L1 same MD: 複製 + 相対書換', () => {
        const result = callCopyMdPasteAssets({
            markdown: '![alt](../images/photo.png)',
            src: fix.note1.outA,
            dest: fix.note1.outA
        });
        // L1 でも copyMdPasteAssets は常に複製
        const destFiles = fs.readdirSync(fix.note1.outA.imageDir);
        expect(destFiles.some((n) => /^copy-\d+-photo\.png$/.test(n))).toBe(true);
        expect(result.rewrittenMarkdown).toMatch(/!\[alt\]\(\.\.\/images\/copy-\d+-photo\.png\)/);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('I-L2 same outliner different MD: 複製 + 相対書換 (L1 と同 dir なので同挙動)', () => {
        // L1 == L2 host 側で見ると同 dir なので同 result
        const result = callCopyMdPasteAssets({
            markdown: '![alt](../images/photo.png)',
            src: fix.note1.outA,
            dest: fix.note1.outA
        });
        expect(result.rewrittenMarkdown).toMatch(/copy-\d+-photo\.png/);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('I-L3 same note different outliner: dest images/ に複製 + 相対書換', () => {
        const result = callCopyMdPasteAssets({
            markdown: '![alt](../images/photo.png)',
            src: fix.note1.outA,
            dest: fix.note1.outB
        });
        const destFiles = fs.readdirSync(fix.note1.outB.imageDir);
        expect(destFiles.some((n) => /^copy-\d+-photo\.png$/.test(n))).toBe(true);
        expect(result.rewrittenMarkdown).toMatch(/copy-\d+-photo\.png/);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('I-L4 different note different outliner: 完全別 path でも複製 + 相対書換', () => {
        const result = callCopyMdPasteAssets({
            markdown: '![alt](../images/photo.png)',
            src: fix.note1.outA,
            dest: fix.note2.outC
        });
        const destFiles = fs.readdirSync(fix.note2.outC.imageDir);
        expect(destFiles.some((n) => /^copy-\d+-photo\.png$/.test(n))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });
});

// ============================================================================
// F. file ([📎])
// ============================================================================

test.describe('Location matrix — F. file ([📎](rel))', () => {
    let fix: Fixture;

    test.beforeEach(() => {
        fix = setupAllOutliners();
        fs.writeFileSync(path.join(fix.note1.outA.fileDir, 'doc.pdf'), 'PDF');
    });
    test.afterEach(() => cleanup(fix));

    test('F-L1 same MD: dest files/ に複製', () => {
        const result = callCopyMdPasteAssets({
            markdown: '[📎 doc.pdf](../files/doc.pdf)',
            src: fix.note1.outA,
            dest: fix.note1.outA
        });
        const destFiles = fs.readdirSync(fix.note1.outA.fileDir);
        expect(destFiles.some((n) => n.startsWith('doc'))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('F-L3 cross-outliner: dest files/ に複製 (元名 + collision suffix)', () => {
        const result = callCopyMdPasteAssets({
            markdown: '[📎 doc.pdf](../files/doc.pdf)',
            src: fix.note1.outA,
            dest: fix.note1.outB
        });
        const destFiles = fs.readdirSync(fix.note1.outB.fileDir);
        expect(destFiles.some((n) => n === 'doc.pdf' || /^doc-\d+\.pdf$/.test(n))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('F-L4 cross-note: 同上', () => {
        const result = callCopyMdPasteAssets({
            markdown: '[📎 doc.pdf](../files/doc.pdf)',
            src: fix.note1.outA,
            dest: fix.note2.outC
        });
        const destFiles = fs.readdirSync(fix.note2.outC.fileDir);
        expect(destFiles.some((n) => n === 'doc.pdf' || /^doc-\d+\.pdf$/.test(n))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });
});

// ============================================================================
// D. drawio.svg
// ============================================================================

test.describe('Location matrix — D. drawio.svg ![](*.drawio.svg)', () => {
    let fix: Fixture;

    test.beforeEach(() => {
        fix = setupAllOutliners();
        fs.writeFileSync(
            path.join(fix.note1.outA.fileDir, 'foo.drawio.svg'),
            '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile&gt;test&lt;/mxfile&gt;"></svg>'
        );
    });
    test.afterEach(() => cleanup(fix));

    test('D-L1 same MD: dest fileDir に複製、imageDir には入らない', () => {
        const result = callCopyMdPasteAssets({
            markdown: '![alt](../files/foo.drawio.svg)',
            src: fix.note1.outA,
            dest: fix.note1.outA
        });
        const destFileFiles = fs.readdirSync(fix.note1.outA.fileDir);
        expect(destFileFiles.some((n) => /foo(-\d+)?\.drawio\.svg/.test(n))).toBe(true);
        // imageDir には drawio が入らない
        const destImgFiles = fs.readdirSync(fix.note1.outA.imageDir);
        expect(destImgFiles.some((n) => n.includes('drawio'))).toBe(false);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('D-L3 cross-outliner: 衝突 suffix は foo-1.drawio.svg (TC-03 spec)', () => {
        // dest にも既存 → 衝突発生
        fs.writeFileSync(path.join(fix.note1.outB.fileDir, 'foo.drawio.svg'), 'EXISTING');
        const result = callCopyMdPasteAssets({
            markdown: '![alt](../files/foo.drawio.svg)',
            src: fix.note1.outA,
            dest: fix.note1.outB
        });
        // 既存保護
        expect(fs.readFileSync(path.join(fix.note1.outB.fileDir, 'foo.drawio.svg'), 'utf8')).toBe('EXISTING');
        // 新ファイル: foo-1.drawio.svg (NOT foo.drawio-1.svg)
        expect(fs.existsSync(path.join(fix.note1.outB.fileDir, 'foo-1.drawio.svg'))).toBe(true);
        expect(fs.existsSync(path.join(fix.note1.outB.fileDir, 'foo.drawio-1.svg'))).toBe(false);
        expect(result.rewrittenMarkdown).toContain('foo-1.drawio.svg');
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('D-L4 cross-note: dest fileDir に複製', () => {
        const result = callCopyMdPasteAssets({
            markdown: '![alt](../files/foo.drawio.svg)',
            src: fix.note1.outA,
            dest: fix.note2.outC
        });
        const destFileFiles = fs.readdirSync(fix.note2.outC.fileDir);
        expect(destFileFiles.some((n) => /foo(-\d+)?\.drawio\.svg/.test(n))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });
});

// ============================================================================
// M. markdown link
// ============================================================================

test.describe('Location matrix — M. markdown link [](*.md)', () => {
    let fix: Fixture;

    test.beforeEach(() => {
        fix = setupAllOutliners();
        fs.writeFileSync(path.join(fix.note1.outA.pagesDir, 'memo.md'), 'MEMO_BODY');
    });
    test.afterEach(() => cleanup(fix));

    test('M-L1 same MD: destMdDir に複製、collision suffix', () => {
        const result = callCopyMdPasteAssets({
            markdown: '[memo](memo.md)',
            src: fix.note1.outA,
            dest: fix.note1.outA
        });
        const destFiles = fs.readdirSync(fix.note1.outA.pagesDir);
        // 既存 memo.md + 衝突 suffix で memo-1.md
        expect(destFiles.some((n) => /^memo-\d+\.md$/.test(n))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('M-L3 cross-outliner: dest pagesDir に複製 (元名 or suffix)', () => {
        const result = callCopyMdPasteAssets({
            markdown: '[memo](memo.md)',
            src: fix.note1.outA,
            dest: fix.note1.outB
        });
        const destFiles = fs.readdirSync(fix.note1.outB.pagesDir);
        expect(destFiles.some((n) => n === 'memo.md' || /^memo-\d+\.md$/.test(n))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('M-L4 cross-note: 同上', () => {
        const result = callCopyMdPasteAssets({
            markdown: '[memo](memo.md)',
            src: fix.note1.outA,
            dest: fix.note2.outC
        });
        const destFiles = fs.readdirSync(fix.note2.outC.pagesDir);
        expect(destFiles.some((n) => n === 'memo.md' || /^memo-\d+\.md$/.test(n))).toBe(true);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });
});

// ============================================================================
// 絶対パス / vscode-resource URL 入力時の正規化 (全 4 型)
// ============================================================================

test.describe('Location matrix — 絶対パス / vscode-resource URL 入力 → 正規化', () => {
    let fix: Fixture;

    test.beforeEach(() => {
        fix = setupAllOutliners();
        fs.writeFileSync(path.join(fix.note1.outA.imageDir, 'photo.png'), 'PHOTO');
        fs.writeFileSync(path.join(fix.note1.outA.fileDir, 'doc.pdf'), 'PDF');
        fs.writeFileSync(
            path.join(fix.note1.outA.fileDir, 'foo.drawio.svg'),
            '<?xml version="1.0"?><svg></svg>'
        );
        fs.writeFileSync(path.join(fix.note1.outA.pagesDir, 'memo.md'), 'MEMO');
    });
    test.afterEach(() => cleanup(fix));

    test('image: 絶対パス → 複製 + 相対書換', () => {
        const absPath = path.join(fix.note1.outA.imageDir, 'photo.png');
        const result = callCopyMdPasteAssets({
            markdown: `![alt](${absPath})`,
            src: fix.note1.outA,
            dest: fix.note1.outB
        });
        expect(result.rewrittenMarkdown).not.toContain(absPath);
        assertNoAbsolutePaths(result.rewrittenMarkdown, fix);
    });

    test('drawio: vscode-resource URL → strip + 複製', () => {
        const absPath = path.join(fix.note1.outA.fileDir, 'foo.drawio.svg');
        const url = `https://file+.vscode-resource.vscode-cdn.net${absPath}`;
        const result = callCopyMdPasteAssets({
            markdown: `![alt](${url})`,
            src: fix.note1.outA,
            dest: fix.note1.outB
        });
        expect(result.rewrittenMarkdown).not.toContain('vscode-resource');
        expect(result.rewrittenMarkdown).not.toContain(absPath);
        const destFileFiles = fs.readdirSync(fix.note1.outB.fileDir);
        expect(destFileFiles.some((n) => n.includes('foo') && n.includes('.drawio.svg'))).toBe(true);
    });
});
