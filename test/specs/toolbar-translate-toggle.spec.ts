/**
 * Sprint: 20260426-095402-toolbar-translate-toggle
 *
 * 検証する FR:
 *   FR-TRTOG-2: standalone toolbar の inline group 直前 (scroll 内最左) に translate group
 *   FR-TRTOG-3: data-show-translate-buttons 属性で表示制御
 *   FR-TRTOG-4: 動的切替で表示/非表示が連動
 *
 * 戦略:
 *   1. HTML 構造検証: editor-body-html.js を node-require で読み込み、
 *      generateEditorBodyHtml() の出力文字列を検証 (TC-TRTOG-1, TC-TRTOG-MATRIX-1 一部)
 *   2. CSS 表示制御検証: page.setContent でツールバー部分 HTML と styles.css を注入し、
 *      data-show-translate-buttons 属性をトグルして computed display を検証
 *      (TC-TRTOG-2 〜 TC-TRTOG-5)
 *
 * standalone-editor.html はツールバー UI を stub しているため、本 spec は
 * 直接 HTML 構造 + CSS rule の単体検証で FR をカバーする。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');

const editorBodyHtmlPath = path.resolve(__dirname, '../../src/shared/editor-body-html.js');
const stylesCssPath = path.resolve(__dirname, '../../src/webview/styles.css');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateEditorBodyHtml } = require(editorBodyHtmlPath);

test.describe('FR-TRTOG-2: standalone toolbar に translate group が含まれる', () => {
    test('TC-TRTOG-1: toolbar-inner 内に [data-group="translate"] が存在し、inline group の直前にある', async () => {
        const html = generateEditorBodyHtml({}, 'darwin');

        // toolbar-inner 内に translate group が存在
        expect(html).toContain('<div class="toolbar-group" data-group="translate">');

        // toolbar-inner の中身を抜き出す
        const innerMatch = html.match(/<div class="toolbar-inner"[^>]*>([\s\S]*?)<\/div>\s*<button class="toolbar-scroll-btn toolbar-scroll-btn--right/);
        expect(innerMatch).not.toBeNull();
        const inner = innerMatch![1];

        // translate group が inline group より前に出現
        const translateIdx = inner.indexOf('data-group="translate"');
        const inlineIdx = inner.indexOf('data-group="inline"');
        expect(translateIdx).toBeGreaterThan(-1);
        expect(inlineIdx).toBeGreaterThan(-1);
        expect(translateIdx).toBeLessThan(inlineIdx);
    });

    test('TC-TRTOG-1b: translate group 内に translateLang と translate ボタンの両方がある', async () => {
        const html = generateEditorBodyHtml({}, 'darwin');
        // 該当 group ブロックを抽出
        const groupMatch = html.match(/<div class="toolbar-group" data-group="translate">([\s\S]*?)<\/div>/);
        expect(groupMatch).not.toBeNull();
        const groupBody = groupMatch![1];
        expect(groupBody).toContain('data-action="translateLang"');
        expect(groupBody).toContain('data-action="translate"');
    });

    test('TC-TRTOG-1c: side panel header の translate ボタンは既存通り維持される (regression)', async () => {
        const html = generateEditorBodyHtml({}, 'darwin');
        // side-panel-header-actions 内の translate ボタンも存在し続ける
        const sidePanelMatch = html.match(/<div class="side-panel-header-actions">([\s\S]*?)<\/div>/);
        expect(sidePanelMatch).not.toBeNull();
        const sidePanelActions = sidePanelMatch![1];
        expect(sidePanelActions).toContain('data-action="translateLang"');
        expect(sidePanelActions).toContain('data-action="translate"');
    });
});

test.describe('FR-TRTOG-3: data-show-translate-buttons 属性で表示制御', () => {
    /**
     * 本テストでは page.setContent で最小限の HTML を注入し styles.css を addStyleTag する。
     * 重要 selector のみ含む簡易 fixture で computed display を確認する。
     */
    const buildFixture = (showFlag: 'true' | 'false', toolbarMode: 'full' | 'simple' = 'full') => `
        <!DOCTYPE html>
        <html data-show-translate-buttons="${showFlag}" data-toolbar-mode="${toolbarMode}">
        <head><title>fixture</title></head>
        <body>
            <div class="toolbar">
                <div class="toolbar-fixed toolbar-fixed--left">
                    <div class="toolbar-group" data-group="history">
                        <button data-action="undo">u</button>
                    </div>
                </div>
                <div class="toolbar-inner">
                    <div class="toolbar-group" data-group="translate">
                        <button data-action="translateLang">ja → en</button>
                        <button data-action="translate">x</button>
                    </div>
                    <div class="toolbar-group" data-group="inline">
                        <button data-action="bold">b</button>
                    </div>
                </div>
            </div>
            <div class="side-panel">
                <div class="side-panel-header">
                    <div class="side-panel-header-actions">
                        <button class="side-panel-header-btn" data-action="undo">u</button>
                        <button class="side-panel-header-btn" data-action="translateLang">ja</button>
                        <button class="side-panel-header-btn" data-action="translate">x</button>
                        <button class="side-panel-header-btn" data-action="source">s</button>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `;

    test('TC-TRTOG-2: フラグ OFF で toolbar-inner 内 translate group が非表示', async ({ page }) => {
        await page.setContent(buildFixture('false'));
        await page.addStyleTag({ path: stylesCssPath });

        const display = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-inner [data-group="translate"]') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(display).toBe('none');
    });

    test('TC-TRTOG-2b: フラグ OFF でも他の toolbar-group は通常表示', async ({ page }) => {
        await page.setContent(buildFixture('false'));
        await page.addStyleTag({ path: stylesCssPath });

        const inlineDisplay = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-inner [data-group="inline"]') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(inlineDisplay).not.toBe('none');
    });

    test('TC-TRTOG-3: フラグ ON で toolbar-inner 内 translate group が表示される', async ({ page }) => {
        await page.setContent(buildFixture('true'));
        await page.addStyleTag({ path: stylesCssPath });

        const display = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-inner [data-group="translate"]') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(display).not.toBe('none');
    });

    test('TC-TRTOG-4: フラグ OFF で side-panel-header-actions 内の translate / translateLang が非表示', async ({ page }) => {
        await page.setContent(buildFixture('false'));
        await page.addStyleTag({ path: stylesCssPath });

        const result = await page.evaluate(() => {
            const t = document.querySelector('.side-panel-header-actions [data-action="translate"]') as HTMLElement;
            const tl = document.querySelector('.side-panel-header-actions [data-action="translateLang"]') as HTMLElement;
            const undo = document.querySelector('.side-panel-header-actions [data-action="undo"]') as HTMLElement;
            return {
                translate: t ? getComputedStyle(t).display : null,
                translateLang: tl ? getComputedStyle(tl).display : null,
                undo: undo ? getComputedStyle(undo).display : null,
            };
        });
        expect(result.translate).toBe('none');
        expect(result.translateLang).toBe('none');
        // 他のボタンは表示されたまま (regression check)
        expect(result.undo).not.toBe('none');
    });

    test('TC-TRTOG-4b: フラグ ON で side-panel-header-actions 内の translate ボタンが表示', async ({ page }) => {
        await page.setContent(buildFixture('true'));
        await page.addStyleTag({ path: stylesCssPath });

        const result = await page.evaluate(() => {
            const t = document.querySelector('.side-panel-header-actions [data-action="translate"]') as HTMLElement;
            const tl = document.querySelector('.side-panel-header-actions [data-action="translateLang"]') as HTMLElement;
            return {
                translate: t ? getComputedStyle(t).display : null,
                translateLang: tl ? getComputedStyle(tl).display : null,
            };
        });
        expect(result.translate).not.toBe('none');
        expect(result.translateLang).not.toBe('none');
    });

    test('TC-TRTOG-5: 動的切替で表示/非表示が連動する', async ({ page }) => {
        await page.setContent(buildFixture('false'));
        await page.addStyleTag({ path: stylesCssPath });

        // 初期: 非表示
        let display = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-inner [data-group="translate"]') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(display).toBe('none');

        // ON に切替
        await page.evaluate(() => {
            document.documentElement.setAttribute('data-show-translate-buttons', 'true');
        });
        display = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-inner [data-group="translate"]') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(display).not.toBe('none');

        // 再び OFF に
        await page.evaluate(() => {
            document.documentElement.setAttribute('data-show-translate-buttons', 'false');
        });
        display = await page.evaluate(() => {
            const el = document.querySelector('.toolbar-inner [data-group="translate"]') as HTMLElement;
            return el ? getComputedStyle(el).display : null;
        });
        expect(display).toBe('none');
    });
});

