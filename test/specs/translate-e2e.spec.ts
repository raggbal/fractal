/**
 * v10: Translation E2E Tests
 * Tests toolbar buttons, message flow, language selection, and translation panel
 */

import { test, expect } from '@playwright/test';
import { EditorTestHelper } from '../utils/editor-test-helper';

// test_remove (sprint 20260727-102631): DOD-T1/T4/T5 は translateLang ボタン依存。
// translateLang は sprint 20260724-160000 で撤廃済み（dead button 削除）のため期待値残骸を削除。
// 残る DOD-T2/T3/T9〜T12/T14 の red は standalone toolbar が空 stub という別の harness gap
// （designer_failures 2026-07-25 記録）— toolbar 実 DOM 化の別 sprint で解消する。
test.describe('Translation Toolbar Buttons', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        editor = new EditorTestHelper(page);
    });


    // DOD-T2: Translate button sends translateContent message with markdown text
    test('DOD-T2: Translate button sends translateContent message', async ({ page }) => {
        await editor.type('Hello World');

        let messageSent = false;
        let messageData: any = null;

        page.on('console', msg => {
            if (msg.text().includes('translateContent')) {
                messageSent = true;
            }
        });

        // Mock host message handler
        await page.evaluate(() => {
            const originalPostMessage = (window as any).hostBridge.translateContent;
            (window as any).__translateMessage = null;
            (window as any).hostBridge.translateContent = function(markdown: string, sourceLang: string, targetLang: string) {
                (window as any).__translateMessage = { markdown, sourceLang, targetLang };
            };
        });

        await page.click('button[data-action="translate"]');

        const message = await page.evaluate(() => (window as any).__translateMessage);
        expect(message).not.toBeNull();
        expect(message.markdown).toContain('Hello World');
        expect(message.sourceLang).toBe('ja');
        expect(message.targetLang).toBe('en');
    });

    // DOD-T3: Selection-based translation: selected text only is sent when selection exists
    test('DOD-T3: Selection-only translation', async ({ page }) => {
        await editor.setMarkdown('First paragraph\n\nSecond paragraph');

        // Select only "First paragraph"
        await page.evaluate(() => {
            const editorEl = document.querySelector('.editor') as HTMLElement;
            const p = editorEl.querySelector('p');
            if (p) {
                const range = document.createRange();
                range.selectNodeContents(p);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }
        });

        await page.evaluate(() => {
            (window as any).__translateMessage = null;
            (window as any).hostBridge.translateContent = function(markdown: string, sourceLang: string, targetLang: string) {
                (window as any).__translateMessage = { markdown, sourceLang, targetLang };
            };
        });

        await page.click('button[data-action="translate"]');

        const message = await page.evaluate(() => (window as any).__translateMessage);
        expect(message).not.toBeNull();
        expect(message.markdown).toContain('First paragraph');
        expect(message.markdown).not.toContain('Second paragraph');
    });



    // DOD-T14: Existing toolbar buttons still work after translate buttons added
    test('DOD-T14: Existing toolbar buttons regression check', async ({ page }) => {
        await editor.type('Test text');

        // Select text
        await page.evaluate(() => {
            const editorEl = document.querySelector('.editor') as HTMLElement;
            const p = editorEl.querySelector('p');
            if (p) {
                const range = document.createRange();
                range.selectNodeContents(p);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }
        });

        // Test bold button
        await page.click('button[data-action="bold"]');
        const html = await editor.getHtml();
        expect(html).toContain('<strong>');

        // Test italic button
        await page.click('button[data-action="italic"]');
        const html2 = await editor.getHtml();
        expect(html2).toContain('<em>');
    });
});

test.describe('Translation Panel', () => {
    let editor: EditorTestHelper;

    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        editor = new EditorTestHelper(page);
    });

    // DOD-T9: translateResult opens translation panel with readonly rendered markdown
    test('DOD-T9: translateResult opens readonly translation panel', async ({ page }) => {
        await editor.setMarkdown('Original text');

        // Simulate translateResult message
        await page.evaluate(() => {
            const event = new MessageEvent('message', {
                data: {
                    type: 'translateResult',
                    translatedMarkdown: 'Translated text',
                    sourceLang: 'ja',
                    targetLang: 'en'
                }
            });
            window.dispatchEvent(event);
        });

        // Wait for side panel to open
        await page.waitForSelector('.side-panel.open', { timeout: 5000 });

        // Check panel is visible
        const sidePanel = page.locator('.side-panel');
        await expect(sidePanel).toHaveClass(/open/);

        // Check filename shows translation label
        const filename = page.locator('.side-panel-filename');
        await expect(filename).toContainText('Translation Result');
        await expect(filename).toContainText('ja → en');

        // Check editor is readonly
        const spEditor = page.locator('.side-panel-editor-root .editor');
        const contentEditable = await spEditor.getAttribute('contenteditable');
        expect(contentEditable).toBe('false');
    });

    // DOD-T10: Translation panel has copy button that copies text to clipboard
    test('DOD-T10: Copy button copies text to clipboard', async ({ page }) => {
        // Simulate translateResult message
        await page.evaluate(() => {
            const event = new MessageEvent('message', {
                data: {
                    type: 'translateResult',
                    translatedMarkdown: 'Copied text',
                    sourceLang: 'ja',
                    targetLang: 'en'
                }
            });
            window.dispatchEvent(event);
        });

        await page.waitForSelector('.side-panel.open', { timeout: 5000 });

        // Grant clipboard permissions
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

        // Click copy button
        const copyBtn = page.locator('.side-panel-copy-path');
        await copyBtn.click();

        // Check clipboard content
        const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
        expect(clipboardText).toContain('Copied text');
    });

    // DOD-T11: Translation panel close button returns to original editor
    test('DOD-T11: Close button hides translation panel', async ({ page }) => {
        // Simulate translateResult message
        await page.evaluate(() => {
            const event = new MessageEvent('message', {
                data: {
                    type: 'translateResult',
                    translatedMarkdown: 'Translated text',
                    sourceLang: 'ja',
                    targetLang: 'en'
                }
            });
            window.dispatchEvent(event);
        });

        await page.waitForSelector('.side-panel.open', { timeout: 5000 });

        // Click close button
        const closeBtn = page.locator('.side-panel-close');
        await closeBtn.click();

        // Wait for panel to close
        await page.waitForTimeout(500);

        // Check panel is hidden
        const sidePanel = page.locator('.side-panel');
        await expect(sidePanel).not.toHaveClass(/open/);
    });
});

test.describe('Side Panel Translation Buttons', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // DOD-T12: Side panel header has translate and translateLang buttons
    test('DOD-T12: Side panel header has translate buttons', async ({ page }) => {
        // Open a page in side panel
        await page.evaluate(async () => {
            const api = (window as any).__testApi;
            if (api && api.openSidePanel) {
                api.openSidePanel('Test content', '/test.md', 'test.md', [], '');
            }
        });

        await page.waitForSelector('.side-panel.open', { timeout: 5000 });

        // Check translate buttons exist in header
        const translateBtn = page.locator('.side-panel-header button[data-action="translate"]');
        const translateLangBtn = page.locator('.side-panel-header button[data-action="translateLang"]');

        await expect(translateBtn).toBeVisible();
        await expect(translateLangBtn).toBeVisible();
    });
});
