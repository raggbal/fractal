/**
 * pdf-export-core.spec.ts — md → PDF export 純ロジックの unit テスト
 *
 * TASK-01 / FR-PDF-03/04 / NFR-PDF-01/02。
 * @playwright/test で src/shared の TS を直接 import (flat-pathbuilder.spec.ts 準拠)。
 *
 * 番人方針: injectNoBreakClasses は各見出しの付与/非付与を厳密配列で assert
 * (状態機械を壊すと RED = counterfactual)。composePdfCss は実 temp ファイルで
 * 後勝ち順・scheme skip を behavioral に検証。buildPrintArgs のネットワーク遮断
 * フラグ (NFR-PDF-02 番人) は単独 assert。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    injectNoBreakClasses,
    composePdfCss,
    PDF_DEFAULT_CSS,
    rewriteImgSrcToFileUri,
    buildSelfContainedHtml,
    buildPrintArgs,
    findChromiumExecutable,
    resolveLocalPath,
} from '../../src/shared/pdf-export-core';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-core-'));
}

/** html 内の h1/h2 開きタグを文書順に配列で返す。 */
function headingTags(html: string): string[] {
    const re = /<h[12]\b[^>]*>/gi;
    const tags: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) tags.push(m[0]);
    return tags;
}
function hasNB(tag: string): boolean {
    return /\bno-break-before\b/.test(tag);
}

// ============================================================
// A. injectNoBreakClasses (★counterfactual: 状態機械を壊すと配列不一致で RED)
// ============================================================

test('TC-PDF-01 h1 A→p→h2 B→p→h2 C→h1 D→p→h2 E → A,B付与 C,D非 E付与', () => {
    const html =
        '<h1>A</h1><p>x</p><h2>B</h2><p>y</p><h2>C</h2><h1>D</h1><p>z</p><h2>E</h2>';
    const out = injectNoBreakClasses(html);
    const tags = headingTags(out); // [A,B,C,D,E]
    expect(tags.length).toBe(5);
    expect(tags.map(hasNB)).toEqual([true, true, false, false, true]);
});

test('TC-PDF-02 h1 なし h2 X→p→h2 Y → X/Y とも非付与', () => {
    const html = '<h2>X</h2><p>x</p><h2>Y</h2>';
    const out = injectNoBreakClasses(html);
    expect(headingTags(out).map(hasNB)).toEqual([false, false]);
});

test('TC-PDF-03 h1→ul→pre→h2→h2→h1→blockquote→h2 → 1stH1,直後h2付与 2ndh2非 2ndh1非 最後h2付与', () => {
    const html =
        '<h1>t</h1><ul><li>a</li></ul><pre>code</pre>' +
        '<h2>b</h2><h2>c</h2>' +
        '<h1>d</h1><blockquote>q</blockquote><h2>e</h2>';
    const out = injectNoBreakClasses(html);
    const tags = headingTags(out); // [h1,h2b,h2c,h1d,h2e]
    expect(tags.length).toBe(5);
    expect(tags.map(hasNB)).toEqual([true, true, false, false, true]);
});

test('TC-PDF-04 <h1 class="x"> → class="x no-break-before" (既存 class 破壊なし)', () => {
    const out = injectNoBreakClasses('<h1 class="x">A</h1>');
    expect(out).toContain('class="x no-break-before"');
    // counterfactual: 既存クラスを潰していない
    expect(out).not.toContain('class="no-break-before"'); // 単独に置換していない
});

test('TC-PDF-05 pre/code 内の &lt;h1&gt; は見出しとして数えない', () => {
    const html =
        '<pre>&lt;h1&gt;fake&lt;/h1&gt;</pre>' +
        '<code>&lt;h2&gt;also&lt;/h2&gt;</code>' +
        '<h1>real</h1><h2>realh2</h2>';
    const out = injectNoBreakClasses(html);
    // エスケープ文字列はそのまま残る (誤変換されない)
    expect(out).toContain('&lt;h1&gt;fake&lt;/h1&gt;');
    expect(out).toContain('&lt;h2&gt;also&lt;/h2&gt;');
    // 実見出しは 2 個だけ検出され、real h1 と直後 h2 に付与
    const tags = headingTags(out);
    expect(tags.length).toBe(2);
    expect(tags.map(hasNB)).toEqual([true, true]);
});

