/**
 * viewer ズーム/パン統一（FR-VZP-01..05 / ADRL-0100）
 * sprint 20260825-224210-viewer-zoom-pan
 *
 * ハーネス: standalone-viewer.html（pdf のみ実レンダ待ち）。
 * ピンチ TC は合成 WheelEvent（ctrlKey/metaKey, cancelable:true）— 妥当性裁定は design §6
 * （wheel は合成と実デバイスで発火条件同一・実機ピンチは US-01/02 手動検収）。
 * パン TC（TASK-02 以降）は実マウス必須（generator_failures 2026-08-10）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// TC-VZP-18 用 fixture（viewer-fixtures/ は gitignored — 規約どおり beforeAll で自己生成）
test.beforeAll(() => {
    const dir = path.resolve(__dirname, '..', 'html', 'viewer-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-100vh.html'), [
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>app-100vh</title>',
        '<style>html,body{margin:0;padding:0}.app{display:flex;height:100vh}',
        '.side{width:220px;background:#1f2937;color:#fff;flex:none}',
        '.main{flex:1;background:#f8fafc;padding:16px}</style></head>',
        '<body><div class="app"><nav class="side"><h2>MENU</h2></nav>',
        '<main class="main"><h1>Dashboard</h1><p>100vh app layout fixture (TC-VZP-18)</p></main>',
        '</div></body></html>',
    ].join(''));
});

async function openPdfAt(page, width = 800) {
    await page.goto('/standalone-viewer.html');
    await page.evaluate((w) => {
        const root = document.getElementById('viewer-root')!;
        root.style.width = w + 'px'; root.style.height = '600px'; root.style.position = 'relative';
    }, width);
    await page.evaluate(() => (window as any).__fileViewer.open(
        'pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'), '/x/ja-en.pdf'));
    await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30000 });
    await page.waitForTimeout(300);
}

/** container 中央付近へ合成 wheel を dispatch し defaultPrevented を返す */
async function dispatchWheel(page, sel: string, init: Record<string, unknown>) {
    return page.evaluate(({ sel, init }) => {
        const el = document.querySelector(sel) as HTMLElement;
        const r = el.getBoundingClientRect();
        const ev = new WheelEvent('wheel', Object.assign({
            bubbles: true, cancelable: true,
            clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.4,
        }, init));
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
    }, { sel, init });
}

const pdfScale = (page) => page.evaluate(() => {
    const v = document.querySelector('.pdfViewer') as HTMLElement;
    return v ? parseFloat(getComputedStyle(v).getPropertyValue('--scale-factor')) : NaN;
});

