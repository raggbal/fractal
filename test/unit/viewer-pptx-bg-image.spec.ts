/**
 * viewer-pptx-bg-image.spec.ts — 画像背景（p:bg/p:bgPr/a:blipFill）を描画まで通す
 * sprint 20261002-140024-pptx-image-background-render（TC-PBG-01〜07）
 *
 * 実バグ: パーサ fill.mjs getBgPicFill は背景画像を { ref, base64, blob, opacity } で返すが、
 * render.mjs normFill は図形 picFill 用の fill.value.picBase64 を読んでいたため、画像背景が
 * 1 枚も描画されなかった（レイアウト・マスターが画像背景で文字が白いスライドは真っ白に見える）。
 * 既存 viewer-pptx-bg.spec.ts は bgRef（単色）だけでパーサ出力しか見ておらず、描画の継ぎ目を踏んでいなかった。
 *
 * 番人: normFill の画像分岐を picBase64 読みに戻すと TC-PBG-01〜03 / 05 / 07 が落ちる。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const DIR = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx');
let dom: JSDOM;
async function load(name: string) {
    dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
    (global as any).DOMParser = dom.window.DOMParser;
    (global as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
    return import(/* webpackIgnore: true */ path.join(DIR, name));
}

function storedZip(entries: Array<[string, string | Buffer]>): Buffer {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name);
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
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
const NS_R = REL;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** 画像背景を bgAt の階層に置いた最小 pptx。alpha を渡すと a:alphaModFix を付ける */
function buildImageBgPptx(bgAt: 'slide' | 'layout' | 'master', alpha?: number): Buffer {
    const theme = `<?xml version="1.0"?>
<a:theme xmlns:a="${NS_A}" name="S"><a:themeElements><a:clrScheme name="S">
<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
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
    const blip = alpha !== undefined ? `<a:blip r:embed="rIdImg"><a:alphaModFix amt="${alpha}"/></a:blip>` : '<a:blip r:embed="rIdImg"/>';
    const BG = `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1">${blip}<a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
    const tree = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';
    const cSld = (bg: boolean) => `<p:cSld>${bg ? BG : ''}${tree}</p:cSld>`;
    const imgRel = (on: boolean) => on ? `<Relationship Id="rIdImg" Type="${REL}/image" Target="../media/image1.png"/>` : '';
    const entries: Array<[string, string | Buffer]> = [
        ['[Content_Types].xml', `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`],
        ['ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
        ['ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/theme" Target="theme/theme1.xml"/></Relationships>`],
        ['ppt/theme/theme1.xml', theme],
        ['ppt/media/image1.png', PNG],
        ['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${cSld(bgAt === 'master')}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`],
        ['ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/>${imgRel(bgAt === 'master')}</Relationships>`],
        ['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${cSld(bgAt === 'layout')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
        ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>${imgRel(bgAt === 'layout')}</Relationships>`],
        ['ppt/slides/slide1.xml', `<?xml version="1.0"?>
<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${cSld(bgAt === 'slide')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`],
        ['ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${imgRel(bgAt === 'slide')}</Relationships>`],
    ];
    return storedZip(entries);
}

/** parse（本番と同じ imageMode:'base64'）→ renderSlideContent まで通し、スライド要素を返す */
async function renderFirst(buf: Buffer, idx = 0) {
    const { parse } = await load('pptxtojson.mjs');
    const { renderSlideContent } = await import(/* webpackIgnore: true */ path.join(DIR, 'render.mjs'));
    const json = await parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { imageMode: 'base64' });
    const doc = dom.window.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    renderSlideContent(doc, el, json.slides[idx], {});
    return el;
}
/** 背景画像（スライド要素直付け or 背景レイヤー）の CSS url を取り出す */
function bgUrlOf(el: any): string {
    const layer = el.querySelector('.ppv-bg');
    const v = (layer ? layer.style.backgroundImage : el.style.backgroundImage) || '';
    return v === 'none' ? '' : v;   // background 一括指定で jsdom は backgroundImage を 'none' にする
}

for (const [tc, at] of [['TC-PBG-01', 'slide'], ['TC-PBG-02', 'layout'], ['TC-PBG-03', 'master']] as const) {
    test(`${tc}: ${at} の画像背景が描画される`, async () => {
        const el = await renderFirst(buildImageBgPptx(at));
        expect(bgUrlOf(el), `${at} の画像背景が描画されていない`).toMatch(/^url\("data:image\/png;base64,iVBORw0KGgo/);
    });
}

test('TC-PBG-04: alphaModFix の不透明度は背景画像だけに反映される', async () => {
    const el: any = await renderFirst(buildImageBgPptx('layout', 50000));
    const layer = el.querySelector('.ppv-bg');
    expect(layer, '半透明の背景レイヤーが無い').not.toBeNull();
    expect(layer.style.backgroundImage).toMatch(/^url\("data:image\/png/);
    expect(parseFloat(layer.style.opacity)).toBeCloseTo(0.5, 5);
    expect(el.style.opacity || '1', 'スライド全体を半透明にしている').toBe('1');
});

test('TC-PBG-05: base64 が空で blob URL だけの背景でも描画される', async () => {
    const { renderSlideContent } = await (async () => { await load('pptxtojson.mjs'); return import(/* webpackIgnore: true */ path.join(DIR, 'render.mjs')); })();
    const doc = dom.window.document;
    const el: any = doc.createElement('div');
    renderSlideContent(doc, el, { fill: { type: 'image', value: { ref: 'x', base64: '', blob: 'blob:http://x/1', opacity: 1 } }, elements: [] }, {});
    expect(bgUrlOf(el)).toBe('url("blob:http://x/1")');
});

test('TC-PBG-06: 単色背景は従来どおり background に色（回帰 pin）', async () => {
    const { renderSlideContent } = await (async () => { await load('pptxtojson.mjs'); return import(/* webpackIgnore: true */ path.join(DIR, 'render.mjs')); })();
    const doc = dom.window.document;
    const el: any = doc.createElement('div');
    renderSlideContent(doc, el, { fill: { type: 'color', value: '#161E2D' }, elements: [] }, {});
    expect(el.style.background).toMatch(/rgb\(22, 30, 45\)|#161e2d/i);
    expect(bgUrlOf(el)).toBe('');
});

const REAL = '/Users/imaken/workspace/fractal/pace/files/2026_APJ_PACE_SIFTGuide-1.pptx';
test('TC-PBG-07: 実ファイル 2026_APJ_PACE_SIFTGuide-1.pptx の 1 ページ目に背景画像が出る', async () => {
    test.skip(!fs.existsSync(REAL), '実ファイルが無い環境');
    const el = await renderFirst(fs.readFileSync(REAL));
    expect(bgUrlOf(el), '1 ページ目（レイアウトの画像背景）が描画されていない').toMatch(/^url\("data:image\/png;base64,/);
});
