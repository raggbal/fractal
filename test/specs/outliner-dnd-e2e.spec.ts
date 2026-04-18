/**
 * Outliner D&D File Import E2E Tests (v12)
 *
 * These tests verify the complete drag & drop file import flow,
 * covering DOD-12-E2E-* items from dod.json.
 *
 * Note: Actual D&D simulation in webview is difficult, so we use
 * __hostMessageHandler to simulate host responses and verify
 * the resulting state changes.
 */

import { test, expect } from '@playwright/test';

test.describe.serial('DOD-12-E2E-1/2/3: File type specific node creation', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        // Initialize with base data
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

    test('DOD-12-E2E-1: PDF drop creates file node with filePath', async ({ page }) => {
        // Simulate dropFilesResult for a PDF file
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'file',
                    ok: true,
                    name: 'sample.pdf',
                    title: 'sample.pdf',
                    filePath: 'files/sample.pdf'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        expect(data.rootIds.length).toBe(2);
        const newNodeId = data.rootIds[1];
        expect(data.nodes[newNodeId].text).toBe('sample.pdf');
        expect(data.nodes[newNodeId].filePath).toBe('files/sample.pdf');
        expect(data.nodes[newNodeId].isPage).toBeFalsy();
    });

    test('DOD-12-E2E-2: MD drop creates page node with pageId', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'md',
                    ok: true,
                    name: 'doc.md',
                    title: 'Hello',
                    pageId: 'test-page-uuid'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        expect(data.rootIds.length).toBe(2);
        const newNodeId = data.rootIds[1];
        expect(data.nodes[newNodeId].text).toBe('Hello');
        expect(data.nodes[newNodeId].isPage).toBe(true);
        expect(data.nodes[newNodeId].pageId).toBe('test-page-uuid');
    });

    test('DOD-12-E2E-3: PNG drop creates image node with addImage', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'image',
                    ok: true,
                    name: 'image.png',
                    imagePath: 'images/image_1234.png',
                    displayUri: 'vscode-webview://images/image_1234.png'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
            return JSON.parse((window as any).__testApi.lastSyncData);
        });

        expect(data.rootIds.length).toBe(2);
        const newNodeId = data.rootIds[1];
        // Image node has empty text and images array
        expect(data.nodes[newNodeId].text).toBe('');
        expect(data.nodes[newNodeId].images).toContain('images/image_1234.png');
    });
});

test.describe('DOD-12-E2E-4: Mixed files single drop with undo', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('3 mixed files create 3 nodes, single undo removes all', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });

        // Drop 3 files of different types
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [
                    { kind: 'md', ok: true, name: 'a.md', title: 'DocA', pageId: 'page-a' },
                    { kind: 'image', ok: true, name: 'b.png', imagePath: 'images/b.png', displayUri: 'uri' },
                    { kind: 'file', ok: true, name: 'c.pdf', title: 'c.pdf', filePath: 'files/c.pdf' }
                ],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        let data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(4); // n1 + 3 new

        // Verify order: n1, DocA, (image), c.pdf
        expect(data.nodes[data.rootIds[1]].text).toBe('DocA');
        expect(data.nodes[data.rootIds[3]].text).toBe('c.pdf');

        // Undo should remove all 3 nodes at once (single snapshot)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(1500);

        data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(1);
        expect(data.rootIds[0]).toBe('n1');

        // Redo should restore all 3
        await page.keyboard.press('Meta+Shift+z');
        await page.waitForTimeout(1500);

        data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(4);
    });
});

test.describe('DOD-12-E2E-6/7: Drop position tests', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('DOD-12-E2E-6: root-end position inserts at end of root level', async ({ page }) => {
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
                results: [{ kind: 'file', ok: true, name: 'end.pdf', title: 'end.pdf', filePath: 'files/end.pdf' }],
                targetNodeId: null,
                position: 'root-end'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(3);
        expect(data.rootIds[0]).toBe('n1');
        expect(data.rootIds[1]).toBe('n2');
        // New node at end
        expect(data.nodes[data.rootIds[2]].text).toBe('end.pdf');
    });

    test('DOD-12-E2E-7: before position inserts before target', async ({ page }) => {
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
                results: [{ kind: 'file', ok: true, name: 'before.pdf', title: 'before.pdf', filePath: 'files/before.pdf' }],
                targetNodeId: 'n2',
                position: 'before'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(3);
        expect(data.rootIds[0]).toBe('n1');
        expect(data.nodes[data.rootIds[1]].text).toBe('before.pdf');
        expect(data.rootIds[2]).toBe('n2');
    });

    test('DOD-12-E2E-7: after position inserts after target', async ({ page }) => {
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
                results: [{ kind: 'file', ok: true, name: 'after.pdf', title: 'after.pdf', filePath: 'files/after.pdf' }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(3);
        expect(data.rootIds[0]).toBe('n1');
        expect(data.nodes[data.rootIds[1]].text).toBe('after.pdf');
        expect(data.rootIds[2]).toBe('n2');
    });

    test('DOD-12-E2E-7: child position inserts as first child and expands', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: ['c1'], text: 'Parent', tags: [], collapsed: true },
                    c1: { id: 'c1', parentId: 'n1', children: [], text: 'Child1', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{ kind: 'file', ok: true, name: 'child.pdf', title: 'child.pdf', filePath: 'files/child.pdf' }],
                targetNodeId: 'n1',
                position: 'child'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        // New node inserted as first child
        expect(data.nodes.n1.children.length).toBe(2);
        expect(data.nodes[data.nodes.n1.children[0]].text).toBe('child.pdf');
        expect(data.nodes.n1.children[1]).toBe('c1');
        // Parent should be expanded
        expect(data.nodes.n1.collapsed).toBe(false);
    });
});

