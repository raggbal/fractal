/**
 * subpage-marker TASK-01 — 層1 パーサ（subpage 判別 + 種別付き extractAllAssetRefs）
 *
 * `[[label]](url)` = サブページ (isSubpage:true) / `[label](url)` = 参照リンク (isSubpage:false)。
 * Wikipedia 引用 `[[label](url)]`（末尾 `]`）は従来通り誤判定しない。
 *
 * TC-SP-01 subpage を isSubpage:true で emit
 * TC-SP-02 参照リンクは isSubpage:false
 * TC-SP-03 Wikipedia 引用を誤判定しない
 * TC-SP-04 画像の二重ブラケットは subpage 対象外
 * TC-SP-05 混在を種別分離
 * TC-SP-06 extractAllAssetRefs が mdLinks（両種別）+ mdLinkRefs（種別付き）
 * TC-SP-07 extractAllAssetRefs 後方互換（title strip / 隣接 / 画像 / http 除外）
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require('../../src/shared/markdown-link-parser.js');
import { extractAllAssetRefs } from '../../src/shared/paste-asset-handler';

test('TC-SP-01: parseMarkdownLinks が subpage を isSubpage:true で emit', () => {
    const toks = P.parseMarkdownLinks('[[sub]](child.md)');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({ kind: 'link', alt: 'sub', url: 'child.md', isSubpage: true, start: 0 });
    expect(toks[0].end).toBe(17); // 末尾 ')' の次
});

test('TC-SP-02: 参照リンクは isSubpage:false', () => {
    const toks = P.parseMarkdownLinks('[ref](x.md)');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({ kind: 'link', alt: 'ref', url: 'x.md', isSubpage: false });
});

test('TC-SP-03: Wikipedia 引用 [[label](url)] を誤判定しない', () => {
    const toks = P.parseMarkdownLinks('[[label](url)]');
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({ alt: 'label', url: 'url', isSubpage: false, start: 1 });
});

test('TC-SP-04: 画像の二重ブラケットは subpage 対象外', () => {
    const toks = P.parseMarkdownLinks('![[alt]](pic.png)');
    // 画像に subpage 概念なし。![[alt]](pic.png) は現行同様 link として拾わない
    expect(toks.filter((t: { isSubpage?: boolean }) => t.isSubpage)).toHaveLength(0);
});

test('TC-SP-05: 混在を種別分離', () => {
    const toks = P.parseMarkdownLinks('[[a]](b.md) と [c](d.md)');
    expect(toks).toHaveLength(2);
    expect(toks[0]).toMatchObject({ alt: 'a', url: 'b.md', isSubpage: true });
    expect(toks[1]).toMatchObject({ alt: 'c', url: 'd.md', isSubpage: false });
});

test('TC-SP-06: extractAllAssetRefs が mdLinks + mdLinkRefs を分離', () => {
    const md = '[[sub]](a.md) と [ref](b.md) と ![](img.png) と [📎 f](c.pdf)';
    const refs = extractAllAssetRefs(md);
    expect(refs.mdLinks.slice().sort()).toEqual(['a.md', 'b.md']);
    expect(refs.mdLinkRefs).toEqual(expect.arrayContaining([
        { url: 'a.md', isSubpage: true },
        { url: 'b.md', isSubpage: false },
    ]));
    expect(refs.mdLinkRefs).toHaveLength(2);
    expect(refs.mdLinks).not.toContain('img.png');
    expect(refs.mdLinks).not.toContain('c.pdf');
});

test('TC-SP-07: extractAllAssetRefs 後方互換（title strip / 隣接 / 画像 / http 除外）', () => {
    // (a) 基本
    expect(extractAllAssetRefs('see [doc](notes/a.md) and [other](b.markdown)').mdLinks.slice().sort())
        .toEqual(['b.markdown', 'notes/a.md']);
    // (b) title 付きリンク: title を strip して y.md を拾う（脱落しない）
    expect(extractAllAssetRefs('[titled](y.md "my title")').mdLinks).toEqual(['y.md']);
    // (c) 隣接リンク
    expect(extractAllAssetRefs('[a](b.md) [c](d.md)').mdLinks.slice().sort()).toEqual(['b.md', 'd.md']);
    // (d) 画像・📎 は mdLinks に混ざらない
    expect(extractAllAssetRefs('![img](p.png) [📎 f](c.pdf) [link](e.md)').mdLinks).toEqual(['e.md']);
    // (e) http/anchor 除外
    expect(extractAllAssetRefs('[ext](https://x.md) [anc](#h)').mdLinks).toEqual([]);
});
