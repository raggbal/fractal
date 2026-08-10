import { test, expect, Page } from '@playwright/test';

// Sprint 20260810-183054 TASK-05 (FR-TBL-04): Excel 表貼り付けの画像混入抑止(Kiro 経路)。
// Kiro keydown 分岐(navigator.clipboard.read)が rich HTML 判定なしに image を無条件挿入する
// 片肺配線を修正 — hasRichHtmlContent を module 化し両経路で共有。
//
// TC-KP-01..03 の駆動(tdd.md「クリップボード注入 2 系統」): 対象は async Clipboard API なので
// DataTransfer 合成 paste では到達しない → navigator.clipboard.read を明示 stub に差し替え
// (実 ClipboardItem と同じメソッド集合のみの明示オブジェクト — Proxy 禁止)+ keydown(Cmd+V)。
// 3 TC すべてに「Kiro 分岐到達の positive assert」(stub の read 呼び出し記録)必須。

const RICH_TABLE_HTML = '<table><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></table>';
// 1x1 transparent PNG
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function setupKiroClipboard(page: Page, opts: { html?: string; image?: boolean }) {
    await page.evaluate(({ html, image, png }) => {
        (window as any).__kiroEnvOverride = true;
        // saveImageAndInsert の呼び出し記録(recorder — 実 host メソッドを包む)
        (window as any).__savedImages = [];
        const api = (window as any).__testApi;
        // standalone は postMessage を記録する fake host — saveImageAndInsert 相当のメッセージを検出する
        // ため、直接 host を触らず window.__savedImages への記録 stub を EditorInstance の host に挿す。
        // standalone-editor.html は EditorInstance.instances 経由で host を持つ。
        const inst = (window as any).EditorInstance?.instances?.values?.().next?.()?.value
            || (window as any).editorInstance;
        const host = inst?.host || (window as any).host;
        if (host && typeof host.saveImageAndInsert === 'function') {
            const orig = host.saveImageAndInsert.bind(host);
            host.saveImageAndInsert = function (dataUrl: string, fileName?: string) {
                (window as any).__savedImages.push({ dataUrl: String(dataUrl).substring(0, 40), fileName });
                return orig(dataUrl, fileName);
            };
        } else {
            // host が見つからない場合でも記録だけはする(グローバル seam)
            (window as any).__saveImageRecorderFallback = true;
        }

        // navigator.clipboard.read の明示 stub(実 ClipboardItem と同じメソッド集合のみ)
        (window as any).__clipboardReadCalls = 0;
        const items: any[] = [];
        const enc = (s: string) => new Blob([s], { type: 'text/html' });
        const b64ToBlob = (b64: string) => {
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return new Blob([arr], { type: 'image/png' });
        };
        if (html !== undefined || image) {
            const types: string[] = [];
            const blobs: Record<string, Blob> = {};
            if (html !== undefined) { types.push('text/html'); blobs['text/html'] = enc(html); }
            if (image) { types.push('image/png'); blobs['image/png'] = b64ToBlob(png); }
            items.push({
                types,
                getType: async (t: string) => {
                    if (!blobs[t]) throw new Error('type not present: ' + t);
                    return blobs[t];
                },
            });
        }
        const clip = (navigator as any).clipboard || {};
        Object.defineProperty(navigator, 'clipboard', {
            value: {
                ...clip,
                read: async () => {
                    (window as any).__clipboardReadCalls++;
                    return items;
                },
            },
            configurable: true,
        });
    }, { html: opts.html, image: !!opts.image, png: PNG_BASE64 });
}

async function pressCmdV(page: Page) {
    await page.evaluate(() => {
        const editor = document.getElementById('editor')!;
        editor.innerHTML = '<p><br></p>';
        const p = editor.querySelector('p')!;
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        const ev = new KeyboardEvent('keydown', {
            key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true,
        });
        document.dispatchEvent(ev);
    });
    await page.waitForTimeout(400);
}

