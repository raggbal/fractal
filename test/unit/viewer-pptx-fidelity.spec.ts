/**
 * viewer-pptx-fidelity.spec.ts — pptx 描画忠実度の unit 番人（TC-PPV-15 / TC-PPV-17）
 *
 * sprint 20260823-165314-viewer-office-text-image 再オープン③（TASK-22 / TASK-24）。
 * 実 deck（PACE_Enablement_P2P.pptx）で発覚した「テキスト位置崩壊・画像消失」の根因を pin する:
 *  - TC-PPV-15: 段落前後間隔 spcPct の単位（1/1000% — 20000 = 20% = 0.2em。100 倍バグの番人）
 *  - TC-PPV-17: SVG-only picture（blip r:embed 無し + asvg:svgBlip のみ）のフォールバック
 * builder は viewer-pptx-bg.spec.ts と同型（stored zip 合成）+ spTree/media/rels 注入口を持つ汎用版。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const DIR = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx');
async function load(name: string) {
    const dom = new JSDOM('');
    (global as any).DOMParser = dom.window.DOMParser;
    (global as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
    return import(/* webpackIgnore: true */ path.join(DIR, name));
}

// ── stored zip（method 0）合成 — build-samples.js と同ロジック ──
function storedZip(entries: Array<[string, string | Buffer]>): Buffer {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
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

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** 最小 pptx: slide1 の spTree に任意 XML、slide rels / media を注入できる汎用 builder */
function buildPptx(opts: { spTree: string; slideRels?: Array<[string, string]>; media?: Array<[string, string | Buffer]> }): Buffer {
    const theme = `<?xml version="1.0"?>
<a:theme xmlns:a="${NS_A}" name="S"><a:themeElements><a:clrScheme name="S">
<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="S"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="S"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;
    const emptyTree = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';
    const slideRels = (opts.slideRels || [])
        .map(([id, target]) => `<Relationship Id="${id}" Type="${REL}/image" Target="${target}"/>`)
        .join('');
    const entries: Array<[string, string | Buffer]> = [
        ['[Content_Types].xml', `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`],
        ['ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
        ['ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/theme" Target="theme/theme1.xml"/></Relationships>`],
        ['ppt/theme/theme1.xml', theme],
        ['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld>${emptyTree}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`],
        ['ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`],
        ['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld>${emptyTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
        ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`],
        ['ppt/slides/slide1.xml', `<?xml version="1.0"?>
<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${REL}"><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${opts.spTree}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`],
        ['ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${slideRels}</Relationships>`],
        ...(opts.media || []).map(([name, content]) => [`ppt/media/${name}`, content] as [string, string | Buffer]),
    ];
    return storedZip(entries);
}

async function parseDeck(buf: Buffer) {
    const { parse } = await load('pptxtojson.mjs');
    return await parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { imageMode: 'base64' });
}

const walkEls = (els: any[], sink: (el: any) => void) => {
    for (const el of els || []) { sink(el); if (el.elements) walkEls(el.elements, sink); }
};

test('TC-PPV-15: 段落前後間隔 spcPct は 1/1000% 単位 — 20000 = 0.2em（100 倍バグの番人）', async () => {
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="9144000" cy="2286000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/>
<a:p><a:pPr><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:spcAft><a:spcPts val="600"/></a:spcAft></a:pPr><a:r><a:t>first</a:t></a:r></a:p>
<a:p><a:r><a:t>second</a:t></a:r></a:p>
</p:txBody></p:sp>`;
    const json = await parseDeck(buildPptx({ spTree: sp }));
    let para: any = null;
    walkEls(json.slides[0].elements, (el) => {
        const p0 = el.content?.paragraphs?.[0];
        if (p0 && p0.runs?.some((r: any) => r.text === 'first')) { para = p0; }
    });
    expect(para, 'テキスト要素がパースされる').toBeTruthy();
    // spcPct val=20000 = 20%（1/1000% 単位）→ 0.2em。counterfactual: 現行バグは 20em を出す = RED
    expect(para.css).toContain('margin-top: 0.2em');
    expect(para.css, '100 倍バグ（20em）が出ていない').not.toContain('margin-top: 20em');
    // spcPts 経路は不変: val=600 = 6pt
    expect(para.css).toContain('margin-bottom: 6pt');
});

test('TC-PPV-17: SVG-only picture（blip r:embed 無し + asvg:svgBlip のみ）が image 要素になる', async () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const pic = `<p:pic><p:nvPicPr><p:cNvPr id="3" name="logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId10"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    const json = await parseDeck(buildPptx({
        spTree: pic,
        slideRels: [['rId10', '../media/image1.svg']],
        media: [['image1.svg', SVG]],
    }));
    const images: any[] = [];
    walkEls(json.slides[0].elements, (el) => { if (el.type === 'image') { images.push(el); } });
    // counterfactual: 現行は blip attrs r:embed 欠落で要素ごと drop = RED
    expect(images.length, 'SVG-only pic が image 要素として存在').toBe(1);
    const src = String(images[0].src || images[0].base64 || '');
    expect(src.startsWith('data:image/svg+xml'), `mime が svg+xml（実際: ${src.slice(0, 30)}）`).toBe(true);
});

test('TC-PPV-17b: blipFill（shape 塗り）経路でも svgBlip フォールバックが効く', async () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>';
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="914400" cy="914400"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
<a:blipFill><a:blip><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId10"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr>
<p:txBody><a:bodyPr/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`;
    const json = await parseDeck(buildPptx({
        spTree: sp,
        slideRels: [['rId10', '../media/image1.svg']],
        media: [['image1.svg', SVG]],
    }));
    let shape: any = null;
    walkEls(json.slides[0].elements, (el) => {
        if (el.content?.paragraphs?.some((p: any) => p.runs?.some((r: any) => r.text === 'x'))) { shape = el; }
    });
    expect(shape, 'shape がパースされる').toBeTruthy();
    const fill = JSON.stringify(shape.fill || '');
    expect(fill.includes('data:image/svg+xml'), `fill に svg data URL（実際: ${fill.slice(0, 60)}）`).toBe(true);
});
