/**
 * viewer-pptx-text-overflow.spec.ts — テキストを枠で切らない（PowerPoint と同じく、はみ出した分も描く）
 * sprint 20261002-140024-pptx-image-background-render TASK-03
 *
 * TC-PBG-08: 1 行分の高さの枠（anchor=t）に 2 行 → 2 行目が切れずに見える（elementFromPoint で実測）
 * TC-PBG-09: anchor=ctr は上下へ / anchor=b は上へはみ出す
 * TC-PBG-10: normAutofit の箱が ctr / b で溢れても縮小されて収まる（上方向の溢れも測る）
 * TC-PBG-11: スライドの外は従来どおり切る（.ppv-slide の overflow:hidden）
 * 番人（mutation で実測）: .ppv-text を overflow:hidden に戻すと TC-PBG-08/09 が / 段落の flex-shrink:0 を外すと
 *   TC-PBG-08/09/10 と TC-PPV-20 が / autofit の溢れ判定を scrollHeight に戻すと TC-PBG-10 が落ちる
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const FIX = path.join(__dirname, '..', 'html', 'viewer-fixtures');
const NS = {
    p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};

function storedZip(entries: Array<[string, string]>): Buffer {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
    for (const [name, text] of entries) {
        const nameBuf = Buffer.from(name); const data = Buffer.from(text);
        const loc = Buffer.alloc(30);
        loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22);
        loc.writeUInt16LE(nameBuf.length, 26);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
        locals.push(loc, nameBuf, data); centrals.push(cen, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

const THEME = `<?xml version="1.0"?>
<a:theme xmlns:a="${NS.a}" name="O"><a:themeElements><a:clrScheme name="O">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="O"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="游ゴシック Light"/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="游ゴシック"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="O"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

// 段落を lines 個（1 段落 = 1 行。折り返しに頼らない = フォント差の影響を受けない）
function box(id: number, x: number, y: number, cy: number, anchor: string, autofit: string, lines: number, sz: number): string {
    const ps = Array.from({ length: lines }, (_, i) =>
        `<a:p><a:r><a:rPr lang="en" sz="${sz}"/><a:t>L${i + 1}</a:t></a:r></a:p>`).join('');
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="b${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="2743200" cy="${cy}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr wrap="square" anchor="${anchor}">${autofit}</a:bodyPr>${ps}</p:txBody></p:sp>`;
}

function slideXml(body: string): string {
    return `<?xml version="1.0"?>
<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${body}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function buildDeck(slides: string[]): Buffer {
    const emptyTree = `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>`;
    const rel = (t: string, target: string) => `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}" Target="${target}"/></Relationships>`;
    const entries: Array<[string, string]> = [
        ['[Content_Types].xml', `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n')}</Types>`],
        ['ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
        ['ppt/_rels/presentation.xml.rels', rel('theme', 'theme/theme1.xml')],
        ['ppt/theme/theme1.xml', THEME],
        ['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`],
        ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rel('theme', '../theme/theme1.xml')],
        ['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
        ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rel('slideMaster', '../slideMasters/slideMaster1.xml')],
    ];
    slides.forEach((s, i) => {
        entries.push([`ppt/slides/slide${i + 1}.xml`, s]);
        entries.push([`ppt/slides/_rels/slide${i + 1}.xml.rels`, rel('slideLayout', '../slideLayouts/slideLayout1.xml')]);
    });
    return storedZip(entries);
}

// 1 行分の高さ（40pt の文字に 48pt の枠）に 2 行
const ONE_LINE = 609600;     // 48pt
const SLIDE1 = slideXml([
    box(2, 457200, 2743200, ONE_LINE, 't', '<a:noAutofit/>', 2, 4000),
    box(3, 4572000, 2743200, ONE_LINE, 'ctr', '<a:noAutofit/>', 3, 4000),
    box(4, 8686800, 2743200, ONE_LINE, 'b', '<a:noAutofit/>', 2, 4000),
    // スライドの右端を越える箱（TC-PBG-11）
    box(5, 11277600, 457200, ONE_LINE, 't', '<a:noAutofit/>', 1, 4000),
].join('\n'));
// normAutofit の箱（1 インチの高さに 32pt × 4 行）を ctr / b で
const SLIDE2 = slideXml([
    box(6, 457200, 2743200, 914400, 'ctr', '<a:normAutofit/>', 4, 3200),
    box(7, 4572000, 2743200, 914400, 'b', '<a:normAutofit/>', 4, 3200),
].join('\n'));

async function openDeck(page: any, name: string, slides: string[]) {
    fs.writeFileSync(path.join(FIX, name), buildDeck(slides));
    await page.goto('/standalone-viewer.html');
    await page.evaluate((n: string) => (window as any).__fileViewer.open(
        'pptx', `./viewer-fixtures/${n}`, document.getElementById('viewer-root')), name);
    await page.waitForSelector('.ppv-slide .ppv-text', { timeout: 15000 });
    await page.waitForTimeout(300);
}

// 各 .ppv-text の枠と、先頭段落の上端・最終段落の下端（いずれも viewport 座標）
const measure = () => Array.from(document.querySelectorAll('.ppv-text')).map((tb: any) => {
    const r = tb.getBoundingClientRect();
    const ps = tb.querySelectorAll('p');
    const first = ps[0].getBoundingClientRect(); const last = ps[ps.length - 1].getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, firstTop: first.top, lastBottom: last.bottom,
        lastMidX: (last.left + last.right) / 2, lastMidY: (last.top + last.bottom) / 2,
        fs: (tb.querySelector('span') || {}).style?.fontSize || null };
});

test('TC-PBG-08: 1 行分の枠に 2 行 — 2 行目が切れずに見える（anchor=t は下へはみ出す）', async ({ page }) => {
    await openDeck(page, 'overflow1.pptx', [SLIDE1]);
    const m = await page.evaluate(measure);
    const t = m[0];
    expect(t.lastBottom, '2 行目は枠の下にはみ出している（前提）').toBeGreaterThan(t.bottom + 5);
    expect(Math.abs(t.firstTop - t.top), 'anchor=t: 先頭行は枠の上端から').toBeLessThan(2);
    // 2 行目の中心を実際にヒットテストする（枠で切られていればテキストに当たらない）
    const hit = await page.evaluate(([x, y]: number[]) => {
        const el = document.elementFromPoint(x, y);
        return el ? (el.textContent || '') : '';
    }, [t.lastMidX, t.lastMidY]);
    expect(hit, '2 行目が描画されている（枠で切られない）').toBe('L2');
});

test('TC-PBG-09: anchor=ctr は上下へ・anchor=b は上へはみ出す', async ({ page }) => {
    await openDeck(page, 'overflow1.pptx', [SLIDE1]);
    const m = await page.evaluate(measure);
    const ctr = m[1]; const b = m[2];
    expect(ctr.firstTop, 'ctr: 上へはみ出す').toBeLessThan(ctr.top - 5);
    expect(ctr.lastBottom, 'ctr: 下へはみ出す').toBeGreaterThan(ctr.bottom + 5);
    expect(Math.abs(b.lastBottom - b.bottom), 'b: 最終行は枠の下端に揃う').toBeLessThan(2);
    expect(b.firstTop, 'b: 上へはみ出す').toBeLessThan(b.top - 5);
    for (const i of [1, 2]) {
        const hit = await page.evaluate(([x, y]: number[]) => (document.elementFromPoint(x, y) || {} as any).textContent || '',
            [m[i].lastMidX, m[i].lastMidY]);
        expect(hit, `箱 ${i} の最終行が描画されている`).toMatch(/^L\d$/);
    }
    // 上へはみ出した先頭行も描画されている
    const firstHit = await page.evaluate(() => {
        const p = document.querySelectorAll('.ppv-text')[2].querySelector('p')!.getBoundingClientRect();
        return (document.elementFromPoint((p.left + p.right) / 2, (p.top + p.bottom) / 2) || {} as any).textContent || '';
    });
    expect(firstHit, 'b: 上へはみ出した先頭行が描画されている').toBe('L1');
});

test('TC-PBG-10: normAutofit の箱が ctr / b で溢れても縮小されて収まる', async ({ page }) => {
    await openDeck(page, 'overflow2.pptx', [SLIDE2]);
    const m = await page.evaluate(measure);
    for (const [i, name] of [[0, 'ctr'], [1, 'b']] as Array<[number, string]>) {
        expect(parseFloat(m[i].fs!), `${name}: 32pt から縮小される`).toBeLessThan(32);
        expect(m[i].firstTop, `${name}: 上へ溢れていない`).toBeGreaterThanOrEqual(m[i].top - 1);
        expect(m[i].lastBottom, `${name}: 下へ溢れていない`).toBeLessThanOrEqual(m[i].bottom + 1);
    }
});

test('TC-PBG-11: スライドの外は従来どおり切る', async ({ page }) => {
    await openDeck(page, 'overflow1.pptx', [SLIDE1]);
    const res = await page.evaluate(() => {
        const slide = document.querySelector('.ppv-slide') as HTMLElement;
        const r = slide.getBoundingClientRect();
        const el = document.elementFromPoint(r.right + 20, r.top + 70);
        return { overflow: getComputedStyle(slide).overflow, outsideIsText: !!(el && el.closest('.ppv-text')) };
    });
    expect(res.overflow).toBe('hidden');
    expect(res.outsideIsText, 'スライドの右外にテキストが描かれていない').toBe(false);
});
