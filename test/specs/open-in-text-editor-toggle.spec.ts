/**
 * fractal.showOpenInTextEditor による Open in Text Editor 表示制御（FR-OTE / ADRL-0017）。
 *
 * 既存 toolbar-translate-toggle.spec と同型:
 *   - CSS 表示制御: page.setContent の最小 fixture + 実 styles.css で computed display を検証（主番人）。
 *   - 実 standalone html に openInTextEditor ボタン（data-action）が存在することを source-text で確認。
 * 3 生成器の <html> 属性注入は vscode import のため unit 直呼び不可 → 手動 US で担保。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const stylesCssPath = path.resolve(__dirname, '../../src/webview/styles.css');

// 最小 fixture: html 属性 + 4 サーフェス相当のボタン + 巻き込み確認用の他ボタン
const buildFixture = (showFlag: 'true' | 'false') => `
    <!DOCTYPE html>
    <html data-show-open-in-text-editor="${showFlag}">
    <head><title>fixture</title></head>
    <body>
        <div class="toolbar">
            <button data-action="openInTextEditor" id="toolbarOite">t</button>
            <button data-action="openInNewTab" id="otherTab">n</button>
            <button data-action="bold" id="otherBold">b</button>
        </div>
        <div class="side-panel-header-actions">
            <button class="side-panel-header-btn" data-action="openInTextEditor" id="spOite">s</button>
        </div>
        <div class="outliner-menu-dropdown">
            <button class="menu-item" data-action="openInTextEditor" id="menuOite">Open in Text Editor</button>
            <button class="menu-item" id="menuOther">Copy Path</button>
        </div>
    </body>
    </html>
`;

async function displayOf(page: any, id: string): Promise<string | null> {
    return page.evaluate((sel: string) => {
        const el = document.getElementById(sel);
        return el ? getComputedStyle(el).display : null;
    }, id);
}

test.describe('FR-OTE: showOpenInTextEditor による表示制御', () => {
    // TC-OTE-03（★load-bearing）: false で全 openInTextEditor が display:none / true で表示
    test('TC-OTE-03 false で openInTextEditor 3 サーフェスが非表示・true で表示', async ({ page }) => {
        // OFF
        await page.setContent(buildFixture('false'));
        await page.addStyleTag({ path: stylesCssPath });
        expect(await displayOf(page, 'toolbarOite')).toBe('none');
        expect(await displayOf(page, 'spOite')).toBe('none');
        expect(await displayOf(page, 'menuOite')).toBe('none');
        // ON（counterfactual: 属性が true なら非表示ルールは効かない）
        await page.setContent(buildFixture('true'));
        await page.addStyleTag({ path: stylesCssPath });
        expect(await displayOf(page, 'toolbarOite')).not.toBe('none');
        expect(await displayOf(page, 'spOite')).not.toBe('none');
        expect(await displayOf(page, 'menuOite')).not.toBe('none');
    });

    // TC-OTE-04（巻き込み無し）: false でも openInTextEditor 以外は表示され続ける
    test('TC-OTE-04 false でも他ボタン(openInNewTab / bold / 他 menu-item)は表示', async ({ page }) => {
        await page.setContent(buildFixture('false'));
        await page.addStyleTag({ path: stylesCssPath });
        expect(await displayOf(page, 'otherTab')).not.toBe('none');
        expect(await displayOf(page, 'otherBold')).not.toBe('none');
        expect(await displayOf(page, 'menuOther')).not.toBe('none');
    });
});

test.describe('FR-OTE: 実 standalone html に openInTextEditor ボタンが存在', () => {
    // TC-OTE-06: notes / outliner の standalone html に data-action="openInTextEditor" が存在
    //   （standalone-editor は toolbar 空 stub で 0 個なので対象外・design-review 訂正）
    test('TC-OTE-06 standalone-notes / standalone-outliner に openInTextEditor ボタンが存在', () => {
        const notesHtml = fs.readFileSync(path.resolve(__dirname, '../html/standalone-notes.html'), 'utf-8');
        const outlinerHtml = fs.readFileSync(path.resolve(__dirname, '../html/standalone-outliner.html'), 'utf-8');
        expect(notesHtml).toContain('data-action="openInTextEditor"');
        expect(outlinerHtml).toContain('data-action="openInTextEditor"');
        // outliner 右クリック項目に data-action を付与した本 sprint の変更点（動的生成の setAttribute）
        expect(outlinerHtml.includes("setAttribute('data-action', 'openInTextEditor')")
            || outlinerHtml.includes('setAttribute("data-action", "openInTextEditor")')).toBe(true);
    });
});
