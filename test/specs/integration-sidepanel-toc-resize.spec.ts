/**
 * F3: Side panel TOC (outline sidebar) drag-resize
 *
 * - resize handle DOM が `.side-panel-sidebar` 内に存在
 * - sidebar が visible 状態の時のみ反応
 * - mousedown/mousemove/mouseup で sidebar の width が変わる
 * - 終了時に幅を保存 (standalone は syncData → .out, notes mode は notesSetSidePanelOutlineWidth)
 *
 * Standalone outliner harness を使う (Notes mode の routing は unit テスト + コードレベル
 * で別途確認)。
 */

import { test, expect } from '@playwright/test';

test.describe('F3: side panel TOC drag-resize', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('resize handle DOM が存在する', async ({ page }) => {
        const handle = page.locator('#sidePanelSidebarResizeHandle');
        await expect(handle).toHaveCount(1);
    });

    test('sidebar が visible でない時は handle は表示されない', async ({ page }) => {
        // Side panel を開かなければ sidebar は visible にならない
        const handle = page.locator('#sidePanelSidebarResizeHandle');
        const visible = await handle.isVisible();
        expect(visible).toBe(false);
    });

    test('CSS: handle にはカーソル col-resize と幅 4px が指定されている', async ({ page }) => {
        const css = await page.evaluate(() => {
            // visible class を強制付与して確認
            const sb = document.querySelector('.side-panel-sidebar') as HTMLElement;
            sb?.classList.add('visible');
            const h = document.getElementById('sidePanelSidebarResizeHandle');
            if (!h) return null;
            const cs = window.getComputedStyle(h);
            return { cursor: cs.cursor, width: cs.width };
        });
        expect(css).not.toBeNull();
        expect(css!.cursor).toBe('col-resize');
        // hover/active 以外の通常時は 4px (CSS に !important なし、:hover で 3px に変化)
        expect(parseFloat(css!.width)).toBeGreaterThanOrEqual(3);
        expect(parseFloat(css!.width)).toBeLessThanOrEqual(5);
    });

    test('drag で sidebar の width が変わる (mousedown → mousemove → mouseup)', async ({ page }) => {
        // sidebar を visible に
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            const sb = document.querySelector('.side-panel-sidebar') as HTMLElement;
            sp?.classList.add('open');
            sp?.style.setProperty('width', '600px');
            sb?.classList.add('visible');
        });
        await page.waitForTimeout(50);

        const handle = page.locator('#sidePanelSidebarResizeHandle');
        const handleBox = await handle.boundingBox();
        expect(handleBox).not.toBeNull();

        const beforeW = await page.evaluate(() => {
            const sb = document.querySelector('.side-panel-sidebar') as HTMLElement;
            return sb?.offsetWidth || 0;
        });

        // 50px 右に drag (sidebar が広がるはず)
        await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox!.x + 50, handleBox!.y + handleBox!.height / 2, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(150);

        const afterW = await page.evaluate(() => {
            const sb = document.querySelector('.side-panel-sidebar') as HTMLElement;
            return sb?.offsetWidth || 0;
        });

        expect(afterW).toBeGreaterThan(beforeW);
    });

    test('standalone mode: drag 終了時に syncData が呼ばれ data.sidePanelOutlineWidth が含まれる', async ({ page }) => {
        // ノードを 1 つ準備して sidebar を visible に
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'A', tags: [] }
                }
            });
            const sp = document.querySelector('.side-panel') as HTMLElement;
            const sb = document.querySelector('.side-panel-sidebar') as HTMLElement;
            sp?.classList.add('open');
            sp?.style.setProperty('width', '600px');
            sb?.classList.add('visible');
        });
        await page.waitForTimeout(50);

        const handle = page.locator('#sidePanelSidebarResizeHandle');
        const box = await handle.boundingBox();
        expect(box).not.toBeNull();

        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + 60, box!.y + box!.height / 2, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(200);

        const syncData = await page.evaluate(() => {
            return (window as any).__testApi.lastSyncData || null;
        });
        expect(syncData).not.toBeNull();

        const parsed = JSON.parse(syncData);
        expect(typeof parsed.sidePanelOutlineWidth).toBe('number');
        expect(parsed.sidePanelOutlineWidth).toBeGreaterThanOrEqual(100);
    });

    test('min 100px clamp: 大きく左に drag しても 100px を切らない', async ({ page }) => {
        await page.evaluate(() => {
            const sp = document.querySelector('.side-panel') as HTMLElement;
            const sb = document.querySelector('.side-panel-sidebar') as HTMLElement;
            sp?.classList.add('open');
            sp?.style.setProperty('width', '600px');
            sb?.classList.add('visible');
        });
        await page.waitForTimeout(50);

        const handle = page.locator('#sidePanelSidebarResizeHandle');
        const box = await handle.boundingBox();
        expect(box).not.toBeNull();

        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x - 500, box!.y + box!.height / 2, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(150);

        const w = await page.evaluate(() => {
            const sb = document.querySelector('.side-panel-sidebar') as HTMLElement;
            return sb?.offsetWidth || 0;
        });
        expect(w).toBeGreaterThanOrEqual(100);
    });
});
