/**
 * viewer-xlsx-numfmt.spec.ts — numFmt サブセット文法エンジン（src/webview/viewer-xlsx/numfmt.mjs）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-03。
 *  - TC-XLV-01: 表駆動（ビルトイン en+ja / カスタム小文法 — Excel 実表示に合わせた期待値）
 *  - TC-XLV-02: 日付シリアル（1900 閏年バグ serial 60/0・59/61 境界・date1904・時刻繰り上げ）
 *  - TC-XLV-03: General（15 桁丸め・11 桁指数切替・45.6% 問題）
 *  - TC-XLV-04: 縮退 3 段（部分未対応トークン無視 / 文法外 → General+fallback / 日付トークン含有 → 汎用日付）
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

const MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-xlsx', 'numfmt.mjs');
const load = async () => await import(/* webpackIgnore: true */ MOD);

type Case = [unknown, string | number, string, string?]; // [value, fmt(文字列 or builtin ID), 期待 text, 期待 color?]

// ── TC-XLV-01: 表駆動（数値・ビルトイン・カスタム） ──
const NUMERIC_CASES: Case[] = [
    // ビルトイン ID（en 基本）
    [1234.567, 1, '1235'],            // '0'
    [1234.567, 2, '1234.57'],         // '0.00'
    [1234567, 3, '1,234,567'],        // '#,##0'
    [1234567.891, 4, '1,234,567.89'], // '#,##0.00'
    [0.12, 9, '12%'],                 // '0%'
    [0.4567, 10, '45.67%'],           // '0.00%'
    [12345, 11, '1.23E+04'],          // '0.00E+00'
    [-1234, 37, '(1,234)'],           // '#,##0 ;(#,##0)'
    [1234, 37, '1,234 '],
    [-1234, 38, '(1,234)', '#FF0000'],
    [-1234.5, 39, '(1,234.50)'],
    [-1234.5, 40, '(1,234.50)', '#FF0000'],
    [12345.6789, 48, '12.3E+3'],      // '##0.0E+0'
    ['hello', 49, 'hello'],           // '@'
    // カスタム: 基本
    [1234.5, '#,##0.00', '1,234.50'],
    [0.5, '0.00', '0.50'],
    [3, '00000', '00003'],
    [1234.5, '0', '1235'],            // 四捨五入
    [0, '0', '0'],
    [-42, '0', '-42'],                // 単一セクション: 負は自動マイナス
    // %（スケーリング後にも 15 桁丸め = 45.6% 問題）
    [0.456, '0.0%', '45.6%'],
    [0.456, '0%', '46%'],
    // 千位スケーリング（末尾カンマ）
    [1234567, '#,##0,', '1,235'],
    [1234567890, '#,##0,,', '1,235'],
    // セクション（正;負;ゼロ;テキスト）
    [12, '0;(0);"-"', '12'],
    [-12, '0;(0);"-"', '(12)'],
    [0, '0;(0);"-"', '-'],
    ['abc', '0;(0);"-";"T:"@', 'T:abc'],
    // 2 セクション: 正・ゼロ ; 負
    [-5, '0.0;[Blue](0.0)', '(5.0)', '#0000FF'],
    [0, '0.0;(0.0)', '0.0'],
    // 色
    [5, '[Red]0', '5', '#FF0000'],
    // 条件セクション
    [150, '[>=100]"big "0;"small "0', 'big 150'],
    [50, '[>=100]"big "0;"small "0', 'small 50'],
    // 通貨リテラル [$¥-411]
    [1234, '[$¥-411]#,##0', '¥1,234'],
    // 引用リテラル + エスケープ
    [7, '"個数: "0"個"', '個数: 7個'],
    [7, '0\\個', '7個'],
    // _x（同幅スペース化 — 幅は再現せず半角スペース 1 個）
    [1234, '#,##0_)', '1,234 '],
    // E+00
    [0.00001234, '0.00E+00', '1.23E-05'],
];

// ── 日付（1900 system 既定） ──
const DATE_CASES: Case[] = [
    // ja ビルトイン 14 = yyyy/m/d（2026-08-23 = serial 46257）
    [46257, 14, '2026/8/23'],
    [46257, 'yyyy/m/d', '2026/8/23'],
    [46257, 'yyyy-mm-dd', '2026-08-23'],
    [46257, 'yyyy"年"m"月"d"日"', '2026年8月23日'],       // ja 31
    [46257, 31, '2026年8月23日'],
    [46257, 34, '2026年8月'],
    [46257, 35, '8月23日'],
    // 和暦（令和 7 年）
    [46257, '[$-411]ge.m.d', 'R8.8.23'],
    [46257, 27, 'R8.8.23'],
    [46257, 28, '令和8年8月23日'],
    [46257, 'ggge"年"m"月"d"日"', '令和8年8月23日'],
    // 平成（1989-01-08 = serial 32516 が H1.1.8）
    [32516, '[$-411]ge.m.d', 'H1.1.8'],
    // 時刻（0.5 = 12:00:00）
    [0.5, 20, '12:00'],
    [0.5, 21, '12:00:00'],
    [0.75, 'h:mm AM/PM', '6:00 PM'],
    [0.25, 'h:mm AM/PM', '6:00 AM'],
    [46257.503472222, 'yyyy/m/d h:mm', '2026/8/23 12:05'],
    [0.5, 32, '12時00分'],
    [0.503, 33, '12時04分19秒'],
    // 経過時間
    [1.5, '[h]:mm', '36:00'],
    [2.0208333333, '[h]:mm:ss', '48:30:00'],
    [0.5, 45, '00:00'],   // mm:ss（12:00:00 の 分:秒 = 00:00）
    // サブ秒
    [0.5000115740740741, 'ss.0', '01.0'],  // 12:00:01
];

