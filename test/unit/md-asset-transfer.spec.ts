/**
 * TC-ACC-01..03 — transferMdWithAssets（sprint 20260820-063902 FR-ACC-01・ADRL-ACC-1）
 *
 * md ファイルを資産随伴（images / 📎files / subpage 再帰閉包）で dest 座標へ複製する adapter。
 * 実体は copyMdPasteAssets（正典・無改造）— 命名も正典既存規約（画像 = copy-<ts>- / 📎・md = 元名-N）。
 * copy semantics（source 全不触）。座標指定だけでフラット⇄隣接（fv）レイアウト変換が成立する。
 *
 * 共通 fixture「資産持ち md」: ![i](images/pic.png) + [📎 a.pdf](files/a.pdf) + [[Sub]](sub.md)
 *   + 参照リンク [ref](refdoc.md)（**複製されず**リンク書換のみ = isSubpage ゲート境界の counterfactual — TDD-2）。
 *   sub.md はさらに画像持ち（再帰の番人）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
    }
}
function requirePah(): any {
    purgeSrcCache();
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../../src/shared/paste-asset-handler');
    } finally {
        purgeSrcCache();
    }
}

/** fixture: dir 直下に資産持ち md 一式を作る（layout: 'flat' = 共有 dir と同型 / 'adjacent' = fv 同型） */
function mkAssetMd(dir: string): string {
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(dir, 'images', 'deep.png'), 'DEEP', 'utf8');
    fs.writeFileSync(path.join(dir, 'files', 'a.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(dir, 'sub.md'), '# Sub\n![d](images/deep.png)\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'refdoc.md'), '# Ref\n', 'utf8');
    const md = path.join(dir, 'main.md');
    fs.writeFileSync(md, '# Main\n![i](images/pic.png)\n[📎 a.pdf](files/a.pdf)\n[[Sub]](sub.md)\n[ref](refdoc.md)\n', 'utf8');
    return md;
}

function coordsOf(dir: string) {
    return { mdDir: dir, imageDir: path.join(dir, 'images'), fileDir: path.join(dir, 'files') };
}

test('TC-ACC-01 フラット→隣接（fv）座標: 全資産随伴 + 参照リンクは非複製・書換のみ + source 全不触', () => {
    const pah = requirePah();
    expect(typeof pah.transferMdWithAssets, 'transferMdWithAssets の export 不在').toBe('function');
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-src-'));
    const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-dst-'));
    const dest = path.join(destRoot, 'folder');
    fs.mkdirSync(dest, { recursive: true });
    const srcMd = mkAssetMd(src);
    const s = coordsOf(src), d = coordsOf(dest);

    const r = pah.transferMdWithAssets(srcMd, {
        sourceMdDir: s.mdDir, sourceImageDir: s.imageDir, sourceFileDir: s.fileDir,
        destMdDir: d.mdDir, destImageDir: d.imageDir, destFileDir: d.fileDir,
    });
    expect(r.newName).toBe('main.md');
    const body = fs.readFileSync(r.destMdPath, 'utf8');
    // 画像随伴（正典命名 = copy-<ts>- prefix）+ 本文書換
    const destImgs = fs.readdirSync(d.imageDir);
    expect(destImgs.length, '画像が随伴していない').toBeGreaterThanOrEqual(2); // pic + sub の deep
    const picCopy = destImgs.find((n) => n.includes('pic.png'));
    expect(picCopy).toBeTruthy();
    expect(body).toContain(`images/${picCopy}`);
    // 📎 随伴（元名維持系）
    expect(fs.existsSync(path.join(d.fileDir, 'a.pdf'))).toBe(true);
    expect(body).toContain('files/a.pdf');
    // subpage 再帰随伴（sub.md + その画像）
    expect(fs.existsSync(path.join(dest, 'sub.md')), 'subpage が随伴していない').toBe(true);
    const subBody = fs.readFileSync(path.join(dest, 'sub.md'), 'utf8');
    const deepCopy = destImgs.find((n) => n.includes('deep.png'));
    expect(subBody).toContain(`images/${deepCopy}`);
    expect(body).toContain('(sub.md)');
    // 参照リンクは非複製・書換のみ（isSubpage ゲート境界 — TDD-2）
    expect(fs.existsSync(path.join(dest, 'refdoc.md')), '参照リンクが複製された（ゲート破り）').toBe(false);
    expect(body).not.toContain('](refdoc.md)'); // dest からの相対に書換わっている
    expect(body).toContain('refdoc.md');        // リンク自体は生存（相対パス化）
    // source 全不触（copy semantics）
    expect(fs.readFileSync(srcMd, 'utf8')).toContain('](refdoc.md)');
    expect(fs.existsSync(path.join(src, 'sub.md'))).toBe(true);
    expect(fs.readdirSync(s.imageDir).length).toBe(2);
});

test('TC-ACC-02 隣接（fv）→フラット座標: note 共有 dir + 直下へ変換されリンク解決', () => {
    const pah = requirePah();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-fv-'));
    const note = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-note-'));
    const srcMd = mkAssetMd(src);
    const s = coordsOf(src), d = coordsOf(note);

    const r = pah.transferMdWithAssets(srcMd, {
        sourceMdDir: s.mdDir, sourceImageDir: s.imageDir, sourceFileDir: s.fileDir,
        destMdDir: d.mdDir, destImageDir: d.imageDir, destFileDir: d.fileDir,
    });
    // note 直下に md + closure md（フラット）・共有 images//files/ に資産
    expect(fs.existsSync(path.join(note, 'main.md'))).toBe(true);
    expect(fs.existsSync(path.join(note, 'sub.md'))).toBe(true);
    expect(fs.readdirSync(path.join(note, 'images')).length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(note, 'files', 'a.pdf'))).toBe(true);
    const body = fs.readFileSync(r.destMdPath, 'utf8');
    expect(body).toContain('(sub.md)');
    // dest 名衝突時は uniquify（既存 main.md がある note へ再転送 → main-1.md）
    const r2 = pah.transferMdWithAssets(srcMd, {
        sourceMdDir: s.mdDir, sourceImageDir: s.imageDir, sourceFileDir: s.fileDir,
        destMdDir: d.mdDir, destImageDir: d.imageDir, destFileDir: d.fileDir,
    });
    expect(r2.newName).toBe('main-1.md');
});