test.describe('FR-VZP-01/02/05: pdf ピンチズーム + ボタン + クランプ', () => {

    test('TC-VZP-01: ピンチ（ctrl+wheel）で不動点ズーム（updateScale 経路・scale 数値化）+ ボタン増減', async ({ page }) => {
        await openPdfAt(page);
        const before = await pdfScale(page);

        // ピンチイン（拡大 = deltaY 負）
        await dispatchWheel(page, '.viewer-pdf-container', { ctrlKey: true, deltaY: -300 });
        await page.waitForTimeout(600);   // drawingDelay 400ms + 余裕
        const zoomed = await pdfScale(page);
        expect(zoomed, 'ピンチで scale が増える').toBeGreaterThan(before);

        // 手動ズーム（ピンチ）後は refit が停止する（FR-FV-23 / TC-PWR-03 と同型の挙動検証）。
        // 【許可: test_update — reviewer iter1 QUAL-1】旧 assert は src 未実装の観測点
        // __lastPdfScaleValue への「無ければ true」フォールバックで常時 green のトートロジーだった。
        // currentScaleValue 数値化の帰結 =「mount 幅を変えても --scale-factor が preset 復帰しない」を直接測る
        await page.evaluate(() => {
            (document.getElementById('viewer-root') as HTMLElement).style.width = '500px';
        });
        await page.waitForTimeout(500);
        const afterResize = await pdfScale(page);
        expect(Math.abs(afterResize - zoomed), 'ピンチ後は幅変化で refit しない（scale 不変）')
            .toBeLessThanOrEqual(0.02);
        await page.evaluate(() => {
            (document.getElementById('viewer-root') as HTMLElement).style.width = '800px';
        });
        await page.waitForTimeout(500);

        // ボタン: [+] で増・[−] で減（increaseScale/decreaseScale 経由）
        const s1 = await pdfScale(page);
        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(300);
        const s2 = await pdfScale(page);
        expect(s2, '[+] で増える').toBeGreaterThan(s1);
        await page.click('.viewer-zoom-out');
        await page.waitForTimeout(300);
        const s3 = await pdfScale(page);
        expect(s3, '[−] で減る').toBeLessThan(s2);
    });

    test('TC-VZP-08: (ctrl||meta)+wheel は defaultPrevented / 素の wheel は preventDefault しない', async ({ page }) => {
        await openPdfAt(page);
        expect(await dispatchWheel(page, '.viewer-pdf-container', { ctrlKey: true, deltaY: -100 }),
            'ctrl+wheel は preventDefault（VS Code ズーム抑止）').toBe(true);
        expect(await dispatchWheel(page, '.viewer-pdf-container', { metaKey: true, deltaY: -100 }),
            'meta+wheel も preventDefault').toBe(true);
        expect(await dispatchWheel(page, '.viewer-pdf-container', { deltaY: -100 }),
            '素の wheel はスクロール温存（preventDefault しない）').toBe(false);
    });

    test('TC-VZP-15(pdf): クランプ境界 — 連打で上限/下限に達し例外なし', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openPdfAt(page);
        for (let i = 0; i < 32; i++) { await page.click('.viewer-zoom-in'); }   // 1.1 刻み × 32 で内部上限へ確実に到達
        await page.waitForTimeout(500);
        const max = await pdfScale(page);
        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(300);
        expect(await pdfScale(page), '上限で止まる').toBeLessThanOrEqual(max + 0.01);

        for (let i = 0; i < 55; i++) { await page.click('.viewer-zoom-out'); }   // 1.1 刻みで内部下限へ
        await page.waitForTimeout(500);
        const min = await pdfScale(page);
        await page.click('.viewer-zoom-out');
        await page.waitForTimeout(300);
        expect(await pdfScale(page), '下限で止まる').toBeGreaterThanOrEqual(min - 0.01);
        expect(min).toBeGreaterThan(0);
        expect(errors, '境界連打で例外なし').toEqual([]);
    });
});

// ── TASK-02: PDF ドラッグパン（FR-VZP-03・実マウス必須） ─────────────────────
async function zoomInTimes(page, n: number) {
    for (let i = 0; i < n; i++) { await page.click('.viewer-zoom-in'); }
    await page.waitForTimeout(600);
}
const scrollPos = (page) => page.evaluate(() => {
    const c = document.querySelector('.viewer-pdf-container') as HTMLElement;
    return { l: c.scrollLeft, t: c.scrollTop };
});
/** テキスト span でも annotation でもない「パン可能な点」を探す（viewport 座標） */
async function panSafePoint(page) {
    return page.evaluate(() => {
        const c = document.querySelector('.viewer-pdf-container') as HTMLElement;
        const r = c.getBoundingClientRect();
        for (const [fx, fy] of [[0.05, 0.5], [0.5, 0.03], [0.95, 0.5], [0.5, 0.97], [0.5, 0.5]]) {
            const x = r.left + r.width * fx, y = r.top + r.height * fy;
            const el = document.elementFromPoint(x, y);
            if (!el) { continue; }
            const inText = el.closest('.textLayer') && el.tagName === 'SPAN' && (el.textContent || '').length > 0;
            const inAnno = el.closest('.annotationLayer');
            if (!inText && !inAnno) { return { x, y }; }
        }
        return null;
    });
}
/** テキスト span の中心点（viewport 座標） */
async function textSpanPoint(page) {
    return page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('.pdfViewer .textLayer span')) as HTMLElement[];
        const c = (document.querySelector('.viewer-pdf-container') as HTMLElement).getBoundingClientRect();
        for (const sp of spans) {
            if ((sp.textContent || '').trim().length <= 3) { continue; }
            const r = sp.getBoundingClientRect();
            // container 可視域内 + 実際にヒットする（前面に他要素がない）ものだけ
            if (r.top < c.top + 4 || r.bottom > c.bottom - 4 || r.left < c.left + 4 || r.right > c.right - 4) { continue; }
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const hit = document.elementFromPoint(x, y);
            if (hit && hit.closest('.textLayer') && hit.tagName === 'SPAN') { return { x, y }; }
        }
        return null;
    });
}

