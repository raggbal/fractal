/**
 * md editor の drawio ホバーに「Open in Viewer」（sprint 20261009-130815-file-viewer-drawio / TASK-09 / FR-DIO-08）
 *
 * TC-DIO-40（ハーネス: test/html/standalone-editor.html — drawio-open-buttons.spec.ts と同じ）
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

async function setup(page: any) {
    const html = path.resolve(__dirname, '../../test/html/standalone-editor.html');
    await page.goto('file://' + html);
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate(() => {
        const editor = document.querySelector('.editor') as HTMLElement;
        const mk = (src: string, mdPath: string) => {
            const img = document.createElement('img');
            img.src = src;
            (img as any).dataset.markdownPath = mdPath;
            img.style.width = '300px'; img.style.height = '80px'; img.style.display = 'block';
            editor.prepend(img);
        };
        mk('/tmp/x/p.svg', 'img/p.svg');
        mk('/tmp/x/a.drawio.svg', 'img/a.drawio.svg?v=1#frag');
    });
}

test('TC-DIO-40: drawio 画像のホバーに Open in Viewer が出て、click で host.openLink に md 相対パスを渡す', async ({ page }) => {
    await setup(page);
    await page.locator('img[src$="a.drawio.svg"]').hover();
    const btns = page.locator('.drawio-open-btn');
    await expect(btns).toHaveCount(4);
    const viewerBtn = page.locator('.drawio-open-btn', { hasText: 'Open in Viewer' });
    await expect(viewerBtn).toBeVisible();
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await viewerBtn.click();
    const msgs = await page.evaluate(() => (window as any).__testApi.messages);
    const links = msgs.filter((m: any) => m.type === 'openLink');
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('img/a.drawio.svg');
    // 既存ボタンの行き先は従来どおり
    expect(msgs.filter((m: any) => m.type === 'openDrawioExternal' || m.type === 'openImageInNewTab')).toHaveLength(0);

    // 普通の svg ではボタンが出ない
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    await page.locator('img[src$="/p.svg"]').hover();
    await page.waitForTimeout(200);
    for (let i = 0; i < 4; i++) { await expect(btns.nth(i)).toBeHidden(); }
});