test('TC-PDF-06 h2 P→h1 Q→h2 R → P非 Q付与(最初のh1) R付与(Q直後の最初h2)', () => {
    const out = injectNoBreakClasses('<h2>P</h2><h1>Q</h1><h2>R</h2>');
    expect(headingTags(out).map(hasNB)).toEqual([false, true, true]);
});

test('TC-PDF-07 見出しゼロ文書 → 入出力 byte 同一', () => {
    const html = '<p>hello</p><ul><li>x</li></ul><blockquote>q</blockquote>';
    expect(injectNoBreakClasses(html)).toBe(html);
});

test('TC-PDF-08 <h1 id="x" data-y="1"> 属性持ち → 検出・class 追記・属性保持', () => {
    const out = injectNoBreakClasses('<h1 id="x" data-y="1">A</h1>');
    const tag = headingTags(out)[0];
    expect(hasNB(tag)).toBe(true);
    expect(tag).toContain('id="x"');
    expect(tag).toContain('data-y="1"');
});

// ============================================================
// B. composePdfCss
// ============================================================

test('TC-PDF-10 includeDefault=true styles=[] → default のみ・skipped=[]', () => {
    const r = composePdfCss({ includeDefault: true, stylePaths: [] });
    expect(r.css).toBe(PDF_DEFAULT_CSS);
    expect(r.skipped).toEqual([]);
});