test.describe('FR-VZP-03: PDF ドラッグパン', () => {

    test('TC-VZP-11: 余白/canvas からの実マウスドラッグでパン（scroll が追従）', async ({ page }) => {
        await openPdfAt(page, 600);
        await zoomInTimes(page, 8);   // あふれさせる
        // ズーム直後は scroll が端に寄っていることがある → 中央へセットしてから両方向に余裕を持つ
        await page.evaluate(() => {
            const c = document.querySelector('.viewer-pdf-container') as HTMLElement;
            c.scrollLeft = Math.max(80, (c.scrollWidth - c.clientWidth) / 2);
            c.scrollTop = Math.max(80, (c.scrollHeight - c.clientHeight) / 2);
        });
        const p = await panSafePoint(page);
        expect(p, 'パン可能な点が存在').not.toBeNull();
        const before = await scrollPos(page);
        await page.mouse.move(p!.x, p!.y);
        await page.mouse.down();
        await page.mouse.move(p!.x + 60, p!.y + 50, { steps: 8 });   // 右下ドラッグ = scroll は減る向き
        await page.mouse.up();
        const after = await scrollPos(page);
        expect(before.l - after.l, '左方向へスクロール（ドラッグと逆向き）').toBeGreaterThan(30);
        expect(before.t - after.t, '上方向へスクロール').toBeGreaterThan(25);
    });

    test('TC-VZP-12: テキスト span 上からの実マウスドラッグは選択（scroll 不変）', async ({ page }) => {
        await openPdfAt(page, 600);
        await zoomInTimes(page, 4);
        const p = await textSpanPoint(page);
        expect(p, '可視のテキスト span が存在').not.toBeNull();
        const before = await scrollPos(page);
        await page.mouse.move(p!.x - 10, p!.y);
        await page.mouse.down();
        await page.mouse.move(p!.x + 40, p!.y, { steps: 6 });
        await page.mouse.up();
        const after = await scrollPos(page);
        const selLen = await page.evaluate(() => String(window.getSelection() || '').length);
        expect(selLen, 'テキストが選択される').toBeGreaterThan(0);
        expect(Math.abs(after.l - before.l) + Math.abs(after.t - before.t), 'scroll は動かない').toBeLessThanOrEqual(1);
    });

    test('TC-VZP-13: 3px 未満の down/up は click（scroll 不変・パン化しない）', async ({ page }) => {
        await openPdfAt(page, 600);
        await zoomInTimes(page, 8);
        const p = await panSafePoint(page);
        const before = await scrollPos(page);
        await page.mouse.move(p!.x, p!.y);
        await page.mouse.down();
        await page.mouse.move(p!.x + 1, p!.y + 1);
        await page.mouse.up();
        const after = await scrollPos(page);
        expect(Math.abs(after.l - before.l) + Math.abs(after.t - before.t)).toBeLessThanOrEqual(1);
    });

    test('TC-VZP-14: 中ボタンドラッグはテキスト span 上からでもパン', async ({ page }) => {
        await openPdfAt(page, 600);
        await zoomInTimes(page, 8);
        await page.evaluate(() => {
            const c = document.querySelector('.viewer-pdf-container') as HTMLElement;
            c.scrollLeft = Math.max(80, (c.scrollWidth - c.clientWidth) / 2);
            c.scrollTop = Math.max(80, (c.scrollHeight - c.clientHeight) / 2);
        });
        const p = await textSpanPoint(page) || await panSafePoint(page);
        const before = await scrollPos(page);
        await page.mouse.move(p!.x, p!.y);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(p!.x + 80, p!.y + 40, { steps: 6 });
        await page.mouse.up({ button: 'middle' });
        const after = await scrollPos(page);
        expect(before.l - after.l, '中ボタンでパン').toBeGreaterThan(30);
    });
});

