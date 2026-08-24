/**
 * viewer-docx-parse.spec.ts — docx 中間モデルパーサ（TC-DXV-02/03/04/11/13）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-09。
 * node コンテキスト + jsdom の DOMParser を global 注入して parseDocumentXml を unit 検証
 * （DocModel はプレーンオブジェクト — DOM 生成なし）。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-docx', 'parse.mjs');

async function parseDoc(bodyXml: string) {
    const dom = new JSDOM('');
    (global as any).DOMParser = dom.window.DOMParser;
    const { parseDocumentXml } = await import(/* webpackIgnore: true */ MOD);
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
<w:body>${bodyXml}</w:body></w:document>`;
    const doc = new dom.window.DOMParser().parseFromString(xml, 'application/xml');
    return parseDocumentXml(doc);
}

/** 全 section の全段落 run テキストを平坦化 */
function allText(model: any): string {
    const out: string[] = [];
    const walkRuns = (runs: any[]) => {
        for (const r of runs) {
            if (r.t === 'text') { out.push(r.text); }
            if (r.t === 'ruby') { walkRuns(r.base); }
            if (r.t === 'link' || r.t === 'textbox') { walkRuns(r.runs); }
        }
    };
    const walkBlocks = (blocks: any[]) => {
        for (const b of blocks) {
            if (b.t === 'p') { walkRuns(b.runs); }
            if (b.t === 'tbl') { for (const row of b.rows) { for (const c of row.cells) { walkBlocks(c.blocks); } } }
        }
    };
    for (const s of model.sections) { walkBlocks(s.blocks); }
    return out.join('');
}

test('TC-DXV-02: xml:space preserve / w:tab 連続 / 空 w:t', async () => {
    const m = await parseDoc(
        '<w:p><w:r><w:t xml:space="preserve">  lead and trail  </w:t></w:r>' +
        '<w:r><w:tab/><w:tab/><w:t>after</w:t></w:r><w:r><w:t/></w:r></w:p>');
    const runs = m.sections[0].blocks[0].runs;
    expect(runs[0]).toMatchObject({ t: 'text', text: '  lead and trail  ' }); // trim 禁止
    expect(runs.filter((r: any) => r.t === 'tab').length).toBe(2);
    expect(allText(m)).toBe('  lead and trail  after');
});

test('TC-DXV-03: sdt 透過 + field 状態機械（instrText 非表示・キャッシュ結果表示・fldSimple・ネスト）', async () => {
    const m = await parseDoc(
        // sdt 透過（目次の典型構造）
        '<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>目次テキスト</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
        // field: begin → instrText（非表示） → separate → cached result（表示） → end
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc123 \\h </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:t>42</w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        // fldSimple は子を表示
        '<w:fldSimple w:instr=" DATE "><w:r><w:t>2026/8/23</w:t></w:r></w:fldSimple>' +
        // ネスト field（外側 begin → 内側 begin/end → 外側 separate 以降表示）
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText>IF</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>REF x</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:t>nested-result</w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
    const text = allText(m);
    expect(text).toContain('目次テキスト');
    expect(text).toContain('42');
    expect(text).toContain('2026/8/23');
    expect(text).toContain('nested-result');
    expect(text).not.toContain('PAGEREF');   // 呪文が本文に出ない
    expect(text).not.toContain('REF x');
});

test('TC-DXV-04: ins 表示 / del 非表示 / w:sym / noBreakHyphen', async () => {
    const m = await parseDoc(
        '<w:p><w:ins w:id="1"><w:r><w:t>inserted</w:t></w:r></w:ins>' +
        '<w:del w:id="2"><w:r><w:delText>deleted</w:delText></w:r></w:del>' +
        '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>' +
        '<w:r><w:noBreakHyphen/><w:t>x</w:t></w:r></w:p>');
    const text = allText(m);
    expect(text).toContain('inserted');
    expect(text).not.toContain('deleted');
    expect(text).toContain('‑x'); // noBreakHyphen = U+2011
    // w:sym は私用領域 -0xF000 の置換（Wingdings F0FC=✓ 相当 — 置換表外は • 縮退）
    const symRun = m.sections[0].blocks[0].runs.find((r: any) => r.t === 'text' && (r.text === '✓' || r.text === '•'));
    expect(symRun).toBeTruthy();
});

test('TC-DXV-11: mc:AlternateContent は Fallback 採用 + v:textbox>w:txbxContent 回収', async () => {
    const m = await parseDoc(
        '<w:p><w:r><mc:AlternateContent>' +
        '<mc:Choice Requires="wps"><w:t>SHOULD-NOT-APPEAR</w:t></mc:Choice>' +
        '<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>' +
        '<w:p><w:r><w:t>テキストボックス本文</w:t></w:r></w:p>' +
        '</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>' +
        '</mc:AlternateContent></w:r></w:p>');
    const text = allText(m);
    expect(text).toContain('テキストボックス本文');
    expect(text).not.toContain('SHOULD-NOT-APPEAR');
});

test('TC-DXV-13: OMML は [数式] プレースホルダ run（unknown 要素の skip と区別）', async () => {
    const m = await parseDoc(
        '<w:p><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath>' +
        '<w:r><w14:glow w14:rad="1"/><w:t>visible</w:t></w:r></w:p>');
    const runs = m.sections[0].blocks[0].runs;
    // OMML → math プレースホルダ run（レンダラが i18n viewerUnsupportedMath を表示）
    expect(runs.some((r: any) => r.t === 'math')).toBe(true);
    // unknown（w14:glow）は skip されつつ後続テキストは生きる（counterfactual: 区別が消えると
    // OMML が silent skip になり math run が消える）
    expect(allText(m)).toContain('visible');
    expect(allText(m)).not.toContain('E=mc^2'); // 数式の中身をテキスト化しない（placeholder）
});

test('sectPr 分割: pPr 内 sectPr（その段落までが前セクション）+ body 末尾', async () => {
    const m = await parseDoc(
        '<w:p><w:r><w:t>sec1</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>sec1-last</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>sec2</w:t></w:r></w:p>' +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:left="1440" w:right="1440" w:top="1440" w:bottom="1440"/></w:sectPr>');
    expect(m.sections.length).toBe(2);
    expect(m.sections[0].props.pgW).toBe(11906);
    expect(m.sections[1].props.pgW).toBe(12240);
    expect(m.sections[1].props.marL).toBe(1440);
});
