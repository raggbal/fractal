/**
 * doc-text-extract.spec.ts — 添付中身検索の抽出正典（doc-text-extract.ts）
 *
 * sprint 20260813-133248-search-doc-content / TASK-01(OOXML)・TASK-03(PDF)。
 * design/system.md §1 / testcases.md A 節 / fixture = poc bh-03/bh-01 移植（test/fixtures/doc-search/）。
 *
 * 検証対象（behavioral + counterfactual。source-contract 文字列 assert は使わない）:
 *  - TC-DS-01: docx（実ツール生成 4 種）から日本語+英語+エンティティ+数値文字参照を抽出
 *  - TC-DS-02: xlsx sharedStrings 経由 + inlineStr 両対応
 *  - TC-DS-03: rPh 番人 — 「東京」ふりがな癒着なし（counterfactual: strip を外すと東京トウキョウ）
 *  - TC-DS-04: pptx 3 スライド全文字列 + layouts/masters テンプレ文字列の非混入
 *  - TC-DS-05: 非 ZIP → skipReason:'encrypted_or_not_zip'
 *  - TC-DS-06: stored(method 0) docx から抽出
 *  - TC-DS-30: NFKC 番人 — 康熙部首 → 統合漢字（counterfactual: normalize を外すと非ヒット）
 *  - TC-DS-31: 行 200 字 clamp / 1MB 打ち切り truncated
 *  - TC-DS-40: extract_error 番人 — 正しい ZIP + 壊れた内部 XML で throw せず skipReason
 *  - TC-DS-41: unsupported_ext — extractor 自身の防御（呼び出し元フィルタと独立）
 *  - TC-DS-07/08/09: PDF（TASK-03）— ToUnicode 埋込抽出 / pdf_unavailable / pdf_no_text
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { extractDocText, normalizeExtracted, DEDICATED_EXTRACT_EXTS, ExtractedLine, SkipReason } from '../../src/shared/doc-text-extract';

const FIX = path.join(__dirname, '..', 'fixtures', 'doc-search');
const read = (name: string): Buffer => fs.readFileSync(path.join(FIX, name));
// rev.3（FR-DS-09）: lines は {text, loc?} — 文字列比較は text を連結
const joined = (lines: ExtractedLine[]): string => lines.map((l) => l.text).join('\n');

test.describe('doc-text-extract: OOXML（TASK-01）', () => {

    test('TC-DS-01: docx 4 種から日本語+英語+エンティティ+数値文字参照を抽出', async () => {
        const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
        for (const name of ['docx-pydocx.docx', 'docx-textutil.docx', 'docx-soffice.docx']) {
            const res = await extractDocText(read(name), '.docx');
            expect(res.skipReason, `${name} should extract`).toBeUndefined();
            const text = joined(res.lines);
            for (const s of expected[name].contains) {
                expect(text, `${name} should contain ${s}`).toContain(s);
            }
        }
    });

    test('TC-DS-02: xlsx sharedStrings + inlineStr 両対応', async () => {
        const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
        // inlineStr のみ（openpyxl 既定）と sharedStrings（LibreOffice 変換）の両変種
        for (const name of ['xlsx-openpyxl-inline.xlsx', 'xlsx-soffice-sst.xlsx']) {
            const res = await extractDocText(read(name), '.xlsx');
            expect(res.skipReason, `${name} should extract`).toBeUndefined();
            const text = joined(res.lines);
            for (const s of expected[name].contains) {
                expect(text, `${name} should contain ${s}`).toContain(s);
            }
        }
    });

    test('TC-DS-03: rPh 番人 — ふりがな癒着なし（counterfactual: strip 無しだと東京トウキョウ）', async () => {
        const res = await extractDocText(read('xlsx-rph.xlsx'), '.xlsx');
        const text = joined(res.lines);
        expect(text).toContain('東京');
        expect(text).not.toContain('トウキョウ');       // rPh strip の番人
        expect(text).not.toContain('東京トウキョウ');
    });

    test('TC-DS-04: pptx 3 スライド全文字列 + layouts テンプレ非混入', async () => {
        const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
        for (const name of ['pptx-pypptx.pptx', 'pptx-soffice.pptx']) {
            const res = await extractDocText(read(name), '.pptx');
            expect(res.skipReason, `${name} should extract`).toBeUndefined();
            const text = joined(res.lines);
            for (const s of expected[name].contains) {
                expect(text, `${name} should contain ${s}`).toContain(s);
            }
            for (const s of expected[name].not_contains || []) {
                expect(text, `${name} must NOT contain template text ${s}`).not.toContain(s);
            }
        }
    });

    test('TC-DS-05: 非 ZIP（暗号化 CFB 相当）→ encrypted_or_not_zip（throw しない）', async () => {
        const res = await extractDocText(read('not-a-zip.docx'), '.docx');
        expect(res.skipReason).toBe('encrypted_or_not_zip');
        expect(res.lines).toEqual([]);
    });

    test('TC-DS-06: stored(method 0) docx から抽出', async () => {
        const res = await extractDocText(read('docx-stored.docx'), '.docx');
        expect(res.skipReason).toBeUndefined();
        const text = joined(res.lines);
        expect(text).toContain('吾輩は猫である。名前はまだ無い。');
        expect(text).toContain('表セル日本語');
    });

    test('TC-DS-40: extract_error 番人 — 正しい ZIP + 壊れた内部 XML で throw せず skipReason', async () => {
        // 実 docx の central directory はそのまま、document.xml の圧縮データを破壊する:
        // 最小手段として「deflate ストリームの中身を反転」した合成 ZIP を作る。
        // ZIP 構造自体は poc 実証済みの正典パーサが読めるよう、fixture を base に
        // 「document.xml の data 部分の先頭 64 bytes を 0xFF で潰す」方式で生成する。
        const buf = Buffer.from(read('docx-pydocx.docx'));
        // local header の 'word/document.xml' を探し、その data 部を破壊
        const marker = Buffer.from('word/document.xml');
        let pos = -1;
        for (let i = 0; i < buf.length - marker.length; i++) {
            // local header 内の filename 出現（PK\x03\x04 の直後 30 bytes 目以降）を探す
            if (buf.readUInt32LE(i) === 0x04034b50) {
                const nameLen = buf.readUInt16LE(i + 26);
                const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
                if (name === 'word/document.xml') { pos = i + 30 + nameLen + buf.readUInt16LE(i + 28); break; }
            }
        }
        expect(pos, 'fixture must contain word/document.xml local header').toBeGreaterThan(0);
        buf.fill(0xff, pos, Math.min(pos + 64, buf.length));
        const res = await extractDocText(buf, '.docx');
        expect(res.skipReason).toBe('extract_error');   // silent 空文字にしない中核（FR-DS-08）
        expect(res.lines).toEqual([]);
    });

    test('TC-DS-41: .txt はテキスト抽出成功（sprint 20260815 test_update — 旧 unsupported_ext 契約の撤廃）', async () => {
        const res = await extractDocText(Buffer.from('plain text 議事録'), '.txt');
        expect(res.skipReason).toBeUndefined();
        expect(res.lines.map((l) => l.text).join('\n')).toContain('議事録');
        // DEDICATED_EXTRACT_EXTS の契約: 専用抽出は 4 拡張子のみ（それ以外は sniff パイプライン）
        expect([...DEDICATED_EXTRACT_EXTS].sort()).toEqual(['.docx', '.pdf', '.pptx', '.xlsx']);
    });
});

test.describe('doc-text-extract: テキスト sniff + decode（FR-DS-11 / sprint 20260815）', () => {

    test('TC-DS-75: UTF-8（BOM なし）テキストがヒット・拡張子非依存', async () => {
        const buf = Buffer.from('会議の議事録です\n2 行目', 'utf8');
        for (const ext of ['.txt', '.json', '']) {          // 拡張子なしでも同結果
            const res = await extractDocText(buf, ext);
            expect(res.skipReason, `ext=${ext}`).toBeUndefined();
            expect(res.noCache, 'テキスト経路は非キャッシュ契約').toBe(true);
            expect(joined(res.lines)).toContain('議事録');
        }
    });

    test('TC-DS-62: BOM→NUL 順序番人 — UTF-16LE BOM がテキスト判定（counterfactual: NUL 検査先行だと binary）+ UTF-8 BOM strip', async () => {
        // UTF-16LE は ASCII/和文とも NUL バイトを含む — BOM 判定が先でなければ binary に落ちる
        const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('議事録テキスト', 'utf16le')]);
        const res = await extractDocText(le, '.txt');
        expect(res.skipReason).toBeUndefined();
        expect(joined(res.lines)).toContain('議事録テキスト');
        // UTF-8 BOM strip（decode 前 subarray 方式 — 先頭 U+FEFF が残らない）
        const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('先頭行', 'utf8')]);
        const res8 = await extractDocText(bom8, '.txt');
        expect(res8.skipReason).toBeUndefined();
        expect(res8.lines[0].text.charCodeAt(0)).not.toBe(0xfeff);
        expect(res8.lines[0].text).toBe('先頭行');
    });

    test('TC-DS-63: UTF-16BE — swap16 デコード（元 Buffer 非破壊・奇数長 tail 切り捨て）', async () => {
        const text = '議事録テキスト BE';
        const leBody = Buffer.from(text, 'utf16le');
        const beBody = Buffer.from(leBody); beBody.swap16();
        const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
        const snapshot = Buffer.from(be);                    // 非破壊 assert 用
        const res = await extractDocText(be, '.txt');
        expect(res.skipReason).toBeUndefined();
        expect(joined(res.lines)).toContain(text);           // LE と同一内容
        expect(be.equals(snapshot), 'swap16 はコピーに対して行い元 Buffer を壊さない').toBe(true);
        // 奇数長 tail（BOM + 奇数バイト）で throw しない
        const odd = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody, Buffer.from([0x30])]);
        const resOdd = await extractDocText(odd, '.txt');
        expect(resOdd.skipReason).toBeUndefined();
        expect(joined(resOdd.lines)).toContain(text);
    });

    test('TC-DS-65: NUL バイナリ → skipReason binary（unsupported_ext は廃止済み）', async () => {
        const bin = Buffer.concat([Buffer.from('PKxx'), Buffer.from([0x00, 0x01, 0x02, 0x00]), Buffer.from('data')]);
        const res = await extractDocText(bin, '.zip');
        expect(res.skipReason).toBe('binary');
        expect(res.lines).toEqual([]);
        // 型レベルの pin: test/ は tsconfig exclude のため CI の tsc では実効しない（IDE tsserver 用）。
        // CI レベルの担保は tasks.md 完了 gate の grep（doc-text-extract.ts 内 unsupported_ext = 0 件）。
        // @ts-expect-error — SkipReason から 'unsupported_ext' は削除済み（union に残っていれば unused directive）
        const removed: SkipReason = 'unsupported_ext';
        expect(removed).toBeTruthy();                        // 変数未使用回避（実行時は文字列のまま）
    });

    test('TC-DS-66: NFKC 対称番人（テキスト版）— 全角括弧が半角に正規化される', async () => {
        const res = await extractDocText(Buffer.from('（重要）全角括弧テスト', 'utf8'), '.txt');
        expect(res.skipReason).toBeUndefined();
        // counterfactual: normalizeExtracted を通さないと '（重要）' のままで第 4 段 NFKC クエリと不一致
        expect(joined(res.lines)).toContain('(重要)');
        expect(joined(res.lines)).not.toContain('（重要）');
    });

    test('TC-DS-71: 受容事項の pin — BOM なし UTF-16 / 混合ファイル / 4MB clamp', async () => {
        // (a) BOM なし UTF-16LE → NUL だらけ → binary（仕様 = 受容事項 1）
        const noBom = Buffer.from('ascii text', 'utf16le');
        expect((await extractDocText(noBom, '.txt')).skipReason).toBe('binary');
        // (b) 先頭 8KB テキスト + 後半バイナリ → テキスト判定（ゴミ行受容 = 受容事項 3）
        const mixed = Buffer.concat([Buffer.from('マーカー行\n'.repeat(1000), 'utf8'), Buffer.from([0x00, 0x01])]);
        const resMixed = await extractDocText(mixed, '.log');
        expect(resMixed.skipReason).toBeUndefined();
        expect(joined(resMixed.lines)).toContain('マーカー');
        // (c) 4MB 超テキスト → truncated + 先頭は保持
        const big = Buffer.from('頭マーカー\n' + 'x'.repeat(5 * 1024 * 1024), 'utf8');
        const resBig = await extractDocText(big, '.txt');
        expect(resBig.skipReason).toBeUndefined();
        expect(resBig.truncated).toBe(true);
        expect(resBig.lines[0].text).toContain('頭マーカー');
    });

    test('TC-DS-72: 専用抽出 regression — 4 拡張子は sniff を通らず従来抽出（ZIP の NUL で binary 落ちしない）', async () => {
        const docx = read('docx-pydocx.docx');
        const res = await extractDocText(docx, '.docx');     // ZIP = NUL 混じりだが専用経路が先
        expect(res.skipReason).toBeUndefined();
        expect(res.noCache, '専用抽出はキャッシュ対象（noCache なし）').toBeFalsy();
        expect(joined(res.lines)).toContain('吾輩は猫である。名前はまだ無い。');
        // 同一 Buffer を非専用拡張子で渡すと binary（ZIP は NUL を含む）— 判定順①の対比
        const asBin = await extractDocText(docx, '.bin');
        expect(asBin.skipReason).toBe('binary');
    });
});

test.describe('doc-text-extract: HTML 本文抽出（FR-DS-12 / sprint 20260815）', () => {

    const HTML_FIXTURE = [
        '<!DOCTYPE html><html><head>',
        '<style>.meeting-notes { color: red; }</style>',
        '<script>const secret = "パスワード検出不可";</script>',
        '</head><body>',
        '<!-- コメント内秘匿語 -->',
        '<div class="meeting-notes">議事録</div>',
        '<table><tr><td>東京</td><td>大阪</td></tr></table>',
        '<p>A&amp;B&nbsp;C&#x3042;</p>',
        '<noscript>ノースクリプト文言</noscript>',
        '</body></html>',
    ].join('\n');

    test('TC-DS-64: 本文のみ抽出（class/script/コメント除去・癒着なし・文字参照復号）', async () => {
        const res = await extractDocText(Buffer.from(HTML_FIXTURE, 'utf8'), '.html');
        expect(res.skipReason).toBeUndefined();
        const text = joined(res.lines);
        expect(text).toContain('議事録');                     // (a) 本文ヒット
        expect(text).not.toContain('meeting');               // (b) class 名は対象外
        expect(text).not.toContain('パスワード検出不可');      // (c) script 中身除去
        expect(text).not.toContain('東京大阪');               // (d) 癒着番人（counterfactual: '' 置換だと RED）
        expect(text).toContain('東京');
        expect(text).toContain('大阪');
        expect(text).toContain('A&B C');                      // (e) &amp; &nbsp; 復号（nbsp → 半角スペース）
        expect(text).toContain('あ');                         //     &#x3042; 数値参照
        expect(text).not.toContain('コメント内秘匿語');        // (f) コメント除去
        expect(text).not.toContain('ノースクリプト文言');      //     noscript 除去
    });

    test('TC-DS-73: 適用範囲 — .xml は生テキスト（属性値がヒット可能）・.htm は .html と同じ', async () => {
        const xml = '<property name="timeout" value="重要設定"/>';
        const resXml = await extractDocText(Buffer.from(xml, 'utf8'), '.xml');
        expect(resXml.skipReason).toBeUndefined();
        expect(joined(resXml.lines)).toContain('重要設定');    // 属性値が検索可能（本文抽出しない）
        expect(joined(resXml.lines)).toContain('<property');   // タグ字面も残る
        // .htm は .html と同じ本文抽出
        const resHtm = await extractDocText(Buffer.from(HTML_FIXTURE, 'utf8'), '.htm');
        expect(joined(resHtm.lines)).toContain('議事録');
        expect(joined(resHtm.lines)).not.toContain('meeting');
    });
});

test.describe('doc-text-extract: 正規化（TASK-01 / FR-DS-07）', () => {

    test('TC-DS-30: NFKC 番人 — 康熙部首 → 統合漢字（counterfactual: normalize 無しだと不一致）', () => {
        // U+2F2D KANGXI RADICAL MOUNTAIN（poc INTERIM-01 で実測した Hiragino 生成 PDF の混入文字）
        const kangxiMountain = '⼭';       // ⼭ — NFKC で U+5C71「山」になる
        const { lines } = normalizeExtracted(`富士${kangxiMountain}麓`);
        expect(lines.join('')).toContain('富士山麓');           // 統合漢字で検索可能
        expect(kangxiMountain.normalize('NFKC')).toBe('山');    // 前提の自己検証
    });

    test('TC-DS-31: 行 200 字 clamp + 1MB 打ち切り truncated', () => {
        const longLine = 'あ'.repeat(500);
        const r1 = normalizeExtracted(longLine);
        expect(r1.lines[0].length).toBe(200);       // SearchMatch.lineText の webview 表示契約
        expect(r1.truncated).toBe(false);

        // 1MB 超（200 字行 × 多数）で打ち切り
        const big = ('い'.repeat(199) + '\n').repeat(30000); // ≒ 6MB
        const r2 = normalizeExtracted(big);
        expect(r2.truncated).toBe(true);
        const total = r2.lines.reduce((a, l) => a + l.length + 1, 0);
        expect(total).toBeLessThanOrEqual(1024 * 1024 + 200);   // 上限 + 最終行マージン
    });
});

test.describe('doc-text-extract: PDF（TASK-03）', () => {

    test('TC-DS-07: ToUnicode 埋込 PDF から日本語+英語を抽出', async () => {
        const res = await extractDocText(read('fixture-ja-en.pdf'), '.pdf');
        expect(res.skipReason).toBeUndefined();
        const text = joined(res.lines);
        expect(text).toContain('富士山麓に鸚鵡鳴く検索対象テキスト');
        expect(text).toContain('FractalSearchTargetEnglish2026');
    });

    test('TC-DS-08: pdfjs 不可（Electron 相当）→ pdf_unavailable（throw しない）', async () => {
        const res = await extractDocText(read('fixture-ja-en.pdf'), '.pdf', {
            pdfjsLoader: async () => { throw new Error('MODULE_NOT_FOUND (electron raw require)'); },
        });
        expect(res.skipReason).toBe('pdf_unavailable');
        expect(res.lines).toEqual([]);
    });

    test('TC-DS-09: predefined CMap 依存 PDF（cmaps 非同梱）→ pdf_no_text', async () => {
        const res = await extractDocText(read('fixture-predefined-cmap.pdf'), '.pdf');
        expect(res.skipReason).toBe('pdf_no_text');
        expect(res.lines).toEqual([]);
    });
});

test.describe('doc-text-extract: zip bomb ガード（TASK-11 / SEC-1）', () => {

    /** 高圧縮率 fixture を合成: ゼロ連続 bytes を deflateRaw した単一エントリ ZIP（docx 偽装） */
    function mkZipBombDocx(uncompressedMb: number): Buffer {
        const uncompressed = Buffer.alloc(uncompressedMb * 1024 * 1024, 0);
        const deflated = zlib.deflateRawSync(uncompressed, { level: 9 });
        const name = Buffer.from('word/document.xml');
        // local header
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(8, 8);                       // method deflate
        lh.writeUInt32LE(deflated.length, 18);        // compressedSize
        lh.writeUInt32LE(uncompressed.length, 22);    // uncompressedSize（正直に宣言）
        lh.writeUInt16LE(name.length, 26);
        // central directory
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt32LE(deflated.length, 20);
        cd.writeUInt32LE(uncompressed.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(0, 42);                      // localOffset
        // EOCD
        const cdOffset = 30 + name.length + deflated.length;
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(1, 8);
        eocd.writeUInt16LE(1, 10);
        eocd.writeUInt32LE(46 + name.length, 12);
        eocd.writeUInt32LE(cdOffset, 16);
        return Buffer.concat([lh, name, deflated, cd, name, eocd]);
    }

    test('TC-DS-42: 高圧縮エントリ（200MB 宣言）→ throw せず extract_error（GB 級 Buffer を確保しない）', async () => {
        const bomb = mkZipBombDocx(200);              // 圧縮後 ~200KB / 伸長後 200MB
        expect(bomb.length).toBeLessThan(1024 * 1024); // fixture 自体は 1MB 未満（高圧縮の確認）
        const before = process.memoryUsage().heapUsed;
        const res = await extractDocText(bomb, '.docx');
        expect(res.skipReason).toBe('extract_error');  // counterfactual: ガードを外すと 200MB Buffer 確保
        expect(res.lines).toEqual([]);
        const growth = process.memoryUsage().heapUsed - before;
        expect(growth).toBeLessThan(50 * 1024 * 1024); // 伸長 Buffer（200MB）を掴んでいない
    });
});

