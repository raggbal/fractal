/**
 * TC-VFB-01..05 — file viewer find bar（sprint 20260822-051129 FR-VFB）
 *
 * ハーネス: standalone-viewer.html（本番忠実 CSP + nonce・軽量 1 面 = 3 面共通実装の検証面。
 * generator_failures 2026-08-15 の教訓どおり重い実レンダはここに集約）。
 * HTML find = 注入 script + MessageChannel（origin 'null' capture 遮断と非干渉）/ PDF = PDFFindController。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const HTML_DIR = path.join(ROOT, 'test', 'html');
const FIXTURE_PDF = path.join(ROOT, 'test', 'fixtures', 'doc-search', 'fixture-ja-en.pdf');

test.beforeAll(() => {
    const dir = path.join(HTML_DIR, 'viewer-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'find-sample.html'), [
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>',
        '<p>alpha Needle bravo</p>',
        '<div>charlie <b>nee</b>dle は分割ノード（マッチしない設計 = テキストノード単位）</div>',
        '<p>delta needle echo NEEDLE fox</p>',
        '<div style="display:none">hidden needle one / hidden needle two（非表示タブ相当 — カウント対象外）</div>',
        '<script>document.body.dataset.x = "1";</scr' + 'ipt>',
        '</body></html>',
    ].join('\n'));
    fs.copyFileSync(FIXTURE_PDF, path.join(dir, 'find-ja-en.pdf'));
    fs.writeFileSync(path.join(dir, 'two-page.pdf'), buildTwoPagePdf());
});

/** 最小 2 ページ PDF（両ページに TwoPageNeedle — 着地ページ検証用。非圧縮・xref 実計算） */
function buildTwoPagePdf(): Buffer {
    const objs: string[] = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>';
    objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
    objs[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
    const s1 = 'BT /F1 24 Tf 72 700 Td (TwoPageNeedle on first) Tj ET';
    const s2 = 'BT /F1 24 Tf 72 700 Td (TwoPageNeedle on second) Tj ET';
    objs[5] = `<< /Length ${s1.length} >>\nstream\n${s1}\nendstream`;
    objs[6] = `<< /Length ${s2.length} >>\nstream\n${s2}\nendstream`;
    objs[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    let out = '%PDF-1.4\n';
    const offsets: number[] = [0];
    for (let i = 1; i <= 7; i++) {
        offsets[i] = out.length;
        out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 8\n0000000000 65535 f \n`;
    for (let i = 1; i <= 7; i++) { out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'; }
    out += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
}

async function openViewer(page: any, kind: string, url: string): Promise<void> {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(({ kind, url }: any) => {
        (window as any).__fileViewer.open(kind, url, document.getElementById('viewer-root'));
    }, { kind, url });
}

test('TC-VFB-01 find bar UI: 🔍/Cmd+F で開閉・Esc で閉じてクリア（共通 UI — html 面で駆動）', async ({ page }) => {
    await openViewer(page, 'html', './viewer-fixtures/find-sample.html');
    await page.waitForSelector('.viewer-html-frame');
    // 🔍 ボタンで開く
    await page.waitForSelector('.viewer-find-toggle');
    await page.click('.viewer-find-toggle');
    await expect(page.locator('.viewer-find-bar')).toBeVisible();
    await expect(page.locator('.viewer-find-bar input')).toBeFocused();
    // Esc で閉じる
    await page.keyboard.press('Escape');
    await expect(page.locator('.viewer-find-bar')).toBeHidden();
    // Cmd+F（viewer フォーカス時）で開く
    await page.click('.viewer-toolbar');
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.viewer-find-bar')).toBeVisible();
});

test('TC-VFB-02 HTML find: case-insensitive マッチ + span ハイライト + 前/次巡回 + クリアで DOM 原状復帰', async ({ page }) => {
    await openViewer(page, 'html', './viewer-fixtures/find-sample.html');
    await page.waitForSelector('.viewer-html-frame');
    await page.waitForTimeout(400); // iframe load + find channel init
    await page.click('.viewer-find-toggle');
    await page.fill('.viewer-find-bar input', 'needle');
    // count 表示（Needle/needle/NEEDLE の 3 件 — 分割ノードと **display:none 配下（SPA の非表示タブ相当）** は対象外 = ブラウザ find 同義）
    await expect(page.locator('.viewer-find-count')).toHaveText('1/3', { timeout: 5000 });
    // iframe 内に span ハイライト 3 個
    const frame = page.frameLocator('.viewer-html-frame');
    await expect(frame.locator('span[data-fv-find]')).toHaveCount(3);
    // 次へ → 2/3、さらに 2 回 → 巡回して 1/3
    await page.click('.viewer-find-next');
    await expect(page.locator('.viewer-find-count')).toHaveText('2/3');
    await page.click('.viewer-find-next');
    await page.click('.viewer-find-next');
    await expect(page.locator('.viewer-find-count')).toHaveText('1/3');
    // 前へ → 巡回して 3/3
    await page.click('.viewer-find-prev');
    await expect(page.locator('.viewer-find-count')).toHaveText('3/3');
    // Esc → span が unwrap され原文テキスト保持
    await page.keyboard.press('Escape');
    await expect(frame.locator('span[data-fv-find]')).toHaveCount(0);
    await expect(frame.locator('body')).toContainText('alpha Needle bravo');
});

test('TC-VFB-03 PDF find: PDFFindController 配線 — count > 0 + ハイライト', async ({ page }) => {
    await openViewer(page, 'pdf', './viewer-fixtures/find-ja-en.pdf');
    await page.waitForSelector('.pdfViewer .page', { timeout: 30000 });
    await page.click('.viewer-find-toggle');
    await page.fill('.viewer-find-bar input', 'FractalSearchTargetEnglish2026');
    // 件数（1/1）と textLayer の highlight span
    await expect(page.locator('.viewer-find-count')).toHaveText('1/1', { timeout: 15000 });
    await expect(page.locator('.pdfViewer .textLayer .highlight').first()).toBeVisible({ timeout: 10000 });
});

test('TC-VFB-04 i18n + バンドル不変 pin', async () => {
    // i18n: interface + 7 locale（NFR — 未登録キーの silent 英語固定防止）
    // SEC-1（reviewer iter1）: label() は webview 側 __outlinerMessages（= WebviewMessages）を読む —
    // Messages（host 側）への誤登録では note/sidepanel 面が英語固定になる。**帰属ブロックまで**検査する
    const iface = fs.readFileSync(path.join(ROOT, 'src/i18n/messages.ts'), 'utf8');
    const wvBlock = iface.slice(iface.indexOf('export interface WebviewMessages'), iface.indexOf('}', iface.indexOf('export interface WebviewMessages')));
    expect(wvBlock.includes('viewerFind'), 'viewerFind が WebviewMessages interface に無い（host 側 Messages への誤登録）').toBe(true);
    for (const loc of ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw']) {
        const src = fs.readFileSync(path.join(ROOT, `src/i18n/locales/${loc}.ts`), 'utf8');
        const wm = src.slice(src.indexOf('export const webviewMessages'));
        expect(wm.includes('viewerFind'), `viewerFind が ${loc} の webviewMessages ブロックに無い`).toBe(true);
    }
    // pdfjs バンドル不変（版 pin = CVE 裁定 — find は配線のみでバンドル再生成しない）
    const lib = fs.readFileSync(path.join(ROOT, 'media/pdfjs-viewer/pdfjs-lib.mjs'), 'utf8');
    expect(lib.includes('5.5.207'), 'pdfjs バンドル版が変わった（find は配線のみの契約）').toBe(true);
});

test('TC-VFB-05 横断検索ヒット連携: open opts.findQuery で自動 find + 経路 6 点の透過 contract', async ({ page }) => {
    // (a) viewer 端 behavioral: findQuery 付き open → find bar 自動オープン + 自動実行
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => {
        (window as any).__fileViewer.open('html', './viewer-fixtures/find-sample.html',
            document.getElementById('viewer-root'), '/x/find-sample.html', { findQuery: 'needle' });
    });
    await expect(page.locator('.viewer-find-bar')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.viewer-find-bar input')).toHaveValue('needle');
    await expect(page.locator('.viewer-find-count')).toHaveText('1/3', { timeout: 5000 });
    // (b) 経路の透過 contract（送出 → bridge → host case → provider message → dispatcher の 5 点）
    const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const panel = read('src/shared/notes-file-panel.js');
    // FR-SEF-01 (sprint 20260822-203347・TASK-05 許可: test_update): 検索語の引き渡しは
    // 生 input 直読みから currentSearch().body（ext: strip 済み本文クエリ）に改訂 — 挙動契約は保持
    expect(/openNoteFilesExternal\(rel,\s*currentSearch\(\)\.body/.test(panel),
        '検索ヒット click が検索語（本文クエリ）を渡していない').toBe(true);
    const bridge = read('src/shared/notes-host-bridge.js');
    expect(bridge.includes("type: 'openNoteFilesExternal'") && bridge.match(/openNoteFilesExternal[\s\S]{0,220}findQuery/) !== null,
        'bridge が findQuery を送っていない').toBe(true);
    const nmh = read('src/shared/notes-message-handler.ts');
    expect(nmh.match(/case 'openNoteFilesExternal'[\s\S]{0,320}findQuery/) !== null,
        'host case が findQuery を透過していない').toBe(true);
    const nep = read('src/notesEditorProvider.ts');
    expect(nep.match(/showNoteViewer[\s\S]{0,400}findQuery/) !== null,
        'showNoteViewer message に findQuery が無い').toBe(true);
    const disp = read('src/shared/viewer-dispatcher.js');
    expect(disp.match(/findQuery/) !== null, 'dispatcher が findQuery を透過していない').toBe(true);
});

test('TC-VFB-06 Cmd+F の確実な先取り: フォーカスが viewer 外（body）でも find bar が開く / 外部入力からは奪わない', async ({ page }) => {
    await openViewer(page, 'html', './viewer-fixtures/find-sample.html');
    await page.waitForSelector('.viewer-html-frame');
    // フォーカスを明示的に body へ（クリックなしの初期状態相当）
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); document.body.focus(); });
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.viewer-find-bar')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.viewer-find-bar')).toBeHidden();
    // viewer 外の入力にフォーカスがある時は奪わない
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.id = 'outside-input';
        document.body.appendChild(inp);
        inp.focus();
    });
    await page.keyboard.press('ControlOrMeta+f');
    await page.waitForTimeout(200);
    await expect(page.locator('.viewer-find-bar')).toBeHidden();
    // 隠れた contenteditable（note 面の md editor 相当）にフォーカスが残っていても viewer が勝つ
    await page.evaluate(() => {
        (document.getElementById('outside-input') as HTMLElement).remove();
        const ce = document.createElement('div');
        ce.id = 'hidden-md';
        ce.contentEditable = 'true';
        document.body.appendChild(ce);
        ce.focus();
        ce.style.display = 'none'; // focus を保持したまま不可視化（display:none でも activeElement は残る）
    });
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.viewer-find-bar')).toBeVisible({ timeout: 3000 });
});

test('TC-VFB-07 pdf + locHint: ヒントページのマッチに着地（両ページ同語 + p.2 → page 2 の selected highlight）', async ({ page }) => {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => {
        (window as any).__fileViewer.open('pdf', './viewer-fixtures/two-page.pdf',
            document.getElementById('viewer-root'), '/x/two-page.pdf', { findQuery: 'TwoPageNeedle', locHint: 'p.2' });
    });
    await expect(page.locator('.viewer-find-bar')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.viewer-find-count')).toHaveText('2/2', { timeout: 15000 }); // page2 のマッチが selected（2 件中 2 番目）
    // counterfactual: 順序化が壊れると page1 起点 = 1/2 になり RED
    await expect(page.locator('.pdfViewer .page[data-page-number="2"] .textLayer .highlight.selected').first())
        .toBeAttached({ timeout: 10000 });
});
