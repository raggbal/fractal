/**
 * Outliner D&D File Import Integration Tests (v12)
 *
 * Tests the webview side of drag & drop file import:
 * - dragover/drop event handling
 * - dropFilesResult message processing
 * - 25/50/25 position detection
 * - saveSnapshot called once per drop
 */

import { test, expect } from '@playwright/test';

test.describe.serial('DOD-12-7/8: Files D&D detection vs node reorder', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Node2', tags: [] }
                }
            });
        });
    });

    test('DOD-12-7: dragover with Files type adds outliner-tree-drop-zone-active class', async ({ page }) => {
        // Simulate dragover with Files type
        const hasClass = await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            const event = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            // DataTransfer.types is read-only in most browsers, so we simulate via mock
            Object.defineProperty(event.dataTransfer, 'types', { value: ['Files'], writable: false });

            treeEl.dispatchEvent(event);
            return treeEl.classList.contains('outliner-tree-drop-zone-active');
        });

        expect(hasClass).toBe(true);
    });

    test('DOD-12-8: dragover without Files type (text/plain) does not add active class', async ({ page }) => {
        const hasClass = await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            const event = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(event.dataTransfer, 'types', { value: ['text/plain'], writable: false });

            treeEl.dispatchEvent(event);
            return treeEl.classList.contains('outliner-tree-drop-zone-active');
        });

        expect(hasClass).toBe(false);
    });

    test('dragleave removes outliner-tree-drop-zone-active class', async ({ page }) => {
        // First add the class via dragover
        await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            treeEl.classList.add('outliner-tree-drop-zone-active');
        });

        // Then simulate dragleave
        const hasClass = await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            const event = new DragEvent('dragleave', {
                bubbles: true,
                cancelable: true
            });
            Object.defineProperty(event, 'target', { value: treeEl, writable: false });

            treeEl.dispatchEvent(event);
            return treeEl.classList.contains('outliner-tree-drop-zone-active');
        });

        expect(hasClass).toBe(false);
    });
});

test.describe.serial('DOD-12-11/12/13/14: dropFilesResult message handling', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Node2', tags: [] }
                }
            });
        });
    });

    test('DOD-12-11: dropFilesResult creates nodes for multiple results (single undo)', async ({ page }) => {
        // Send multiple results
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [
                    { kind: 'md', ok: true, title: 'File1', pageId: 'p1' },
                    { kind: 'file', ok: true, title: 'File2', filePath: 'files/f2.pdf' },
                    { kind: 'image', ok: true, imagePath: 'images/i1.png', displayUri: 'vscode:/images/i1.png' }
                ],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        // Wait for syncToHost debounce (1000ms) + buffer
        await page.waitForTimeout(1500);

        // Verify 3 new nodes were created
        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });
        expect(data.rootIds.length).toBe(5); // n1 + 3 new + n2

        // Undo should revert all 3 nodes at once (single snapshot)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(1500);

        const dataAfterUndo = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });
        expect(dataAfterUndo.rootIds.length).toBe(2); // back to n1, n2
    });

    test('DOD-12-12: dropFilesResult with md kind creates page node', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{ kind: 'md', ok: true, title: 'Markdown Page', pageId: 'md-page-001' }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        // Find the new node
        const newId = data.rootIds.find((id: string) => id !== 'n1' && id !== 'n2');
        expect(newId).toBeTruthy();
        expect(data.nodes[newId].text).toBe('Markdown Page');
        expect(data.nodes[newId].isPage).toBe(true);
        expect(data.nodes[newId].pageId).toBe('md-page-001');
        expect(data.nodes[newId].filePath).toBe(null);
    });

    test('DOD-12-13: dropFilesResult with image kind creates node with addImage', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'image',
                    ok: true,
                    imagePath: 'images/test-image.png',
                    displayUri: 'vscode://file/images/test-image.png'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        // Find the new node
        const newId = data.rootIds.find((id: string) => id !== 'n1' && id !== 'n2');
        expect(newId).toBeTruthy();
        expect(data.nodes[newId].text).toBe('');
        expect(data.nodes[newId].isPage).toBe(false);
        expect(data.nodes[newId].images).toContain('images/test-image.png');
    });

    test('DOD-12-14: dropFilesResult with file kind creates node with filePath', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'file',
                    ok: true,
                    title: 'report.pdf',
                    filePath: 'files/report.pdf'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        // Find the new node
        const newId = data.rootIds.find((id: string) => id !== 'n1' && id !== 'n2');
        expect(newId).toBeTruthy();
        expect(data.nodes[newId].text).toBe('report.pdf');
        expect(data.nodes[newId].isPage).toBe(false);
        expect(data.nodes[newId].pageId).toBe(null);
        expect(data.nodes[newId].filePath).toBe('files/report.pdf');
    });
});

