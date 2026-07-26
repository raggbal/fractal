/**
 * resource-roots TASK-01 — webview アクセス範囲の純関数
 *
 * resolveResourceRoots: settings string[] → 許可絶対パス群（~展開・絶対のみ・空なら [homedir]）
 * isPathUnderAnyRoot:    絶対パスが root 群のいずれか配下か
 * findOutOfRangeImages:  md 本文の画像で許可範囲外を列挙
 *
 * TC-RR-01〜08 resolveResourceRoots / 10〜15 isPathUnderAnyRoot / 20〜25 findOutOfRangeImages
 */
import { test, expect } from '@playwright/test';
import {
    resolveResourceRoots,
    isPathUnderAnyRoot,
    findOutOfRangeImages,
} from '../../src/shared/resource-roots';
import { extractAllAssetRefs } from '../../src/shared/paste-asset-handler';

// ---- resolveResourceRoots ----

test('TC-RR-01: 空配列 → homedir フォールバック（後方互換）', () => {
    expect(resolveResourceRoots([], '/home/u')).toEqual(['/home/u']);
});

test('TC-RR-02: undefined → homedir フォールバック', () => {
    expect(resolveResourceRoots(undefined, '/home/u')).toEqual(['/home/u']);
});

test('TC-RR-03: ~ 単独展開', () => {
    expect(resolveResourceRoots(['~'], '/home/u')).toEqual(['/home/u']);
});

test('TC-RR-04: ~/notes 展開', () => {
    expect(resolveResourceRoots(['~/notes'], '/home/u')).toEqual(['/home/u/notes']);
});

test('TC-RR-05: 絶対パスそのまま（複数）', () => {
    expect(resolveResourceRoots(['/abs/path', '/Volumes/ext'], '/home/u')).toEqual([
        '/abs/path',
        '/Volumes/ext',
    ]);
});

test('TC-RR-06: 相対・空・空白は全除外 → 0件 → homedir フォールバック（load-bearing）', () => {
    // 相対除外を消すと 'relative/x' 等が混じり fail する
    expect(resolveResourceRoots(['relative/x', '', '  ', './y'], '/home/u')).toEqual(['/home/u']);
});

test('TC-RR-07: 重複除去', () => {
    expect(resolveResourceRoots(['/a', '/a', '~/n'], '/home/u')).toEqual(['/a', '/home/u/n']);
});

test('TC-RR-08: 混在（有効のみ採用・相対だけ捨てる）', () => {
    expect(resolveResourceRoots(['~/notes', 'bad/rel', '/abs'], '/home/u')).toEqual([
        '/home/u/notes',
        '/abs',
    ]);
});

// ---- isPathUnderAnyRoot ----

test('TC-RR-10: 配下', () => {
    expect(isPathUnderAnyRoot('/home/u/notes/a/img.png', ['/home/u'])).toBe(true);
});

test('TC-RR-11: 同一', () => {
    expect(isPathUnderAnyRoot('/home/u', ['/home/u'])).toBe(true);
});

test('TC-RR-12: 範囲外（load-bearing）', () => {
    // 判定を常に true にすると fail
    expect(isPathUnderAnyRoot('/other/x.png', ['/home/u'])).toBe(false);
});

test('TC-RR-13: prefix 部分一致の誤判定防止（load-bearing）', () => {
    // 素朴な startsWith 実装だと /home/user2 が /home/user 配下と誤判定して true になり fail
    expect(isPathUnderAnyRoot('/home/user2/x', ['/home/user'])).toBe(false);
});

test('TC-RR-14: 複数 root のうち 2 番目にマッチ', () => {
    expect(isPathUnderAnyRoot('/vol/ext/n/i.png', ['/home/u', '/vol/ext'])).toBe(true);
});

test('TC-RR-15: 絶対でない入力は false', () => {
    expect(isPathUnderAnyRoot('relative', ['/home/u'])).toBe(false);
});

// ---- findOutOfRangeImages ----

test('TC-RR-20: 相対画像が配下 → 範囲内（空）', () => {
    expect(findOutOfRangeImages('![](images/a.png)', '/home/u/note', ['/home/u'])).toEqual([]);
});

test('TC-RR-21: 相対画像が範囲外（load-bearing）', () => {
    // 検知を無効化すると [] になり fail
    expect(findOutOfRangeImages('![](images/a.png)', '/vol/ext/note', ['/home/u'])).toEqual([
        '/vol/ext/note/images/a.png',
    ]);
});

test('TC-RR-22: 絶対画像が範囲外', () => {
    expect(findOutOfRangeImages('![](/abs/other/x.png)', '/home/u/n', ['/home/u'])).toEqual([
        '/abs/other/x.png',
    ]);
});

test('TC-RR-23: http/data URL は対象外（load-bearing = extractAllAssetRefs が元々列挙しない）', () => {
    // (a) 実測: extractAllAssetRefs は http/data を .images に拾わない（この前提が壊れたら検知の設計を見直す）
    expect(extractAllAssetRefs('![](https://ex.com/x.png)').images).toEqual([]);
    expect(extractAllAssetRefs('![](data:image/png;base64,AA)').images).toEqual([]);
    // (b) よって findOutOfRangeImages も http/data では範囲外を出さない
    expect(
        findOutOfRangeImages(
            '![](https://ex.com/x.png)\n![](data:image/png;base64,AA)',
            '/home/u/n',
            ['/home/u']
        )
    ).toEqual([]);
});

test('TC-RR-24: 範囲内 + 範囲外混在 → 範囲外だけ列挙', () => {
    expect(
        findOutOfRangeImages(
            '![](images/in.png)\n![](/ext/out.png)',
            '/home/u/n',
            ['/home/u']
        )
    ).toEqual(['/ext/out.png']);
});

test('TC-RR-25: 画像なし → 空', () => {
    expect(findOutOfRangeImages('just text, no images', '/home/u/n', ['/home/u'])).toEqual([]);
});