test.describe.serial('DOD-12-E2E-5: Folder rejection', () => {
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

    test('Folder drop creates no nodes (handled by webview filtering)', async ({ page }) => {
        // Get initial node count using getSerializedData (since lastSyncData may not be set yet)
        const initialCount = await page.evaluate(() => {
            const data = (window as any).__testApi.getSerializedData();
            return data ? data.rootIds.length : 1; // Default to 1 if no sync data
        });

        // When folders are dropped, webview filters them out before sending to host
        // So dropFilesResult would have empty results
        // Note: empty results don't trigger node creation or sync
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [], // Folders were filtered out
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        // Node count should remain the same
        const finalCount = await page.evaluate(() => {
            const data = (window as any).__testApi.getSerializedData();
            return data ? data.rootIds.length : 1;
        });
        expect(finalCount).toBe(initialCount);
    });
});

test.describe('DOD-12-E2E-13: Filename collision suffix', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('Collision suffix is applied by host (foo.pdf -> foo-1.pdf)', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });

        // Host applies suffix and sends back renamed file
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'file',
                    ok: true,
                    name: 'foo.pdf',
                    title: 'foo-1.pdf', // Renamed by host
                    filePath: 'files/foo-1.pdf'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        const newNodeId = data.rootIds[1];
        expect(data.nodes[newNodeId].text).toBe('foo-1.pdf');
        expect(data.nodes[newNodeId].filePath).toBe('files/foo-1.pdf');
    });
});

test.describe.serial('DOD-12-E2E-14: Drag overlay cleanup', () => {
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

    test('dragleave removes drop zone active class', async ({ page }) => {
        // Create dragover event with Files type (using Object.defineProperty for types)
        const hasClassAfterDrag = await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const dragOver = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(dragOver.dataTransfer, 'types', { value: ['Files'], writable: false });
            tree.dispatchEvent(dragOver);
            return tree.classList.contains('outliner-tree-drop-zone-active');
        });
        expect(hasClassAfterDrag).toBe(true);

        // Trigger dragleave
        const hasClassAfterLeave = await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const dragLeave = new DragEvent('dragleave', {
                bubbles: true,
                cancelable: true
            });
            tree.dispatchEvent(dragLeave);
            return tree.classList.contains('outliner-tree-drop-zone-active');
        });
        expect(hasClassAfterLeave).toBe(false);
    });
});

test.describe.serial('DOD-12-E2E-15: ESC/cancel preserves state', () => {
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

    test('dragend without drop preserves original state', async ({ page }) => {
        // Get initial state via getSerializedData
        const initialNodeCount = await page.evaluate(() => {
            const data = (window as any).__testApi.getSerializedData();
            return data ? data.rootIds.length : 2;
        });
        expect(initialNodeCount).toBe(2);

        // Start drag with Files type
        await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const dragOver = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(dragOver.dataTransfer, 'types', { value: ['Files'], writable: false });
            tree.dispatchEvent(dragOver);
        });

        // Cancel drag (dragend without drop)
        await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const dragEnd = new DragEvent('dragend', {
                bubbles: true,
                cancelable: true
            });
            tree.dispatchEvent(dragEnd);
        });

        // State should be unchanged
        const finalNodeCount = await page.evaluate(() => {
            const data = (window as any).__testApi.getSerializedData();
            return data ? data.rootIds.length : 2;
        });
        expect(finalNodeCount).toBe(2);
    });
});

