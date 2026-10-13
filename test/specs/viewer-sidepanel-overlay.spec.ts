/**
 * viewer-sidepanel-overlay.spec.ts — viewer sidepanel を md sidepanel の上に重ねる（全 kind 共通）
 *
 * sprint 20261009-130815-file-viewer-drawio 再オープン① / TASK-11 / FR-VSO-01〜03 / ADRL-0138。
 * ハーネス: standalone-outliner.html（TC-FV-21 と同じ。viewer-side-panel.js は kind 非依存の 1 実装なので、
 * 重なり・Esc・幅はパネル単位で検証する。drawio はこのハーネスで本体が描画されなくても、パネルの挙動は同じ）。
 *
 * TC-VSO-01〜06
 */
import { test, expect, Page } from '@playwright/test';

const LONG_MD = '# md panel\n\n' + Array.from({ length: 120 }, (_, i) => `line ${i} of the md sidepanel`).join('\n\n');

async function openMd(page: Page, name = 'a.md', markdown = LONG_MD): Promise<void> {
    await page.evaluate(([n, md]) => {
        (window as any).__hostMessageHandler({ type: 'openSidePanel', markdown: md, filePath: '/x/' + n, fileName: n, toc: [], documentBaseUri: '' });
    }, [name, markdown]);
    await page.waitForSelector('.side-panel.open', { timeout: 5000 });
    await page.waitForTimeout(300); // open アニメーション
}
async function openViewer(page: Page, kind = 'html'): Promise<void> {
    await page.evaluate((k) => {
        const uri = k === 'html' ? './viewer-fixtures/sample.html' : './viewer-fixtures/drawio/aws-plain.drawio';
        window.postMessage({ type: 'openViewerPanel', kind: k, fileUri: uri, filePath: k === 'html' ? '/x/sample.html' : '/x/aws-plain.drawio' }, '*');
    }, kind);
    await page.waitForSelector('.viewer-side-panel.open', { timeout: 5000 });
    await page.waitForTimeout(300);
}
const count = (page: Page, sel: string) => page.locator(sel).count();

