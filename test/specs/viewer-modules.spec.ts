/**
 * viewer-modules.spec.ts — viewer モジュール機構（lazy import / mount 契約 / locHint parse）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-06（TC-VEX-09/17）+ TASK-17（TC-VEX-13 を追記予定）。
 * ハーネス: standalone-viewer.html（実行前に test:build:all）。stub モジュール（synthetic .mjs）で
 * 機構自体を検証する — 実 kind の統合は各 kind TASK のハーネス spec が担保。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { storedZip } from '../utils/stored-zip';

const HTML_DIR = path.join(__dirname, '..', 'html');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'viewer');

function writeStubModule(): void {
    const dir = path.join(HTML_DIR, 'viewer-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stub-viewer-module.mjs'), [
        '// synthetic stub — TC-VEX-09（モジュール評価回数 = import 回数の観測子）',
        'window.__stubEvalCount = (window.__stubEvalCount || 0) + 1;',
        'export default {',
        '  async mount(ctx) {',
        '    window.__stubMountCount = (window.__stubMountCount || 0) + 1;',
        '    window.__stubCtxKeys = Object.keys(ctx).sort();',
        '    window.__stubLocHint = ctx.locHint; window.__stubFindQuery = ctx.findQuery;',
        "    const el = ctx.body.ownerDocument.createElement('div');",
        "    el.className = 'stub-mounted'; el.textContent = 'stub-mounted';",
        '    ctx.body.appendChild(el);',
        '    return { destroy() { window.__stubDestroyed = (window.__stubDestroyed || 0) + 1; } };',
        '  },',
        '};',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'dummy.txt'), 'dummy');
}

test.beforeAll(() => {
    writeStubModule();
    // TASK-17: 実文書 fixtures（build-samples.js が生成・commit 済み）をハーネス配下へ
    const dir = path.join(HTML_DIR, 'viewer-fixtures');
    for (const f of ['sample.docx', 'sample.xlsx', 'sample.pptx']) {
        fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
    }
    // TC-VEX-13: パース途中で throw する壊れ docx（document.xml が非 well-formed XML）
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    fs.writeFileSync(path.join(dir, 'broken.docx'), storedZip([
        ['_rels/.rels', `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`],
        ['word/document.xml', '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>trunc'],
    ]));
});

test('TC-VEX-09: lazy import — 初回 open でロード・Promise キャッシュ・pdf/html では非ロード', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => {
        (window as any).__viewerConfig = (window as any).__viewerConfig || {};
        (window as any).__viewerConfig.viewerModuleUris = { text: './viewer-fixtures/stub-viewer-module.mjs' };
    });
    // html open ではモジュールをロードしない（lazy）
    await page.evaluate(() => (window as any).__fileViewer.open(
        'html', './viewer-fixtures/dummy.txt', document.getElementById('viewer-root'), '/tmp/dummy.html'));
    await page.waitForSelector('.viewer-toolbar');
    expect(await page.evaluate(() => (window as any).__stubEvalCount || 0)).toBe(0);
    // text open でロード + mount
    await page.evaluate(() => (window as any).__fileViewer.open(
        'text', './viewer-fixtures/dummy.txt', document.getElementById('viewer-root'), '/tmp/dummy.txt'));
    await page.waitForSelector('.stub-mounted');
    expect(await page.evaluate(() => (window as any).__stubEvalCount)).toBe(1);
    expect(await page.evaluate(() => (window as any).__stubMountCount)).toBe(1);
    // 2 回目の open で import は 1 回のまま（Promise キャッシュ）・mount は 2 回目
    await page.evaluate(() => (window as any).__fileViewer.open(
        'text', './viewer-fixtures/dummy.txt', document.getElementById('viewer-root'), '/tmp/dummy.txt'));
    await page.waitForSelector('.stub-mounted');
    expect(await page.evaluate(() => (window as any).__stubEvalCount)).toBe(1);
    expect(await page.evaluate(() => (window as any).__stubMountCount)).toBe(2);
    // destroy 連結（cleanupRegistry 経由 — 2 回目の open が 1 回目の instance を破棄している）
    expect(await page.evaluate(() => (window as any).__stubDestroyed || 0)).toBe(1);
    // mount ctx 契約（architecture.md §2）
    const keys = await page.evaluate(() => (window as any).__stubCtxKeys as string[]);
    for (const k of ['body', 'mount', 'state', 'config', 'postMessage', 'label', 'fileUri', 'filePath', 'locHint', 'findQuery']) {
        expect(keys, `ctx.${k}`).toContain(k);
    }
});

test('TC-VEX-09: モジュール URI 未設定 kind は失敗 UI（webview を落とさない）', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => {
        (window as any).__viewerConfig = (window as any).__viewerConfig || {};
        (window as any).__viewerConfig.viewerModuleUris = {};
        (window as any).__fileViewer.open('docx', './viewer-fixtures/dummy.txt', document.getElementById('viewer-root'), '/tmp/d.docx');
    });
    await page.waitForSelector('.viewer-error');
});

test('TC-VEX-09: locHint/findQuery が mount ctx へ one-shot で渡る', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => {
        (window as any).__viewerConfig.viewerModuleUris = { xlsx: './viewer-fixtures/stub-viewer-module.mjs' };
        (window as any).__fileViewer.open('xlsx', './viewer-fixtures/dummy.txt', document.getElementById('viewer-root'), '/tmp/a.xlsx',
            { locHint: 'Sheet2!C5', findQuery: 'hello' });
    });
    await page.waitForSelector('.stub-mounted');
    expect(await page.evaluate(() => (window as any).__stubLocHint)).toEqual({ sheet: 'Sheet2', cell: 'C5' });
    expect(await page.evaluate(() => (window as any).__stubFindQuery)).toBe('hello');
});

test('TC-VEX-17: parseLocHint の kind 分岐', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    const parse = (kind: string, hint: string | null) =>
        page.evaluate(([k, h]) => (window as any).__fileViewer.parseLocHint(k, h), [kind, hint] as [string, string | null]);
    expect(await parse('xlsx', 'Sheet2!C5')).toEqual({ sheet: 'Sheet2', cell: 'C5' });
    expect(await parse('xlsx', 'My!Sheet!C5')).toEqual({ sheet: 'My!Sheet', cell: 'C5' });        // 最後の ! で分割
    expect(await parse('xlsx', 'シート1!AB12')).toEqual({ sheet: 'シート1', cell: 'AB12' });
    expect(await parse('pptx', 'slide 3')).toEqual({ slide: 3 });
    expect(await parse('pptx', 'Slide12')).toEqual({ slide: 12 });
    expect(await parse('pdf', 'p.4')).toEqual({ page: 4 });                                        // 既存互換
    expect(await parse('text', 'p.4')).toBeNull();
    expect(await parse('docx', 'anything')).toBeNull();
    expect(await parse('xlsx', 'no-cell-here')).toBeNull();
    expect(await parse('xlsx', null)).toBeNull();
});

// ── TASK-17: 実文書 fixtures の統合 smoke + TC-VEX-13（blob 全 revoke） ──────

function spyBlobUrls(page: any) {
    return page.evaluate(() => {
        const w = window as any;
        w.__blobCreated = 0; w.__blobRevoked = 0;
        const c = URL.createObjectURL.bind(URL);
        const r = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (b: Blob) => { w.__blobCreated++; return c(b); };
        URL.revokeObjectURL = (u: string) => { w.__blobRevoked++; return r(u); };
    });
}

test('統合 smoke: 実文書 sample.{docx,xlsx,pptx} が実モジュールで描画される', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    const open = (kind: string, file: string) => page.evaluate(([k, f]: [string, string]) =>
        (window as any).__fileViewer.open(k, `./viewer-fixtures/${f}`, document.getElementById('viewer-root'), `/tmp/${f}`),
        [kind, file] as [string, string]);
    await open('docx', 'sample.docx');
    await page.waitForSelector('.dxv-page');
    expect(await page.evaluate(() => document.querySelector('.dxv-root')!.textContent)).toContain('会議議事録');
    await open('xlsx', 'sample.xlsx');
    await page.waitForSelector('.xlv-cell');
    expect(await page.evaluate(() => document.querySelector('.xlv-spacer')!.textContent)).toContain('要件定義');
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('.xlv-tab')).map((t) => t.textContent))).toEqual(['計画', '補足']);
    await open('pptx', 'sample.pptx');
    await page.waitForSelector('.ppv-slide');
    await page.waitForFunction(() => (document.body.textContent || '').includes('事業計画の概要'));
});

test('TC-VEX-13: blob 全 revoke — 正常 destroy / 破棄後の遅延 blob / 壊れ docx の失敗経路', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    await spyBlobUrls(page);
    const open = (file: string) => page.evaluate((f: string) =>
        (window as any).__fileViewer.open('docx', `./viewer-fixtures/${f}`, document.getElementById('viewer-root'), `/tmp/${f}`)
            .catch(() => { /* 壊れ fixture は open が reject し error UI を出す */ }), file);
    // 1) 正常: 画像 blob が生成される → destroy で全 revoke
    await open('sample.docx');
    await page.waitForFunction(() => {
        const img = document.querySelector('.dxv-page img') as HTMLImageElement | null;
        return !!img && img.src.startsWith('blob:');
    });
    await page.evaluate(() => (window as any).__fileViewer.destroy(document.getElementById('viewer-root')));
    let counts = await page.evaluate(() => ({ c: (window as any).__blobCreated, r: (window as any).__blobRevoked }));
    expect(counts.c).toBeGreaterThan(0);
    expect(counts.r).toBe(counts.c);
    // 2) 破棄後の遅延 blob: open 直後（media 到着前）に destroy → 遅延生成分も漏らさない
    await open('sample.docx');
    await page.evaluate(() => (window as any).__fileViewer.destroy(document.getElementById('viewer-root')));
    await page.waitForFunction(() =>
        (window as any).__blobCreated > 0 && (window as any).__blobRevoked === (window as any).__blobCreated,
        null, { timeout: 10000 });
    // 3) 失敗経路: パース途中 throw → error UI + created == revoked（登録済み分が全 revoke — INV-3）
    const before = await page.evaluate(() => (window as any).__blobCreated);
    await open('broken.docx');
    await page.waitForSelector('.viewer-error');
    counts = await page.evaluate(() => ({ c: (window as any).__blobCreated, r: (window as any).__blobRevoked }));
    expect(counts.c).toBe(counts.r);
    expect(before).toBeLessThanOrEqual(counts.c); // 番人の自壊検知（spy が生きている）
});
