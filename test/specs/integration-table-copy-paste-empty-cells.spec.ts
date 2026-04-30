/**
 * Table copy-paste regression: empty cells with `<br>` must round-trip cleanly.
 *
 * BUG: `normalizeMultiLineTableCells` was applying a Notion-flatten regex unconditionally:
 *      /\|\s*<br>\s*(?=\|)/gi → '|\n'
 *   This broke legitimate `| <br> | <br> |` empty-cell rows by treating them as flattened
 *   row separators. Result: 2-column row turned into 3 single-pipe lines.
 *
 * Fix: only de-flatten lines that ALSO contain a separator pattern `| --- |` on the SAME line
 *   (= clear signal of Notion-flattened single-line table). Multi-line markdown tables with
 *   `| <br> |` empty cells are now untouched.
 */
import { test, expect, Page } from '@playwright/test';

async function loadEditor(page: Page, md: string) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((md) => { (window as any).__testApi.setMarkdown(md); }, md);
    await page.waitForTimeout(200);
}

async function copyAllPasteBelow(page: Page) {
    // Select the table only, copy, then paste in a paragraph BELOW the table
    const copied = await page.evaluate(() => {
        const editor: any = document.querySelector('.editor[contenteditable]');
        const table = editor.querySelector('table');
        if (!table) return '';
        const range = document.createRange();
        range.selectNodeContents(table);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        const data = new DataTransfer();
        const ev = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        editor.dispatchEvent(ev);
        return data.getData('text/x-any-md');
    });
    // Add a target paragraph below the table and put cursor there
    return await page.evaluate((md) => {
        const editor: any = document.querySelector('.editor[contenteditable]');
        const target = document.createElement('p');
        target.innerHTML = '<br>';
        editor.appendChild(target);
        editor.focus();
        const r = document.createRange();
        r.setStart(target, 0);
        r.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        const data = new DataTransfer();
        data.setData('text/x-any-md', md);
        data.setData('text/plain', md);
        const ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        editor.dispatchEvent(ev);
        return (window as any).__testApi.htmlToMarkdown();
    }, copied);
}

test.describe('Table copy-paste: empty cells must survive round-trip', () => {

    test('Simple table with one empty-cell row: paste preserves table structure (no orphan `|`)', async ({ page }) => {
        const md = '| Header 1 | Header 2 |\n| --- | --- |\n| Cell1 | Cell2 |\n| <br> | <br> |\n';
        await loadEditor(page, md);
        const result = await copyAllPasteBelow(page);
        // The CRITICAL bug signature is orphan `|` lines (broken table).
        const lines = result.split('\n');
        for (const line of lines) {
            if (line.trim() === '|') {
                throw new Error('Found orphan `|` line — table was broken: ' + JSON.stringify(result));
            }
        }
    });

    test('Complex table with mixed empty / partial-br cells: no orphan `|` lines', async ({ page }) => {
        const md = '| Header 1 | Header 2 |\n| --- | --- |\n| Cell1 | Cell2 |\n| <br> | <br> |\n| ｄ<br> | <br> |\n| <br>ｄ | ｄ<br> |\n';
        await loadEditor(page, md);
        const result = await copyAllPasteBelow(page);
        const lines = result.split('\n');
        for (const line of lines) {
            if (line.trim() === '|') {
                throw new Error('Found orphan `|` line — table was broken: ' + JSON.stringify(result));
            }
        }
    });

    test('normalizeMultiLineTableCells: legitimate empty cells unchanged', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        const r = await page.evaluate(() => {
            const fn = (window as any).__editorUtils?.normalizeMultiLineTableCells;
            const input = '| Header 1 | Header 2 |\n| --- | --- |\n| Cell1 | Cell2 |\n| <br> | <br> |';
            return { input, output: fn(input) };
        });
        // Output should equal input (no de-flattening applied to legit table)
        expect(r.output).toBe(r.input);
    });

    test('normalizeMultiLineTableCells: Notion-flattened table IS de-flattened', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        const r = await page.evaluate(() => {
            const fn = (window as any).__editorUtils?.normalizeMultiLineTableCells;
            // All on ONE line with `| <br> |` separators between rows AND `| --- |` separator inline
            const input = '| h1 | h2 | <br> | --- | --- | <br> | c1 | c2 |';
            return { output: fn(input) };
        });
        // Should split into rows
        const lines = r.output.split('\n').filter((l: string) => l.trim().length > 0);
        expect(lines.length).toBeGreaterThanOrEqual(3);
        expect(lines).toContain('| h1 | h2 |');
    });

    test('Empty cells serialize as empty (no `<br>` in markdown output)', async ({ page }) => {
        // After Enter or Add Row, new cells contain <br>. Round-trip should produce
        // clean markdown like `|  |  |` instead of `| <br> | <br> |`.
        const md = '| H1 | H2 |\n| --- | --- |\n| a | b |\n';
        await loadEditor(page, md);
        // Insert a new row by simulating Enter at end of last cell
        await page.evaluate(() => {
            const lastCell = document.querySelectorAll('.editor table td')[1] as HTMLElement;
            lastCell.focus();
            const r = document.createRange();
            r.selectNodeContents(lastCell);
            r.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        const md2 = await page.evaluate(() => (window as any).__testApi.htmlToMarkdown());
        // The new row should be empty cells WITHOUT <br>
        expect(md2).not.toContain('<br>');
        // The new row should be `|  |  |` (whitespace) — verify presence
        expect(md2).toMatch(/\|\s+\|\s+\|/);
    });

    test('Mixed cells: pure-empty cells become empty, line-break cells preserve <br>', async ({ page }) => {
        // Cell with `<br>` between text content (line break) should keep `<br>`
        const md = '| H1 | H2 |\n| --- | --- |\n| line1<br>line2 | <br> |\n';
        await loadEditor(page, md);
        const result = await page.evaluate(() => (window as any).__testApi.htmlToMarkdown());
        // text with embedded br is preserved
        expect(result).toMatch(/line1<br>line2/);
        // pure-empty cell does NOT have <br>
        // (the second cell should be just whitespace)
        const lines = result.split('\n');
        const dataRow = lines.find((l) => l.includes('line1<br>line2'));
        expect(dataRow).toBeTruthy();
        // After 'line1<br>line2 |' the next cell should be just whitespace, not <br>
        expect(dataRow).not.toMatch(/line1<br>line2\s*\|\s*<br>/);
    });

    test('normalizeMultiLineTableCells: row with only <br> cells (no separator nearby) is preserved', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        const r = await page.evaluate(() => {
            const fn = (window as any).__editorUtils?.normalizeMultiLineTableCells;
            const input = '| <br> | <br> | <br> |';  // 3 empty cells in a single row, no separator pattern
            return { output: fn(input) };
        });
        // Should NOT be split — no separator pattern → not flattened table
        expect(r.output).toBe('| <br> | <br> | <br> |');
    });
});
