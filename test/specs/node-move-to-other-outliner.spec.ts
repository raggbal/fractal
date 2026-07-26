/**
 * node-move-to-other-outliner — node → 別 .out への D&D move の E2E（FR-NM-01/02）
 *
 * 実 HTML5 D&D の完全再現は困難なため:
 *  - dragstart は実イベントで発火し、dataTransfer に新 MIME が載るかを検証（TC-NM-10/12）
 *  - drop は DataTransfer をモックして file-panel の .out item に drop イベントを発火し、
 *    bridge.notesMoveOutNodeSubtreeIntoOut が呼ばれるかを __testApi.notesMessages で検証（TC-NM-11）
 */
import { test, expect, Page } from '@playwright/test';

const SUBTREE_MIME = 'application/x-fractal-out-node-subtree';

async function initNotesWithOutliner(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // outliner に node を 1 個作る。Outliner.init の第2引数 outFileKey で currentOutFileKey を注入
    // （dragstart payload の outFileKey に載る）
    await page.evaluate(() => {
        (window as any).Outliner.init({
            version: 1,
            rootIds: ['N1'],
            nodes: { N1: { id: 'N1', parentId: null, children: [], text: 'movable node', isPage: false, pageId: null, images: [], filePath: null } },
        }, '/note/outA.out');
        (window as any).__testApi.ready = true;
        // file-panel に .out アイテムを 2 個（自分 + 別 outliner）
        (window as any).__testApi.initNotesPanel(
            [
                { id: 'outA', filePath: '/note/outA.out', title: 'Outliner A' },
                { id: 'outB', filePath: '/note/outB.out', title: 'Outliner B' },
            ],
            '/note/outA.out',
            null, null
        );
    });
    await page.waitForTimeout(200);
}

test.describe('node-move-to-other-outliner (FR-NM-01/02)', () => {
    test('TC-NM-10: notes outliner の node dragstart で subtree MIME が載る（page なしでも）', async ({ page }) => {
        await initNotesWithOutliner(page);
        const types = await page.evaluate(({ mime }) => {
            const bullet = document.querySelector('.outliner-node[data-id="N1"] .outliner-bullet') as HTMLElement;
            if (!bullet) return { err: 'no bullet', types: [] as string[], payload: null };
            const dt = new DataTransfer();
            const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
            bullet.dispatchEvent(ev);
            return {
                err: null,
                types: Array.from(dt.types || []),
                payload: dt.getData(mime) || null,
            };
        }, { mime: SUBTREE_MIME });
        expect(types.err).toBeNull();
        expect(types.types, 'subtree MIME が dataTransfer に載る（page なし node でも）').toContain(SUBTREE_MIME);
        const payload = JSON.parse(types.payload!);
        expect(payload.nodeId).toBe('N1');
        expect(payload.outFileKey).toBeTruthy();
    });

    test('TC-NM-13: dragover で preventDefault される（通常 node でも drop 可能に・HIGH-1 回帰）', async ({ page }) => {
        // HIGH-1: 通常 node（page なし）は subtree MIME のみ持つ。dragover ハンドラが
        // preventDefault しないと HTML5 D&D 仕様で drop イベントが発火しない（実機で無反応）。
        await initNotesWithOutliner(page);
        const prevented = await page.evaluate(({ mime }) => {
            const targetItem = document.querySelector('.file-panel-item[data-item-id="outB"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData(mime, JSON.stringify({ outFileKey: '/note/outA.out', nodeId: 'N1' }));
            const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
            targetItem.dispatchEvent(ev);
            return ev.defaultPrevented;
        }, { mime: SUBTREE_MIME });
        expect(prevented, 'subtree MIME の dragover で preventDefault される（drop が発火可能）').toBe(true);

        // ★counterfactual: MIME を持たない dragover（file-panel drag でもない）→ preventDefault されない
        const notPrevented = await page.evaluate(() => {
            const targetItem = document.querySelector('.file-panel-item[data-item-id="outB"]') as HTMLElement;
            const dt = new DataTransfer(); // MIME なし
            const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
            targetItem.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        expect(notPrevented, 'counterfactual: MIME 無し dragover は preventDefault されない（ゲートが load-bearing）').toBe(false);
    });

    test('TC-NM-11: .out item への drop で notesMoveOutNodeSubtreeIntoOut が呼ばれる（load-bearing）', async ({ page }) => {
        await initNotesWithOutliner(page);
        const result = await page.evaluate(({ mime }) => {
            (window as any).__testApi.notesMessages = [];
            // 別 outliner B の .out item を drop 先にする
            const targetItem = document.querySelector('.file-panel-item[data-item-id="outB"]') as HTMLElement;
            if (!targetItem) return { err: 'no target item', calls: [] };
            const dt = new DataTransfer();
            dt.setData(mime, JSON.stringify({ outFileKey: '/note/outA.out', nodeId: 'N1' }));
            const dropEv = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
            targetItem.dispatchEvent(dropEv);
            const calls = ((window as any).__testApi.notesMessages || [])
                .filter((m: any) => m.type === 'notesMoveOutNodeSubtreeIntoOut');
            return { err: null, calls };
        }, { mime: SUBTREE_MIME });
        expect(result.err).toBeNull();
        expect(result.calls.length, 'move bridge が 1 回呼ばれる').toBe(1);
        expect(result.calls[0].payload.nodeId).toBe('N1');
        expect(result.calls[0].targetOutFilePath).toBe('/note/outB.out');

        // ★counterfactual: 自分自身（outA）に drop → no-op（bridge 呼ばれない）
        const selfDrop = await page.evaluate(({ mime }) => {
            (window as any).__testApi.notesMessages = [];
            const selfItem = document.querySelector('.file-panel-item[data-item-id="outA"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData(mime, JSON.stringify({ outFileKey: '/note/outA.out', nodeId: 'N1' }));
            selfItem.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            return ((window as any).__testApi.notesMessages || [])
                .filter((m: any) => m.type === 'notesMoveOutNodeSubtreeIntoOut').length;
        }, { mime: SUBTREE_MIME });
        expect(selfDrop, 'counterfactual: 自分自身の .out への drop は no-op').toBe(0);
    });
});
