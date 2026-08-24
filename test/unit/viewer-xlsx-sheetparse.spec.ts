/**
 * viewer-xlsx-sheetparse.spec.ts — シートパース 2 経路 + seam（TC-XLV-05/08 / ADRL-0095）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-10。
 * DOMParser 経路（jsdom 注入）と文字列走査経路が同一 SheetModel を返すこと（両経路同値）が中核の番人。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const SHEET_MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-xlsx', 'sheet-parse.mjs');
const WB_MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-xlsx', 'workbook.mjs');

async function load() {
    const dom = new JSDOM('');
    (global as any).DOMParser = dom.window.DOMParser;
    return {
        sheet: await import(/* webpackIgnore: true */ SHEET_MOD),
        wb: await import(/* webpackIgnore: true */ WB_MOD),
    };
}

const SHEET_XML = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetFormatPr defaultRowHeight="18.75"/>
<cols><col min="2" max="3" width="12.5" customWidth="1"/><col min="5" max="5" hidden="1" width="8.43"/></cols>
<sheetData>
<row r="1" ht="30" customHeight="1"><c r="A1" t="s"><v>0</v></c><c t="s"><v>1</v></c><c r="D1"><v>42.5</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>直接</t></is></c><c r="B2" t="str"><f>CONCAT(A1)</f><v>式結果</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="e"><v>#DIV/0!</v></c></row>
<row r="4" hidden="1"><c r="B4" s="3"/></row>
<row/>
</sheetData>
<mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>
</worksheet>`;

// prefix 付き変種（<x:row> — 名前空間プレフィックス付き main ns）
const SHEET_XML_PREFIXED = SHEET_XML
    .replace(/<(\/?)(worksheet|sheetFormatPr|cols|col|sheetData|row|c|v|is|t|f|mergeCells|mergeCell)\b/g, '<$1x:$2')
    .replace('<x:worksheet xmlns=', '<x:worksheet xmlns:x=');

test('TC-XLV-05: セル型全種・r 属性省略規則・hidden・merge・cols', async () => {
    const { sheet } = await load();
    const model = sheet.parseSheetDom(SHEET_XML);
    // r 省略: A1 の次の t="s" セルは B1 / <row/>（r 省略）は直前 +1 = 5 行目
    const r1 = model.rows.get(0)!;
    expect(r1.cells.get(0)).toMatchObject({ t: 's', v: '0' });
    expect(r1.cells.get(1)).toMatchObject({ t: 's', v: '1' });  // r 省略 → B1
    expect(r1.cells.get(3)).toMatchObject({ t: 'n', v: '42.5' });
    expect(r1.ht).toBe(30);
    const r2 = model.rows.get(1)!;
    expect(r2.cells.get(0)).toMatchObject({ t: 'inlineStr', v: '直接' });
    expect(r2.cells.get(1)).toMatchObject({ t: 'str', v: '式結果', f: 'CONCAT(A1)' });
    expect(r2.cells.get(2)).toMatchObject({ t: 'b', v: '1' });
    expect(r2.cells.get(3)).toMatchObject({ t: 'e', v: '#DIV/0!' });
    // 値なしスタイル付きセル + hidden 行
    const r4 = model.rows.get(3)!;
    expect(r4.hidden).toBe(true);
    expect(r4.cells.get(1)).toMatchObject({ s: 3 });
    // merges / cols / defaultRowHeight
    expect(model.merges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
    expect(model.cols[0]).toMatchObject({ min: 2, max: 3, width: 12.5 });
    expect(model.cols[1]).toMatchObject({ min: 5, max: 5, hidden: true });
    expect(model.defaultRowHeight).toBe(18.75);
});

test('TC-XLV-08: 両経路同値（plain / self-closing / prefix 変種）+ pickSheetParser 境界', async () => {
    const { sheet } = await load();
    for (const [name, xml] of [['plain', SHEET_XML], ['prefixed', SHEET_XML_PREFIXED]] as const) {
        const domModel = sheet.parseSheetDom(xml);
        const streamModel = sheet.parseSheetStream(xml);
        // Map は JSON にならないため正規化して deep-equal
        const norm = (m: any) => ({
            rows: [...m.rows.entries()].map(([i, r]: any) => [i, { ...r, cells: [...r.cells.entries()] }]),
            merges: m.merges, cols: m.cols,
            defaultRowHeight: m.defaultRowHeight, defaultColWidth: m.defaultColWidth,
            dimension: m.dimension,
        });
        expect(norm(streamModel), `両経路同値（${name}）`).toEqual(norm(domModel));
    }
    // seam 境界（8MB ± 1）
    const TH = sheet.SHEET_PARSE_THRESHOLD;
    expect(TH).toBe(8 * 1024 * 1024);
    expect(sheet.pickSheetParser(TH - 1)).toBe('dom');
    expect(sheet.pickSheetParser(TH)).toBe('dom');
    expect(sheet.pickSheetParser(TH + 1)).toBe('stream');
});

test('workbook: rels 経由シート解決・date1904・sharedStrings rich 連結 + rPh strip・theme スワップ表', async () => {
    const { wb } = await load();
    const workbookXml = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr date1904="1"/>
<bookViews><workbookView activeTab="1"/></bookViews>
<sheets><sheet name="集計!表" sheetId="99" r:id="rId2"/><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="秘" sheetId="2" state="veryHidden" r:id="rId3"/></sheets>
</workbook>`;
    const relsXml = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type=".../worksheet" Target="worksheets/sheetX.xml"/>
<Relationship Id="rId2" Type=".../worksheet" Target="worksheets/mySheet99.xml"/>
<Relationship Id="rId3" Type=".../worksheet" Target="worksheets/hidden.xml"/>
</Relationships>`;
    const sstXml = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>plain</t></si>
<si><r><t>東</t></r><r><t>京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>
</sst>`;
    const themeXml = `<?xml version="1.0"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme></a:themeElements></a:theme>`;
    const model = wb.parseWorkbook({ workbookXml, relsXml, sharedStringsXml: sstXml, themeXml, stylesXml: null });
    expect(model.date1904).toBe(true);
    expect(model.activeTab).toBe(1);
    // rels 経由（sheetId=99 でも rId が正 — ファイル名を当てにしない）+ タブ順は要素順
    expect(model.sheets.map((s: any) => s.name)).toEqual(['集計!表', 'Data', '秘']);
    expect(model.sheets[0].target).toBe('worksheets/mySheet99.xml');
    expect(model.sheets[2].state).toBe('veryHidden');
    // sharedStrings: rich run 連結 + rPh 除去（ふりがな癒着なし）
    expect(model.sharedStrings).toEqual(['plain', '東京']);
    // theme index スワップ（0=lt1, 1=dk1, 2=lt2, 3=dk2, 4=accent1）
    expect(model.themeColors[0]).toBe('FFFFFF');
    expect(model.themeColors[1]).toBe('000000');
    expect(model.themeColors[2]).toBe('E7E6E6');
    expect(model.themeColors[3]).toBe('44546A');
    expect(model.themeColors[4]).toBe('4472C4');
});
