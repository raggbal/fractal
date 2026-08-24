/**
 * viewer-pptx.spec.ts — pptx viewer レンダラ（TC-PPV-05/06/07/10/11）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-14。
 * fixture = spec 内合成の最小 pptx（12 スライド・preset 図形・縦書き・XSS テキスト —
 * 実文書 fixture は TASK-17 の sample.pptx が別途担保）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const FIX = path.join(__dirname, '..', 'html', 'viewer-fixtures');
const NS = {
    p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};

function storedZip(entries: Array<[string, string | Buffer]>): Buffer {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
    for (const [name, text] of entries) {
        const nameBuf = Buffer.from(name); const data = typeof text === 'string' ? Buffer.from(text) : text;
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

function sp(id: number, text: string, opts: { vert?: string; sz?: number } = {}): string {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="${914400 + id * 100000}"/><a:ext cx="6096000" cy="1143000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr${opts.vert ? ` vert="${opts.vert}"` : ''}/><a:p><a:r><a:rPr lang="ja" sz="${opts.sz || 2400}" b="1"><a:latin typeface="Century"/><a:ea typeface="ＭＳ 明朝"/></a:rPr><a:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function slideXml(i: number): string {
    let extra = '';
    if (i === 1) {
        // preset 図形（ellipse・赤 solidFill・テキストなし）+ XSS テキスト
        extra = `<p:sp><p:nvSpPr><p:cNvPr id="90" name="e"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="7000000" y="1000000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm>
<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>
<p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>` + sp(91, 'a<b>c&d <img onerror=x>');
    }
    if (i === 2) { extra = sp(92, '縦書きテキスト', { vert: 'vert270' }); }
    if (i === 3) {
        // p:pic（実画像 — TC-PPV-13: base64 data URL で <img> 描画される）
        extra = `<p:pic><p:nvPicPr><p:cNvPr id="95" name="pic95"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="1000000" y="3500000"/><a:ext cx="1200000" cy="1200000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    }
    return `<?xml version="1.0"?>
<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${sp(2, `FINDME-${i} slide text`)}${extra}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
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

function buildPptx(slideCount: number): Buffer {
    const entries: Array<[string, string]> = [];
    const overrides = Array.from({ length: slideCount }, (_, k) =>
        `<Override PartName="/ppt/slides/slide${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
    entries.push(['[Content_Types].xml', `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides}</Types>`]);
    entries.push(['ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`]);
    entries.push(['ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`]);
    entries.push(['ppt/theme/theme1.xml', THEME]);
    const emptyTree = `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>`;
    entries.push(['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`]);
    entries.push(['ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`]);
    entries.push(['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`]);
    entries.push(['ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`]);
    const PNG_4x4 = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAcT9GO0U4BxoAAAAAElFTkSuQmCC', 'base64');
    entries.push(['ppt/media/image1.png', PNG_4x4]);
    for (let i = 1; i <= slideCount; i++) {
        entries.push([`ppt/slides/slide${i}.xml`, slideXml(i)]);
        const img = i === 3
            ? `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
            : '';
        entries.push([`ppt/slides/_rels/slide${i}.xml.rels`, `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${img}</Relationships>`]);
    }
    return storedZip(entries);
}

test.beforeAll(() => {
    fs.mkdirSync(FIX, { recursive: true });
    fs.writeFileSync(path.join(FIX, 'deck.pptx'), buildPptx(12));
});

async function openPptx(page: any, opts?: Record<string, unknown>) {
    await page.goto('/standalone-viewer.html');
    await page.evaluate((o: any) => (window as any).__fileViewer.open(
        'pptx', './viewer-fixtures/deck.pptx', document.getElementById('viewer-root'), '/tmp/deck.pptx', o || undefined), opts || null);
    await page.waitForSelector('.ppv-slide', { timeout: 20000 });
}

test('TC-PPV-05: 描画 — スライド実寸・preset 図形 svg path・テーマ EA フォント・XSS テキスト非要素化', async ({ page }) => {
    await openPptx(page);
    const res = await page.evaluate(() => {
        const slides = document.querySelectorAll('.ppv-slide');
        const canvas1 = document.querySelector('.ppv-canvas[data-rendered="1"]') as HTMLElement;
        const paths = Array.from(document.querySelectorAll('.ppv-el svg path')) as SVGPathElement[];
        const ellipse = paths.find((p) => ((p.getAttribute('fill') || '').toUpperCase().includes('FF0000'))) || paths[0];
        const spans = Array.from(document.querySelectorAll('.ppv-text span')).map((s) => ({
            text: (s as HTMLElement).textContent, font: (s as HTMLElement).style.fontFamily,
        }));
        return {
            count: slides.length,
            canvasW: canvas1 ? canvas1.style.width : null,   // 12192000 EMU = 960pt = 1280px
            hasPath: !!ellipse && (ellipse.getAttribute('d') || '').length > 10,
            pathFill: ellipse ? ellipse.getAttribute('fill') : null,
            spans,
            injected: document.querySelector('.ppv-text img') !== null,   // XSS counterfactual
            pwned: (window as any).x !== undefined,
        };
    });
    expect(res.count).toBe(12);
    expect(res.canvasW).toBe('1280px');
    expect(res.hasPath).toBe(true);
    expect((res.pathFill || '').toUpperCase()).toContain('FF0000');
    const xss = res.spans.find((s: any) => (s.text || '').includes('a<b>c&d'));
    expect(xss, 'XSS テキストが textContent として生存').toBeTruthy();
    expect(res.injected).toBe(false);   // <img onerror> が要素化されていない
    expect(res.pwned).toBe(false);
    const ea = res.spans.find((s: any) => (s.font || '').includes('ＭＳ 明朝'));
    expect(ea, 'EA フォントスタックが style に出る').toBeTruthy();
});

test('TC-PPV-06: windowed — 初回実描画は可視 + バッファのみ・スクロールで描画', async ({ page }) => {
    await openPptx(page);
    await page.waitForFunction(() => document.querySelectorAll('.ppv-canvas[data-rendered="1"]').length > 0);
    const initial = await page.evaluate(() => document.querySelectorAll('.ppv-canvas[data-rendered="1"]').length);
    expect(initial).toBeLessThan(12); // 構造 assert（全 12 枚を先行描画しない）
    // 末尾へスクロール → 追加描画
    await page.evaluate(() => {
        const els = document.querySelectorAll('.ppv-slide');
        els[els.length - 1].scrollIntoView();
    });
    await page.waitForFunction(() => {
        const last = document.querySelectorAll('.ppv-canvas')[11] as HTMLElement;
        return last.dataset.rendered === '1';
    });
});

test('TC-PPV-10: locHint slide 着地 + findQuery + one-shot', async ({ page }) => {
    await openPptx(page, { locHint: 'slide 5', findQuery: 'FINDME-5' });
    await page.waitForSelector('.fv-find-current', { timeout: 15000 });
    const res = await page.evaluate(() => ({
        count: (document.querySelector('.viewer-find-count') as HTMLElement).textContent,
        slide5Rendered: (document.querySelectorAll('.ppv-canvas')[4] as HTMLElement).dataset.rendered,
        currentText: (document.querySelector('.fv-find-current') as HTMLElement).textContent,
    }));
    expect(res.slide5Rendered).toBe('1');   // 先行描画
    expect(res.count).toBe('1/1');
    expect(res.currentText).toContain('FINDME-5');
    // one-shot: 消費後に別語を find → hint に引き戻されず新ヒットへ
    await page.evaluate(() => {
        const input = document.querySelector('.viewer-find-bar input') as HTMLInputElement;
        input.value = 'FINDME-1';
        input.dispatchEvent(new Event('input'));
    });
    await page.waitForFunction(() =>
        ((document.querySelector('.fv-find-current') as HTMLElement | null)?.textContent || '').includes('FINDME-1'));
});

test('TC-PPV-07/11: shape 失敗分離 + 縮退プレースホルダ 4 種（renderer 単体・jsdom）', async () => {
    const dom = new JSDOM('<div id="s"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const { renderSlideContent } = await import(/* webpackIgnore: true */
        path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx', 'render.mjs'));
    const label = (_k: string, fb: string) => fb;
    const poison: any = { type: 'shape', left: 0, top: 0, width: 10, height: 10 };
    Object.defineProperty(poison, 'path', { get() { throw new Error('poisoned'); } });
    const slide = {
        fill: '#FFFFFF',
        elements: [
            poison,
            { type: 'text', left: 0, top: 20, width: 100, height: 10, content: { paragraphs: [{ css: '', runs: [{ text: 'alive', css: '' }] }] } },
            { type: 'chart', left: 0, top: 40, width: 50, height: 20 },
            { type: 'diagram', left: 0, top: 70, width: 50, height: 20 },
            { type: 'math', left: 0, top: 100, width: 50, height: 20 },
            { type: 'image', left: 0, top: 130, width: 50, height: 20, src: 'emf-not-renderable' },
        ],
    };
    const host = doc.getElementById('s')!;
    renderSlideContent(doc, host, slide, { label });
    // 失敗分離: poisoned shape は error-box・後続要素は生存
    expect(host.querySelectorAll('.ppv-error-box').length).toBe(1);
    expect(host.textContent).toContain('alive');
    // 縮退プレースホルダ 4 種（i18n 文言）
    const phs = Array.from(host.querySelectorAll('.ppv-placeholder')).map((e) => e.textContent);
    expect(phs).toContain('Chart (not rendered)');
    expect(phs).toContain('SmartArt (not rendered)');
    expect(phs).toContain('[equation]');
    expect(phs).toContain('Image format not supported');
    // 縦書き class（renderer 単体 — writing-mode は実 Chromium 側 TC-PPV-05 の deck で担保）
    const host2 = doc.createElement('div');
    renderSlideContent(doc, host2, {
        fill: null,
        elements: [{ type: 'text', left: 0, top: 0, width: 10, height: 10, vert: 'vert270', content: { paragraphs: [{ css: '', runs: [{ text: 'v', css: '' }] }] } }],
    }, { label });
    expect(host2.querySelector('.ppv-text.ppv-vert270')).toBeTruthy();
});