test.describe('viewer sidepanel の重ね表示（再オープン① / TASK-11）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__viewerSidePanel && (window as any).__testApi);
    });

    test('TC-VSO-01: md を閉じずに前面に重なる（html / drawio）', async ({ page }) => {
        for (const kind of ['html', 'drawio']) {
            await openMd(page);
            await openViewer(page, kind);
            expect(await count(page, '.side-panel.open'), `${kind}: md は開いたまま`).toBe(1);
            expect(await count(page, '.viewer-side-panel.open'), `${kind}: viewer が開く`).toBe(1);
            const topIsViewer = await page.evaluate(() => {
                const r = document.querySelector('.viewer-side-panel')!.getBoundingClientRect();
                const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !!el && !!el.closest('.viewer-side-panel');
            });
            expect(topIsViewer, `${kind}: 中心は viewer`).toBe(true);
            await page.evaluate(() => (window as any).__viewerSidePanel.close());
        }
    });

    test('TC-VSO-02: × で閉じると md がそのまま見える（スクロール位置も）', async ({ page }) => {
        await openMd(page);
        const scrolled = await page.evaluate(() => {
            const cands = [...document.querySelectorAll('.side-panel *')] as HTMLElement[];
            const sc = cands.find((el) => el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY));
            if (!sc) { return null; }
            sc.setAttribute('data-test-scroller', '1');
            sc.scrollTop = 80;
            return sc.scrollTop;
        });
        expect(scrolled).toBeGreaterThan(0);
        await openViewer(page);
        await page.locator('.viewer-side-panel .viewer-side-panel-close').click();
        await page.waitForTimeout(300);
        expect(await count(page, '.viewer-side-panel.open')).toBe(0);
        expect(await count(page, '.side-panel.open')).toBe(1);
        expect(await page.evaluate(() => (document.querySelector('[data-test-scroller]') as HTMLElement).scrollTop)).toBe(scrolled);
    });

    test('TC-VSO-03: Esc は最前面の 1 枚だけ（2 回目で md）', async ({ page }) => {
        await openMd(page);
        await openViewer(page);
        await page.locator('.viewer-side-panel .viewer-title').click();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        expect(await count(page, '.viewer-side-panel.open'), '1 回目: viewer が閉じる').toBe(0);
        expect(await count(page, '.side-panel.open'), '1 回目: md は残る').toBe(1);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        expect(await count(page, '.side-panel.open'), '2 回目: md が閉じる').toBe(0);
    });

    test('TC-VSO-04: find bar 内の Esc は find bar だけ、lightbox 中は何も閉じない', async ({ page }) => {
        await openMd(page);
        await openViewer(page);
        // (a) find bar（html kind は find 対応）
        await page.locator('.viewer-side-panel .viewer-find-toggle').click();
        const input = page.locator('.viewer-side-panel .viewer-find-bar input');
        await expect(input).toBeVisible();
        await input.focus();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        await expect(page.locator('.viewer-side-panel .viewer-find-bar')).toBeHidden();
        expect(await count(page, '.viewer-side-panel.open')).toBe(1);
        expect(await count(page, '.side-panel.open')).toBe(1);
        // (b) lightbox（viewer に focus を置いてから overlay を差し込む — overlay は pointer を奪うため先に focus）
        await page.locator('.viewer-side-panel .viewer-title').click();
        await page.evaluate(() => { const o = document.createElement('div'); o.className = 'outliner-image-overlay'; document.body.appendChild(o); });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        expect(await count(page, '.viewer-side-panel.open')).toBe(1);
        expect(await count(page, '.side-panel.open')).toBe(1);
    });

    test('TC-VSO-05: 幅を md に合わせる・残す排他', async ({ page }) => {
        // (a) 幅
        await openMd(page);
        await page.evaluate(() => { (document.querySelector('.side-panel') as HTMLElement).style.width = '600px'; });
        await openViewer(page);
        const w = await page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        expect(Math.abs(w - 600)).toBeLessThanOrEqual(1);
        // (b) md 側で別の md を開くと viewer は閉じる（TC-FV-21 方向 2 と同じ）
        await openMd(page, 'b.md', '# md again');
        expect(await count(page, '.viewer-side-panel.open')).toBe(0);
        // (c) md の × だけを押しても viewer は残る
        await openViewer(page);
        await page.evaluate(() => (document.querySelector('.side-panel.open .side-panel-close') as HTMLElement).click());
        await page.waitForTimeout(300);
        expect(await count(page, '.side-panel.open')).toBe(0);
        expect(await count(page, '.viewer-side-panel.open')).toBe(1);
    });

    test('TC-VSO-06: viewer の外で押した Esc は奪わない', async ({ page }) => {
        await openMd(page);
        await openViewer(page);
        await page.evaluate(() => {
            const inp = document.createElement('input');
            inp.id = 'outside-input';
            inp.style.cssText = 'position:fixed;left:4px;top:4px;z-index:5000';
            document.body.appendChild(inp);
            (window as any).__outsideEsc = 0;
            inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { (window as any).__outsideEsc++; } });
        });
        await page.locator('#outside-input').focus();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        expect(await count(page, '.viewer-side-panel.open'), 'viewer は閉じない').toBe(1);
        expect(await page.evaluate(() => (window as any).__outsideEsc), '外側の要素が Esc を受ける').toBe(1);
    });

    test('TC-VSO-07: md に合わせた幅は md 無しの再オープンで既定に戻り、手でリサイズした幅は残る', async ({ page }) => {
        const viewerW = () => page.evaluate(() => document.querySelector('.viewer-side-panel')!.getBoundingClientRect().width);
        const containerHalf = () => page.evaluate(() => {
            const p = document.querySelector('.viewer-side-panel')!.parentElement as HTMLElement;
            return p.getBoundingClientRect().width * 0.5;
        });
        // md 600px に合わせて開く → viewer と md を閉じる → md 無しで開く
        await openMd(page);
        await page.evaluate(() => { (document.querySelector('.side-panel') as HTMLElement).style.width = '600px'; });
        await openViewer(page);
        expect(Math.abs((await viewerW()) - 600)).toBeLessThanOrEqual(1);
        await page.evaluate(() => (window as any).__viewerSidePanel.close());
        await page.evaluate(() => (document.querySelector('.side-panel.open .side-panel-close') as HTMLElement).click());
        await page.waitForTimeout(300);
        expect(await count(page, '.side-panel.open')).toBe(0);
        await openViewer(page);
        expect(Math.abs((await viewerW()) - (await containerHalf())), 'md に合わせた幅は残らない（既定 50%）').toBeLessThanOrEqual(1);
        // 手でリサイズした幅は md 無しの再オープンでも残る（従来どおり）
        const handle = page.locator('.viewer-side-panel-resize-handle');
        const hb = (await handle.boundingBox())!;
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await page.mouse.down();
        await page.mouse.move(hb.x + hb.width / 2 - 80, hb.y + hb.height / 2, { steps: 5 });
        await page.mouse.up();
        const resized = await viewerW();
        await page.evaluate(() => (window as any).__viewerSidePanel.close());
        await openViewer(page);
        expect(Math.abs((await viewerW()) - resized), 'リサイズした幅は残る').toBeLessThanOrEqual(1);
    });
});
