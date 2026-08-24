/**
 * viewer-docx.spec.ts — docx viewer レンダラ（TC-DXV-01/05/09/10/12/14）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-15。
 * fixture = spec 内合成の最小 docx（表結合・page break・ルビ・画像・EMF・XSS 文字 —
 * 実文書 fixture は TASK-17 の sample.docx が別途担保）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { storedZip } from '../utils/stored-zip';
import { extractDocText, ExtractedLine } from '../../src/shared/doc-text-extract';

const FIX = path.join(__dirname, '..', 'html', 'viewer-fixtures');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAcT9GO0U4BxoAAAAAElFTkSuQmCC', 'base64');

const DOCUMENT_XML = `<?xml version="1.0"?>
<w:document ${W} xmlns:r="${REL}"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>見出しテキスト</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">本文 a&lt;b&gt;c &amp; エスケープ確認</w:t></w:r></w:p>
<w:p><w:r><w:ruby><w:rt><w:r><w:t>とうきょう</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>東京</w:t></w:r></w:rubyBase></w:ruby><w:t>に行く</w:t></w:r></w:p>
<w:tbl>
  <w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr>
  <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
  <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>結合セルA</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>縦結合B</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>C1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>
  <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r>
<w:r><w:drawing><wp:inline><wp:extent cx="457200" cy="457200"/>
  <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId11"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r>
<w:r><w:drawing><wp:anchor><wp:extent cx="914400" cy="457200"/><wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>
  <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId12"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
</wp:anchor></w:drawing></w:r></w:p>
<w:p><w:r><w:t>1 ページ目の末尾</w:t><w:br w:type="page"/><w:t>2 ページ目の先頭</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1134" w:right="1134" w:top="1134" w:bottom="1134"/></w:sectPr>
</w:body></w:document>`;

const STYLES_XML = `<?xml version="1.0"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="2F5496"/></w:rPr></w:style>
</w:styles>`;

function buildDocx(documentXml: string): Buffer {
    return storedZip([
        ['_rels/.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`],
        ['word/document.xml', documentXml],
        ['word/_rels/document.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rId10" Type="${REL}/image" Target="media/image1.png"/>
<Relationship Id="rId11" Type="${REL}/image" Target="media/image2.emf"/>
<Relationship Id="rId12" Type="${REL}/image" Target="media/image3.png"/></Relationships>`],
        ['word/styles.xml', STYLES_XML],
        ['word/media/image1.png', PNG],
        ['word/media/image2.emf', Buffer.from('not-a-real-emf')],
        ['word/media/image3.png', PNG],
    ]);
}

test.beforeAll(() => {
    fs.mkdirSync(FIX, { recursive: true });
    fs.writeFileSync(path.join(FIX, 'doc.docx'), buildDocx(DOCUMENT_XML));
    const vertical = DOCUMENT_XML.replace('<w:sectPr><w:pgSz',
        '<w:sectPr><w:textDirection w:val="tbRl"/><w:pgSz');
    fs.writeFileSync(path.join(FIX, 'vertical.docx'), buildDocx(vertical));
});

async function openDocx(page: any, file = 'doc.docx', opts?: Record<string, unknown>) {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(([f, o]: [string, any]) => (window as any).__fileViewer.open(
        'docx', `./viewer-fixtures/${f}`, document.getElementById('viewer-root'), `/tmp/${f}`, o || undefined),
        [file, opts || null] as [string, any]);
    await page.waitForSelector('.dxv-page', { timeout: 20000 });
}

test('TC-DXV-01: 文字を落とさない — 抽出正典の全行が描画テキストに出現 + XSS 非要素化 + 見出しスタイル', async ({ page }) => {
    await openDocx(page);
    const rendered = await page.evaluate(() => ({
        text: (document.querySelector('.dxv-root') as HTMLElement).textContent,
        injectedTags: document.querySelectorAll('.dxv-root b, .dxv-root img[onerror]').length,
        headingSpan: (() => {
            const s = document.querySelector('.dxv-page p span') as HTMLElement;
            return { weight: s.style.fontWeight, size: s.style.fontSize, color: s.style.color };
        })(),
    }));
    // 抽出正典（doc-text-extract）との照合（FR-DXV-01 の番人）
    const canonical = await extractDocText(fs.readFileSync(path.join(FIX, 'doc.docx')), '.docx');
    expect(canonical.skipReason).toBeFalsy();
    // 「文字を 1 文字も落とさない」番人 — 文字頻度の包含比較（順序非依存: ruby は正典が
    // rt→base の文書順・描画は base→rt の DOM 順になる正当な順序差があるため）
    const freq = (s: string) => {
        const m = new Map<string, number>();
        for (const ch of s.replace(/\s+/g, '')) { m.set(ch, (m.get(ch) || 0) + 1); }
        return m;
    };
    const renderedFreq = freq(rendered.text || '');
    for (const line of (canonical.lines as ExtractedLine[])) {
        for (const [ch, n] of freq(line.text)) {
            expect(renderedFreq.get(ch) || 0, `文字「${ch}」が欠落（正典 ${n} 個）`).toBeGreaterThanOrEqual(n);
        }
    }
    expect(rendered.text).toContain('a<b>c & エスケープ確認'); // textContent 生存
    expect(rendered.injectedTags).toBe(0);
    // Heading1: bold + 18pt(36 half) + 色
    expect(rendered.headingSpan.weight).toBe('bold');
    expect(rendered.headingSpan.size).toBe('18pt');
    expect(rendered.headingSpan.color).toBe('rgb(47, 84, 150)');
});

test('TC-DXV-05: 表 — gridSpan → colspan / vMerge restart-continue → rowspan（列位置追跡）', async ({ page }) => {
    await openDocx(page);
    const tbl = await page.evaluate(() => {
        const t = document.querySelector('.dxv-page table')!;
        const cells = Array.from(t.querySelectorAll('td')).map((td) => ({
            colspan: td.colSpan, rowspan: td.rowSpan, text: (td.textContent || '').trim(),
        }));
        return { rows: t.querySelectorAll('tr').length, cells };
    });
    expect(tbl.rows).toBe(2);
    const a = tbl.cells.find((c: any) => c.text === '結合セルA')!;
    expect(a.colspan).toBe(2);
    const b = tbl.cells.find((c: any) => c.text === '縦結合B')!;
    expect(b.rowspan).toBe(2);
    // 被覆セル（vMerge continue）は出力されない
    expect(tbl.cells.length).toBe(4);
});

test('TC-DXV-09: 画像 — inline blob（EMU→px）/ EMF プレースホルダ / anchor align=right float', async ({ page }) => {
    await openDocx(page);
    await page.waitForFunction(() => {
        const imgs = document.querySelectorAll('.dxv-page img');
        return imgs.length >= 2 && Array.from(imgs).every((i) => (i as HTMLImageElement).src.startsWith('blob:'));
    }, null, { timeout: 10000 });
    const res = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('.dxv-page img')) as HTMLImageElement[];
        const ph = document.querySelector('.dxv-unsupported-img') as HTMLElement;
        return {
            inlineW: imgs[0].style.width,                         // 914400 EMU = 96px
            floatRight: imgs.some((i) => i.style.float === 'right'),
            phText: ph ? ph.textContent : null,
        };
    });
    expect(res.inlineW).toBe('96px');
    expect(res.floatRight).toBe(true);
    expect(res.phText).toContain('Image format not supported');   // EMF 縮退
});

test('TC-DXV-10: 紙面幅カード — pgSz 幅一致・明示 page break で 2 カード・近似注記・狭幅 scale', async ({ page }) => {
    await openDocx(page);
    const res = await page.evaluate(() => {
        const pages = document.querySelectorAll('.dxv-page');
        return {
            count: pages.length,
            width: (pages[0] as HTMLElement).style.width,   // 11906 dxa → 793.7px
            note: (document.querySelector('.dxv-note') as HTMLElement).textContent,
            page2Text: (pages[1] as HTMLElement).textContent,
        };
    });
    expect(res.count).toBe(2);                       // 明示 page break のみで分割
    expect(parseFloat(res.width)).toBeCloseTo(11906 / 20 * (4 / 3), 0);
    expect(res.note).toContain('Approximate layout');
    expect(res.page2Text).toContain('2 ページ目の先頭');
    expect(res.page2Text).not.toContain('1 ページ目の末尾');
    // 狭幅 mount → transform scale
    await page.evaluate(() => {
        const root = document.getElementById('viewer-root') as HTMLElement;
        root.style.width = '400px';
    });
    await page.waitForFunction(() =>
        ((document.querySelector('.dxv-page') as HTMLElement).style.transform || '').includes('scale'));
});

test('TC-DXV-12: find — n/total・↑↓・原状復帰・findQuery one-shot（再 find で再ジャンプしない）', async ({ page }) => {
    await openDocx(page, 'doc.docx', { findQuery: 'ページ目' });
    await page.waitForSelector('.fv-find-current');
    let count = await page.evaluate(() => (document.querySelector('.viewer-find-count') as HTMLElement).textContent);
    expect(count).toBe('1/2');
    await page.evaluate(() => (document.querySelector('.viewer-find-next') as HTMLElement).click());
    count = await page.evaluate(() => (document.querySelector('.viewer-find-count') as HTMLElement).textContent);
    expect(count).toBe('2/2');
    // one-shot counterfactual: 手動で別語 find → 元 query に引き戻されない
    await page.evaluate(() => {
        const input = document.querySelector('.viewer-find-bar input') as HTMLInputElement;
        input.value = '東京';
        input.dispatchEvent(new Event('input'));
    });
    await page.waitForFunction(() =>
        ((document.querySelector('.viewer-find-count') as HTMLElement).textContent || '') === '1/1');
    // Esc → span unwrap 原状復帰（ハイライト残骸ゼロ）
    await page.focus('.viewer-find-bar input');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.fv-find-hit').length === 0);
});

test('TC-DXV-14: ルビ <ruby><rt> + 縦書き警告バナー', async ({ page }) => {
    await openDocx(page);
    const ruby = await page.evaluate(() => {
        const r = document.querySelector('.dxv-page ruby');
        return r ? { base: r.textContent, rt: r.querySelector('rt')!.textContent } : null;
    });
    expect(ruby).toBeTruthy();
    expect(ruby!.base).toContain('東京');
    expect(ruby!.rt).toBe('とうきょう');
    // 横書き文書にバナーは出ない
    expect(await page.evaluate(() => document.querySelector('.dxv-banner'))).toBeNull();
    // 縦書き文書 → 警告バナー + 横書き縮退（描画は成立）
    await openDocx(page, 'vertical.docx');
    const banner = await page.evaluate(() => (document.querySelector('.dxv-banner') as HTMLElement | null)?.textContent);
    expect(banner).toContain('Vertical text shown horizontally');
});
