/**
 * viewer-xlsx.spec.ts — xlsx viewer 統合（仮想グリッド/タブ/数式/locHint/find/付帯 — TC-XLV-09..15）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-16。
 * fixture = spec 内合成の最小 xlsx（10 万行/500 列は疎セルで dimension を張る —
 * 仮想化は「geometry は dimension・内容は rows Map 疎」という設計の検証そのもの）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { storedZip } from '../utils/stored-zip';

const FIX = path.join(__dirname, '..', 'html', 'viewer-fixtures');
const XM = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const SHEET1 = `<?xml version="1.0"?>
<worksheet ${XM} ${RNS}>
<sheetData>
<row r="1">
  <c r="A1" t="s" s="1"><v>0</v></c>
  <c r="C1" s="2"><v>45000</v></c>
  <c r="D1" t="s"><v>2</v></c>
  <c r="SF1" t="s"><v>0</v></c>
</row>
<row r="2">
  <c r="A2"><f>1+1</f><v>2</v></c>
  <c r="B2"><f>SUM(A1:A2)</f></c>
</row>
<row r="3">
  <c r="A3" t="s"><v>1</v></c>
  <c r="B3" t="s"><v>1</v></c>
</row>
<row r="5"><c r="A5" t="s" s="1"><v>3</v></c></row>
<row r="7"><c r="E7" s="3"><v>1</v></c><c r="F7" s="3"><v>2</v></c></row>
<row r="8"><c r="E8" s="3"><v>3</v></c><c r="F8" s="3"><v>4</v></c></row>
<row r="100000"><c r="A100000"><v>99</v></c></row>
</sheetData>
<autoFilter ref="A1:D3"/>
<mergeCells count="1"><mergeCell ref="A5:C6"/></mergeCells>
<hyperlinks><hyperlink ref="D1" r:id="rIdHL"/></hyperlinks>
</worksheet>`;

const SHEET2 = `<?xml version="1.0"?>
<worksheet ${XM}>
<sheetData>
<row r="5"><c r="C5" t="s"><v>1</v></c></row>
</sheetData>
</worksheet>`;

const SHEET_TRIVIAL = `<?xml version="1.0"?>
<worksheet ${XM}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;

const STYLES = `<?xml version="1.0"?>
<styleSheet ${XM}>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/>
<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>
<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom></border></borders>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
</cellXfs>
</styleSheet>`;

const SST = `<?xml version="1.0"?>
<sst ${XM} count="4" uniqueCount="4">
<si><t>hello</t></si><si><t>find検索語end</t></si><si><t>リンク</t></si><si><t>MERGED</t></si>
</sst>`;

const WORKBOOK = `<?xml version="1.0"?>
<workbook ${XM} ${RNS}>
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>
<sheet name="Sheet1" sheetId="1" r:id="rId1"/>
<sheet name="Sheet2" sheetId="2" r:id="rId2"/>
<sheet name="HiddenS" sheetId="3" state="hidden" r:id="rId3"/>
<sheet name="VeryH" sheetId="4" state="veryHidden" r:id="rId4"/>
</sheets>
</workbook>`;

const COMMENTS = `<?xml version="1.0"?>
<comments ${XM}><authors><author>a</author></authors>
<commentList><comment ref="B1" authorId="0"><text><r><t>コメント本文</t></r></text></comment></commentList>
</comments>`;

function buildXlsx(): Buffer {
    return storedZip([
        ['_rels/.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
        ['xl/workbook.xml', WORKBOOK],
        ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="${REL}/worksheet" Target="worksheets/sheet4.xml"/>
<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rIdT" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
        ['xl/worksheets/sheet1.xml', SHEET1],
        ['xl/worksheets/sheet2.xml', SHEET2],
        ['xl/worksheets/sheet3.xml', SHEET_TRIVIAL],
        ['xl/worksheets/sheet4.xml', SHEET_TRIVIAL],
        ['xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0"?>
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rIdHL" Type="${REL}/hyperlink" Target="https://example.com/x" TargetMode="External"/>
<Relationship Id="rIdCm" Type="${REL}/comments" Target="../comments1.xml"/></Relationships>`],
        ['xl/comments1.xml', COMMENTS],
        ['xl/styles.xml', STYLES],
        ['xl/sharedStrings.xml', SST],
    ]);
}

test.beforeAll(() => {
    fs.mkdirSync(FIX, { recursive: true });
    fs.writeFileSync(path.join(FIX, 'grid.xlsx'), buildXlsx());
});

async function openXlsx(page: any, opts?: Record<string, unknown>) {
    await page.goto('/standalone-viewer.html');
    await page.evaluate((o: any) => (window as any).__fileViewer.open(
        'xlsx', './viewer-fixtures/grid.xlsx', document.getElementById('viewer-root'), '/tmp/grid.xlsx', o || undefined),
        opts || null);
    await page.waitForSelector('.xlv-cell', { timeout: 20000 });
}

test('TC-XLV-09: 仮想化 — 初回 DOM ≤ 可視+バッファ・スクロール行差替・固定ヘッダ同期・列仮想化', async ({ page }) => {
    await openXlsx(page);
    const initial = await page.evaluate(() => ({
        cells: document.querySelectorAll('.xlv-cell').length,
        rowHdrs: document.querySelectorAll('.xlv-rowhdr-cell').length,
        spacerH: (document.querySelector('.xlv-spacer') as HTMLElement).offsetHeight,
        spacerW: (document.querySelector('.xlv-spacer') as HTMLElement).offsetWidth,
    }));
    // 10 万行 × 500 列 = 5,000 万セルに対し、描画は可視域 + バッファのみ（構造 assert）
    expect(initial.cells).toBeLessThan(3000);
    expect(initial.rowHdrs).toBeLessThan(300);
    expect(initial.spacerH).toBeGreaterThan(1_000_000);  // 100k 行 × 約 20px
    expect(initial.spacerW).toBeGreaterThan(30_000);     // 500 列 × 約 69px
    // 縦スクロール → 行差替（A100000 の 99 が現れ、先頭行セルは消える）
    await page.evaluate(() => {
        const vp = document.querySelector('.xlv-viewport') as HTMLElement;
        vp.scrollTop = vp.scrollHeight;
        vp.dispatchEvent(new Event('scroll'));
    });
    await page.waitForSelector('.xlv-cell[data-ref="A100000"]');
    const afterV = await page.evaluate(() => ({
        hasTop: !!document.querySelector('.xlv-cell[data-ref="A1"]'),
        bottomText: (document.querySelector('.xlv-cell[data-ref="A100000"]') as HTMLElement).textContent,
        lastRowHdr: Array.from(document.querySelectorAll('.xlv-rowhdr-cell')).map((e) => e.textContent).pop(),
        hdrSync: (() => {
            // CSSOM は大値 px を float32 で再シリアライズ（-1.99936e+06px）するため数値比較
            const vp = document.querySelector('.xlv-viewport') as HTMLElement;
            const inner = document.querySelector('.xlv-rowhdr-inner') as HTMLElement;
            const m = /translateY\((-?[\d.e+]+)px\)/i.exec(inner.style.transform);
            return !!m && Math.abs(parseFloat(m[1]) + vp.scrollTop) < 10;
        })(),
    }));
    expect(afterV.hasTop).toBe(false);
    expect(afterV.bottomText).toBe('99');
    expect(afterV.lastRowHdr).toBe('100000');
    expect(afterV.hdrSync).toBe(true);
    // 横スクロール → 列差替（SF 列が現れる + 列ヘッダ同期）
    await page.evaluate(() => {
        const vp = document.querySelector('.xlv-viewport') as HTMLElement;
        vp.scrollTop = 0;
        vp.scrollLeft = vp.scrollWidth;
        vp.dispatchEvent(new Event('scroll'));
    });
    await page.waitForSelector('.xlv-cell[data-ref="SF1"]');
    const afterH = await page.evaluate(() => ({
        colHdrs: Array.from(document.querySelectorAll('.xlv-colhdr-cell')).map((e) => e.textContent),
        hasA: !!document.querySelector('.xlv-cell[data-ref="A1"]'),
    }));
    expect(afterH.colHdrs).toContain('SF');
    expect(afterH.colHdrs).not.toContain('A');
    expect(afterH.hasA).toBe(false);
});

test('TC-XLV-10: 結合セル — アンカーが結合サイズで描画・被覆セル非描画・塗りはアンカー xf', async ({ page }) => {
    await openXlsx(page);
    const res = await page.evaluate(() => {
        const anchor = document.querySelector('.xlv-cell[data-ref="A5"]') as HTMLElement;
        const single = document.querySelector('.xlv-cell[data-ref="A3"]') as HTMLElement;
        return {
            text: anchor.textContent,
            wide: anchor.offsetWidth > single.offsetWidth * 2.5,   // 3 列ぶん
            tall: anchor.offsetHeight > single.offsetHeight * 1.5, // 2 行ぶん
            bg: anchor.style.backgroundColor,
            covered: document.querySelectorAll('.xlv-cell[data-ref="B5"], .xlv-cell[data-ref="A6"]').length,
        };
    });
    expect(res.text).toBe('MERGED');
    expect(res.wide).toBe(true);
    expect(res.tall).toBe(true);
    expect(res.bg).toBe('rgb(255, 0, 0)');  // solid fill = fgColor（アンカー xf s=1）
    expect(res.covered).toBe(0);
});

test('TC-XLV-11: シートタブ — 順序・hidden 灰色 + title・veryHidden 非表示・active 初期・切替', async ({ page }) => {
    await openXlsx(page);
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.xlv-tab')).map((b) => ({
        name: b.textContent, hidden: b.classList.contains('xlv-tab-hidden'),
        title: (b as HTMLElement).title, active: b.classList.contains('xlv-tab-active'),
    })));
    expect(tabs.map((t: any) => t.name)).toEqual(['Sheet1', 'Sheet2', 'HiddenS']);  // veryHidden は出さない
    expect(tabs[0].active).toBe(true);
    expect(tabs[2].hidden).toBe(true);
    expect(tabs[2].title.length).toBeGreaterThan(0);
    // 切替 → Sheet2 の C5 が描画される
    await page.evaluate(() => (document.querySelectorAll('.xlv-tab')[1] as HTMLElement).click());
    await page.waitForSelector('.xlv-cell[data-ref="C5"]');
    const c5 = await page.evaluate(() => (document.querySelector('.xlv-cell[data-ref="C5"]') as HTMLElement).textContent);
    expect(c5).toContain('検索語');
});

test('TC-XLV-12: 数式 — v キャッシュ表示 + f tooltip / キャッシュ欠落 = 空 + tooltip（"0" にしない）', async ({ page }) => {
    await openXlsx(page);
    const res = await page.evaluate(() => {
        const a2 = document.querySelector('.xlv-cell[data-ref="A2"]') as HTMLElement;
        const b2 = document.querySelector('.xlv-cell[data-ref="B2"]') as HTMLElement;
        return { a2Text: a2.textContent, a2Title: a2.title, b2Text: b2.textContent, b2Title: b2.title };
    });
    expect(res.a2Text).toBe('2');
    expect(res.a2Title).toBe('=1+1');
    expect(res.b2Text).toBe('');            // counterfactual: "0" と表示しない
    expect(res.b2Title).toBe('=SUM(A1:A2)');
});

test('TC-XLV-13: locHint Sheet2!C5 — シート切替 + 可視 + 強調 + findQuery one-shot', async ({ page }) => {
    await openXlsx(page, { locHint: 'Sheet2!C5', findQuery: '検索語' });
    await page.waitForSelector('.xlv-cell[data-ref="C5"].xlv-loc-hit');
    const state = await page.evaluate(() => ({
        activeTab: (document.querySelector('.xlv-tab-active') as HTMLElement).textContent,
        count: (document.querySelector('.viewer-find-count') as HTMLElement).textContent,
        visible: (() => {
            const cell = document.querySelector('.xlv-cell[data-ref="C5"]') as HTMLElement;
            const vp = document.querySelector('.xlv-viewport') as HTMLElement;
            const cr = cell.getBoundingClientRect(); const vr = vp.getBoundingClientRect();
            return cr.top >= vr.top && cr.bottom <= vr.bottom;
        })(),
    }));
    expect(state.activeTab).toBe('Sheet2');
    expect(state.count).toBe('1/1');        // find は現シート（Sheet2）のみ
    expect(state.visible).toBe(true);
    // one-shot counterfactual: Sheet1 に手動切替 → 再 find しても Sheet2 に引き戻されない
    await page.evaluate(() => (document.querySelectorAll('.xlv-tab')[0] as HTMLElement).click());
    await page.waitForSelector('.xlv-cell[data-ref="A1"]');
    await page.evaluate(() => {
        const input = document.querySelector('.viewer-find-bar input') as HTMLInputElement;
        input.value = '検索語';
        input.dispatchEvent(new Event('input'));
    });
    await page.waitForFunction(() =>
        ((document.querySelector('.viewer-find-count') as HTMLElement).textContent || '') === '1/2');
    const still = await page.evaluate(() => (document.querySelector('.xlv-tab-active') as HTMLElement).textContent);
    expect(still).toBe('Sheet1');
});

test('TC-XLV-14: find — numfmt 適用後の表示文字列基準・現シートのみ・↑↓巡回', async ({ page }) => {
    await openXlsx(page);
    // 生値 45000 / 表示 2023/3/15（builtin 14 ja）— 表示文字列でヒットする（FR-FV-21 の xlsx 契約）
    await page.evaluate(() => {
        (window as any).__fileViewerState = null;
        const input = document.querySelector('.viewer-find-toggle') as HTMLElement;
        input.click();
    });
    await page.fill('.viewer-find-bar input', '2023/3');
    await page.waitForFunction(() =>
        ((document.querySelector('.viewer-find-count') as HTMLElement).textContent || '') === '1/1');
    await page.waitForSelector('.xlv-cell[data-ref="C1"].xlv-find-current');
    // Sheet1 の 検索語 は A3/B3 の 2 セル（Sheet2 の C5 は数えない = 現シートのみ）
    await page.fill('.viewer-find-bar input', '検索語');
    await page.waitForFunction(() =>
        ((document.querySelector('.viewer-find-count') as HTMLElement).textContent || '') === '1/2');
    await page.evaluate(() => (document.querySelector('.viewer-find-next') as HTMLElement).click());
    await page.waitForSelector('.xlv-cell[data-ref="B3"].xlv-find-current');
    await page.evaluate(() => (document.querySelector('.viewer-find-next') as HTMLElement).click());
    await page.waitForSelector('.xlv-cell[data-ref="A3"].xlv-find-current');   // 巡回
    const count = await page.evaluate(() => (document.querySelector('.viewer-find-count') as HTMLElement).textContent);
    expect(count).toBe('1/2');
});

test('TC-XLV-15: 付帯 — ハイパーリンク下線 + click で openExternal message / コメントマーカー / 漏斗', async ({ page }) => {
    await openXlsx(page);
    const res = await page.evaluate(() => {
        const d1 = document.querySelector('.xlv-cell[data-ref="D1"]') as HTMLElement;
        d1.click();
        const b1 = document.querySelector('.xlv-cell[data-ref="B1"]') as HTMLElement;
        return {
            link: d1.classList.contains('xlv-link'),
            posted: ((window as any).__postedMessages || []).filter((m: any) => m.type === 'openExternalFallback'),
            marker: !!b1.querySelector('.xlv-comment-marker'),
            commentTitle: b1.title,
            funnels: Array.from(document.querySelectorAll('.xlv-funnel')).map((f) =>
                (f.closest('.xlv-cell') as HTMLElement).dataset.ref),
        };
    });
    expect(res.link).toBe(true);
    expect(res.posted.length).toBe(1);
    expect(res.posted[0].type).toBe('openExternalFallback');
    expect(res.posted[0].fileUri).toBe('https://example.com/x');
    // autoFilter A1:D3 の 1 行目（A1..D1）に漏斗
    expect(res.funnels.sort()).toEqual(['A1', 'B1', 'C1', 'D1']);
    expect(res.marker).toBe(true);
    expect(res.commentTitle).toContain('コメント本文');
});


test('TC-XLV-16: 罫線 collapse + 表示スケール — 共有辺は 1 本・行高/フォントは縮小表示（実測 FB 2026-08-24）', async ({ page }) => {
    await openXlsx(page);
    const res = await page.evaluate(() => {
        const q = (ref: string) => document.querySelector(`.xlv-cell[data-ref="${ref}"]`) as HTMLElement;
        const a1 = q('A1');
        return {
            e7: { right: q('E7').style.borderRight, bottom: q('E7').style.borderBottom, left: q('E7').style.borderLeft, top: q('E7').style.borderTop },
            f7: { left: q('F7').style.borderLeft, right: q('F7').style.borderRight },
            e8: { top: q('E8').style.borderTop },
            rowH: a1.offsetHeight,          // 既定行高 20px × 0.9 = 18px
            baseFont: getComputedStyle(a1).fontSize,
        };
    });
    // ブロック外周（左上セルの left/top・自セルの right/bottom）は描く
    expect(res.e7.left).toContain('1px solid');
    expect(res.e7.top).toContain('1px solid');
    expect(res.e7.right).toContain('1px solid');
    expect(res.e7.bottom).toContain('1px solid');
    // 共有辺は隣（E7 の right / bottom）が描くので F7 の left・E8 の top はスキップ = 二重 1px+1px を作らない
    expect(res.f7.left).toBe('');
    expect(res.e8.top).toBe('');
    expect(res.f7.right).toContain('1px solid'); // ブロック右外周は描く
    // 表示スケール 0.9（行高）+ 基本フォント 11px
    expect(res.rowH).toBe(18);
    expect(res.baseFont).toBe('11px');
});
