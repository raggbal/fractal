/**
 * FR-MM-IP 仕上げ: 画像がある mindmap node は text と同様に横幅を広げる（sprint 20260721-194411）。
 * text 無し node に複数画像を持たせると、旧実装は幅 80 に潰れて画像が縦積みになっていた。
 * imageMinWidth を estimateMeasure(pass-1) と measureRealWidth(pass-2) の両方に適用して横に広げる（max 280）。
 * paste 経路でなく images を seed して幅を測る（幅計算に集中。paste は前 sprint で検証済み）。
 */
import { test, expect } from '@playwright/test';

// 1x1 透明 png data URL（実描画させる）
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}
function n(id: string, text: string, extra: any = {}) {
    return Object.assign({ id, parentId: null, children: [], text, collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] }, extra);
}
async function toMindmap(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.evaluate(() => (window as any).Outliner.setViewMode('mindmap'));
    await page.waitForTimeout(200); // 2 パス render 完了待ち
}
function seed(nodeExtra: any) {
    return { version: 1, viewMode: 'mindmap', rootIds: ['r'],
        nodes: { r: n('r', 'Root', { children: ['a'] }), a: n('a', 'AAA', Object.assign({ parentId: 'r' }, nodeExtra)) } };
}
async function boxWidth(page: import('@playwright/test').Page, id = 'a') {
    const b = await page.locator(`.mindmap-node[data-node-id="${id}"] .mindmap-node-box`).boundingBox();
    return b ? b.width : -1;
}

// TC-IW-01（load-bearing）: text 無し node に画像 2 枚 → 幅が横に広がる
test('TC-IW-01 text 無し + 画像 2 枚 → 幅が横に広がる', async ({ page }) => {
    await setup(page);
    await toMindmap(page, seed({ text: '', images: [IMG, IMG] }));
    const w = await boxWidth(page);
    // 2 枚分（60+60+gap+padding ≈ 162）。旧挙動（text 無し = 幅 ~80）なら 150 未満。
    expect(w).toBeGreaterThanOrEqual(150);
    // counterfactual: imageMinWidth を 0 にすると w~80 で本 assert が RED
});

// TC-IW-02: 画像 2 枚が横に並ぶ（縦積みでない）
test('TC-IW-02 画像 2 枚が横に並ぶ', async ({ page }) => {
    await setup(page);
    await toMindmap(page, seed({ text: '', images: [IMG, IMG] }));
    const tops = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('.mindmap-node[data-node-id="a"] .mindmap-node-images img'));
        return imgs.map(im => Math.round(im.getBoundingClientRect().top));
    });
    expect(tops.length).toBe(2);
    // 2 枚の top がほぼ同じ = 同一行（縦積みなら img 高さ分ずれる）
    expect(Math.abs(tops[0] - tops[1])).toBeLessThan(10);
});

// TC-IW-03: text 有り + 画像 → 大きい方の幅（text だけの node が縮まない回帰）
test('TC-IW-03 text 幅 と 画像幅 の大きい方を採る', async ({ page }) => {
    await setup(page);
    // 短い text のみ
    await toMindmap(page, seed({ text: '短い', images: [] }));
    const wTextOnly = await boxWidth(page);
    // 短い text + 画像 2 枚 → 画像で広がる
    await toMindmap(page, seed({ text: '短い', images: [IMG, IMG] }));
    const wTextPlusImg = await boxWidth(page);
    expect(wTextPlusImg).toBeGreaterThanOrEqual(wTextOnly);

    // 長い text は画像の有無で縮まない（text 幅 vs 画像幅の max）
    const longText = 'とても長いタイトルがここに入るテキスト';
    await toMindmap(page, seed({ text: longText, images: [] }));
    const wLongOnly = await boxWidth(page);
    await toMindmap(page, seed({ text: longText, images: [IMG] }));
    const wLongPlusImg = await boxWidth(page);
    expect(wLongPlusImg).toBeGreaterThanOrEqual(wLongOnly - 2); // 画像で不当に縮まない
});

// TC-IW-04（max 280 回帰）: 画像多数でも幅 ≤ 280
test('TC-IW-04 画像 5 枚でも幅 ≤ 280', async ({ page }) => {
    await setup(page);
    await toMindmap(page, seed({ text: '', images: [IMG, IMG, IMG, IMG, IMG] }));
    const w = await boxWidth(page);
    expect(w).toBeLessThanOrEqual(282); // 280 + border 誤差
});
