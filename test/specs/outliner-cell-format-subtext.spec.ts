/**
 * TC-005 — OutlinerCell Phase 5: applyInlineFormat + subtext open/close
 *
 * Sprint: 20260502-230053-outliner-table-editor-mode
 * Task:   TASK-A5 (Phase 5 split of outliner.js → outliner-cell.js)
 *
 * Phase 5 helpers use full host injection (model + host + saveSnapshot).
 * Tests use mock model + host objects to verify pure behavior in isolation.
 */

import { test, expect } from '@playwright/test';

test.describe('TC-005: OutlinerCell Phase 5 (applyInlineFormat + subtext)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('OutlinerCell exposes Phase 5 API', async ({ page }) => {
        const surface = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            return {
                applyInlineFormat: typeof OC?.applyInlineFormat,
                openSubtext: typeof OC?.openSubtext,
                closeSubtext: typeof OC?.closeSubtext,
                handleSubtextKeydown: typeof OC?.handleSubtextKeydown
            };
        });
        expect(surface.applyInlineFormat).toBe('function');
        expect(surface.openSubtext).toBe('function');
        expect(surface.closeSubtext).toBe('function');
        expect(surface.handleSubtextKeydown).toBe('function');
    });

    test('applyInlineFormat without selection inserts marker pair at cursor', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.contentEditable = 'true';
            div.textContent = 'hello';
            document.body.appendChild(div);
            // place cursor at offset 5 (end)
            OC.setCursor.atOffset(div, 5);
            try {
                let calledSync = 0;
                let updatedText: string | null = null;
                const model = {
                    getNode: (_id: string) => ({ id: 'n1', text: 'hello' }),
                    updateText: (_id: string, t: string) => { updatedText = t; }
                };
                const host = {
                    scheduleSyncToHost: () => { calledSync++; }
                };
                OC.applyInlineFormat({ nodeId: 'n1', textEl: div, marker: '**', model, host });
                return { updatedText, calledSync };
            } finally {
                div.remove();
            }
        });
        // No selection: inserts pair at offset 5 (end) — text becomes 'hello****'
        expect(result.updatedText).toBe('hello****');
        expect(result.calledSync).toBe(1);
    });

    test('applyInlineFormat with selection wraps text in marker', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.contentEditable = 'true';
            div.textContent = 'hello world';
            document.body.appendChild(div);
            // Select 'world' (offset 6..11)
            const range = document.createRange();
            const sel = window.getSelection()!;
            const tn = div.firstChild!;
            range.setStart(tn, 6);
            range.setEnd(tn, 11);
            sel.removeAllRanges();
            sel.addRange(range);
            try {
                let updatedText: string | null = null;
                const model = {
                    getNode: () => ({ id: 'n1', text: 'hello world' }),
                    updateText: (_id: string, t: string) => { updatedText = t; }
                };
                OC.applyInlineFormat({
                    nodeId: 'n1', textEl: div, marker: '**',
                    model, host: { scheduleSyncToHost: () => {} }
                });
                return { updatedText };
            } finally {
                div.remove();
            }
        });
        expect(result.updatedText).toBe('hello **world**');
    });

    test('applyInlineFormat toggles marker off when already wrapped', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const div = document.createElement('div');
            div.contentEditable = 'true';
            div.textContent = 'a **b** c';
            document.body.appendChild(div);
            // Select 'b' (offset 4..5 in '**b**')
            const range = document.createRange();
            const sel = window.getSelection()!;
            const tn = div.firstChild!;
            range.setStart(tn, 4);
            range.setEnd(tn, 5);
            sel.removeAllRanges();
            sel.addRange(range);
            try {
                let updatedText: string | null = null;
                const model = {
                    getNode: () => ({ id: 'n1', text: 'a **b** c' }),
                    updateText: (_id: string, t: string) => { updatedText = t; }
                };
                OC.applyInlineFormat({
                    nodeId: 'n1', textEl: div, marker: '**',
                    model, host: { scheduleSyncToHost: () => {} }
                });
                return { updatedText };
            } finally {
                div.remove();
            }
        });
        // Toggle off: ** removed from each side
        expect(result.updatedText).toBe('a b c');
    });

    test('openSubtext makes subtext editable + focuses + sets cursor at end', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            // Build minimal tree DOM
            const treeEl = document.createElement('div');
            const nodeEl = document.createElement('div');
            nodeEl.className = 'outliner-node';
            nodeEl.dataset.id = 'n1';
            const subtextEl = document.createElement('div');
            subtextEl.className = 'outliner-subtext';
            nodeEl.appendChild(subtextEl);
            treeEl.appendChild(nodeEl);
            document.body.appendChild(treeEl);

            const model = {
                getNode: (id: string) => id === 'n1' ? { id: 'n1', subtext: 'hello\nworld' } : null
            };
            try {
                OC.openSubtext({ nodeId: 'n1', treeEl, model });
                return {
                    isEditing: subtextEl.classList.contains('is-editing'),
                    hasContent: subtextEl.classList.contains('has-content'),
                    textContent: subtextEl.textContent,
                    contentEditable: subtextEl.contentEditable,
                    isFocused: document.activeElement === subtextEl
                };
            } finally {
                treeEl.remove();
            }
        });
        expect(result.isEditing).toBe(true);
        expect(result.hasContent).toBe(true);
        expect(result.textContent).toBe('hello\nworld');
        expect(result.contentEditable).toBe('true');
        expect(result.isFocused).toBe(true);
    });

    test('closeSubtext commits value via model.updateSubtext + calls host.scheduleSyncToHost', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const subtextEl = document.createElement('div');
            subtextEl.classList.add('is-editing', 'has-content');
            subtextEl.contentEditable = 'true';
            subtextEl.innerHTML = 'line1<br>line2';

            let savedSubtext: string | null = null;
            let syncCalled = 0;
            let focusedId: string | null = null;
            const model = {
                getNode: () => ({ id: 'n1' }),
                updateSubtext: (_id: string, t: string) => { savedSubtext = t; }
            };
            const host = {
                scheduleSyncToHost: () => { syncCalled++; },
                focusNode: (id: string) => { focusedId = id; }
            };
            OC.closeSubtext({ nodeId: 'n1', subtextEl, model, host });
            return {
                savedSubtext,
                syncCalled,
                focusedId,
                editingClass: subtextEl.classList.contains('is-editing'),
                contentEditable: subtextEl.contentEditable
            };
        });
        expect(result.savedSubtext).toBe('line1\nline2');
        expect(result.syncCalled).toBe(1);
        expect(result.focusedId).toBe('n1');
        expect(result.editingClass).toBe(false);
        expect(result.contentEditable).toBe('false');
    });

    // sprint 20260806-133523 (許可: test_update): FR-SE-01 で閉じるキーが Shift+Enter →
    // Shift+Cmd+Enter に変更（開くと同キーのトグル統一）。Shift+Enter は改行のデフォルト委譲に。
    test('handleSubtextKeydown Shift+Cmd+Enter closes subtext', async ({ page }) => {
        const result = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const subtextEl = document.createElement('div');
            subtextEl.contentEditable = 'true';
            subtextEl.textContent = 'val';
            document.body.appendChild(subtextEl);
            try {
                let saved: string | null = null;
                let prevented = 0;
                const event = {
                    isComposing: false,
                    keyCode: 13,
                    key: 'Enter',
                    shiftKey: true,
                    metaKey: true,
                    ctrlKey: false,
                    preventDefault: () => { prevented++; }
                };
                const model = {
                    getNode: () => ({ id: 'n' }),
                    updateSubtext: (_id: string, v: string) => { saved = v; }
                };
                OC.handleSubtextKeydown({
                    event, nodeId: 'n', subtextEl, model,
                    host: { scheduleSyncToHost: () => {}, focusNode: () => {} }
                });
                return { saved, prevented };
            } finally {
                subtextEl.remove();
            }
        });
        expect(result.saved).toBe('val');
        expect(result.prevented).toBe(1);
    });
});
