/**
 * Sprint: 20260723-150000-md-outline-close-icon-and-panel-toggle-move
 *
 * FR-OU-01: md Outline パネルの閉じるボタンを ☰(&#9776;) → ×(&times;)（note md / sidepanel md / standalone md 共通）。
 * FR-OU-02: note md で file panel 閉 + Outline 開 のとき、file panel 開トグルを Outline ヘッダ左に表示（editor 左端は非表示）。
 *
 * 戦略:
 *   - 構造検証: editor-body-html.js を node-require し generateEditorBodyHtml / generateSidePanelHtml の出力文字列を検証。
 *   - 状態依存 CSS 検証: page.setContent で DOM + notes-body-html の CSS を注入し、file panel / Outline の class を
 *     トグルして 3 個の toggle の computed display を検証（TC-OU-04）。
 *   standalone build は md pane #sidebar/#closeSidebar を display:none + showNotesPanelToggle 無しでハードコードするため
 *   本 FR は E2E 非対象 → 本 spec の構造/CSS 単体検証 + 手動 US でカバー。
 */
import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');

const editorBodyHtmlPath = path.resolve(__dirname, '../../src/shared/editor-body-html.js');
const notesBodyHtmlPath = path.resolve(__dirname, '../../src/shared/notes-body-html.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateEditorBodyHtml, generateSidePanelHtml } = require(editorBodyHtmlPath);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateNotesFilePanelHtml } = require(notesBodyHtmlPath);

test.describe('FR-OU-01/02 — Outline close × + note md toggle 移設', () => {
    // TC-OU-01: editor 本体 #closeSidebar が &times;、☰ でない
    test('TC-OU-01 #closeSidebar は × (&times;)・☰ でない', () => {
        const html = generateEditorBodyHtml({}, 'darwin', { showNotesPanelToggle: true });
        // #closeSidebar ボタンを抽出
        const m = html.match(/<button[^>]*id="closeSidebar"[^>]*>([\s\S]*?)<\/button>/);
        expect(m, '#closeSidebar が存在').toBeTruthy();
        expect(m![0]).toContain('&times;');
        expect(m![0]).not.toContain('&#9776;');
        // title / id は維持
        expect(m![0]).toMatch(/title="[^"]*Cmd/);
    });

    // TC-OU-02: sidepanel #sidePanelSidebarClose が &times; / 他機能の ☰ は残る
    test('TC-OU-02 #sidePanelSidebarClose は ×・他機能の ☰ は不変', () => {
        const sp = generateSidePanelHtml({});
        const m = sp.match(/<button[^>]*id="sidePanelSidebarClose"[^>]*>([\s\S]*?)<\/button>/);
        expect(m, '#sidePanelSidebarClose が存在').toBeTruthy();
        expect(m![0]).toContain('&times;');
        expect(m![0]).not.toContain('&#9776;');
        // ★ file panel collapse ボタン（別機能の ☰）は notes-body-html で不変
        const fp = generateNotesFilePanelHtml({ collapsed: false, messages: {} });
        const fpHtml = typeof fp === 'string' ? fp : fp.html;
        const collapseBtn = fpHtml.match(/<button[^>]*id="filePanelCollapse"[^>]*>([\s\S]*?)<\/button>/);
        expect(collapseBtn, 'filePanelCollapse が存在').toBeTruthy();
        expect(collapseBtn![0], 'file panel collapse は ☰ のまま（× にしていない）').toContain('&#9776;');
    });

    // TC-OU-03: note md で Outline ヘッダに --outline toggle 追加・toolbar に --toolbar marker / 非 note md には無い
    test('TC-OU-03 showNotesPanelToggle 時のみ Outline ヘッダ toggle を追加', () => {
        const noteMd = generateEditorBodyHtml({}, 'darwin', { showNotesPanelToggle: true });
        // sidebar-header 内に --outline toggle が <h3>Outline</h3> の前にある
        const headerM = noteMd.match(/<div class="sidebar-header">([\s\S]*?)<\/div>/);
        expect(headerM, 'sidebar-header が存在').toBeTruthy();
        const header = headerM![1];
        expect(header).toContain('notes-panel-toggle-btn--outline');
        // --outline が <h3> より前（左）
        expect(header.indexOf('notes-panel-toggle-btn--outline')).toBeLessThan(header.indexOf('<h3>'));
        // toolbar 左端の toggle に --toolbar marker
        expect(noteMd).toContain('notes-panel-toggle-btn--toolbar');

        // showNotesPanelToggle 無し（standalone/sidepanel 相当）は Outline ヘッダ toggle 無し
        const standalone = generateEditorBodyHtml({}, 'darwin', {});
        const saHeaderM = standalone.match(/<div class="sidebar-header">([\s\S]*?)<\/div>/);
        expect(saHeaderM![1]).not.toContain('notes-panel-toggle-btn--outline');
        expect(standalone).not.toContain('notes-panel-toggle-btn--toolbar');
    });

    // TC-OU-04（★load-bearing・状態依存 CSS）: 3 個の toggle の表示条件が排他
    test('TC-OU-04 3 toggle の display が file panel / Outline 状態で排他', async ({ page }) => {
        const fp = generateNotesFilePanelHtml({ collapsed: false, messages: {} });
        const notesCss = (typeof fp === 'string') ? '' : fp.css;
        // 実 DOM 階層を最小再現: .notes-layout > .notes-file-panel + .notes-main-wrapper
        //   .notes-main-wrapper 内に ① outliner pane(#notesPanelToggleBtn) と ② md pane(.container>#sidebar+.editor-container)
        const dom = `
          <div class="notes-layout">
            <div class="notes-file-panel" id="fp"></div>
            <div class="notes-main-wrapper">
              <div class="outliner-container"><div class="outliner-search-bar">
                <button class="notes-panel-toggle-btn" id="notesPanelToggleBtn">≡</button>
              </div></div>
              <div class="container">
                <aside class="sidebar" id="sidebar">
                  <div class="sidebar-header">
                    <button class="notes-panel-toggle-btn notes-panel-toggle-btn--outline" id="tOutline">≡</button>
                    <h3>Outline</h3>
                    <button class="sidebar-toggle" id="closeSidebar">&times;</button>
                  </div>
                </aside>
                <main class="editor-container"><div class="toolbar">
                  <button class="notes-panel-toggle-btn notes-panel-toggle-btn--toolbar" id="tToolbar">≡</button>
                </div></main>
              </div>
            </div>
          </div>`;
        await page.setContent(`<!DOCTYPE html><html><head><style>${notesCss}</style></head><body>${dom}</body></html>`);

        const disp = (id: string) => page.$eval('#' + id, (el) => getComputedStyle(el).display);
        const setFp = (collapsed: boolean) => page.$eval('#fp', (el, c) => { el.classList.toggle('collapsed', c as boolean); }, collapsed);
        const setOutline = (open: boolean) => page.$eval('#sidebar', (el, o) => { el.classList.toggle('hidden', !(o as boolean)); }, open);

        // (a) file panel 開 → 3 個とも none
        await setFp(false); await setOutline(true);
        expect(await disp('notesPanelToggleBtn')).toBe('none');
        expect(await disp('tToolbar')).toBe('none');
        expect(await disp('tOutline')).toBe('none');

        // (b) file panel 閉 + Outline 閉 → ①表示 / ②表示 / ③非表示
        await setFp(true); await setOutline(false);
        expect(await disp('notesPanelToggleBtn'), '① outliner は常時表示').not.toBe('none');
        expect(await disp('tToolbar'), '② toolbar は Outline 閉で表示').not.toBe('none');
        expect(await disp('tOutline'), '③ outline は Outline 閉で非表示').toBe('none');

        // (c) file panel 閉 + Outline 開 → ①表示 / ②非表示 / ③表示（②③ 排他 = 単一ボタン）
        await setFp(true); await setOutline(true);
        expect(await disp('notesPanelToggleBtn'), '① outliner は常時表示').not.toBe('none');
        expect(await disp('tToolbar'), '② toolbar は Outline 開で非表示').toBe('none');
        expect(await disp('tOutline'), '③ outline は Outline 開で表示').not.toBe('none');
    });
});
