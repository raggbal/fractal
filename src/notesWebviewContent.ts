import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getNonce } from './webviewContent';

interface NotesConfig {
    theme: string;
    fontSize: number;
    toolbarMode?: string;
    webviewMessages?: Record<string, string>;
    enableDebugLogging?: boolean;
    outlinerPageTitle?: boolean;
    documentBaseUri?: string;
    folderName?: string;
    showTranslateButtons?: boolean;
    imageMaxWidth?: number;
}

interface NotesInitData {
    jsonContent: string;
    fileList: Array<{ filePath: string; title: string; id: string }>;
    currentFilePath: string | null;
    panelCollapsed: boolean;
    structure?: any;
    panelWidth?: number;
    noteSidePanelWidth?: number;
    noteSidePanelOutlineWidth?: number;
    fileChangeId?: number;
    /** FR-NT-01: note フォルダ名 (noteTitle 未設定時の既定表示) */
    noteFolderName?: string;
    /** FR-HP: 最近開いたファイル履歴 + パネル状態 */
    history?: Array<{ kind: string; id: string; title: string; ts: number }>;
    historyPanelHeight?: number;
    historyPanelCollapsed?: boolean;
}

export function getNotesWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    config: NotesConfig,
    initData: NotesInitData
): string {
    const nonce = getNonce();
    const msg = config.webviewMessages || {};

    // Load CSS
    // Minimal redesign foundation (sprint 20260509-185557): tokens.css / fr-base.css / fr-components.css
    // Inject BEFORE editor styles / outliner css so existing rules can reference --fr-* variables.
    const tokensCssPath = path.join(__dirname, 'webview', 'tokens.css');
    const tokensCss = fs.existsSync(tokensCssPath) ? fs.readFileSync(tokensCssPath, 'utf8') : '';
    const frBaseCssPath = path.join(__dirname, 'webview', 'fr-base.css');
    const frBaseCss = fs.existsSync(frBaseCssPath) ? fs.readFileSync(frBaseCssPath, 'utf8') : '';
    const frComponentsCssPath = path.join(__dirname, 'webview', 'fr-components.css');
    const frComponentsCss = fs.existsSync(frComponentsCssPath) ? fs.readFileSync(frComponentsCssPath, 'utf8') : '';

    const outlinerCssPath = path.join(__dirname, 'webview', 'outliner.css');
    const outlinerCss = fs.readFileSync(outlinerCssPath, 'utf8')
        .replace('__FONT_SIZE__', String(config.fontSize));

    const stylesPath = path.join(__dirname, 'webview', 'styles.css');
    const editorStyles = fs.readFileSync(stylesPath, 'utf8')
        .replace('__FONT_SIZE__', String(config.fontSize));

    // Load Notes shared CSS/HTML
    const notesBodyHtml = require(path.join(__dirname, 'shared', 'notes-body-html.js'));
    const { css: notesCss, html: notesHtml } = notesBodyHtml.generateNotesFilePanelHtml({
        collapsed: initData.panelCollapsed,
        messages: config.webviewMessages || {},
    });

    // Load Notes color palette (must load before notes-file-panel.js)
    const notesColorPaletteScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'notes-color-palette.js'), 'utf8');

    // Load Notes file panel JS
    const notesFilePanelScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'notes-file-panel.js'), 'utf8');

    // Load shared markdown link parser (used by outliner.js and editor.js)
    const linkParserScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'markdown-link-parser.js'), 'utf8');

    // Load clip-source selector (paste 時のクリップボード源判定, outliner.js の前に注入)
    const clipSelectScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-clip-select.js'), 'utf8');

    // Load HostBridge (shared + notes)
    const sidePanelBridgeScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'sidepanel-bridge-methods.js'), 'utf8');
    const notesHostBridgeScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'notes-host-bridge.js'), 'utf8');
    // FR-LR-03: md メインペイン dispatcher（externalUpdate in-place 対応）
    const notesMdDispatcherScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'notes-md-dispatcher.js'), 'utf8');
    // FR-HP: 最近開いたファイル履歴パネル
    const notesHistoryPanelScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'notes-history-panel.js'), 'utf8');

    // Load outliner scripts
    const outlinerCellScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-cell.js'), 'utf8');
    const outlinerModelScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-model.js'), 'utf8');
    const outlinerSearchScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-search.js'), 'utf8');
    const outlinerScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner.js'), 'utf8');

    // Load editor scripts (for side panel EditorInstance)
    const editorUtilsScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'editor-utils.js'), 'utf8');
    const editorScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'editor.js'), 'utf8')
        .replace('__DEBUG_MODE__', String(config.enableDebugLogging ?? false))
        .replace('__I18N__', JSON.stringify(msg))
        .replace('__DOCUMENT_BASE_URI__', '')
        .replace('__IS_OUTLINER_PAGE__', 'true')
        .replace('__CONTENT__', `'(unused)'`);

    // Vendor library URIs
    const vendorDir = path.join(__dirname, '..', 'vendor');
    const vendorUri = (file: string) => webview.asWebviewUri(
        vscode.Uri.file(path.join(vendorDir, file))
    );
    // v0.207.50: html-md-converter bundle で turndown + GFM + Fractal rule を統合
    const htmlMdConverterScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'html-md-converter.js'), 'utf8');
    const mermaidUri = vendorUri('mermaid.min.js');
    const katexJsUri = vendorUri('katex.min.js');
    const katexCssUri = vendorUri('katex.min.css');
    // Mindmap Mode (sprint 20260701-122355): d3 layout engine + mindmap scripts/css.
    // Notes mode uses this generator (NOT outlinerWebviewContent.ts) — must inject here too
    // for 4-mode coverage (Hard MUST). See design-review #H3.
    const d3HierarchyUri = vendorUri('d3-hierarchy.min.js');
    const d3FlextreeUri = vendorUri('d3-flextree.min.js');
    const mindmapModelScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-model.js'), 'utf8');
    const mindmapLayoutScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-layout.js'), 'utf8');
    const mindmapRenderScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-render.js'), 'utf8');
    const mindmapExportScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-export.js'), 'utf8');
    const mindmapInteractionsScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-interactions.js'), 'utf8');
    const mindmapCssPath = path.join(__dirname, 'webview', 'mindmap.css');
    const mindmapCss = fs.existsSync(mindmapCssPath) ? fs.readFileSync(mindmapCssPath, 'utf8') : '';

    // Base64 encode JSON content
    const jsonToEncode = initData.jsonContent || '{"version":1,"rootIds":[],"nodes":{}}';
    const base64Content = Buffer.from(jsonToEncode, 'utf8').toString('base64');

    // Side panel HTML (shared with all editors)
    const { generateSidePanelHtml, generateEditorBodyHtml } = require(path.join(__dirname, 'shared', 'editor-body-html.js'));
    const sidePanelHtml = generateSidePanelHtml(msg);
    // ADR-008: Notes 内 .md 用メインペイン (standalone と同じ body HTML)。
    // ただし side-panel は notes-layout 側で別途出力するため、ここでは含めない
    // (DOM 内 `.side-panel` 重複を避けるため。outliner.js が
    // `document.querySelector('.side-panel')` で最初の要素を掴む仕様のため、
    // 重複すると markdown-container 内側の hidden パネルを掴んでしまう)
    const markdownPaneHtml = generateEditorBodyHtml(msg, process.platform, { includeSidePanel: false, showOpenInNewTab: true, showNotesPanelToggle: true });

    return `<!DOCTYPE html>
<html lang="en" data-theme="${config.theme}" data-fr-theme="${config.theme}" data-toolbar-mode="${config.toolbarMode || 'full'}" data-show-translate-buttons="${String(config.showTranslateButtons ?? false)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: http: data: file:; font-src ${webview.cspSource} https: https://fonts.gstatic.com data:; frame-src blob:;">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap">
    <title>Fractal Notes</title>
    <style>${tokensCss}</style>
    <style>${frBaseCss}</style>
    <style>${frComponentsCss}</style>
    <style>${editorStyles}</style>
    <style>${outlinerCss}</style>
    <style>${mindmapCss}</style>
    <link rel="stylesheet" href="${katexCssUri}">
    <style>${notesCss}</style>
    <style>:root { --image-max-width: ${typeof (config as any).imageMaxWidth === 'number' && (config as any).imageMaxWidth >= 100 ? (config as any).imageMaxWidth : 600}px; }</style>
</head>
<body>
    <!-- 左サイドパネル S3 sync（notes 全体 sync）中の進捗 overlay -->
    <div class="outliner-s3-sync-overlay" role="status" aria-live="polite">
        <div class="outliner-s3-sync-overlay-spinner"></div>
        <p class="outliner-s3-sync-overlay-title">Syncing with S3…</p>
        <p class="outliner-s3-sync-overlay-phase">Preparing…</p>
        <p class="outliner-s3-sync-overlay-hint">Editor is locked during sync. Please wait.</p>
    </div>
    <div class="notes-layout" data-note-folder-name="${config.folderName || ''}">
        ${notesHtml}
        <div class="notes-main-wrapper">
            <div class="outliner-container">
                <div class="outliner-scroll-content">
                    <div class="outliner-page-title" style="${config.outlinerPageTitle ? '' : 'display:none;'}">
                        <input type="text" class="outliner-page-title-input" placeholder="Untitled" />
                    </div>
                    <div class="outliner-scope-search-indicator" style="display:none"><span class="outliner-scope-search-tag"></span></div>
                    <div class="outliner-search-bar">
                        <button class="notes-panel-toggle-btn" id="notesPanelToggleBtn" title="Show file panel (Cmd+\\)">&#9776;</button>
                        <div class="outliner-daily-nav-area" style="display:none">
                            <button class="outliner-daily-btn" id="dailyNavToday">Today</button>
                            <button class="outliner-daily-btn outliner-daily-btn-sm" id="dailyNavPrev">&lt;</button>
                            <button class="outliner-daily-btn outliner-daily-btn-sm" id="dailyNavNext">&gt;</button>
                            <button class="outliner-daily-btn outliner-daily-btn-sm" id="dailyNavCalendar"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="16" height="16" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></button>
                            <div class="outliner-daily-picker" id="dailyNavPicker" style="display:none">
                                <div class="outliner-daily-picker-header">
                                    <button class="outliner-daily-picker-nav" id="dailyPickerPrevMonth">&lt;</button>
                                    <span class="outliner-daily-picker-title" id="dailyPickerTitle"></span>
                                    <button class="outliner-daily-picker-nav" id="dailyPickerNextMonth">&gt;</button>
                                </div>
                                <div class="outliner-daily-picker-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
                                <div class="outliner-daily-picker-grid" id="dailyPickerGrid"></div>
                            </div>
                        </div>
                        <button class="outliner-nav-back-btn" title="Back" disabled><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
                        <button class="outliner-nav-forward-btn" title="Forward" disabled><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
                        <button class="outliner-search-mode-toggle" title="Toggle search mode: Tree / Focus"></button>
                        <div class="outliner-search-input-wrapper"><input type="text" class="outliner-search-input" placeholder="Search... (e.g. #tag, keyword, is:page)" /><button class="outliner-search-clear-btn" style="display:none" title="Clear search"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button><div class="outliner-tag-suggest-bar" style="display:none"></div></div>
                        <button class="outliner-undo-btn" title="Undo (Cmd+Z)" disabled></button>
                        <button class="outliner-redo-btn" title="Redo (Cmd+Shift+Z)" disabled></button>
                        <button class="outliner-view-toggle-btn" title="Switch view (Outline / Table)"></button>
                        <button class="outliner-task-mode-toggle-btn" title="Task Mode"></button>
                        <button class="outliner-task-filter-toggle-btn" title="Filter: Active / All"></button>
                        <button class="outliner-archive-btn" title="Archive completed tasks"></button>
                        <button class="outliner-menu-btn" title="Menu"></button>
                    </div>
                    <div class="outliner-breadcrumb"></div>
                    <div class="outliner-tree" role="tree"></div>
                </div>
                <div class="fractal-resource-footer" style="display:none" data-rrf-template="${msg.resourceAccessOutOfRangeCount || '{count} image(s) are outside the allowed folders and cannot be shown (e.g. {sample}).'}">
                    <span class="rrf-msg">${msg.resourceAccessOutOfRange || 'Some images are outside the allowed folders and cannot be shown.'}</span>
                    <button class="rrf-open-settings" data-action="openResourceRootsSettings">${msg.resourceAccessOpenSettings || 'Change allowed folders'}</button>
                </div>
            </div>
            <div class="markdown-container" style="display:none">
                ${markdownPaneHtml}
            </div>
        </div>
    </div>

    ${sidePanelHtml}

    <script nonce="${nonce}">${htmlMdConverterScript}</script>
    <script src="${mermaidUri}" nonce="${nonce}"></script>
    <script src="${katexJsUri}" nonce="${nonce}"></script>
    <script src="${d3HierarchyUri}" nonce="${nonce}"></script>
    <script src="${d3FlextreeUri}" nonce="${nonce}"></script>

    <script nonce="${nonce}">
        window.__SKIP_EDITOR_AUTO_INIT__ = true;
        window.__outlinerMessages = ${JSON.stringify(config.webviewMessages || {})};
        window.__outlinerImageBaseUri = "${config.documentBaseUri || ''}";
        window.__initialFileChangeId = ${initData.fileChangeId || 0};
        window.__noteSidePanelWidth = ${JSON.stringify(initData.noteSidePanelWidth ?? null)};
        window.__noteSidePanelOutlineWidth = ${JSON.stringify(initData.noteSidePanelOutlineWidth ?? null)};
    </script>
    <script nonce="${nonce}">${linkParserScript}</script>
    <script nonce="${nonce}">${sidePanelBridgeScript}</script>
    <script nonce="${nonce}">${notesHostBridgeScript}</script>
    <script nonce="${nonce}">${editorUtilsScript}</script>
    <script nonce="${nonce}">${editorScript}</script>
    <script nonce="${nonce}">${outlinerCellScript}</script>
    <script nonce="${nonce}">${outlinerModelScript}</script>
    <script nonce="${nonce}">${mindmapModelScript}</script>
    <script nonce="${nonce}">${mindmapLayoutScript}</script>
    <script nonce="${nonce}">${mindmapRenderScript}</script>
    <script nonce="${nonce}">${mindmapExportScript}</script>
    <script nonce="${nonce}">${mindmapInteractionsScript}</script>
    <script nonce="${nonce}">${outlinerSearchScript}</script>
    <script nonce="${nonce}">${clipSelectScript}</script>
    <script nonce="${nonce}">${outlinerScript}</script>
    <script nonce="${nonce}">${notesColorPaletteScript}</script>
    <script nonce="${nonce}">${notesFilePanelScript}</script>
    <script nonce="${nonce}">${notesMdDispatcherScript}</script>
    <script nonce="${nonce}">${notesHistoryPanelScript}</script>
    <script nonce="${nonce}">
        try {
            var initialData = JSON.parse(decodeURIComponent(escape(atob('${base64Content}'))));
            Outliner.init(initialData, ${JSON.stringify(initData.currentFilePath)});
        } catch(e) {
            console.error('[Notes] Failed to initialize outliner:', e);
            Outliner.init({ version: 1, rootIds: [], nodes: {} }, ${JSON.stringify(initData.currentFilePath)});
        }
        // Initialize notes file panel
        notesFilePanel.init(
            window.notesHostBridge,
            ${JSON.stringify(initData.fileList)},
            ${JSON.stringify(initData.currentFilePath)},
            ${JSON.stringify(initData.structure || null)},
            ${JSON.stringify(initData.panelWidth || null)},
            ${JSON.stringify(initData.noteFolderName || '')}
        );

        // ─── ADR-008: Notes 内 .md ファイル用のメインペイン dispatcher ───
        // 実装は shared/notes-md-dispatcher.js（FR-LR-03: externalUpdate は in-place 更新）。
        window.__initNotesMdDispatcher({
            outlinerContainer: document.querySelector('.outliner-container'),
            markdownContainer: document.querySelector('.markdown-container'),
            bridge: window.notesMarkdownHostBridge,
        });

        // ─── FR-HP: 最近開いたファイル履歴パネル ───
        window.__notesHistoryPanel = window.__initNotesHistoryPanel({
            panelEl: document.getElementById('sidePanelHistory'),
            listEl: document.getElementById('sidePanelHistoryList'),
            toggleEl: document.getElementById('sidePanelHistoryToggle'),
            resizeHandleEl: document.getElementById('sidePanelHistoryResizeHandle'),
            bridge: {
                openFile: function(id) { window.notesHostBridge.openFile(id); },
                saveHistoryPanelCollapsed: function(c) { window.notesHostBridge.saveHistoryPanelCollapsed(c); },
                saveHistoryPanelHeight: function(h) { window.notesHostBridge.saveHistoryPanelHeight(h); },
            },
            initialHistory: ${JSON.stringify(initData.history || [])},
            initialHeight: ${JSON.stringify(initData.historyPanelHeight ?? null)},
            initialCollapsed: ${JSON.stringify(initData.historyPanelCollapsed ?? false)},
        });
        // structure 更新（notesFileListChanged）で history 再描画
        window.addEventListener('message', function(e) {
            var m = e.data;
            if (m && m.type === 'notesFileListChanged' && m.structure && window.__notesHistoryPanel) {
                window.__notesHistoryPanel.render(m.structure.history || []);
            }
        });
    </script>
</body>
</html>`;
}
