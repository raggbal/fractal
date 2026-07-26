import { test, expect } from '@playwright/test';
import * as path from 'path';

test('drawio hover shows 3 buttons and VS Code button posts openImageInNewTab', async ({ page }) => {
    const html = path.resolve(__dirname, '../../test/html/standalone-editor.html');
    await page.goto('file://' + html);
    await page.waitForFunction(() => (window as any).__testApi);
    // drawio img を差し込む
    await page.evaluate(() => {
        const editor = document.querySelector('.editor') as HTMLElement;
        const img = document.createElement('img');
        img.src = '/tmp/x/diagram.drawio.svg';
        (img as any).dataset.markdownPath = 'files/diagram.drawio.svg';
        img.style.width = '300px'; img.style.height = '80px';
        editor.prepend(img);
    });
    const img = page.locator('img[src$="diagram.drawio.svg"]');
    await img.hover();
    // 3 ボタンが可視
    const btns = page.locator('.drawio-open-btn');
    await expect(btns).toHaveCount(3);
    const texts = await btns.allTextContents();
    expect(texts).toContain('Open in External');
    expect(texts).toContain('Open in VS Code');
    expect(texts).toContain('Copy Path');
    for (let i = 0; i < 3; i++) await expect(btns.nth(i)).toBeVisible();
    // VS Code ボタン → openImageInNewTab が host に届く
    await page.locator('.drawio-open-btn', { hasText: 'Open in VS Code' }).click();
    const msgs = await page.evaluate(() => (window as any).__testApi.messages);
    const m = msgs.filter((x: any) => x.type === 'openImageInNewTab');
    expect(m.length).toBe(1);
    expect(m[0].absPath).toBe('/tmp/x/diagram.drawio.svg');
    // External ボタン → openDrawioExternal（絶対パス。host 側で mac は draw.io Desktop 優先）
    await img.hover();
    await page.locator('.drawio-open-btn', { hasText: 'Open in External' }).click();
    const msgs2 = await page.evaluate(() => (window as any).__testApi.messages);
    const m2 = msgs2.filter((x: any) => x.type === 'openDrawioExternal');
    expect(m2.length).toBe(1);
    expect(m2[0].absPath).toBe('/tmp/x/diagram.drawio.svg');
});
