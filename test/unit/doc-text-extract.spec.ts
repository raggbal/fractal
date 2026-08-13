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
import { extractDocText, normalizeExtracted, CONTENT_SEARCH_EXTS } from '../../src/shared/doc-text-extract';

const FIX = path.join(__dirname, '..', 'fixtures', 'doc-search');
const read = (name: string): Buffer => fs.readFileSync(path.join(FIX, name));
const joined = (lines: string[]): string => lines.join('\n');

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

    test('TC-DS-41: unsupported_ext — extractor 自身が防御（呼び出し元フィルタと独立）', async () => {
        const res = await extractDocText(Buffer.from('plain text'), '.txt');
        expect(res.skipReason).toBe('unsupported_ext');
        // CONTENT_SEARCH_EXTS の契約: 4 拡張子のみ
        expect(CONTENT_SEARCH_EXTS.sort()).toEqual(['.docx', '.pdf', '.pptx', '.xlsx']);
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
