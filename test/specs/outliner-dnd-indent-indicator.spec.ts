/**
 * outliner-dnd-indent-indicator — D&D 挿入インジケータの indent 対応（sprint 20260802-010347）
 *
 * FR-DII-01: 挿入線を落ちる先の depth 位置から描く（全幅一直線をやめる）
 * FR-DII-02: after position で clientX により挿入先 depth を選択（ファイルツリー型）
 * FR-DII-03: 表示 depth と挿入結果の一致（resolveDropDepth + lastDropResolution）
 *
 * TC 定義: sprint の testcases.md。INDENT_PX = 24。
 */

import { test, expect } from '@playwright/test';

// fixture: a(d0) > b(d1) > c(d2), d(d0) — c と d の間が「境界 after」
async function initTree(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({
            version: 1,
            rootIds: ['a', 'd'],
            nodes: {
                a: { id: 'a', parentId: null, text: 'alpha', children: ['b'] },
                b: { id: 'b', parentId: 'a', text: 'beta', children: ['c'] },
                c: { id: 'c', parentId: 'b', text: 'gamma', children: [] },
                d: { id: 'd', parentId: null, text: 'delta', children: [] },
            },
        });
    });
    await page.waitForSelector('.outliner-node[data-id="c"]');
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}

// node の after 帯（y=90%）に Files 型 dragover を clientX 指定で発火
async function dragoverAfter(page: import('@playwright/test').Page, nodeId: string, clientX: number) {
    await page.evaluate(({ nodeId, clientX }) => {
        const el = document.querySelector(`.outliner-node[data-id="${nodeId}"]`) as HTMLElement;
        const rect = el.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }));
        const ev = new DragEvent('dragover', {
            bubbles: true, cancelable: true,
            clientX, clientY: rect.y + rect.height * 0.9,
        });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        el.dispatchEvent(ev);
    }, { nodeId, clientX });
}

async function indicatorLeft(page: import('@playwright/test').Page): Promise<number | null> {
    return page.evaluate(() => {
        const ind = document.querySelector('.outliner-drop-indicator') as HTMLElement | null;
        return ind ? parseInt(ind.style.left || '0', 10) : null;
    });
}

// tree 左端の clientX（depth 計算の基準）
async function treeLeft(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(() => document.querySelector('.outliner-tree')!.getBoundingClientRect().left);
}