test('TC-XLV-01: 数値・ビルトイン・カスタムの表駆動', async () => {
    const { formatCell } = await load();
    for (const [v, fmt, expected, color] of NUMERIC_CASES) {
        const r = formatCell(v, typeof v === 'string' ? 'str' : 'n', fmt, {});
        expect(r.text, `${JSON.stringify(v)} × ${JSON.stringify(fmt)}`).toBe(expected);
        if (color) { expect(r.color, `color of ${fmt}`).toBe(color); }
    }
});

test('TC-XLV-01: 日付の表駆動（1900 system）', async () => {
    const { formatCell } = await load();
    for (const [v, fmt, expected] of DATE_CASES) {
        const r = formatCell(v, 'n', fmt, {});
        expect(r.text, `${v} × ${JSON.stringify(fmt)}`).toBe(expected);
    }
});

test('TC-XLV-02: 日付シリアルの正確な仕様', async () => {
    const { formatCell } = await load();
    const f = (v: number, fmt: string, opts: any = {}) => formatCell(v, 'n', fmt, opts).text;
    // 1900 閏年バグ
    expect(f(59, 'yyyy/m/d')).toBe('1900/2/28');
    expect(f(60, 'yyyy/m/d')).toBe('1900/2/29'); // 架空日を Excel 同様に出す
    expect(f(61, 'yyyy/m/d')).toBe('1900/3/1');
    expect(f(1, 'yyyy/m/d')).toBe('1900/1/1');
    expect(f(0, 'yyyy/m/d')).toBe('1900/1/0');   // 時刻専用値の日付部
    // date1904: 同じ serial が 4 年 +1 日ずれる
    expect(f(0, 'yyyy/m/d', { date1904: true })).toBe('1904/1/1');
    expect(f(46257, 'yyyy/m/d', { date1904: true })).toBe('2030/8/24');
    // 時刻繰り上げ（86399.9999… 秒 → 翌日 0:00）
    expect(f(0.9999999999, 'yyyy/m/d h:mm:ss')).toBe('1900/1/1 0:00:00');
    // 曜日
    expect(f(46257, 'ddd')).toBe('Sun');
    expect(f(46257, 'dddd')).toBe('Sunday');
    expect(f(46257, 'mmm')).toBe('Aug');
    expect(f(46257, 'mmmm')).toBe('August');
});

test('TC-XLV-03: General', async () => {
    const { formatCell } = await load();
    const g = (v: unknown, t = 'n') => formatCell(v, t as any, 0, {}).text;
    expect(g(0.1 + 0.2)).toBe('0.3');                    // 15 桁丸めで FP ノイズ除去
    expect(g(123)).toBe('123');
    expect(g(-4.5)).toBe('-4.5');
    expect(g(12345678901)).toBe('12345678901');          // 11 桁までは通常表示
    expect(g(123456789012)).toBe('1.23457E+11');         // 12 桁で指数
    expect(g(0.000000001)).toBe('1E-09');                // 微小数は指数
    expect(g(1.5)).toBe('1.5');
    expect(g(true, 'b')).toBe('TRUE');
    expect(g('#DIV/0!', 'e')).toBe('#DIV/0!');
    expect(g('text', 'str')).toBe('text');
    // 45.6% 問題は % 側で検証済み（NUMERIC_CASES）— General 側も 0.456 が化けない
    expect(g(0.456)).toBe('0.456');
});

test('TC-XLV-04: 縮退 3 段', async () => {
    const { formatCell } = await load();
    // (a) 部分未対応トークン（* 充填）は無視して残りを整形
    const r1 = formatCell(1234, 'n', '#,##0*x', {});
    expect(r1.text).toBe('1,234');
    // (b) 文法外（未知ブラケット・日付トークンなし）→ General + fallback マーク
    const r2 = formatCell(1234.5, 'n', '[Bogus]0', {});
    expect(r2.fallback).toBe('general');
    expect(r2.text).toBe('1234.5');
    // (b2) 文法外だが日付トークン含有（仏暦 B1）→ 汎用日付表示の特例
    const r2b = formatCell(1234.5, 'n', '[$-D07041E]B1yyyy', {});
    expect(r2b.fallback).toBe('date');
    expect(r2b.text).toBe('1903/5/18 12:00');
    // (c) 分数 → 小数縮退（General 相当・エラーにしない）
    const r3 = formatCell(1.25, 'n', '# ?/?', {});
    expect(r3.text).toBe('1.25');
    // (d) 例外を投げない（どんな書式でも text が返る）
    const r4 = formatCell(42, 'n', '"unclosed', {});
    expect(typeof r4.text).toBe('string');
    // alignHint
    expect(formatCell(1, 'n', 0, {}).alignHint).toBe('right');
    expect(formatCell('a', 'str', 0, {}).alignHint).toBe('left');
});
