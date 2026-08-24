/**
 * viewer-pptx-port.spec.ts — pptx 移植の依存置換 + 構造化 runs（TC-PPV-01/02/03/04/08）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-11。
 *  - TC-PPV-01: readXmlFile.mjs（DOMParser 版）が upstream simplifyLostLess 出力形と互換
 *  - TC-PPV-02: genTextBody 構造化 runs — `a<b>c` が生文字列のまま（XSS counterfactual）
 *  - TC-PPV-03: zip-facade（jszip 同形 async('string'|'arraybuffer'|'base64')）
 *  - TC-PPV-04: color-util の tinycolor quirk（toHex/toHex8 = # なし・HSL 往復）
 *  - TC-PPV-08: EA フォント — {latin, ea} 分離収集 + テーマ +mj/+mn-ea 解決でスタック化
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as zlib from 'zlib';
import { JSDOM } from 'jsdom';

const DIR = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx');
async function load(name: string) {
    const dom = new JSDOM('');
    (global as any).DOMParser = dom.window.DOMParser;
    (global as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
    return import(/* webpackIgnore: true */ path.join(DIR, name));
}

test('TC-PPV-01: readXmlFile 互換 — タグ名キー / attrs.order / value / 単一文字列 collapse / 実体デコード', async () => {
    const { parseXmlString } = await load('readXmlFile.mjs');
    const json = parseXmlString(
        '<p:sp xmlns:p="urn:p" xmlns:a="urn:a">' +
        '<p:txBody><a:p>' +
        '<a:r><a:rPr b="1"/><a:t>hello</a:t></a:r>' +
        '<a:r><a:t xml:space="preserve">  spaced  </a:t></a:r>' +
        '<a:r><a:t>a&lt;b&gt;c &amp;</a:t></a:r>' +
        '</a:p></p:txBody></p:sp>');
    const sp = json['p:sp'];
    expect(sp).toBeTruthy();                                     // prefix 付きタグ名キー
    const runs = sp['p:txBody']['a:p']['a:r'];
    expect(Array.isArray(runs)).toBe(true);                      // 複数 → 配列
    expect(runs[0]['a:t']).toBe('hello');                        // 単一文字列子 → string collapse
    expect(runs[0]['a:rPr'].attrs.b).toBe('1');                  // 属性 + order
    expect(typeof runs[0]['a:rPr'].attrs.order).toBe('number');
    expect(runs[1]['a:t'].value).toBe('  spaced  ');             // 属性付きテキスト → {attrs, value}
    expect(runs[1]['a:t'].attrs['xml:space']).toBe('preserve');
    expect(runs[2]['a:t']).toBe('a<b>c &');                      // DOMParser は実体デコード済み
});

test('TC-PPV-02: 構造化 runs — 生文字列保持（HTML エスケープ痕跡なし = XSS counterfactual）', async () => {
    const { genTextBody } = await load('text.mjs');
    const textBody = {
        'a:p': {
            'a:pPr': { attrs: { order: 0 } },
            'a:r': [
                { attrs: { order: 1 }, 'a:rPr': { attrs: { order: 2, b: '1' } }, 'a:t': 'a<b>c & <img onerror=x>' },
                { attrs: { order: 3 }, 'a:rPr': { attrs: { order: 4 } }, 'a:t': '日本語' },
            ],
        },
    };
    const warpObj = { slideResObj: {}, themeContent: null, slideMasterTextStyles: undefined, defaultTextStyle: undefined };
    const out = genTextBody(textBody, {}, undefined, undefined, undefined, warpObj);
    expect(out).toBeTruthy();
    expect(out.paragraphs.length).toBe(1);
    const runs = out.paragraphs[0].runs;
    expect(runs[0].text).toBe('a<b>c & <img onerror=x>');   // 生のまま（&lt; 等の entity を持ち込まない）
    expect(runs[0].css).toContain('font-weight: bold');
    expect(runs[1].text).toBe('日本語');
    // HTML 文字列でない（string を返す旧契約の廃止）
    expect(typeof out).toBe('object');
});

