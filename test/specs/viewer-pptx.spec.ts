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