test.describe('D&D indent インジケータ', () => {
    test.beforeEach(async ({ page }) => { await initTree(page); });

    // TC-DII-01 ★load-bearing・counterfactual: 旧実装（left:0 固定）だと depth 位置にならず RED
    test('TC-DII-01: 挿入線が挿入先 depth の位置から始まる', async ({ page }) => {
        const left = await treeLeft(page);
        // b(d1) の after 帯・clientX は d1 相当（left + 24*1 + 半分）
        await dragoverAfter(page, 'b', left + 24 * 1 + 12);
        const l = await indicatorLeft(page);
        expect(l).not.toBeNull();
        // b の次の表示 node は c(d2)。範囲 [2, 2]（次 d2 〜 b.depth+1=2）→ depth2 固定
        expect(l).toBe(24 * 2);
    });

    // TC-DII-02 ★load-bearing・counterfactual: clientX 無視（旧実装）だと 3 点同一で RED
    test('TC-DII-02: 境界 after で clientX により depth が切り替わる', async ({ page }) => {
        const left = await treeLeft(page);
        // c(d2) の after = 境界（次の表示 node は d(d0)）。範囲 [0, 3]
        await dragoverAfter(page, 'c', left + 2);           // depth0 相当
        expect(await indicatorLeft(page)).toBe(0);

        await dragoverAfter(page, 'c', left + 24 * 2 + 12); // depth2 相当
        expect(await indicatorLeft(page)).toBe(24 * 2);

        await dragoverAfter(page, 'c', left + 24 * 3 + 12); // depth3 相当（c の子）
        expect(await indicatorLeft(page)).toBe(24 * 3);

        // 範囲外は clamp（過大 → maxDepth=3）
        await dragoverAfter(page, 'c', left + 24 * 10);
        expect(await indicatorLeft(page)).toBe(24 * 3);
    });

    // TC-DII-03 ★load-bearing: 表示 depth と files drop の挿入射影が一致（FR-DII-03）
    test('TC-DII-03: drop の挿入結果が表示 depth と一致（files 経路の射影）', async ({ page }) => {
        const left = await treeLeft(page);
        // c の after で depth0 を選択（インジケータは depth0 位置）
        await dragoverAfter(page, 'c', left + 2);
        expect(await indicatorLeft(page)).toBe(0);

        // そのまま drop（同 clientX）→ depth0 = 祖先 a の直後 → targetId='a', pos='after' に射影
        await page.evaluate(({ left }) => {
            const el = document.querySelector('.outliner-node[data-id="c"]') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.items.add(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }));
            const ev = new DragEvent('drop', {
                bubbles: true, cancelable: true,
                clientX: left + 2, clientY: rect.y + rect.height * 0.9,
            });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            el.dispatchEvent(ev);
        }, { left });
        await page.waitForTimeout(300);

        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const imp = msgs.filter((m: any) => m.type === 'dropFilesImport');
        expect(imp.length).toBe(1);
        expect(imp[0].targetNodeId).toBe('a'); // depth0 = a の直後（祖先へ射影）
        expect(imp[0].position).toBe('after');
    });

    // TC-DII-03b ★load-bearing: node reorder drop も解決結果で挿入（moveNode 経路）
    test('TC-DII-03b: node reorder の drop も選択 depth に挿入', async ({ page }) => {
        // d を掴んで c の after に depth3（c の子）で落とす
        const left = await treeLeft(page);
        // dragState を作る（bullet の実 dragstart。bullet は draggable=true 前提）
        const dragStarted = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="d"]') as HTMLElement;
            const bullet = el.querySelector('.outliner-bullet') as HTMLElement | null;
            if (!bullet) return false;
            const dt = new DataTransfer();
            const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            bullet.dispatchEvent(ev);
            return true;
        });
        expect(dragStarted).toBe(true);
        // c の after 帯で depth3（c の子）を選択して dragover → drop
        await page.evaluate(({ left }) => {
            const el = document.querySelector('.outliner-node[data-id="c"]') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const fire = (type: string) => {
                const dt = new DataTransfer();
                dt.setData('text/plain', 'd');
                const ev = new DragEvent(type, {
                    bubbles: true, cancelable: true,
                    clientX: left + 24 * 3 + 12, clientY: rect.y + rect.height * 0.9,
                });
                Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
                el.dispatchEvent(ev);
            };
            fire('dragover');
            fire('drop');
        }, { left });
        await page.waitForTimeout(200);

        // 検証は再レンダー後の DOM depth（lastSyncData は debounce されるため使わない）
        const depth = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="d"]') as HTMLElement | null;
            return el ? parseInt(el.dataset.depth || '-1', 10) : -1;
        });
        expect(depth).toBe(3); // depth3 = c の子として挿入された
    });

    // TC-DII-04: 一意な after は従来挙動に縮退
    test('TC-DII-04: 同 depth が続く after は従来同等（範囲 1 に縮退）', async ({ page }) => {
        const left = await treeLeft(page);
        // a(d0) の after: 次の表示 node は b(d1)。範囲 [1, 1] → depth1 固定
        await dragoverAfter(page, 'a', left + 2);        // 小さい clientX でも
        expect(await indicatorLeft(page)).toBe(24 * 1);
        await dragoverAfter(page, 'a', left + 24 * 5);   // 大きい clientX でも
        expect(await indicatorLeft(page)).toBe(24 * 1);
    });

    // TC-DII-05: before / child は不変（回帰）
    test('TC-DII-05: before は depth 位置の線 / child は従来の破線箱', async ({ page }) => {
        // before 帯（y=10%）: b(d1) → depth1 位置から
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="b"]') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.items.add(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }));
            const ev = new DragEvent('dragover', {
                bubbles: true, cancelable: true,
                clientX: rect.x + 30, clientY: rect.y + rect.height * 0.1,
            });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            el.dispatchEvent(ev);
        });
        expect(await indicatorLeft(page)).toBe(24 * 1);

        // child 帯（y=50%）: 従来の破線箱（left:0・border あり）
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="b"]') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.items.add(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }));
            const ev = new DragEvent('dragover', {
                bubbles: true, cancelable: true,
                clientX: rect.x + 30, clientY: rect.y + rect.height * 0.5,
            });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            el.dispatchEvent(ev);
        });
        const childBox = await page.evaluate(() => {
            const ind = document.querySelector('.outliner-drop-indicator') as HTMLElement;
            return { left: ind.style.left, hasBorder: !!ind.style.border };
        });
        expect(childBox.left).toBe('0px');
        expect(childBox.hasBorder).toBe(true);
    });

    // TC-DII-06: lastDropResolution のリセット（stale 防止）
    test('TC-DII-06: dragend 後の素の drop は stale 解決を使わない', async ({ page }) => {
        const left = await treeLeft(page);
        // c の after で depth3 を解決させる
        await dragoverAfter(page, 'c', left + 24 * 3 + 12);
        expect(await indicatorLeft(page)).toBe(24 * 3);
        // drop せず dragend（安全網が removeDropIndicator → resolution 破棄）
        await page.evaluate(() => {
            window.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        });
        // 別 node（a）に dragover なしの素の files drop → フォールバック（a の after 相当の従来解決）
        await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const el = document.querySelector('.outliner-node[data-id="a"]') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.items.add(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }));
            const ev = new DragEvent('drop', {
                bubbles: true, cancelable: true,
                clientX: rect.x + 10, clientY: rect.y + rect.height * 0.9,
            });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            el.dispatchEvent(ev);
        });
        await page.waitForTimeout(300);

        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const imp = msgs.filter((m: any) => m.type === 'dropFilesImport');
        expect(imp.length).toBe(1);
        // stale（target=c の depth3 = child of c）が使われず、target=a のまま
        expect(imp[0].targetNodeId).toBe('a');
    });
});
