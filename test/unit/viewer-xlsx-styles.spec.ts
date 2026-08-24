/**
 * viewer-xlsx-styles.spec.ts — cellXfs 解決・色 4 形態・寸法（TC-XLV-06/07）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-13。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-xlsx', 'styles.mjs');
async function load() {
    const dom = new JSDOM('');
    (global as any).DOMParser = dom.window.DOMParser;
    return import(/* webpackIgnore: true */ MOD);
}

const STYLES_XML = `<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy&quot;年&quot;m&quot;月&quot;"/></numFmts>
<fonts count="3">
<font><sz val="11"/><name val="游ゴシック"/></font>
<font><b/><sz val="14"/><color rgb="FFFF0000"/><name val="Meiryo"/></font>
<font><color theme="1"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/></border>
<border><left style="thin"><color indexed="10"/></left><bottom style="medium"><color rgb="FF333333"/></bottom></border>
</borders>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="176" fontId="1" fillId="2" borderId="1" applyNumberFormat="1"><alignment horizontal="center" wrapText="1"/></xf>
<xf numFmtId="14" fontId="2" fillId="3" borderId="0"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0"/>
</cellXfs>
</styleSheet>`;

// workbook 側の themeColors（スワップ済み配列: 0=lt1,1=dk1,2=lt2,3=dk2,4=accent1..）
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];

test('TC-XLV-06: cellXfs 解決 — solid=fgColor / numFmtId ID 検索 / theme+tint HLS / indexed / セル>行>列', async () => {
    const { parseStyles, resolveCellStyle, effectiveStyleIdx, tintColor } = await load();
    const styles = parseStyles(STYLES_XML);
    // numFmtId 164+ は ID 検索（インデックスでない）
    const st1 = resolveCellStyle(1, styles, THEME);
    expect(st1.numFmt).toBe('yyyy"年"m"月"');
    expect(st1.font.bold).toBe(true);
    expect(st1.font.sizePt).toBe(14);
    expect(st1.font.color).toBe('#FF0000');           // ARGB → #RRGGBB
    expect(st1.fill).toBe('#FFE699');                 // solid = **fgColor**（bgColor でない）
    expect(st1.border.left).toMatchObject({ style: 'thin', color: '#FF0000' });   // indexed 10 = FF0000
    expect(st1.border.bottom).toMatchObject({ style: 'medium', color: '#333333' });
    expect(st1.alignment).toMatchObject({ horizontal: 'center', wrapText: true });
    // ビルトイン numFmtId はそのまま数値で返る（numfmt.mjs が ID 解決）
    const st2 = resolveCellStyle(2, styles, THEME);
    expect(st2.numFmt).toBe(14);
    // theme=4 (accent1) + tint 0.5 → HLS で明るく（正確値は tintColor 単体で検証）
    expect(st2.fill).toBe('#' + tintColor('4472C4', 0.5));
    expect(st2.font.color).toBe('#000000');           // theme=1 → dk1（スワップ表）
    // tint の HLS 検証（正確に検証可能な組: 黒 + tint0.5 = 中間グレー / tint 0 = 恒等 / 白は不変）
    expect(tintColor('000000', 0.5)).toBe('808080');
    expect(tintColor('4472C4', 0)).toBe('4472C4');
    expect(tintColor('FFFFFF', 0.3)).toBe('FFFFFF');
    // 負 tint は暗く
    const darker = tintColor('4472C4', -0.5);
    expect(parseInt(darker.slice(0, 2), 16)).toBeLessThan(0x44);
    // セル > 行 > 列
    expect(effectiveStyleIdx(2, 1, 3)).toBe(2);
    expect(effectiveStyleIdx(null, 1, 3)).toBe(1);
    expect(effectiveStyleIdx(null, null, 3)).toBe(3);
    expect(effectiveStyleIdx(null, null, null)).toBeNull();
});

test('TC-XLV-07: 寸法 — ECMA 列幅式（MDW 7/8）・行高 pt×4/3・MDW 実測 seam', async () => {
    const { colWidthPx, rowHeightPx, measureMdw } = await load();
    // 既知ペア: 既定幅 8.43 @ MDW=7（Calibri 11）→ 64px
    expect(colWidthPx(8.43, 7)).toBe(64);
    // 游ゴシック系 MDW=8 では同じ width が広くなる（7 決め打ちの 12% 縮み問題の構造的解決）
    expect(colWidthPx(8.43, 8)).toBeGreaterThan(64);
    expect(colWidthPx(0, 7)).toBe(0);      // hidden（width 0）
    expect(rowHeightPx(18.75)).toBe(25);   // pt × 4/3
    expect(rowHeightPx(15)).toBe(20);
    // MDW 実測 seam（measure 関数注入 — 7.2px 実測 → ceil 8）
    expect(measureMdw((s: string) => s.length * 7.2)).toBe(8);
    expect(measureMdw(() => { throw new Error('no canvas'); })).toBe(7); // fallback
});
