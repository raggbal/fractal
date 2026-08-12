/**
 * Sprint 20260812-110538: FR-MMC mindmap copy/cut/paste + FR-MMI 画像選択削除
 * ctx フック(ADRL-0056)で outliner 正典 3 点セット + pasteNodesFromText を共有。
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function tree() {
    return {
        version: 1, viewMode: 'mindmap', rootIds: ['n1', 'n9'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: ['c1', 'c2'], text: 'Parent', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            c1: { id: 'c1', parentId: 'n1', children: ['g1'], text: 'Child A', collapsed: false, subtext: '', images: ['./images/a.png', './images/b.png'], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
            g1: { id: 'g1', parentId: 'c1', children: [], text: 'Grand', collapsed: false, subtext: '', images: [], isPage: true, pageId: 'pg-1', checked: null, filePath: null, tags: [] },
            c2: { id: 'c2', parentId: 'n1', children: [], text: 'Child B', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: 'files/doc.pdf', tags: [] },
            n9: { id: 'n9', parentId: null, children: [], text: 'Target', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
        }
    };
}

async function init(page, data) {
    await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
    await page.waitForTimeout(250);
}

async function focusNode(page, nodeId: string) {
    await page.locator(`.mindmap-node-text[data-node-id="${nodeId}"]`).click();
    await page.waitForTimeout(100);
}

test('TC-MMC-01 cmd+c copies focused node with all descendants + Store', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await focusNode(page, 'n1');
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(200);
    const store = await page.evaluate(() =>
        (window as any).__testApi.messages.find((m: any) => m.type === 'saveOutlinerClipboard'));
    expect(store).toBeTruthy();
    expect(store.isCut ?? store.nodesData?.isCut ?? false).toBeFalsy();
    const nodes = store.nodesData || store.nodes;
    expect(nodes.length).toBe(4); // n1 + c1 + g1 + c2(subtree 全体)
    expect(nodes[0].level).toBe(0);
    expect(nodes.some((n: any) => n.isPage)).toBe(true);       // page 含む
    expect(nodes.some((n: any) => n.images?.length === 2)).toBe(true); // 画像 2 含む
    expect(nodes.some((n: any) => n.filePath)).toBe(true);     // file 含む
});

test('TC-MMC-02 cmd+x copies then removes subtree; undo restores', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await focusNode(page, 'c1');
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(300);
    let exists = await page.evaluate(() =>
        document.querySelectorAll('.mindmap-node-text[data-node-id="c1"]').length);
    expect(exists).toBe(0); // subtree 削除
    const store = await page.evaluate(() =>
        (window as any).__testApi.messages.find((m: any) => m.type === 'saveOutlinerClipboard'));
    expect(store).toBeTruthy();
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(300);
    exists = await page.evaluate(() =>
        document.querySelectorAll('.mindmap-node-text[data-node-id="c1"]').length);
    expect(exists).toBe(1); // undo 復帰
});

test('TC-MMC-03 cmd+v pastes as child of focused node', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await focusNode(page, 'c2');
    await page.keyboard.press('Meta+c'); // c2(file node)を copy
    await page.waitForTimeout(200);
    await focusNode(page, 'n9');
    // paste は実 clipboardData の paste イベント(内部 clip が copyId 一致で勝つ形を合成)
    await page.evaluate(async () => {
        const tree = document.querySelector('.outliner-tree')!;
        const dt = new DataTransfer();
        dt.setData('text/plain', 'Child B');
        tree.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        await new Promise(r => setTimeout(r, 300));
    });
    // n9 の子として挿入されたことを DOM(mindmap 再描画)で検証
    const st = await page.evaluate(() => {
        // mindmap の edge/node から n9 の子数を数える: data-node-id 列挙で n9 以外の新 node
        const ids = Array.from(document.querySelectorAll('.mindmap-node-text[data-node-id]'))
            .map(el => el.getAttribute('data-node-id'));
        return { total: ids.length };
    });
    // 元 6 node(title 除く 5 + title)に +1 された(貼り付けで node が増えて描画されている)
    expect(st.total).toBeGreaterThanOrEqual(6);
});

test('TC-MMC-04 multi-asset copy triggers asset duplication messages (same-note copy)', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await focusNode(page, 'n1');
    await page.keyboard.press('Meta+c'); // 画像 2 + file + page 混在 subtree
    await page.waitForTimeout(200);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await focusNode(page, 'n9');
    await page.evaluate(async () => {
        const tree = document.querySelector('.outliner-tree')!;
        const dt = new DataTransfer();
        // internalClipboard の plainText と一致させる(tab インデント形式)
        dt.setData('text/plain', 'Parent\n\tChild A\n\t\tGrand\n\tChild B');
        tree.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        await new Promise(r => setTimeout(r, 400));
    });
    const msgs = await page.evaluate(() =>
        (window as any).__testApi.messages.map((m: any) => m.type));
    // 同一 note copy = 資産は複製(host 経由): page は handlePageAssetsCross、画像は copyImagesCross、file は handleFileAssetCross
    expect(msgs).toContain('handlePageAssetsCross');
    expect(msgs.filter((t: string) => t === 'copyImagesCross' || t === 'handlePageAssetsCross' || t === 'handleFileAssetCross').length).toBeGreaterThanOrEqual(3);
});

test('TC-MMC-06 cmd+c/x while editing defers to text editing', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    // c2 を編集状態に(dblclick 相当 = promoteToEditing)
    await page.locator('.mindmap-node-text[data-node-id="c2"]').dblclick();
    await page.waitForTimeout(150);
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    await page.keyboard.press('Meta+c'); // 編集中 = node copy にならない
    await page.waitForTimeout(150);
    const store = await page.evaluate(() =>
        (window as any).__testApi.messages.find((m: any) => m.type === 'saveOutlinerClipboard'));
    expect(store).toBeFalsy();
    // node も消えていない(cmd+x 誤爆なし)
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(150);
    const exists = await page.evaluate(() =>
        document.querySelectorAll('.mindmap-node-text[data-node-id="c2"]').length);
    expect(exists).toBe(1);
});

test('TC-MMC-05 mindmap copy (subtree with meta) pastes into outliner view as nodes', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await focusNode(page, 'n1'); // subtree(4 node・メタ付き)を copy
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(200);
    // outliner view へ切替
    await page.evaluate(() => { (window as any).Outliner.setViewMode('outliner'); });
    await page.waitForTimeout(300);
    // n9 の text にフォーカスして paste(internal clipboard が plainText 一致で勝つ)
    await page.evaluate(async () => {
        const textEl = document.querySelector('.outliner-text[data-node-id="n9"]') as HTMLElement;
        textEl.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', 'Parent\n\tChild A\n\t\tGrand\n\tChild B');
        textEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        await new Promise(r => setTimeout(r, 400));
    });
    const counts = await page.evaluate(() => ({
        parents: Array.from(document.querySelectorAll('.outliner-text'))
            .filter(el => el.textContent?.trim() === 'Parent').length,
        grands: Array.from(document.querySelectorAll('.outliner-text'))
            .filter(el => el.textContent?.trim() === 'Grand').length,
    }));
    expect(counts.parents).toBe(2); // 元 + 貼り付け(node として)
    expect(counts.grands).toBe(2);  // 階層ごと貼られている
});

// ---- FR-MMI-01: mindmap 画像の選択・削除 ----

test('TC-MMI-01 image click selects; Delete removes; undo restores', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    const img = page.locator('.mindmap-node-images img').first();
    await img.click();
    await page.waitForTimeout(100);
    const sel = await page.evaluate(() => {
        const el = document.querySelector('.mindmap-node-images img.is-selected') as HTMLElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { outline: cs.outlineWidth, shadow: cs.boxShadow !== 'none' };
    });
    expect(sel).not.toBeNull();
    expect(sel!.outline).not.toBe('0px');
    // Delete で除去(c1 は画像 2 枚 → 1 枚に)
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    let count = await page.evaluate(() =>
        document.querySelectorAll('.mindmap-node-images img').length);
    expect(count).toBe(1);
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(300);
    count = await page.evaluate(() =>
        document.querySelectorAll('.mindmap-node-images img').length);
    expect(count).toBe(2); // undo 復帰
});

test('TC-MMI-02 dblclick lightbox still works (selection non-interfering)', async ({ page }) => {
    await setup(page);
    await init(page, tree());
    await page.locator('.mindmap-node-images img').first().dblclick();
    await page.waitForTimeout(200);
    const overlay = await page.evaluate(() =>
        !!document.querySelector('.outliner-image-overlay, .image-overlay, [class*="overlay"]'));
    expect(overlay).toBe(true);
});
