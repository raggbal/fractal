/**
 * TC-003 — OutlinerCell Phase 3 cursor / DOM helpers
 *
 * Sprint: 20260502-230053-outliner-table-editor-mode
 * Task:   TASK-A3 (Phase 3 split of outliner.js → outliner-cell.js)
 *
 * Helpers:
 *   - setCursor.toEnd / toStart / atOffset
 *   - getCursor.offset / range
 *   - getPlainText (NBSP normalization)
 *   - getSubtextPlainText (BR / div block normalization)
 *   - getSubtextPreview (first-line ellipsis)
 */

import { test, expect } from '@playwright/test';

test.describe('TC-003: OutlinerCell Phase 3 cursor / DOM helpers', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('OutlinerCell.setCursor / getCursor namespace exists', async ({ page }) => {
        const surface = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return {
                setCursorEnd: typeof OC?.setCursor?.toEnd,
                setCursorStart: typeof OC?.setCursor?.toStart,
                setCursorAtOffset: typeof OC?.setCursor?.atOffset,
                getCursorOffset: typeof OC?.getCursor?.offset,
                getCursorRange: typeof OC?.getCursor?.range,
                flatGetPlainText: typeof OC?.getPlainText,
                flatGetSubtextPlainText: typeof OC?.getSubtextPlainText,
                flatGetSubtextPreview: typeof OC?.getSubtextPreview
            };
        });
        expect(surface.setCursorEnd).toBe('function');
        expect(surface.setCursorStart).toBe('function');
        expect(surface.setCursorAtOffset).toBe('function');
        expect(surface.getCursorOffset).toBe('function');
        expect(surface.getCursorRange).toBe('function');
        expect(surface.flatGetPlainText).toBe('function');
        expect(surface.flatGetSubtextPlainText).toBe('function');
        expect(surface.flatGetSubtextPreview).toBe('function');
    });

    test('setCursor.atOffset → getCursor.offset round-trip', async ({ page }) => {
        const offsets = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.contentEditable = 'true';
            div.textContent = 'hello world';
            document.body.appendChild(div);
            try {
                const out: number[] = [];
                for (const off of [0, 5, 11]) {
                    OC.setCursor.atOffset(div, off);
                    out.push(OC.getCursor.offset(div));
                }
                return out;
            } finally {
                div.remove();
            }
        });
        expect(offsets).toEqual([0, 5, 11]);
    });

    test('setCursor.toEnd / toStart move cursor to extremes', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.contentEditable = 'true';
            div.textContent = 'abcdef';
            document.body.appendChild(div);
            try {
                OC.setCursor.toEnd(div);
                const endOff = OC.getCursor.offset(div);
                OC.setCursor.toStart(div);
                const startOff = OC.getCursor.offset(div);
                return { endOff, startOff };
            } finally {
                div.remove();
            }
        });
        expect(result.endOff).toBe(6);
        expect(result.startOff).toBe(0);
    });

    test('getCursor.range returns null when selection is outside element', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.contentEditable = 'true';
            div.textContent = 'inside';
            document.body.appendChild(div);
            const otherDiv = document.createElement('div');
            otherDiv.contentEditable = 'true';
            otherDiv.textContent = 'outside';
            document.body.appendChild(otherDiv);
            try {
                // Move selection into otherDiv, then query against div
                OC.setCursor.atOffset(otherDiv, 3);
                return OC.getCursor.range(div);
            } finally {
                div.remove();
                otherDiv.remove();
            }
        });
        expect(result).toBeNull();
    });

    test('getPlainText normalizes NBSP to space', async ({ page }) => {
        const out = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.textContent = 'a b c';
            return OC.getPlainText(div);
        });
        expect(out).toBe('a b c');
    });

    test('getSubtextPlainText converts BR to newline', async ({ page }) => {
        const out = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.innerHTML = 'line1<br>line2<br>line3';
            return OC.getSubtextPlainText(div);
        });
        expect(out).toBe('line1\nline2\nline3');
    });

    test('getSubtextPreview returns first line + ellipsis', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return {
                multiline: OC.getSubtextPreview('line one\nline two'),
                single: OC.getSubtextPreview('only one'),
                empty: OC.getSubtextPreview(''),
                falsy: OC.getSubtextPreview(null)
            };
        });
        expect(result.multiline).toBe('line one ...');
        expect(result.single).toBe('only one');
        expect(result.empty).toBe('');
        expect(result.falsy).toBe('');
    });
});
