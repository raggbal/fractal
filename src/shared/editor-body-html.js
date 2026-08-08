'use strict';

/**
 * VSCode / Electron 共通のエディタボディHTML生成
 *
 * @param {Record<string, string>} messages - i18n メッセージ
 * @param {string} platform - process.platform ('darwin' | 'win32' | 'linux')
 * @param {{ includeSidePanel?: boolean, showOpenInNewTab?: boolean, showNotesPanelToggle?: boolean }} [options]
 *   includeSidePanel=false の場合 side-panel/overlay の HTML を出力しない
 *   (Notes モードのように外側で side-panel を持つホスト用)。省略時は true。
 *   showOpenInNewTab=true の場合 toolbar 右端に「新タブで開く」ボタンを追加
 *   (Notes 内 .md メインペイン用)。
 *   showNotesPanelToggle=true の場合 toolbar 左端に「notes file panel を開く」ボタンを追加
 *   (Notes 内 .md メインペイン用、file-panel が collapsed の時のみ表示)。
 * @returns {string} <div class="container">...</div> の HTML文字列
 */
function generateEditorBodyHtml(messages, platform, options) {
    const msg = messages || {};
    const m = (key) => msg[key] || '';
    const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl';
    const includeSidePanel = !options || options.includeSidePanel !== false;
    const showOpenInNewTab = !!(options && options.showOpenInNewTab);
    const showNotesPanelToggle = !!(options && options.showNotesPanelToggle);
    const openInNewTabBtn = showOpenInNewTab
        ? `<button data-action="openInNewTab" title="Open in new tab"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`
        : '';
    const notesPanelToggleBtn = showNotesPanelToggle
        ? `<button class="notes-panel-toggle-btn notes-panel-toggle-btn--toolbar" title="Show file panel (Cmd+\\)">&#9776;</button>`
        : '';

    return `<div class="container">
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-header">
                ${showNotesPanelToggle ? `<button class="notes-panel-toggle-btn notes-panel-toggle-btn--outline" title="Show file panel (Cmd+\\)">&#9776;</button>` : ''}
                <h3>Outline</h3>
                <button class="sidebar-toggle" id="closeSidebar" title="${m('closeOutline')} (Cmd+\\)">&times;</button>
            </div>
            <nav class="outline" id="outline"></nav>
            <div class="sidebar-footer">
                <div class="word-count" id="wordCount"></div>
                <div class="sidebar-status-imagedir" id="statusImageDir">
                    <span class="imagedir-label">${m('imageDirLabel')}</span> <span class="imagedir-path" id="imageDirPath"></span>
                </div>
                <div class="sidebar-status-filedir" id="statusFileDir">
                    <span class="filedir-label">${m('fileDirLabel')}</span> <span class="filedir-path" id="fileDirPath"></span>
                </div>
            </div>
            <div class="sidebar-resizer" id="sidebarResizer"></div>
        </aside>
        <main class="editor-container">
            <div class="toolbar" id="toolbar">
                <div class="toolbar-fixed toolbar-fixed--left">
                    ${notesPanelToggleBtn}
                    <button data-action="openOutline" class="menu-btn hidden" id="openSidebarBtn" title="${m('openOutline')} (Cmd+\\)"></button>
                    <div class="toolbar-group" data-group="history">
                        <button data-action="undo" title="${m('undo')}"></button>
                        <button data-action="redo" title="${m('redo')}"></button>
                    </div>
                </div>
                <button class="toolbar-scroll-btn toolbar-scroll-btn--left hidden" id="toolbarScrollLeft">&#x276E;</button>
                <div class="toolbar-inner" id="toolbarInner">
                    <div class="toolbar-group" data-group="translate">
                        <button data-action="translate" title="Translate"></button>
                    </div>
                    <div class="toolbar-group" data-group="inline">
                        <button data-action="bold" title="${m('bold')}"></button>
                        <button data-action="italic" title="${m('italic')}"></button>
                        <button data-action="strikethrough" title="${m('strikethrough')}"></button>
                        <button data-action="code" title="${m('inlineCode')}"></button>
                        <button data-action="textColor" title="${m('textColor')}">A</button>
                    </div>
                    <div class="toolbar-group" data-group="block">
                        <button data-action="heading1" title="${m('heading1')}"></button>
                        <button data-action="heading2" title="${m('heading2')}"></button>
                        <button data-action="heading3" title="${m('heading3')}"></button>
                        <button data-action="heading4" title="${m('heading4')}"></button>
                        <button data-action="heading5" title="${m('heading5')}"></button>
                        <button data-action="heading6" title="${m('heading6')}"></button>
                        <button data-action="ul" title="${m('unorderedList')}"></button>
                        <button data-action="ol" title="${m('orderedList')}"></button>
                        <button data-action="task" title="${m('taskList')}"></button>
                        <button data-action="quote" title="${m('blockquote')}"></button>
                        <button data-action="codeblock" title="${m('codeBlock')}"></button>
                        <button data-action="mermaid" title="${m('mermaidBlock')}"></button>
                        <button data-action="math" title="${m('mathBlock')}"></button>
                        <button data-action="hr" title="${m('horizontalRule')}"></button>
                    </div>
                    <div class="toolbar-group" data-group="insert">
                        <button data-action="link" title="${m('insertLink')}"></button>
                        <button data-action="image" title="${m('insertImage')}"></button>
                        <button data-action="table" title="${m('insertTable')}"></button>
                    </div>
                </div>
                <button class="toolbar-scroll-btn toolbar-scroll-btn--right hidden" id="toolbarScrollRight">&#x276F;</button>
                <div class="toolbar-fixed toolbar-fixed--right">
                    <div class="toolbar-group" data-group="utility">
                        <button data-action="attachments" title="${m('attachments') || 'Attachments'}"></button>
                        <button data-action="openInTextEditor" title="${m('openInTextEditor')} (${mod}+Shift+.)"></button>
                        <button data-action="source" title="${m('toggleSourceMode')} (${mod}+.)"></button>
                        <button data-action="translate" class="toolbar-translate-fixed" title="Translate"></button>
                        <button data-action="exportPdf" title="Export to PDF"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg></button>
                        <button data-action="exportBundle" title="Export bundle"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
                        <button data-action="copyPath" title="${m('copyPath')}"></button>
                        <button data-action="copyInAppLink" class="toolbar-copy-inapp-link" title="${m('copyInAppLink') || 'Copy In-App Link'}" style="display:none"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg></button>
                        ${openInNewTabBtn}
                    </div>
                </div>
            </div>
            <div class="editor-wrapper" id="editorWrapper">
                <div class="search-replace-box" id="searchReplaceBox" style="display: none;">
                    <div class="search-row">
                        <input type="text" class="search-input" id="searchInput" placeholder="${m('searchPlaceholder')}" />
                        <span class="search-count" id="searchCount">0/0</span>
                        <button class="search-prev" id="searchPrev" title="${m('searchPrev')}">&#9650;</button>
                        <button class="search-next" id="searchNext" title="${m('searchNext')}">&#9660;</button>
                        <button class="toggle-replace" id="toggleReplace" title="${m('toggleReplace')}">&#8693;</button>
                        <button class="close-search" id="closeSearch" title="${m('closeSearch')}">&#10005;</button>
                    </div>
                    <div class="replace-row" id="replaceRow" style="display: none;">
                        <input type="text" class="replace-input" id="replaceInput" placeholder="${m('replacePlaceholder')}" />
                        <button class="replace-one" id="replaceOne" title="${m('replace')}">${m('replace')}</button>
                        <button class="replace-all" id="replaceAll" title="${m('replaceAll')}">${m('replaceAll')}</button>
                    </div>
                    <div class="search-options">
                        <label><input type="checkbox" class="search-case-sensitive" id="searchCaseSensitive" /> ${m('caseSensitive')}</label>
                        <label><input type="checkbox" class="search-whole-word" id="searchWholeWord" /> ${m('wholeWord')}</label>
                        <label><input type="checkbox" class="search-regex" id="searchRegex" /> ${m('regex')}</label>
                    </div>
                </div>
                <div class="editor" id="editor" contenteditable="true" spellcheck="true"></div>
                <textarea class="source-editor" id="sourceEditor" style="display: none;"></textarea>
            </div>
            <div class="fractal-resource-footer" style="display:none" data-rrf-template="${m('resourceAccessOutOfRangeCount')}">
                <span class="rrf-msg">${m('resourceAccessOutOfRange')}</span>
                <button class="rrf-open-settings" data-action="openResourceRootsSettings">${m('resourceAccessOpenSettings')}</button>
            </div>
            ${includeSidePanel ? generateSidePanelHtml(msg) : ''}
        </main>
    </div>`;
}

/**
 * サイドパネルHTML生成（全エディタ共通）
 *
 * @param {Record<string, string>} messages - i18n メッセージ
 * @returns {string} side-panel + overlay の HTML文字列
 */
function generateSidePanelHtml(messages) {
    const msg = messages || {};
    return `
        <div class="side-panel" id="sidePanel">
            <div class="side-panel-resize-handle" id="sidePanelResizeHandle"></div>
            <aside class="side-panel-sidebar" id="sidePanelSidebar">
                <div class="sidebar-header">
                    <h3>Outline</h3>
                    <button class="sidebar-toggle" id="sidePanelSidebarClose" title="${msg.closeOutline || 'Close Outline'} (Cmd+\\)">&times;</button>
                </div>
                <nav class="side-panel-toc" id="sidePanelToc"></nav>
                <div class="side-panel-toc-footer">
                    <div class="side-panel-word-count" id="sidePanelWordCount"></div>
                    <div class="side-panel-imagedir" id="sidePanelImageDir">
                        <span class="imagedir-label">${msg.imageDirLabel || 'Image save directory:'}</span> <span class="imagedir-path" id="sidePanelImageDirPath"></span>
                    </div>
                    <div class="side-panel-filedir" id="sidePanelFileDir">
                        <span class="filedir-label">${msg.fileDirLabel || 'File save directory:'}</span> <span class="filedir-path" id="sidePanelFileDirPath"></span>
                    </div>
                </div>
                <div class="side-panel-sidebar-resize-handle" id="sidePanelSidebarResizeHandle" title="Drag to resize outline"></div>
            </aside>
            <div class="side-panel-editor-container">
                <div class="side-panel-header">
                    <button class="menu-btn side-panel-outline-btn" id="sidePanelOpenOutline" title="${msg.openOutline || 'Open Outline'} (Cmd+\\)">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
                    </button>
                    <button class="side-panel-header-btn side-panel-nav-leading" data-action="navigateBack" title="Back (Opt+Left)" disabled>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                    </button>
                    <button class="side-panel-header-btn side-panel-nav-leading" data-action="navigateForward" title="Forward (Opt+Right)" disabled>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                    <!-- 狭幅レスポンシブ: lead（outline+nav）と close は固定、中央のみ横スクロール -->
                    <div class="side-panel-header-scroll">
                    <span class="side-panel-filename" id="sidePanelFilename"></span>
                    <div class="side-panel-header-actions">
                        <button class="side-panel-header-btn side-panel-expand" id="sidePanelExpand" title="Expand">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                        </button>
                        <button class="side-panel-header-btn" data-action="undo" title="Undo"></button>
                        <button class="side-panel-header-btn" data-action="redo" title="Redo"></button>
                        <button class="side-panel-header-btn" data-action="translate" title="Translate"></button>
                        <button class="side-panel-header-btn" data-action="attachments" title="Attachments"></button>
                        <button class="side-panel-header-btn" data-action="openInTextEditor" title="Open in Text Editor"></button>
                        <button class="side-panel-header-btn" data-action="exportPdf" title="Export to PDF">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>
                        </button>
                        <button class="side-panel-header-btn" data-action="exportBundle" title="Export bundle">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        </button>
                        <button class="side-panel-header-btn" data-action="source" title="Source mode"></button>
                    </div>
                    <button class="side-panel-copy-path" id="sidePanelCopyPath" title="Copy file path">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button class="side-panel-copy-inapp-link" id="sidePanelCopyInAppLink" title="${msg.copyInAppLink || 'Copy In-App Link'}" style="display:none">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                    </button>
                    </div>
                    <!-- FR-SPM-01 (sprint 20260808-000219): overflow「…」メニュー。狭幅で溢れた
                         非固定ボタンのプロキシ item を持つ。scroll 外＝固定（常に押せる）。
                         格納ボタンが 0 のときは sidepanel-overflow.js が display:none にする -->
                    <button class="side-panel-header-btn side-panel-overflow-btn" id="sidePanelOverflowBtn" title="${msg.overflowMenuTitle || 'More actions'}" style="display:none">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                    </button>
                    <div class="side-panel-overflow-menu" id="sidePanelOverflowMenu" style="display:none"></div>
                    <!-- sprint 20260725: open-in-tab は close と同様に scroll 外＝固定表示（狭幅でも隠れない） -->
                    <button class="side-panel-open-tab" id="sidePanelOpenTab" title="Open in new tab">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </button>
                    <button class="side-panel-close" id="sidePanelClose" title="Close (Cmd+\\)">&times;</button>
                </div>
                <div class="side-panel-iframe-container" id="sidePanelIframeContainer"></div>
            </div>
        </div>`;
}
// sprint 20260724-042927: .side-panel-overlay（シャドー）を全モードで廃止（外側クリック close も廃止）。

module.exports = { generateEditorBodyHtml, generateSidePanelHtml };
