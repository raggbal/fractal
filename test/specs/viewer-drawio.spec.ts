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

/** 描画中の図形（path）の外接幅。svg 直下の g は背景を含み倍率で変わらないため使わない */
const GRAPH_WIDTH_JS = `(() => { let l = 1e9, r = -1e9;
    document.querySelectorAll('#pane svg path').forEach((p) => { const b = p.getBoundingClientRect(); l = Math.min(l, b.left); r = Math.max(r, b.right); });
    return r - l; })()`;
async function graphWidth(frame: Frame): Promise<number> {
    return frame.evaluate(GRAPH_WIDTH_JS);
}
/** 図形幅が条件を満たすまで待つ（iframe の CSP が文字列評価を禁じるので waitForFunction ではなく poll） */
async function waitWidth(frame: Frame, ok: (w: number) => boolean): Promise<void> {
    await expect.poll(async () => ok(await graphWidth(frame)), { timeout: 5000 }).toBe(true);
}

test.describe('drawio viewer — ツールバー・操作（TASK-07）', () => {
    test('TC-DIO-22: 複数ページの切替', async ({ page }) => {
        await openDrawio(page, 'three-pages.drawio');
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'ONLY_ON_P1');
        const sel = page.locator('.viewer-drawio-page');
        await expect(sel).toBeVisible();
        expect(await sel.locator('option').allTextContents()).toEqual(['P1', 'P2', 'P3']);
        await sel.selectOption({ label: 'P2' });
        await waitForLabel(frame, 'ONLY_ON_P2');
        const text = await frame.evaluate(() => document.querySelector('#pane svg')!.textContent || '');
        expect(text).not.toContain('ONLY_ON_P1');
    });

    test('TC-DIO-23: 1 ページ・1 レイヤーならページ選択・レイヤーは出ない', async ({ page }) => {
        await openDrawio(page, 'aws-plain.drawio');
        await waitForLabel(await drawioFrame(page), 'LAMBDA_LABEL');
        await expect(page.locator('.viewer-drawio-page')).toBeHidden();
        await expect(page.locator('.viewer-drawio-layers')).toBeHidden();
    });

    test('TC-DIO-24: レイヤーの表示切替（ファイルは変更しない）', async ({ page }) => {
        await openDrawio(page, 'two-layers.drawio');
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'NET_LABEL');
        const posted0 = await page.evaluate(() => (window as any).__postedMessages.length);
        await page.locator('.viewer-drawio-layers').click();
        const menu = page.locator('.viewer-drawio-layer-menu');
        await expect(menu).toBeVisible();
        expect(await menu.locator('label').allTextContents()).toEqual(['Background', 'Network']);
        await menu.locator('label', { hasText: 'Network' }).locator('input').uncheck();
        await frame.waitForFunction(() => !(document.querySelector('#pane svg')!.textContent || '').includes('NET_LABEL'));
        expect(await frame.evaluate(() => document.querySelector('#pane svg')!.textContent)).toContain('BG_LABEL');
        await menu.locator('label', { hasText: 'Network' }).locator('input').check();
        await waitForLabel(frame, 'NET_LABEL');
        // レイヤー操作で host へのメッセージ（保存等）は飛ばない
        expect(await page.evaluate(() => (window as any).__postedMessages.length)).toBe(posted0);
    });

    test('TC-DIO-25: [+][−][⟲]', async ({ page }) => {
        await openDrawio(page, 'aws-plain.drawio');
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'LAMBDA_LABEL');
        const w0 = await graphWidth(frame);
        await page.locator('.viewer-zoom-in').click();
        await waitWidth(frame, (w) => w > w0 + 1);
        const w1 = await graphWidth(frame);
        await page.locator('.viewer-zoom-in').click();
        await waitWidth(frame, (w) => w > w1 + 1);
        await page.locator('.viewer-zoom-reset').click();
        await waitWidth(frame, (w) => Math.abs(w - w0) <= 2);
        await page.locator('.viewer-zoom-out').click();
        await waitWidth(frame, (w) => w < w0 - 1);
    });

    test('TC-DIO-26: Ctrl+ホイールは iframe 内でズーム（係数 exp(-deltaY*0.003)）、修飾なしはズームしない', async ({ page }) => {
        await openDrawio(page, 'aws-plain.drawio');
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'LAMBDA_LABEL');
        const box = (await page.locator('iframe.fv-drawio-frame').boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const w0 = await graphWidth(frame);
        await page.mouse.wheel(0, -100); // 修飾なし: ズームしない
        await page.waitForTimeout(150);
        expect(Math.abs((await graphWidth(frame)) - w0)).toBeLessThanOrEqual(1);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -100);
        await page.keyboard.up('Control');
        await waitWidth(frame, (w) => w > w0 + 1);
        const ratio = (await graphWidth(frame)) / w0;
        expect(Math.abs(ratio - Math.exp(0.3)) / Math.exp(0.3)).toBeLessThan(0.02);
        expect(await page.evaluate(() => window.visualViewport ? window.visualViewport.scale : 1)).toBe(1);
    });

    test('TC-DIO-33: ツールバーの全順序と find 非表示', async ({ page }) => {
        await openDrawio(page, 'three-pages.drawio');
        await waitForLabel(await drawioFrame(page), 'ONLY_ON_P1');
        const classes = await page.evaluate(() => [...document.querySelector('.viewer-toolbar')!.children].map((c) => c.className.split(' ')[0]));
        const i = classes.indexOf('viewer-title');
        expect(classes.slice(i, i + 7)).toEqual([
            'viewer-title', 'viewer-drawio-page', 'viewer-drawio-layers',
            'viewer-zoom-out', 'viewer-zoom-in', 'viewer-zoom-reset', 'viewer-open-external',
        ]);
        expect(classes).not.toContain('viewer-find-toggle');
        await page.locator('.viewer-title').click();
        await page.keyboard.press('ControlOrMeta+f');
        await expect(page.locator('.viewer-find-bar:visible')).toHaveCount(0);
    });
});