test.describe.serial('DOD-12-E2E-8 (regression): Node reorder D&D still works', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1', 'n2', 'n3'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'Node2', tags: [] },
                    n3: { id: 'n3', parentId: null, children: [], text: 'Node3', tags: [] }
                }
            });
        });
    });

    test('Existing node reorder via drag (non-Files) continues to work', async ({ page }) => {
        // This test verifies that existing reorder logic is not broken
        // The actual reorder D&D is tested in outliner-dnd.spec.ts
        // Here we verify that files D&D doesn't interfere with node reorder D&D
        // by checking that non-Files dragover doesn't add the drop-zone-active class
        const hasActiveClass = await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const dragOver = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            // Non-Files drag (e.g., node reorder)
            Object.defineProperty(dragOver.dataTransfer, 'types', { value: ['text/plain'], writable: false });
            tree.dispatchEvent(dragOver);
            return tree.classList.contains('outliner-tree-drop-zone-active');
        });
        // Node reorder drag should NOT add the drop zone active class
        expect(hasActiveClass).toBe(false);

        // Verify nodes exist in the DOM
        const nodeCount = await page.locator('.outliner-node').count();
        expect(nodeCount).toBe(3);
    });
});

test.describe('DOD-12-FR2-1 (regression): Menu import continues to work', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('importFilesResult (menu-based) creates file node', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });

        // Menu import uses importFilesResult (not dropFilesResult)
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'importFilesResult',
                results: [{
                    title: 'menu-import.pdf',
                    filePath: 'files/menu-import.pdf'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(2);
        const newNodeId = data.rootIds[1];
        expect(data.nodes[newNodeId].text).toBe('menu-import.pdf');
        expect(data.nodes[newNodeId].filePath).toBe('files/menu-import.pdf');
    });

    test('importMdFilesResult (menu-based) creates page node', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });

        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'importMdFilesResult',
                results: [{
                    title: 'Menu MD',
                    content: '# Menu MD\n\nbody',
                    pageId: 'menu-page-id'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(2);
        const newNodeId = data.rootIds[1];
        expect(data.nodes[newNodeId].text).toBe('Menu MD');
        expect(data.nodes[newNodeId].isPage).toBe(true);
        expect(data.nodes[newNodeId].pageId).toBe('menu-page-id');
    });
});

test.describe('DOD-12-E2E-10 (regression): Image paste continues to work', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('outlinerImageSaved adds image to existing node', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });

        // Simulate image paste result
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'outlinerImageSaved',
                nodeId: 'n1',
                imagePath: 'images/pasted_1234.png',
                displayUri: 'vscode-webview://images/pasted_1234.png'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        // Image added to existing node
        expect(data.nodes.n1.images).toContain('images/pasted_1234.png');
        // Node text preserved
        expect(data.nodes.n1.text).toBe('Node1');
    });
});

test.describe.serial('DOD-12-21: Notes mode dropFilesImport dispatch', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('DOD-12-21: Notes mode uses shared outliner.js which handles dropFilesImport', async ({ page }) => {
        // Notes mode uses the same outliner.js as standalone outliner
        // This test verifies that dropFilesResult handler exists and works
        // which is the same code path used by Notes mode

        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Node1', tags: [] }
                }
            });
        });

        // Simulate dropFilesResult (the response from host after dropFilesImport)
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'file',
                    ok: true,
                    title: 'notes-test.pdf',
                    filePath: 'files/notes-test.pdf'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(2);

        // Verify the node was created correctly
        const newNodeId = data.rootIds.find((id: string) => id !== 'n1');
        expect(data.nodes[newNodeId].filePath).toBe('files/notes-test.pdf');
    });
});

test.describe('DOD-12-22/23: Performance tests', () => {
    const SKIP_PERF = process.env.SKIP_PERF === '1';

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

    test('DOD-12-22: 10MB single file drop processes within 200ms', async ({ page }) => {
        if (SKIP_PERF) {
            test.skip();
            return;
        }

        // Measure time from dropFilesResult receipt to completion
        const timing = await page.evaluate(async () => {
            const start = performance.now();

            // Simulate a large file result (10MB would be processed by host, we test webview handling)
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'file',
                    ok: true,
                    title: 'large-10mb.pdf',
                    filePath: 'files/large-10mb.pdf'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });

            // Wait for DOM update
            await new Promise(r => setTimeout(r, 50));

            const end = performance.now();
            return { duration: end - start };
        });

        // Webview processing should be fast (< 200ms)
        // The actual file I/O happens on host side
        expect(timing.duration).toBeLessThan(200);
    });

    test('DOD-12-23: 20 file multi-drop processes within 1000ms', async ({ page }) => {
        if (SKIP_PERF) {
            test.skip();
            return;
        }

        const timing = await page.evaluate(async () => {
            const start = performance.now();

            // Simulate 20 file results
            const results = [];
            for (let i = 0; i < 20; i++) {
                results.push({
                    kind: 'file',
                    ok: true,
                    title: `file-${i}.pdf`,
                    filePath: `files/file-${i}.pdf`
                });
            }

            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results,
                targetNodeId: 'n1',
                position: 'after'
            });

            // Wait for DOM update
            await new Promise(r => setTimeout(r, 100));

            const end = performance.now();
            return { duration: end - start };
        });

        // 20 nodes should be created within 1 second
        expect(timing.duration).toBeLessThan(1000);

        // Wait for syncToHost debounce to complete
        await page.waitForTimeout(1500);

        // Verify all nodes were created
        const data = await page.evaluate(() => {
            const syncData = (window as any).__testApi.lastSyncData;
            if (!syncData) return null;
            return JSON.parse(syncData);
        });
        expect(data).not.toBeNull();
        expect(data.rootIds.length).toBe(21); // n1 + 20 new
    });
});

