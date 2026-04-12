/**
 * Outliner File Attachment E2E Tests
 * Tests file node features: import, icon, editing, context menu, mutual exclusion
 */

import { test, expect } from '@playwright/test';

test.describe('Outliner File Node Features', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // Helper: clear messages
    async function clearMessages(page: any) {
        await page.evaluate(() => {
            (window as any).__testApi.messages = [];
        });
    }

    // Helper: get messages of specific type
    async function getMessages(page: any, type: string) {
        return page.evaluate((t: string) => {
            return (window as any).__testApi.messages.filter((m: any) => m.type === t);
        }, type);
    }

    // =========================================================
    // DOD-1: Import menu item
    // =========================================================

    test('DOD-1: importFilesDialog handler exists and sends message', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Test node', tags: [] }
                }
            });
        });

        await clearMessages(page);

        // Directly call the bridge method
        await page.evaluate(() => {
            (window as any).outlinerHostBridge.importFilesDialog('n1');
        });

        await page.waitForTimeout(100);

        // Verify message was sent
        const msgs = await getMessages(page, 'importFilesDialog');
        expect(msgs.length).toBe(1);
        expect(msgs[0].targetNodeId).toBe('n1');
    });

    // =========================================================
    // DOD-3: importFilesResult creates file nodes
    // =========================================================

    test('DOD-3: importFilesResult creates file nodes with filePath', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Target', tags: [] }
                }
            });
        });

        // Clear previous sync data
        await page.evaluate(() => {
            (window as any).__testApi.lastSyncData = null;
        });

        // Send importFilesResult message via message handler
        await page.evaluate(() => {
            if ((window as any).__hostMessageHandler) {
                (window as any).__hostMessageHandler({
                    type: 'importFilesResult',
                    targetNodeId: 'n1',
                    position: 'after',
                    results: [
                        { title: 'report.pdf', filePath: 'files/report.pdf' },
                        { title: 'data.xlsx', filePath: 'files/data.xlsx' }
                    ]
                });
            }
        });

        await page.waitForTimeout(1200);

        // Verify 2 new nodes were created
        const allNodes = page.locator('.outliner-node');
        expect(await allNodes.count()).toBe(3); // n1 + 2 new

        // Verify data contains filePath
        const syncData = await page.evaluate(() => (window as any).__testApi.lastSyncData);
        expect(syncData).toBeTruthy();
        const data = JSON.parse(syncData as string);

        // Find nodes with filePath
        const fileNodes = Object.values(data.nodes).filter((n: any) => n.filePath);
        expect(fileNodes.length).toBe(2);
        expect(fileNodes.some((n: any) => n.filePath === 'files/report.pdf')).toBe(true);
        expect(fileNodes.some((n: any) => n.filePath === 'files/data.xlsx')).toBe(true);
    });

    // =========================================================
    // DOD-4: File node shows 📎 icon
    // =========================================================

    test('DOD-4: File node displays 📎 icon', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'report.pdf',
                        tags: [],
                        filePath: 'files/report.pdf'
                    }
                }
            });
        });

        // Verify file icon exists
        const fileIcon = page.locator('.outliner-file-icon');
        expect(await fileIcon.count()).toBe(1);

        // Verify icon content is 📎
        const iconText = await fileIcon.textContent();
        expect(iconText).toContain('\uD83D\uDCCE'); // 📎
    });

    test('DOD-4: Non-file node does not show 📎 icon', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'Normal node', tags: [] }
                }
            });
        });

        // Verify no file icon
        const fileIcon = page.locator('.outliner-file-icon');
        expect(await fileIcon.count()).toBe(0);
    });

    // =========================================================
    // DOD-5: File node text editable and can have children
    // =========================================================

    test('DOD-5: File node text is editable', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'original.pdf',
                        tags: [],
                        filePath: 'files/original.pdf'
                    }
                }
            });
        });

        // Click text to edit
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(200);

        // Select all and replace
        await page.keyboard.press('Meta+a');
        await page.keyboard.type('edited.pdf');
        await page.waitForTimeout(300);

        // Trigger sync by blur
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1200);

        // Verify text changed in data
        const syncData = await page.evaluate(() => (window as any).__testApi.lastSyncData);
        expect(syncData).toBeTruthy();
        const data = JSON.parse(syncData as string);
        expect(data.nodes.n1.text).toContain('edited');
    });

    test('DOD-5: File node can have children', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'parent.pdf',
                        tags: [],
                        filePath: 'files/parent.pdf',
                        collapsed: false
                    }
                }
            });
        });

        // Wait for render
        await page.waitForTimeout(300);

        // Focus node text
        const textEl = page.locator('.outliner-node[data-id="n1"] .outliner-text');
        await textEl.click();
        await page.waitForTimeout(300);

        // Move cursor to end and create new sibling then indent
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        await page.keyboard.type('child note');
        await page.keyboard.press('Tab');
        await page.waitForTimeout(600);

        // Verify child exists in DOM
        const childNodes = page.locator('.outliner-children[data-parent="n1"] .outliner-node');
        expect(await childNodes.count()).toBeGreaterThanOrEqual(1);
    });

    // =========================================================
    // DOD-6: 📎 icon click sends openAttachedFile message
    // =========================================================

    test('DOD-6: Clicking 📎 icon sends openAttachedFile message', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'document.pdf',
                        tags: [],
                        filePath: 'files/document.pdf'
                    }
                }
            });
        });

        await clearMessages(page);

        // Click file icon
        const fileIcon = page.locator('.outliner-file-icon');
        await fileIcon.click();
        await page.waitForTimeout(300);

        // Verify openAttachedFile message sent
        const msgs = await getMessages(page, 'openAttachedFile');
        expect(msgs.length).toBe(1);
        expect(msgs[0].nodeId).toBe('n1');
    });

    // =========================================================
    // DOD-7: Context menu Open/Remove File
    // =========================================================

    test('DOD-7: File node context menu shows "Open File" and "Remove File"', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'test.pdf',
                        tags: [],
                        filePath: 'files/test.pdf'
                    }
                }
            });
        });

        // Right-click file node
        const nodeEl = page.locator('.outliner-node[data-id="n1"]');
        await nodeEl.click({ button: 'right' });
        await page.waitForTimeout(200);

        // Verify 'Open File' menu item exists
        const openFileItem = page.locator('.outliner-context-menu-item', { hasText: 'Open File' });
        expect(await openFileItem.count()).toBe(1);

        // Verify 'Remove File' menu item exists
        const removeFileItem = page.locator('.outliner-context-menu-item', { hasText: 'Remove File' });
        expect(await removeFileItem.count()).toBe(1);
    });

    test('DOD-7: "Open File" context menu sends openAttachedFile message', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'doc.pdf',
                        tags: [],
                        filePath: 'files/doc.pdf'
                    }
                }
            });
        });

        await clearMessages(page);

        // Right-click and select 'Open File'
        const nodeEl = page.locator('.outliner-node[data-id="n1"]');
        await nodeEl.click({ button: 'right' });
        await page.waitForTimeout(200);

        const openFileItem = page.locator('.outliner-context-menu-item', { hasText: 'Open File' });
        await openFileItem.click();
        await page.waitForTimeout(300);

        // Verify message sent
        const msgs = await getMessages(page, 'openAttachedFile');
        expect(msgs.length).toBe(1);
        expect(msgs[0].nodeId).toBe('n1');
    });

    // =========================================================
    // DOD-8: Remove File clears filePath
    // =========================================================

    test('DOD-8: "Remove File" clears filePath without physical deletion', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'removable.pdf',
                        tags: [],
                        filePath: 'files/removable.pdf'
                    }
                }
            });
        });

        // Verify file icon exists before removal
        expect(await page.locator('.outliner-file-icon').count()).toBe(1);

        // Right-click and select 'Remove File'
        const nodeEl = page.locator('.outliner-node[data-id="n1"]');
        await nodeEl.click({ button: 'right' });
        await page.waitForTimeout(200);

        const removeFileItem = page.locator('.outliner-context-menu-item', { hasText: 'Remove File' });
        await removeFileItem.click();
        await page.waitForTimeout(1200);

        // Verify icon is gone
        expect(await page.locator('.outliner-file-icon').count()).toBe(0);

        // Verify filePath is null in data
        const syncData = await page.evaluate(() => (window as any).__testApi.lastSyncData);
        expect(syncData).toBeTruthy();
        const data = JSON.parse(syncData as string);
        expect(data.nodes.n1.filePath).toBeNull();

        // Verify node text still exists
        expect(data.nodes.n1.text).toBe('removable.pdf');
    });

    // =========================================================
    // DOD-9: Mutual exclusion isPage and filePath
    // =========================================================

    test('DOD-9: Making file node into page clears filePath', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'file-to-page.pdf',
                        tags: [],
                        filePath: 'files/file-to-page.pdf'
                    }
                }
            });
        });

        // Verify file icon exists
        expect(await page.locator('.outliner-file-icon').count()).toBe(1);

        // Right-click and Make Page
        const nodeEl = page.locator('.outliner-node[data-id="n1"]');
        await nodeEl.click({ button: 'right' });
        await page.waitForTimeout(200);

        const makePageItem = page.locator('.outliner-context-menu-item', { hasText: 'Make Page' });
        await makePageItem.click();
        await page.waitForTimeout(1200);

        // Verify file icon is gone
        expect(await page.locator('.outliner-file-icon').count()).toBe(0);

        // Verify page icon appears
        expect(await page.locator('.outliner-page-icon').count()).toBe(1);

        // Verify data: isPage=true, filePath=null
        const syncData = await page.evaluate(() => (window as any).__testApi.lastSyncData);
        expect(syncData).toBeTruthy();
        const data = JSON.parse(syncData as string);
        expect(data.nodes.n1.isPage).toBe(true);
        expect(data.nodes.n1.filePath).toBeNull();
    });

    test('DOD-9: File import creates non-page nodes', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'My Page',
                        tags: [],
                        isPage: true,
                        pageId: 'uuid-page-1'
                    }
                }
            });
        });

        // Verify page icon exists
        expect(await page.locator('.outliner-page-icon').count()).toBe(1);

        // Clear sync data
        await page.evaluate(() => {
            (window as any).__testApi.lastSyncData = null;
        });

        // Import file after page node
        await page.evaluate(() => {
            if ((window as any).__hostMessageHandler) {
                (window as any).__hostMessageHandler({
                    type: 'importFilesResult',
                    targetNodeId: 'n1',
                    position: 'after',
                    results: [
                        { title: 'attachment.pdf', filePath: 'files/attachment.pdf' }
                    ]
                });
            }
        });

        await page.waitForTimeout(1200);

        // Verify sync happened
        const syncData = await page.evaluate(() => (window as any).__testApi.lastSyncData);
        expect(syncData).toBeTruthy();
        const data = JSON.parse(syncData as string);

        // Find file node - should have isPage=false
        const fileNode = Object.values(data.nodes).find((n: any) => n.filePath === 'files/attachment.pdf');
        expect(fileNode).toBeTruthy();
        expect((fileNode as any).isPage).toBeFalsy();
        expect((fileNode as any).pageId).toBeNull();
    });

    // =========================================================
    // DOD-22: Copy/Paste file node
    // =========================================================

    test('DOD-22: Copy file node → clipboard includes filePath', async ({ page }) => {
        // Setup: create outliner with file node
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'File node',
                        tags: [],
                        filePath: 'files/document.pdf'
                    }
                }
            });
        });

        await clearMessages(page);

        // Focus the file node
        await page.click('.outliner-node[data-id="n1"]');

        // Simulate Cmd+C (copy) via keyboard
        await page.keyboard.down('Meta'); // Cmd on Mac
        await page.keyboard.press('c');
        await page.keyboard.up('Meta');

        await page.waitForTimeout(200);

        // Verify saveOutlinerClipboard was called
        let clipboardMsgs = await getMessages(page, 'saveOutlinerClipboard');
        expect(clipboardMsgs.length).toBeGreaterThan(0);

        // Verify clipboard contains filePath
        const clipboardData = clipboardMsgs[clipboardMsgs.length - 1];
        expect(clipboardData.nodes).toBeTruthy();
        expect(clipboardData.nodes[0].filePath).toBe('files/document.pdf');
        expect(clipboardData.isCut).toBe(false); // copy, not cut
    });


    test('DOD-22: Cut file node → clipboard includes filePath with isCut=true', async ({ page }) => {
        // Setup: create outliner with file node
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: {
                    n1: {
                        id: 'n1',
                        parentId: null,
                        children: [],
                        text: 'Cut me',
                        tags: [],
                        filePath: 'files/original.xlsx'
                    }
                }
            });
        });

        await clearMessages(page);

        // Focus and select the node
        await page.click('.outliner-node[data-id="n1"]');

        // Simulate Cmd+X (cut)
        await page.keyboard.down('Meta');
        await page.keyboard.press('x');
        await page.keyboard.up('Meta');

        await page.waitForTimeout(200);

        // Verify saveOutlinerClipboard was called with isCut=true
        const clipboardMsgs = await getMessages(page, 'saveOutlinerClipboard');
        expect(clipboardMsgs.length).toBeGreaterThan(0);
        const clipData = clipboardMsgs[clipboardMsgs.length - 1];
        expect(clipData.isCut).toBe(true);
        expect(clipData.nodes[0].filePath).toBe('files/original.xlsx');
    });
});
