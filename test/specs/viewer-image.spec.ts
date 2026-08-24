/**
 * viewer-image.spec.ts — image viewer（TC-IMV-01..06）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-08。ハーネス: standalone-viewer.html。
 * 実レンダ + 数値検証（wheel 不動点）。svg の script 非実行は window flag の不在で観測。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const FIX = path.join(__dirname, '..', 'html', 'viewer-fixtures');
// 4x4 赤 PNG（decode 可能な最小実画像）
const RED_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAcT9GO0U4BxoAAAAAElFTkSuQmCC',
    'base64');

test.beforeAll(() => {
    fs.mkdirSync(FIX, { recursive: true });
    fs.writeFileSync(path.join(FIX, 'small.png'), RED_PNG);
    fs.writeFileSync(path.join(FIX, 'evil.svg'), [
        '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40">',
        '<script>window.parent.__svgPwned = true; window.__svgPwned = true;</script>',
        '<rect width="60" height="40" fill="#3a7"/>',
        '</svg>',
    ].join(''));
});

async function openImage(page: any, file: string) {
    await page.goto('/standalone-viewer.html');
    await page.evaluate((f: string) => (window as any).__fileViewer.open(
        'image', `./viewer-fixtures/${f}`, document.getElementById('viewer-root'), `/tmp/${f}`), file);
    await page.waitForSelector('.fv-image-stage img');
    await page.waitForFunction(() => !!(window as any).__fvImageState);
}

test('TC-IMV-01: 初期フィット — 小画像は拡大しない（s=1 センタリング）', async ({ page }) => {
    await openImage(page, 'small.png');
    const st = await page.evaluate(() => (window as any).__fvImageState);
    expect(st.scale).toBe(1); // 4x4 画像 → fit>1 でも 1 に clamp
    const centered = await page.evaluate(() => {
        const stage = document.querySelector('.fv-image-stage') as HTMLElement;
        const s = (window as any).__fvImageState;
        return Math.abs(s.tx - (stage.clientWidth - 4) / 2) < 1 && Math.abs(s.ty - (stage.clientHeight - 4) / 2) < 1;
    });
    expect(centered).toBe(true);
});

test('TC-IMV-02: wheel 不動点ズーム — カーソル下の画像座標が不変・clamp', async ({ page }) => {
    await openImage(page, 'small.png');
    const result = await page.evaluate(() => {
        const stage = document.querySelector('.fv-image-stage') as HTMLElement;
        const rect = stage.getBoundingClientRect();
        const cx = rect.left + 30, cy = rect.top + 20;
        const before = { ...(window as any).__fvImageState };
        // カーソル位置の画像座標（img ローカル）
        const imgX = (30 - before.tx) / before.scale;
        const imgY = (20 - before.ty) / before.scale;
        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
        const after = (window as any).__fvImageState;
        const imgX2 = (30 - after.tx) / after.scale;
        const imgY2 = (20 - after.ty) / after.scale;
        return { zoomedIn: after.scale > before.scale, dx: Math.abs(imgX - imgX2), dy: Math.abs(imgY - imgY2) };
    });
    expect(result.zoomedIn).toBe(true);
    expect(result.dx).toBeLessThan(0.001); // 不動点（数値検証）
    expect(result.dy).toBeLessThan(0.001);
    // clamp 上限 32x
    const capped = await page.evaluate(() => {
        const stage = document.querySelector('.fv-image-stage') as HTMLElement;
        for (let i = 0; i < 100; i++) {
            stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }));
        }
        return (window as any).__fvImageState.scale;
    });
    expect(capped).toBeLessThanOrEqual(32);
});

test('TC-IMV-03: [−][+]/[fit]/[等倍] と倍率 % 表示', async ({ page }) => {
    await openImage(page, 'small.png');
    const label0 = await page.evaluate(() => (document.querySelector('.fv-image-zoom-label') as HTMLElement).textContent);
    expect(label0).toMatch(/^\d+%$/);
    const s1 = await page.evaluate(() => {
        (document.querySelector('.viewer-zoom-in') as HTMLElement).click();
        return (window as any).__fvImageState.scale;
    });
    expect(s1).toBeCloseTo(1.25, 5);
    const s2 = await page.evaluate(() => {
        (document.querySelector('.viewer-zoom-out') as HTMLElement).click();
        return (window as any).__fvImageState.scale;
    });
    expect(s2).toBeCloseTo(1, 5);
    // 等倍 = 1/devicePixelRatio（% 表示は 100%）
    const actual = await page.evaluate(() => {
        (document.querySelector('.viewer-actual-size') as HTMLElement).click();
        return {
            scale: (window as any).__fvImageState.scale,
            dpr: window.devicePixelRatio,
            label: (document.querySelector('.fv-image-zoom-label') as HTMLElement).textContent,
        };
    });
    expect(actual.scale).toBeCloseTo(1 / actual.dpr, 5);
    expect(actual.label).toBe('100%');
    // fit で復帰
    const fitScale = await page.evaluate(() => {
        (document.querySelector('.viewer-fit') as HTMLElement).click();
        return (window as any).__fvImageState.scale;
    });
    expect(fitScale).toBe(1);
});

test('TC-IMV-04: script 入り svg → 画像描画・スクリプト非実行', async ({ page }) => {
    await openImage(page, 'evil.svg');
    // 実描画（naturalWidth が立つ = SVG として decode）
    const nat = await page.evaluate(() => (document.querySelector('.fv-image-stage img') as HTMLImageElement).naturalWidth);
    expect(nat).toBe(60);
    // script 非実行（`<img>` の secure static mode — ADRL-0091）
    const pwned = await page.evaluate(() => (window as any).__svgPwned);
    expect(pwned).toBeUndefined();
    // 🔍 も find bar も無い（find 対象外）
    expect(await page.evaluate(() => document.querySelector('.viewer-find-toggle'))).toBeNull();
});

test('TC-IMV-05: inline svg 番人 — viewer-image に <svg> 注入コードが無い', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-image', 'index.mjs'), 'utf8');
    expect(/createElementNS/.test(src), 'createElementNS（inline svg 注入）').toBe(false);
    expect(/innerHTML/.test(src), 'innerHTML').toBe(false);
});

test('TC-IMV-06: destroy で objectURL revoke・市松背景', async ({ page }) => {
    await openImage(page, 'small.png');
    const bg = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.fv-image-stage') as HTMLElement).backgroundImage);
    expect(bg).toContain('linear-gradient'); // 市松（computed style — CSS 削除は class assert では検出不能）
    const revoked = await page.evaluate(async () => {
        const img = document.querySelector('.fv-image-stage img') as HTMLImageElement;
        const url = img.src;
        (window as any).__fileViewer.destroy(document.getElementById('viewer-root'));
        try {
            const r = await fetch(url);
            return !r.ok;
        } catch { return true; } // revoke 済み blob URL は fetch 不能
    });
    expect(revoked).toBe(true);
});