/**
 * ネットワークに実際に出た外部要求を数える。Playwright は CSP で止まった要求にも 'request' を出す
 * （failure = 'csp'）ため、route に届いた要求（= CSP を通過した要求）と requestfinished だけを数える
 */
async function trackExternal(page: Page): Promise<string[]> {
    const hits: string[] = [];
    await page.route(/external\.test|fonts\.googleapis\.com|fonts\.gstatic\.com/, (r) => { hits.push(r.request().url()); return r.fulfill({ status: 200, body: '' }); });
    page.on('requestfinished', (r) => {
        const u = r.url();
        if (!u.startsWith('http://localhost:3000') && !u.startsWith('blob:') && !u.startsWith('data:')) { hits.push(u); }
    });
    return hits;
}

test.describe('drawio viewer — セキュリティ・資源・失敗・性能（TASK-08）', () => {
    test('TC-DIO-31: 外部通信 0（notes 面と同じ緩い CSP のハーネス）', async ({ page }) => {
        const hits = await trackExternal(page);
        await openDrawio(page, 'external.drawio', '/standalone-viewer-notescsp.html');
        // 前提: このハーネスの外側 CSP は https 画像・Google Fonts を許す（notes 面と同じ）。止めているのは iframe 内の meta CSP
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'EXT_LABEL');
        await waitForLabel(frame, 'FONT_LABEL');
        await page.waitForTimeout(500);
        await openDrawio(page, 'aws-plain.drawio', '/standalone-viewer-notescsp.html');
        await waitForLabel(await drawioFrame(page), 'LAMBDA_LABEL');
        // notes 面の webview 本体が読む Inter フォント（googleapis）はハーネス本体の要求なので、iframe 発（external.test・Roboto）だけを見る
        expect(hits.filter((u) => /external\.test|family=Roboto/.test(u))).toEqual([]);
        await expect(page.locator('.viewer-error')).toHaveCount(0);
    });

    test('TC-DIO-32: 図中リンクで遷移しない', async ({ page, context }) => {
        const external = await trackExternal(page);
        await openDrawio(page, 'external.drawio');
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'LINK_LABEL');
        const before = frame.url();
        await frame.getByText('LINK_LABEL').click();
        await page.waitForTimeout(500);
        expect(external.filter((u) => /external\.test/.test(u))).toEqual([]);
        expect(frame.url()).toBe(before);
        expect(context.pages()).toHaveLength(1);
    });

    test('TC-DIO-34: sandbox は allow-scripts のみ、iframe → 親 window の postMessage は届かない', async ({ page }) => {
        await openDrawio(page, 'aws-plain.drawio');
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'LAMBDA_LABEL');
        expect(await page.locator('iframe.fv-drawio-frame').getAttribute('sandbox')).toBe('allow-scripts');
        await page.evaluate(() => {
            (window as any).__gotNull = 0;
            window.addEventListener('message', (e) => { if (e.origin === 'null') { (window as any).__gotNull++; } });
            (window as any).__postedMessages.length = 0;
        });
        await frame.evaluate(() => { parent.postMessage({ type: 'openExternalFallback', fileUri: 'x' }, '*'); });
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => (window as any).__gotNull)).toBe(0);
        expect(await page.evaluate(() => (window as any).__postedMessages.length)).toBe(0);
    });

    test('TC-DIO-35: 別ファイルを開くと blob revoke・port close・iframe とポップオーバーの除去・タイマー解除', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            const w = window as any;
            w.__revoked = []; w.__closed = 0; w.__timers = new Map(); w.__cleared = new Set();
            const rv = URL.revokeObjectURL.bind(URL);
            URL.revokeObjectURL = (u: string) => { w.__revoked.push(u); rv(u); };
            const cl = MessagePort.prototype.close;
            MessagePort.prototype.close = function () { w.__closed++; return cl.call(this); };
            const st = window.setTimeout.bind(window); const ct = window.clearTimeout.bind(window);
            (window as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => { const id = st(fn, ms, ...a); w.__timers.set(id, ms); return id; };
            (window as any).clearTimeout = (id: any) => { w.__cleared.add(id); ct(id); };
            w.__fileViewer.open('drawio', './viewer-fixtures/drawio/two-layers.drawio', document.getElementById('viewer-root'), '/tmp/two-layers.drawio');
        });
        const frame = await drawioFrame(page);
        await waitForLabel(frame, 'NET_LABEL');
        await page.locator('.viewer-drawio-layers').click();
        await expect(page.locator('.viewer-drawio-layer-menu')).toBeVisible();
        const src = await page.locator('iframe.fv-drawio-frame').getAttribute('src');
        fs.writeFileSync(path.join(DEST, 'note.txt'), 'hello');
        await page.evaluate(() => (window as any).__fileViewer.open('text', './viewer-fixtures/drawio/note.txt', document.getElementById('viewer-root'), '/tmp/note.txt'));
        await expect(page.locator('iframe.fv-drawio-frame')).toHaveCount(0);
        await expect(page.locator('.viewer-drawio-layer-menu')).toHaveCount(0);
        const r = await page.evaluate(() => {
            const w = window as any;
            const pending = [...w.__timers.entries()].filter(([id, ms]: any) => ms === 15000 && !w.__cleared.has(id));
            return { revoked: w.__revoked, closed: w.__closed, pending: pending.length };
        });
        expect(r.revoked).toContain(src);
        expect(r.closed).toBeGreaterThanOrEqual(1);
        expect(r.pending).toBe(0);
    });

    test('TC-DIO-36: 描画が時間内に終わらなければ失敗 UI', async ({ page }) => {
        // 返信を握りつぶす script をライブラリの代わりに埋め込ませる（rendered が来ない状態）
        await page.route('**/drawio-viewer/viewer-static.min.js', (r) => r.fulfill({ body: 'MessagePort.prototype.postMessage = function () {};', contentType: 'text/javascript' }));
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__viewerConfig.drawioRenderTimeoutMs = 1000;
            (window as any).__fileViewer.open('drawio', './viewer-fixtures/drawio/aws-plain.drawio', document.getElementById('viewer-root'), '/tmp/aws-plain.drawio');
        });
        await expect(page.locator('.viewer-error')).toContainText('Could not display this diagram', { timeout: 5000 });
        await expect(page.locator('iframe.fv-drawio-frame')).toHaveCount(0);
    });

    test('TC-DIO-37: 抽出 XML が 20MB 超なら tooLarge、ちょうどは通る', async ({ page }) => {
        const LIMIT = 20 * 1024 * 1024;
        const head = '<mxfile><diagram name="Big"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="BIG_LABEL" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell><!--';
        const tail = '--></root></mxGraphModel></diagram></mxfile>';
        const make = (n: number) => head + 'x'.repeat(n - head.length - tail.length) + tail;
        await page.route('**/big-over.drawio', (r) => r.fulfill({ body: make(LIMIT + 1), contentType: 'text/plain' }));
        await page.route('**/big-exact.drawio', (r) => r.fulfill({ body: make(LIMIT), contentType: 'text/plain' }));
        await openDrawio(page, 'big-over.drawio');
        await expect(page.locator('.viewer-error')).toContainText('too large', { timeout: 15000 });
        await openDrawio(page, 'big-exact.drawio');
        await waitForLabel(await drawioFrame(page), 'BIG_LABEL');
        await expect(page.locator('.viewer-error')).toHaveCount(0);
    });

    test('TC-DIO-38: 性能 — ライブラリは 1 回だけ取得、drawio 以外では取得しない', async ({ page }) => {
        const libReq: string[] = [];
        page.on('request', (r) => { if (/drawio-viewer\/(viewer-static|stencils)\.min\.js/.test(r.url())) { libReq.push(r.url()); } });
        fs.writeFileSync(path.join(DEST, 'note.txt'), 'hello');
        await page.goto('/standalone-viewer.html');
        const root = 'document.getElementById("viewer-root")';
        await page.evaluate(() => (window as any).__fileViewer.open('text', './viewer-fixtures/drawio/note.txt', document.getElementById('viewer-root'), '/tmp/note.txt'));
        await page.waitForSelector('.viewer-body');
        await page.waitForTimeout(300);
        expect(libReq).toHaveLength(0);
        void root;
        const openOnce = async () => {
            await page.evaluate(() => (window as any).__fileViewer.open('drawio', './viewer-fixtures/drawio/aws-plain.drawio', document.getElementById('viewer-root'), '/tmp/aws-plain.drawio'));
            await waitForLabel(await drawioFrame(page), 'LAMBDA_LABEL');
            await expect.poll(() => page.evaluate(() => (window as any).__fvDrawioTimings && (window as any).__fvDrawioTimings.rendered)).not.toBeNull();
            return page.evaluate(() => { const t = (window as any).__fvDrawioTimings; return t.rendered - t.start; });
        };
        const t1 = await openOnce();
        await page.evaluate(() => (window as any).__fileViewer.open('text', './viewer-fixtures/drawio/note.txt', document.getElementById('viewer-root'), '/tmp/note.txt'));
        const t2 = await openOnce();
        expect(libReq).toHaveLength(2); // viewer-static + stencils を 1 回ずつ
        expect(t1).toBeLessThan(2000);
        expect(t2).toBeLessThan(1000);
    });

    test('TC-DIO-39: ライブラリ取得に失敗しても、次に開いたときは描画できる', async ({ page }) => {
        await page.route('**/drawio-viewer/viewer-static.min.js', (r) => r.fulfill({ status: 404, body: '' }));
        await openDrawio(page, 'aws-plain.drawio');
        await expect(page.locator('.viewer-error')).toHaveCount(1, { timeout: 5000 });
        await page.unroute('**/drawio-viewer/viewer-static.min.js');
        await page.evaluate(() => (window as any).__fileViewer.open('drawio', './viewer-fixtures/drawio/aws-plain.drawio', document.getElementById('viewer-root'), '/tmp/aws-plain.drawio'));
        await waitForLabel(await drawioFrame(page), 'LAMBDA_LABEL');
    });
});
