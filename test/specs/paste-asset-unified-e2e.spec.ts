/**
 * E2E tests for v9.1 unified paste-asset-handler message integration
 * Tests handlePageAssetsCross and handleFileAssetCross messages
 */

import { test, expect } from '@playwright/test';

/**
 * Tests verify that outliner.js sends the correct unified messages
 * (handlePageAssetsCross, handleFileAssetCross) with the isCut flag
 * instead of the old separate copy/move messages.
 */

test.describe('Unified paste asset messages (v9.1)', () => {

    test.describe('Standalone outliner', () => {
        test.beforeEach(async ({ page }) => {
            await page.goto('/standalone-outliner.html');
            await page.waitForFunction(() => (window as any).__testApi?.ready);
        });

        test('copy page node sends handlePageAssetsCross with isCut=false (DOD-R9)', async ({ page }) => {
            // Arrange: Create a page node with images
            await page.evaluate(() => {
                (window as any).__testApi.initOutliner({
                    version: 1,
                    rootIds: ['n1'],
                    nodes: {
                        n1: {
                            id: 'n1',
                            parentId: null,
                            children: [],
                            text: 'Page node for copy',
                            tags: [],
                            isPage: true,
                            pageId: 'page-copy-123',
                            images: ['pages/images/img1.png']
                        }
                    },
                    pageDir: './sourceDir/'
                }, '/test/sourceFile.out');
            });

            // Act: Select and copy the page node
            const textEl = page.locator('.outliner-text').first();
            await textEl.click();
            await page.waitForTimeout(100);
            await page.keyboard.press('Meta+c');
            await page.waitForTimeout(200);

            // Simulate file switch to trigger cross-file paste detection
            await page.evaluate(() => {
                (window as any).__hostMessageHandler({
                    type: 'updateData',
                    outFileKey: '/test/destFile.out',
                    data: {
                        version: 1,
                        rootIds: ['nTarget'],
                        nodes: {
                            nTarget: { id: 'nTarget', parentId: null, children: [], text: 'Target', tags: [] }
                        },
                        pageDir: './destDir/'
                    },
                    fileChangeId: 1
                });
            });
            await page.waitForTimeout(200);

            // Clear messages to track only paste-triggered messages
            await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

            // Paste on target node
            const targetText = page.locator('.outliner-text').first();
            await targetText.click();
            await page.waitForTimeout(100);

            await page.evaluate(() => {
                const targetEl = document.querySelector('.outliner-text') as HTMLElement;
                if (targetEl) {
                    targetEl.focus();
                    const pasteEvent = new ClipboardEvent('paste', {
                        clipboardData: new DataTransfer(),
                        bubbles: true,
                        cancelable: true
                    });
                    pasteEvent.clipboardData!.setData('text/plain', 'Page node for copy');
                    targetEl.dispatchEvent(pasteEvent);
                }
            });
            await page.waitForTimeout(500);

            // Assert: handlePageAssetsCross message sent with isCut=false
            const messages = await page.evaluate(() => (window as any).__testApi.messages);
            const handlePageMsg = messages.find((m: any) => m.type === 'handlePageAssetsCross');
            expect(handlePageMsg).toBeTruthy();
            expect(handlePageMsg.pageId).toBe('page-copy-123');
            expect(handlePageMsg.isCut).toBe(false);
            expect(handlePageMsg.nodeImages).toEqual(['pages/images/img1.png']);
        });

        test('cut page node cross-file sends handlePageAssetsCross with isCut=true (DOD-R9)', async ({ page }) => {
            // Arrange: Create a page node with images
            await page.evaluate(() => {
                (window as any).__testApi.initOutliner({
                    version: 1,
                    rootIds: ['n1'],
                    nodes: {
                        n1: {
                            id: 'n1',
                            parentId: null,
                            children: [],
                            text: 'Page node for cut',
                            tags: [],
                            isPage: true,
                            pageId: 'page-cut-456',
                            images: ['pages/images/img2.png']
                        }
                    },
                    pageDir: './sourceDir/'
                }, '/test/sourceFile.out');
            });

            // Act: Select and cut the page node
            const textEl = page.locator('.outliner-text').first();
            await textEl.click();
            await page.waitForTimeout(100);
            await page.keyboard.press('Meta+x');
            await page.waitForTimeout(200);

            // Simulate file switch
            await page.evaluate(() => {
                (window as any).__hostMessageHandler({
                    type: 'updateData',
                    outFileKey: '/test/destFile.out',
                    data: {
                        version: 1,
                        rootIds: ['nTarget'],
                        nodes: {
                            nTarget: { id: 'nTarget', parentId: null, children: [], text: 'Target', tags: [] }
                        },
                        pageDir: './destDir/'
                    },
                    fileChangeId: 1
                });
            });
            await page.waitForTimeout(200);

            // Clear messages
            await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

            // Paste on target node
            const targetText = page.locator('.outliner-text').first();
            await targetText.click();
            await page.waitForTimeout(100);

            await page.evaluate(() => {
                const targetEl = document.querySelector('.outliner-text') as HTMLElement;
                if (targetEl) {
                    targetEl.focus();
                    const pasteEvent = new ClipboardEvent('paste', {
                        clipboardData: new DataTransfer(),
                        bubbles: true,
                        cancelable: true
                    });
                    pasteEvent.clipboardData!.setData('text/plain', 'Page node for cut');
                    targetEl.dispatchEvent(pasteEvent);
                }
            });
            await page.waitForTimeout(500);

            // Assert: handlePageAssetsCross message sent with isCut=true
            const messages = await page.evaluate(() => (window as any).__testApi.messages);
            const handlePageMsg = messages.find((m: any) => m.type === 'handlePageAssetsCross');
            expect(handlePageMsg).toBeTruthy();
            expect(handlePageMsg.pageId).toBe('page-cut-456');
            expect(handlePageMsg.isCut).toBe(true);
            expect(handlePageMsg.nodeImages).toEqual(['pages/images/img2.png']);
        });

        test('copy file node sends handleFileAssetCross with isCut=false (DOD-R10)', async ({ page }) => {
            // Arrange: Create a file node
            await page.evaluate(() => {
                (window as any).__testApi.initOutliner({
                    version: 1,
                    rootIds: ['n1'],
                    nodes: {
                        n1: {
                            id: 'n1',
                            parentId: null,
                            children: [],
                            text: 'File node for copy',
                            tags: [],
                            filePath: 'files/document.pdf'
                        }
                    },
                    pageDir: './sourceDir/'
                }, '/test/sourceFile.out');
            });

            // Act: Select and copy the file node
            const textEl = page.locator('.outliner-text').first();
            await textEl.click();
            await page.waitForTimeout(100);
            await page.keyboard.press('Meta+c');
            await page.waitForTimeout(200);

            // Simulate file switch
            await page.evaluate(() => {
                (window as any).__hostMessageHandler({
                    type: 'updateData',
                    outFileKey: '/test/destFile.out',
                    data: {
                        version: 1,
                        rootIds: ['nTarget'],
                        nodes: {
                            nTarget: { id: 'nTarget', parentId: null, children: [], text: 'Target', tags: [] }
                        },
                        pageDir: './destDir/'
                    },
                    fileChangeId: 1
                });
            });
            await page.waitForTimeout(200);

            // Clear messages
            await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

            // Paste on target node
            const targetText = page.locator('.outliner-text').first();
            await targetText.click();
            await page.waitForTimeout(100);

            await page.evaluate(() => {
                const targetEl = document.querySelector('.outliner-text') as HTMLElement;
                if (targetEl) {
                    targetEl.focus();
                    const pasteEvent = new ClipboardEvent('paste', {
                        clipboardData: new DataTransfer(),
                        bubbles: true,
                        cancelable: true
                    });
                    pasteEvent.clipboardData!.setData('text/plain', 'File node for copy');
                    targetEl.dispatchEvent(pasteEvent);
                }
            });
            await page.waitForTimeout(500);

            // Assert: handleFileAssetCross message sent with isCut=false
            const messages = await page.evaluate(() => (window as any).__testApi.messages);
            const handleFileMsg = messages.find((m: any) => m.type === 'handleFileAssetCross');
            expect(handleFileMsg).toBeTruthy();
            expect(handleFileMsg.filePath).toBe('files/document.pdf');
            expect(handleFileMsg.isCut).toBe(false);
        });

        test('cut file node cross-file sends handleFileAssetCross with isCut=true (DOD-R10)', async ({ page }) => {
            // Arrange: Create a file node
            await page.evaluate(() => {
                (window as any).__testApi.initOutliner({
                    version: 1,
                    rootIds: ['n1'],
                    nodes: {
                        n1: {
                            id: 'n1',
                            parentId: null,
                            children: [],
                            text: 'File node for cut',
                            tags: [],
                            filePath: 'files/report.xlsx'
                        }
                    },
                    pageDir: './sourceDir/'
                }, '/test/sourceFile.out');
            });

            // Act: Select and cut the file node
            const textEl = page.locator('.outliner-text').first();
            await textEl.click();
            await page.waitForTimeout(100);
            await page.keyboard.press('Meta+x');
            await page.waitForTimeout(200);

            // Simulate file switch
            await page.evaluate(() => {
                (window as any).__hostMessageHandler({
                    type: 'updateData',
                    outFileKey: '/test/destFile.out',
                    data: {
                        version: 1,
                        rootIds: ['nTarget'],
                        nodes: {
                            nTarget: { id: 'nTarget', parentId: null, children: [], text: 'Target', tags: [] }
                        },
                        pageDir: './destDir/'
                    },
                    fileChangeId: 1
                });
            });
            await page.waitForTimeout(200);

            // Clear messages
            await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });

            // Paste on target node
            const targetText = page.locator('.outliner-text').first();
            await targetText.click();
            await page.waitForTimeout(100);

            await page.evaluate(() => {
                const targetEl = document.querySelector('.outliner-text') as HTMLElement;
                if (targetEl) {
                    targetEl.focus();
                    const pasteEvent = new ClipboardEvent('paste', {
                        clipboardData: new DataTransfer(),
                        bubbles: true,
                        cancelable: true
                    });
                    pasteEvent.clipboardData!.setData('text/plain', 'File node for cut');
                    targetEl.dispatchEvent(pasteEvent);
                }
            });
            await page.waitForTimeout(500);

            // Assert: handleFileAssetCross message sent with isCut=true
            const messages = await page.evaluate(() => (window as any).__testApi.messages);
            const handleFileMsg = messages.find((m: any) => m.type === 'handleFileAssetCross');
            expect(handleFileMsg).toBeTruthy();
            expect(handleFileMsg.filePath).toBe('files/report.xlsx');
            expect(handleFileMsg.isCut).toBe(true);
        });
    });
});