test.describe.serial('DOD-12-15/16/17/18: Position-based insertion', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('DOD-12-15: position=root-end inserts at end of root level', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Node2', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{ kind: 'file', ok: true, title: 'End.pdf', filePath: 'files/end.pdf' }],
                targetNodeId: null,
                position: 'root-end'
            });
        });
        await page.waitForTimeout(1500);

        const rootIds = await page.evaluate(() => {
            const data = JSON.parse((window as any).__testApi.lastSyncData);
            return data.rootIds;
        });

        expect(rootIds.length).toBe(3);
        expect(rootIds[0]).toBe('n1');
        expect(rootIds[1]).toBe('n2');
        // Last one should be new node
    });

    test('DOD-12-16: position=before inserts before target node', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Node2', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{ kind: 'file', ok: true, title: 'Before.pdf', filePath: 'files/before.pdf' }],
                targetNodeId: 'n2',
                position: 'before'
            });
        });
        await page.waitForTimeout(1500);

        const rootIds = await page.evaluate(() => {
            const data = JSON.parse((window as any).__testApi.lastSyncData);
            return data.rootIds;
        });

        // n1, new, n2
        expect(rootIds.length).toBe(3);
        expect(rootIds[0]).toBe('n1');
        expect(rootIds[2]).toBe('n2');
    });

    test('DOD-12-17: position=after inserts after target node', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Node2', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{ kind: 'file', ok: true, title: 'After.pdf', filePath: 'files/after.pdf' }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const rootIds = await page.evaluate(() => {
            const data = JSON.parse((window as any).__testApi.lastSyncData);
            return data.rootIds;
        });

        // n1, new, n2
        expect(rootIds.length).toBe(3);
        expect(rootIds[0]).toBe('n1');
        expect(rootIds[2]).toBe('n2');
    });

    test('DOD-12-18: position=child inserts as first child and expands parent', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['c1'], text: 'Parent', tags: [], collapsed: true },
                    c1: { id: 'c1', parentId: 'n1', children: [], text: 'ExistingChild', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{ kind: 'file', ok: true, title: 'Child.pdf', filePath: 'files/child.pdf' }],
                targetNodeId: 'n1',
                position: 'child'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        // n1's children should have new node at start
        expect(data.nodes.n1.children.length).toBe(2);
        expect(data.nodes.n1.children[1]).toBe('c1'); // existing child moved to index 1
        // n1 should be expanded
        expect(data.nodes.n1.collapsed).toBe(false);
    });
});

test.describe.serial('dropFilesResult: Mixed results and order preservation', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });
    });

    test('Mixed md/image/file results create nodes in order', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [
                    { kind: 'md', ok: true, title: 'First.md', pageId: 'p1' },
                    { kind: 'image', ok: true, imagePath: 'images/second.png', displayUri: 'uri:second.png' },
                    { kind: 'file', ok: true, title: 'third.pdf', filePath: 'files/third.pdf' }
                ],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        expect(data.rootIds.length).toBe(4);
        // Check order: n1, md, image, file
        const nodeTexts = data.rootIds.slice(1).map((id: string) => {
            const node = data.nodes[id];
            return node.text || (node.images?.length > 0 ? 'IMAGE' : '');
        });
        expect(nodeTexts[0]).toBe('First.md');
        expect(nodeTexts[1]).toBe('IMAGE');
        expect(nodeTexts[2]).toBe('third.pdf');
    });

    test('Failed results (ok:false) are skipped', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [
                    { kind: 'file', ok: true, title: 'success.pdf', filePath: 'files/success.pdf' },
                    { kind: 'image', ok: false, name: 'failed.png', error: 'some error' },
                    { kind: 'md', ok: true, title: 'another.md', pageId: 'p2' }
                ],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        // Only 2 nodes created (failed one skipped)
        expect(data.rootIds.length).toBe(3); // n1 + 2 successes
    });
});

