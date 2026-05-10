'use strict';

/**
 * Notes 左パネル CSS + HTML を生成
 * VSCode / Electron 共通
 *
 * @param {object} options
 * @param {boolean} options.collapsed - パネルが折り畳み状態か
 * @returns {{ css: string, html: string }} CSS文字列とHTML文字列
 */

/**
 * 20 色分の Notes アイコン色付け CSS を生成
 * @returns {string} CSS ルール文字列
 */
function generateNotesColorCss() {
    // CommonJS require または global から palette を取得
    var palette;
    if (typeof NOTES_COLOR_PALETTE !== 'undefined') {
        palette = NOTES_COLOR_PALETTE;
    } else if (typeof require !== 'undefined') {
        palette = require('./notes-color-palette').NOTES_COLOR_PALETTE;
    } else {
        return '';
    }

    return palette.map(function(c) {
        // 直下セレクタ (>) を使用してサブツリーへの色伝播を防止
        return '.notes-item-color-' + c.name + ' > .file-panel-item-icon,\n' +
               '.notes-item-color-' + c.name + ' > .file-panel-folder-icon { ' +
               'stroke: ' + c.hex + '; opacity: 1; }';
    }).join('\n');
}

function generateNotesFilePanelHtml(options) {
    var collapsed = options && options.collapsed;
    var msg = (options && options.messages) || {};
    var m = function(key, fallback) { return msg[key] || fallback; };
    var panelClass = collapsed ? ' collapsed' : '';

    var css = `
        .notes-layout {
            display: flex; height: 100vh; overflow: hidden;
        }
        .notes-file-panel {
            width: var(--notes-panel-width, 198px); min-width: 0; flex-shrink: 0;
            /* ミニマル: 1px の薄い divider で視覚分離 (色統一後の境界線) */
            border-right: 1px solid var(--fr-color-divider, var(--outliner-border, #e0e0e0));
            display: flex; flex-direction: column;
            background: var(--fr-color-bg-panel, var(--outliner-bg, #fafafa));
            overflow: hidden;
        }
        .notes-file-panel.collapsed { width: 0; border-right: none; }
        /* 0 幅のハンドル + ::before で前後 3px 程度 hit area を overlap させる。
           通常時は flex 上のスペースを取らず、hover/active で青ラインが出る。 */
        .notes-resize-handle {
            width: 0; flex-shrink: 0; position: relative; z-index: 10;
        }
        .notes-resize-handle::before {
            content: '';
            position: absolute;
            top: 0; bottom: 0;
            left: -3px; right: -3px;
            cursor: col-resize;
        }
        .notes-resize-handle:hover::before,
        .notes-resize-handle.active::before {
            background: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
            /* hover bar は file panel 側のみ (右側 = editor 側には拡張しない)
               editor の左 border のように見える二重表示を防止 */
            left: -2px; right: 0;
        }
        .notes-file-panel.collapsed + .notes-resize-handle { display: none; }
        .file-panel-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 7px 11px; /* layout 維持 */
            border-bottom: 1px solid var(--fr-color-divider, var(--outliner-border, #e0e0e0));
            box-sizing: border-box;
        }
        .file-panel-title { font-weight: 600; font-size: 12px; white-space: nowrap; }
        .file-panel-actions { display: flex; gap: 4px; align-items: center; }
        .file-panel-btn {
            background: transparent;
            border: 1px solid var(--fr-color-border, var(--outliner-border, #e0e0e0));
            border-radius: var(--fr-radius-sm, 6px);
            cursor: pointer;
            color: var(--fr-color-text-primary, inherit);
            padding: 6px 7px; line-height: 1; font-size: 12px;
            display: flex; align-items: center; justify-content: center;
            opacity: 0.7;
        }
        .file-panel-btn:hover {
            opacity: 1;
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
            background: var(--fr-color-bg-elevated, transparent);
        }
        .file-panel-btn:focus-visible {
            outline: none;
            box-shadow: var(--fr-shadow-focus, 0 0 0 3px rgba(79, 107, 255, 0.25));
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
        }
        .file-panel-list { flex: 1; overflow-y: auto; padding: 4px 0; }

        /* ── File item ── */
        .file-panel-item {
            padding: 5px 11px; cursor: pointer; font-size: 12px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            border-radius: var(--fr-radius-sm, 6px); margin: 1px 4px;
            display: flex; align-items: center; gap: 5px;
            position: relative;
        }
        /* file panel list item: hover は water-blue で反転 (active 行も同様)。active 行は背景なし + 左 2px primary bar
         * 注: .active:hover を明示することで .active の transparent を上書き (specificity 同点 → 高 specificity 勝ち) */
        .file-panel-item.active {
            background: transparent;
            font-weight: 500;
        }
        .file-panel-item:hover,
        .file-panel-item.active:hover { background: var(--fr-color-selection-bg, var(--outliner-active, #d8e8f8)); }
        .file-panel-item.active::before {
            content: ''; position: absolute; left: 0; top: 4px; bottom: 4px;
            /* 「ノート」タブの border-bottom (2px) と統一 */
            width: 2px; background: var(--fr-color-selection-bar, var(--fr-color-primary, currentColor));
            border-radius: 1px;
        }
        .file-panel-item-icon { flex-shrink: 0; opacity: 0.5; width: 13px; height: 13px; }
        .file-panel-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        /* ── Folder ── */
        .file-panel-folder { }
        .file-panel-folder-header {
            padding: 5px 11px; cursor: pointer; font-size: 12px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            border-radius: var(--fr-radius-sm, 6px); margin: 1px 4px;
            display: flex; align-items: center; gap: 4px;
            font-weight: 500;
        }
        .file-panel-folder-header:hover { background: var(--fr-color-selection-bg, var(--outliner-hover, #e8e8e8)); }
        .file-panel-folder-chevron {
            flex-shrink: 0; width: 13px; height: 13px;
            display: flex; align-items: center; justify-content: center;
            transition: transform 0.15s;
            opacity: 0.6;
        }
        .file-panel-folder.collapsed > .file-panel-folder-header > .file-panel-folder-chevron {
            transform: rotate(-90deg);
        }
        .file-panel-folder-icon { flex-shrink: 0; opacity: 0.5; width: 13px; height: 13px; }
        .file-panel-folder-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file-panel-folder-children {
            padding-left: 25px;  /* v11: was 11px. chevron(14) + gap(4) + folder icon(14) 相当 */
        }
        .file-panel-folder.collapsed > .file-panel-folder-children {
            display: none;
        }

        /* ── Drag & Drop ── */
        .file-panel-drag-over { background: var(--fr-color-selection-bg, var(--outliner-active, #d8e8f8)); border-radius: var(--fr-radius-sm, 6px); }
        .file-panel-drop-line {
            height: 2px; background: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
            margin: 0 4px; border-radius: 1px;
            pointer-events: none;
        }
        [draggable="true"] { cursor: grab; }
        [draggable="true"]:active { cursor: grabbing; }

        .file-panel-empty {
            padding: 14px 11px; color: var(--fr-color-text-tertiary, var(--outliner-subtext, #999)); font-size: 11px; text-align: center;
        }
        .notes-main-wrapper { flex: 1; overflow: hidden; display: flex; flex-direction: column; position: relative; }
        .notes-panel-toggle-btn {
            background: transparent; border: 1px solid var(--fr-color-border, var(--outliner-border, #e0e0e0));
            border-radius: var(--fr-radius-sm, 6px); cursor: pointer; padding: 4px 5px; line-height: 1;
            display: none; color: var(--fr-color-text-primary, inherit); opacity: 0.7; font-size: 12px;
            align-items: center; justify-content: center; flex-shrink: 0; margin-right: 5px;
        }
        .notes-panel-toggle-btn:hover {
            opacity: 1;
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
        }
        .notes-panel-toggle-btn:focus-visible {
            outline: none;
            box-shadow: var(--fr-shadow-focus, 0 0 0 3px rgba(79, 107, 255, 0.25));
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
        }
        .notes-file-panel.collapsed ~ .notes-main-wrapper .notes-panel-toggle-btn { display: flex; }
        .file-panel-rename-input {
            width: 100%; padding: 4px 7px; font-size: 12px;
            border: 1px solid var(--fr-color-primary, var(--outliner-active, #4a9eff));
            border-radius: var(--fr-radius-sm, 6px); outline: none;
            background: var(--fr-color-bg-elevated, var(--outliner-bg, #fff));
            color: var(--fr-color-text-primary, inherit);
            box-shadow: var(--fr-shadow-focus, 0 0 0 3px rgba(79, 107, 255, 0.25));
        }
        .file-panel-context-menu {
            position: fixed;
            background: var(--fr-color-bg-elevated, var(--outliner-bg, #fff));
            border: 1px solid var(--fr-color-border, var(--outliner-border, #ddd));
            border-radius: var(--fr-radius-lg, 10px);
            box-shadow: var(--fr-shadow-2, 0 4px 11px rgba(0,0,0,0.15));
            padding: 4px; z-index: var(--fr-z-popup, 1000);
            min-width: 126px;
        }
        .file-panel-context-item {
            padding: 5px 14px; cursor: pointer; font-size: 12px;
            white-space: nowrap; border-radius: var(--fr-radius-sm, 6px);
        }
        .file-panel-context-item:hover { background: var(--fr-color-bg-app, var(--outliner-hover, #e8e8e8)); }
        .file-panel-context-item.danger { color: var(--fr-color-danger, #e55); }
        .file-panel-context-item.danger:hover { background: var(--fr-color-danger-soft, rgba(217,74,74,0.1)); }

        /* ── Tabs ── */
        .file-panel-tabs {
            display: flex; border-bottom: 1px solid var(--outliner-border, #e0e0e0);
            padding: 0; flex-shrink: 0;
        }
        .file-panel-tab {
            flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
            padding: 7px 4px; border: none; background: none; cursor: pointer;
            font-size: 11px; opacity: 0.6; color: inherit;
            border-bottom: 2px solid transparent; transition: opacity 0.15s;
        }
        .file-panel-tab:hover { opacity: 0.85; }
        .file-panel-tab.active { opacity: 1; border-bottom-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc)); }
        .file-panel-tab svg { flex-shrink: 0; }
        .file-panel-content { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
        .file-panel-content-actions {
            display: flex; gap: 4px; padding: 5px 7px;
            border-bottom: 1px solid var(--outliner-border, #e0e0e0); flex-shrink: 0;
        }
        .file-panel-content-actions .file-panel-btn { font-size: 11px; padding: 4px 7px; }

        /* ── Search ── */
        .file-panel-search-input-wrap {
            padding: 7px; display: flex; flex-direction: column; gap: 4px;
            border-bottom: 1px solid var(--outliner-border, #e0e0e0);
        }
        .file-panel-search-input {
            width: 100%; padding: 4px 7px; font-size: 12px;
            border: 1px solid var(--fr-color-border, var(--outliner-border, #e0e0e0));
            border-radius: var(--fr-radius-sm, 6px);
            background: var(--fr-color-bg-elevated, var(--outliner-bg, #fff));
            color: var(--fr-color-text-primary, inherit); outline: none;
            box-sizing: border-box;
        }
        .file-panel-search-input:focus {
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
            box-shadow: var(--fr-shadow-focus, 0 0 0 3px rgba(79, 107, 255, 0.25));
        }
        .file-panel-search-options { display: flex; gap: 2px; }
        .file-panel-search-opt-btn {
            padding: 2px 5px; font-size: 10px; border: 1px solid transparent;
            border-radius: 3px; cursor: pointer; opacity: 0.6; background: transparent; color: inherit;
        }
        .file-panel-search-opt-btn:hover { opacity: 0.8; }
        .file-panel-search-opt-btn.active {
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc)); opacity: 1;
        }
        .file-panel-search-results { flex: 1; overflow-y: auto; padding: 4px 0; }
        .file-panel-search-section { margin-bottom: 5px; }
        .file-panel-search-section-title {
            padding: 5px 9px 4px; font-size: 10px; font-weight: 700;
            color: var(--vscode-textLink-foreground, #007acc);
            border-bottom: 1px solid var(--vscode-panel-border, var(--outliner-border, #e0e0e0));
            text-transform: none; letter-spacing: 0.02em;
        }
        .file-panel-search-file-group { margin-bottom: 4px; }
        .file-panel-search-file-header {
            padding: 4px 11px; font-size: 10px; font-weight: 600;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            color: var(--vscode-symbolIcon-classForeground, #d19a66);
        }
        .file-panel-search-file-header.is-md {
            color: var(--vscode-symbolIcon-classForeground, #d19a66);
        }
        .file-panel-search-match {
            padding: 4px 11px 4px 18px; font-size: 11px; cursor: pointer;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .file-panel-search-match:hover { background: var(--fr-color-selection-bg, var(--outliner-hover, #e8e8e8)); }
        .file-panel-search-highlight { background: rgba(255, 200, 0, 0.3); font-weight: 500; }
        .file-panel-search-count { padding: 4px 11px; font-size: 10px; opacity: 0.6; }
        .file-panel-search-spinner { padding: 7px 11px; font-size: 11px; opacity: 0.5; }

        /* ── S3 Tab ── */
        .s3-panel-section { padding: 7px 11px; }
        .s3-label { font-size: 10px; opacity: 0.7; margin-bottom: 4px; display: block; }
        .s3-input-row { display: flex; gap: 4px; }
        .s3-input-row .file-panel-search-input { flex: 1; }
        .s3-status { font-size: 10px; margin-top: 5px; opacity: 0.6; }
        .s3-status.ok { color: var(--fr-color-success, #3a3); opacity: 1; }
        .s3-status.error { color: var(--fr-color-danger, #e55); opacity: 1; }
        .s3-actions { display: flex; flex-direction: column; gap: 5px; padding-top: 4px; }
        .s3-action-btn {
            width: 100%; text-align: center; padding: 7px 11px;
            font-size: 11px; border-radius: var(--fr-radius-sm, 6px);
        }
        .s3-action-btn:focus-visible {
            outline: none;
            box-shadow: var(--fr-shadow-focus, 0 0 0 3px rgba(79, 107, 255, 0.25));
        }
        .s3-action-btn.s3-danger {
            border-color: var(--fr-color-danger, #c44);
            color: var(--fr-color-danger, #c44);
        }
        .s3-action-btn.s3-danger:hover {
            background: var(--fr-color-danger-soft, rgba(204, 68, 68, 0.1));
        }
        .s3-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .s3-progress { padding: 7px 11px; }
        .s3-progress-message { font-size: 11px; font-weight: 500; }
        .s3-progress-detail { font-size: 10px; opacity: 0.6; margin-top: 2px; word-break: break-all; }

        /* ── Tools Tab ── */
        .file-panel-tools-section {
            margin: 9px 0; padding: 0;
        }
        .file-panel-section-title {
            font-weight: bold; font-size: 11px; margin-bottom: 5px;
            color: var(--fr-color-text-primary, var(--vscode-foreground)); opacity: 0.8;
        }

        /* ── v11: Color Palette UI ── */
        .file-panel-color-grid {
            display: grid;
            grid-template-columns: repeat(5, 18px);
            gap: 4px;
            padding: 7px 11px;
        }
        .file-panel-color-swatch {
            width: 18px; height: 18px;
            border-radius: var(--fr-radius-xs, 4px);
            cursor: pointer;
            border: 2px solid transparent;
            transition: transform 0.1s, border-color 0.1s;
        }
        .file-panel-color-swatch:hover { transform: scale(1.15); }
        .file-panel-color-swatch.active { border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc)); }
        .file-panel-color-back, .file-panel-color-none {
            font-size: 11px;
            opacity: 0.75;
        }

        /* ── v11: Notes Item Color Classes (generated) ── */
        ` + generateNotesColorCss() + `
    `;

    var html = `<aside class="notes-file-panel${panelClass}" id="notesFilePanel">
            <div class="file-panel-header">
                <span class="file-panel-title">Outlines</span>
                <div class="file-panel-actions">
                    <button class="file-panel-btn" id="filePanelCollapse" title="${m('notesCollapsePanel', 'Collapse panel')} (Cmd+\\)">&#9776;</button>
                </div>
            </div>
            <div class="file-panel-tabs">
                <button class="file-panel-tab active" data-tab="notes">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 13h-2"/><path d="M10 17H8"/><path d="M16 17h-2"/></svg>
                    ${m('notesTabNotes', 'Notes')}
                </button>
                <button class="file-panel-tab" data-tab="search">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    ${m('notesTabSearch', 'Search')}
                </button>
                <button class="file-panel-tab" data-tab="tools">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg>
                    ${m('notesTabTools', 'Tools')}
                </button>
            </div>
            <div class="file-panel-content" id="filePanelContentNotes">
                <div class="file-panel-content-actions">
                    <button class="file-panel-btn" id="filePanelAddFolder" title="${m('notesNewFolder', 'New Folder')}"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg></button>
                    <button class="file-panel-btn" id="filePanelAdd" title="${m('notesNewOutline', 'New Outline')}"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
                    <span style="flex:1"></span>
                    <button class="file-panel-btn" id="filePanelToday" title="${m('notesToday', 'Today')}"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="16" height="16" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${m('notesToday', 'Today')}</button>
                </div>
                <div class="file-panel-list" id="notesFileList"></div>
            </div>
            <div class="file-panel-content" id="filePanelContentSearch" style="display:none">
                <div class="file-panel-search-input-wrap">
                    <input type="text" class="file-panel-search-input" id="notesSearchInput" placeholder="${m('notesSearchPlaceholder', 'Search...')}" />
                    <div class="file-panel-search-options">
                        <button class="file-panel-search-opt-btn" id="notesSearchCase" title="${m('notesMatchCase', 'Match Case')}">Aa</button>
                        <button class="file-panel-search-opt-btn" id="notesSearchWord" title="${m('notesWholeWord', 'Whole Word')}">W</button>
                        <button class="file-panel-search-opt-btn" id="notesSearchRegex" title="${m('notesUseRegex', 'Use Regex')}">.*</button>
                    </div>
                </div>
                <div class="file-panel-search-count" id="notesSearchCount"></div>
                <div class="file-panel-search-results" id="notesSearchResults"></div>
            </div>
            <div class="file-panel-content" id="filePanelContentTools" style="display:none">
                <!-- S3 Sync Section -->
                <div class="file-panel-tools-section">
                    <div class="file-panel-section-title">${m('notesS3Sync', 'S3 Sync')}</div>
                    <div class="s3-panel-section">
                        <label class="s3-label">S3 Bucket Path</label>
                        <div class="s3-input-row">
                            <input type="text" class="file-panel-search-input" id="s3BucketPathInput" placeholder="my-bucket/path" />
                            <button class="file-panel-btn" id="s3SavePath" title="${m('notesS3Save', 'Save')}">${m('notesS3Save', 'Save')}</button>
                        </div>
                        <div class="s3-status" id="s3CredentialStatus"></div>
                    </div>
                    <div class="s3-panel-section s3-actions">
                        <button class="file-panel-btn s3-action-btn" id="s3BtnSync" disabled>${m('notesS3Sync', 'Sync (Backup)')}</button>
                        <button class="file-panel-btn s3-action-btn s3-danger" id="s3BtnRemoteDeleteUpload" disabled>${m('notesS3RemoteDeleteUpload', 'Remote Delete &amp; Upload')}</button>
                        <button class="file-panel-btn s3-action-btn s3-danger" id="s3BtnLocalDeleteDownload" disabled>${m('notesS3LocalDeleteDownload', 'Local Delete &amp; Download')}</button>
                    </div>
                    <div class="s3-progress" id="s3Progress" style="display:none">
                        <div class="s3-progress-message" id="s3ProgressMessage"></div>
                        <div class="s3-progress-detail" id="s3ProgressDetail"></div>
                    </div>
                </div>

                <!-- Clean Notes Section -->
                <div class="file-panel-tools-section">
                    <div class="file-panel-section-title">${m('notesCleanNotes', 'Clean Notes')}</div>
                    <button class="file-panel-btn" id="filePanelCleanupCurrent" title="${m('notesCleanUnusedCurrentNoteTooltip', 'Scan current note for unused files')}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            <line x1="10" y1="11" x2="10" y2="17"/>
                            <line x1="14" y1="11" x2="14" y2="17"/>
                        </svg>
                        ${m('notesCleanUnusedCurrentNote', 'Clean Unused Files (Current Note)')}
                    </button>
                    <button class="file-panel-btn" id="filePanelCleanupTools" title="${m('notesCleanUnusedAllNotesTooltip', 'Scan all registered notes for unused files')}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            <line x1="10" y1="11" x2="10" y2="17"/>
                            <line x1="14" y1="11" x2="14" y2="17"/>
                        </svg>
                        ${m('notesCleanUnusedAllNotes', 'Clean Unused Files in All Notes')}
                    </button>
                </div>

                <!-- Translate Section (v0.207.25): Custom Terminology の手動 update -->
                <div class="file-panel-tools-section">
                    <div class="file-panel-section-title">${m('notesTranslateSection', 'Translate')}</div>
                    <button class="file-panel-btn" id="filePanelUpdateTranslateTerminology" title="${m('notesUpdateTranslateTerminologyTooltip', 'Upload Custom Terminology dictionary to Amazon Translate')}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M2 12h6M12 2v6m4 0L20 4m-4 16l4-4M2 12l4 4m12-12l4-4"/>
                            <circle cx="12" cy="12" r="3"/>
                        </svg>
                        ${m('notesUpdateTranslateTerminology', 'Update Translate Terminology')}
                    </button>
                </div>
            </div>
        </aside>
        <div class="notes-resize-handle" id="notesResizeHandle"></div>`;

    return { css: css, html: html };
}

module.exports = { generateNotesFilePanelHtml };
