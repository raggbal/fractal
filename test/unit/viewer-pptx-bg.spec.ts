/**
 * viewer-pptx-bg.spec.ts — pptx 背景 bgRef→テーマ solidFill(phClr) の phClr 継承（TC-PPV-14）
 *
 * sprint 20260823-165314-viewer-office-text-image 再オープン①（TASK-19）。
 * 手動テストで発覚した「背景が白になる」バグの番人: getSlideBackgroundFill の
 * bgRef → bgFillStyleLst → SOLID_FILL 分岐が解決済み phClr を getSolidFill に渡さないと、
 * テーマ側 `<a:schemeClr val="phClr"/>` が空文字に解決され fill.value='' = 白になる。
 * fixture は master clrMap を既定と反転（bg2="dk2"）させ、正解 = dk2 = #232F3E を一意化する
 * （実ファイル PACE_Enablement_P2P.pptx と同構成）。
 * 3 変種（slide 直 / layout / master の各 bgRef 経路）で 3 分岐全部の配線を pin する。
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

// ── stored zip（method 0）合成 — test/fixtures/viewer/build-samples.js と同ロジック ──
function storedZip(entries: Array<[string, string]>): Buffer {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name);
        const data = Buffer.from(content);
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

// bgRef idx=1001（テーマ bgFillStyleLst の 1 番目 = solidFill(phClr)）を bg2 で塗る指示
const BG_REF = '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg>';

/**
 * 最小 pptx を合成する。
 * @param bgAt   bgRef を置く階層（'slide' | 'layout' | 'master'）— fill.mjs の 3 分岐に対応
 * @param clrMap 'reversed'（bg2="dk2" → 正解 #232F3E）| 'default'（bg2="lt2" → 正解 #FFFFFF）
 */
function buildBgPptx(bgAt: 'slide' | 'layout' | 'master', clrMap: 'reversed' | 'default'): Buffer {
    const theme = `<?xml version="1.0"?>
<a:theme xmlns:a="${NS_A}" name="S"><a:themeElements><a:clrScheme name="S">
<a:dk1><a:srgbClr val="002D43"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="232F3E"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="S"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="S"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;
    const clrMapAttrs = clrMap === 'reversed'
        ? 'bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"'
        : 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"';
    const tree = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';
    const cSld = (bg: boolean) => `<p:cSld>${bg ? BG_REF : ''}${tree}</p:cSld>`;
    const entries: Array<[string, string]> = [
        // Override は 2 件以上（1 件だと simplifyLostLess が配列に collapse せず getContentTypes の for-of が落ちる）
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
<p:sldMaster xmlns:p="${NS_P}" xmlns:a="${NS_A}">${cSld(bgAt === 'master')}<p:clrMap ${clrMapAttrs} accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`],
        ['ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`],
        ['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${NS_P}" xmlns:a="${NS_A}">${cSld(bgAt === 'layout')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
        ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`],
        ['ppt/slides/slide1.xml', `<?xml version="1.0"?>
<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}">${cSld(bgAt === 'slide')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`],
        ['ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`],
    ];
    return storedZip(entries);
}

async function parseBg(bgAt: 'slide' | 'layout' | 'master', clrMap: 'reversed' | 'default') {
    const { parse } = await load('pptxtojson.mjs');
    const buf = buildBgPptx(bgAt, clrMap);
    const json = await parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { imageMode: 'none' });
    return json.slides[0].fill;
}

// counterfactual: phClr を getSolidFill に渡さない旧コードでは 3 変種とも value='' で RED
test('TC-PPV-14a: slide 直指定 bgRef — phClr が clrMap 反転込みで #232F3E に解決', async () => {
    expect(await parseBg('slide', 'reversed')).toEqual({ type: 'color', value: '#232F3E' });
});

test('TC-PPV-14b: layout bgRef 継承（実バグ発覚経路）— #232F3E', async () => {
    expect(await parseBg('layout', 'reversed')).toEqual({ type: 'color', value: '#232F3E' });
});

test('TC-PPV-14c: master bgRef 継承 — #232F3E', async () => {
    expect(await parseBg('master', 'reversed')).toEqual({ type: 'color', value: '#232F3E' });
});

test('TC-PPV-14d: 既定 clrMap（bg2→lt2）は白のまま — 過剰修正の番人', async () => {
    expect(await parseBg('layout', 'default')).toEqual({ type: 'color', value: '#FFFFFF' });
});