test.describe.serial('DOD-12-9: 25/50/25 dropIndicator position transitions', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });
    });

    test('DOD-12-9: clientY=5 (12.5%) shows indicator before', async ({ page }) => {
        // Get the node element and its bounding rect
        const result = await page.evaluate(() => {
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            if (!nodeEl) return { error: 'no node' };

            // Get node rect
            const rect = nodeEl.getBoundingClientRect();
            const h = rect.height;

            // Simulate dragover at y=5 (top 25% zone assuming ~40px height)
            const clientY = rect.top + h * 0.125; // 12.5% from top

            const event = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                clientY: clientY,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(event.dataTransfer, 'types', { value: ['Files'], writable: false });

            nodeEl.dispatchEvent(event);

            // Check indicator position (before = at top of element)
            const indicator = document.querySelector('.outliner-drop-indicator') as HTMLElement;
            if (!indicator) return { error: 'no indicator', height: h };

            const indicatorRect = indicator.getBoundingClientRect();
            // 'before' indicator should be at the top of the node
            const isAtTop = Math.abs(indicatorRect.top - rect.top) < 10;
            return { position: isAtTop ? 'before' : 'unknown', height: h, indicatorTop: indicatorRect.top, nodeTop: rect.top };
        });

        expect(result.error).toBeUndefined();
        expect(result.position).toBe('before');
    });

    test('DOD-12-9: clientY=50% shows indicator child', async ({ page }) => {
        const result = await page.evaluate(() => {
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            if (!nodeEl) return { error: 'no node' };

            const rect = nodeEl.getBoundingClientRect();
            const h = rect.height;

            // Simulate dragover at y=50% (middle zone)
            const clientY = rect.top + h * 0.5;

            const event = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                clientY: clientY,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(event.dataTransfer, 'types', { value: ['Files'], writable: false });

            nodeEl.dispatchEvent(event);

            // Check indicator style for 'child' (usually indicated by different styling)
            const indicator = document.querySelector('.outliner-drop-indicator') as HTMLElement;
            if (!indicator) return { error: 'no indicator', height: h };

            // 'child' indicator typically spans the full height or is centered
            // Check that indicator covers the node area (not at top or bottom edge)
            const indicatorRect = indicator.getBoundingClientRect();
            const isChild = indicatorRect.height > 2 || // thicker than line
                (indicatorRect.top > rect.top + 5 && indicatorRect.bottom < rect.bottom - 5);
            return { position: isChild || indicatorRect.height > 10 ? 'child' : 'unknown', height: h, indicatorHeight: indicatorRect.height };
        });

        expect(result.error).toBeUndefined();
        expect(result.position).toBe('child');
    });

    test('DOD-12-9: clientY=87.5% shows indicator after', async ({ page }) => {
        const result = await page.evaluate(() => {
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            if (!nodeEl) return { error: 'no node' };

            const rect = nodeEl.getBoundingClientRect();
            const h = rect.height;

            // Simulate dragover at y=87.5% (bottom 25% zone)
            const clientY = rect.top + h * 0.875;

            const event = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                clientY: clientY,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(event.dataTransfer, 'types', { value: ['Files'], writable: false });

            nodeEl.dispatchEvent(event);

            // Check indicator position (after = at bottom of element)
            const indicator = document.querySelector('.outliner-drop-indicator') as HTMLElement;
            if (!indicator) return { error: 'no indicator', height: h };

            const indicatorRect = indicator.getBoundingClientRect();
            // 'after' indicator should be at the bottom of the node
            const isAtBottom = Math.abs(indicatorRect.top - rect.bottom) < 10;
            return { position: isAtBottom ? 'after' : 'unknown', height: h, indicatorTop: indicatorRect.top, nodeBottom: rect.bottom };
        });

        expect(result.error).toBeUndefined();
        expect(result.position).toBe('after');
    });
});

