/**
 * viewer-pptx-font-fallback.spec.ts — 指定フォントが無いとき、接尾語を外した基本名に寄せる
 * sprint 20261002-140024-pptx-image-background-render TASK-04 / TC-PBG-12
 *
 * テーマの見出しフォント "Amazon Ember Display" が閲覧環境に無いと汎用フォントで描かれ、字幅が変わって
 * 折り返し位置がずれる。同じファミリーの基本名（"Amazon Ember"）を次の候補に置く。
 * 番人: 接尾語の規則を外すと (a)(b)(c)(e) が落ちる
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const SRC = path.join(__dirname, '..', '..', 'src', 'webview');

test('TC-PBG-12: 太さ・用途の接尾語を外した基本名が次の候補に入る', async () => {
    const { withJaFallback } = await import(/* webpackIgnore: true */ path.join(SRC, 'viewer-common', 'font-fallback.mjs'));
    // (a) 用途の接尾語
    expect(withJaFallback(['Amazon Ember Display'])).toBe('"Amazon Ember Display", "Amazon Ember", sans-serif');
    // (b) 太さの接尾語
    expect(withJaFallback(['Segoe UI Semibold'])).toBe('"Segoe UI Semibold", "Segoe UI", sans-serif');
    // (c) 和文 + 太さ → 基本名の和文の別名まで展開
    const ja = withJaFallback(['Calibri Light', '游ゴシック Light']);
    expect(ja.startsWith('"Calibri Light", Calibri, "游ゴシック Light", "游ゴシック", "Yu Gothic"'), ja).toBe(true);
    expect(ja.endsWith('sans-serif')).toBe(true);
    // (d) 接尾語だけの名前・接尾語の無い名前は変えない（回帰 pin）
    expect(withJaFallback(['Display'])).toBe('Display, sans-serif');
    expect(withJaFallback(['Arial'])).toBe('Arial, sans-serif');
    expect(withJaFallback(['游明朝'])).toBe('"游明朝", "Yu Mincho", YuMincho, "Hiragino Mincho ProN", "MS Mincho", serif');

    // (e) pptx の run の font-family にもこのスタックが入る
    new JSDOM('');
    const { getSpanStyleInfo } = await import(/* webpackIgnore: true */ path.join(SRC, 'viewer-pptx', 'text.mjs'));
    const warpObj = {
        slideResObj: {},
        themeContent: { 'a:theme': { 'a:themeElements': { 'a:fontScheme': {
            'a:majorFont': { 'a:latin': { attrs: { typeface: 'Amazon Ember Display' } }, 'a:ea': { attrs: { typeface: '' } } },
            'a:minorFont': { 'a:latin': { attrs: { typeface: 'Amazon Ember' } }, 'a:ea': { attrs: { typeface: '' } } },
        } } } },
    };
    const node = { 'a:rPr': { attrs: { order: 0 } }, 'a:t': 'AWSentral' };
    const info = getSpanStyleInfo(node, {}, {}, undefined, undefined, undefined, 'title', undefined, undefined, warpObj);
    expect(info.styleText).toContain('font-family: "Amazon Ember Display", "Amazon Ember", sans-serif;');
});