// ── TASK-03: pptx ピンチ（FR-VZP-01） ─────────────────────────────────────
test.describe('FR-VZP-01: pptx ピンチズーム', () => {
    test('TC-VZP-02: ピンチで setScale が増加 + 不動点スクロール補正 + defaultPrevented', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            const root = document.getElementById('viewer-root')!;
            root.style.width = '700px'; root.style.height = '500px'; root.style.position = 'relative';
            (window as any).__fileViewer.open('pptx', './viewer-fixtures/deck.pptx', root, '/tmp/deck.pptx');
        });
        await page.waitForSelector('.ppv-slide', { timeout: 20000 });
        await page.waitForTimeout(300);

        // 3 枚目のスライドまでスクロールしておく（不動点補正の観測用）
        await page.evaluate(() => {
            const slides = document.querySelectorAll('.ppv-slide');
            (slides[2] as HTMLElement).scrollIntoView();
        });
        await page.waitForTimeout(200);
        const before = await page.evaluate(() => {
            const s = document.querySelector('.ppv-slide') as HTMLElement;
            const sc = s.closest('.viewer-body') as HTMLElement;
            return { w: s.getBoundingClientRect().width, st: sc.scrollTop };
        });

        const scEl = await page.evaluate(() => {
            const sc = document.querySelector('.viewer-body') as HTMLElement;
            const r = sc.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        const prevented = await page.evaluate(({ x, y }) => {
            const sc = document.querySelector('.viewer-body') as HTMLElement;
            const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -300, clientX: x, clientY: y });
            sc.dispatchEvent(ev);
            return ev.defaultPrevented;
        }, scEl);
        await page.waitForTimeout(300);

        const after = await page.evaluate(() => {
            const s = document.querySelector('.ppv-slide') as HTMLElement;
            const sc = s.closest('.viewer-body') as HTMLElement;
            return { w: s.getBoundingClientRect().width, st: sc.scrollTop };
        });
        expect(prevented, 'ctrl+wheel は preventDefault').toBe(true);
        expect(after.w, 'スライド幅が拡大').toBeGreaterThan(before.w * 1.2);
        expect(after.st, '不動点補正で scrollTop が追随（拡大に比例して増える）').toBeGreaterThan(before.st);
    });
});

// ── TASK-04: docx ピンチ + ボタン（FR-VZP-01/02） ──────────────────────────
test.describe('FR-VZP-01/02: docx ズーム', () => {
    test('TC-VZP-03 + TC-VZP-09(docx): ピンチとボタンで実効 scale が変わる', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            const root = document.getElementById('viewer-root')!;
            root.style.width = '900px'; root.style.height = '500px'; root.style.position = 'relative';
            (window as any).__fileViewer.open('docx', './viewer-fixtures/doc.docx', root, '/tmp/doc.docx');
        });
        await page.waitForSelector('.dxv-page', { timeout: 20000 });
        await page.waitForTimeout(200);
        const w0 = await page.evaluate(() => (document.querySelector('.dxv-page') as HTMLElement).getBoundingClientRect().width);

        // ボタン存在 + click（TC-VZP-09 docx 分）
        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(150);
        const w1 = await page.evaluate(() => (document.querySelector('.dxv-page') as HTMLElement).getBoundingClientRect().width);
        expect(w1, '[+] で拡大').toBeGreaterThan(w0 * 1.1);

        // ピンチ（縮小方向も）
        const prevented = await page.evaluate(() => {
            const body = document.querySelector('.viewer-body') as HTMLElement;
            const r = body.getBoundingClientRect();
            const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 400,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
            body.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        await page.waitForTimeout(150);
        const w2 = await page.evaluate(() => (document.querySelector('.dxv-page') as HTMLElement).getBoundingClientRect().width);
        expect(prevented, 'ctrl+wheel は preventDefault').toBe(true);
        expect(w2, 'ピンチアウト（縮小）で幅が減る').toBeLessThan(w1);
    });
});

// ── TASK-05: text ズーム（FR-VZP-01/02） ──────────────────────────────────
test.describe('FR-VZP-01/02: text ズーム', () => {
    test('TC-VZP-04 + TC-VZP-09(text): ボタン/ピンチで font-size 倍率が変わる・チャンク表示維持', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            const root = document.getElementById('viewer-root')!;
            root.style.width = '700px'; root.style.height = '500px'; root.style.position = 'relative';
            (window as any).__fileViewer.open('text', './viewer-fixtures/dummy.txt', root, '/tmp/dummy.txt');
        });
        await page.waitForSelector('.fv-text', { timeout: 15000 });
        await page.waitForTimeout(200);
        const fs0 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.fv-text')!).fontSize));

        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(100);
        const fs1 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.fv-text')!).fontSize));
        expect(fs1, '[+] で font-size 増').toBeGreaterThan(fs0 * 1.1);

        const prevented = await page.evaluate(() => {
            const el = document.querySelector('.fv-text') as HTMLElement;
            const r = el.getBoundingClientRect();
            const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 400,
                clientX: r.left + 50, clientY: r.top + 50 });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        await page.waitForTimeout(100);
        const fs2 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.fv-text')!).fontSize));
        expect(prevented, 'ctrl+wheel は preventDefault').toBe(true);
        expect(fs2, 'ピンチアウトで font-size 減').toBeLessThan(fs1);
        // チャンク表示（行）が維持されている
        expect(await page.evaluate(() => document.querySelectorAll('.fv-text .fv-lt').length)).toBeGreaterThan(0);
    });
});