test('TC-ACC-40 source containment（SEC-1）: 絶対パス /../ escape 参照は複製されない・正資産は随伴・skip リンクは書換なし温存', () => {
    const pah = requirePah();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-sec-'));
    const src = path.join(base, 'note');
    const dest = path.join(base, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    // source coords 外の「盗まれてはいけない」ファイル群
    fs.writeFileSync(path.join(base, 'escape.png'), 'ESC', 'utf8');
    fs.writeFileSync(path.join(base, 'escape2.png'), 'ESC2', 'utf8');
    fs.writeFileSync(path.join(base, 'secret.pdf'), 'SECRET', 'utf8');
    const absTarget = path.join(base, 'absfile.png');
    fs.writeFileSync(absTarget, 'ABS', 'utf8');
    // source coords 内の正資産
    fs.mkdirSync(path.join(src, 'images'), { recursive: true });
    fs.mkdirSync(path.join(src, 'files'), { recursive: true });
    fs.writeFileSync(path.join(src, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(src, 'files', 'a.pdf'), 'PDF-1', 'utf8');
    // closure member（sub.md 自体は contain 内 → 複製される）が escape 参照を持つ（closure 資産ループの番人）
    fs.writeFileSync(path.join(src, 'sub.md'), '# Sub\n![e2](../escape2.png)\n', 'utf8');
    const srcMd = path.join(src, 'main.md');
    fs.writeFileSync(srcMd, [
        '# Main',
        '![i](images/pic.png)',
        `![abs](${absTarget})`,
        '![esc](../escape.png)',
        '[📎 secret.pdf](../secret.pdf)',
        '[📎 a.pdf](files/a.pdf)',
        '[[Sub]](sub.md)',
        '',
    ].join('\n'), 'utf8');

    const r = pah.transferMdWithAssets(srcMd, {
        sourceMdDir: src, sourceImageDir: path.join(src, 'images'), sourceFileDir: path.join(src, 'files'),
        destMdDir: dest, destImageDir: path.join(dest, 'images'), destFileDir: path.join(dest, 'files'),
    });
    const body = fs.readFileSync(r.destMdPath, 'utf8');
    // 正資産は従来どおり随伴
    const imgs = fs.readdirSync(path.join(dest, 'images'));
    expect(imgs.find((n) => n.includes('pic.png'))).toBeTruthy();
    expect(fs.existsSync(path.join(dest, 'files', 'a.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'sub.md'))).toBe(true);
    // containment: 外部ファイルは dest のどこにも複製されない（counterfactual: containment を外すと湧く）
    expect(imgs.find((n) => n.includes('absfile')), '絶対パス参照が複製された').toBeFalsy();
    expect(imgs.find((n) => n.includes('escape')), '../ escape 参照が複製された').toBeFalsy();
    expect(fs.readdirSync(path.join(dest, 'files')).find((n) => n.includes('secret'))).toBeFalsy();
    // closure member（sub.md）の escape 参照も複製されない + リンクは書換なし温存
    expect(fs.readFileSync(path.join(dest, 'sub.md'), 'utf8')).toContain('(../escape2.png)');
    // skip したリンクは書換なし温存（欠損参照と同じ流儀）
    expect(body).toContain(`![abs](${absTarget})`);
    expect(body).toContain('![esc](../escape.png)');
    expect(body).toContain('[📎 secret.pdf](../secret.pdf)');
    // source 側の外部ファイルは無傷
    expect(fs.readFileSync(path.join(base, 'escape.png'), 'utf8')).toBe('ESC');
});

test('TC-ACC-41 duplicateMdEntity containment（SEC-1）: ../ escape 参照は複製対象外（外部 dir 書込ゼロ）・正常 rel は従来複製', () => {
    const pah = requirePah();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-dup-'));
    const note = path.join(base, 'note');
    fs.mkdirSync(path.join(note, 'images'), { recursive: true });
    fs.writeFileSync(path.join(base, 'outside.png'), 'OUT', 'utf8');
    fs.writeFileSync(path.join(note, 'images', 'pic.png'), 'PNG-1', 'utf8');
    const md = path.join(note, 'main.md');
    fs.writeFileSync(md, '# Main\n![i](images/pic.png)\n![o](../outside.png)\n', 'utf8');
    const baseEntriesBefore = fs.readdirSync(base).sort();

    const r = pah.duplicateMdEntity(md, note);
    expect(fs.existsSync(r.newMdPath)).toBe(true);
    // 正常 rel は従来どおり uniquify 複製（note/images 内に pic の複製が増える）
    expect(fs.readdirSync(path.join(note, 'images')).length).toBe(2);
    // ../ escape は複製対象外 = 外部 dir（base）への書込ゼロ（counterfactual: skip を外すと outside-1.png が湧く）
    expect(fs.readdirSync(base).sort()).toEqual(baseEntriesBefore);
    // escape リンクは書換なし温存
    expect(fs.readFileSync(r.newMdPath, 'utf8')).toContain('(../outside.png)');
});

test('TC-ACC-03 資産なし md = dest md 1 個のみ・空 dir 非作成 / 循環 subpage は各 1 個で閉じる', () => {
    const pah = requirePah();
    // (a) 資産なし
    const src1 = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-plain-'));
    const dst1 = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-plain-d-'));
    const md1 = path.join(src1, 'plain.md');
    fs.writeFileSync(md1, '# Plain\njust text\n', 'utf8');
    pah.transferMdWithAssets(md1, {
        sourceMdDir: src1, sourceImageDir: path.join(src1, 'images'), sourceFileDir: path.join(src1, 'files'),
        destMdDir: dst1, destImageDir: path.join(dst1, 'images'), destFileDir: path.join(dst1, 'files'),
    });
    expect(fs.existsSync(path.join(dst1, 'plain.md'))).toBe(true);
    expect(fs.existsSync(path.join(dst1, 'images')), '空 images/ が作られた').toBe(false);
    expect(fs.existsSync(path.join(dst1, 'files')), '空 files/ が作られた').toBe(false);
    // (b) 循環 subpage（a↔b）
    const src2 = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-cyc-'));
    const dst2 = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-cyc-d-'));
    fs.writeFileSync(path.join(src2, 'b.md'), '# B\n[[A]](a.md)\n', 'utf8');
    const a = path.join(src2, 'a.md');
    fs.writeFileSync(a, '# A\n[[B]](b.md)\n', 'utf8');
    pah.transferMdWithAssets(a, {
        sourceMdDir: src2, sourceImageDir: path.join(src2, 'images'), sourceFileDir: path.join(src2, 'files'),
        destMdDir: dst2, destImageDir: path.join(dst2, 'images'), destFileDir: path.join(dst2, 'files'),
    });
    // b は 1 個だけ（visited 打ち切り）
    const mds = fs.readdirSync(dst2).filter((n) => n.endsWith('.md'));
    expect(mds.filter((n) => n.startsWith('b')).length).toBe(1);
});
