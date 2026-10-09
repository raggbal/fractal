/**
 * viewer-drawio.spec.ts — drawio viewer の E2E（sprint 20261009-130815-file-viewer-drawio）
 *
 * ハーネス: test/html/standalone-viewer.html（+ notes 面 CSP 版 standalone-viewer-notescsp.html）。
 * fixture: test/fixtures/viewer/drawio/（beforeAll で test/html/viewer-fixtures/drawio/ にコピーして配信）。
 * 描画の観測: Playwright の frame API で sandbox iframe（opaque origin）の中に入り、svg のテキスト・要素を数える。
 *
 * TASK-06: TC-DIO-20 / 21 / 27 / 28 / 29 / 30
 */
import { test, expect, Page, Frame } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'fixtures', 'viewer', 'drawio');
const DEST = path.join(__dirname, '..', 'html', 'viewer-fixtures', 'drawio');

test.beforeAll(() => {
    fs.mkdirSync(DEST, { recursive: true });
    for (const f of fs.readdirSync(SRC)) {
        if (f.endsWith('.js')) { continue; }
        fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
    }
});

async function openDrawio(page: Page, file: string, harness = '/standalone-viewer.html'): Promise<void> {
    await page.goto(harness);
    await page.evaluate((f: string) => (window as any).__fileViewer.open(
        'drawio', `./viewer-fixtures/drawio/${f}`, document.getElementById('viewer-root'), `/tmp/${f}`), file);
}

/** drawio の iframe（blob 文書）を返す */
async function drawioFrame(page: Page): Promise<Frame> {
    const handle = await page.waitForSelector('iframe.fv-drawio-frame');
    const frame = await handle.contentFrame();
    expect(frame).not.toBeNull();
    return frame!;
}

/** iframe 内の svg に text が描画されるまで待つ */
async function waitForLabel(frame: Frame, text: string): Promise<void> {
    await frame.waitForFunction((t: string) => {
        const svg = document.querySelector('#pane svg');
        return !!svg && (svg.textContent || '').includes(t);
    }, text, { timeout: 10000 });
}

test.describe('drawio viewer — 描画', () => {
    test('TC-DIO-20: AWS アイコン入り .drawio（非圧縮）が描画され、ステンシルの path が出る', async ({ page }) => {
        await openDrawio(page, 'aws-plain.drawio');
        const frame = await drawioFrame(page);
        for (const t of ['LAMBDA_LABEL', 'S3_LABEL', 'DDB_LABEL']) { await waitForLabel(frame, t); }
        const counts = await frame.evaluate(() => ({
            shapes: document.querySelectorAll('#pane svg g g').length,
            paths: document.querySelectorAll('#pane svg path').length,
        }));
        expect(counts.shapes).toBeGreaterThanOrEqual(3);
        // resourceIcon は「背景の path 1 本 + アイコン本体（mxgraph.aws4.lambda 等のステンシル）の path」で描かれる。
        // stencils.min.js が無いとアイコン本体が空になり 3 本（背景のみ）に落ちる（実測: 有 6 / 無 3）
        expect(counts.paths).toBeGreaterThanOrEqual(6);
        await expect(page.locator('.fv-drawio-loading')).toHaveCount(0);
    });

    test('TC-DIO-21: 圧縮ページ（deflateRaw + base64）が描画される', async ({ page }) => {
        await openDrawio(page, 'compressed.drawio');
        await waitForLabel(await drawioFrame(page), 'COMPRESSED_LABEL');
    });

    test('TC-DIO-27: .drawio.svg（Desktop 保存 / fractal テンプレート）は img ではなく iframe 描画', async ({ page }) => {
        await openDrawio(page, 'desktop.drawio.svg');
        await waitForLabel(await drawioFrame(page), 'DESKTOP_LABEL');
        await expect(page.locator('.fv-image-stage img')).toHaveCount(0);

        // テンプレートの Placeholder セルはラベルが空（drawioTemplate.ts）— 図形（rect）が描画されることを見る
        await openDrawio(page, 'fractal-template.drawio.svg');
        const frame = await drawioFrame(page);
        await frame.waitForFunction(() => document.querySelectorAll('#pane svg rect').length > 0, null, { timeout: 10000 });
        await expect(page.locator('.fv-image-stage img')).toHaveCount(0);
    });

    test('TC-DIO-28: .drawio.png（zTXt の mxfile）が描画される', async ({ page }) => {
        await openDrawio(page, 'embedded.drawio.png');
        await waitForLabel(await drawioFrame(page), 'PNG_LABEL');
    });

    test('TC-DIO-29: mxfile を持たない .drawio.svg は image 表示に戻り、失敗 UI は出ない', async ({ page }) => {
        await openDrawio(page, 'plain-renamed.drawio.svg');
        await page.waitForSelector('.fv-image-stage img');
        await expect(page.locator('iframe.fv-drawio-frame')).toHaveCount(0);
        await expect(page.locator('.viewer-error')).toHaveCount(0);
        await expect(page.locator('.viewer-zoom-reset')).toBeHidden();
        // image の [+] 配線が効く
        await page.waitForFunction(() => !!(window as any).__fvImageState);
        const before = await page.evaluate(() => (window as any).__fvImageState.scale);
        await page.locator('.viewer-zoom-in').click();
        const after = await page.evaluate(() => (window as any).__fvImageState.scale);
        expect(after).toBeGreaterThan(before);
    });

    test('TC-DIO-30: 壊れた .drawio は失敗 UI、OS で開くで脱出できる', async ({ page }) => {
        await openDrawio(page, 'broken.drawio');
        const err = page.locator('.viewer-error');
        await expect(err).toHaveCount(1, { timeout: 10000 });
        await expect(err).toContainText('Could not display this diagram');
        await expect(page.locator('iframe.fv-drawio-frame')).toHaveCount(0);
        await page.evaluate(() => { (window as any).__postedMessages.length = 0; });
        await page.locator('.viewer-open-external').click();
        const msgs = await page.evaluate(() => (window as any).__postedMessages);
        expect(msgs.some((m: any) => m.type === 'openExternalFallback')).toBe(true);
    });
});
