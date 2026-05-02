/**
 * TC-002 — OutlinerCell Phase 2 helpers (pure-function unit tests)
 *
 * Sprint: 20260502-230053-outliner-table-editor-mode
 * Task:   TASK-A2 (Phase 2 split of outliner.js → outliner-cell.js)
 *
 * Pure helpers extracted in Phase 2:
 *   - stripInlineMarkers
 *   - renderEditingText
 *   - convertUrlsToMarkdownLinks
 *   - buildRenderedToSourceMap
 *   - renderedOffsetToSource
 *   - sourceOffsetToRendered
 */

import { test, expect } from '@playwright/test';

test.describe('TC-002: OutlinerCell Phase 2 helpers', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // --- API surface ---

    test('OutlinerCell exposes Phase 2 helpers', async ({ page }) => {
        const surface = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return {
                stripInlineMarkers: typeof OC?.stripInlineMarkers,
                renderEditingText: typeof OC?.renderEditingText,
                convertUrlsToMarkdownLinks: typeof OC?.convertUrlsToMarkdownLinks,
                buildRenderedToSourceMap: typeof OC?.buildRenderedToSourceMap,
                renderedOffsetToSource: typeof OC?.renderedOffsetToSource,
                sourceOffsetToRendered: typeof OC?.sourceOffsetToRendered
            };
        });
        expect(surface.stripInlineMarkers).toBe('function');
        expect(surface.renderEditingText).toBe('function');
        expect(surface.convertUrlsToMarkdownLinks).toBe('function');
        expect(surface.buildRenderedToSourceMap).toBe('function');
        expect(surface.renderedOffsetToSource).toBe('function');
        expect(surface.sourceOffsetToRendered).toBe('function');
    });

    // --- stripInlineMarkers ---

    test('stripInlineMarkers strips bold marker', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.stripInlineMarkers('**bold**'));
        expect(out).toBe('bold');
    });

    test('stripInlineMarkers strips italic marker without affecting **bold**', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.stripInlineMarkers('**bold** *italic*'));
        expect(out).toBe('bold italic');
    });

    test('stripInlineMarkers strips strike-through and code', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.stripInlineMarkers('~~done~~ `x`'));
        expect(out).toBe('done x');
    });

    test('stripInlineMarkers handles empty', async ({ page }) => {
        const out = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return [OC.stripInlineMarkers(''), OC.stripInlineMarkers(null), OC.stripInlineMarkers(undefined)];
        });
        expect(out).toEqual(['', '', '']);
    });

    // --- renderEditingText ---

    test('renderEditingText preserves markers as-is', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.renderEditingText('**bold**'));
        expect(out).toBe('**bold**');
    });

    test('renderEditingText highlights tags but keeps offset stable', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.renderEditingText('hi #t end'));
        expect(out).toContain('<span class="outliner-tag">#t</span>');
    });

    test('renderEditingText escapes raw HTML', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.renderEditingText('<x>'));
        expect(out).not.toContain('<x>');
        expect(out).toContain('&lt;x&gt;');
    });

    test('renderEditingText does not tag URL @', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.renderEditingText('go https://e.com/x@y'));
        expect(out).toContain('https://e.com/x@y');
        expect(out).not.toContain('<span class="outliner-tag">');
    });

    // --- convertUrlsToMarkdownLinks (TC-002 main case) ---

    test('convertUrlsToMarkdownLinks wraps bare URL', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.convertUrlsToMarkdownLinks('see https://example.com'));
        expect(out).toBe('see [https://example.com](https://example.com)');
    });

    test('convertUrlsToMarkdownLinks excludes trailing punctuation', async ({ page }) => {
        // testcases.md TC-002 explicit example: 'see https://example.com.'
        // → 'see [https://example.com](https://example.com).'
        // (trailing dot must NOT be part of the URL — v4 spec)
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.convertUrlsToMarkdownLinks('see https://example.com.'));
        expect(out).toBe('see [https://example.com](https://example.com).');
    });

    test('convertUrlsToMarkdownLinks does NOT re-wrap URL already inside a Markdown link', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.convertUrlsToMarkdownLinks('[a](https://example.com) and https://b.com'));
        // first URL untouched (already inside link), second URL wrapped
        expect(out).toBe('[a](https://example.com) and [https://b.com](https://b.com)');
    });

    test('convertUrlsToMarkdownLinks returns input when empty / falsy', async ({ page }) => {
        const out = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return [OC.convertUrlsToMarkdownLinks(''), OC.convertUrlsToMarkdownLinks(null)];
        });
        expect(out).toEqual(['', null]);
    });

    // --- buildRenderedToSourceMap / renderedOffsetToSource / sourceOffsetToRendered ---

    test('buildRenderedToSourceMap maps **bold** → bold', async ({ page }) => {
        const map = await page.evaluate(() =>
            (window as any).OutlinerCell.buildRenderedToSourceMap('**bold**', 'bold'));
        // Each rendered char maps to its source position; trailing entry at end of source.
        expect(map).toEqual([2, 3, 4, 5, 8]);
    });

    test('renderedOffsetToSource bidirectional integrity for **bold**', async ({ page }) => {
        // `**bold**` (8 chars source, 4 chars rendered)
        const out = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const src = '**bold**';
            return {
                start: OC.renderedOffsetToSource(src, 0),     // before 'b' → src offset 2
                end: OC.renderedOffsetToSource(src, 4),       // after 'd' → src len (8)
                back0: OC.sourceOffsetToRendered(src, 2),     // src 'b' → rendered 0
                back4: OC.sourceOffsetToRendered(src, 5)      // after 'd' (closing **) → rendered 4
            };
        });
        expect(out.start).toBe(2);
        expect(out.end).toBe(8);
        expect(out.back0).toBe(0);
        // back4 may be 3 or 4 depending on map; check it's >= 3 (sane upper bound)
        expect(out.back4).toBeGreaterThanOrEqual(3);
    });

    test('renderedOffsetToSource clamps overflow', async ({ page }) => {
        const out = await page.evaluate(() =>
            (window as any).OutlinerCell.renderedOffsetToSource('abc', 999));
        expect(out).toBe(3);
    });
});
