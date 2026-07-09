/**
 * paste-image-1to1-ownership TASK-01 — 貼り付け画像の 1:1 所有権保証
 *
 * INVARIANT: 各アセットファイルは EXACTLY ONE の node/md から参照される。異なるソース実体
 * （src 絶対パスが違う）は basename が同じでも別コピーに分岐しなければならない（データロス防止）。
 * ただし 1 つの node/md 内で同一物理ソースを複数参照した場合は 1 コピーに集約してよい（1:1 OK）。
 *
 * (A) copyMdPasteAssets       TC-1A-01 (load-bearing) / TC-1A-02
 * (B) copyAssetsAndRewriteForMd 経由（closure md）  TC-1B-01 (load-bearing)
 * (C) handleImageAssets       TC-1C-01 (regression guard) / TC-1C-02 (load-bearing)
 *
 * counterfactual: 現行の `copy-<timestamp>-<basename>` + `if(!existsSync) skip` /
 *   basename キー renameMap では、別 dir 同名別実体の 2 枚目が 1 枚目に畳み込まれ、
 *   両参照が同一ファイル（1 枚目の中身）を指す → 下記の load-bearing assert が fail する。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyMdPasteAssets, handleImageAssets } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paste-1to1-'));
}

function writeF(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

/** 本文中の画像 URL を抽出（![...](url)）。 */
function imageUrls(md: string): string[] {
    return [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
}

/** destImageDir 内の物理ファイル一覧。 */
function listImages(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
}

// ─── (A) copyMdPasteAssets ──────────────────────────────────────────────────

test('TC-1A-01 (load-bearing) 別 dir 同名・中身別の 2 画像が別コピーに', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dst = path.join(root, 'dst');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    writeF(src, 'a/pic.png', 'AAA');
    writeF(src, 'b/pic.png', 'BBB');
    const markdown = '![x](a/pic.png)\n![y](b/pic.png)';

    const { rewrittenMarkdown } = copyMdPasteAssets({
        markdown,
        sourceMdDir: src,
        sourceImageDir: src,
        sourceFileDir: src,
        destImageDir: path.join(dst, 'images'),
        destFileDir: path.join(dst, 'files'),
        destMdDir: dst,
    });

    // dst/images に 2 つの物理ファイルができる（1 つに畳まれていない）
    const files = listImages(path.join(dst, 'images'));
    expect(files.length).toBe(2);

    // rewrittenMarkdown の 2 リンクが別々の dest を指す
    const urls = imageUrls(rewrittenMarkdown);
    expect(urls.length).toBe(2);
    const abs1 = path.resolve(dst, urls[0]);
    const abs2 = path.resolve(dst, urls[1]);
    expect(abs1).not.toBe(abs2);
    expect(fs.existsSync(abs1)).toBe(true);
    expect(fs.existsSync(abs2)).toBe(true);

    // ★load-bearing: 一方 'AAA'、他方 'BBB'（2 つ目が 'AAA' に畳まれていない）
    const contents = new Set([fs.readFileSync(abs1, 'utf8'), fs.readFileSync(abs2, 'utf8')]);
    expect(contents.has('AAA')).toBe(true);
    expect(contents.has('BBB')).toBe(true);
    // 絶対パス禁止（可搬性原則）
    expect(rewrittenMarkdown).not.toContain('/Users/');
    expect(rewrittenMarkdown).not.toContain(root);
    // counterfactual: 現行（単一 timestamp + basename + skip）だと copy-<ts>-pic.png 1 つに畳まれ、
    //   両リンクが中身 'AAA' の同一ファイルを指し contents.has('BBB') が false → fail。
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-1A-02 同一物理ソースの重複参照は 1 コピーに集約（1:1 OK）', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dst = path.join(root, 'dst');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    writeF(src, 'pic.png', 'X');
    const markdown = '![a](pic.png)\n![b](pic.png)';

    const { rewrittenMarkdown } = copyMdPasteAssets({
        markdown,
        sourceMdDir: src,
        sourceImageDir: src,
        sourceFileDir: src,
        destImageDir: path.join(dst, 'images'),
        destFileDir: path.join(dst, 'files'),
        destMdDir: dst,
    });

    // dst/images に 1 つだけ（同一 src なので dedup）
    const files = listImages(path.join(dst, 'images'));
    expect(files.length).toBe(1);

    // 両リンクが同じ dest を指し、中身 'X'
    const urls = imageUrls(rewrittenMarkdown);
    expect(urls.length).toBe(2);
    expect(urls[0]).toBe(urls[1]);
    const abs = path.resolve(dst, urls[0]);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('X');
    fs.rmSync(root, { recursive: true, force: true });
});

