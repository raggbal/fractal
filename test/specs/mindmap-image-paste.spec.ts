/**
 * FR-MM-IP: mindmap node への画像 paste（sprint 20260721-180905）。
 * clipboardData の image を横取り → preventDefault（native 挿入抑止）→ host.saveOutlinerImage →
 * outlinerImageSaved（mindmap フォールバック=renderTree）で node.images に描画。dblclick で lightbox。
 * standalone bridge の saveOutlinerImage モックは outlinerImageSaved を即エコーバックする。
 */
import { test, expect } from '@playwright/test';

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
    await page.waitForTimeout(150);
}
const TREE = () => ({ version: 1, viewMode: 'mindmap', rootIds: ['r'],
    nodes: { r: n('r', 'Root', { children: ['a'] }), a: n('a', 'AAA', { parentId: 'r' }) } });

// a を選択（getFocused=a）してから image paste イベントを合成発火。
// paste イベントの defaultPrevented を返す（TC-IP-02 の load-bearing 検証用）。
async function selectAndPasteImage(page: import('@playwright/test').Page, fileName = 'clip.png') {
    await page.locator('.mindmap-node[data-node-id="a"]').click();
    await page.waitForTimeout(50);
    return page.evaluate((fileName) => {
        const tree = document.querySelector('.outliner-tree[data-view-mode="mindmap"]') as HTMLElement;
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], fileName, { type: 'image/png' }));
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true });
        tree.dispatchEvent(ev);
        return { defaultPrevented: ev.defaultPrevented };
    }, fileName);
}

// TC-IP-01（load-bearing）: 画像 paste → saveOutlinerImage + node.images に入り mindmap に描画
test('TC-IP-01 画像 paste → node.images 描画', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await selectAndPasteImage(page);
    await page.waitForTimeout(200); // FileReader onload + outlinerImageSaved echo + renderTree
    // host.saveOutlinerImage が呼ばれた
    const called = await page.evaluate(() =>
        ((window as any).__testApi.messages || []).some((m: any) => m.type === 'saveOutlinerImage' && m.nodeId === 'a'));
    expect(called).toBeTruthy();
    // model に画像が入った
    const imgs = await page.evaluate(() => (window as any).__testApi.getModel().nodes['a'].images.length);
    expect(imgs).toBe(1);
    // ★ mindmap に描画された（outlinerImageSaved の renderTree フォールバックが効いている = multi-path 番人）
    await expect(page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-images img')).toHaveCount(1);
});

// TC-IP-02（load-bearing）: 画像 paste で preventDefault が呼ばれる（native contenteditable 挿入抑止）
test('TC-IP-02 画像 paste で preventDefault + 本文に img が入らない', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    const res = await selectAndPasteImage(page);
    await page.waitForTimeout(200);
    // ★ load-bearing: 画像 paste で e.preventDefault() が呼ばれている（実装の preventDefault を外すと false → RED）。
    //   synthetic ClipboardEvent は native paste-into-contenteditable を発火しないため、
    //   「本文 img 不在」だけでは番人にならない（tautology）。defaultPrevented を直接 assert する。
    expect(res.defaultPrevented).toBe(true);
    // 併せて本文に img が挿入されていないことも確認（実 VS Code での巨大 img 混入は手動 US で担保）。
    const hasImgInText = await page.evaluate(() => {
        const t = document.querySelector('.mindmap-node-text[data-node-id="a"]');
        return t ? t.innerHTML.indexOf('<img') >= 0 : false;
    });
    expect(hasImgInText).toBeFalsy();
});

// TC-IP-03: 複数画像が小さく並ぶ
test('TC-IP-03 複数画像が並ぶ', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await selectAndPasteImage(page, 'a1.png');
    await page.waitForTimeout(200);
    await selectAndPasteImage(page, 'a2.png');
    await page.waitForTimeout(200);
    await expect(page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-images img')).toHaveCount(2);
    // img が小さい（CSS max-width 60px）
    const w = await page.evaluate(() => {
        const img = document.querySelector('.mindmap-node[data-node-id="a"] .mindmap-node-images img') as HTMLElement;
        return img ? img.getBoundingClientRect().width : 999;
    });
    expect(w).toBeLessThanOrEqual(60);
});

// TC-IP-04: 画像 dblclick で lightbox プレビュー
test('TC-IP-04 画像 dblclick で lightbox', async ({ page }) => {
    await setup(page); await toMindmap(page, TREE());
    await selectAndPasteImage(page);
    await page.waitForTimeout(200);
    const img = page.locator('.mindmap-node[data-node-id="a"] .mindmap-node-images img').first();
    await img.dblclick();
    await page.waitForTimeout(100);
    // showImageOverlay が .outliner-image-overlay を出す
    await expect(page.locator('.outliner-image-overlay')).toHaveCount(1);
    // node は編集モードに入っていない（img dblclick は stopPropagation）
    const editing = await page.evaluate(() => {
        const t = document.querySelector('.mindmap-node-text[data-node-id="a"]');
        return t ? t.classList.contains('is-editing') : false;
    });
    expect(editing).toBeFalsy();
});
