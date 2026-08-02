/**
 * pdf-export-button.spec.ts — FR-PDF-08 PDF export ボタンの UI 構造（TC-PDF-60）
 *
 * TASK-10 / design/system.md §8.1。
 * editor-body-html.js を node-require で直接呼び（translate-toggle spec の先例）、
 * generateEditorBodyHtml() / generateSidePanelHtml() の出力文字列に
 *   - data-action="exportPdf" が存在する
 *   - その文字列位置が data-action="exportBundle" より前（Export bundle の左）
 *   - sidepanel 側は side-panel-header-btn class 付き
 * を検証する（source-text + 位置関係）。
 *
 * counterfactual: exportPdf ボタンを exportBundle の後ろに置く / class を落とすと RED。
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const editorBodyHtmlPath = path.resolve(__dirname, '../../src/shared/editor-body-html.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateEditorBodyHtml, generateSidePanelHtml } = require(editorBodyHtmlPath);

test.describe('FR-PDF-08: PDF export ボタン（TC-PDF-60）', () => {
    test('TC-PDF-60a: main toolbar に exportPdf が存在し exportBundle より前', () => {
        const html = generateEditorBodyHtml({}, 'darwin');
        const pdfIdx = html.indexOf('data-action="exportPdf"');
        const bundleIdx = html.indexOf('data-action="exportBundle"');
        expect(pdfIdx).toBeGreaterThan(-1);
        expect(bundleIdx).toBeGreaterThan(-1);
        // Export bundle の左 = 文字列位置が前
        expect(pdfIdx).toBeLessThan(bundleIdx);
    });

    test('TC-PDF-60b: sidepanel header に exportPdf が存在し exportBundle より前・side-panel-header-btn class 付き', () => {
        const html = generateSidePanelHtml({});
        const pdfIdx = html.indexOf('data-action="exportPdf"');
        const bundleIdx = html.indexOf('data-action="exportBundle"');
        expect(pdfIdx).toBeGreaterThan(-1);
        expect(bundleIdx).toBeGreaterThan(-1);
        expect(pdfIdx).toBeLessThan(bundleIdx);

        // exportPdf ボタンの markup に side-panel-header-btn class が付いていること。
        // ボタン要素を抽出して class を確認する（button 開始タグ内に両属性が同居）。
        const btnMatch = html.match(/<button[^>]*data-action="exportPdf"[^>]*>/);
        expect(btnMatch).not.toBeNull();
        expect(btnMatch![0]).toContain('side-panel-header-btn');
    });

    test('TC-PDF-60c: generateEditorBodyHtml 経由（side panel 込み）でも sidepanel exportPdf が side-panel-header-btn 付き', () => {
        // generateEditorBodyHtml は includeSidePanel 既定 true で generateSidePanelHtml を内包する。
        // main と sidepanel の 2 箇所とも exportPdf を持つことを合成出力でも確認。
        const html = generateEditorBodyHtml({}, 'darwin');
        // main toolbar 側（toolbar-group utility 内）と sidepanel header 側で計 2 個
        const count = (html.match(/data-action="exportPdf"/g) || []).length;
        expect(count).toBe(2);
        // sidepanel 側の exportPdf ボタンが side-panel-header-btn を持つ
        const spMatch = html.match(/<button[^>]*side-panel-header-btn[^>]*data-action="exportPdf"[^>]*>|<button[^>]*data-action="exportPdf"[^>]*side-panel-header-btn[^>]*>/);
        expect(spMatch).not.toBeNull();
    });
});
