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
 *   - TC-WV-09 (FR-TF-06a 受信側): editor に x-fractal-tree-file の drop で targetHost.attachTreeFileToMd(id)。
 *       main / sidepanel の targetHost 選択を両方踏む + 既存 tree-md 分岐（linkMdAsSubpage）に流入しない
 *       （counterfactual: 同 DataTransfer に poison な x-fractal-tree-md を積み、tree-file 分岐を外すと
 *        linkMdAsSubpage へ誤流入 = RED）。
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
            const fa = anchors.find(a => (a.textContent || '').indexOf('📎') === 0) as HTMLElement | undefined;
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

    // ---- TC-WV-09: editor x-fractal-tree-file drop -> attachTreeFileToMd; main/sidepanel both; not linkMdAsSubpage ----
    test('TC-WV-09 editor の x-fractal-tree-file drop が targetHost.attachTreeFileToMd(id) を呼ぶ・main/sidepanel 両方・linkMdAsSubpage へ流入しない', async ({ page }) => {
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

        // main editor へ drop（同 DataTransfer に poison な tree-md を積む = counterfactual）
        const main = await page.evaluate(() => {
            (window as any).__mainCalls.length = 0;
            (window as any).__sideCalls.length = 0;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-tree-file', JSON.stringify({ id: 'F1' }));
            dt.setData('application/x-fractal-tree-md', JSON.stringify({ filePath: '/poison/x.md', id: 'PM1' }));
            (window as any).__mainEd.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 5, clientY: 5 }));
            return { main: (window as any).__mainCalls.slice(), side: (window as any).__sideCalls.slice() };
        });
        const mainAttach = main.main.filter((c: any) => c.type === 'attachTreeFileToMd');
        expect(mainAttach.length).toBe(1);
        expect(mainAttach[0].args[0]).toBe('F1');
        // counterfactual: tree-file 分岐が正しく先行し return するので linkMdAsSubpage は呼ばれない
        expect(main.main.filter((c: any) => c.type === 'linkMdAsSubpage').length).toBe(0);
        // sidepanel host は呼ばれない
        expect(main.side.length).toBe(0);

        // sidepanel editor へ drop
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

        const res = await page.evaluate(() => {
            const EI = (window as any).EditorInstance;
            EI.instances.length = 0;
            const c = document.createElement('div');
            const ed = document.createElement('div');
            ed.className = 'editor'; ed.contentEditable = 'true';
            c.appendChild(ed); document.body.appendChild(c);
            // 実クラス: recorder main host を包む（メソッド集合は実装どおり = Proxy fake でない）
            const calls: any[] = [];
            const mainHost = (window as any).__rec(calls, {});
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
});