test('TC-PDF-11 includeDefault=true + 実在 CSS → default の後にユーザー CSS(後勝ち)', () => {
    const dir = mkTmp();
    const cssPath = path.join(dir, 'user.css');
    const userCss = 'body { color: red; } /*USER-MARKER*/';
    fs.writeFileSync(cssPath, userCss);
    const r = composePdfCss({ includeDefault: true, stylePaths: [cssPath] });
    expect(r.css).toContain('/*USER-MARKER*/');
    expect(r.css).toContain('@page'); // default 断片
    // 後勝ち順: default が先、ユーザーが後
    expect(r.css.indexOf('@page')).toBeLessThan(r.css.indexOf('/*USER-MARKER*/'));
    expect(r.skipped).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-PDF-12 includeDefault=false + 実在 CSS → default 不含', () => {
    const dir = mkTmp();
    const cssPath = path.join(dir, 'user.css');
    fs.writeFileSync(cssPath, '/*ONLY-USER*/');
    const r = composePdfCss({ includeDefault: false, stylePaths: [cssPath] });
    expect(r.css).toBe('/*ONLY-USER*/');
    expect(r.css).not.toContain('@page');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-PDF-13 [不在パス, 実在 CSS] → 不在は skipped・実在は適用', () => {
    const dir = mkTmp();
    const missing = path.join(dir, 'nope.css');
    const cssPath = path.join(dir, 'real.css');
    fs.writeFileSync(cssPath, '/*REAL*/');
    const r = composePdfCss({ includeDefault: false, stylePaths: [missing, cssPath] });
    expect(r.css).toContain('/*REAL*/');
    expect(r.skipped).toContain(missing);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-PDF-14 [https://, file://, 実在ローカル] → scheme付きは全 skipped・実在分適用', () => {
    const dir = mkTmp();
    const cssPath = path.join(dir, 'local.css');
    fs.writeFileSync(cssPath, '/*LOCAL-APPLIED*/');
    const https = 'https://evil/x.css';
    const fileUrl = 'file:///x.css';
    const r = composePdfCss({ includeDefault: false, stylePaths: [https, fileUrl, cssPath] });
    expect(r.css).toContain('/*LOCAL-APPLIED*/');
    // scheme 付きは読まれず skipped (counterfactual: file:// も allowlist で弾く)
    expect(r.skipped).toContain(https);
    expect(r.skipped).toContain(fileUrl);
    expect(r.skipped.length).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-PDF-15 ~/ と相対パスの解決 (resolveTerminologyPath 規則)', () => {
    // ~ 展開
    expect(resolveLocalPath('~/sub/x.css')).toBe(path.join(os.homedir(), '/sub/x.css'));
    // 相対は workspaceRoot ベースで resolve
    expect(resolveLocalPath('a/b.css', '/ws')).toBe(path.resolve('/ws', 'a/b.css'));
    // 絶対はそのまま
    const abs = path.join(mkTmp(), 'z.css');
    expect(resolveLocalPath(abs, '/ws')).toBe(abs);
    // composePdfCss が相対パスを workspaceRoot 基準で解決して読む
    const ws = mkTmp();
    fs.writeFileSync(path.join(ws, 'rel.css'), '/*REL-RESOLVED*/');
    const r = composePdfCss({ includeDefault: false, stylePaths: ['rel.css'], workspaceRoot: ws });
    expect(r.css).toContain('/*REL-RESOLVED*/');
    expect(r.skipped).toEqual([]);
    fs.rmSync(ws, { recursive: true, force: true });
});

// ============================================================
// C. rewriteImgSrcToFileUri / buildSelfContainedHtml / buildPrintArgs / findChromiumExecutable
// ============================================================

test('TC-PDF-20 <img src="/abs/path/画像 1.png"> → file:///abs/path/%E7%94%BB%E5%83%8F%201.png', () => {
    const html = '<img src="/abs/path/画像 1.png">';
    const out = rewriteImgSrcToFileUri(html);
    expect(out).toContain('file:///abs/path/%E7%94%BB%E5%83%8F%201.png');
    expect(out).not.toContain('/abs/path/画像 1.png');
});

test('TC-PDF-21 data:/https: src は不変', () => {
    const dataHtml = '<img src="data:image/png;base64,AAAA">';
    const httpsHtml = '<img src="https://example.com/x.png">';
    expect(rewriteImgSrcToFileUri(dataHtml)).toBe(dataHtml);
    expect(rewriteImgSrcToFileUri(httpsHtml)).toBe(httpsHtml);
    // 既に file: の src も不変
    const fileHtml = '<img src="file:///already/x.png">';
    expect(rewriteImgSrcToFileUri(fileHtml)).toBe(fileHtml);
});

test('TC-PDF-22 buildSelfContainedHtml の構造 (DOCTYPE + charset + style + body class)', () => {
    const out = buildSelfContainedHtml({ bodyHtml: '<p>BODY</p>', css: '/*CSS*/', title: 'My Doc' });
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<title>My Doc</title>');
    expect(out).toContain('<style>');
    expect(out).toContain('/*CSS*/');
    expect(out).toContain('<body class="pdf-export">');
    expect(out).toContain('<p>BODY</p>');
    // 順序: style は head 内、body は後
    expect(out.indexOf('/*CSS*/')).toBeLessThan(out.indexOf('<body class="pdf-export">'));
});

test('TC-PDF-23 buildPrintArgs が必須フラグを含む・legacyHeadless で --headless (NFR-PDF-02 番人)', () => {
    const dest = '/tmp/out.pdf';
    const url = 'file:///tmp/in.html';
    const args = buildPrintArgs(dest, url);
    expect(args).toContain('--headless=new');
    expect(args).toContain('--no-pdf-header-footer');
    expect(args).toContain('--print-to-pdf=' + dest);
    expect(args).toContain(url);
    // ネットワーク全遮断フラグ単独 assert (外すと RED = NFR-PDF-02 番人)
    expect(args).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
    // JS 実行遮断フラグ単独 assert (防御 in depth / NFR-PDF-02・ADRL-0037 強化。外すと RED)
    expect(args).toContain('--disable-javascript');
    // legacyHeadless
    const legacy = buildPrintArgs(dest, url, { legacyHeadless: true });
    expect(legacy).toContain('--headless');
    expect(legacy).not.toContain('--headless=new');
    // 遮断フラグは legacy でも残る
    expect(legacy).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
    // JS 実行遮断フラグも legacy でも残る (両経路一律)
    expect(legacy).toContain('--disable-javascript');
});

test('TC-PDF-30 explicit 実在 → それを返す', () => {
    const explicit = '/custom/chrome';
    const exists = (p: string) => p === explicit;
    expect(findChromiumExecutable(explicit, exists, 'darwin')).toBe(explicit);
});

test('TC-PDF-31 darwin で Chrome のみ実在 (exists 注入) → Chrome パス', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const exists = (p: string) => p === chrome;
    expect(findChromiumExecutable(undefined, exists, 'darwin')).toBe(chrome);
});

test('TC-PDF-32 全不在 → undefined', () => {
    const exists = (_p: string) => false;
    expect(findChromiumExecutable(undefined, exists, 'darwin')).toBeUndefined();
    expect(findChromiumExecutable('/x/y', exists, 'win32')).toBeUndefined();
    expect(findChromiumExecutable(undefined, exists, 'linux')).toBeUndefined();
});