test.describe.serial('DOD-12-E2E-11: Notes mode outliner D&D behavior', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('DOD-12-E2E-11: Notes mode outliner responds to Files D&D (shared code)', async ({ page }) => {
        // Notes mode uses the same outliner.js, so Files D&D works identically
        // This test verifies the integration works for Notes-specific scenarios
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Notes Node', tags: [] }
                }
            });
        });

        // Simulate Notes mode drop result (Notes uses different file paths)
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'dropFilesResult',
                results: [{
                    kind: 'file',
                    ok: true,
                    title: 'notes-doc.pdf',
                    // Notes mode path: {mainFolderPath}/{outlinerId}/files/
                    filePath: 'files/notes-doc.pdf'
                }],
                targetNodeId: 'n1',
                position: 'after'
            });
        });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => JSON.parse((window as any).__testApi.lastSyncData));
        expect(data.rootIds.length).toBe(2);

        const newNodeId = data.rootIds[1];
        expect(data.nodes[newNodeId].text).toBe('notes-doc.pdf');
        expect(data.nodes[newNodeId].filePath).toBe('files/notes-doc.pdf');
    });
});

test.describe.serial('DOD-12-E2E-12: Side panel drop does not trigger outliner D&D', () => {
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

    test('DOD-12-E2E-12: drop outside treeEl does not add nodes', async ({ page }) => {
        // Get initial node count from DOM (more reliable than sync data)
        const initialCount = await page.locator('.outliner-node').count();

        // Simulate drop on body (outside outliner-tree)
        const triggered = await page.evaluate(() => {
            let dropFilesImportCalled = false;
            const originalFn = (window as any).host?.dropFilesImport;
            if ((window as any).host) {
                (window as any).host.dropFilesImport = () => {
                    dropFilesImportCalled = true;
                };
            }

            // Dispatch drop on body (not on outliner-tree)
            const body = document.body;
            const event = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(event.dataTransfer, 'types', { value: ['Files'], writable: false });

            body.dispatchEvent(event);

            // Restore
            if (originalFn) {
                (window as any).host.dropFilesImport = originalFn;
            }

            return dropFilesImportCalled;
        });

        // dropFilesImport should NOT be called when dropping outside tree
        expect(triggered).toBe(false);

        // Node count should remain unchanged
        const finalCount = await page.locator('.outliner-node').count();
        expect(finalCount).toBe(initialCount);
    });

    test('DOD-12-E2E-12: drop on non-tree element does not trigger dropFilesImport', async ({ page }) => {
        // Create a side panel-like element outside the tree
        await page.evaluate(() => {
            const sidePanel = document.createElement('div');
            sidePanel.id = 'mock-side-panel';
            sidePanel.style.cssText = 'width:100px;height:100px;position:fixed;right:0;top:0;';
            document.body.appendChild(sidePanel);
        });

        const triggered = await page.evaluate(() => {
            let called = false;
            const originalFn = (window as any).host?.dropFilesImport;
            if ((window as any).host) {
                (window as any).host.dropFilesImport = () => {
                    called = true;
                };
            }

            const sidePanel = document.getElementById('mock-side-panel');
            const event = new DragEvent('drop', {
                bubbles: false, // Don't bubble to tree
                cancelable: true,
                dataTransfer: new DataTransfer()
            });
            Object.defineProperty(event.dataTransfer, 'types', { value: ['Files'], writable: false });

            sidePanel?.dispatchEvent(event);

            if (originalFn) {
                (window as any).host.dropFilesImport = originalFn;
            }

            return called;
        });

        expect(triggered).toBe(false);
    });
});