// ── TASK-06: xlsx ズーム（geometry 再構築 — FR-VZP-01/02/05） ────────────────
async function openXlsx(page) {
    await page.goto('/standalone-viewer.html');
    await page.evaluate(() => {
        const root = document.getElementById('viewer-root')!;
        root.style.width = '800px'; root.style.height = '500px'; root.style.position = 'relative';
        (window as any).__fileViewer.open('xlsx', './viewer-fixtures/grid.xlsx', root, '/tmp/grid.xlsx');
    });
    await page.waitForSelector('.xlv-cell', { timeout: 20000 });
    await page.waitForTimeout(200);
}
const xlsxMetrics = (page) => page.evaluate(() => {
    const hdr = document.querySelector('.xlv-colhdr-inner > div') as HTMLElement;   // 先頭列ヘッダ
    const root = document.querySelector('.xlv-root') as HTMLElement;
    const vp = document.querySelector('.xlv-viewport') as HTMLElement | null;
    return {
        colW: hdr ? hdr.getBoundingClientRect().width : -1,
        fontPx: root ? parseFloat(getComputedStyle(root).fontSize) : -1,
        cells: document.querySelectorAll('.xlv-cell').length,
    };
});

test.describe('FR-VZP-01/02/05: xlsx ズーム（geometry 再構築）', () => {
    test('TC-VZP-05 + TC-VZP-09(xlsx): ピンチ/ボタンで列幅・フォントが倍率変化しグリッドが機能維持', async ({ page }) => {
        await openXlsx(page);
        const m0 = await xlsxMetrics(page);
        expect(m0.cells).toBeGreaterThan(0);

        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(400);
        const m1 = await xlsxMetrics(page);
        expect(m1.colW, '[+] で列幅が拡大').toBeGreaterThan(m0.colW * 1.1);
        expect(m1.fontPx, 'フォントも倍率追随').toBeGreaterThan(m0.fontPx * 1.05);
        expect(m1.cells, '再構築後もセルが描画されている').toBeGreaterThan(0);

        const prevented = await page.evaluate(() => {
            const el = document.querySelector('.xlv-root') as HTMLElement;
            const r = el.getBoundingClientRect();
            const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 400,
                clientX: r.left + 200, clientY: r.top + 200 });
            (document.elementFromPoint(r.left + 200, r.top + 200) || el).dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        await page.waitForTimeout(400);
        const m2 = await xlsxMetrics(page);
        expect(prevented, 'ctrl+wheel は preventDefault').toBe(true);
        expect(m2.colW, 'ピンチアウトで縮小').toBeLessThan(m1.colW);
    });

    test('TC-VZP-15(xlsx): 極端倍率でも geometry 再構築が破綻しない（境界番人）', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openXlsx(page);
        for (let i = 0; i < 12; i++) { await page.click('.viewer-zoom-in'); await page.waitForTimeout(80); }
        let m = await xlsxMetrics(page);
        expect(m.cells, '上限側でもセル描画').toBeGreaterThan(0);
        for (let i = 0; i < 24; i++) { await page.click('.viewer-zoom-out'); await page.waitForTimeout(80); }
        m = await xlsxMetrics(page);
        expect(m.cells, '下限側でもセル描画').toBeGreaterThan(0);
        // スクロール・シートタブが生存
        await page.evaluate(() => { const v = document.querySelector('.xlv-viewport') as HTMLElement; if (v) { v.scrollTop = 100; } });
        expect(errors, '境界連打で例外なし').toEqual([]);
    });
});

