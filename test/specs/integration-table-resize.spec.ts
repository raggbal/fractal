/**
 * Table column resize — pseudo-element approach (no DOM handle inside cells).
 *
 * Resize is detected via mouse position relative to cell's right edge.
 * Visual indicator is via CSS `::after` pseudo-element on cells with
 * `.col-resize-hover` / `.col-resize-resizing` classes.
 *
 * Cells contain NO `.table-col-resize-handle` div — this fixes the cursor-trapping
 * problem where ArrowRight in a cell would land at the right edge.
 */
import { test, expect, Page } from '@playwright/test';

async function loadEditor(page: Page, md: string) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((md) => { (window as any).__testApi.setMarkdown(md); }, md);
    await page.waitForTimeout(200);
}

const TABLE_MD = '| A | B | C |\n|---|---|---|\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n| a3 | b3 | c3 |\n';

// Helper: dispatch a mousedown at a position relative to a cell, then mousemove + mouseup.
// Dispatches ON the cell (event bubbles up to editor's listener with cell as e.target).
async function dragAtCellEdge(page: Page, selector: string, deltaX: number) {
    return await page.evaluate(async ({ sel, dx }) => {
        const cell = document.querySelector(sel) as HTMLElement;
        if (!cell) throw new Error('cell not found: ' + sel);
        const rect = cell.getBoundingClientRect();
        const startX = rect.right;
        const y = rect.top + 5;
        cell.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true,
            clientX: startX, clientY: y
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, cancelable: true,
            clientX: startX + dx, clientY: y
        }));
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    }, { sel: selector, dx: deltaX });
}

