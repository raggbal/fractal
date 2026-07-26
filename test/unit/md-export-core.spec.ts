/**
 * md-export-core — collectExportClosure（収集）と exportBundle（出力）の unit テスト。
 * sprint 20260720-170429-md-export-bundle。fs は実 tmp dir で検証（ブラウザ不要）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectExportClosure, exportBundle, demoteSubpageLinks, ExportOptions } from '../../src/shared/md-export-core';

const OPT = (o: Partial<ExportOptions>): ExportOptions => ({
    includeChildren: false, recurseChildren: false, includeLinks: false, recurseLinks: false, ...o,
});

let tmp: string;
test.beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-export-')); });
test.afterEach(() => { if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); });

const w = (rel: string, body: string): string => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
    return abs;
};
// bundle 内 md 名の集合（root basename 相当）
const names = (arr: string[]) => arr.map((p) => path.basename(p)).sort();

test.describe('collectExportClosure', () => {
    // TC-EX-01: 両 include off → root のみ
    test('TC-EX-01 closure=root のみ（両 include off）', () => {
        const root = w('root.md', 'text [[a]](a.md) and [x](x.md)');
        w('a.md', 'child'); w('x.md', 'link');
        const c = collectExportClosure(root, OPT({}));
        expect(names(c)).toEqual(['root.md']);
    });

    // TC-EX-02: 子 1 階層（recurse off）→ 孫を含まない
    test('TC-EX-02 子 1 階層（recurse off）', () => {
        const root = w('root.md', '[[a]](a.md)');
        w('a.md', '[[b]](b.md)'); w('b.md', 'grand');
        const c = collectExportClosure(root, OPT({ includeChildren: true, recurseChildren: false }));
        expect(names(c)).toEqual(['a.md', 'root.md']);   // b は含まない
    });

    // TC-EX-03: 子 再帰 → 孫まで（counterfactual: TC-EX-02 と対）
    test('TC-EX-03 子 再帰（孫まで）', () => {
        const root = w('root.md', '[[a]](a.md)');
        w('a.md', '[[b]](b.md)'); w('b.md', 'grand');
        const c = collectExportClosure(root, OPT({ includeChildren: true, recurseChildren: true }));
        expect(names(c)).toEqual(['a.md', 'b.md', 'root.md']);
    });

    // TC-EX-04: リンク先 1 階層（recurse off）
    test('TC-EX-04 リンク先 1 階層', () => {
        const root = w('root.md', '[x](x.md)');
        w('x.md', '[y](y.md)'); w('y.md', 'deep');
        const c = collectExportClosure(root, OPT({ includeLinks: true, recurseLinks: false }));
        expect(names(c)).toEqual(['root.md', 'x.md']);   // y は含まない
    });

    // TC-EX-05: リンク先 再帰
    test('TC-EX-05 リンク先 再帰', () => {
        const root = w('root.md', '[x](x.md)');
        w('x.md', '[y](y.md)'); w('y.md', 'deep');
        const c = collectExportClosure(root, OPT({ includeLinks: true, recurseLinks: true }));
        expect(names(c)).toEqual(['root.md', 'x.md', 'y.md']);
    });

    // TC-EX-06: 循環（A→B→A）で有限終了・各 1 回（load-bearing: visited 無しなら無限）
    test('TC-EX-06 循環で有限終了', () => {
        const a = w('a.md', '[[b]](b.md)');
        w('b.md', '[[a]](a.md)');
        const c = collectExportClosure(a, OPT({ includeChildren: true, recurseChildren: true }));
        expect(names(c)).toEqual(['a.md', 'b.md']);   // 各 1 回、ハングしない
    });

    // TC-EX-07: リンク先 越境（別ディレクトリの .md）
    test('TC-EX-07 リンク先 越境', () => {
        const root = w('noteA/root.md', '[z](../noteB/z.md)');
        w('noteB/z.md', 'other note');
        const c = collectExportClosure(root, OPT({ includeLinks: true }));
        expect(names(c)).toEqual(['root.md', 'z.md']);   // note 境界を越える
    });

    // TC-EX-08: 解決不能リンクはスキップ
    test('TC-EX-08 解決不能リンクはスキップ', () => {
        const root = w('root.md', '[q](missing.md)');
        const c = collectExportClosure(root, OPT({ includeLinks: true }));
        expect(names(c)).toEqual(['root.md']);
    });

    // TC-EX-09: 子とリンク先の混在・visited 共有（同じ a を両方で指す → 1 回）
    test('TC-EX-09 子とリンク先の混在で重複なし', () => {
        const root = w('root.md', '[[a]](a.md) and [a](a.md)');
        w('a.md', 'both');
        const c = collectExportClosure(root, OPT({ includeChildren: true, includeLinks: true }));
        expect(names(c)).toEqual(['a.md', 'root.md']);
        expect(c.length).toBe(2);   // a は 1 回だけ
    });
});

test.describe('exportBundle', () => {
    // TC-EX-10: レイアウト（<dest>/<rootBase>/ + images/ + files/ + flat md）
    test('TC-EX-10 レイアウト', () => {
        const root = w('src/root.md', '[[child]](child.md)');
        w('src/child.md', 'child body');
        const dest = path.join(tmp, 'out'); fs.mkdirSync(dest);
        const r = exportBundle({ rootMdAbs: root, dest, options: OPT({ includeChildren: true }) });
        expect(r.ok).toBe(true);
        expect(r.bundleDir).toBe(path.join(dest, 'root'));
        expect(fs.existsSync(path.join(r.bundleDir, 'root.md'))).toBe(true);
        expect(fs.existsSync(path.join(r.bundleDir, 'child.md'))).toBe(true);   // flat
        expect(fs.existsSync(path.join(r.bundleDir, 'images'))).toBe(true);
        expect(fs.existsSync(path.join(r.bundleDir, 'files'))).toBe(true);
        expect(r.mdCount).toBe(2);
    });

    // TC-EX-11: md 名衝突 → 連番 + 本文リンク書換（load-bearing: 同名別実体で衝突を実成立）
    test('TC-EX-11 md 名衝突は連番 + 本文書換', () => {
        const root = w('src/root.md', '[[foo]](sub1/foo.md) and [bar](sub2/foo.md)');
        w('src/sub1/foo.md', 'foo one');
        w('src/sub2/foo.md', 'foo two');
        const dest = path.join(tmp, 'out'); fs.mkdirSync(dest);
        const r = exportBundle({ rootMdAbs: root, dest, options: OPT({ includeChildren: true, includeLinks: true }) });
        expect(r.ok).toBe(true);
        // 2 実体が bundle 直下に別名で存在
        expect(fs.existsSync(path.join(r.bundleDir, 'foo.md'))).toBe(true);
        expect(fs.existsSync(path.join(r.bundleDir, 'foo-1.md'))).toBe(true);
        // root 本文の 2 リンクが各々 foo.md / foo-1.md（flat 相対）を指す
        const rootOut = fs.readFileSync(path.join(r.bundleDir, 'root.md'), 'utf8');
        expect(rootOut).toContain('](foo.md)');
        expect(rootOut).toContain('](foo-1.md)');
        expect(rootOut).not.toContain('sub1/');
        expect(rootOut).not.toContain('sub2/');
    });

    // TC-EX-12: 画像/添付集約 + 書換（元名保持・prefix なし・ensureDir）
    test('TC-EX-12 画像/添付集約は元名保持', () => {
        const root = w('src/root.md', '![p](images/p.png)\n\n[📎 doc](files/d.pdf)');
        w('src/images/p.png', 'PNGDATA');
        w('src/files/d.pdf', 'PDFDATA');
        const dest = path.join(tmp, 'out'); fs.mkdirSync(dest);
        const r = exportBundle({ rootMdAbs: root, dest, options: OPT({}) });
        expect(r.ok).toBe(true);
        expect(fs.existsSync(path.join(r.bundleDir, 'images', 'p.png'))).toBe(true);   // 元名保持（copy-<ts>- なし）
        expect(fs.existsSync(path.join(r.bundleDir, 'files', 'd.pdf'))).toBe(true);
        const rootOut = fs.readFileSync(path.join(r.bundleDir, 'root.md'), 'utf8');
        expect(rootOut).toContain('images/p.png');
        expect(rootOut).toContain('files/d.pdf');
        expect(rootOut).not.toContain('copy-');
        expect(r.imageCount).toBe(1);
        expect(r.fileCount).toBe(1);
    });

    // TC-EX-13: drawio.svg は files/ へ（![]() 構文でも）
    test('TC-EX-13 drawio は files/ へ振り分け', () => {
        const root = w('src/root.md', '![d](images/x.drawio.svg)');
        w('src/images/x.drawio.svg', '<svg/>');
        const dest = path.join(tmp, 'out'); fs.mkdirSync(dest);
        const r = exportBundle({ rootMdAbs: root, dest, options: OPT({}) });
        expect(r.ok).toBe(true);
        expect(fs.existsSync(path.join(r.bundleDir, 'files', 'x.drawio.svg'))).toBe(true);
        expect(fs.existsSync(path.join(r.bundleDir, 'images', 'x.drawio.svg'))).toBe(false);
        const rootOut = fs.readFileSync(path.join(r.bundleDir, 'root.md'), 'utf8');
        expect(rootOut).toContain('files/x.drawio.svg');
    });

    // TC-EX-14: bundle フォルダ名衝突 → rootBase-1 に退避
    test('TC-EX-14 bundle フォルダ名衝突は退避', () => {
        const root = w('src/root.md', 'body');
        const dest = path.join(tmp, 'out'); fs.mkdirSync(dest);
        fs.mkdirSync(path.join(dest, 'root'));   // 既存
        const r = exportBundle({ rootMdAbs: root, dest, options: OPT({}) });
        expect(r.ok).toBe(true);
        expect(r.bundleDir).toBe(path.join(dest, 'root-1'));   // 上書きしない
    });

    // TC-EX-15: 副作用ゼロ（元 md・元画像が不変）
    test('TC-EX-15 副作用ゼロ', () => {
        const root = w('src/root.md', '![p](images/p.png)');
        const img = w('src/images/p.png', 'ORIGINAL');
        const beforeMd = fs.readFileSync(root, 'utf8');
        const beforeImg = fs.readFileSync(img, 'utf8');
        const dest = path.join(tmp, 'out'); fs.mkdirSync(dest);
        exportBundle({ rootMdAbs: root, dest, options: OPT({}) });
        expect(fs.readFileSync(root, 'utf8')).toBe(beforeMd);       // 元 md 不変
        expect(fs.readFileSync(img, 'utf8')).toBe(beforeImg);       // 元画像 不変
    });

    // TC-EX-19: bundle 内で subpage `[[title]](path)` が通常リンク `[title](path)` に変換される（FR-EX-10）
    test('TC-EX-19 subpage リンクが通常リンクに変換（外部可搬）', () => {
        const root = w('src/root.md', '[[Child]](child.md) and [Ref](ref.md)\n\n![pic](images/p.png)');
        w('src/child.md', '# Child\n[[Grand]](grand.md)');
        w('src/grand.md', '# Grand');
        w('src/ref.md', '# Ref');
        w('src/images/p.png', 'PNG');
        const dest = path.join(tmp, 'out'); fs.mkdirSync(dest);
        const r = exportBundle({ rootMdAbs: root, dest, options: OPT({ includeChildren: true, recurseChildren: true, includeLinks: true }) });
        expect(r.ok).toBe(true);
        const rootOut = fs.readFileSync(path.join(r.bundleDir, 'root.md'), 'utf8');
        // subpage → 通常リンク（`[[` が消える）
        expect(rootOut).toContain('[Child](child.md)');
        expect(rootOut).not.toContain('[[Child]]');
        expect(rootOut).not.toContain('[[');
        // 参照リンク・画像は不変
        expect(rootOut).toContain('[Ref](ref.md)');
        expect(rootOut).toContain('![pic](images/p.png)');
        // 子 md 内の subpage も変換される
        const childOut = fs.readFileSync(path.join(r.bundleDir, 'child.md'), 'utf8');
        expect(childOut).toContain('[Grand](grand.md)');
        expect(childOut).not.toContain('[[Grand]]');
    });
});

test.describe('demoteSubpageLinks (純関数)', () => {
    // TC-EX-19b: helper 単体。subpage のみ変換、参照/画像/複数を保持（counterfactual 込み）
    test('TC-EX-19b subpage のみ [ ] 化・他は不変', () => {
        expect(demoteSubpageLinks('[[A]](a.md)')).toBe('[A](a.md)');
        expect(demoteSubpageLinks('[B](b.md)')).toBe('[B](b.md)');            // 参照リンクは不変
        expect(demoteSubpageLinks('![img](x.png)')).toBe('![img](x.png)');   // 画像は不変
        expect(demoteSubpageLinks('start [[A]](a.md) mid [B](b.md) ![i](i.png) end'))
            .toBe('start [A](a.md) mid [B](b.md) ![i](i.png) end');           // 混在
        expect(demoteSubpageLinks('[[X]](x.md) [[Y]](y.md)')).toBe('[X](x.md) [Y](y.md)'); // 複数
        expect(demoteSubpageLinks('no links here')).toBe('no links here');   // subpage 無しは素通し
    });
});
