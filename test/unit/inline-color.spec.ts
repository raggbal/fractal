/**
 * TC-IC-01/02 — inline-color.js 共有 core（サニタイズ allowlist + span 認識/生成/除去）。
 *
 * 純ロジック（DOM/vscode 非依存）なので Node require で直接検証する。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IC = require(path.join(__dirname, '../../src/shared/inline-color.js'));

test.describe('inline-color 共有 core', () => {
    // TC-IC-01（isSafeColorValue allowlist・R-3）★load-bearing・counterfactual
    test('TC-IC-01 isSafeColorValue は hex のみ許可・危険値を弾く', () => {
        // 安全（hex 3/6 桁・大文字も小文字化して true）
        expect(IC.isSafeColorValue('#ef4444')).toBe(true);
        expect(IC.isSafeColorValue('#e11')).toBe(true);
        expect(IC.isSafeColorValue('#EF4444')).toBe(true);
        expect(IC.isSafeColorValue('  #3b82f6  ')).toBe(true); // trim
        // 危険 / 非 hex（保存は hex 直値のみなので名前色・rgb も false）
        expect(IC.isSafeColorValue('red')).toBe(false);
        expect(IC.isSafeColorValue('rgb(1,2,3)')).toBe(false);
        expect(IC.isSafeColorValue('#ef4444;background:url(x)')).toBe(false);
        expect(IC.isSafeColorValue('#ef4444"onload="alert(1)')).toBe(false);
        expect(IC.isSafeColorValue('expression(1)')).toBe(false);
        expect(IC.isSafeColorValue('javascript:x')).toBe(false);
        expect(IC.isSafeColorValue('#gggggg')).toBe(false);
        expect(IC.isSafeColorValue('')).toBe(false);
        expect(IC.isSafeColorValue(null as any)).toBe(false);
        // ★ counterfactual: allowlist を .includes('#') 等に緩めると '#ef4444;background:url(x)' が通る（=RED）。
        //   ここでその危険値が false であることが allowlist の load-bearing 証明。
    });

    // TC-IC-02（COLOR_SPAN_RE + extract + wrap/strip round-trip）
    test('TC-IC-02 色 span の認識・抽出・生成・除去', () => {
        // makeColorSpanRe: color:#hex のみ抽出。複合 style は不成立。
        const re1 = IC.makeColorSpanRe();
        const m = re1.exec('foo <span style="color:#ef4444">bar</span> baz');
        expect(m).not.toBeNull();
        expect(m[1]).toBe('#ef4444');
        expect(m[2]).toBe('bar');
        // 複合 style（background 併記）はマッチしない
        const re2 = IC.makeColorSpanRe();
        expect(re2.exec('<span style="color:#ef4444;background:red">x</span>')).toBeNull();
        // extractColorFromStyle: 単一 color のみ許可
        expect(IC.extractColorFromStyle('color:#ef4444')).toBe('#ef4444');
        expect(IC.extractColorFromStyle('color: #EF4444;')).toBe('#ef4444'); // 小文字化 + 末尾;
        expect(IC.extractColorFromStyle('color:#ef4444;background:red')).toBeNull(); // 複合は null
        expect(IC.extractColorFromStyle('font-weight:bold')).toBeNull();
        expect(IC.extractColorFromStyle('color:red')).toBeNull(); // 名前色 null
        // ブラウザ execCommand('foreColor') は color: rgb(...) に正規化する → hex 化して受ける（load-bearing）
        expect(IC.extractColorFromStyle('color: rgb(239, 68, 68)')).toBe('#ef4444');
        expect(IC.extractColorFromStyle('color: rgb(239, 68, 68);')).toBe('#ef4444');
        expect(IC.extractColorFromStyle('color: inherit')).toBeNull(); // 色解除は null
        // wrap / strip round-trip
        expect(IC.wrapColorSpan('x', '#ef4444')).toBe('<span style="color:#ef4444">x</span>');
        expect(IC.wrapColorSpan('x', 'red')).toBe('x'); // 危険色は無着色
        expect(IC.stripColorSpan('<span style="color:#ef4444">x</span>')).toBe('x');
        expect(IC.stripColorSpan('a <span style="color:#3b82f6">b</span> c')).toBe('a b c');
    });
});
