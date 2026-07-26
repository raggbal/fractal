/**
 * md-move-link-recursion-unify TASK-02 — handlePageAssets whole-link 書換 + 完全再帰
 *
 * scope2（部分文字列誤置換 + basename 衝突の解消）:
 *   TC-HPA-01 (load-bearing) a.png 改名が banana.png を巻き込まない
 *   TC-HPA-02 (load-bearing) 同一 basename 別 dir 画像が衝突せず両方残る
 *   TC-HPA-03            file リンク書換も whole-link
 * scope3（完全再帰）:
 *   TC-HPA-10 (load-bearing) 多段 md-link A→B→C を全複製 + dst 内解決
 *   TC-HPA-11            再帰複製 md の画像も複製先を指す
 *   TC-HPA-12            copy 経路なので src 温存
 *   TC-HPA-20            外部リンクは相対書換・絶対禁止
 *   TC-HPA-30            後方互換: cut 経路は再帰しない + nodeImages 単純ケース不変
 *   TC-HPA-31 (load-bearing) basename 衝突ケースの nodeImages が両方別解決
 *
 * outliner per-note レイアウト:
 *   srcOutDir = <note>            （.out ファイルの dir）
 *   srcPagesDir = <note>/pages    （page md / images / files の親）
 *   page md   = srcPagesDir/<pageId>.md
 *   images    = srcPagesDir/images/*
 *   files     = srcPagesDir/files/*
 *   nodeImages ref = destOutDir 基準相対（例 'pages/images/x.png' or 'images/x.png'）
 *   body image ref = md（= srcPagesDir）基準相対（例 'images/x.png'）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handlePageAssets } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hpa-rec-'));
}

/** src note (out=<root>/src, pages=<root>/src/pages) と dst note を用意。 */
function setup(): {
    root: string;
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
} {
    const root = mkTmp();
    const srcOutDir = path.join(root, 'src');
    const srcPagesDir = path.join(srcOutDir, 'pages');
    const destOutDir = path.join(root, 'dst');
    const destPagesDir = path.join(destOutDir, 'pages');
    fs.mkdirSync(srcPagesDir, { recursive: true });
    fs.mkdirSync(destPagesDir, { recursive: true });
    return { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir };
}