test.describe('Table column resize (pseudo-element approach)', () => {

    test('cells do NOT contain .table-col-resize-handle DOM element', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        const r = await page.evaluate(() => {
            const handles = document.querySelectorAll('.editor table .table-col-resize-handle');
            return { handleCount: handles.length };
        });
        // No handle elements in DOM — cursor navigation is unaffected
        expect(r.handleCount).toBe(0);
    });

    test('drag near cell right edge resizes the whole column', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        const before = await page.evaluate(() => {
            const cells = Array.from(document.querySelectorAll('.editor table tr')[1].querySelectorAll('td'));
            return cells.map((c: any) => c.offsetWidth);
        });
        await dragAtCellEdge(page, '.editor table tr:nth-child(3) td:nth-child(1)', 120);
        const after = await page.evaluate(() => {
            const cells = Array.from(document.querySelectorAll('.editor table tr')[1].querySelectorAll('td'));
            return cells.map((c: any) => c.offsetWidth);
        });
        expect(after[0]).toBeGreaterThan(before[0]);
        expect(after[1]).toBe(before[1]);
        expect(after[2]).toBe(before[2]);
    });

    test('all cells in dragged column get .col-resize-resizing class', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        await page.evaluate(() => {
            const cell = document.querySelectorAll('.editor table th')[0] as HTMLElement;
            const rect = cell.getBoundingClientRect();
            cell.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, cancelable: true,
                clientX: rect.right, clientY: rect.top + 10
            }));
        });
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const col0 = Array.from(table.querySelectorAll('tr')).map((row: any) => row.cells[0]);
            const col1 = Array.from(table.querySelectorAll('tr')).map((row: any) => row.cells[1]);
            return {
                col0Total: col0.length,
                col0Resizing: col0.filter((c: any) => c.classList.contains('col-resize-resizing')).length,
                col1Resizing: col1.filter((c: any) => c.classList.contains('col-resize-resizing')).length
            };
        });
        expect(r.col0Total).toBe(4); // header + 3 body rows
        expect(r.col0Resizing).toBe(4);
        expect(r.col1Resizing).toBe(0);

        await page.evaluate(() => {
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(50);
        const afterEnd = await page.evaluate(() => {
            return document.querySelectorAll('.editor table .col-resize-resizing').length;
        });
        expect(afterEnd).toBe(0);
    });

    test('mouse position aligns with column right edge during drag (no drift)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        const result = await page.evaluate(async () => {
            const cell = document.querySelectorAll('.editor table th')[0] as HTMLElement;
            const rect = cell.getBoundingClientRect();
            const targetX = rect.right + 200;
            cell.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, cancelable: true,
                clientX: rect.right, clientY: rect.top + 10
            }));
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true,
                clientX: targetX, clientY: rect.top + 10
            }));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            const newRect = cell.getBoundingClientRect();
            return { targetX, cellRightAfter: newRect.right, drift: Math.abs(targetX - newRect.right) };
        });
        expect(result.drift).toBeLessThan(3);
    });

    test('hover near right edge highlights ALL cells in column with .col-resize-hover', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        await page.evaluate(() => {
            const cell = document.querySelectorAll('.editor table tr')[2].querySelectorAll('td')[0] as HTMLElement;
            const rect = cell.getBoundingClientRect();
            cell.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true,
                clientX: rect.right - 1, clientY: rect.top + 10
            }));
        });
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const col0 = Array.from(table.querySelectorAll('tr')).map((row: any) => row.cells[0]);
            const col1 = Array.from(table.querySelectorAll('tr')).map((row: any) => row.cells[1]);
            return {
                col0Hover: col0.filter((c: any) => c.classList.contains('col-resize-hover')).length,
                col1Hover: col1.filter((c: any) => c.classList.contains('col-resize-hover')).length
            };
        });
        expect(r.col0Hover).toBe(4);
        expect(r.col1Hover).toBe(0);
    });

    test('regression: ArrowRight at end of cell text moves to NEXT cell (no right-edge stop)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        await page.evaluate(() => {
            const td = document.querySelectorAll('.editor table td')[0] as HTMLElement;
            // Find text node "a1"
            const textNode = Array.from(td.childNodes).find((n) => n.nodeType === 3 && n.textContent === 'a1') as Text;
            const r = document.createRange();
            r.setStart(textNode, textNode.textContent!.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        // Press right ONCE — should land in next cell (idx 1)
        await page.keyboard.press('ArrowRight');
        const r = await page.evaluate(() => {
            const sel = window.getSelection()!;
            const range = sel.getRangeAt(0);
            const cell = (range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer) as Element;
            const td = cell.closest ? cell.closest('td, th') : null;
            const cellIdx = td ? Array.from(td.parentNode!.children).indexOf(td) : -1;
            return { cellIdx, container: range.startContainer.nodeName };
        });
        expect(r.cellIdx).toBe(1); // moved to next cell
    });

    test('regression: Shift+Enter in empty cell inserts exactly ONE <br>', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Add an empty row
        await page.evaluate(() => {
            const lastTd = document.querySelectorAll('.editor table td')[2] as HTMLElement;
            lastTd.focus();
            const r = document.createRange();
            r.setStart(lastTd.firstChild!, lastTd.firstChild!.textContent!.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        // Now in empty cell of new row — Shift+Enter
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(100);
        const r = await page.evaluate(() => {
            const sel = window.getSelection()!;
            const range = sel.getRangeAt(0);
            const cell = (range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer) as Element;
            const td = cell.closest ? cell.closest('td, th') : null;
            return { brCount: td?.querySelectorAll('br').length };
        });
        // Original empty <br> + new <br> for line break = 2
        expect(r.brCount).toBe(2);
    });

    test('Enter-inserted row participates in resize (mouse-edge detection works on new cells)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Insert new row via Enter at end of last cell
        await page.evaluate(() => {
            const lastTd = document.querySelectorAll('.editor table td')[2] as HTMLElement;
            lastTd.focus();
            const r = document.createRange();
            r.setStart(lastTd.firstChild!, lastTd.firstChild!.textContent!.length);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        // Drag right edge of NEWLY inserted row's first cell
        const before = await page.evaluate(() => {
            const cells = Array.from(document.querySelectorAll('.editor table tr')[1].querySelectorAll('td'));
            return cells.map((c: any) => c.offsetWidth);
        });
        await page.evaluate(async () => {
            // Last row is the newly inserted one
            const rows = document.querySelectorAll('.editor table tr');
            const newRow = rows[rows.length - 1];
            const newCell = newRow.querySelectorAll('td')[0] as HTMLElement;
            const rect = newCell.getBoundingClientRect();
            newCell.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, cancelable: true,
                clientX: rect.right, clientY: rect.top + 5
            }));
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true,
                clientX: rect.right + 100, clientY: rect.top + 5
            }));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(50);
        const after = await page.evaluate(() => {
            const cells = Array.from(document.querySelectorAll('.editor table tr')[1].querySelectorAll('td'));
            return cells.map((c: any) => c.offsetWidth);
        });
        expect(after[0]).toBeGreaterThan(before[0]);
    });

    test('persistence: resize → htmlToMarkdown emits HTML comment with widths', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        await dragAtCellEdge(page, '.editor table tr:nth-child(1) th:nth-child(1)', 100);
        const r = await page.evaluate(() => {
            const md = (window as any).__testApi.htmlToMarkdown();
            const table = document.querySelector('.editor table');
            return { md, dataAttr: table?.getAttribute('data-col-widths') };
        });
        expect(r.dataAttr).toMatch(/^\d+,\d+,\d+$/);
        expect(r.md).toContain('<!-- fractal-col-widths:');
        const m = r.md.match(/<!-- fractal-col-widths: ([0-9,]+) -->/);
        expect(m).toBeTruthy();
        expect(m![1].split(',').length).toBe(3);
    });

    test('persistence: markdown with comment renders table with fixed widths', async ({ page }) => {
        const md = '<!-- fractal-col-widths: 250,120,80 -->\n| A | B | C |\n|---|---|---|\n| a | b | c |\n';
        await loadEditor(page, md);
        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            return {
                tableLayout: table.style.tableLayout,
                tableWidth: table.style.width,
                colDataAttr: table.getAttribute('data-col-widths'),
                cellWidths: Array.from(table.querySelectorAll('tr:nth-child(1) > th')).map((c: any) => c.style.width)
            };
        });
        expect(r.tableLayout).toBe('fixed');
        expect(r.tableWidth).toBe((250 + 120 + 80) + 'px');
        expect(r.colDataAttr).toBe('250,120,80');
        expect(r.cellWidths).toEqual(['250px', '120px', '80px']);
    });

    test('persistence: roundtrip preserves widths', async ({ page }) => {
        const mdWithWidths = '<!-- fractal-col-widths: 200,150,100 -->\n| A | B | C |\n|---|---|---|\n| a | b | c |\n';
        await loadEditor(page, mdWithWidths);
        const md = await page.evaluate(() => (window as any).__testApi.htmlToMarkdown());
        expect(md).toMatch(/<!-- fractal-col-widths: 200,150,100 -->/);
    });

    test('resize rightmost column does NOT shrink other columns', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        await dragAtCellEdge(page, '.editor table tr:nth-child(1) th:nth-child(1)', 150);
        const phase1 = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.editor table th')).map((c: any) => c.offsetWidth);
        });
        await dragAtCellEdge(page, '.editor table tr:nth-child(1) th:nth-child(3)', 100);
        const phase2 = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.editor table th')).map((c: any) => c.offsetWidth);
        });
        expect(phase2[0]).toBe(phase1[0]);
        expect(phase2[1]).toBe(phase1[1]);
        expect(phase2[2]).toBeGreaterThan(phase1[2]);
    });

    test('drag below min-width clamps and does not throw', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        const before = await page.evaluate(() => {
            return (document.querySelector('.editor table th') as HTMLElement).offsetWidth;
        });
        await dragAtCellEdge(page, '.editor table tr:nth-child(1) th:nth-child(1)', -1000);
        const after = await page.evaluate(() => {
            return (document.querySelector('.editor table th') as HTMLElement).offsetWidth;
        });
        expect(after).toBeGreaterThanOrEqual(80);
        expect(after).toBeLessThanOrEqual(before);
    });
});
