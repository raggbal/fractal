/**
 * Table column resize: handles on every row + drag tracks mouse + all column handles highlight
 *
 * Bug-fix:
 *   1. mouse↔line desync during drag → use absolute (clientX − cell.left) instead of delta-based math
 *   2. handles only on header → add to all cells (th + td)
 *   3. only dragged handle blue → highlight ALL handles in the column
 */
import { test, expect, Page } from '@playwright/test';

async function loadEditor(page: Page, md: string) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((md) => { (window as any).__testApi.setMarkdown(md); }, md);
    await page.waitForTimeout(200);
}

const TABLE_MD = '| A | B | C |\n|---|---|---|\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n| a3 | b3 | c3 |\n';

test.describe('Table column resize', () => {

    test('resize handles are added to every cell (th + td)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            if (!table) return { err: 'no table' };
            const rows = table.querySelectorAll('tr');
            const counts = Array.from(rows).map((row) => {
                const cells = row.querySelectorAll('th, td');
                let withHandle = 0;
                cells.forEach((c) => {
                    if (c.querySelector(':scope > .table-col-resize-handle')) withHandle++;
                });
                return { totalCells: cells.length, withHandle };
            });
            return { counts };
        });
        if ('err' in r) throw new Error(r.err);
        // Each row has 3 cells, all 3 should have a handle
        for (const c of r.counts) {
            expect(c.totalCells).toBe(3);
            expect(c.withHandle).toBe(3);
        }
    });

    test('drag td handle resizes the whole column', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Initial widths
        const before = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const cells = Array.from(table.querySelectorAll('tr')[1].querySelectorAll('td'));
            return cells.map((c: any) => c.offsetWidth);
        });
        // Drag the second td's handle in column 0 (first column) - simulate mousedown→mousemove→mouseup
        await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            // Pick the second body row's first cell (td) — col 0
            const bodyRow = table.querySelectorAll('tr')[2];
            const td = bodyRow.querySelector('td') as HTMLElement;
            const handle = td.querySelector('.table-col-resize-handle') as HTMLElement;
            const tdRect = td.getBoundingClientRect();
            // Mousedown on handle
            handle.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, cancelable: true,
                clientX: tdRect.right, clientY: tdRect.top + 10
            }));
            // Mousemove +120 px
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true, cancelable: true,
                clientX: tdRect.right + 120, clientY: tdRect.top + 10
            }));
        });
        await page.waitForTimeout(50);
        // Mouseup ends the drag
        await page.evaluate(() => {
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(50);

        const after = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const cells = Array.from(table.querySelectorAll('tr')[1].querySelectorAll('td'));
            return cells.map((c: any) => c.offsetWidth);
        });
        // Column 0 should be wider; columns 1, 2 should be unchanged
        expect(after[0]).toBeGreaterThan(before[0]);
        // Other columns should not change
        expect(after[1]).toBe(before[1]);
        expect(after[2]).toBe(before[2]);
    });

    test('all handles in dragged column are highlighted (.resizing class)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const headerCell = table.querySelector('th') as HTMLElement; // col 0
            const handle = headerCell.querySelector('.table-col-resize-handle') as HTMLElement;
            const rect = headerCell.getBoundingClientRect();
            handle.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, cancelable: true,
                clientX: rect.right, clientY: rect.top + 10
            }));
        });
        await page.waitForTimeout(50);

        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            // All handles for col 0 should have .resizing
            const allHandles = Array.from(table.querySelectorAll('.table-col-resize-handle'));
            const col0Handles = allHandles.filter((h: any) => h.dataset.colIndex === '0');
            const col1Handles = allHandles.filter((h: any) => h.dataset.colIndex === '1');
            return {
                col0Count: col0Handles.length,
                col0Resizing: col0Handles.filter((h) => h.classList.contains('resizing')).length,
                col1Resizing: col1Handles.filter((h) => h.classList.contains('resizing')).length
            };
        });
        // 1 header + 3 body rows = 4 handles in col 0
        expect(r.col0Count).toBe(4);
        // ALL col 0 handles should have .resizing
        expect(r.col0Resizing).toBe(4);
        // col 1 handles should NOT be resizing
        expect(r.col1Resizing).toBe(0);

        // End drag
        await page.evaluate(() => {
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(50);

        const afterEnd = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const allHandles = Array.from(table.querySelectorAll('.table-col-resize-handle'));
            return allHandles.filter((h) => h.classList.contains('resizing')).length;
        });
        expect(afterEnd).toBe(0);
    });

    test('mouse position aligns with column right edge during drag (no delta-drift)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        const result = await page.evaluate(async () => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const headerCell = table.querySelector('th') as HTMLElement;
            const handle = headerCell.querySelector('.table-col-resize-handle') as HTMLElement;
            const rect = headerCell.getBoundingClientRect();
            const targetX = rect.right + 200; // drag 200 px right

            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.right, clientY: rect.top + 10 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: targetX, clientY: rect.top + 10 }));
            // wait a frame for rAF batching
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));

            const newRect = headerCell.getBoundingClientRect();
            // Mouse-relative tracking: cell's right edge should be ~ targetX (clamped to min-width 80)
            return {
                targetX,
                cellRightAfter: newRect.right,
                drift: Math.abs(targetX - newRect.right)
            };
        });
        // drift should be at most a few pixels (sub-pixel rounding)
        expect(result.drift).toBeLessThan(3);
    });

    test('hover on handle highlights ALL handles in column with .col-hover', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // mouseover the second-row first cell's handle (col 0)
        await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const td = table.querySelectorAll('tr')[2].querySelector('td') as HTMLElement;
            const handle = td.querySelector('.table-col-resize-handle') as HTMLElement;
            handle.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const all = Array.from(table.querySelectorAll('.table-col-resize-handle'));
            const col0 = all.filter((h: any) => h.dataset.colIndex === '0');
            const col1 = all.filter((h: any) => h.dataset.colIndex === '1');
            return {
                col0Hover: col0.filter((h) => h.classList.contains('col-hover')).length,
                col1Hover: col1.filter((h) => h.classList.contains('col-hover')).length,
                col0Total: col0.length
            };
        });
        // 4 rows total (1 header + 3 body) → col 0 has 4 handles, all should hover
        expect(r.col0Hover).toBe(4);
        // col 1 not hovered
        expect(r.col1Hover).toBe(0);
    });

    test('Enter-inserted row gets resize handles via MutationObserver', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Place cursor in last body row last cell, press Enter
        await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const lastRow = table.querySelectorAll('tr')[3];
            const lastCell = lastRow.querySelectorAll('td')[2] as HTMLElement;
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
        // Wait for MutationObserver to apply handles
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const rows = table.querySelectorAll('tr');
            // After Enter we should have 5 rows (header + 4 body)
            const newRowCells = rows[rows.length - 1].querySelectorAll('td');
            return {
                rowCount: rows.length,
                newRowCellCount: newRowCells.length,
                newRowHandleCount: Array.from(newRowCells).filter((c) => c.querySelector(':scope > .table-col-resize-handle')).length
            };
        });
        expect(r.rowCount).toBe(5);
        expect(r.newRowCellCount).toBe(3);
        expect(r.newRowHandleCount).toBe(3); // each new cell has a handle
    });

    test('persistence: resize → htmlToMarkdown emits HTML comment with widths', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Resize first column
        await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const headerCell = table.querySelector('th') as HTMLElement;
            const handle = headerCell.querySelector('.table-col-resize-handle') as HTMLElement;
            const rect = headerCell.getBoundingClientRect();
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.right, clientY: rect.top + 10 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: rect.right + 100, clientY: rect.top + 10 }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => {
            const md = (window as any).__testApi.htmlToMarkdown();
            const table = document.querySelector('.editor table');
            return { md, dataAttr: table?.getAttribute('data-col-widths') };
        });
        // data-col-widths should be set
        expect(r.dataAttr).toMatch(/^\d+,\d+,\d+$/);
        // md should contain the comment line
        expect(r.md).toContain('<!-- fractal-col-widths:');
        // numbers should be 3 widths comma-separated
        const m = r.md.match(/<!-- fractal-col-widths: ([0-9,]+) -->/);
        expect(m).toBeTruthy();
        expect(m![1].split(',').length).toBe(3);
    });

    test('persistence: markdown with comment renders table with fixed widths', async ({ page }) => {
        const mdWithWidths = '<!-- fractal-col-widths: 250,120,80 -->\n| A | B | C |\n|---|---|---|\n| a | b | c |\n';
        await loadEditor(page, mdWithWidths);
        const r = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            return {
                tableLayout: table.style.tableLayout,
                tableWidth: table.style.width,
                colDataAttr: table.getAttribute('data-col-widths'),
                cellWidths: Array.from(table.querySelectorAll('th, tr:nth-child(1) > th')).map((c: any) => c.style.width)
            };
        });
        expect(r.tableLayout).toBe('fixed');
        expect(r.tableWidth).toBe((250 + 120 + 80) + 'px');
        expect(r.colDataAttr).toBe('250,120,80');
        // header cells should have explicit widths
        expect(r.cellWidths).toEqual(['250px', '120px', '80px']);
    });

    test('persistence: roundtrip preserves widths', async ({ page }) => {
        const mdWithWidths = '<!-- fractal-col-widths: 200,150,100 -->\n| A | B | C |\n|---|---|---|\n| a | b | c |\n';
        await loadEditor(page, mdWithWidths);
        const md = await page.evaluate(() => (window as any).__testApi.htmlToMarkdown());
        // Should still contain the comment with same widths
        expect(md).toMatch(/<!-- fractal-col-widths: 200,150,100 -->/);
    });

    test('resize rightmost column does NOT shrink other columns (regression)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Phase 1: resize column 0 (left) wider
        const phase1 = await page.evaluate(async () => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const headerCells = table.querySelectorAll('th');
            const c0 = headerCells[0] as HTMLElement;
            const handle = c0.querySelector('.table-col-resize-handle') as HTMLElement;
            const rect = c0.getBoundingClientRect();
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.right, clientY: rect.top + 5 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: rect.right + 150, clientY: rect.top + 5 }));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            return Array.from(table.querySelectorAll('th')).map((c: any) => c.offsetWidth);
        });
        // Record column widths after phase 1 (col 0 should now be ~+150 wider than initial)

        // Phase 2: resize the RIGHTMOST column (col 2). Column 0 width must not shrink.
        const phase2 = await page.evaluate(async () => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const headerCells = table.querySelectorAll('th');
            const c2 = headerCells[2] as HTMLElement;
            const handle = c2.querySelector('.table-col-resize-handle') as HTMLElement;
            const rect = c2.getBoundingClientRect();
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.right, clientY: rect.top + 5 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: rect.right + 100, clientY: rect.top + 5 }));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            return Array.from(table.querySelectorAll('th')).map((c: any) => c.offsetWidth);
        });
        // After resizing col 2, col 0 and col 1 widths should be UNCHANGED
        expect(phase2[0]).toBe(phase1[0]);
        expect(phase2[1]).toBe(phase1[1]);
        // col 2 should be wider after phase 2
        expect(phase2[2]).toBeGreaterThan(phase1[2]);
    });

    test('regression: ArrowRight at end of cell content does NOT land at right edge (handle skip)', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Place cursor at end of "a1" text in second body row first cell
        const result = await page.evaluate(() => {
            const td = document.querySelectorAll('.editor table td')[0] as HTMLElement;
            // Find the text "a1" inside the cell (after the handle)
            const textNode = Array.from(td.childNodes).find((n) => n.nodeType === 3 && n.textContent === 'a1') as Text | undefined;
            if (!textNode) return { err: 'no text' };
            const r = document.createRange();
            r.setStart(textNode, textNode.textContent!.length); // end of "a1"
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
            return { ok: true };
        });
        if ('err' in result) throw new Error(result.err);
        // Press → twice — should land in next cell, not at TD-after-handle position
        await page.keyboard.press('ArrowRight');
        const after1 = await page.evaluate(() => {
            const sel = window.getSelection()!;
            const r = sel.getRangeAt(0);
            const cell = (r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer) as Element;
            const td = cell.closest ? cell.closest('td, th') : null;
            const cellIdx = td ? Array.from(td.parentNode!.children).indexOf(td) : -1;
            return {
                container: r.startContainer.nodeName,
                offset: r.startOffset,
                cellIdx,
                cellText: td?.textContent
            };
        });
        // Should have moved to next cell (idx 1) — NOT stayed in TD with weird offset
        expect(after1.cellIdx).toBe(1);
    });

    test('regression: Shift+Enter in empty cell inserts exactly ONE <br>', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        // Add a new empty row
        await page.evaluate(() => {
            const lastTd = document.querySelectorAll('.editor table td')[2] as HTMLElement; // last td of row 1
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
        // Now in empty cell of new row. Shift+Enter
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(100);
        const r = await page.evaluate(() => {
            const sel = window.getSelection()!;
            const range = sel.getRangeAt(0);
            const cell = (range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer) as Element;
            const td = cell.closest ? cell.closest('td, th') : null;
            return {
                cellHTML: td?.innerHTML,
                brCount: td?.querySelectorAll('br').length
            };
        });
        // Should have exactly 2 brs (the new br + the original empty-cell br) — not 3+
        expect(r.brCount).toBe(2);
    });

    test('drag below min-width clamps and does not throw', async ({ page }) => {
        await loadEditor(page, TABLE_MD);
        const before = await page.evaluate(() => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            return (table.querySelector('th') as HTMLElement).offsetWidth;
        });
        const r = await page.evaluate(async () => {
            const table = document.querySelector('.editor table') as HTMLTableElement;
            const headerCell = table.querySelector('th') as HTMLElement;
            const handle = headerCell.querySelector('.table-col-resize-handle') as HTMLElement;
            const rect = headerCell.getBoundingClientRect();
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.right, clientY: rect.top + 10 }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: rect.left - 100, clientY: rect.top + 10 }));
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            return { width: headerCell.offsetWidth };
        });
        // column shouldn't grow when dragging left past min, and shouldn't be wildly wrong
        expect(r.width).toBeGreaterThanOrEqual(80);
        expect(r.width).toBeLessThanOrEqual(before);
    });
});