test.describe('doc-text-extract: 位置メタ（TASK-17 / FR-DS-09 / ADRL-0060）', () => {

    test('TC-DS-51: PDF はページ番号 loc（p.1 — 単一ページ fixture の境界確認）', async () => {
        const res = await extractDocText(read('fixture-ja-en.pdf'), '.pdf');
        expect(res.skipReason).toBeUndefined();
        const hit = res.lines.find((l) => l.text.includes('富士山麓に鸚鵡鳴く'));
        expect(hit).toBeDefined();
        expect(hit!.loc).toBe('p.1');
        // 全行がページ loc を持つ（PDF に loc なし行は無い）
        expect(res.lines.every((l) => /^p\.\d+$/.test(l.loc || ''))).toBe(true);
    });

    test('TC-DS-52: pptx はスライド番号 loc（3 枚目の語 = slide 3）', async () => {
        const res = await extractDocText(read('pptx-pypptx.pptx'), '.pptx');
        expect(res.skipReason).toBeUndefined();
        const first = res.lines.find((l) => l.text.includes('一枚目タイトル'));
        const third = res.lines.find((l) => l.text.includes('三枚目 Third'));
        expect(first!.loc).toBe('slide 1');
        expect(third!.loc).toBe('slide 3');   // off-by-one 番人
    });

    test('TC-DS-53: xlsx はシート名+セル参照 loc（sharedStrings 経由 + inlineStr の両方）', async () => {
        // sharedStrings 経由（LibreOffice 変換・シート名 = データ/第二シート）
        const sst = await extractDocText(read('xlsx-soffice-sst.xlsx'), '.xlsx');
        expect(sst.skipReason).toBeUndefined();
        const sstHit = sst.lines.find((l) => l.text.includes('東京タワー'));
        expect(sstHit).toBeDefined();
        expect(sstHit!.loc).toMatch(/^データ![A-Z]+\d+$/);        // シート名!セル参照
        const sheet2Hit = sst.lines.find((l) => l.text.includes('二枚目の日本語セル'));
        expect(sheet2Hit!.loc).toMatch(/^第二シート![A-Z]+\d+$/);  // 2 枚目シートの名前解決

        // inlineStr（openpyxl 既定）
        const inline = await extractDocText(read('xlsx-openpyxl-inline.xlsx'), '.xlsx');
        expect(inline.skipReason).toBeUndefined();
        const inlineHit = inline.lines.find((l) => l.text.includes('東京タワー'));
        expect(inlineHit).toBeDefined();
        expect(inlineHit!.loc).toMatch(/![A-Z]+\d+$/);            // inlineStr セルにも loc
    });

    test('TC-DS-54: docx は loc なし（位置なし裁定 — 抽出品質は不変）', async () => {
        const res = await extractDocText(read('docx-pydocx.docx'), '.docx');
        expect(res.skipReason).toBeUndefined();
        expect(res.lines.length).toBeGreaterThan(0);
        expect(res.lines.every((l) => l.loc === undefined)).toBe(true);
        expect(joined(res.lines)).toContain('吾輩は猫である。名前はまだ無い。');
    });
});
