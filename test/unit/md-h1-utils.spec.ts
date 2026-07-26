/**
 * FR-TH-01/02/04/05 + NFR-TH-02: md 先頭 H1 の抽出/置換 と byte-skip 書込
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFirstH1, setFirstH1, writeFileIfChanged } from '../../src/shared/md-h1-utils';

test.describe('md-h1-utils — extractFirstH1', () => {
    // TC-TH-01: 最初の H1 を返す
    test('TC-TH-01 先頭 H1 を返す / 最初の H1', () => {
        expect(extractFirstH1('# Hello\n\nbody')).toBe('Hello');
        // 先頭が H1 でなくても「最初に現れる H1」を返す（先頭限定は setFirstH1 の挿入判定で扱う）
        expect(extractFirstH1('no heading\n# later')).toBe('later');
    });

    // TC-TH-01b: コードブロック内 # を無視
    test('TC-TH-01b コードブロック内の # を無視', () => {
        const md = '```\n# fake\n```\n# Real';
        expect(extractFirstH1(md)).toBe('Real');
    });

    // TC-TH-01c: H1 無し → null
    test('TC-TH-01c H1 が無ければ null', () => {
        expect(extractFirstH1('## H2 only\n\nbody')).toBeNull();
        expect(extractFirstH1('no headings at all')).toBeNull();
    });
});

test.describe('md-h1-utils — setFirstH1', () => {
    // TC-TH-02: 既存先頭 H1 を置換・本文保持
    test('TC-TH-02 先頭 H1 を置換し本文の他は保持', () => {
        expect(setFirstH1('# Old\n\nbody\n## Sub', 'New')).toBe('# New\n\nbody\n## Sub');
    });

    // TC-TH-02b: 冪等 — 同値なら === 同一 return
    test('TC-TH-02b 冪等: 既に同じ title なら入力と同一文字列を返す', () => {
        const md = '# Same\n\nbody';
        const out = setFirstH1(md, 'Same');
        expect(out).toBe(md);
    });

    // TC-TH-02c: H1 無し → 先頭挿入
    test('TC-TH-02c H1 無しは先頭に # title を挿入', () => {
        expect(setFirstH1('body only', 'T')).toBe('# T\n\nbody only');
    });

    // TC-TH-02d: 本文途中の ## H2 を H1 と誤検出しない
    test('TC-TH-02d 途中の ## H2 を H1 と誤検出せず先頭挿入・## Sub 不変', () => {
        expect(setFirstH1('intro\n\n## Sub', 'T')).toBe('# T\n\nintro\n\n## Sub');
    });

    // TC-TH-02f: CRLF 保持 + title に # を含んでも壊さない + 往復整合（★review it.2 HIGH+MEDIUM）
    test('TC-TH-02f setFirstH1 CRLF 保持 / title の # 保持 / 往復整合', () => {
        // CRLF 本文の H1 行を置換 → \r を保持（mixed EOL にしない）
        expect(setFirstH1('# old\r\nbody', 'New')).toBe('# New\r\nbody');
        // title に # を含んでも壊さない
        expect(setFirstH1('# Old', 'C#')).toBe('# C#');
        // 往復整合: set した H1 を extract で読み戻すと同じ（不変点）
        const md = setFirstH1('# x\n\nbody', 'C#');
        expect(extractFirstH1(md)).toBe('C#');
        // 冪等: C# が既にあれば入力と同一
        expect(setFirstH1('# C#\n\nbody', 'C#')).toBe('# C#\n\nbody');
    });
});

test.describe('md-h1-utils — CommonMark ATX 閉じ記号（★review it.2 HIGH）', () => {
    // TC-TH-01d: 末尾 # 保持（空白前置の閉じ記号だけ剥がす）
    test('TC-TH-01d extractFirstH1 は空白前置でない末尾 # を保持', () => {
        expect(extractFirstH1('# C#')).toBe('C#');
        expect(extractFirstH1('# F# and C#')).toBe('F# and C#');
        expect(extractFirstH1('# .gitignore')).toBe('.gitignore');
        expect(extractFirstH1('# Hello')).toBe('Hello');
        // 空白前置の閉じ記号は CommonMark どおり剥がす
        expect(extractFirstH1('# Title #')).toBe('Title');
        expect(extractFirstH1('# Title ###')).toBe('Title');
        // 閉じ記号のみの後に空白
        expect(extractFirstH1('# Done #  ')).toBe('Done');
    });
});

test.describe('md-h1-utils — writeFileIfChanged (★HIGH-1)', () => {
    let tempDir: string;
    test.beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-h1-wif-')); });
    test.afterEach(() => { if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); });

    // TC-TH-02e: 差分あり書込 / byte 一致 skip (mtime 不変) / 未存在 path
    test('TC-TH-02e 差分書込=true / byte一致=false+mtime不変 / 未存在=true', async () => {
        const p = path.join(tempDir, 'a.md');

        // (c) 未存在 → 書いて true
        expect(writeFileIfChanged(p, '# One\n')).toBe(true);
        expect(fs.readFileSync(p, 'utf8')).toBe('# One\n');

        // (b) byte 一致 → 書かず false、mtime 不変
        const mtime1 = fs.statSync(p).mtimeMs;
        await new Promise((r) => setTimeout(r, 20));
        expect(writeFileIfChanged(p, '# One\n')).toBe(false);
        expect(fs.statSync(p).mtimeMs).toBe(mtime1); // mtime 保護 (NFR-TH-02 load-bearing)

        // (a) 差分 → 書いて true
        expect(writeFileIfChanged(p, '# Two\n')).toBe(true);
        expect(fs.readFileSync(p, 'utf8')).toBe('# Two\n');
    });
});