test('TC-PPV-03: zip-facade — jszip 同形 async 契約 + 不在 null', async () => {
    const { createZipFacade } = await load('zip-facade.mjs');
    // 最小 zip 合成（stored 1 エントリ）
    const name = Buffer.from('a.xml');
    const data = Buffer.from('<x>日本語</x>');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 42);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cen.length + name.length, 12); eocd.writeUInt32LE(loc.length + name.length + data.length, 16);
    const zipBuf = Buffer.concat([loc, name, data, cen, name, eocd]);
    const zip = await createZipFacade(new Uint8Array(zipBuf));
    expect(await zip.file('a.xml')!.async('string')).toBe('<x>日本語</x>');
    const ab = await zip.file('a.xml')!.async('arraybuffer');
    expect(Buffer.from(ab).toString('utf8')).toBe('<x>日本語</x>');
    expect(Buffer.from(await zip.file('a.xml')!.async('base64'), 'base64').toString('utf8')).toBe('<x>日本語</x>');
    expect(zip.file('missing.xml')).toBeNull();
});

test('TC-PPV-04: color-util — tinycolor quirk（# なし hex・HSL 往復・setAlpha/toHex8）', async () => {
    const mod = await load('color-util.mjs');
    const tinycolor = mod.default;
    // applyShade('FF0000', 0.5) 相当: l を半分 → 800000
    const hsl = tinycolor('FF0000').toHsl();
    expect(hsl.h).toBe(0); expect(hsl.s).toBe(1); expect(hsl.l).toBe(0.5);
    expect(tinycolor({ h: hsl.h, s: hsl.s, l: hsl.l * 0.5, a: hsl.a }).toHex()).toBe('800000');
    // # なし返却の quirk（呼び出し側が '#'+hex を組む前提）
    expect(tinycolor('#4472C4').toHex().startsWith('#')).toBe(false);
    // HSL 往復
    const h2 = tinycolor('4472C4').toHsl();
    expect(tinycolor(h2).toHex()).toBe('4472c4');
    // setAlpha + toHex8
    expect(tinycolor('FF0000').setAlpha(0.5).toHex8()).toBe('ff000080');
    // 8 桁 hex 入力
    expect(tinycolor('11223344').toHex8()).toBe('11223344');
});

test('TC-PPV-08: EA フォント — 分離収集 + テーマ解決でスタック化（Century, ＭＳ 明朝）', async () => {
    const { getFontType } = await load('fontStyle.mjs');
    const warpObj = {
        themeContent: {
            'a:theme': { 'a:themeElements': { 'a:fontScheme': {
                'a:majorFont': { 'a:latin': { attrs: { typeface: 'Calibri Light' } }, 'a:ea': { attrs: { typeface: '游ゴシック Light' } } },
                'a:minorFont': { 'a:latin': { attrs: { typeface: 'Calibri' } }, 'a:ea': { attrs: { typeface: '游ゴシック' } } },
            } } },
        },
    };
    // 明示 latin + ea → スタック
    const node = { 'a:rPr': { attrs: { order: 0 }, 'a:latin': { attrs: { typeface: 'Century' } }, 'a:ea': { attrs: { typeface: 'ＭＳ 明朝' } } } };
    const ft = getFontType(node, {}, {}, undefined, undefined, 'body', undefined, 1, warpObj);
    expect(ft).toBe('Century, ＭＳ 明朝');
    // テーマ参照（+mn-lt / +mn-ea）
    const node2 = { 'a:rPr': { attrs: { order: 0 }, 'a:latin': { attrs: { typeface: '+mn-lt' } }, 'a:ea': { attrs: { typeface: '+mn-ea' } } } };
    expect(getFontType(node2, {}, {}, undefined, undefined, 'body', undefined, 1, warpObj)).toBe('Calibri, 游ゴシック');
    // latin のみ明示 → ea はテーマ補完（EA 落ち防止）
    const node3 = { 'a:rPr': { attrs: { order: 0 }, 'a:latin': { attrs: { typeface: 'Arial' } } } };
    expect(getFontType(node3, {}, {}, undefined, undefined, 'body', undefined, 1, warpObj)).toBe('Arial, 游ゴシック');
    // title はテーマ major
    const node4 = { 'a:rPr': { attrs: { order: 0 } } };
    expect(getFontType(node4, {}, {}, undefined, undefined, 'title', undefined, 1, warpObj)).toBe('Calibri Light, 游ゴシック Light');
});