test.describe('Kiro paste image guard (FR-TBL-04)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-KP-01: Kiro + rich HTML table + image 並列 → image 不採用(表は paste イベント側が処理)
    // counterfactual: rich 判定を外すと saveImageAndInsert が呼ばれ RED
    test('TC-KP-01 rich HTML alongside image suppresses image insertion', async ({ page }) => {
        await setupKiroClipboard(page, { html: RICH_TABLE_HTML, image: true });
        await pressCmdV(page);
        const result = await page.evaluate(() => ({
            readCalls: (window as any).__clipboardReadCalls,
            savedImages: (window as any).__savedImages,
        }));
        // positive assert: Kiro 分岐に実際に到達した(false-green 防止)
        expect(result.readCalls).toBeGreaterThan(0);
        // rich HTML 同居 → image 不採用
        expect(result.savedImages).toHaveLength(0);
    });

    // TC-KP-02: Kiro + image のみ(HTML なし)→ 従来どおり画像挿入(over-broad 抑止の番人)
    test('TC-KP-02 image-only clipboard still inserts image', async ({ page }) => {
        await setupKiroClipboard(page, { image: true });
        await pressCmdV(page);
        const result = await page.evaluate(() => ({
            readCalls: (window as any).__clipboardReadCalls,
            savedImages: (window as any).__savedImages,
        }));
        expect(result.readCalls).toBeGreaterThan(0); // positive assert: 分岐到達
        expect(result.savedImages).toHaveLength(1);   // 画像は従来どおり挿入
    });

    // TC-KP-03: Kiro + SVG のみ HTML + image → image 採用(既存 SVG 例外が Kiro 経路でも同一)
    test('TC-KP-03 svg-only HTML alongside image keeps image insertion', async ({ page }) => {
        await setupKiroClipboard(page, {
            html: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
            image: true,
        });
        await pressCmdV(page);
        const result = await page.evaluate(() => ({
            readCalls: (window as any).__clipboardReadCalls,
            savedImages: (window as any).__savedImages,
        }));
        expect(result.readCalls).toBeGreaterThan(0); // positive assert: 分岐到達
        expect(result.savedImages).toHaveLength(1);   // SVG 単体は rich でない → image 採用
    });

    // TC-KP-04: 非 Kiro(override false)+ rich HTML + image → 既存経路の挙動不変(HTML paste 優先)
    test('TC-KP-04 non-Kiro path unchanged (HTML preferred over image)', async ({ page }) => {
        await page.evaluate(() => { (window as any).__kiroEnvOverride = false; });
        // 非 Kiro は paste イベント経路(DataTransfer 合成)
        await page.evaluate(({ html }) => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<p><br></p>';
            const p = editor.querySelector('p')!;
            const range = document.createRange();
            range.selectNodeContents(p);
            range.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            const clipboardData = {
                _data: { 'text/plain': '', 'text/html': html } as Record<string, string>,
                getData: function (type: string) { return this._data[type] || ''; },
                setData: function (type: string, value: string) { this._data[type] = value; },
                // rich HTML + image item 並列(既存 hasRichHtmlContent が image を捨てる)
                items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
            };
            const event = new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
            });
            Object.defineProperty(event, 'clipboardData', {
                value: clipboardData, writable: false, configurable: true,
            });
            editor.dispatchEvent(event);
        }, { html: RICH_TABLE_HTML });
        await page.waitForTimeout(400);
        const result = await page.evaluate(() => ({
            tableCount: document.querySelectorAll('#editor table').length,
        }));
        expect(result.tableCount).toBe(1); // HTML paste が優先され表が入る
    });

    // TC-KP-05: hasRichHtmlContent module 化後の判定不変(全既存分岐)
    test('TC-KP-05 hasRichHtmlContent decision table unchanged after module hoist', async ({ page }) => {
        const results = await page.evaluate(() => {
            const fn = (window as any).__hasRichHtmlContentForTest;
            if (typeof fn !== 'function') return { error: 'not exposed' };
            return {
                svgOnly: fn('<svg xmlns="x"><rect/></svg>'),
                divSvg: fn('<div class="x"><svg><rect/></svg></div>'),
                imgOnly: fn('<img src="a.png">'),
                richText: fn('<p>hello</p>'),
                richTable: fn('<table><tr><td>a</td></tr></table>'),
                empty: fn(''),
            };
        });
        expect((results as any).error).toBeUndefined();
        expect(results.svgOnly).toBe(false);
        expect(results.divSvg).toBe(false);
        expect(results.imgOnly).toBe(false);
        expect(results.richText).toBe(true);
        expect(results.richTable).toBe(true);
        expect(results.empty).toBe(false);
    });
});
