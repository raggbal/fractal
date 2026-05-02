/**
 * TC-001 — OutlinerCell.renderInlineText / classifyLinkHref pure-function unit tests
 *
 * Sprint: 20260502-230053-outliner-table-editor-mode
 * Task:   TASK-A1 (Phase 1 split of outliner.js → outliner-cell.js)
 *
 * These tests pin the pure-function behaviour of the cell-local renderer, so
 * later phases (TASK-A2..A5 and the Outliner Table Editor) can rely on a
 * stable contract. The functions are evaluated inside the standalone-outliner
 * test page, which is the same load environment the production webview uses.
 */

import { test, expect } from '@playwright/test';

test.describe('TC-001: OutlinerCell.renderInlineText / classifyLinkHref', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // --- API surface ---

    test('OutlinerCell global is exposed with required methods', async ({ page }) => {
        const surface = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return {
                hasGlobal: typeof OC === 'object' && OC !== null,
                renderType: typeof OC?.renderInlineText,
                classifyType: typeof OC?.classifyLinkHref
            };
        });
        expect(surface.hasGlobal).toBe(true);
        expect(surface.renderType).toBe('function');
        expect(surface.classifyType).toBe('function');
    });

    // --- renderInlineText: empty / falsy ---

    test('renderInlineText returns empty string for falsy input', async ({ page }) => {
        const out = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return [
                OC.renderInlineText(''),
                OC.renderInlineText(null as any),
                OC.renderInlineText(undefined as any)
            ];
        });
        expect(out).toEqual(['', '', '']);
    });

    // --- renderInlineText: bold / italic / strike / code ---

    test('renderInlineText converts **bold** to <strong>', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('**bold**'));
        expect(html).toBe('<strong>bold</strong>');
    });

    test('renderInlineText converts *italic* to <em> without confusing **bold**', async ({ page }) => {
        const both = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('**bold** *italic*'));
        expect(both).toContain('<strong>bold</strong>');
        expect(both).toContain('<em>italic</em>');
    });

    test('renderInlineText converts `code` to <code>', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('`x`'));
        expect(html).toBe('<code>x</code>');
    });

    test('renderInlineText converts ~~strike~~ to <del>', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('~~done~~'));
        expect(html).toBe('<del>done</del>');
    });

    // --- renderInlineText: tags ---

    test('renderInlineText wraps #tag with span.outliner-tag', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('hello #world'));
        expect(html).toBe('hello <span class="outliner-tag">#world</span>');
    });

    test('renderInlineText wraps Japanese tag (#日本語) with span.outliner-tag', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('text #日本語 end'));
        expect(html).toContain('<span class="outliner-tag">#日本語</span>');
    });

    // --- renderInlineText: links ---

    test('renderInlineText converts [label](url) to <a>', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('see [docs](https://example.com)'));
        expect(html).toContain('<a href="https://example.com"');
        expect(html).toContain('>docs</a>');
    });

    test('renderInlineText preserves raw URL as plain text (does not auto-wrap)', async ({ page }) => {
        // renderInlineText itself preserves raw URLs verbatim (a separate
        // editor-side pass — convertUrlsToMarkdownLinks — handles auto-link
        // conversion before the next render). Critically, the @ in any URL
        // must not be turned into an outliner-tag span.
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('go to https://example.com/x@y now'));
        expect(html).toContain('https://example.com/x@y');
        expect(html).not.toContain('<span class="outliner-tag">');
    });

    // --- renderInlineText: HTML escaping (no XSS for plain input) ---

    test('renderInlineText escapes raw HTML in plain text', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('<script>alert(1)</script>'));
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    test('renderInlineText escapes ampersand', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('a & b'));
        expect(html).toContain('a &amp; b');
    });

    // --- renderInlineText: combined input from testcases.md TC-001 ---

    test('renderInlineText handles bold + italic + code + tag + link in one input', async ({ page }) => {
        const html = await page.evaluate(() =>
            (window as any).OutlinerCell.renderInlineText('**b** *i* `c` #t [l](https://e.com)'));
        // bold span / italic span / code span / tag class / link a が含まれる
        expect(html).toContain('<strong>b</strong>');
        expect(html).toContain('<em>i</em>');
        expect(html).toContain('<code>c</code>');
        expect(html).toContain('<span class="outliner-tag">#t</span>');
        expect(html).toContain('<a href="https://e.com"');
    });

    // --- classifyLinkHref ---

    test('classifyLinkHref returns "" for normal http(s) URLs', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return [
                OC.classifyLinkHref('https://example.com'),
                OC.classifyLinkHref('http://x.test'),
                OC.classifyLinkHref('')
            ];
        });
        expect(result).toEqual(['', '', '']);
    });

    test('classifyLinkHref recognises fractal://note/<id> as link-fractal-node', async ({ page }) => {
        const cls = await page.evaluate(() =>
            (window as any).OutlinerCell.classifyLinkHref('fractal://note/abc123'));
        expect(cls).toBe('link-fractal-node');
    });

    test('classifyLinkHref recognises fractal://note/<id>/page/<pid> as link-fractal-page', async ({ page }) => {
        const cls = await page.evaluate(() =>
            (window as any).OutlinerCell.classifyLinkHref('fractal://note/abc/page/xyz'));
        expect(cls).toBe('link-fractal-page');
    });

    test('classifyLinkHref recognises relative .md path as link-internal-md', async ({ page }) => {
        const cls = await page.evaluate(() =>
            (window as any).OutlinerCell.classifyLinkHref('subdir/foo.md'));
        expect(cls).toBe('link-internal-md');
    });

    test('classifyLinkHref returns "" for fragment-only #anchor', async ({ page }) => {
        const cls = await page.evaluate(() =>
            (window as any).OutlinerCell.classifyLinkHref('#section'));
        expect(cls).toBe('');
    });
});
