/**
 * TC-004 — OutlinerCell Phase 4 image cell helpers
 *
 * Sprint: 20260502-230053-outliner-table-editor-mode
 * Task:   TASK-A4 (Phase 4 split of outliner.js → outliner-cell.js)
 *
 * The image helpers use the host-injection pattern. Tests inject a mock host
 * and verify that:
 *   - resolveImageSrc respects baseUri
 *   - getImageDropIndex returns boundary indices
 *   - showImageDropIndicator / clearImageDropIndicators toggle classes
 *   - renderNodeImages places <img.outliner-image-thumb> in container
 */

import { test, expect } from '@playwright/test';

test.describe('TC-004: OutlinerCell Phase 4 image helpers', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('OutlinerCell exposes Phase 4 image API', async ({ page }) => {
        const surface = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return {
                resolveImageSrc: typeof OC?.resolveImageSrc,
                getImageDropIndex: typeof OC?.getImageDropIndex,
                showImageDropIndicator: typeof OC?.showImageDropIndicator,
                clearImageDropIndicators: typeof OC?.clearImageDropIndicators,
                clearImageSelection: typeof OC?.clearImageSelection,
                showImageOverlay: typeof OC?.showImageOverlay,
                renderNodeImages: typeof OC?.renderNodeImages
            };
        });
        expect(surface.resolveImageSrc).toBe('function');
        expect(surface.getImageDropIndex).toBe('function');
        expect(surface.showImageDropIndicator).toBe('function');
        expect(surface.clearImageDropIndicators).toBe('function');
        expect(surface.clearImageSelection).toBe('function');
        expect(surface.showImageOverlay).toBe('function');
        expect(surface.renderNodeImages).toBe('function');
    });

    test('resolveImageSrc respects passed baseUri (host-injected)', async ({ page }) => {
        const out = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return {
                withBase: OC.resolveImageSrc('foo.png', 'https://cdn.example.com/assets'),
                withBaseRelative: OC.resolveImageSrc('./foo.png', 'https://cdn.example.com/assets'),
                noBaseProvided: OC.resolveImageSrc('foo.png', null)
            };
        });
        expect(out.withBase).toBe('https://cdn.example.com/assets/foo.png');
        expect(out.withBaseRelative).toBe('https://cdn.example.com/assets/foo.png');
        // Without baseUri (and no window fallback), returns input as-is
        expect(out.noBaseProvided).toBe('foo.png');
    });

    test('getImageDropIndex returns 0 on empty container', async ({ page }) => {
        const idx = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const container = document.createElement('div');
            return OC.getImageDropIndex(container, 0, 0);
        });
        expect(idx).toBe(0);
    });

    test('renderNodeImages renders <img> elements via host inject', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const container = document.createElement('div');
            document.body.appendChild(container);
            try {
                const node = { id: 'n1', images: ['a.png', 'b.png'] };
                const host = {
                    getImageBaseUri: () => '/base',
                    getModel: () => ({ moveImage: () => {}, getNode: () => node }),
                    saveSnapshot: () => {},
                    scheduleSyncToHost: () => {},
                    getImageDragState: () => null,
                    setImageDragState: (_: any) => {},
                    getSelectedImageInfo: () => null,
                    setSelectedImageInfo: (_: any) => {},
                    isReadOnly: () => false
                };
                OC.renderNodeImages(container, node, host);
                const imgs = container.querySelectorAll('img.outliner-image-thumb');
                return {
                    count: imgs.length,
                    src0: (imgs[0] as HTMLImageElement)?.getAttribute('src'),
                    nodeId0: (imgs[0] as HTMLImageElement)?.dataset.nodeId,
                    idx1: (imgs[1] as HTMLImageElement)?.dataset.index
                };
            } finally {
                container.remove();
            }
        });
        expect(result.count).toBe(2);
        expect(result.src0).toBe('/base/a.png');
        expect(result.nodeId0).toBe('n1');
        expect(result.idx1).toBe('1');
    });

    test('renderNodeImages skips drag handlers in read-only mode', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const container = document.createElement('div');
            document.body.appendChild(container);
            try {
                const host = {
                    getImageBaseUri: () => '/base',
                    isReadOnly: () => true
                };
                OC.renderNodeImages(container, { id: 'n2', images: ['x.png'] }, host);
                const img = container.querySelector('img.outliner-image-thumb') as HTMLImageElement;
                return { draggable: img?.draggable };
            } finally {
                container.remove();
            }
        });
        expect(result.draggable).toBe(false);
    });

    test('clearImageSelection resets via host accessors', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const span = document.createElement('span');
            span.classList.add('is-selected');
            let saved: any = { nodeId: 'n', index: 0, element: span };
            const host = {
                getSelectedImageInfo: () => saved,
                setSelectedImageInfo: (s: any) => { saved = s; }
            };
            OC.clearImageSelection(host);
            return { saved, hasClass: span.classList.contains('is-selected') };
        });
        expect(result.saved).toBeNull();
        expect(result.hasClass).toBe(false);
    });

    test('showImageDropIndicator + clearImageDropIndicators toggle classes', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const container = document.createElement('div');
            for (let i = 0; i < 3; i++) {
                const img = document.createElement('img');
                img.className = 'outliner-image-thumb';
                container.appendChild(img);
            }
            document.body.appendChild(container);
            try {
                OC.showImageDropIndicator(container, 1); // mid drop
                const mid = container.querySelectorAll('.outliner-image-thumb.drop-before').length;
                OC.clearImageDropIndicators(container);
                const cleared = container.querySelectorAll('.drop-before, .drop-after, .is-dragging').length;
                return { mid, cleared };
            } finally {
                container.remove();
            }
        });
        expect(result.mid).toBe(1);
        expect(result.cleared).toBe(0);
    });
});
