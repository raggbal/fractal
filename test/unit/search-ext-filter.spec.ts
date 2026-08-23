/**
 * TC-SEF-01 — ext: クエリ構文の正典 parse（sprint 20260822-203347 FR-SEF-01）
 *
 * 正典 = src/shared/search-ext-filter.js（UMD。whole-word.js / ADRL-0080 と同一構造）。
 * 規則: 先頭トークンのみ認識（キーワードは大小文字 + 全角許容を文字クラスで直接マッチ）・
 * 値のみ NFKC + 小文字 + 先頭ドット strip・body は生のまま（NFKC しない）・
 * 有効値 0 個はリテラル縮退。CLI ミラー（fractal-search.mjs）の一致基準でもある。
 */
import { test, expect } from '@playwright/test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const requireCanon = () => require('../../src/shared/search-ext-filter');

test('TC-SEF-01a 先頭トークン認識 + リテラル逃げ道', () => {
    const { parseExtQuery } = requireCanon();
    expect(parseExtQuery('ext:pdf 見積')).toEqual({ body: '見積', exts: ['pdf'] });
    expect(parseExtQuery('  ext:pdf 見積 書 ')).toEqual({ body: '見積 書', exts: ['pdf'] });
    // 先頭以外はリテラル検索語（strip されない）
    expect(parseExtQuery('見積 ext:pdf')).toEqual({ body: '見積 ext:pdf', exts: null });
    // 値なし（ext: 単独）はマッチ対象外 = リテラル
    expect(parseExtQuery('ext: 見積')).toEqual({ body: 'ext: 見積', exts: null });
});

test('TC-SEF-01b 値の正規化: 大文字 / 先頭ドット / 全角キーワード・全角値・全角カンマ', () => {
    const { parseExtQuery } = requireCanon();
    expect(parseExtQuery('ext:PDF x')).toEqual({ body: 'x', exts: ['pdf'] });
    expect(parseExtQuery('ext:.pdf x')).toEqual({ body: 'x', exts: ['pdf'] });
    expect(parseExtQuery('ｅｘｔ：ｐｄｆ x')).toEqual({ body: 'x', exts: ['pdf'] });
    expect(parseExtQuery('ext:pdf，docx x')).toEqual({ body: 'x', exts: ['pdf', 'docx'] });
});

test('TC-SEF-01c 複数指定 + 空要素除去', () => {
    const { parseExtQuery } = requireCanon();
    expect(parseExtQuery('ext:pdf,docx, x')).toEqual({ body: 'x', exts: ['pdf', 'docx'] });
    expect(parseExtQuery('ext:pdf,,docx x')).toEqual({ body: 'x', exts: ['pdf', 'docx'] });
});

test('TC-SEF-01d 縮退: 有効値 0 個はリテラル扱い（トークンを body に残す）', () => {
    const { parseExtQuery } = requireCanon();
    // counterfactual: 縮退を外す（exts=[] を返す）と「全件非表示」の silent 事故になる — null + 残存が契約
    expect(parseExtQuery('ext:. 見積')).toEqual({ body: 'ext:. 見積', exts: null });
    expect(parseExtQuery('ext:, 見積')).toEqual({ body: 'ext:, 見積', exts: null });
    expect(parseExtQuery('ext:.,. 見積')).toEqual({ body: 'ext:.,. 見積', exts: null });
});

test('TC-SEF-01e body は生のまま（NFKC されない）+ 本文空', () => {
    const { parseExtQuery } = requireCanon();
    // 全角括弧が半角化されない（既存 3 段の生テキスト regex 対称性 — FR-DS-07 裁定の不変）
    expect(parseExtQuery('ext:pdf （全角）')).toEqual({ body: '（全角）', exts: ['pdf'] });
    // ext: 単独 → body 空（検索非実行は panel 側の既存空クエリ挙動 = TC-SEF-03(e)）
    expect(parseExtQuery('ext:pdf')).toEqual({ body: '', exts: ['pdf'] });
});

test('TC-SEF-01f matchesExt / extOfName', () => {
    const { matchesExt, extOfName } = requireCanon();
    // exts=null は常に true（フィルタなし）
    expect(matchesExt('pdf', null)).toBe(true);
    expect(matchesExt('', null)).toBe(true);
    expect(matchesExt(undefined, null)).toBe(true);
    // 照合は小文字化して行う
    expect(matchesExt('PDF', ['pdf'])).toBe(true);
    expect(matchesExt('pdf', ['pdf', 'docx'])).toBe(true);
    expect(matchesExt('xlsx', ['pdf', 'docx'])).toBe(false);
    // 拡張子なし（''）はどの指定にも不一致
    expect(matchesExt('', ['pdf'])).toBe(false);
    // extOfName: 最後の . 以降・小文字。dotfile / 拡張子なしは ''
    expect(extOfName('report.PDF')).toBe('pdf');
    expect(extOfName('a.b.tar.gz')).toBe('gz');
    expect(extOfName('Makefile')).toBe('');
    expect(extOfName('.gitignore')).toBe('');
    expect(extOfName('dir/file.docx')).toBe('docx');
});

test('TC-SEF-01g キーワード自体の大小文字（counterfactual: /i を外すと RED）', () => {
    const { parseExtQuery } = requireCanon();
    expect(parseExtQuery('EXT:pdf 語')).toEqual({ body: '語', exts: ['pdf'] });
    expect(parseExtQuery('Ext:pdf 語')).toEqual({ body: '語', exts: ['pdf'] });
});

test('TC-SEF-07 本番配線番人: notesWebviewContent + standalone ハーネスに inline 登録がある（generator_failures 2026-08-17 クラス）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const prod = fs.readFileSync(path.join(__dirname, '../../src/notesWebviewContent.ts'), 'utf8');
    expect(prod.includes('search-ext-filter.js'), '本番 inline（notesWebviewContent.ts）に search-ext-filter.js の読み込みが無い').toBe(true);
    expect(/searchExtFilterScript/.test(prod) && prod.indexOf('${searchExtFilterScript}') !== -1,
        '読み込んだ script が HTML テンプレートに埋め込まれていない').toBe(true);
    // HTML テンプレート上で panel の script tag より前に注入される（whole-word と同じ順序契約）
    expect(prod.indexOf('${searchExtFilterScript}')).toBeLessThan(prod.indexOf('${notesFilePanelScript}'));
    const harness = fs.readFileSync(path.join(__dirname, '../build-standalone-notes.js'), 'utf8');
    expect(harness.includes('search-ext-filter.js'), 'ハーネス（build-standalone-notes.js）に注入が無い').toBe(true);
});
