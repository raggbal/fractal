/**
 * 2026-08-05 手動テスト追補 — Outliner page md → Notes tree D&D は 📄 アイコンを掴む
 *
 * TC-PI-01  📄 アイコンの dragstart で application/x-fractal-out-node-page が積まれる
 *           （outFileKey + nodeId + pageId）・draggable=true・bullet の dragState は張られない
 * TC-PI-02  bullet の dragstart では out-node-page MIME を積まない（並べ替え専用に分離。
 *           counterfactual: 旧実装（bullet 積み）に戻すと RED）。subtree MIME は従来どおり bullet に載る
 */
import { test, expect } from '@playwright/test';

const PAGE_MIME = 'application/x-fractal-out-node-page';
const SUBTREE_MIME = 'application/x-fractal-out-node-subtree';

async function boot(page: import('@playwright/test').Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initNotesPanel(
            [{ filePath: '/test/plan.out', title: 'Plan', id: 'outPlan' }],
            '/test/plan.out',
            { version: 1, rootIds: ['outPlan'], items: { outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out' } } });
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'out', fileChangeId: 1, outFileKey: '/test/plan.out',
            data: {
                version: 1, rootIds: ['n1'],
                nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'Page Node', tags: [], isPage: true, pageId: 'pg1', collapsed: false, checked: null, subtext: '', images: [], filePath: null } },
            },
        });
    });
    await page.waitForTimeout(300);
}

test('TC-PI-01 📄 アイコン dragstart で out-node-page MIME（payload 完全）', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(({ PAGE_MIME }) => {
        const icon = document.querySelector('.outliner-page-icon') as HTMLElement;
        if (!icon) return { error: 'no page icon' };
        const dt = new DataTransfer();
        icon.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const raw = dt.getData(PAGE_MIME);
        const dragging = document.querySelectorAll('.is-dragging').length;
        icon.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return { draggable: icon.getAttribute('draggable'), payload: raw ? JSON.parse(raw) : null, dragging };
    }, { PAGE_MIME });
    expect((r as any).error).toBeUndefined();
    expect(r.draggable).toBe('true');
    expect(r.payload).not.toBeNull();
    expect(r.payload.nodeId).toBe('n1');
    expect(r.payload.pageId).toBe('pg1');
    expect(r.payload.outFileKey).toBe('/test/plan.out');
    expect(r.dragging, '📄 drag はノード並べ替えの dragState を張らない').toBe(0);
});

test('TC-PI-02 bullet dragstart は out-node-page を積まない（subtree は従来どおり）', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(({ PAGE_MIME, SUBTREE_MIME }) => {
        const bullet = document.querySelector('.outliner-bullet') as HTMLElement;
        if (!bullet) return { error: 'no bullet' };
        const dt = new DataTransfer();
        bullet.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const pageRaw = dt.getData(PAGE_MIME);
        const subtreeRaw = dt.getData(SUBTREE_MIME);
        bullet.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return { pageRaw, subtreeHas: !!subtreeRaw };
    }, { PAGE_MIME, SUBTREE_MIME });
    expect((r as any).error).toBeUndefined();
    expect(r.pageRaw, 'bullet に page MIME は載らない').toBe('');
    expect(r.subtreeHas, 'subtree 移動 MIME は bullet に残る').toBe(true);
});