// ── TASK-07: html ズーム（iframe 注入 — FR-VZP-01/02） ─────────────────────
test.describe('FR-VZP-01/02: html ズーム（iframe 内）', () => {
    test('TC-VZP-06 + TC-VZP-09(html): iframe 内ピンチ/親ボタンで zoom・rerender 後も維持', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            const root = document.getElementById('viewer-root')!;
            root.style.width = '800px'; root.style.height = '500px'; root.style.position = 'relative';
            (window as any).__fileViewer.open('html', './viewer-fixtures/plain-text.html', root, '/tmp/plain-text.html');
        });
        await page.waitForSelector('.viewer-html-frame', { timeout: 15000 });
        await page.waitForTimeout(600);   // iframe load + find/zoom チャネル init
        const frame = page.frameLocator('.viewer-html-frame');
        await frame.locator('body').waitFor({ timeout: 10000 });

        // 【許可: test_update — 再オープン① FR-VZP-02b/ADRL-0101】観測点を iframe 内
        // documentElement.style.zoom から親側 iframe 要素の transform: scale(z) へ改訂
        //（html zoom v2 = 親側 iframe scale。倍率状態は完全に親が保持）
        const zoomOf = () => page.evaluate(() => {
            const el = document.querySelector('.viewer-html-frame') as HTMLElement;
            const m = /scale\(([0-9.]+)\)/.exec(el.style.transform || '');
            return m ? parseFloat(m[1]) : 1;
        });

        // 親の [+] ボタン → iframe 内 zoom が増える（TC-VZP-09 html 分）
        const z0 = await zoomOf();
        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(300);
        const z1 = await zoomOf();
        expect(z1, '[+] で iframe zoom 増').toBeGreaterThan(z0 * 1.1);

        // iframe 内ピンチ（ctrl+wheel）→ zoom 減 + iframe 内 defaultPrevented
        const inner = page.frames().slice(-1)[0];
        const prevented = await inner.evaluate(() => {
            const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 400, clientX: 100, clientY: 100 });
            document.body.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        await page.waitForTimeout(200);
        const z2 = await zoomOf();
        expect(prevented, 'iframe 内 ctrl+wheel は preventDefault').toBe(true);
        expect(z2, 'ピンチアウトで減').toBeLessThan(z1);

        // rerenderHtml（スクリプト許可トグル）後も倍率維持（親が load 時に再適用）
        await page.click('.viewer-script-toggle');
        await page.waitForTimeout(800);
        const z3 = await zoomOf();
        expect(Math.abs(z3 - z2), 'rerender 後も倍率維持').toBeLessThan(0.05);
    });

    test('TC-VZP-18: 100vh アプリ型ページが zoom out でもペイン全体を埋める（reflow 実測）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            const root = document.getElementById('viewer-root')!;
            root.style.width = '800px'; root.style.height = '500px'; root.style.position = 'relative';
            (window as any).__fileViewer.open('html', './viewer-fixtures/app-100vh.html', root, '/tmp/app-100vh.html');
        });
        await page.waitForSelector('.viewer-html-frame', { timeout: 15000 });
        await page.waitForTimeout(600);
        const frame = page.frameLocator('.viewer-html-frame');
        await frame.locator('.app').waitFor({ timeout: 10000 });

        const boxOf = () => page.evaluate(() => {
            const host = (document.querySelector('.viewer-html-frame') as HTMLElement).parentElement!;
            const r = (document.querySelector('.viewer-html-frame') as HTMLElement).getBoundingClientRect();
            const c = host.getBoundingClientRect();
            return { fw: r.width, fh: r.height, cw: c.width, ch: c.height };
        });
        const b0 = await boxOf();

        // zoom out ×2（1/1.25^2 = 0.64）
        await page.click('.viewer-zoom-out');
        await page.click('.viewer-zoom-out');
        await page.waitForTimeout(400);

        // (a) 視覚 box はペインを埋めたまま（v1.3.10 バグ = 右下余白 の番人）
        const b1 = await boxOf();
        expect(Math.abs(b1.fw - b0.cw), 'zoom out 後も iframe 視覚幅 = コンテナ幅').toBeLessThan(3);
        expect(Math.abs(b1.fh - b0.ch), 'zoom out 後も iframe 視覚高 = コンテナ高').toBeLessThan(3);

        // (b) 内部ビューポートは CSS px で広がる（reflow の実証 — CSS zoom 方式では起きない）
        const innerW = await page.frames().slice(-1)[0].evaluate(() => document.documentElement.clientWidth);
        expect(innerW, '内部ビューポート幅が 100/z 倍へ拡大').toBeGreaterThan(b0.cw * 1.4);

        // (c) 100vh の app 箱も広がった内部ビューポートを埋める（vh reflow）
        const appH = await page.frames().slice(-1)[0].evaluate(() => {
            const el = document.querySelector('.app') as HTMLElement;
            return { app: el.getBoundingClientRect().height, vp: document.documentElement.clientHeight };
        });
        expect(Math.abs(appH.app - appH.vp), '100vh 箱が内部ビューポート高と一致').toBeLessThan(3);
    });
});