// ─── (B) copyAssetsAndRewriteForMd 経由（closure md の画像）─────────────────

test('TC-1B-01 (load-bearing) 2 closure md が同名の別画像 → 別コピー', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dst = path.join(root, 'dst');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    // md-link 再帰を通す: root.md → a.md / b.md（同 note 内）。a.md/b.md が同名別画像を参照。
    writeF(src, 'root.md', '[a](a.md) [b](b.md)');
    writeF(src, 'a.md', '![](imgs/p.png)');
    writeF(src, 'b.md', '![](other/p.png)');
    writeF(src, 'imgs/p.png', 'PA');
    writeF(src, 'other/p.png', 'PB');

    const { rewrittenMarkdown } = copyMdPasteAssets({
        markdown: '[a](a.md) [b](b.md)',
        sourceMdDir: src,
        sourceImageDir: src,
        sourceFileDir: src,
        destImageDir: path.join(dst, 'images'),
        destFileDir: path.join(dst, 'files'),
        destMdDir: dst,
    });

    // root 本文の md-link が dst 内の a.md / b.md 複製を指す
    const mdLinks = [...rewrittenMarkdown.matchAll(/\[[ab]\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(mdLinks.length).toBe(2);
    const aAbs = path.resolve(dst, mdLinks[0]);
    const bAbs = path.resolve(dst, mdLinks[1]);
    expect(fs.existsSync(aAbs)).toBe(true);
    expect(fs.existsSync(bAbs)).toBe(true);

    // 各複製 md の画像リンクを解決
    const aImg = imageUrls(fs.readFileSync(aAbs, 'utf8'));
    const bImg = imageUrls(fs.readFileSync(bAbs, 'utf8'));
    expect(aImg.length).toBe(1);
    expect(bImg.length).toBe(1);
    const aImgAbs = path.resolve(path.dirname(aAbs), aImg[0]);
    const bImgAbs = path.resolve(path.dirname(bAbs), bImg[0]);

    // ★load-bearing: 各々の画像リンクが別々の物理ファイルを指す（一方 'PA'、他方 'PB'）
    expect(aImgAbs).not.toBe(bImgAbs);
    expect(fs.existsSync(aImgAbs)).toBe(true);
    expect(fs.existsSync(bImgAbs)).toBe(true);
    const contents = new Set([fs.readFileSync(aImgAbs, 'utf8'), fs.readFileSync(bImgAbs, 'utf8')]);
    expect(contents.has('PA')).toBe(true);
    expect(contents.has('PB')).toBe(true);

    // dst/images に 2 物理ファイル
    const files = listImages(path.join(dst, 'images'));
    expect(files.length).toBe(2);
    // counterfactual: 現行（closure md ごとに `copy-${Date.now()}-p.png` + skip）だと 1 つに畳まれ
    //   b.md が 'PA' を指す → contents.has('PB') false / files.length 1 → fail。
    fs.rmSync(root, { recursive: true, force: true });
});

// ─── (C) handleImageAssets（copyImagesCross）─────────────────────────────────

// 注: prefix が別（copy-n1-/copy-n2-）なので pre-fix でも別ファイルになる = regression ガード。
// 同一呼び出し内 basename 畳み込みの真の load-bearing は TC-1C-02。
test('TC-1C-01 (regression guard) 別実体同名を 2 回 → 別コピー', () => {
    const root = mkTmp();
    const srcA = path.join(root, 'srcA');
    const srcB = path.join(root, 'srcB');
    const dst = path.join(root, 'dst');
    writeF(srcA, 'images/pic.png', 'A');
    writeF(srcB, 'images/pic.png', 'B');
    fs.mkdirSync(dst, { recursive: true });

    const r1 = handleImageAssets({
        srcOutDir: srcA, srcPagesDir: srcA,
        destOutDir: dst, destPagesDir: dst,
        renamePrefix: 'copy-n1-',
        nodeImages: ['images/pic.png'],
    });
    const r2 = handleImageAssets({
        srcOutDir: srcB, srcPagesDir: srcB,
        destOutDir: dst, destPagesDir: dst,
        renamePrefix: 'copy-n2-',
        nodeImages: ['images/pic.png'],
    });

    // dst/images に 2 物理ファイル（'A' と 'B'）
    const files = listImages(path.join(dst, 'images'));
    expect(files.length).toBe(2);

    // 各 newNodeImages が別々の dest を指す
    expect(r1.newNodeImages.length).toBe(1);
    expect(r2.newNodeImages.length).toBe(1);
    const abs1 = path.resolve(dst, r1.newNodeImages[0]);
    const abs2 = path.resolve(dst, r2.newNodeImages[0]);
    expect(abs1).not.toBe(abs2);
    expect(fs.existsSync(abs1)).toBe(true);
    expect(fs.existsSync(abs2)).toBe(true);

    // ★load-bearing: 中身が別（2 回目が 1 回目の skip で 'A' を共有していない）
    expect(fs.readFileSync(abs1, 'utf8')).toBe('A');
    expect(fs.readFileSync(abs2, 'utf8')).toBe('B');
    // counterfactual: 現行（renamePrefix 別で dest 名は別だが、prefix が異なるので実は現行でも別名）。
    //   → 本 TC は「別 prefix で別ファイル」が保たれることの regression ガード。
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-1C-02 (load-bearing) 同一 nodeImages 内の同名別 dir 参照 → 別コピー', () => {
    const root = mkTmp();
    const srcA = path.join(root, 'srcA');
    const dst = path.join(root, 'dst');
    writeF(srcA, 'images/logo.png', 'L1');
    writeF(srcA, 'sub/logo.png', 'L2');
    fs.mkdirSync(dst, { recursive: true });

    const r = handleImageAssets({
        srcOutDir: srcA, srcPagesDir: srcA,
        destOutDir: dst, destPagesDir: dst,
        renamePrefix: 'copy-n1-',
        nodeImages: ['images/logo.png', 'sub/logo.png'],
    });

    // dst/images に 2 物理ファイル
    const files = listImages(path.join(dst, 'images'));
    expect(files.length).toBe(2);

    // newNodeImages の 2 要素が別々の dest を指す
    expect(r.newNodeImages.length).toBe(2);
    const [v1, v2] = r.newNodeImages;
    expect(v1).not.toBe(v2);
    const abs1 = path.resolve(dst, v1);
    const abs2 = path.resolve(dst, v2);
    expect(abs1).not.toBe(abs2);
    expect(fs.existsSync(abs1)).toBe(true);
    expect(fs.existsSync(abs2)).toBe(true);

    // ★load-bearing: 片方 'L1'・片方 'L2'（basename キー renameMap で畳まれず 1 つ消失していない）
    const contents = new Set([fs.readFileSync(abs1, 'utf8'), fs.readFileSync(abs2, 'utf8')]);
    expect(contents.has('L1')).toBe(true);
    expect(contents.has('L2')).toBe(true);
    // counterfactual: 現行（basename キー renameMap `copy-n1-logo.png` に両者を畳む）だと 1 つ消失し
    //   contents.size===1 → fail。
    fs.rmSync(root, { recursive: true, force: true });
});
