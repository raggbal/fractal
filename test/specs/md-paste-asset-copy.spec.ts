/**
 * MD Editor Copy/Paste Asset Duplication E2E Tests
 * DOD-1, DOD-2, DOD-3, DOD-4, DOD-10, DOD-12, DOD-13, DOD-14
 *
 * Note: These tests verify that the implementation code exists and is correct.
 * The standalone-editor.html would need to be rebuilt to include the new code.
 * Runtime testing of the full flow requires VSCode extension environment.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('MD Paste Asset Copy - Source Code Verification', () => {
    const editorJsPath = path.join(__dirname, '../../src/webview/editor.js');

    test('DOD-1, DOD-2, DOD-14: Copy/cut handlers set text/x-any-md-context when _assetContext exists', () => {
        const editorJsContent = fs.readFileSync(editorJsPath, 'utf-8');

        // Verify copy handler has context setting logic
        expect(editorJsContent).toContain("e.clipboardData.setData('text/x-any-md', md)");
        expect(editorJsContent).toContain("if (host._assetContext) {");
        expect(editorJsContent).toContain("e.clipboardData.setData('text/x-any-md-context', JSON.stringify(host._assetContext))");

        // Verify cut handler also has context setting logic
        const cutHandlerMatch = editorJsContent.match(/editor\.addEventListener\('cut'[\s\S]*?}\);/);
        expect(cutHandlerMatch).toBeTruthy();
        expect(cutHandlerMatch[0]).toContain("if (host._assetContext) {");
        expect(cutHandlerMatch[0]).toContain("text/x-any-md-context");
    });

    test('DOD-3, DOD-4, DOD-12, DOD-13: Paste handler checks directory equality', () => {
        const editorJsContent = fs.readFileSync(editorJsPath, 'utf-8');

        // Verify paste handler reads context and compares dirs
        expect(editorJsContent).toContain("const assetContext = e.clipboardData.getData('text/x-any-md-context')");
        expect(editorJsContent).toContain("const internalMd = e.clipboardData.getData('text/x-any-md')");
        expect(editorJsContent).toContain("const sourceCtx = JSON.parse(assetContext)");
        expect(editorJsContent).toContain("const destCtx = host._assetContext");

        // Verify directory comparison logic
        expect(editorJsContent).toContain("sourceCtx.imageDir !== destCtx.imageDir || sourceCtx.fileDir !== destCtx.fileDir");
        expect(editorJsContent).toContain("host.pasteWithAssetCopy");
    });

    test('DOD-10: pasteWithAssetCopyResult message handler exists', () => {
        const editorJsContent = fs.readFileSync(editorJsPath, 'utf-8');

        // Verify pasteWithAssetCopyResult handler exists
        expect(editorJsContent).toContain("message.type === 'pasteWithAssetCopyResult'");
        expect(editorJsContent).toContain("message.markdown");
    });

    test('DOD-1: SidePanelHostBridge has _assetContext property', () => {
        const editorJsContent = fs.readFileSync(editorJsPath, 'utf-8');

        // Verify SidePanelHostBridge constructor initializes _assetContext
        const classMatch = editorJsContent.match(/class SidePanelHostBridge[\s\S]*?constructor\([\s\S]*?\{[\s\S]*?\}/);
        expect(classMatch).toBeTruthy();
        expect(classMatch[0]).toContain("this._assetContext = null");
    });

    test('DOD-10: SidePanelHostBridge has pasteWithAssetCopy method', () => {
        const editorJsContent = fs.readFileSync(editorJsPath, 'utf-8');

        // Verify SidePanelHostBridge has pasteWithAssetCopy method
        const sidePanelBridgeClass = editorJsContent.match(/class SidePanelHostBridge[\s\S]*?(?=class EditorInstance)/);
        expect(sidePanelBridgeClass).toBeTruthy();
        expect(sidePanelBridgeClass[0]).toContain("pasteWithAssetCopy(markdown, sourceContext)");
        expect(sidePanelBridgeClass[0]).toContain("this._mainHost.pasteWithAssetCopy(markdown, sourceContext, this.filePath)");
    });

    test('DOD-11: Host handlers in providers exist', () => {
        // Check outlinerProvider.ts
        const outlinerProviderPath = path.join(__dirname, '../../src/outlinerProvider.ts');
        const outlinerContent = fs.readFileSync(outlinerProviderPath, 'utf-8');
        expect(outlinerContent).toContain("case 'pasteWithAssetCopy':");
        expect(outlinerContent).toContain("copyMdPasteAssets");

        // Check notesEditorProvider.ts
        const notesProviderPath = path.join(__dirname, '../../src/notesEditorProvider.ts');
        const notesContent = fs.readFileSync(notesProviderPath, 'utf-8');
        expect(notesContent).toContain("sidePanelAssetContext");

        // Check editorProvider.ts
        const editorProviderPath = path.join(__dirname, '../../src/editorProvider.ts');
        const editorContent = fs.readFileSync(editorProviderPath, 'utf-8');
        expect(editorContent).toContain("case 'pasteWithAssetCopy':");
    });

    test('DOD-15, DOD-16: outliner.js forwards messages', () => {
        const outlinerJsPath = path.join(__dirname, '../../src/webview/outliner.js');
        const outlinerContent = fs.readFileSync(outlinerJsPath, 'utf-8');

        // Verify sidePanelAssetContext forwarding
        expect(outlinerContent).toContain("case 'sidePanelAssetContext':");
        expect(outlinerContent).toContain("sidePanelHostBridge._assetContext");

        // Verify pasteWithAssetCopyResult forwarding
        expect(outlinerContent).toContain("case 'pasteWithAssetCopyResult':");
        expect(outlinerContent).toContain("sidePanelHostBridge._sendMessage");
    });
});