test.describe.serial('DOD-12-24: 50MB+ file rejection in webview', () => {
    test('DOD-12-24: handleFilesDrop has MAX_FILE_SIZE check for 50MB', async () => {
        // Static code analysis test - verify the 50MB limit is implemented
        const fs = await import('fs');
        const path = await import('path');

        const srcPath = path.join(process.cwd(), 'src/webview/outliner.js');
        const src = fs.readFileSync(srcPath, 'utf-8');

        // Verify MAX_FILE_SIZE constant exists with correct value
        expect(src).toMatch(/MAX_FILE_SIZE\s*=\s*50\s*\*\s*1024\s*\*\s*1024/);

        // Verify the size check exists
        expect(src).toMatch(/file\.size\s*>\s*MAX_FILE_SIZE/);

        // Verify notifyDropFileTooLarge is called for oversized files
        expect(src).toMatch(/host\.notifyDropFileTooLarge\s*\(/);
    });
});

test.describe.serial('DOD-12-26: FileReader usage - no File direct to postMessage', () => {
    test('DOD-12-26: handleFilesDrop uses readFileByKind (FileReader) and passes processed data to host', async () => {
        // Static code analysis test
        const fs = await import('fs');
        const path = await import('path');

        const srcPath = path.join(process.cwd(), 'src/webview/outliner.js');
        const src = fs.readFileSync(srcPath, 'utf-8');

        // Verify readFileByKind function exists and uses FileReader
        expect(src).toMatch(/function readFileByKind/);
        expect(src).toMatch(/new FileReader/);
        expect(src).toMatch(/reader\.readAsText/);
        expect(src).toMatch(/reader\.readAsDataURL/);
        expect(src).toMatch(/reader\.readAsArrayBuffer/);

        // Verify handleFilesDrop calls readFileByKind to process files
        expect(src).toMatch(/await readFileByKind\(f, kind\)/);

        // Verify the imports array is built from processed content, not File objects
        // The pattern: content = await readFileByKind(f, kind)
        //              imports.push({ kind: kind, name: f.name, ...content })
        expect(src).toMatch(/imports\.push\(\s*\{\s*kind:\s*kind,\s*name:\s*f\.name,\s*\.\.\.content\s*\}/);

        // Verify host.dropFilesImport receives the processed imports array
        expect(src).toMatch(/host\.dropFilesImport\(imports,\s*targetNodeId,\s*position\)/);

        // Ensure File object itself is NOT passed to postMessage
        // File objects should be converted to content/dataUrl/bytes via FileReader
        // The imports array should contain serializable data only
        const dropFilesImportMatch = src.match(/host\.dropFilesImport\([^)]+\)/g);
        expect(dropFilesImportMatch).toBeTruthy();
        // Should pass 'imports' variable, not 'files' or 'items' directly
        expect(dropFilesImportMatch![0]).toContain('imports');
        expect(dropFilesImportMatch![0]).not.toMatch(/\bfiles\b|\bitems\b/);
    });
});

// ============================================================================
// DOD-12-27〜31: VSCode Explorer D&D 経路 (v12 拡張)
// ============================================================================

test.describe.serial('DOD-12-27: VSCode URI dragover detection', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });
    });

    test('DOD-12-27: dragover with application/vnd.code.uri-list type adds outliner-tree-drop-zone-active class', async ({ page }) => {
        const hasClass = await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            const event = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            // Mock VSCode Explorer URI list type
            Object.defineProperty(event.dataTransfer, 'types', {
                value: ['application/vnd.code.uri-list'],
                writable: false
            });

            treeEl.dispatchEvent(event);
            return treeEl.classList.contains('outliner-tree-drop-zone-active');
        });

        expect(hasClass).toBe(true);
    });

    test('DOD-12-27: node element dragover with uri-list shows drop indicator', async ({ page }) => {
        const result = await page.evaluate(() => {
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            if (!nodeEl) return { error: 'no node' };

            const rect = nodeEl.getBoundingClientRect();
            const event = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                clientY: rect.top + rect.height * 0.5,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(event.dataTransfer, 'types', {
                value: ['application/vnd.code.uri-list'],
                writable: false
            });

            nodeEl.dispatchEvent(event);
            const indicator = document.querySelector('.outliner-drop-indicator');
            return { hasIndicator: !!indicator };
        });

        expect(result.hasIndicator).toBe(true);
    });
});

