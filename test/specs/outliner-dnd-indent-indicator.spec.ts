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

// TASK-06: 任意の縦比率（ratio）で Files 型 dragover を clientX 指定で発火
async function dragoverAtRatio(page: import('@playwright/test').Page, nodeId: string, clientX: number, ratio: number) {
    await page.evaluate(({ nodeId, clientX, ratio }) => {
        const el = document.querySelector(`.outliner-node[data-id="${nodeId}"]`) as HTMLElement;
        const rect = el.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }));
        const ev = new DragEvent('dragover', {
            bubbles: true, cancelable: true,
            clientX, clientY: rect.y + rect.height * ratio,
        });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        el.dispatchEvent(ev);
    }, { nodeId, clientX, ratio });
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
        // b の次の表示 node は c(d2)。範囲 [2,2]（収束）→ depth2 固定。
        // TASK-05: left は bullet 列整列（depth*24 + CONTENT_OFFSET 18）
        expect(l).toBe(24 * 2 + 18);
    });

    // TC-DII-02 ★load-bearing・counterfactual: clientX 無視（旧実装）だと 3 点同一で RED
    test('TC-DII-02: 境界 after で clientX により depth が切り替わる', async ({ page }) => {
        const left = await treeLeft(page);
        // c(d2) の after = 境界（次の表示 node は d(d0)）。
        // TASK-05 改訂: 範囲 [0, 2]（対象と同階層まで。子 d3 は除外）。left は bullet 整列（+18）
        await dragoverAfter(page, 'c', left + 18 + 2);            // depth0 相当（bullet 列基準）
        expect(await indicatorLeft(page)).toBe(0 + 18);

        await dragoverAfter(page, 'c', left + 18 + 24 * 2 + 12);  // depth2 相当
        expect(await indicatorLeft(page)).toBe(24 * 2 + 18);

        // 範囲外は clamp（過大 → maxDepth=2 = 対象と同階層。子 d3 にはならない）
        await dragoverAfter(page, 'c', left + 24 * 10);
        expect(await indicatorLeft(page)).toBe(24 * 2 + 18);
    });

    // TC-DII-03 ★load-bearing: 表示 depth と files drop の挿入射影が一致（FR-DII-03）
    test('TC-DII-03: drop の挿入結果が表示 depth と一致（files 経路の射影）', async ({ page }) => {
        const left = await treeLeft(page);
        // c の after で depth0 を選択（インジケータは depth0 の bullet 位置）
        await dragoverAfter(page, 'c', left + 2);
        expect(await indicatorLeft(page)).toBe(0 + 18);

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
        // c の after 帯で depth2（c と同階層 = b の子）を選択して dragover → drop
        // TASK-05 改訂: depth3（c の子）は範囲外。同階層挿入で検証
        await page.evaluate(({ left }) => {
            const el = document.querySelector('.outliner-node[data-id="c"]') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const fire = (type: string) => {
                const dt = new DataTransfer();
                dt.setData('text/plain', 'd');
                const ev = new DragEvent(type, {
                    bubbles: true, cancelable: true,
                    clientX: left + 18 + 24 * 2 + 12, clientY: rect.y + rect.height * 0.9,
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
        expect(depth).toBe(2); // depth2 = c の兄弟（b の子）として挿入された
    });

    // TC-DII-07（TASK-05 新規）: after 線から対象の子（depth+1）にはならない ★load-bearing・counterfactual
    // counterfactual: maxDepth を targetDepth+1 に戻すと depth3 に入り RED
    test('TC-DII-07: after 線からは対象の子に drop できない（child は青点線経由のみ）', async ({ page }) => {
        const left = await treeLeft(page);
        // c(d2・子なし) の after で clientX を極端に大きく → clamp は depth2（子 d3 にならない）
        await dragoverAfter(page, 'c', left + 24 * 10);
        expect(await indicatorLeft(page)).toBe(24 * 2 + 18);

        // そのまま drop（files）→ 射影は c の after（同階層）であり child ではない
        await page.evaluate(({ left }) => {
            (window as any).__testApi.messages.length = 0;
            const el = document.querySelector('.outliner-node[data-id="c"]') as HTMLElement;
            const rect = el.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.items.add(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }));
            const ev = new DragEvent('drop', {
                bubbles: true, cancelable: true,
                clientX: left + 24 * 10, clientY: rect.y + rect.height * 0.9,
            });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            el.dispatchEvent(ev);
        }, { left });
        await page.waitForTimeout(300);

        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const imp = msgs.filter((m: any) => m.type === 'dropFilesImport');
        expect(imp.length).toBe(1);
        expect(imp[0].targetNodeId).toBe('c');
        expect(imp[0].position).toBe('after'); // child でない
    });

    // TC-DII-04: 一意な after は従来挙動に縮退
    test('TC-DII-04: 同 depth が続く after は従来同等（範囲 1 に縮退）', async ({ page }) => {
        const left = await treeLeft(page);
        // a(d0) の after: 次の表示 node は b(d1)。範囲 [1,1] 収束 → depth1（先頭の子の位置）固定
        await dragoverAfter(page, 'a', left + 2);        // 小さい clientX でも
        expect(await indicatorLeft(page)).toBe(24 * 1 + 18);
        await dragoverAfter(page, 'a', left + 24 * 5);   // 大きい clientX でも
        expect(await indicatorLeft(page)).toBe(24 * 1 + 18);
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
        expect(await indicatorLeft(page)).toBe(24 * 1 + 18);

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
        // c の after で depth2（改訂後の maxDepth）を解決させる
        await dragoverAfter(page, 'c', left + 24 * 5);
        expect(await indicatorLeft(page)).toBe(24 * 2 + 18);
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

    // TC-DII-08（TASK-06 新規）: after 帯拡大で下端 40% でも clientX 量子化が効く ★load-bearing・counterfactual
    // 真因: clientX による depth 選択は position==='after' でのみ効き、旧実装では after 帯が
    //   「下端 25%（y>h*0.75）」と薄く、純粋な左右移動で帯から外れ clientX が無視されていた。
    // 修正: after 帯を「下端 40%（y>h*0.60）」に拡大。ratio=0.65（旧 0.75 帯の外・新 0.60 帯の内）で
    //   after が発火し clientX で depth が切り替わることを assert。
    // counterfactual（実測済み）: しきい値を 0.75 に戻すと ratio=0.65 は child 帯に落ち、
    //   indicator が破線箱（left:0px・border あり・clientX 無視）になり、2 座標で同じ left になって RED。
    test('TC-DII-08: 下端 40% 帯（ratio 0.65）でも clientX により depth が切り替わる', async ({ page }) => {
        const left = await treeLeft(page);
        // c(d2) の after = 境界（次の表示 node は d(d0)・範囲 [0,2]）。ratio=0.65 で after を発火。
        // depth0 相当の clientX
        await dragoverAtRatio(page, 'c', left + 18 + 2, 0.65);
        const shallow = await page.evaluate(() => {
            const ind = document.querySelector('.outliner-drop-indicator') as HTMLElement | null;
            return ind ? { left: ind.style.left, hasBorder: !!ind.style.border } : null;
        });
        expect(shallow).not.toBeNull();
        // after 線（破線箱でない）= depth0 の bullet 位置
        expect(shallow!.hasBorder).toBe(false);
        expect(shallow!.left).toBe(0 + 18 + 'px');

        // depth2 相当の clientX（同じ ratio=0.65）→ 線が depth2 位置へ = 横移動が帯内で効く
        await dragoverAtRatio(page, 'c', left + 18 + 24 * 2 + 12, 0.65);
        const deep = await page.evaluate(() => {
            const ind = document.querySelector('.outliner-drop-indicator') as HTMLElement | null;
            return ind ? { left: ind.style.left, hasBorder: !!ind.style.border } : null;
        });
        expect(deep).not.toBeNull();
        expect(deep!.hasBorder).toBe(false);
        expect(deep!.left).toBe(24 * 2 + 18 + 'px');

        // 2 座標で left が異なる = clientX 量子化が新帯で機能している（旧 0.75 帯なら両方 child 箱 left:0）
        expect(shallow!.left).not.toBe(deep!.left);
    });

    // TC-DII-09（TASK-06 回帰）: child 帯の中央（ratio 0.5）は不変 = 従来の破線箱
    // 帯境界の移動で child が中央 50%→40% に縮むが、中央 0.5 は依然 child であることの番人。
    test('TC-DII-09: child 帯中央（ratio 0.5）は従来どおり破線箱（帯縮小の回帰）', async ({ page }) => {
        const left = await treeLeft(page);
        // b(d1) の中央 ratio=0.5 は 0.25–0.60 の child 帯内
        await dragoverAtRatio(page, 'b', left + 30, 0.5);
        const box = await page.evaluate(() => {
            const ind = document.querySelector('.outliner-drop-indicator') as HTMLElement;
            return { left: ind.style.left, hasBorder: !!ind.style.border };
        });
        expect(box.left).toBe('0px');    // child は全幅箱（left:0）
        expect(box.hasBorder).toBe(true); // 破線 border あり
    });
});