// ── FR-VZP-04: image は実装変更なし — ctrl 変種の回帰 pin ────────────────────
test.describe('FR-VZP-04: image ctrl 変種回帰 pin', () => {
    test('TC-VZP-07: ctrlKey 付き wheel でも既存 zoomAt 経路でズーム（無条件 preventDefault 経路の変種）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => (window as any).__fileViewer.open(
            'image', './viewer-fixtures/pic.png', document.getElementById('viewer-root'), '/tmp/pic.png'));
        await page.waitForSelector('.fv-image-stage img');
        await page.waitForFunction(() => !!(window as any).__fvImageState);
        const s0 = await page.evaluate(() => (window as any).__fvImageState.scale);
        const prevented = await page.evaluate(() => {
            const stage = document.querySelector('.fv-image-stage')!;
            const r = stage.getBoundingClientRect();
            const ev = new WheelEvent('wheel', {
                bubbles: true, cancelable: true, ctrlKey: true, deltaY: -240,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            });
            stage.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        const s1 = await page.evaluate(() => (window as any).__fvImageState.scale);
        expect(prevented, 'image は無条件 preventDefault（FR-VZP-04 — ctrl 変種でも同じ）').toBe(true);
        expect(s1, 'ctrl+wheel（deltaY<0）で拡大 — 既存 zoomAt 経路').toBeGreaterThan(s0);
    });
});

// ── TASK-13（reviewer iter1 QUAL-3）: xlsx 高頻度ピンチバースト頑健性 ──────────
test.describe('FR-VZP-01: xlsx バースト頑健性', () => {
    test('TC-VZP-17: 待ちなし連続ピンチでもエラーなし・zoom 反映・busy が永久ロックしない', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await openXlsx(page);
        const m0 = await xlsxMetrics(page);

        // 実機ピンチ相当: 待ちなしで 15 発連続 dispatch（zoomBusy 中の要求 drop は許容仕様 —
        // ここで pin するのは「落ちない・終端で反映される・busy が解放される」の 3 点のみ）
        await page.evaluate(() => {
            const el = document.querySelector('.xlv-root') as HTMLElement;
            const r = el.getBoundingClientRect();
            for (let i = 0; i < 15; i++) {
                const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
                    deltaY: -200, clientX: r.left + 200, clientY: r.top + 200 });
                (document.elementFromPoint(r.left + 200, r.top + 200) || el).dispatchEvent(ev);
            }
        });
        await page.waitForTimeout(1500);   // 再構築の settle
        const m1 = await xlsxMetrics(page);
        expect(errors, 'ページエラーなし').toEqual([]);
        expect(m1.colW, 'バースト終端で zoom が反映（少なくとも 1 段拡大）').toBeGreaterThan(m0.colW * 1.05);
        expect(m1.cells, 'グリッド機能維持').toBeGreaterThan(0);

        // busy が永久ロックしない: バースト後の単発操作が通常どおり効く
        await page.click('.viewer-zoom-out');
        await page.waitForTimeout(500);
        const m2 = await xlsxMetrics(page);
        expect(m2.colW, 'バースト後も [−] が効く（busy 解放済み）').toBeLessThan(m1.colW);
    });
});