test('TC-PPV-16: 描画不能 mime（EMF 実データ）は placeholder — png は img（renderer 単体・jsdom）', async () => {
    // 再オープン③ TASK-23: iteration 3 追補（el.base64 採用）で data:image/x-emf が壊れ <img> になる退行の番人。
    // 既存 TC-PPV-11 の EMF fixture はデータ無し経路（src 非 data:）のため本退行を検出できなかった —
    // 実データ入り（data:image/x-emf;base64,）経路を pin する。
    const dom = new JSDOM('<div id="s"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const { renderSlideContent } = await import(/* webpackIgnore: true */
        path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx', 'render.mjs'));
    const label = (_k: string, fb: string) => fb;
    const slide = {
        fill: '#FFFFFF',
        elements: [
            { type: 'image', left: 0, top: 0, width: 50, height: 20, base64: 'data:image/x-emf;base64,AQAAAGwAAAAA' },
            { type: 'image', left: 0, top: 30, width: 50, height: 20, base64: 'data:image/x-wmf;base64,AQAAAGwAAAAA' },
            { type: 'image', left: 0, top: 60, width: 50, height: 20, base64: 'data:image/tiff;base64,SUkqAAgAAAA=' },
            { type: 'image', left: 0, top: 90, width: 50, height: 20, base64: 'data:image/png;base64,iVBORw0KGgo=' },
        ],
    };
    const host = doc.getElementById('s')!;
    renderSlideContent(doc, host, slide, { label });
    // counterfactual: 現行は emf/wmf/tiff も <img> 化（壊れアイコン）= RED
    const phs = Array.from(host.querySelectorAll('.ppv-placeholder')).map((e) => e.textContent);
    expect(phs.filter((t) => t === 'Image format not supported').length, 'emf/wmf/tiff の 3 件が placeholder').toBe(3);
    const imgs = Array.from(host.querySelectorAll('img')).map((i: any) => i.src.slice(0, 15));
    expect(imgs, 'png だけが img（過剰修正番人）').toEqual(['data:image/png;']);
});

test('TC-PPV-19: ベクタ EMF は SVG 実描画・変換不能 EMF は placeholder（renderer 単体・jsdom）', async () => {
    // 再オープン④ TASK-27: EMF data URL をエンジン（viewer-common/emf.mjs）で SVG 化して <img> 表示。
    // 変換不能（garbage）は従来どおり placeholder（TC-PPV-16 の縮退契約と整合）。
    const dom = new JSDOM('<div id="s"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const { renderSlideContent } = await import(/* webpackIgnore: true */
        path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx', 'render.mjs'));
    const label = (_k: string, fb: string) => fb;
    // 最小の有効ベクタ EMF を合成（viewer-emf.spec.ts と同レイアウト）
    const rec = (t: number, body: number[]) => {
        const size = 8 + body.length * 4;
        const b = new Uint8Array(size); const dv = new DataView(b.buffer);
        dv.setUint32(0, t, true); dv.setUint32(4, size, true);
        body.forEach((v, i) => dv.setInt32(8 + i * 4, v, true));
        return b;
    };
    const header = new Uint8Array(108); {
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 1, true); dv.setUint32(4, 108, true);
        dv.setInt32(16, 99, true); dv.setInt32(20, 99, true);
        dv.setUint32(40, 0x464d4520, true);
    }
    const parts = [header,
        rec(9, [100, 100]), rec(10, [0, 0]),
        rec(39, [1, 0, 0x0000FF00, 0]), rec(37, [1]),
        rec(59, []), rec(27, [10, 10]), rec(54, [90, 10]), rec(54, [50, 90]), rec(61, []), rec(60, []), rec(62, [0, 0, 0, 0]),
        rec(14, [0, 0, 5])];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const emfBytes = new Uint8Array(total); let off = 0;
    for (const p of parts) { emfBytes.set(p, off); off += p.length; }
    const b64 = Buffer.from(emfBytes).toString('base64');
    const slide = {
        fill: '#FFFFFF',
        elements: [
            { type: 'image', left: 0, top: 0, width: 50, height: 20, base64: `data:image/x-emf;base64,${b64}` },
            { type: 'image', left: 0, top: 30, width: 50, height: 20, base64: 'data:image/x-emf;base64,AQAAAGwAAAAA' },
        ],
    };
    const host = doc.getElementById('s')!;
    renderSlideContent(doc, host, slide, { label });
    // counterfactual: 現行はベクタ EMF も placeholder = RED
    const imgs = Array.from(host.querySelectorAll('img')).map((i: any) => String(i.src).slice(0, 26));
    expect(imgs, 'ベクタ EMF が SVG data URL の img に').toEqual(['data:image/svg+xml;base64,']);
    const phs = Array.from(host.querySelectorAll('.ppv-placeholder')).map((e) => e.textContent);
    expect(phs.filter((t) => t === 'Image format not supported').length, '変換不能 EMF は placeholder のまま').toBe(1);
});

test('TC-PPV-18: normAutofit（fontScale/lnSpcReduction）の描画適用（renderer 単体・jsdom）', async () => {
    // 再オープン③ TASK-25: PowerPoint が保存した自動縮小結果（normAutofit attrs）をレンダラが消費する番人。
    const dom = new JSDOM('<div id="s"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const { renderSlideContent } = await import(/* webpackIgnore: true */
        path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx', 'render.mjs'));
    const label = (_k: string, fb: string) => fb;
    const para = () => ({ css: 'line-height: 1.2;', runs: [{ text: 'fit', css: 'font-size: 32pt;color: #000000;' }] });
    const slide = {
        fill: '#FFFFFF',
        elements: [
            { type: 'text', left: 0, top: 0, width: 100, height: 20,
              autoFit: { type: 'text', fontScale: 50, lnSpcReduction: 20 },
              content: { paragraphs: [para()] } },
            { type: 'text', left: 0, top: 30, width: 100, height: 20,
              content: { paragraphs: [para()] } },
        ],
    };
    const host = doc.getElementById('s')!;
    renderSlideContent(doc, host, slide, { label });
    const texts = host.querySelectorAll('.ppv-text');
    const span0 = texts[0].querySelector('span') as HTMLElement;
    const p0 = texts[0].querySelector('p') as HTMLElement;
    // counterfactual: 未適用の現行は 32pt のまま = RED
    expect(span0.style.fontSize, 'fontScale=50 → 32pt×0.5').toBe('16pt');
    expect(parseFloat(p0.style.lineHeight), 'lnSpcReduction=20 → 1.2×0.8').toBeCloseTo(0.96, 2);
    // ガード: autoFit 無しの要素は 1 バイトも変わらない（過剰修正番人）
    const span1 = texts[1].querySelector('span') as HTMLElement;
    const p1 = texts[1].querySelector('p') as HTMLElement;
    expect(span1.style.fontSize).toBe('32pt');
    expect(p1.style.lineHeight).toBe('1.2');
});

test('TC-PPV-20: normAutofit 実計算 — 空 normAutofit でも溢れたら段階縮小・noAutofit は不変', async ({ page }) => {
    // 再オープン④ TASK-29: PowerPoint は縮小値未保存（空 <a:normAutofit/>）でも表示時に autofit を
    // 再計算する。viewer も DOM attach 後に高さ超過を実測して段階縮小する（実レイアウト必須 = harness）。
    // 中程度の溢れ（32pt では溢れ・縮小段のどこかで収まる量 — 床 25% でも収まらない量にすると PowerPoint 同様に溢れが残る）
    const LONG = Array.from({ length: 4 }, (_, i) => `Overflowing content ${i} with words`).join(' ');
    const box = (id: number, y: number, autofit: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="b${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="${y}"/><a:ext cx="6096000" cy="914400"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr>${autofit}</a:bodyPr><a:p><a:r><a:rPr lang="en" sz="3200"/><a:t>${LONG}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const slide = `<?xml version="1.0"?>
<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${box(2, 914400, '<a:normAutofit/>')}
${box(3, 3000000, '<a:noAutofit/>')}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    const emptyTree = `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>`;
    const deck = storedZip([
        ['[Content_Types].xml', `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`],
        ['ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
        ['ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`],
        ['ppt/theme/theme1.xml', THEME],
        ['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:sldMaster>`],
        ['ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`],
        ['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}">${emptyTree}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
        ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`],
        ['ppt/slides/slide1.xml', slide],
        ['ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`],
    ]);
    fs.writeFileSync(path.join(FIX, 'autofit.pptx'), deck);
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => (window as any).__fileViewer.open(
        'pptx', './viewer-fixtures/autofit.pptx', document.getElementById('viewer-root')));
    await page.waitForSelector('.ppv-slide .ppv-text', { timeout: 15000 });
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('.ppv-text'));
        return boxes.map((tb: any) => {
            const span = tb.querySelector('span');
            return {
                fs: span ? span.style.fontSize : null,
                overflow: tb.scrollHeight - tb.clientHeight,
            };
        });
    });
    expect(res.length).toBe(2);
    // counterfactual: 現行は 32pt のまま溢れる = RED
    expect(parseFloat(res[0].fs!), 'normAutofit の箱は 32pt から縮小される').toBeLessThan(32);
    expect(res[0].overflow, '縮小後は箱に収まる（+1px 許容）').toBeLessThanOrEqual(1);
    // 不変ガード: noAutofit は縮小しない
    expect(res[1].fs, 'noAutofit は 32pt のまま').toBe('32pt');
});

test('TC-PPV-21: リストマーカー — ol 連番・マーカーの run css 継承・ぶら下げインデント（renderer 単体・jsdom）', async () => {
    // 再オープン④ TASK-30
    const dom = new JSDOM('<div id="s"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const { renderSlideContent } = await import(/* webpackIgnore: true */
        path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx', 'render.mjs'));
    const label = (_k: string, fb: string) => fb;
    const li = (text: string, type: string, css = '') =>
        ({ css, listType: type, listLevel: 0, runs: [{ text, css: 'font-size: 24pt;color: #FFFFFF;' }] });
    const empty = () => ({ css: '', listType: 'ol', listLevel: 0, runs: [{ text: '', css: '' }] });
    const slide = {
        fill: '#232F3E',
        elements: [{
            type: 'text', left: 0, top: 0, width: 400, height: 300,
            content: { paragraphs: [
                li('first', 'ol'),
                empty(),                                   // スペーサー空段落（PowerPoint は番号を振らない・消費しない）
                li('second', 'ol'),
                { css: '', listType: '', listLevel: 0, runs: [{ text: 'plain', css: '' }] },
                li('restarted', 'ol'),
                li('bullet item', 'ul', 'margin-left: 36pt;text-indent: -36pt;'),
            ] },
        }],
    };
    const host = doc.getElementById('s')!;
    renderSlideContent(doc, host, slide, { label });
    const ps = Array.from(host.querySelectorAll('.ppv-text p'));
    const markerOf = (p: any) => (p.querySelector('span.ppv-marker') as HTMLElement);
    const markerText = (p: any) => { const s = markerOf(p); return s ? s.textContent : null; };
    // (a) ol 連番 + 空段落は番号を振らず消費もしない + 非リスト段落でリセット（counterfactual: 現行は「· 」固定 = RED）
    expect(markerText(ps[0])).toBe('1. ');
    expect(markerText(ps[1]), '空のスペーサー段落にはマーカーを出さない').toBeNull();
    expect(markerText(ps[2]), '空段落は番号を消費しない').toBe('2. ');
    expect(markerText(ps[4]), '非リスト段落を挟んだらリセット').toBe('1. ');
    // (b) マーカー span が先頭 run の css を継承（counterfactual: 現行は無スタイル = RED）
    expect(markerOf(ps[0]).style.fontSize).toBe('24pt');
    expect(markerText(ps[5])).toBe('• ');
    expect(markerOf(ps[5]).style.fontSize).toBe('24pt');
    // (c) list 段落の marL/indent（ぶら下げ）が p css に残る
    expect((ps[5] as any).style.marginLeft).toBe('36pt');
    expect((ps[5] as any).style.textIndent).toBe('-36pt');
});

test('TC-PPV-12: zip エラーの友好的変換 — 非 zip .pptx → ローカライズ文言・NOT_ZIP 非露出', async ({ page }) => {
    // reviewer iteration 1 QUAL-1（許可: test_add）: docx/xlsx と同じ viewerProtectedFile 変換の pptx 版番人
    fs.writeFileSync(path.join(FIX, 'not-a-zip.pptx'), 'これは zip ではないただのテキスト');
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => (window as any).__fileViewer.open(
        'pptx', './viewer-fixtures/not-a-zip.pptx', document.getElementById('viewer-root'), '/tmp/not-a-zip.pptx'));
    await page.waitForSelector('.viewer-error');
    const text = await page.evaluate(() => (document.querySelector('.viewer-error') as HTMLElement).textContent || '');
    expect(text).toContain('Password-protected files cannot be displayed'); // label 既定文言（ハーネスは locale 注入なし）
    expect(text).not.toContain('NOT_ZIP');                                  // 生の技術コードを露出しない
});

test('TC-PPV-13: p:pic 画像 — base64 data URL で <img> 描画・placeholder に落ちない（ユーザー報告 2026-08-23）', async ({ page }) => {
    await openPptx(page);
    // slide 3 を可視化（windowed 描画のため scroll で実 DOM 化）
    await page.evaluate(() => {
        const slides = document.querySelectorAll('.ppv-slide');
        (slides[2] as HTMLElement).scrollIntoView({ block: 'start' });
    });
    await page.waitForFunction(() => {
        const s3 = document.querySelectorAll('.ppv-slide')[2];
        return !!(s3 && s3.querySelector('img'));
    }, null, { timeout: 10000 });
    const res = await page.evaluate(() => {
        const s3 = document.querySelectorAll('.ppv-slide')[2];
        const img = s3.querySelector('img') as HTMLImageElement;
        return {
            src: img.src.slice(0, 22),
            phText: (s3.textContent || ''),
        };
    });
    expect(res.src).toBe('data:image/png;base64,');
    expect(res.phText).not.toContain('Image format not supported');
});
