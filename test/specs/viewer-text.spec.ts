/**
 * viewer-text.spec.ts — text viewer（TC-TXV-01..06）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-07。ハーネス: standalone-viewer.html
 * （viewer-modules/viewer-text.mjs は build-viewer-modules.js → build-standalone-viewer.js が供給）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const FIX = path.join(__dirname, '..', 'html', 'viewer-fixtures');

test.beforeAll(() => {
    fs.mkdirSync(FIX, { recursive: true });
    fs.writeFileSync(path.join(FIX, 'sample.json'), '{\n  "name": "値",\n  "long": "' + 'x'.repeat(400) + '"\n}\n');
    fs.writeFileSync(path.join(FIX, 'binary.bin'), Buffer.concat([Buffer.from('abc'), Buffer.from([0, 1, 2]), Buffer.from('def')]));
    const le = Buffer.from('日本語 UTF16LE テキスト\n2 行目', 'utf16le');
    fs.writeFileSync(path.join(FIX, 'utf16le.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), le]));
    // 6 万行（≫ CHUNK=5000）— spec 内生成・末尾付近にのみ現れる語を仕込む
    const lines: string[] = [];
    for (let i = 1; i <= 60000; i++) { lines.push(`line ${i} lorem ipsum`); }
    lines[59990] = 'line 59991 NEEDLE-AT-TAIL';
    fs.writeFileSync(path.join(FIX, 'big.log'), lines.join('\n'));
});

async function openText(page: any, file: string, opts?: Record<string, unknown>) {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(([f, o]: [string, any]) => (window as any).__fileViewer.open(
        'text', `./viewer-fixtures/${f}`, document.getElementById('viewer-root'), `/tmp/${f}`, o || undefined),
        [file, opts || null] as [string, any]);
}

test('TC-TXV-01: 表示 — 行番号・折り返し・選択コピー可能な DOM', async ({ page }) => {
    await openText(page, 'sample.json');
    await page.waitForSelector('.fv-text .fv-line');
    const first = await page.evaluate(() => {
        const line = document.querySelector('.fv-line') as HTMLElement;
        return {
            ln: (line.querySelector('.fv-ln') as HTMLElement).textContent,
            text: (line.querySelector('.fv-lt') as HTMLElement).textContent,
            wrap: getComputedStyle(line.querySelector('.fv-lt') as HTMLElement).whiteSpace,
            lnSelect: getComputedStyle(line.querySelector('.fv-ln') as HTMLElement).userSelect,
        };
    });
    expect(first.ln).toBe('1');
    expect(first.text).toBe('{');
    expect(first.wrap).toBe('pre-wrap');        // 折り返し表示（横スクロールなし）
    expect(first.lnSelect).toBe('none');        // 行番号はコピーに混ざらない
    // 日本語行の内容
    const line2 = await page.evaluate(() => (document.querySelectorAll('.fv-lt')[1] as HTMLElement).textContent);
    expect(line2).toContain('"name": "値"');
});

test('TC-TXV-02: バイナリ → 明示メッセージ + OS で開くボタン', async ({ page }) => {
    await openText(page, 'binary.bin');
    await page.waitForSelector('.fv-text-binary');
    const txt = await page.evaluate(() => (document.querySelector('.fv-text-binary') as HTMLElement).textContent);
    expect(txt).toContain('Cannot display as text'); // ハーネスは i18n 注入なし → 既定英語
    await page.waitForSelector('.viewer-open-external-fallback');
});

test('TC-TXV-03: chunk — 初回同期 append は CHUNK 以内・idle 追記で全行到達', async ({ page }) => {
    await openText(page, 'big.log');
    await page.waitForSelector('.fv-text .fv-line');
    const initial = await page.evaluate(() => (window as any).__fvTextInitialLines);
    expect(initial).toBeLessThanOrEqual(5000);   // 構造 assert（NFR-VEX-03 — 全行同期 append しない）
    expect(initial).toBeGreaterThan(0);
    await page.waitForFunction(() => document.querySelectorAll('.fv-line').length === 60000, null, { timeout: 60000 });
});

test('TC-TXV-04: find — 末尾ヒットへの chunk 先行描画着地 + pendingFindQuery one-shot', async ({ page }) => {
    await openText(page, 'big.log', { findQuery: 'NEEDLE-AT-TAIL' });
    await page.waitForSelector('.fv-find-current', { timeout: 30000 });
    const res = await page.evaluate(() => ({
        count: (document.querySelector('.viewer-find-count') as HTMLElement).textContent,
        currentLine: (document.querySelector('.fv-find-current')!.closest('.fv-line')!.querySelector('.fv-ln') as HTMLElement).textContent,
        rendered: document.querySelectorAll('.fv-line').length,
    }));
    expect(res.count).toBe('1/1');
    expect(res.currentLine).toBe('59991');
    expect(res.rendered).toBeGreaterThanOrEqual(59991); // 未描画 chunk の先行描画
    // one-shot: 消費後に手動で別語を find しても元 query に引き戻されない
    await page.evaluate(() => {
        const input = document.querySelector('.viewer-find-bar input') as HTMLInputElement;
        input.value = 'lorem';
        input.dispatchEvent(new Event('input'));
    });
    await page.waitForFunction(() =>
        ((document.querySelector('.viewer-find-count') as HTMLElement).textContent || '').endsWith('/1000'));
    const q = await page.evaluate(() => (document.querySelector('.viewer-find-bar input') as HTMLInputElement).value);
    expect(q).toBe('lorem');
});

test('TC-TXV-05: findClear 原状復帰・Esc で bar close', async ({ page }) => {
    await openText(page, 'sample.json');
    await page.waitForSelector('.fv-text .fv-line');
    const before = await page.evaluate(() => (document.querySelector('.fv-text') as HTMLElement).innerHTML);
    await page.evaluate(() => {
        (window as any).__fvState = null;
        const bar = document.querySelector('.viewer-find-bar') as HTMLElement;
        bar.style.display = 'flex';
        const input = bar.querySelector('input') as HTMLInputElement;
        input.value = 'name';
        input.dispatchEvent(new Event('input'));
    });
    await page.waitForSelector('.fv-find-current');
    await page.focus('.viewer-find-bar input');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (document.querySelector('.viewer-find-bar') as HTMLElement).style.display === 'none');
    const after = await page.evaluate(() => (document.querySelector('.fv-text') as HTMLElement).innerHTML);
    expect(after).toBe(before); // unwrap 原状復帰
});

test('TC-TXV-06: UTF-16LE BOM のデコード表示', async ({ page }) => {
    await openText(page, 'utf16le.txt');
    await page.waitForSelector('.fv-text .fv-line');
    const t = await page.evaluate(() => (document.querySelector('.fv-lt') as HTMLElement).textContent);
    expect(t).toBe('日本語 UTF16LE テキスト');
});