// ── 再オープン① TASK-15（FR-VZP-06）: ⟲ zoom リセット ─────────────────────
test.describe('FR-VZP-06: ⟲ zoom リセット（6 kind 全列挙 + image 負 assert）', () => {
    test('TC-VZP-19: ズーム後 ⟲ で初期倍率へ復帰（pdf は refit 再開も対で）', async ({ page }) => {
        test.setTimeout(120000);
        const openAt = async (kind: string, file: string, waitSel: string, w = 800) => {
            await page.goto('/standalone-viewer.html');
            await page.evaluate(({ kind, file, w }) => {
                const root = document.getElementById('viewer-root')!;
                root.style.width = w + 'px'; root.style.height = '500px'; root.style.position = 'relative';
                (window as any).__fileViewer.open(kind, `./viewer-fixtures/${file}`, root, `/tmp/${file}`);
            }, { kind, file, w });
            await page.waitForSelector(waitSel, { timeout: 30000 });
            await page.waitForTimeout(300);
        };
        const zoomInTwice = async () => {
            await page.click('.viewer-zoom-in'); await page.click('.viewer-zoom-in');
            await page.waitForTimeout(400);
        };
        const reset = async () => { await page.click('.viewer-zoom-reset'); await page.waitForTimeout(500); };

        // pdf: scale が初期値へ + preset 復帰で幅追従（refit）が再開する
        await openAt('pdf', 'ja-en.pdf', '.pdfViewer .page canvas');
        const p0 = await pdfScale(page);
        await zoomInTwice();
        expect(await pdfScale(page)).toBeGreaterThan(p0 * 1.1);
        await reset();
        const p1 = await pdfScale(page);
        expect(Math.abs(p1 - p0), 'pdf: ⟲ で初期 scale へ').toBeLessThan(0.03);
        await page.evaluate(() => { (document.getElementById('viewer-root') as HTMLElement).style.width = '500px'; });
        await page.waitForTimeout(600);
        expect(await pdfScale(page), 'pdf: ⟲ 後は幅追従（refit）が再開').toBeLessThan(p1 - 0.02);

        // pptx: スライド幅が初期値へ
        await openAt('pptx', 'deck.pptx', '.ppv-slide', 700);
        const slideW = () => page.evaluate(() => (document.querySelector('.ppv-slide') as HTMLElement).getBoundingClientRect().width);
        const s0 = await slideW();
        await zoomInTwice();
        expect(await slideW()).toBeGreaterThan(s0 * 1.2);
        await reset();
        expect(Math.abs((await slideW()) - s0), 'pptx: ⟲ で fit 幅へ').toBeLessThan(4);

        // docx: page card 幅が初期値へ
        await openAt('docx', 'doc.docx', '.dxv-page', 900);
        const pageW = () => page.evaluate(() => (document.querySelector('.dxv-page') as HTMLElement).getBoundingClientRect().width);
        const d0 = await pageW();
        await zoomInTwice();
        expect(await pageW()).toBeGreaterThan(d0 * 1.2);
        await reset();
        expect(Math.abs((await pageW()) - d0), 'docx: ⟲ で userScale=1 へ').toBeLessThan(4);

        // text: font-size が基準へ
        await openAt('text', 'dummy.txt', '.fv-text');
        const fs2 = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.fv-text')!).fontSize));
        const t0 = await fs2();
        await zoomInTwice();
        expect(await fs2()).toBeGreaterThan(t0 * 1.2);
        await reset();
        expect(Math.abs((await fs2()) - t0), 'text: ⟲ で倍率 1 へ').toBeLessThan(0.6);

        // xlsx: 列幅が初期値へ
        await openAt('xlsx', 'grid.xlsx', '.xlv-cell');
        const colW = () => page.evaluate(() => {
            const hdr = document.querySelector('.xlv-colhdr-inner > div') as HTMLElement;
            return hdr.getBoundingClientRect().width;
        });
        const x0 = await colW();
        await zoomInTwice();
        await page.waitForTimeout(400);
        expect(await colW()).toBeGreaterThan(x0 * 1.2);
        await reset();
        expect(Math.abs((await colW()) - x0), 'xlsx: ⟲ で zoom=1 へ').toBeLessThan(2);

        // html: iframe transform が素に戻る
        await openAt('html', 'plain-text.html', '.viewer-html-frame');
        const hz = () => page.evaluate(() => {
            const el = document.querySelector('.viewer-html-frame') as HTMLElement;
            const m = /scale\(([0-9.]+)\)/.exec(el.style.transform || '');
            return m ? parseFloat(m[1]) : 1;
        });
        await zoomInTwice();
        expect(await hz()).toBeGreaterThan(1.2);
        await reset();
        expect(await hz(), 'html: ⟲ で z=1（style 素戻し）').toBe(1);

        // image: ⟲ は存在しない（既存 [フィット] が同機能 — FR-VZP-06 負 assert）
        await openAt('image', 'pic.png', '.fv-image-stage img');
        expect(await page.locator('.viewer-zoom-reset').count(), 'image に ⟲ なし').toBe(0);
    });
});