test.describe('NFR-TRTOG-2: toolbarMode との整合', () => {
    const buildFixture = (showFlag: 'true' | 'false', toolbarMode: 'full' | 'simple') => `
        <!DOCTYPE html>
        <html data-show-translate-buttons="${showFlag}" data-toolbar-mode="${toolbarMode}">
        <head><title>fixture</title></head>
        <body>
            <div class="toolbar">
                <div class="toolbar-inner">
                    <div class="toolbar-group" data-group="translate">
                        <button data-action="translateLang">ja</button>
                    </div>
                </div>
            </div>
            <div class="side-panel">
                <div class="side-panel-header">
                    <div class="side-panel-header-actions">
                        <button class="side-panel-header-btn" data-action="translate">x</button>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `;

    test('TC-TRTOG-MATRIX-1: 4 組合せで期待挙動', async ({ page }) => {
        const cases = [
            { mode: 'full' as const, flag: 'true' as const, toolbarTranslate: 'visible', sidePanelTranslate: 'visible' },
            { mode: 'full' as const, flag: 'false' as const, toolbarTranslate: 'hidden', sidePanelTranslate: 'hidden' },
            { mode: 'simple' as const, flag: 'true' as const, toolbarTranslate: 'hidden', sidePanelTranslate: 'visible' },
            { mode: 'simple' as const, flag: 'false' as const, toolbarTranslate: 'hidden', sidePanelTranslate: 'hidden' },
        ];

        for (const c of cases) {
            await page.setContent(buildFixture(c.flag, c.mode));
            await page.addStyleTag({ path: stylesCssPath });

            const result = await page.evaluate(() => {
                const tInner = document.querySelector('.toolbar-inner [data-group="translate"]') as HTMLElement;
                const sp = document.querySelector('.side-panel-header-actions [data-action="translate"]') as HTMLElement;
                const inner = document.querySelector('.toolbar-inner') as HTMLElement;
                return {
                    toolbarInnerDisplay: inner ? getComputedStyle(inner).display : null,
                    translateGroupDisplay: tInner ? getComputedStyle(tInner).display : null,
                    sidePanelTranslateDisplay: sp ? getComputedStyle(sp).display : null,
                };
            });

            // toolbar-inner translate group は flag=true && mode=full のみ visible
            const toolbarVisible = (result.toolbarInnerDisplay !== 'none')
                && (result.translateGroupDisplay !== 'none');
            const expectedToolbar = c.toolbarTranslate === 'visible';
            expect(
                toolbarVisible,
                `toolbar translate (mode=${c.mode}, flag=${c.flag}) expected ${c.toolbarTranslate}`
            ).toBe(expectedToolbar);

            // side panel translate は flag に従う (mode の影響を受けない)
            const sidePanelVisible = result.sidePanelTranslateDisplay !== 'none';
            const expectedSp = c.sidePanelTranslate === 'visible';
            expect(
                sidePanelVisible,
                `side panel translate (mode=${c.mode}, flag=${c.flag}) expected ${c.sidePanelTranslate}`
            ).toBe(expectedSp);
        }
    });
});
