/**
 * TASK-05 (sprint 20260809-031217-notetree-file-dnd): Notes ファイルツリー file item の
 * D&D 送受信を outliner.js / editor.js の webview 側で配線する番人。
 *
 * 対象 TC（design §4d–§4h / testcases.md）:
 *   - TC-WV-02 (FR-TF-05b): outliner 📎 アイコン dragstart が application/x-fractal-out-node-file を
 *       setData（payload {outFileKey, nodeId}・絶対パス不含 = NFR-TF-02）。bullet dragstart は
 *       従来 MIME（x-fractal-out-node-subtree）のみ（掴み分離）。
 *   - TC-WV-03 (FR-TF-06b): md editor の file アンカー dragstart が application/x-fractal-md-filelink を
 *       setData。subpage アンカーは従来 MIME（x-fractal-md-subpage）のみ（相互不干渉）。
 *   - TC-WV-08 (FR-TF-05a 受信側): outliner に x-fractal-tree-file の drop（DataTransfer 合成）で
 *       notesHostBridge.notesImportTreeFileAtPosition(id, outFileId, targetNodeId, position) が呼ばれる。
 *       tree-md drop（既存）と相互不干渉。
 *   - TC-WV-09 (FR-TF-06a 受信側 + FR-MSEL-04 rev2): editor に x-fractal-tree-file **単独**の drop で
 *       targetHost.attachTreeFileToMd(id)（main / sidepanel の targetHost 選択を両方踏む）。
 *       tree-file と tree-md が**同載**の drop は種別混在の複数選択（design §4-2 rev2 / TASK-45）なので
 *       結合 bridge attachTreeItemsToMdBatch を **1 回**呼び、単一 attachTreeFileToMd / linkMdAsSubpage は呼ばない
 *       （TASK-50 test_update: 旧 counterfactual「poison な tree-md を同載しても tree-file 分岐が先行」は
 *        rev2 の契約と衝突するため撤回。「tree-md 単独 drop が attachTreeFileToMd を呼ばない」は TC-WV-08 系が担保）。
 *   - TC-WV-10 (§4h one-shot 掃除): outliner 📎 dragstart / editor file アンカー dragstart の新 state が
 *       dragend で clear される（per-file counterfactual: dragend clear を外すと stale = RED）。
 *
 * 環境: production notes モード（outliner.js + editor.js を同一 document に両ロード）を現ソースから
 *   addScriptTag で組み上げる（build-standalone-notes.js と同じ script 順・placeholder 置換）。
 *   コミット済み standalone HTML は `npx playwright test` では再ビルドされない（pretest = compile+lint のみ）ため
 *   stale。よって毎回現ソースを注入する。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../../src');
const r = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// build-standalone-notes.js と同じ「editor.js より前」スクリプト群
const SCRIPTS_BEFORE_EDITOR = [
    // 🔴 共有ヘルパは **outliner.js / notes-file-panel.js より前**に登録する（drop 経路で必ず呼ばれる）。
    // この spec は build-standalone-* を使わず独自の script リストで組むため、
    // 本番 3 面 + standalone ハーネス 3 本の「6 点登録」では届かない 7 点目にあたる
    // （TASK-30 で batch-payload を入れたとき TC-WV-08 / TC-MX-04 が RED になって判明）。
    r('shared/menu-placement.js'),
    r('shared/batch-payload.js'),
    r('webview/html-md-converter.js'),
    r('shared/markdown-link-parser.js'),
    r('shared/sidepanel-bridge-methods.js'),
    r('webview/editor-utils.js'),
    r('shared/notes-color-palette.js'),
    r('shared/inline-color.js'),
    r('shared/inline-color-picker.js'),
    r('shared/inapp-link-utils.js'),
    r('shared/shortcut-list.js'),
    r('shared/shortcut-hud.js'),
];
const EDITOR_JS = r('webview/editor.js')
    .replace('__DEBUG_MODE__', 'false')
    .replace('__I18N__', '{}')
    .replace('__DOCUMENT_BASE_URI__', '')
    .replace('__IS_OUTLINER_PAGE__', 'true')
    .replace('__CONTENT__', `'(unused)'`);
const SCRIPTS_AFTER_EDITOR = [
    r('webview/outliner-cell.js'),
    r('webview/outliner-model.js'),
    r('webview/outliner-search.js'),
    r('webview/outliner-clip-select.js'),
    r('webview/outliner.js'),
];

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateEditorBodyHtml, generateSidePanelHtml } = require(path.join(SRC, 'shared/editor-body-html.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notesBodyHtml = require(path.join(SRC, 'shared/notes-body-html.js'));
const NOTES_PANEL_HTML = notesBodyHtml.generateNotesFilePanelHtml({ collapsed: false, messages: {} }).html;
const MARKDOWN_PANE_HTML = generateEditorBodyHtml({}, 'darwin', { includeSidePanel: false });
const SIDE_PANEL_HTML = generateSidePanelHtml({});

const BODY = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body>
    <div class="notes-layout" data-note-folder-name="">
        ${NOTES_PANEL_HTML}
        <div class="notes-main-wrapper">
            <div class="notes-tab-bar" id="notesTabBar" style="display:none;"></div>
            <div class="outliner-container">
                <div class="outliner-scroll-content">
                    <div class="outliner-page-title"><input type="text" class="outliner-page-title-input" /></div>
                    <div class="outliner-search-bar">
                        <button class="outliner-nav-back-btn" disabled></button>
                        <button class="outliner-nav-forward-btn" disabled></button>
                        <button class="outliner-search-mode-toggle"></button>
                        <div class="outliner-search-input-wrapper">
                            <input type="text" class="outliner-search-input" placeholder="Search..." />
                        </div>
                        <button class="outliner-undo-btn" disabled></button>
                        <button class="outliner-redo-btn" disabled></button>
                        <button class="outliner-menu-btn"></button>
                    </div>
                    <div class="outliner-breadcrumb"></div>
                    <div class="outliner-tree" role="tree"></div>
                </div>
            </div>
            <div class="markdown-container" style="display:none">
                ${MARKDOWN_PANE_HTML}
            </div>
            ${SIDE_PANEL_HTML}
        </div>
    </div>
    <div class="sidebar" id="sidebar" style="display:none;"><div class="outline" id="outline"></div></div>
    <div class="sidebar-resizer" id="sidebarResizer" style="display:none;"></div>
    <div class="toolbar" id="toolbar" style="display:none;"></div>
    <div id="statusLeft" style="display:none;"></div>
    <div class="sidebar-status-imagedir" id="statusImageDir" style="display:none;"></div>
    <div class="word-count" id="wordCount" style="display:none;"></div>
    <div class="source-editor" id="sourceEditor" style="display:none;"></div>
    <button class="sidebar-toggle" id="closeSidebar" style="display:none;"></button>
    <button data-action="openOutline" id="openSidebarBtn" style="display:none;"></button>
    <div class="editor" id="editor" contenteditable="true" spellcheck="false" style="display:none;"></div>
</body></html>`;

// window に載せる bootstrap（フラグ + mermaid stub + 記録用 Proxy bridge + recorder）
const BOOTSTRAP = `
window.__SKIP_EDITOR_AUTO_INIT__ = true;
window.__outlinerMessages = {};
window.__initialFileChangeId = 0;
window.mermaid = { initialize: function(){}, run: function(){}, render: function(){ return Promise.resolve({ svg: '' }); }, mermaidAPI: { initialize: function(){} } };
window.__calls = [];
window.__mainCalls = [];
window.__sideCalls = [];
window.__rec = function(log, extra){
    extra = extra || {};
    return new Proxy(extra, {
        get: function(t, p){
            if (p === 'then' || typeof p === 'symbol') { return undefined; }
            if (p in t) { return t[p]; }
            return function(){ log.push({ type: String(p), args: Array.prototype.slice.call(arguments) }); };
        }
    });
};
window.outlinerHostBridge = window.__rec(window.__calls, { filePath: null, onMessage: function(h){ window.__omh = h; } });
window.notesHostBridge = window.__rec(window.__calls, {});
window.notesFilePanel = { getCurrentOutFileId: function(){ return 'OUT-1'; } };
`;

async function loadEnv(page: Page): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(BODY, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: BOOTSTRAP });
    for (const s of SCRIPTS_BEFORE_EDITOR) { await page.addScriptTag({ content: s }); }
    await page.addScriptTag({ content: EDITOR_JS });
    for (const s of SCRIPTS_AFTER_EDITOR) { await page.addScriptTag({ content: s }); }
}

// filePath を持つ 1 node の outliner を outFileKey 付きで初期化
async function initOutlinerWithFileNode(page: Page): Promise<void> {
    await page.evaluate(() => {
        const data = {
            version: 1,
            rootIds: ['n1'],
            nodes: {
                n1: {
                    id: 'n1', parentId: null, children: [], text: 'attachment node',
                    filePath: 'files/report.pdf', isPage: false, pageId: null,
                    collapsed: false, checked: null, subtext: '', images: [],
                },
            },
        };
        (window as any).Outliner.init(data, 'OUT-KEY-1');
    });
}

// editor.js の document レベル dragstart/drop/dragend listener を登録するため実 EditorInstance を 1 個構築
async function initEditorListeners(page: Page): Promise<void> {
    await page.evaluate(() => {
        const mc = document.querySelector('.markdown-container') as HTMLElement;
        mc.style.display = '';
        // eslint-disable-next-line no-new
        new (window as any).EditorInstance(mc, (window as any).outlinerHostBridge, {
            initialContent: '', filePath: '/notes/main.md', documentBaseUri: '', sidebarHidden: true,
        });
    });
}

test.describe('TASK-05 — notetree file D&D (outliner / md editor webview)', () => {

    // ---- TC-WV-02: outliner 📎 dragstart -> x-fractal-out-node-file (no abs path); bullet legacy only ----
    test('TC-WV-02 outliner 📎 dragstart は x-fractal-out-node-file のみ・絶対パス不含、bullet は subtree MIME のみ', async ({ page }) => {
        await loadEnv(page);
        await initOutlinerWithFileNode(page);

        const iconExists = await page.evaluate(() => !!document.querySelector('.outliner-file-icon'));
        expect(iconExists).toBe(true);

        // setData spy で 📎 dragstart を捕捉
        const iconCap = await page.evaluate(() => {
            const icon = document.querySelector('.outliner-file-icon') as HTMLElement;
            const captured: Record<string, string> = {};
            const orig = (DataTransfer.prototype as any).setData;
            (DataTransfer.prototype as any).setData = function (type: string, data: string) {
                captured[type] = data; return orig.call(this, type, data);
            };
            try {
                const dt = new DataTransfer();
                icon.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            } finally {
                (DataTransfer.prototype as any).setData = orig;
            }
            return captured;
        });

        expect(iconCap['application/x-fractal-out-node-file']).toBeTruthy();
        // bullet 並べ替え/subtree MIME は 📎 には載らない（掴み分離）
        expect(iconCap['application/x-fractal-out-node-subtree']).toBeUndefined();
        const filePayload = JSON.parse(iconCap['application/x-fractal-out-node-file']);
        expect(filePayload.outFileKey).toBe('OUT-KEY-1');
        expect(filePayload.nodeId).toBe('n1');
        // NFR-TF-02: 絶対パス / filePath 実体を含まない
        expect(JSON.stringify(filePayload)).not.toContain('report.pdf');
        expect(JSON.stringify(filePayload)).not.toContain('files/');

        // bullet dragstart は従来 MIME（subtree）のみ・file MIME は載らない
        const bulletCap = await page.evaluate(() => {
            const bullet = document.querySelector('.outliner-bullet') as HTMLElement;
            const captured: Record<string, string> = {};
            const orig = (DataTransfer.prototype as any).setData;
            (DataTransfer.prototype as any).setData = function (type: string, data: string) {
                captured[type] = data; return orig.call(this, type, data);
            };
            try {
                const dt = new DataTransfer();
                bullet.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            } finally {
                (DataTransfer.prototype as any).setData = orig;
            }
            return captured;
        });
        expect(bulletCap['application/x-fractal-out-node-subtree']).toBeTruthy();
        expect(bulletCap['application/x-fractal-out-node-file']).toBeUndefined();
    });

    // ---- TC-WV-03: md file anchor dragstart -> x-fractal-md-filelink; subpage anchor legacy only ----
    test('TC-WV-03 md file アンカー dragstart は x-fractal-md-filelink のみ、subpage アンカーは x-fractal-md-subpage のみ', async ({ page }) => {
        await loadEnv(page);
        await initEditorListeners(page);

        // real instance の .editor に file アンカー + subpage アンカーを挿入
        await page.evaluate(() => {
            const ed = document.querySelector('.markdown-container .editor') as HTMLElement;
            ed.innerHTML =
                '<a id="fileA" href="files/report.pdf" data-markdown-path="files/report.pdf" data-is-file-attachment="true">📎 report.pdf</a>' +
                '<a id="subA" href="sub.md" data-markdown-path="sub.md" data-subpage="true">Sub Page</a>';
        });

        // file アンカー dragstart
        const fileCap = await page.evaluate(() => {
            const a = document.getElementById('fileA') as HTMLElement;
            const captured: Record<string, string> = {};
            const orig = (DataTransfer.prototype as any).setData;
            (DataTransfer.prototype as any).setData = function (type: string, data: string) {
                captured[type] = data; return orig.call(this, type, data);
            };
            try {
                const dt = new DataTransfer();
                a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            } finally {
                (DataTransfer.prototype as any).setData = orig;
            }
            return captured;
        });
        expect(fileCap['application/x-fractal-md-filelink']).toBeTruthy();
        expect(fileCap['application/x-fractal-md-subpage']).toBeUndefined();
        const fp = JSON.parse(fileCap['application/x-fractal-md-filelink']);
        expect(fp.href).toBe('files/report.pdf');
        expect(fp.sourceMdPath).toBe('/notes/main.md');

        // subpage アンカー dragstart は従来 MIME のみ・filelink は載らない
        const subCap = await page.evaluate(() => {
            const a = document.getElementById('subA') as HTMLElement;
            const captured: Record<string, string> = {};
            const orig = (DataTransfer.prototype as any).setData;
            (DataTransfer.prototype as any).setData = function (type: string, data: string) {
                captured[type] = data; return orig.call(this, type, data);
            };
            try {
                const dt = new DataTransfer();
                a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            } finally {
                (DataTransfer.prototype as any).setData = orig;
            }
            return captured;
        });
        expect(subCap['application/x-fractal-md-subpage']).toBeTruthy();
        expect(subCap['application/x-fractal-md-filelink']).toBeUndefined();
    });

    // ---- TC-MX-06 (FR-TF-15 2026-08-10): レンダリング済み file アンカーでも dragstart が効く ----
    // 初版は data-is-file-attachment が insertFileLink の新規挿入時にしか付かず、md ロード→
    // レンダリング後のアンカーは drag 不能だった（counterfactual: レンダ時付与を外すと RED）。
    test('TC-MX-06 md ロード後（レンダリング経由）の 📎 file アンカーで dragstart → x-fractal-md-filelink。subpage 非干渉', async ({ page }) => {
        await loadEnv(page);
        // insertFileLink を経由せず、initialContent の md からレンダリングさせる
        await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container') as HTMLElement;
            mc.style.display = '';
            // eslint-disable-next-line no-new
            new (window as any).EditorInstance(mc, (window as any).outlinerHostBridge, {
                initialContent: '[📎 report.pdf](files/report.pdf)\n\n[[Sub Page]](sub.md)\n',
                filePath: '/notes/main.md', documentBaseUri: '', sidebarHidden: true,
            });
        });

        const state = await page.evaluate(() => {
            const ed = document.querySelector('.markdown-container .editor') as HTMLElement;
            const anchors = Array.from(ed.querySelectorAll('a'));
            // TASK-05: 📎 は DOM テキストに出ない（serialize が復元）— data 属性で特定
            const fa = anchors.find(a => (a as HTMLElement).dataset.isFileAttachment === 'true') as HTMLElement | undefined;
            const sa = anchors.find(a => (a as HTMLElement).dataset.subpage === 'true') as HTMLElement | undefined;
            if (!fa) return { found: false } as any;
            const captured: Record<string, string> = {};
            const orig = (DataTransfer.prototype as any).setData;
            (DataTransfer.prototype as any).setData = function (type: string, data: string) {
                captured[type] = data; return orig.call(this, type, data);
            };
            try {
                const dt = new DataTransfer();
                fa.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            } finally {
                (DataTransfer.prototype as any).setData = orig;
            }
            return {
                found: true,
                draggable: (fa as any).draggable === true,
                hasAttr: fa.dataset.isFileAttachment === 'true',
                subpageDistinct: !!sa && sa !== fa,
                captured,
            };
        });

        expect(state.found).toBe(true);
        expect(state.draggable).toBe(true);   // レンダ時に draggable 付与
        expect(state.hasAttr).toBe(true);     // レンダ時に data-is-file-attachment 付与（DOM 契約統一）
        expect(state.subpageDistinct).toBe(true);
        expect(state.captured['application/x-fractal-md-filelink']).toBeTruthy();
        const p = JSON.parse(state.captured['application/x-fractal-md-filelink']);
        expect(p.href).toBe('files/report.pdf');
        expect(p.sourceMdPath).toBe('/notes/main.md');
        expect(state.captured['application/x-fractal-md-subpage']).toBeUndefined();
    });

    // ---- TC-WV-08: outliner x-fractal-tree-file drop -> notesImportTreeFileAtPosition ----
    test('TC-WV-08 outliner の x-fractal-tree-file drop が notesImportTreeFileAtPosition(id, outFileId, targetNodeId, position) を呼ぶ・tree-md と不干渉', async ({ page }) => {
        await loadEnv(page);
        await initOutlinerWithFileNode(page);

        const result = await page.evaluate(() => {
            (window as any).__calls.length = 0;
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'FILE-77' }));
            const rect = nodeEl.getBoundingClientRect();
            // node 上端付近 = before 判定（ratio < 0.25）
            nodeEl.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rect.left + 5, clientY: rect.top + 1,
            }));
            return (window as any).__calls.slice();
        });

        const importCalls = result.filter((c: any) => c.type === 'notesImportTreeFileAtPosition');
        expect(importCalls.length).toBe(1);
        // 位置引数: (id, outFileId, targetNodeId, position)
        expect(importCalls[0].args[0]).toBe('FILE-77');
        expect(importCalls[0].args[1]).toBe('OUT-1'); // notesFilePanel.getCurrentOutFileId()
        expect(importCalls[0].args[2]).toBe('n1');     // targetNodeId
        expect(importCalls[0].args[3]).toBe('before'); // position（上端付近）
        // tree-md 経路（notesImportMdIntoOut）へは流入しない
        expect(result.filter((c: any) => c.type === 'notesImportMdIntoOut').length).toBe(0);

        // 相互不干渉: tree-md drop は従来どおり notesImportMdIntoOut を呼ぶ（notesImportTreeFileAtPosition は呼ばない）
        const mdResult = await page.evaluate(() => {
            (window as any).__calls.length = 0;
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-md', JSON.stringify({ id: 'MD-9' }));
            nodeEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            return (window as any).__calls.slice();
        });
        expect(mdResult.filter((c: any) => c.type === 'notesImportMdIntoOut').length).toBe(1);
        expect(mdResult.filter((c: any) => c.type === 'notesImportTreeFileAtPosition').length).toBe(0);
    });

    // ---- TC-MX-04 (FR-TF-14 2026-08-10): tree-file / tree-md の node 上 dragover で補助線 + drop 位置 pass-through ----
    // 従来は zone highlight（点線）のみで補助線が出ず、md は rootIds 先頭固定だった。
    // counterfactual: node dragover の indicator 分岐を外すと indicator 不在 = RED /
    //                 handleTreeMdDrop の位置引数を外すと position が undefined = RED。
    test('TC-MX-04 node 上の tree-file/tree-md dragover で補助線表示・md drop は位置引数付きで呼ばれる', async ({ page }) => {
        await loadEnv(page);
        await initOutlinerWithFileNode(page);

        // (a) tree-file dragover → indicator 出現（zone highlight と共存）
        const fileOver = await page.evaluate(() => {
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'FILE-1' }));
            const rect = nodeEl.getBoundingClientRect();
            nodeEl.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rect.left + 5, clientY: rect.top + 1, // 上端 = before 帯
            }));
            return {
                indicator: !!document.querySelector('.outliner-drop-indicator'),
            };
        });
        expect(fileOver.indicator).toBe(true);

        // (b) tree-md dragover → indicator 出現
        const mdOver = await page.evaluate(() => {
            const prev = document.querySelector('.outliner-drop-indicator');
            if (prev) prev.remove();
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-md', JSON.stringify({ id: 'MD-1' }));
            const rect = nodeEl.getBoundingClientRect();
            nodeEl.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rect.left + 5, clientY: rect.top + rect.height / 2, // 中央 = child 帯
            }));
            return { indicator: !!document.querySelector('.outliner-drop-indicator') };
        });
        expect(mdOver.indicator).toBe(true);

        // (c) tree-md drop（上端 = before）→ notesImportMdIntoOut(id, outFileId, targetNodeId, position)
        const mdDrop = await page.evaluate(() => {
            (window as any).__calls.length = 0;
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-md', JSON.stringify({ id: 'MD-9' }));
            const rect = nodeEl.getBoundingClientRect();
            nodeEl.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rect.left + 5, clientY: rect.top + 1,
            }));
            return (window as any).__calls.slice();
        });
        const mdCalls = mdDrop.filter((c: any) => c.type === 'notesImportMdIntoOut');
        expect(mdCalls.length).toBe(1);
        expect(mdCalls[0].args[0]).toBe('MD-9');
        expect(mdCalls[0].args[1]).toBe('OUT-1');
        expect(mdCalls[0].args[2]).toBe('n1');      // targetNodeId（従来は渡らなかった）
        expect(mdCalls[0].args[3]).toBe('before');  // position
    });

    // ---- TC-MX-08 (FR-TF-15 → TASK-05 sprint 20260813-210323 で subpage 方式に更新) ----
    // 旧仕様: ce=false + user-select:none でアンカー全体を掴めた（が、テキスト編集・選択・BS 不能）。
    // 新仕様（許可: test_update・ユーザー要求 = 他リンクとの非対称解消）: subpage と完全同一構造 —
    // 📎 マーカーは DOM に出さず（serialize が復元）、表示アイコンは CSS ::before。テキストは
    // 編集可能、drag は ::before アイコン（テキスト選択・caret 対象外）を掴む（TASK-19 と同一機序）。
    test('TC-MX-08 レンダ済み file アンカーの ::before アイコン起点 real mouse drag → dragstart + x-fractal-md-filelink', async ({ page }) => {
        await loadEnv(page);
        // ::before アイコンは styles.css 由来 — このハーネスは script のみ注入なので
        // 実 CSS を現ソースから注入する（TC-MX-10 の outliner.css 注入と同思想）。
        await page.addStyleTag({ content: r('webview/styles.css') });
        await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container') as HTMLElement;
            mc.style.display = '';
            // eslint-disable-next-line no-new
            new (window as any).EditorInstance(mc, (window as any).outlinerHostBridge, {
                initialContent: '[📎 report.pdf](files/report.pdf)\n\ntail text\n',
                filePath: '/notes/main.md', documentBaseUri: '', sidebarHidden: true,
            });
            (window as any).__dragTypes = null;
            // bubble 段 + editor.js の handler より後に登録 = setData 実行後の types を読む
            document.addEventListener('dragstart', (e: any) => {
                (window as any).__dragTypes = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
            }, false);
        });

        const a = page.locator('.markdown-container .editor a[data-is-file-attachment="true"]');
        await a.waitFor({ state: 'visible' });
        // DOM 契約（subpage と同一構造）: draggable 維持・ce=false 撤去・📎 は DOM テキストに出ない
        expect(await a.getAttribute('draggable')).toBe('true');
        expect(await a.getAttribute('contenteditable')).not.toBe('false');
        expect(await a.textContent()).toBe('report.pdf');

        // real mouse drag（左端 ::before アイコン領域を掴む — subpage と同じ持ち方）
        const box = (await a.boundingBox())!;
        await page.mouse.move(box.x + 5, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 85, box.y + 80, { steps: 5 });
        await page.mouse.move(box.x + 165, box.y + 160, { steps: 5 });
        await page.mouse.up();

        const types = await page.evaluate(() => (window as any).__dragTypes);
        expect(types).not.toBeNull(); // アイコン起点で dragstart が発火（テキスト部分は選択操作になる）
        expect(types).toContain('application/x-fractal-md-filelink');
    });

    // ---- TC-MX-07 (FR-TF-05a code_fix 2026-08-10): position='before' × target=先頭兄弟 → 先頭に入る ----
    // 旧実装は「前兄弟 afterId 計算 + addNode」で、先頭 target のとき afterId=null が addNode の
    // 「null=末尾 append」に化け、「一番上に drop すると一番下に入る」バグ（手動テスト③追報）。
    test('TC-MX-07 dropFilesResult/importMdFilesResult の before が先頭 target で index 0 に入る', async ({ page }) => {
        await loadEnv(page);
        // 兄弟 2 node（n1, n2）— n1 が先頭
        await page.evaluate(() => {
            const data = {
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'first', filePath: null, isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                    n2: { id: 'n2', parentId: null, children: [], text: 'second', filePath: null, isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [] },
                },
            };
            (window as any).Outliner.init(data, 'OUT-KEY-1');
        });

        // dropFilesResult: 先頭 n1 の before に file node
        const afterDrop = await page.evaluate(() => {
            const w = window as any;
            w.__omh({ type: 'dropFilesResult', results: [{ kind: 'file', ok: true, title: 'a.pdf', filePath: 'files/a.pdf' }], targetNodeId: 'n1', position: 'before' });
            return w.Outliner.getModel ? w.Outliner.getModel().rootIds.slice() : (w.__outlinerModel ? w.__outlinerModel.rootIds.slice() : null);
        });
        // 挿入 node が index 0（先頭）に居る（counterfactual: 旧実装だと末尾 = RED）
        expect(afterDrop).not.toBeNull();
        expect(afterDrop.indexOf('n1')).toBe(1); // 新 node が n1 の前 = n1 は 2 番目へ
        expect(afterDrop.indexOf('n2')).toBe(2);

        // importMdFilesResult: 同型 before 分岐
        const afterMd = await page.evaluate(() => {
            const w = window as any;
            w.__omh({ type: 'importMdFilesResult', results: [{ title: 'Doc', pageId: 'pg1' }], targetNodeId: 'n1', position: 'before' });
            return w.Outliner.getModel ? w.Outliner.getModel().rootIds.slice() : null;
        });
        expect(afterMd).not.toBeNull();
        // 2 回目の挿入も n1 より前（rootIds 内で n1 の index が繰り上がる）
        expect(afterMd.indexOf('n1')).toBeGreaterThanOrEqual(2);
        expect(afterMd.indexOf('n2')).toBe(afterMd.length - 1); // n2 は末尾のまま

        // importFilesResult: 3 番目の同型 before 分岐（review iter3 QUAL-1 — 現状 host は after 固定で
        // dead code だが、将来の位置対応で再燃しないよう番人化）
        const afterFiles = await page.evaluate(() => {
            const w = window as any;
            w.__omh({ type: 'importFilesResult', results: [{ title: 'x.pdf', filePath: 'files/x.pdf' }], targetNodeId: 'n1', position: 'before' });
            return w.Outliner.getModel ? w.Outliner.getModel().rootIds.slice() : null;
        });
        expect(afterFiles).not.toBeNull();
        expect(afterFiles.indexOf('n1')).toBeGreaterThanOrEqual(3); // 3 回とも n1 より前に入った
        expect(afterFiles.indexOf('n2')).toBe(afterFiles.length - 1);
    });

    // ---- TC-WV-09: editor x-fractal-tree-file drop -> attachTreeFileToMd (file 単独); 両 MIME 同載 -> attachTreeItemsToMdBatch 1 回 ----
    // TASK-50（reviewer iteration 5 gate・test_update）: §4-2 rev2 で「tree-md + tree-file 同載 = 種別混在の複数選択 →
    // 結合 batch 1 回」が仕様になったため、旧「poison な tree-md を同載しても tree-file 分岐が先行する」counterfactual を撤回。
    // 「tree-md だけの drop が attachTreeFileToMd を呼ばない」ことは TC-WV-08 系（tree-md drop は linkMdAsSubpage 経路）が担保する。
    test('TC-WV-09 editor の x-fractal-tree-file drop: file 単独は targetHost.attachTreeFileToMd(id)（main/sidepanel 両方）・tree-md 同載は attachTreeItemsToMdBatch 1 回で単一 bridge は呼ばない', async ({ page }) => {
        await loadEnv(page);
        await initEditorListeners(page); // document listener を登録

        // 実 instance を捨て、main/sidepanel の 2 fake instance（別 host）を instances に積む
        await page.evaluate(() => {
            const EI = (window as any).EditorInstance;
            EI.instances.length = 0;
            function mk() {
                const c = document.createElement('div');
                const ed = document.createElement('div');
                ed.className = 'editor'; ed.contentEditable = 'true';
                c.appendChild(ed); document.body.appendChild(c);
                return { c: c, ed: ed };
            }
            const m = mk(); const s = mk();
            (window as any).__mainEd = m.ed;
            (window as any).__sideEd = s.ed;
            EI.instances.push({ container: m.c, host: (window as any).__rec((window as any).__mainCalls, {}), options: { filePath: '/notes/main.md' } });
            EI.instances.push({ container: s.c, host: (window as any).__rec((window as any).__sideCalls, {}), options: { filePath: '/notes/side.md' } });
        });

        // (a) main editor へ file 単独 drop → FR-TF-06a の契約（attachTreeFileToMd(id)）
        const mainSingle = await page.evaluate(() => {
            (window as any).__mainCalls.length = 0;
            (window as any).__sideCalls.length = 0;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'F1' }));
            (window as any).__mainEd.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            return { main: (window as any).__mainCalls.slice(), side: (window as any).__sideCalls.slice() };
        });
        const mainAttach = mainSingle.main.filter((c: any) => c.type === 'attachTreeFileToMd');
        expect(mainAttach.length).toBe(1);
        expect(mainAttach[0].args[0]).toBe('F1');
        expect(mainSingle.main.filter((c: any) => c.type === 'linkMdAsSubpage').length).toBe(0);
        expect(mainSingle.main.filter((c: any) => c.type === 'attachTreeItemsToMdBatch').length).toBe(0);
        // sidepanel host は呼ばれない
        expect(mainSingle.side.length).toBe(0);

        // (b) main editor へ tree-file + tree-md **同載** drop → 種別混在 = 結合 batch 1 回（§4-2 rev2）
        const mainMixed = await page.evaluate(() => {
            (window as any).__mainCalls.length = 0;
            (window as any).__sideCalls.length = 0;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'F1', seq: 1 }));
            dt.setData('application/x-fractal-tree-md', JSON.stringify({ filePath: '/notes/x.md', id: 'PM1', seq: 0 }));
            (window as any).__mainEd.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            return { main: (window as any).__mainCalls.slice(), side: (window as any).__sideCalls.slice() };
        });
        const mixedBatch = mainMixed.main.filter((c: any) => c.type === 'attachTreeItemsToMdBatch');
        expect(mixedBatch.length, 'attachTreeItemsToMdBatch は 1 回').toBe(1);
        const items = mixedBatch[0].args[0] as Array<{ kind: string; id: string }>;
        expect(items.map((it) => `${it.kind}:${it.id}`).sort()).toEqual(['file:F1', 'md:PM1']);
        // seq 順（md seq0 → file seq1）で結合される
        expect(items.map((it) => it.id)).toEqual(['PM1', 'F1']);
        // 単一 bridge は呼ばれない（結合 batch に一本化）
        expect(mainMixed.main.filter((c: any) => c.type === 'attachTreeFileToMd').length).toBe(0);
        expect(mainMixed.main.filter((c: any) => c.type === 'linkMdAsSubpage').length).toBe(0);
        expect(mainMixed.side.length).toBe(0);

        // (c) sidepanel editor へ file 単独 drop → sidepanel host の attachTreeFileToMd
        const side = await page.evaluate(() => {
            (window as any).__mainCalls.length = 0;
            (window as any).__sideCalls.length = 0;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'F2' }));
            (window as any).__sideEd.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            return { main: (window as any).__mainCalls.slice(), side: (window as any).__sideCalls.slice() };
        });
        const sideAttach = side.side.filter((c: any) => c.type === 'attachTreeFileToMd');
        expect(sideAttach.length).toBe(1);
        expect(sideAttach[0].args[0]).toBe('F2');
        expect(side.side.filter((c: any) => c.type === 'linkMdAsSubpage').length).toBe(0);
        // main host は呼ばれない
        expect(side.main.length).toBe(0);
    });

    // ---- TC-WV-15: sidepanel は実 SidePanelHostBridge 経由（Proxy fake 禁止の番人） ----
    // TC-WV-09 の fake host は「任意メソッド名に応答する Proxy」なので、SidePanelHostBridge に
    // 委譲メソッドが実在しなくても green になる（generator_failures 2026-08-09 の false-green）。
    // ここでは実クラスに recorder main host を包ませ、typeof ガードが実メソッドで発火することを固定する
    // （counterfactual: SidePanelHostBridge.attachTreeFileToMd を消すとガード false で不発 = RED）。
    test('TC-WV-15 sidepanel drop は実 SidePanelHostBridge の委譲で main host に (id, sidePanelFilePath) が届く', async ({ page }) => {
        await loadEnv(page);
        await initEditorListeners(page);

        // 実 notes-host-bridge.js の outlinerHostBridge ブロックからメソッド名集合を抽出
        //（Notes outliner ページの sidepanel の実 _mainHost 面。TC-RG-02 と同じブロック分割規約）。
        const bridgeSrc = r('shared/notes-host-bridge.js');
        const outStart = bridgeSrc.indexOf('window.outlinerHostBridge = Object.assign');
        const mdStart = bridgeSrc.indexOf('window.notesMarkdownHostBridge = Object.assign');
        const outBlock = bridgeSrc.slice(outStart, mdStart);
        const methodNames = Array.from(outBlock.matchAll(/^\s{8}(\w+): function/gm)).map((m) => (m as any)[1]);
        expect(methodNames).toContain('attachTreeFileToMd'); // 追報①修正の前提（欠けていたら bridge 側が RED）
        await page.evaluate((names) => { (window as any).__outlinerBridgeMethods = names; }, methodNames);

        const res = await page.evaluate(() => {
            const EI = (window as any).EditorInstance;
            EI.instances.length = 0;
            const c = document.createElement('div');
            const ed = document.createElement('div');
            ed.className = 'editor'; ed.contentEditable = 'true';
            c.appendChild(ed); document.body.appendChild(c);
            // §4m 是正（再オープン⑤）: _mainHost は Proxy recorder でなく「実 notes-host-bridge.js の
            // outlinerHostBridge ブロックから抽出したメソッド名集合を持つ明示 stub」にする。
            // Proxy は任意メソッド名に応答するため第 2 ホップ（実 bridge ブロックのメソッド欠落 =
            // 追報①の根本原因）を検証できなかった。存在しないメソッドは undefined を返し
            // typeof ガードの発火（silent no-op）を実挙動どおり再現する。
            const calls: any[] = [];
            const methodNames: string[] = (window as any).__outlinerBridgeMethods;
            const mainHost: any = {};
            for (const m of methodNames) {
                mainHost[m] = function (...args: any[]) { calls.push({ type: m, args }); };
            }
            const SPB = (window as any).SidePanelHostBridge;
            const bridge = new SPB(mainHost, '/notes/side.md', {});
            EI.instances.push({ container: c, host: bridge, options: { filePath: '/notes/side.md' } });

            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'F9' }));
            ed.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            return {
                hasMethod: typeof bridge.attachTreeFileToMd === 'function',
                calls: calls.slice(),
            };
        });
        // 委譲メソッドが実在する（typeof ガードが発火する前提そのもの）
        expect(res.hasMethod).toBe(true);
        // main host へ (id, sidepanel の filePath) で委譲される
        const attach = res.calls.filter((c: any) => c.type === 'attachTreeFileToMd');
        expect(attach.length).toBe(1);
        expect(attach[0].args[0]).toBe('F9');
        expect(attach[0].args[1]).toBe('/notes/side.md');
    });

    // ---- TC-WV-10: dragstart new state cleared on dragend (per-file counterfactual) ----
    test('TC-WV-10 outliner 📎 / editor file アンカーの dragstart 新 state が dragend で clear される', async ({ page }) => {
        await loadEnv(page);
        await initOutlinerWithFileNode(page);
        await initEditorListeners(page);

        // (a) outliner 📎: dragstart で state 付与 → dragend で clear
        const outliner = await page.evaluate(() => {
            const icon = document.querySelector('.outliner-file-icon') as HTMLElement;
            const dt1 = new DataTransfer();
            icon.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt1 }));
            const afterStart = icon.classList.contains('outliner-file-icon-dragging');
            const dt2 = new DataTransfer();
            icon.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
            const afterEnd = icon.classList.contains('outliner-file-icon-dragging');
            return { afterStart, afterEnd };
        });
        expect(outliner.afterStart).toBe(true);  // dragstart で state ON
        expect(outliner.afterEnd).toBe(false);   // dragend で clear（counterfactual: clear を外すと true = RED）

        // (b) editor file アンカー: dragstart で state 付与 → dragend で clear
        const editor = await page.evaluate(() => {
            const ed = document.querySelector('.markdown-container .editor') as HTMLElement;
            ed.innerHTML = '<a id="fA" href="files/a.pdf" data-markdown-path="files/a.pdf" data-is-file-attachment="true">📎 a.pdf</a>';
            const a = document.getElementById('fA') as HTMLElement;
            const dt1 = new DataTransfer();
            a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt1 }));
            const afterStart = a.classList.contains('dragging-file-attachment');
            const dt2 = new DataTransfer();
            a.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
            const afterEnd = a.classList.contains('dragging-file-attachment');
            return { afterStart, afterEnd };
        });
        expect(editor.afterStart).toBe(true);
        expect(editor.afterEnd).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════
    // 再オープン④ (2026-08-10 rc.1 検証起因): 表示バグ 2 件（TC-MX-09/10）
    // ═══════════════════════════════════════════════════════════════════

    // ---- TC-MX-09: md editor drag cursor — 余白 dragover でエディタ端の全高バーにならない ----
    // 機序: showDragCursor の fallback で elementFromPoint が editor 自体（コンテンツ外の余白）を
    // 返すと、旧実装は editorRect.left+5 に editor 全高のバーを描いた（pointer から数百 px 乖離）。
    test('TC-MX-09 editor 余白への dragover で drag cursor がマウス位置近傍に出る（端の全高バー化しない）', async ({ page }) => {
        await loadEnv(page);
        await initOutlinerWithFileNode(page);
        await initEditorListeners(page);

        const r = await page.evaluate(() => {
            const mc = document.querySelector('.markdown-container') as HTMLElement;
            const editorEl = mc.querySelector('.editor') as HTMLElement;
            // 実環境の症状幾何を再現: ce=false inline 要素の行 + 大きな padding。
            // ※ file アンカー自体は TASK-05 (sprint 20260813-210323) で ce=true 化されたが、
            //    この fixture の ce=false は「caretRangeFromPoint が高さ 0 の element offset に
            //    落ちる幾何」を合成する装置（code block header 等の ce=false inline で今も実在）。
            // アンカー行の padding 域では caretRangeFromPoint が P の element offset に落ちて
            // 高さ 0 の rect を返し（最初の repro grid で実測）、elementFromPoint は editor 自体
            // （padding は editor の box）→ 旧実装の「editor rect 基準の全高バー」分岐に入る。
            mc.style.position = 'fixed';
            (mc.style as any).inset = '0';
            mc.style.zIndex = '99999';
            mc.style.background = '#fff';
            editorEl.innerHTML =
                '<p>first</p>' +
                '<p><a href="files/x.docx" data-is-file-attachment="true" contenteditable="false" draggable="true">📎 attachment anchor text</a></p>' +
                '<p>last</p>';
            editorEl.style.minHeight = '600px';
            editorEl.style.padding = '40px 120px';
            const anchor = editorEl.querySelector('a') as HTMLElement;
            const ar = anchor.getBoundingClientRect();
            const er = editorEl.getBoundingClientRect();
            // アンカー行の左 padding 域（editor 直 hit + caret 高 0 の点）を確認しつつ使う
            const x = er.left + 30, y = ar.top + ar.height / 2;
            const probeEl = document.elementFromPoint(x, y);
            const rg = (document as any).caretRangeFromPoint(x, y);
            const rgH = rg ? rg.getBoundingClientRect().height : -1;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'F1' }));
            editorEl.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
            }));
            const cursor = document.querySelector('.drag-cursor') as HTMLElement;
            const out: any = { probeIsEditor: probeEl === editorEl, rgH, x, y, visible: false };
            if (cursor && cursor.style.display !== 'none') {
                out.visible = true;
                out.left = parseFloat(cursor.style.left);
                out.top = parseFloat(cursor.style.top);
                out.height = parseFloat(cursor.style.height);
            }
            editorEl.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
            return out;
        });

        expect(r.probeIsEditor).toBe(true);  // setup: elementFromPoint = editor 自体（padding 域）
        expect(r.rgH).toBe(0);               // setup: caret rect 高 0 = fallback 分岐に入る条件
        expect(r.visible).toBe(true);
        // counterfactual: 旧実装だと left = editorRect.left+5 で height = editor 全高（600px 級）
        expect(Math.abs(r.left - r.x)).toBeLessThan(30);   // マウス位置近傍
        expect(Math.abs(r.top - r.y)).toBeLessThan(30);
        expect(r.height).toBeLessThanOrEqual(30);           // 全高バー化しない
    });

    // ---- TC-MX-10: outliner 受理点線 × is-focused — focus 行でも点線が描画される ----
    // 機序: 要素 outline (offset -2px) は CSS paint order で子要素背景（is-focused の水色 =
    // tree box と同幅）より先に描かれ、focus 行だけ点線が上塗りされて消えていた。
    test('TC-MX-10 受理点線が is-focused 行の左端でも見える（::after オーバーレイ化）', async ({ page }) => {
        await loadEnv(page);
        await initOutlinerWithFileNode(page);
        // このハーネスは script のみ注入で CSS を読まない — 点線/背景の pixel 検証には
        // 実 CSS（outliner.css）が必要なので現ソースから注入する（addScriptTag と同思想）。
        await page.addStyleTag({ content: r('webview/outliner.css') });
        // 実環境の theme token を再現: is-focused は不透明 water-blue（fr-base の
        // --fr-color-selection-bg）。ハーネス素の fallback は rgba(0,120,212,0.15) の半透明で
        // 点線が透けてしまい、counterfactual（旧 outline 方式で点線消失 = RED）が成立しない。
        await page.addStyleTag({ content: ':root { --fr-color-selection-bg: #deedf5; }' });

        const box = await page.evaluate(() => {
            const tree = document.querySelector('.outliner-tree') as HTMLElement;
            const node = document.querySelector('.outliner-node') as HTMLElement;
            tree.classList.add('outliner-tree-drop-zone-active');
            node.classList.add('is-focused');
            const tr = tree.getBoundingClientRect();
            const nr = node.getBoundingClientRect();
            return { treeLeft: tr.left, treeRight: tr.right, nodeLeft: nr.left, nodeRight: nr.right,
                     nodeBg: getComputedStyle(node).backgroundColor, rowTop: nr.top, rowH: nr.height };
        });

        // focus 行の左端帯（点線が走るべき x = treeLeft..treeLeft+2）を screenshot して
        // 点線ピクセル（青系 #007acc = rgb(0,122,204)）の実在を検証
        const clipY = Math.max(0, box.rowTop + 2);
        const shot = await page.screenshot({
            clip: { x: Math.max(0, box.treeLeft - 1), y: clipY, width: 6, height: Math.max(8, box.rowH - 4) },
        });
        // PNG を raw decode せず、page 側で canvas に読み戻して画素検査
        const hasBlue = await page.evaluate(async (b64) => {
            const img = new Image();
            await new Promise<void>((res, rej) => {
                img.onload = () => res(); img.onerror = () => rej(new Error('img load'));
                img.src = 'data:image/png;base64,' + b64;
            });
            const cv = document.createElement('canvas');
            cv.width = img.width; cv.height = img.height;
            const ctx = cv.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
            for (let i = 0; i < px.length; i += 4) {
                const r = px[i], g = px[i + 1], b = px[i + 2];
                // 点線色 var(--vscode-focusBorder, #007acc) 近傍（青が強く赤が弱い）
                if (b > 150 && b - r > 60 && g < 180) return true;
            }
            return false;
        }, shot.toString('base64'));

        // counterfactual: 要素 outline 方式に戻すと is-focused の水色が点線を上塗りして false = RED
        expect(hasBlue).toBe(true);
    });


    // ═══════════════════════════════════════════════════════════════════
    // 再オープン⑤ (2026-08-10): FR-TF-19 md editor drop 受け 4 MIME（TC-CN-02/03/05）
    // ═══════════════════════════════════════════════════════════════════

    // main editor へ drop して targetHost の新メソッドが正しい payload で呼ばれることを検証する共通形
    async function dropOnMainEditor(page: Page, mime: string, payload: any): Promise<any[]> {
        return await page.evaluate(({ m, p }) => {
            const w = window as any;
            w.__calls.length = 0;
            const mc = document.querySelector('.markdown-container') as HTMLElement;
            const ed = mc.querySelector('.editor') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData(m, JSON.stringify(p));
            ed.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            return w.__calls.slice();
        }, { m: mime, p: payload });
    }

    test('TC-CN-02 out-node-file → md editor drop で attachOutNodeFileToMd が呼ばれる', async ({ page }) => {
        await loadEnv(page);
        await initEditorListeners(page);
        const calls = await dropOnMainEditor(page, 'application/x-fractal-out-node-file', { outFileKey: '/n/a.out', nodeId: 'n1' });
        const hit = calls.filter((c: any) => c.type === 'attachOutNodeFileToMd');
        expect(hit.length).toBe(1);
        expect(hit[0].args[0]).toEqual({ outFileKey: '/n/a.out', nodeId: 'n1' });
    });

    test('TC-CN-03 out-node-page → md editor drop で importOutPageNodeToMd が呼ばれる', async ({ page }) => {
        await loadEnv(page);
        await initEditorListeners(page);
        const calls = await dropOnMainEditor(page, 'application/x-fractal-out-node-page', { outFileKey: '/n/a.out', nodeId: 'n1', pageId: 'p1', title: 'T' });
        const hit = calls.filter((c: any) => c.type === 'importOutPageNodeToMd');
        expect(hit.length).toBe(1);
        expect(hit[0].args[0].pageId).toBe('p1');
    });

    test('TC-CN-05 md-filelink / md-subpage → md editor drop + self-drop no-op', async ({ page }) => {
        await loadEnv(page);
        await initEditorListeners(page);
        // (a) 別 md からの filelink → attachMdFileLinkToMd
        const a = await dropOnMainEditor(page, 'application/x-fractal-md-filelink', { href: 'files/x.pdf', sourceMdPath: '/other/src.md' });
        expect(a.filter((c: any) => c.type === 'attachMdFileLinkToMd').length).toBe(1);
        // (b) 別 md からの subpage → linkMdSubpageToMd
        const b = await dropOnMainEditor(page, 'application/x-fractal-md-subpage', { href: 'sub.md', sourceMdPath: '/other/src.md', title: 'Sub' });
        expect(b.filter((c: any) => c.type === 'linkMdSubpageToMd').length).toBe(1);
        // (c) self-drop（sourceMdPath === 対象 md = /notes/main.md）→ no-op（counterfactual: ガードを外すと発火 = RED）
        const c = await dropOnMainEditor(page, 'application/x-fractal-md-filelink', { href: 'files/x.pdf', sourceMdPath: '/notes/main.md' });
        expect(c.filter((x: any) => x.type === 'attachMdFileLinkToMd').length).toBe(0);
        const d = await dropOnMainEditor(page, 'application/x-fractal-md-subpage', { href: 'sub.md', sourceMdPath: '/notes/main.md', title: 'Sub' });
        expect(d.filter((x: any) => x.type === 'linkMdSubpageToMd').length).toBe(0);
    });


    // ═══════════════════════════════════════════════════════════════════
    // 再オープン⑤ (2026-08-10): FR-TF-20 outliner drop 受け 2 MIME（TC-CN-04）
    // ═══════════════════════════════════════════════════════════════════

    test('TC-CN-04 md-filelink / md-subpage → outliner: dragover 受理 + 補助線 + drop で host 呼び出し', async ({ page }) => {
        await loadEnv(page);
        await initOutlinerWithFileNode(page);

        const r = await page.evaluate(() => {
            const w = window as any;
            const out: any = {};
            const nodeEl = document.querySelector('.outliner-node') as HTMLElement;
            const rect = nodeEl.getBoundingClientRect();

            const drive = (mime: string, payload: any) => {
                w.__calls.length = 0;
                const dt = new DataTransfer();
                dt.setData(mime, JSON.stringify(payload));
                // dragover: 受理（preventDefault）+ 補助線
                const ov = new DragEvent('dragover', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                    clientX: rect.left + 5, clientY: rect.top + 1, // before 帯
                });
                nodeEl.dispatchEvent(ov);
                const accepted = ov.defaultPrevented;
                const indicator = !!document.querySelector('.outliner-drop-indicator');
                // drop
                nodeEl.dispatchEvent(new DragEvent('drop', {
                    bubbles: true, cancelable: true, dataTransfer: dt,
                    clientX: rect.left + 5, clientY: rect.top + 1,
                }));
                return { accepted, indicator, calls: w.__calls.slice() };
            };

            out.filelink = drive('application/x-fractal-md-filelink', { href: 'files/x.pdf', sourceMdPath: '/n/src.md' });
            out.subpage = drive('application/x-fractal-md-subpage', { href: 'sub.md', sourceMdPath: '/n/src.md', title: 'Sub' });
            return out;
        });

        // counterfactual: dragover 配線を外すと accepted=false で drop 不発 = RED
        expect(r.filelink.accepted).toBe(true);
        expect(r.filelink.indicator).toBe(true);
        const fl = r.filelink.calls.filter((c: any) => c.type === 'importMdFileLinkIntoOut');
        expect(fl.length).toBe(1);
        expect(fl[0].args[0]).toEqual({ href: 'files/x.pdf', sourceMdPath: '/n/src.md' });
        expect(fl[0].args[1]).toBe('OUT-1');   // outFileId
        expect(fl[0].args[2]).toBe('n1');      // targetNodeId
        expect(fl[0].args[3]).toBe('before');  // position

        expect(r.subpage.accepted).toBe(true);
        const sp = r.subpage.calls.filter((c: any) => c.type === 'importMdSubpageIntoOut');
        expect(sp.length).toBe(1);
        expect(sp[0].args[0].href).toBe('sub.md');
        expect(sp[0].args[3]).toBe('before');
    });


    test('TC-CN-11(SYSALIGN-1): sidepanel drop で新 4 メソッドが SidePanelHostBridge 第 2 ホップ経由で届く', async ({ page }) => {
        await loadEnv(page);
        await initEditorListeners(page);
        // TC-WV-15 と同じ「実 bridge ブロック抽出の明示 stub」で第 2 ホップを実面検証
        const bridgeSrc = r('shared/notes-host-bridge.js');
        const outStart = bridgeSrc.indexOf('window.outlinerHostBridge = Object.assign');
        const mdStart = bridgeSrc.indexOf('window.notesMarkdownHostBridge = Object.assign');
        const outBlock = bridgeSrc.slice(outStart, mdStart);
        const methodNames = Array.from(outBlock.matchAll(/^\s{8}(\w+): function/gm)).map((m) => (m as any)[1]);
        for (const m of ['attachOutNodeFileToMd', 'importOutPageNodeToMd', 'attachMdFileLinkToMd', 'linkMdSubpageToMd']) {
            expect(methodNames).toContain(m); // bridge 側の実在（欠けたら追報①クラス）
        }
        await page.evaluate((names) => { (window as any).__outlinerBridgeMethods = names; }, methodNames);

        const res = await page.evaluate(() => {
            const EI = (window as any).EditorInstance;
            EI.instances.length = 0;
            const c = document.createElement('div');
            const ed = document.createElement('div');
            ed.className = 'editor'; ed.contentEditable = 'true';
            c.appendChild(ed); document.body.appendChild(c);
            const calls: any[] = [];
            const methodNames2: string[] = (window as any).__outlinerBridgeMethods;
            const mainHost: any = {};
            for (const m of methodNames2) { mainHost[m] = function (...args: any[]) { calls.push({ type: m, args }); }; }
            const SPB = (window as any).SidePanelHostBridge;
            const bridge = new SPB(mainHost, '/notes/side.md', {});
            EI.instances.push({ container: c, host: bridge, options: { filePath: '/notes/side.md' } });

            const drive = (mime: string, payload: any) => {
                const dt = new DataTransfer();
                dt.setData(mime, JSON.stringify(payload));
                ed.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            };
            drive('application/x-fractal-out-node-file', { outFileKey: '/n/a.out', nodeId: 'n1' });
            drive('application/x-fractal-out-node-page', { outFileKey: '/n/a.out', nodeId: 'n1', pageId: 'p1' });
            drive('application/x-fractal-md-filelink', { href: 'files/x.pdf', sourceMdPath: '/other/src.md' });
            drive('application/x-fractal-md-subpage', { href: 'sub.md', sourceMdPath: '/other/src.md' });
            return calls;
        });

        // 4 メソッドとも第 2 引数 = sidepanel の filePath で mainHost に届く
        for (const m of ['attachOutNodeFileToMd', 'importOutPageNodeToMd', 'attachMdFileLinkToMd', 'linkMdSubpageToMd']) {
            const hit = res.filter((c: any) => c.type === m);
            expect(hit.length, `${m} が第 2 ホップに届かない`).toBe(1);
            expect(hit[0].args[1]).toBe('/notes/side.md');
        }
    });

});
