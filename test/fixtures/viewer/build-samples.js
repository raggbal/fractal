/**
 * build-samples.js — TASK-17 の実文書 fixtures（sample.docx / sample.xlsx / sample.pptx）生成器
 *
 * sprint 20260823-165314-viewer-office-text-image。表・結合・書式・placeholder・和文・画像込みの
 * 「実文書相当」を決定論的に合成して commit する（バイナリの出所をレビュー可能に保つ）。
 * 再生成: node test/fixtures/viewer/build-samples.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── stored zip（method 0）合成 — test/utils/stored-zip.ts と同ロジックの JS 版 ──
function storedZip(entries) {
    const locals = []; const centrals = []; let offset = 0;
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name);
        const data = typeof content === 'string' ? Buffer.from(content) : content;
        const loc = Buffer.alloc(30);
        loc.writeUInt32LE(0x04034b50, 0);
        loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22);
        loc.writeUInt16LE(nameBuf.length, 26);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
        locals.push(loc, nameBuf, data); centrals.push(cen, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

const PNG_4x4 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAcT9GO0U4BxoAAAAAElFTkSuQmCC', 'base64');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// ── sample.docx: 見出し・和文本文・結合表・ルビ・画像・改ページ 2 ページ ──
function buildDocx() {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const doc = `<?xml version="1.0"?>
<w:document ${W} xmlns:r="${REL}"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>会議議事録（サンプル）</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>日時: </w:t></w:r><w:r><w:t>2026年8月23日 / 場所: 第一会議室</w:t></w:r></w:p>
<w:p><w:r><w:ruby><w:rt><w:r><w:t>ぎじろく</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>議事録</w:t></w:r></w:rubyBase></w:ruby><w:t>の要点を以下の表にまとめる。</w:t></w:r></w:p>
<w:tbl>
  <w:tblPr><w:tblBorders><w:top w:val="single"/><w:bottom w:val="single"/><w:left w:val="single"/><w:right w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr>
  <w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>
  <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:val="clear" w:fill="DDEBF7"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>議題（結合セル）</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>担当</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>予算計画</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>承認済み</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>
  <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r><w:r><w:t xml:space="preserve"> 添付図（ロゴ）</w:t></w:r></w:p>
<w:p><w:r><w:t>1 ページ目の結び。</w:t><w:br w:type="page"/><w:t>2 ページ目: 付録。強調は</w:t></w:r>
<w:r><w:rPr><w:i/><w:u w:val="single"/><w:color w:val="C00000"/></w:rPr><w:t>斜体下線赤</w:t></w:r><w:r><w:t>で示す。</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1134" w:right="1134" w:top="1134" w:bottom="1134"/></w:sectPr>
</w:body></w:document>`;
    const styles = `<?xml version="1.0"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="2F5496"/></w:rPr></w:style>
</w:styles>`;
    return storedZip([
        ['_rels/.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`],
        ['word/document.xml', doc],
        ['word/_rels/document.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rId10" Type="${REL}/image" Target="media/image1.png"/></Relationships>`],
        ['word/styles.xml', styles],
        ['word/media/image1.png', PNG_4x4],
    ]);
}

// ── sample.xlsx: 2 シート・結合・書式（塗り/太字/日付/％）・数式・ハイパーリンク ──
function buildXlsx() {
    const XM = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const RNS = `xmlns:r="${REL}"`;
    const sheet1 = `<?xml version="1.0"?>
<worksheet ${XM} ${RNS}>
<cols><col min="1" max="1" width="14"/><col min="2" max="3" width="12"/></cols>
<sheetData>
<row r="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" t="s" s="1"><v>1</v></c><c r="C1" t="s" s="1"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="2"><v>45000</v></c><c r="C2" s="3"><v>0.25</v></c></row>
<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>1200</v></c><c r="C3"><f>B3*2</f><v>2400</v></c></row>
<row r="5"><c r="A5" t="s" s="1"><v>5</v></c></row>
</sheetData>
<autoFilter ref="A1:C3"/>
<mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells>
<hyperlinks><hyperlink ref="A3" r:id="rIdHL"/></hyperlinks>
</worksheet>`;
    const sheet2 = `<?xml version="1.0"?>
<worksheet ${XM}><sheetData><row r="1"><c r="A1" t="s"><v>6</v></c></row></sheetData></worksheet>`;
    const styles = `<?xml version="1.0"?>
<styleSheet ${XM}>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0"/>
</cellXfs>
</styleSheet>`;
    const sst = `<?xml version="1.0"?>
<sst ${XM} count="7" uniqueCount="7">
<si><t>項目</t></si><si><t>期日</t></si><si><t>進捗率</t></si><si><t>要件定義</t></si>
<si><t>リンク付き実装</t></si><si><t>合計（結合セル）</t></si><si><t>第二シートの補足</t></si></sst>`;
    const workbook = `<?xml version="1.0"?>
<workbook ${XM} ${RNS}><sheets>
<sheet name="計画" sheetId="1" r:id="rId1"/><sheet name="補足" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    return storedZip([
        ['_rels/.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
        ['xl/workbook.xml', workbook],
        ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rIdT" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
        ['xl/worksheets/sheet1.xml', sheet1],
        ['xl/worksheets/sheet2.xml', sheet2],
        ['xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rIdHL" Type="${REL}/hyperlink" Target="https://example.com/plan" TargetMode="External"/></Relationships>`],
        ['xl/styles.xml', styles],
        ['xl/sharedStrings.xml', sst],
    ]);
}

// ── sample.pptx: 2 スライド・和文・図形塗り・表相当のテキスト（TASK-14 spec と同骨格） ──
function buildPptx() {
    const NS = {
        p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
        a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
        r: REL,
        rel: PKG_REL,
    };
    const sp = (id, text, y) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="${y}"/><a:ext cx="9144000" cy="1143000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ja" sz="2400" b="1"><a:latin typeface="Century"/><a:ea typeface="ＭＳ 明朝"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const slide = (i, body) => `<?xml version="1.0"?>
<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${body}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    const ellipse = `<p:sp><p:nvSpPr><p:cNvPr id="90" name="e"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="7000000" y="3000000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm>
<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr>
<p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`;
    const theme = `<?xml version="1.0"?>
<a:theme xmlns:a="${NS.a}" name="S"><a:themeElements><a:clrScheme name="S">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="S"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="游ゴシック Light"/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="游ゴシック"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="S"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;
    const emptyTree = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
    const entries = [
        ['[Content_Types].xml', `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`],
        ['ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
        ['ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL}/theme" Target="theme/theme1.xml"/></Relationships>`],
        ['ppt/theme/theme1.xml', theme],
        ['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`],
        ['ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`],
        ['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
        ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`],
        ['ppt/slides/slide1.xml', slide(1, sp(2, '事業計画の概要', 914400) + sp(3, '第一四半期の進捗と課題', 2200000) + ellipse)],
        ['ppt/slides/slide2.xml', slide(2, sp(2, '付録: 用語集', 914400) + sp(3, 'サンプル資料の第二スライド', 2200000))],
        ['ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`],
        ['ppt/slides/_rels/slide2.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`],
    ];
    return storedZip(entries);
}

const OUT = __dirname;
fs.writeFileSync(path.join(OUT, 'sample.docx'), buildDocx());
fs.writeFileSync(path.join(OUT, 'sample.xlsx'), buildXlsx());
fs.writeFileSync(path.join(OUT, 'sample.pptx'), buildPptx());
console.log('samples written to', OUT);
