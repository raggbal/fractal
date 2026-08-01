/**
 * outliner-dnd-highlight — outliner D&D の highlight 残留 + drop 信頼性（sprint 20260801-232943）
 *
 * 症状 A: shift なし D&D（drop が webview に届かない）で水色枠
 *   `.outliner-tree-drop-zone-active` が残留し、以降の D&D も阻害される。
 * 症状 B: node の contenteditable テキスト要素上への drop が handler に届かず
 *   添付 node が作られないことがある。
 *
 * TC 定義: sprint の tasks.md（実装レベル sprint のため goal.md/tasks.md に列挙）。
 * synthetic DragEvent + DataTransfer は mindmap-file-drop.spec.ts の先例パターン。
 */

import { test, expect } from '@playwright/test';

// standalone-outliner を使う（notes 版の test bridge は dropFilesImport 未実装のため。
// D&D 配線は outliner.js 共通なので検証対象は同一 — mindmap-file-drop.spec と同じ選択）
async function initTree(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({
            version: 1,
            rootIds: ['a', 'b'],
            nodes: {
                a: { id: 'a', parentId: null, text: 'alpha node', children: [] },
                b: { id: 'b', parentId: null, text: 'beta node', children: [] },
            },
        });
    });
    await page.waitForSelector('.outliner-node[data-id="a"]');
    await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
}

// Files 型の synthetic DragEvent を任意 target に発火（mindmap-file-drop.spec の先例）
async function fireDragEvent(
    page: import('@playwright/test').Page,
    type: string,
    targetSelector: string,
    opts: { withFile?: boolean } = { withFile: true },
) {
    await page.evaluate(({ type, targetSelector, withFile }) => {
        const target = document.querySelector(targetSelector) as HTMLElement;
        const dt = new DataTransfer();
        if (withFile) {
            dt.items.add(new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }));
        }
        const rect = target.getBoundingClientRect();
        const ev = new DragEvent(type, {
            bubbles: true, cancelable: true,
            clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
        });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        target.dispatchEvent(ev);
    }, { type, targetSelector, withFile: opts.withFile !== false });
}

async function hasHighlight(page: import('@playwright/test').Page) {
    return page.evaluate(() =>
        document.querySelector('.outliner-tree')!.classList.contains('outliner-tree-drop-zone-active'));
}

