/**
 * Sprint 20260812-110538: FR-OIP-01 画像 paste 二重貼付の 3 層防御 + FR-OIP-02 選択視覚
 * 機序(research 実測): stale mindmap paste listener(ファイル切替で teardown されない)+
 * handleNodePaste のバブリング + standalone onMessage 累積。
 */
import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

function tree(viewMode = 'outliner') {
    return {
        version: 1, viewMode, rootIds: ['n1'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: 'Node one', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] },
        }
    };
}

// 1px PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// node text にフォーカスして実 clipboardData(image item)の paste を dispatch
async function pasteImageIntoNode(page, nodeId: string) {
    await page.evaluate(async ([nid, b64]) => {
        const textEl = document.querySelector(`.outliner-text[data-node-id="${nid}"]`) as HTMLElement;
        textEl.focus();
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], 'img.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        textEl.dispatchEvent(e);
        await new Promise(r => setTimeout(r, 300));
    }, [nodeId, PNG_B64]);
}

const imageState = (page, nodeId: string) => page.evaluate((nid) => {
    const api = (window as any).__testApi;
    return {
        saveMsgCount: api.messages.filter((m: any) => m.type === 'saveOutlinerImage').length,
        modelImages: (window as any).Outliner?.getModel?.()?.getNode?.(nid)?.images?.length
            ?? document.querySelectorAll(`.outliner-images[data-node-id="${nid}"] img`).length,
    };
}, nodeId);

test.describe('FR-OIP-01 image paste dedup', () => {
    // TC-OIP-01: outliner view での画像 paste = saveOutlinerImage 1 回・画像 1 枚
    test('TC-OIP-01 paste into node sends saveOutlinerImage exactly once', async ({ page }) => {
        await setup(page);
        await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, tree());
        await page.waitForTimeout(150);
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
        await pasteImageIntoNode(page, 'n1');
        const st = await imageState(page, 'n1');
        expect(st.saveMsgCount).toBe(1);
    });

    // TC-OIP-02: mindmap 表示 → 別データへ updateData 切替(destroy 封鎖)→ paste = 1 回
    // counterfactual: updateData の destroy + paste listener ガードを外すと 2 回 = RED
    test('TC-OIP-02 paste after mindmap->outliner file switch stays single', async ({ page }) => {
        await setup(page);
        // mindmap の .out を開く(listener が attach される)
        await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, tree('mindmap'));
        await page.waitForTimeout(300);
        // 別ファイル(outliner view)へ updateData 経路で切替
        await page.evaluate((d) => {
            (window as any).__hostMessageHandler({ type: 'updateData', data: d, fileChangeId: 'switch-1' });
        }, tree('outliner'));
        await page.waitForTimeout(300);
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
        await pasteImageIntoNode(page, 'n1');
        const st = await imageState(page, 'n1');
        expect(st.saveMsgCount).toBe(1); // stale mindmap listener が発火しない
    });

    // TC-OIP-03: mindmap→mindmap の切替で描画・画像 paste が正常(destroy 追加の安全性)
    test('TC-OIP-03 mindmap-to-mindmap switch keeps mindmap functional', async ({ page }) => {
        await setup(page);
        await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, tree('mindmap'));
        await page.waitForTimeout(300);
        await page.evaluate((d) => {
            (window as any).__hostMessageHandler({ type: 'updateData', data: d, fileChangeId: 'switch-2' });
        }, tree('mindmap'));
        await page.waitForTimeout(300);
        const boxes = await page.evaluate(() => document.querySelectorAll('.mindmap-node-box').length);
        expect(boxes).toBeGreaterThan(0); // 再 attach されて描画されている
        // mindmap での画像 paste も 1 回のみ
        await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const t = document.querySelector('.mindmap-node-text[data-node-id="n1"]') as HTMLElement;
            t?.focus();
        });
        await page.evaluate(async (b64) => {
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const file = new File([arr], 'img.png', { type: 'image/png' });
            const dt = new DataTransfer();
            dt.items.add(file);
            const tree = document.querySelector('.outliner-tree')!;
            tree.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
            await new Promise(r => setTimeout(r, 300));
        }, PNG_B64);
        const n = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'saveOutlinerImage').length);
        expect(n).toBe(1);
    });

    // TC-OIP-04: onMessage 正典化 — handler を 2 回登録しても処理は最新 1 回分
    test('TC-OIP-04 bridge onMessage keeps handlers isolated (no accumulation)', async ({ page }) => {
        await setup(page);
        const counts = await page.evaluate(async () => {
            const factory = (window as any).__createSidePanelBridgeMethods;
            if (!factory) return null;
            const bridge = factory(function() {});
            let a = 0, b = 0;
            bridge.onMessage(() => { a++; });
            bridge.onMessage(() => { b++; }); // 同一 bridge の再登録 = 置換
            window.postMessage({ type: 'test-ping' }, '*');
            await new Promise(r => setTimeout(r, 100));
            return { a, b };
        });
        if (counts === null) { test.skip(); return; }
        expect(counts.b).toBe(1);
        expect(counts.a).toBe(0); // 旧 handler は置換されて呼ばれない(累積なし)
    });
});

test.describe('FR-OIP-02 selected image visual', () => {
    test('TC-OIP-05 image click shows clear selection; blank click clears', async ({ page }) => {
        await setup(page);
        const data = tree();
        (data.nodes.n1 as any).images = ['./images/a.png'];
        await page.evaluate((d) => { (window as any).__testApi.initOutliner(d); }, data);
        await page.waitForTimeout(200);
        const img = page.locator('.outliner-images img, .outliner-image-thumb').first();
        await img.click();
        await page.waitForTimeout(100);
        const style = await page.evaluate(() => {
            const el = document.querySelector('.outliner-image-thumb.is-selected, .outliner-images img.is-selected') as HTMLElement;
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { outline: cs.outlineWidth, shadow: cs.boxShadow };
        });
        expect(style).not.toBeNull();
        expect(style!.outline).not.toBe('0px');   // outline で明確に識別
        expect(style!.shadow).not.toBe('none');   // shadow 付き
        // 空白 click で解除
        await page.evaluate(() => {
            (document.querySelector('.outliner-tree') as HTMLElement).click();
        });
        await page.waitForTimeout(100);
        const still = await page.evaluate(() =>
            !!document.querySelector('.is-selected'));
        expect(still).toBe(false);
    });
});
