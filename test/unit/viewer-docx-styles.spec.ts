/**
 * viewer-docx-styles.spec.ts — スタイル 4 層 + toggle XOR / numbering / theme（TC-DXV-06/07/08）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-12。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const DIR = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-docx');
function domGlobals() {
    const dom = new JSDOM('');
    (global as any).DOMParser = dom.window.DOMParser;
}
const xml = (s: string) => new (global as any).DOMParser().parseFromString(s, 'application/xml');

test('TC-DXV-06: 4 層解決 — docDefaults → basedOn チェーン → 直接書式 / toggle XOR', async () => {
    domGlobals();
    const { buildStyleResolver } = await import(/* webpackIgnore: true */ path.join(DIR, 'styles.mjs'));
    const stylesDoc = xml(`<w:styles xmlns:w="urn:w">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/><w:rFonts w:ascii="Calibri" w:eastAsia="游明朝"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:color w:val="336699"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:basedOn w:val="Base"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Strong"><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Loop1"><w:basedOn w:val="Loop2"/></w:style>
<w:style w:type="paragraph" w:styleId="Loop2"><w:basedOn w:val="Loop1"/></w:style>
</w:styles>`);
    const resolver = buildStyleResolver(stylesDoc);
    // docDefaults → Heading1（basedOn 経由の color 継承 + サイズ上書き）
    const eff = resolver.effectiveRPr({ paraStyleId: 'Heading1', direct: {} });
    expect(eff.szHalf).toBe(32);
    expect(eff.color).toBe('336699');       // Base から継承
    expect(eff.fonts.ea).toBe('游明朝');     // docDefaults から
    expect(eff.b).toBe(true);
    // 直接書式が絶対上書き
    const eff2 = resolver.effectiveRPr({ paraStyleId: 'Heading1', direct: { szHalf: 24, b: false } });
    expect(eff2.szHalf).toBe(24);
    expect(eff2.b).toBe(false);
    // toggle XOR: Heading1(b) × Strong(b) → 打ち消して非 bold（counterfactual: 後勝ちだと true）
    const eff3 = resolver.effectiveRPr({ paraStyleId: 'Heading1', charStyleId: 'Strong', direct: {} });
    expect(eff3.b).toBe(false);
    // 循環 basedOn は無限ループしない
    const eff4 = resolver.effectiveRPr({ paraStyleId: 'Loop1', direct: {} });
    expect(eff4.szHalf).toBe(21);
});

test('TC-DXV-07: numbering — 継続/上位リセット/startOverride/和文 numFmt/%1.%2', async () => {
    domGlobals();
    const { buildNumbering, createCounter, formatNum } = await import(/* webpackIgnore: true */ path.join(DIR, 'numbering.mjs'));
    const doc = xml(`<w:numbering xmlns:w="urn:w">
<w:abstractNum w:abstractNumId="0">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1">
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimalEnclosedCircle"/><w:lvlText w:val="%1"/></w:lvl>
</w:abstractNum>
<w:num w:numId="10"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="11"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
<w:num w:numId="12"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`);
    const defs = buildNumbering(doc);
    const counter = createCounter(defs);
    expect(counter.next(10, 0).text).toBe('1.');
    expect(counter.next(10, 1).text).toBe('1.1');
    expect(counter.next(10, 1).text).toBe('1.2');
    expect(counter.next(10, 0).text).toBe('2.');   // 継続
    expect(counter.next(10, 1).text).toBe('2.1');  // 上位で下位リセット
    expect(counter.next(11, 0).text).toBe('5.');   // startOverride
    expect(counter.next(12, 0).text).toBe('①');    // decimalEnclosedCircle
    expect(counter.next(12, 0).text).toBe('②');
    // 書式化関数（和文系）
    expect(formatNum('decimalFullWidth', 123)).toBe('１２３');
    expect(formatNum('aiueo', 3)).toBe('ｳ');
    expect(formatNum('irohaFullWidth', 2)).toBe('ロ');
    expect(formatNum('lowerRoman', 4)).toBe('iv');
    expect(formatNum('upperLetter', 28)).toBe('AB');
    expect(formatNum('decimalZero', 7)).toBe('07');
});

test('TC-DXV-08: theme — accent1+tint 期待 hex / auto 黒・濃色 shd 上で白 / ea フォールバック', async () => {
    domGlobals();
    const { parseTheme, resolveRunColor, fontFamilyCss } = await import(/* webpackIgnore: true */ path.join(DIR, 'theme.mjs'));
    const themeDoc = xml(`<a:theme xmlns:a="urn:a"><a:themeElements><a:clrScheme name="O">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="O"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="游ゴシック Light"/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="游明朝"/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`);
    const theme = parseTheme(themeDoc);
    expect(theme.colors.accent1).toBe('4472C4');
    // themeColor="accent1" + themeTint="99"（60% tint）→ Office 既知値 #8FAADC
    expect(resolveRunColor({ themeColor: 'accent1', themeTint: '99' }, theme, {})).toBe('#8FAADC');
    // background1 → lt1 / text1 → dk1 のマッピング
    expect(resolveRunColor({ themeColor: 'background1' }, theme, {})).toBe('#FFFFFF');
    expect(resolveRunColor({ themeColor: 'text1' }, theme, {})).toBe('#000000');
    // auto = 黒 / 濃色 shd 上では白
    expect(resolveRunColor({ color: 'auto' }, theme, {})).toBe('#000000');
    expect(resolveRunColor({ color: 'auto' }, theme, { shdFill: '1F3864' })).toBe('#FFFFFF');
    // 直接 hex
    expect(resolveRunColor({ color: 'FF0000' }, theme, {})).toBe('#FF0000');
    // ea フォールバックスタック（viewer-common withJaFallback 経由）
    const fam = fontFamilyCss({ ascii: 'Century', ea: 'ＭＳ 明朝' }, theme);
    expect(fam).toContain('Century');
    expect(fam).toContain('ＭＳ 明朝');
    expect(fam).toContain('serif');
    // asciiTheme / eaTheme の解決
    const fam2 = fontFamilyCss({ asciiTheme: 'minorHAnsi', eaTheme: 'minorEastAsia' }, theme);
    expect(fam2).toContain('Calibri');
    expect(fam2).toContain('游明朝');
});