function writeSrc(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

// ─── scope2 ───────────────────────────────────────────────────────────────

test('TC-HPA-01 (load-bearing) a.png 改名が banana.png を巻き込まない', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    writeSrc(srcPagesDir, 'images/a.png', 'A-DATA');
    writeSrc(srcPagesDir, 'images/banana.png', 'BANANA-DATA');
    writeSrc(srcPagesDir, 'src1.md', '![a](images/a.png) ![banana](images/banana.png)');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'src1', newPageId: 'dst1', nodeImages: [],
    });

    const body = fs.readFileSync(path.join(destPagesDir, 'dst1.md'), 'utf8');
    // 両画像 URL を抽出
    const urls = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(urls.length).toBe(2);
    const aUrl = urls.find(u => /a\.png$/.test(u) && !/banana/.test(u))!;
    const bananaUrl = urls.find(u => /banana\.png$/.test(u))!;
    expect(aUrl).toBeTruthy();
    expect(bananaUrl).toBeTruthy();
    // ★load-bearing: banana の URL は末尾 banana.png のまま（a.png 改名が substring として文字列途中に
    //   埋め込まれて壊れていない）。旧実装の `.replace(/a\.png/g)` だと banana.png → bana<a.png改名> になり
    //   末尾が banana.png でなくなる。
    expect(bananaUrl.endsWith('banana.png')).toBe(true);
    // banana URL 内に a 画像の改名値が混入していない（両者は独立した dest 名を持つ）
    expect(bananaUrl).not.toContain(aUrl.replace(/^.*\//, ''));
    // 両画像とも dst に別々に実在し、リンクが解決する
    expect(fs.existsSync(path.resolve(destPagesDir, aUrl))).toBe(true);
    expect(fs.existsSync(path.resolve(destPagesDir, bananaUrl))).toBe(true);
    expect(fs.readFileSync(path.resolve(destPagesDir, aUrl), 'utf8')).toBe('A-DATA');
    expect(fs.readFileSync(path.resolve(destPagesDir, bananaUrl), 'utf8')).toBe('BANANA-DATA');
    // counterfactual: basename `.replace(/a\.png/g)` だと banana.png の URL が bancopy-...-a.png 的に壊れ、
    //   bananaUrl が copy-dst1 を含む / 解決不能になり上の assert が fail する。
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-HPA-02 (load-bearing) 同一 basename 別 dir 画像が衝突せず両方残る', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    writeSrc(srcPagesDir, 'images/logo.png', 'IMAGES-LOGO');
    writeSrc(srcPagesDir, 'sub/logo.png', 'SUB-LOGO');
    writeSrc(srcPagesDir, 'src2.md', '![1](images/logo.png) ![2](sub/logo.png)');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'src2', newPageId: 'dst2', nodeImages: [],
    });

    const body = fs.readFileSync(path.join(destPagesDir, 'dst2.md'), 'utf8');
    const urls = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(urls.length).toBe(2);
    const [u1, u2] = urls;
    // ★load-bearing: 2 リンクが別々のファイルを指し、内容が別（片方消失していない）
    const abs1 = path.resolve(destPagesDir, u1);
    const abs2 = path.resolve(destPagesDir, u2);
    expect(u1).not.toBe(u2);
    expect(fs.existsSync(abs1)).toBe(true);
    expect(fs.existsSync(abs2)).toBe(true);
    expect(abs1).not.toBe(abs2);
    const contents = new Set([
        fs.readFileSync(abs1, 'utf8'),
        fs.readFileSync(abs2, 'utf8'),
    ]);
    expect(contents.has('IMAGES-LOGO')).toBe(true);
    expect(contents.has('SUB-LOGO')).toBe(true);
    // counterfactual: basename キー renameMap（現行）だと 2 枚目 skip で片方消失 → contents.size===1 になり fail。
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-HPA-03 file リンク書換も whole-link (substring 関係)', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    writeSrc(srcPagesDir, 'files/doc.pdf', 'DOC');
    writeSrc(srcPagesDir, 'files/doc.pdf.bak', 'DOC-BAK');
    // 事前に dst 側へ衝突ファイルを置き、rename を強制（doc.pdf → doc-1.pdf 等）
    writeSrc(destPagesDir, 'files/doc.pdf', 'EXISTING');
    writeSrc(destPagesDir, 'files/doc.pdf.bak', 'EXISTING-BAK');
    writeSrc(srcPagesDir, 'src3.md', '[📎 d](files/doc.pdf) [📎 dd](files/doc.pdf.bak)');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'src3', newPageId: 'dst3', nodeImages: [],
    });

    const body = fs.readFileSync(path.join(destPagesDir, 'dst3.md'), 'utf8');
    const urls = [...body.matchAll(/\[📎[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(urls.length).toBe(2);
    // doc.pdf を指す URL と doc.pdf.bak を指す URL がそれぞれ dst に解決する
    for (const u of urls) {
        expect(fs.existsSync(path.resolve(destPagesDir, u))).toBe(true);
    }
    // 内容が別々（doc.pdf 改名が doc.pdf.bak を壊していない）
    const contents = urls.map(u => fs.readFileSync(path.resolve(destPagesDir, u), 'utf8'));
    expect(new Set(contents).has('DOC')).toBe(true);
    expect(new Set(contents).has('DOC-BAK')).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

// ─── scope3 ───────────────────────────────────────────────────────────────

test('TC-HPA-10 (load-bearing) 多段 md-link A→B→C を全複製 + dst 内解決', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    // ★subpage marker `[[]]` のみ複製対象（ゲート反転・ADR-0009）。参照 `[]` は複製されない。
    writeSrc(srcPagesDir, 'A.md', '[[b]](B.md)');
    writeSrc(srcPagesDir, 'B.md', '[[c]](C.md)');
    writeSrc(srcPagesDir, 'C.md', '# c');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'A', newPageId: 'dstA', nodeImages: [],
    });

    // dstA.md + B + C 相当（>=3 枚の .md）
    const mdFiles = fs.readdirSync(destPagesDir).filter(f => f.endsWith('.md'));
    expect(mdFiles.length).toBeGreaterThanOrEqual(3);

    // ★load-bearing: dstA 本文 subpage [[b]] が dst 内 B を指す（URL span のみ書換で marker 保持）
    const aBody = fs.readFileSync(path.join(destPagesDir, 'dstA.md'), 'utf8');
    const mB = aBody.match(/\[+b\]+\(([^)]+)\)/);
    expect(mB).toBeTruthy();
    const bAbs = path.resolve(destPagesDir, mB![1]);
    expect(fs.existsSync(bAbs)).toBe(true);
    // その B 複製本文 subpage [[c]] が dst 内 C を指す（全リンク dst 内解決）
    const bBody = fs.readFileSync(bAbs, 'utf8');
    const mC = bBody.match(/\[+c\]+\(([^)]+)\)/);
    expect(mC).toBeTruthy();
    const cAbs = path.resolve(path.dirname(bAbs), mC![1]);
    expect(fs.existsSync(cAbs)).toBe(true);
    expect(fs.readFileSync(cAbs, 'utf8')).toBe('# c');
    // counterfactual: 1 階層のみ（現行）だと C が複製されず bBody の [c] が dst 内で解決不能 → cAbs 不在で fail。
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-HPA-11 再帰複製 md の画像も複製先を指す', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    // ★subpage marker `[[]]` のみ複製対象。参照 `[]` は複製されない。
    writeSrc(srcPagesDir, 'A.md', '[[b]](B.md)');
    writeSrc(srcPagesDir, 'B.md', '![](images/bp.png)');
    writeSrc(srcPagesDir, 'images/bp.png', 'BP-DATA');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'A', newPageId: 'dstA', nodeImages: [],
    });

    const aBody = fs.readFileSync(path.join(destPagesDir, 'dstA.md'), 'utf8');
    const mB = aBody.match(/\[+b\]+\(([^)]+)\)/);
    expect(mB).toBeTruthy();
    const bAbs = path.resolve(destPagesDir, mB![1]);
    expect(fs.existsSync(bAbs)).toBe(true);
    const bBody = fs.readFileSync(bAbs, 'utf8');
    const mImg = bBody.match(/!\[\]\(([^)]+)\)/);
    expect(mImg).toBeTruthy();
    const imgAbs = path.resolve(path.dirname(bAbs), mImg![1]);
    // B 複製本文の画像リンクが dst 配下を指し実在
    expect(fs.existsSync(imgAbs)).toBe(true);
    expect(fs.readFileSync(imgAbs, 'utf8')).toBe('BP-DATA');
    expect(path.resolve(imgAbs).startsWith(path.resolve(destPagesDir))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-HPA-12 copy 経路なので src 温存', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    // ★subpage marker `[[]]` = 複製対象 closure（B/C も複製される）。copy 経路なので src も温存される。
    writeSrc(srcPagesDir, 'A.md', '[[b]](B.md)');
    writeSrc(srcPagesDir, 'B.md', '[[c]](C.md)');
    writeSrc(srcPagesDir, 'C.md', '# c');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'A', newPageId: 'dstA', nodeImages: [],
    });

    // copy なので src はすべて残る
    expect(fs.existsSync(path.join(srcPagesDir, 'A.md'))).toBe(true);
    expect(fs.existsSync(path.join(srcPagesDir, 'B.md'))).toBe(true);
    expect(fs.existsSync(path.join(srcPagesDir, 'C.md'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-HPA-13 (load-bearing) 参照リンク [ref](x.md) は複製されない（ゲート反転の番人）', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    // A は R への「参照」リンク（プレーン `[]`）を持つ。R は自note内に実在するが subpage marker ではない。
    // ゲート反転（ADR-0009）後: 参照リンクは複製ゲートを通らない = R は複製されない（URL 書換のみ）。
    writeSrc(srcPagesDir, 'A.md', '[ref](R.md)');
    writeSrc(srcPagesDir, 'R.md', '# r');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'A', newPageId: 'dstA', nodeImages: [],
    });

    // ★load-bearing: R が dst に複製されない（dstA.md だけ = .md は 1 枚）。
    //   ゲート反転前（= 全 md リンクを follow）だと R が複製され .md が 2 枚になり fail する。
    const mdFiles = fs.readdirSync(destPagesDir).filter(f => f.endsWith('.md'));
    expect(mdFiles).toEqual(['dstA.md']);
    expect(fs.existsSync(path.join(destPagesDir, 'R.md'))).toBe(false);

    // 参照リンクは URL 書換のみ（複製先でなく元 R への相対で解決・絶対パスにしない）。
    const aBody = fs.readFileSync(path.join(destPagesDir, 'dstA.md'), 'utf8');
    expect(aBody).not.toContain('/Users/');
    expect(aBody).not.toContain(root);
    const mRef = aBody.match(/\[ref\]\(([^)]+)\)/);
    expect(mRef).toBeTruthy();
    expect(path.isAbsolute(mRef![1])).toBe(false);
    // 書換後 URL は元 R.md（複製されていない）に解決する。
    const refAbs = path.resolve(destPagesDir, mRef![1]);
    expect(fs.existsSync(refAbs)).toBe(true);
    expect(fs.readFileSync(refAbs, 'utf8')).toBe('# r');
    expect(path.resolve(refAbs)).toBe(path.resolve(srcPagesDir, 'R.md'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-HPA-20 外部リンクは相対書換・絶対禁止', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    // srcPagesDir 外の兄弟 md
    writeSrc(srcOutDir, '外部/X.md', '# x');
    // ★subpage [[b]] = 自note内複製対象。[x] は自note外 subpage でも参照でも複製されない（ADRL-0002）ので
    //   external 相対書換のみ検証するため参照 `[]` のまま置く。
    writeSrc(srcPagesDir, 'A.md', '[[b]](B.md) [x](../外部/X.md)');
    writeSrc(srcPagesDir, 'B.md', '# b');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'A', newPageId: 'dstA', nodeImages: [],
    });

    const aBody = fs.readFileSync(path.join(destPagesDir, 'dstA.md'), 'utf8');
    // X は複製されない
    expect(fs.readdirSync(destPagesDir).some(f => f === 'X.md')).toBe(false);
    // dst A 本文の [x] が絶対パスを含まない（相対）
    expect(aBody).not.toContain('/Users/');
    expect(aBody).not.toContain(root);
    const mX = aBody.match(/\[x\]\(([^)]+)\)/);
    expect(mX).toBeTruthy();
    expect(path.isAbsolute(mX![1])).toBe(false);
    // 相対で元 X に解決する
    expect(fs.existsSync(path.resolve(destPagesDir, mX![1]))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-HPA-30 後方互換: cut 経路は再帰しない + nodeImages 単純ケース不変', () => {
    // (a) cut 経路は closure 再帰しない（subpage marker があっても B が複製されず名前維持）
    {
        const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
        // subpage marker でも cut 経路は再帰しない（!isCut ブロックを通らない）ことを検証。
        writeSrc(srcPagesDir, 'A.md', '[[b]](B.md)');
        writeSrc(srcPagesDir, 'B.md', '# b');
        handlePageAssets({
            srcOutDir, srcPagesDir, destOutDir, destPagesDir,
            pageId: 'A', newPageId: null, nodeImages: [],
        });
        const aBody = fs.readFileSync(path.join(destPagesDir, 'A.md'), 'utf8');
        // cut は名前維持（B.md リンクがそのまま・複製されない）
        expect(aBody).toContain('B.md');
        // cut では B が dst に複製されない（closure 再帰しない）
        expect(fs.readdirSync(destPagesDir).filter(f => f.endsWith('.md')).length).toBe(1);
        fs.rmSync(root, { recursive: true, force: true });
    }
    // (b) copy 単純ケースの nodeImages 出力形式が現行と同一（destOutDir 基準相対）
    {
        const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
        writeSrc(srcPagesDir, 'images/x.png', 'X-DATA');
        writeSrc(srcPagesDir, 'node1.md', '![](images/x.png)');
        const result = handlePageAssets({
            srcOutDir, srcPagesDir, destOutDir, destPagesDir,
            pageId: 'node1', newPageId: 'dstN', nodeImages: ['images/x.png'],
        });
        // destImagesDir = destPagesDir/images、destOutDir 基準では pages/images。
        // 単純ケース（衝突なし）は後方互換の `copy-<newPageId>-<basename>` 形式（index を付けない）。
        expect(result.newNodeImages.length).toBe(1);
        const nv = result.newNodeImages[0];
        // destOutDir 基準相対（絶対パスでない・pages/images/ を含む）
        expect(path.isAbsolute(nv)).toBe(false);
        expect(nv).toContain('copy-dstN-x.png');
        expect(nv).toBe('pages/images/copy-dstN-x.png');
        // 実ファイルに解決する
        expect(fs.existsSync(path.resolve(destOutDir, nv))).toBe(true);
        expect(fs.readFileSync(path.resolve(destOutDir, nv), 'utf8')).toBe('X-DATA');
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('TC-HPA-31 (load-bearing) basename 衝突ケースの nodeImages が両方別解決', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    writeSrc(srcPagesDir, 'images/logo.png', 'IMAGES-LOGO');
    writeSrc(srcPagesDir, 'sub/logo.png', 'SUB-LOGO');
    writeSrc(srcPagesDir, 'n.md', '![1](images/logo.png) ![2](sub/logo.png)');

    const result = handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'n', newPageId: 'dstN', nodeImages: ['images/logo.png', 'sub/logo.png'],
    });

    expect(result.newNodeImages.length).toBe(2);
    const [v1, v2] = result.newNodeImages;
    // ★load-bearing: 2 要素が別々の dest ファイルを指す（同一値に潰れない）
    expect(v1).not.toBe(v2);
    const abs1 = path.resolve(destOutDir, v1);
    const abs2 = path.resolve(destOutDir, v2);
    expect(abs1).not.toBe(abs2);
    expect(fs.existsSync(abs1)).toBe(true);
    expect(fs.existsSync(abs2)).toBe(true);
    const contents = new Set([fs.readFileSync(abs1, 'utf8'), fs.readFileSync(abs2, 'utf8')]);
    expect(contents.has('IMAGES-LOGO')).toBe(true);
    expect(contents.has('SUB-LOGO')).toBe(true);
    // counterfactual: basename キー renameMap（現行）だと両 nodeImage が同一 newBase に潰れ 1 枚消失 → fail。
    fs.rmSync(root, { recursive: true, force: true });
});