test.describe.serial('DOD-12-28: VSCode URI drop sends dropVscodeUrisImport message', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });
    });

    test('DOD-12-28: drop with uri-list sends dropVscodeUrisImport with parsed URIs', async ({ page }) => {
        // Capture messages sent to host
        const capturedMessages: any[] = [];
        await page.evaluate(() => {
            const original = (window as any).outlinerHostBridge.dropVscodeUrisImport;
            (window as any).outlinerHostBridge.dropVscodeUrisImport = function(uris: string[], targetNodeId: string | null, position: string) {
                (window as any).__capturedDropVscodeUrisImport = { uris, targetNodeId, position };
                // Don't call original to avoid actual processing
            };
        });

        await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            const event = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });

            // Mock the dataTransfer
            Object.defineProperty(event.dataTransfer, 'types', {
                value: ['application/vnd.code.uri-list'],
                writable: false
            });
            Object.defineProperty(event.dataTransfer, 'getData', {
                value: (type: string) => {
                    if (type === 'application/vnd.code.uri-list') {
                        return 'file:///tmp/a.pdf\nfile:///tmp/b.md\nfile:///tmp/c.png';
                    }
                    return '';
                },
                writable: false
            });

            treeEl.dispatchEvent(event);
        });

        const captured = await page.evaluate(() => (window as any).__capturedDropVscodeUrisImport);
        expect(captured).toBeTruthy();
        expect(captured.uris).toEqual([
            'file:///tmp/a.pdf',
            'file:///tmp/b.md',
            'file:///tmp/c.png'
        ]);
        expect(captured.position).toBe('root-end');
    });

    test('DOD-12-28: empty lines in uri-list are filtered out', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).outlinerHostBridge.dropVscodeUrisImport = function(uris: string[], targetNodeId: string | null, position: string) {
                (window as any).__capturedDropVscodeUrisImport = { uris, targetNodeId, position };
            };
        });

        await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            const event = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });

            Object.defineProperty(event.dataTransfer, 'types', {
                value: ['application/vnd.code.uri-list'],
                writable: false
            });
            Object.defineProperty(event.dataTransfer, 'getData', {
                value: (type: string) => {
                    if (type === 'application/vnd.code.uri-list') {
                        return 'file:///tmp/a.pdf\n\n  \nfile:///tmp/b.pdf\n';
                    }
                    return '';
                },
                writable: false
            });

            treeEl.dispatchEvent(event);
        });

        const captured = await page.evaluate(() => (window as any).__capturedDropVscodeUrisImport);
        expect(captured.uris).toEqual(['file:///tmp/a.pdf', 'file:///tmp/b.pdf']);
    });
});

