/**
 * FR-B08 (sprint 20260804-145603) — Note ファイルツリーの md item → Note Outliner tree D&D
 *
 * dragstart（notes-file-panel.js）で application/x-fractal-tree-md を setData し、
 * outliner tree（outliner.js）の drop が既存 notesImportMdIntoOut（v0.207.77:
 * h1→node text・page 添付・ツリーから md エントリ除去 = 直接 md D&D と同じ結果）へ委譲する。
 *
 * TC-B08-01  md item の dragstart で tree-md MIME + id が dataTransfer に積まれる
 * TC-B08-02  tree への drop で notesImportMdIntoOut(mdFileId, currentOutId) が呼ばれる
 *            （counterfactual: MIME 分岐を外すと files 分岐にも入らず bridge 呼び出しゼロ = RED）
 * TC-B08-03  drop 後に highlight（outliner-tree-drop-zone-active）と dropIndicator が両方消える
 * TC-B08-04  out item のドラッグでは tree-md MIME が積まれない（md 限定）
 */
import { test, expect } from '@playwright/test';

const TREE_MD_MIME = 'application/x-fractal-tree-md';

const fileList = [
    { filePath: '/test/doc.md', title: 'Doc', id: 'mdDoc' },
    { filePath: '/test/plan.out', title: 'Plan', id: 'outPlan' },
];
const structure = {
    version: 1,
    rootIds: ['mdDoc', 'outPlan'],
    items: {
        mdDoc: { type: 'file', id: 'mdDoc', title: 'Doc', ext: 'md' },
        outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out' },
    },
};

async function boot(page: import('@playwright/test').Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/plan.out', structure);
    }, { fileList, structure });
    // outliner 側にも current .out を反映（tree render + currentOutFileKey）
    await page.evaluate(() => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'out', fileChangeId: 1, outFileKey: '/test/plan.out',
            data: { version: 1, rootIds: [], nodes: {}, title: 'Plan' },
        });
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
}

test.describe('FR-B08: ファイルツリー md → Outliner tree D&D (standalone-notes)', () => {
    test.beforeEach(async ({ page }) => { await boot(page); });

    test('TC-B08-01 md item dragstart で tree-md MIME + id が積まれる', async ({ page }) => {
        const payload = await page.evaluate((MIME) => {
            const src = document.querySelector('[data-item-id="mdDoc"]') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const raw = dt.getData(MIME);
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return raw ? JSON.parse(raw) : null;
        }, TREE_MD_MIME);
        expect(payload, 'md item は tree-md MIME を積む').not.toBeNull();
        expect(payload.id).toBe('mdDoc');
    });

    test('TC-B08-02 tree drop で notesImportMdIntoOut(mdFileId, currentOutId) 発火', async ({ page }) => {
        const msgs = await page.evaluate((MIME) => {
            const src = document.querySelector('[data-item-id="mdDoc"]') as HTMLElement;
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = tree.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 50);
            tree.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            tree.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
        }, TREE_MD_MIME);
        const imp = msgs.filter((m: any) => m.type === 'notesImportMdIntoOut');
        expect(imp.length, 'notesImportMdIntoOut が 1 回だけ発火').toBe(1);
        expect(imp[0].mdFileId).toBe('mdDoc');
        expect(imp[0].targetOutId).toBe('outPlan');
    });

    test('TC-B08-03 drop 後に highlight と dropIndicator が両方消える', async ({ page }) => {
        const after = await page.evaluate(() => {
            const src = document.querySelector('[data-item-id="mdDoc"]') as HTMLElement;
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = tree.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 50);
            tree.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            const duringHighlight = tree.classList.contains('outliner-tree-drop-zone-active');
            tree.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return {
                duringHighlight,
                highlight: tree.classList.contains('outliner-tree-drop-zone-active'),
                indicator: document.querySelectorAll('.outliner-drop-indicator').length,
            };
        });
        expect(after.duringHighlight, 'dragover 中は highlight が付く（掃除対象が実在する setup）').toBe(true);
        expect(after.highlight, 'drop 後 highlight 消滅').toBe(false);
        expect(after.indicator, 'drop 後 dropIndicator 消滅').toBe(0);
    });

    test('TC-B08-04 out item のドラッグでは tree-md MIME を積まない（md 限定）', async ({ page }) => {
        const raw = await page.evaluate((MIME) => {
            const src = document.querySelector('[data-item-id="outPlan"]') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const v = dt.getData(MIME);
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return v;
        }, TREE_MD_MIME);
        expect(raw).toBe('');
    });
});