test.describe('outliner D&D highlight ライフサイクル（症状 A）', () => {
    test.beforeEach(async ({ page }) => { await initTree(page); });

    // TC-DH-01 ★load-bearing・counterfactual:
    // フォールバック解除（window dragend / 関与判定 dragleave）を外すと残留で RED。
    // TASK-04 拡張: dropIndicator（node dragover が出す挿入位置インジケータ）も
    // 安全網で消えること（片系統漏れの counterfactual: removeDropIndicator を
    // 安全網から外すと dropIndicator が残留し RED）。
    test('TC-DH-01: drop が来ない drag セッション終了で highlight + dropIndicator が解除される', async ({ page }) => {
        // node 子要素（テキスト）上で dragover → highlight 点灯 + node dragover が dropIndicator 生成
        await fireDragEvent(page, 'dragover', '.outliner-node[data-id="a"] .outliner-text');
        expect(await hasHighlight(page)).toBe(true);
        const hasIndicatorBefore = await page.evaluate(
            () => !!document.querySelector('.outliner-drop-indicator'));
        expect(hasIndicatorBefore).toBe(true);

        // drop は発火させず dragend（shift なし D&D の終わり方）→ 両系統とも解除
        await page.evaluate(() => {
            window.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        });
        expect(await hasHighlight(page)).toBe(false);
        const hasIndicatorAfter = await page.evaluate(
            () => !!document.querySelector('.outliner-drop-indicator'));
        expect(hasIndicatorAfter).toBe(false);
    });

    test('TC-DH-01b: node 子要素上のまま tree 外へ dragleave しても解除される', async ({ page }) => {
        await fireDragEvent(page, 'dragover', '.outliner-node[data-id="a"] .outliner-text');
        expect(await hasHighlight(page)).toBe(true);

        // カーソルが node 子要素上のまま tree 外へ（relatedTarget = tree 外要素 = body）。
        // 旧実装（e.target === treeEl 限定）では解除されず RED
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="a"] .outliner-text')!;
            const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'relatedTarget', { value: document.body, configurable: true });
            textEl.dispatchEvent(ev);
        });
        expect(await hasHighlight(page)).toBe(false);
    });

    // TC-DH-02: 残留状態（人工的に付与）からの通常 drop が正常処理される
    test('TC-DH-02: 残留 highlight が後続 drop を阻害しない', async ({ page }) => {
        await page.evaluate(() => {
            document.querySelector('.outliner-tree')!.classList.add('outliner-tree-drop-zone-active');
            (window as any).__testApi.messages.length = 0;
        });
        await fireDragEvent(page, 'dragover', '.outliner-node[data-id="a"] .outliner-text');
        await fireDragEvent(page, 'drop', '.outliner-node[data-id="a"] .outliner-text');
        await page.waitForTimeout(300); // FileReader async

        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const imports = msgs.filter((m: any) => m.type === 'dropFilesImport');
        expect(imports.length).toBe(1);
        expect(await hasHighlight(page)).toBe(false); // drop で解除もされる
    });

    // TC-DH-04（回帰）: 正常系のライフサイクル不変
    test('TC-DH-04: enter→drop で解除 / enter→tree外 leave で解除（正常系回帰）', async ({ page }) => {
        // enter(over)→drop
        await fireDragEvent(page, 'dragover', '.outliner-tree');
        expect(await hasHighlight(page)).toBe(true);
        await fireDragEvent(page, 'drop', '.outliner-tree');
        await page.waitForTimeout(200);
        expect(await hasHighlight(page)).toBe(false);

        // enter(over)→leave（treeEl 自身から外へ）
        await fireDragEvent(page, 'dragover', '.outliner-tree');
        expect(await hasHighlight(page)).toBe(true);
        await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree')!;
            const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'relatedTarget', { value: document.body, configurable: true });
            tree.dispatchEvent(ev);
        });
        expect(await hasHighlight(page)).toBe(false);
    });
});

test.describe('outliner files drop の信頼性（症状 B）', () => {
    test.beforeEach(async ({ page }) => { await initTree(page); });

    // TC-DH-03（回帰番人）: contenteditable 上への drop で import が発火することを固定。
    // 注: counterfactual 実測では capture 先取りを外しても synthetic drop は bubble handler に
    // 届き green（capture 先取りは実環境の contenteditable 既定処理/stopPropagation 吸収への
    // 対策で、ハーネスでは発火条件を完全再現できない）。load-bearing の実証は TC-DH-03b
    // （フォールバック判定 = counterfactual RED 実測済み）が担う。実環境の効果は手動 US で検収。
    test('TC-DH-03: node の contenteditable テキスト上への drop で添付 import が発火', async ({ page }) => {
        // contenteditable を編集状態にして drop（最も吸われやすい状態を再現）
        await page.evaluate(() => {
            const textEl = document.querySelector('.outliner-node[data-id="a"] .outliner-text') as HTMLElement;
            textEl.setAttribute('contenteditable', 'true');
            textEl.focus();
            (window as any).__testApi.messages.length = 0;
        });
        await fireDragEvent(page, 'drop', '.outliner-node[data-id="a"] .outliner-text');
        await page.waitForTimeout(300);

        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const imports = msgs.filter((m: any) => m.type === 'dropFilesImport');
        expect(imports.length).toBe(1);
        expect(imports[0].targetNodeId).toBe('a'); // 最寄り node が target
    });

    test('TC-DH-03b: types に Files が無く files 実体だけある drop も受理（フォールバック判定）', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.messages.length = 0;
            const target = document.querySelector('.outliner-node[data-id="a"] .outliner-text') as HTMLElement;
            const dt = new DataTransfer();
            dt.items.add(new File([new Uint8Array([1, 2, 3])], 'doc.pdf', { type: 'application/pdf' }));
            const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
            // types を空に偽装（環境により types に 'Files' が乗らないケースの再現）
            Object.defineProperty(dt, 'types', { value: [], configurable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
            target.dispatchEvent(ev);
        });
        await page.waitForTimeout(300);

        const msgs = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
        const imports = msgs.filter((m: any) => m.type === 'dropFilesImport');
        expect(imports.length).toBe(1);
    });
});