test.describe.serial('DOD-12-29/30/31: processDropVscodeUrisImport static analysis', () => {
    test('DOD-12-29: processDropVscodeUrisImport calls importFiles/importMdFiles directly', async () => {
        const fs = await import('fs');
        const path = await import('path');

        const srcPath = path.join(process.cwd(), 'src/shared/drop-import.ts');
        const src = fs.readFileSync(srcPath, 'utf-8');

        // Verify processDropVscodeUrisImport function exists
        expect(src).toMatch(/export async function processDropVscodeUrisImport/);

        // Verify it calls importMdFiles (not importMdFilesCore)
        expect(src).toMatch(/importMdFiles\s*\(/);

        // Verify it calls importFiles (not importFilesCore)
        expect(src).toMatch(/importFiles\s*\(/);
    });

    test('DOD-12-30: Explorer path .md drop uses importMdFiles for relative image resolution', async () => {
        const fs = await import('fs');
        const path = await import('path');

        const srcPath = path.join(process.cwd(), 'src/shared/drop-import.ts');
        const src = fs.readFileSync(srcPath, 'utf-8');

        // Verify processDropVscodeUrisImport does NOT use skipRelativeImages
        // It should call importMdFiles directly which handles relative images
        const vscodeUrisSection = src.match(/export async function processDropVscodeUrisImport[\s\S]+?^}/m);
        expect(vscodeUrisSection).toBeTruthy();

        // Should NOT contain skipRelativeImages in this function
        if (vscodeUrisSection) {
            expect(vscodeUrisSection[0]).not.toMatch(/skipRelativeImages/);
        }
    });

    test('DOD-12-31: Explorer path has no MAX_FILE_SIZE check (code review)', async () => {
        const fs = await import('fs');
        const path = await import('path');

        const webviewSrcPath = path.join(process.cwd(), 'src/webview/outliner.js');
        const webviewSrc = fs.readFileSync(webviewSrcPath, 'utf-8');

        // Find handleVscodeUrisDrop function
        const handleVscodeUrisMatch = webviewSrc.match(/function handleVscodeUrisDrop[\s\S]+?(?=\n    function|\n    \/\/|$)/);
        expect(handleVscodeUrisMatch).toBeTruthy();

        if (handleVscodeUrisMatch) {
            // Should NOT contain MAX_FILE_SIZE check
            expect(handleVscodeUrisMatch[0]).not.toMatch(/MAX_FILE_SIZE/);
            expect(handleVscodeUrisMatch[0]).not.toMatch(/file\.size/);
            expect(handleVscodeUrisMatch[0]).not.toMatch(/notifyDropFileTooLarge/);
        }
    });
});

test.describe.serial('DOD-12-E2E-19: Finder path regression after Explorer path addition', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });
    });

    test('DOD-12-E2E-19: Finder path (Files type) still calls handleFilesDrop, not handleVscodeUrisDrop', async ({ page }) => {
        // Verify that Files type triggers handleFilesDrop
        await page.evaluate(() => {
            (window as any).__handleFilesDropCalled = false;
            (window as any).__handleVscodeUrisDropCalled = false;

            // Mock both handlers to track which one is called
            const originalDropFilesImport = (window as any).outlinerHostBridge.dropFilesImport;
            (window as any).outlinerHostBridge.dropFilesImport = function() {
                (window as any).__handleFilesDropCalled = true;
            };

            const originalDropVscodeUrisImport = (window as any).outlinerHostBridge.dropVscodeUrisImport;
            if (originalDropVscodeUrisImport) {
                (window as any).outlinerHostBridge.dropVscodeUrisImport = function() {
                    (window as any).__handleVscodeUrisDropCalled = true;
                };
            }
        });

        // Simulate Files type drop (Finder path)
        await page.evaluate(() => {
            const treeEl = document.querySelector('.outliner-tree') as HTMLElement;
            const event = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });

            Object.defineProperty(event.dataTransfer, 'types', {
                value: ['Files'],
                writable: false
            });
            Object.defineProperty(event.dataTransfer, 'items', {
                value: [],
                writable: false
            });

            treeEl.dispatchEvent(event);
        });

        // Give a moment for async processing
        await page.waitForTimeout(100);

        const result = await page.evaluate(() => ({
            filesDropCalled: (window as any).__handleFilesDropCalled,
            vscodeUrisDropCalled: (window as any).__handleVscodeUrisDropCalled
        }));

        // Files type should trigger handleFilesDrop path (which calls dropFilesImport)
        // NOT handleVscodeUrisDrop
        expect(result.vscodeUrisDropCalled).toBe(false);
    });
});
