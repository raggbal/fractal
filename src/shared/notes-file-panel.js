'use strict';

/**
 * Notes 左ファイルパネル — webview 内で動作する UI コントローラ
 * VSCode / Electron 共通
 *
 * ツリー表示（フォルダ + ファイル）、D&D による並び替え・移動をサポート
 *
 * 使い方:
 *   notesFilePanel.init(bridge, fileList, currentFile, structure)
 *
 * bridge インターフェース:
 *   openFile(filePath), createFile(title, parentId), deleteFile(filePath),
 *   renameTitle(filePath, newTitle), togglePanel(collapsed),
 *   createFolder(title, parentId), deleteFolder(folderId),
 *   renameFolder(folderId, newTitle), toggleFolder(folderId),
 *   moveItem(itemId, targetParentId, index),
 *   onFileListChanged(handler)
 */
var notesFilePanel = (function() {
    var bridge = null;
    var fileList = [];
    var currentFile = null;
    var structure = null;
    var noteFolderName = '';       // FR-NT-01: noteTitle 未設定時の既定表示 (フォルダ名)
    var titleLabelEl = null;       // FR-NT-01: #notesTitleLabel
    var _titleEditing = false;     // 二重編集ガード
    var listEl = null;
    var panelEl = null;
    var contextMenu = null;
    var i18n = window.__outlinerMessages || {};
    var favoritesEl = null; // v0.207.37: Notes タブ直下のお気に入り section container

    // D&D state (module-scope, VSCode webview の dataTransfer 制限回避)
    var dragItemId = null;
    var dragItemType = null; // 'file' or 'folder'
    var dragSourceFileExt = null; // 'md' | 'out' | null  (file の場合のみ)
    var dropIndicator = null;

    // Resize state
    var resizeHandle = null;
    var isResizing = false;
    var resizeStartX = 0;
    var resizeStartWidth = 0;
    var PANEL_MIN_WIDTH = 140;
    var PANEL_MAX_WIDTH_RATIO = 0.5;
    var lastSavedPanelWidth = null;

    // Tab state
    var currentTab = 'notes'; // 'notes' | 'search' | 'tools'

    // Search state
    var searchInputEl = null;
    var searchResultsEl = null;
    var searchCountEl = null;
    var searchOptions = { caseSensitive: false, wholeWord: false, useRegex: false };
    var currentSearchId = 0;
    var searchTotalCount = 0;

    // SVG icons
    var ICON_FILE = '<svg class="file-panel-item-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
    // ADR-008: Notes 内 .md ファイル識別用アイコン (file の右下に "M" ラベル)
    var ICON_FILE_MD = '<svg class="file-panel-item-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><text x="8" y="19" font-size="8" font-weight="700" stroke="none" fill="currentColor">M</text></svg>';
    var ICON_FOLDER = '<svg class="file-panel-folder-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    var ICON_CHEVRON = '<svg class="file-panel-folder-chevron" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

    // ── ファイルマップ構築 ──

    function buildFileMap(files) {
        var map = {};
        files.forEach(function(f) {
            var id = f.id || f.filePath.replace(/^.*[/\\]/, '').replace(/\.out$/, '');
            map[id] = f;
        });
        return map;
    }

    // ── FR-NT-01/02: note フォルダタイトル (見出し) の表示と inline 編集 ──

    function currentNoteTitleText() {
        var t = structure && structure.noteTitle;
        return (t && String(t).trim()) ? String(t).trim() : (noteFolderName || '');
    }

    function renderNoteTitle() {
        if (!titleLabelEl) { titleLabelEl = document.getElementById('notesTitleLabel'); }
        if (!titleLabelEl || _titleEditing) { return; }
        titleLabelEl.textContent = currentNoteTitleText();
    }

    function beginNoteTitleEdit() {
        if (!titleLabelEl || _titleEditing) { return; }
        _titleEditing = true;
        var original = currentNoteTitleText();
        titleLabelEl.setAttribute('contenteditable', 'true');
        titleLabelEl.classList.add('editing');
        titleLabelEl.focus();
        // 全選択
        try {
            var range = document.createRange();
            range.selectNodeContents(titleLabelEl);
            var sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(range);
        } catch (e) { /* noop */ }

        var finish = function(commit) {
            if (!_titleEditing) { return; }
            _titleEditing = false;
            titleLabelEl.removeAttribute('contenteditable');
            titleLabelEl.classList.remove('editing');
            titleLabelEl.removeEventListener('keydown', onKey);
            titleLabelEl.removeEventListener('blur', onBlur);
            if (commit) {
                var val = (titleLabelEl.textContent || '').trim();
                if (val !== original && bridge && bridge.setNoteTitle) {
                    bridge.setNoteTitle(val); // 空文字なら host 側でクリア (フォルダ名表示に戻る)
                }
            }
            renderNoteTitle(); // 表示を確定値 (or 元) に戻す
        };
        var onKey = function(e) {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); titleLabelEl.textContent = original; finish(false); }
        };
        var onBlur = function() { finish(true); };
        titleLabelEl.addEventListener('keydown', onKey);
        titleLabelEl.addEventListener('blur', onBlur);
    }

    // ── ツリーレンダリング ──

    function renderTree() {
        if (!listEl) return;
        listEl.innerHTML = '';

        // v0.207.37: お気に入り section を Notes タブ直下に常時表示 (空なら非表示)
        renderFavoritesSection();

        if (!structure || !structure.rootIds || structure.rootIds.length === 0) {
            // フラットリストフォールバック
            if (fileList.length === 0) {
                listEl.innerHTML = '<div class="file-panel-empty">No outlines yet.<br>Click + to create one.</div>';
                return;
            }
            fileList.forEach(function(f) {
                listEl.appendChild(createFileElement(f, null));
            });
            return;
        }

        var fileMap = buildFileMap(fileList);
        renderIds(structure.rootIds, listEl, fileMap, null);

        if (listEl.children.length === 0) {
            listEl.innerHTML = '<div class="file-panel-empty">No outlines yet.<br>Click + to create one.</div>';
        }
    }

    /** v0.207.37: お気に入り section を Notes タブ直下に flat list 表示 (folder 階層なし)。
     *  空なら section を display:none で完全非表示 (旧版と全く同じ見た目)。 */
    function renderFavoritesSection() {
        if (!favoritesEl) return;
        favoritesEl.innerHTML = '';
        var favIds = (structure && Array.isArray(structure.favorites)) ? structure.favorites : [];
        if (favIds.length === 0) {
            favoritesEl.style.display = 'none';
            return;
        }
        var fileMap = buildFileMap(fileList);
        var rendered = [];
        favIds.forEach(function(fileId) {
            var f = fileMap[fileId];
            if (!f) return; // 削除済等は skip
            var item = structure && structure.items ? structure.items[fileId] : null;
            var displayTitle = (item && item.title) || f.title || fileId;
            var fileEntry = Object.assign({}, f, { title: displayTitle });
            var el = createFileElement(fileEntry, null);
            el.dataset.favSection = '1';  // 右クリック menu で簡素 menu を出す marker
            rendered.push(el);
        });
        if (rendered.length === 0) {
            favoritesEl.style.display = 'none';
            return;
        }
        // header + list (★ icon は外し、text label のみ)
        var header = document.createElement('div');
        header.className = 'file-panel-favorites-header';
        header.innerHTML = '<span>' + (i18n.notesFavorites || 'Favorites') + '</span>';
        favoritesEl.appendChild(header);
        rendered.forEach(function(el) { favoritesEl.appendChild(el); });
        favoritesEl.style.display = '';
    }

    function renderIds(ids, containerEl, fileMap, parentId) {
        ids.forEach(function(id) {
            var item = structure.items[id];
            if (!item) return;

            if (item.type === 'folder') {
                containerEl.appendChild(createFolderElement(item, fileMap, parentId));
            } else if (item.type === 'file') {
                var fileEntry = fileMap[id];
                if (fileEntry) {
                    containerEl.appendChild(createFileElement(fileEntry, parentId));
                }
            }
        });
    }

    function createFileElement(f, parentId) {
        var item = document.createElement('div');
        var isMd = /\.md$/i.test(f.filePath);
        var itemClass = 'file-panel-item' + (f.filePath === currentFile ? ' active' : '');
        // v11: color class 反映
        var itemColor = getItemColor(f.id || f.filePath.replace(/^.*[/\\]/, '').replace(/\.(out|md)$/, ''));
        if (itemColor) {
            itemClass += ' notes-item-color-' + itemColor;
        }
        if (isMd) itemClass += ' is-md';
        item.className = itemClass;
        item.dataset.filePath = f.filePath;
        item.dataset.itemId = f.id || f.filePath.replace(/^.*[/\\]/, '').replace(/\.(out|md)$/, '');
        item.dataset.itemType = 'file';
        item.dataset.fileExt = isMd ? 'md' : 'out';
        if (parentId) item.dataset.parentId = parentId;
        item.draggable = true;

        var icon = isMd ? ICON_FILE_MD : ICON_FILE;
        item.innerHTML = icon + '<span class="file-panel-item-title">' + escapeHtml(f.title || 'Untitled') + '</span>';

        item.addEventListener('click', function(e) {
            // FR-CT-01: cmd/ctrl+click → webview 内タブ（右クリック Open in new tab と同経路）
            if (e && (e.metaKey || e.ctrlKey)) {
                if (bridge.openFileInTab) bridge.openFileInTab(f.filePath);
                return; // FR-CT-02: openFile は発火させない（currentFile も変えない）
            }
            if (f.filePath !== currentFile) {
                currentFile = f.filePath;  // 即時更新で二重送信防止
                bridge.openFile(f.filePath);
            }
        });
        item.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            startRenameFile(item, f);
        });
        item.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            showFileContextMenu(e, f);
        });

        // D&D
        setupDragSource(item);
        setupDropTarget(item);

        return item;
    }

    function createFolderElement(folder, fileMap, parentId) {
        var wrapper = document.createElement('div');
        wrapper.className = 'file-panel-folder' + (folder.collapsed ? ' collapsed' : '');
        wrapper.dataset.folderId = folder.id;
        wrapper.dataset.itemId = folder.id;
        wrapper.dataset.itemType = 'folder';
        if (parentId) wrapper.dataset.parentId = parentId;

        var header = document.createElement('div');
        // v11: color class は header に付与 (wrapper ではない — 直下セレクタが効くため)
        var headerClass = 'file-panel-folder-header';
        if (folder.color) {
            headerClass += ' notes-item-color-' + folder.color;
        }
        header.className = headerClass;
        header.draggable = true;
        header.innerHTML = ICON_CHEVRON + ICON_FOLDER +
            '<span class="file-panel-folder-title">' + escapeHtml(folder.title || (i18n.notesUntitled || 'Untitled')) + '</span>';

        // クリックで展開/折りたたみ
        header.addEventListener('click', function() {
            bridge.toggleFolder(folder.id);
        });
        header.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            startRenameFolder(header, folder);
        });
        header.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            showFolderContextMenu(e, folder);
        });

        // D&D（ヘッダーがドラッグソース、フォルダ全体がドロップターゲット）
        setupDragSource(header);
        setupDropTarget(header);

        wrapper.appendChild(header);

        var children = document.createElement('div');
        children.className = 'file-panel-folder-children';
        renderIds(folder.childIds || [], children, fileMap, folder.id);
        wrapper.appendChild(children);

        // フォルダの子エリアもドロップターゲット
        setupFolderChildrenDrop(children, folder.id);

        return wrapper;
    }

    // ── リネーム ──

    function startRenameFile(itemEl, file) {
        var titleSpan = itemEl.querySelector('.file-panel-item-title');
        if (!titleSpan) { startRenameLegacy(itemEl, file); return; }

        var input = document.createElement('input');
        input.className = 'file-panel-rename-input';
        input.value = file.title || '';
        input.type = 'text';

        var originalHtml = titleSpan.innerHTML;
        titleSpan.innerHTML = '';
        titleSpan.appendChild(input);
        input.focus();
        input.select();

        var done = false;
        function finish() {
            if (done) return;
            done = true;
            var val = input.value.trim();
            if (val && val !== file.title) {
                bridge.renameTitle(file.filePath, val);
            } else {
                titleSpan.innerHTML = originalHtml;
            }
        }
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { finish(); }
            if (e.key === 'Escape') { done = true; titleSpan.innerHTML = originalHtml; }
        });
    }

    function startRenameLegacy(itemEl, file) {
        var input = document.createElement('input');
        input.className = 'file-panel-rename-input';
        input.value = file.title || '';
        input.type = 'text';
        itemEl.textContent = '';
        itemEl.appendChild(input);
        input.focus();
        input.select();
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            var val = input.value.trim();
            if (val && val !== file.title) {
                bridge.renameTitle(file.filePath, val);
            } else {
                itemEl.textContent = file.title || (i18n.notesUntitled || 'Untitled');
            }
        }
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { finish(); }
            if (e.key === 'Escape') { done = true; itemEl.textContent = file.title || (i18n.notesUntitled || 'Untitled'); }
        });
    }

    function startRenameFolder(headerEl, folder) {
        var titleSpan = headerEl.querySelector('.file-panel-folder-title');
        if (!titleSpan) return;

        var input = document.createElement('input');
        input.className = 'file-panel-rename-input';
        input.value = folder.title || '';
        input.type = 'text';

        var originalHtml = titleSpan.innerHTML;
        titleSpan.innerHTML = '';
        titleSpan.appendChild(input);
        input.focus();
        input.select();

        var done = false;
        function finish() {
            if (done) return;
            done = true;
            var val = input.value.trim();
            if (val && val !== folder.title) {
                bridge.renameFolder(folder.id, val);
            } else {
                titleSpan.innerHTML = originalHtml;
            }
        }
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', function(e) {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { finish(); }
            if (e.key === 'Escape') { done = true; titleSpan.innerHTML = originalHtml; }
        });
    }

    // ── コンテキストメニュー ──

    function showFileContextMenu(e, file) {
        closeContextMenu();
        contextMenu = document.createElement('div');
        contextMenu.className = 'file-panel-context-menu';
        contextMenu.style.left = e.clientX + 'px';
        contextMenu.style.top = e.clientY + 'px';

        var fileId = file.id || file.filePath.replace(/^.*[/\\]/, '').replace(/\.out$/, '');
        var currentColor = getItemColor(fileId);
        var isFav = isFavorite(fileId);

        // v0.207.37: お気に入り section 内 item は「★ Unfavorite」のみのシンプル menu
        // (e.target から最近接の .file-panel-item を辿って data-fav-section 判定)
        var clickedItem = e.target && e.target.closest ? e.target.closest('.file-panel-item') : null;
        var fromFavSection = !!(clickedItem && clickedItem.dataset && clickedItem.dataset.favSection === '1');
        if (fromFavSection) {
            addContextItem(contextMenu, i18n.notesUnfavorite || '★ Unfavorite', function() {
                closeContextMenu();
                bridge.toggleFavorite(fileId);
            });
            document.body.appendChild(contextMenu);
            setTimeout(function() { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
            return;
        }

        // クリックされた file 要素の親フォルダ ID を取得（ルート直下なら null）
        var fileItemEl = clickedItem || (listEl ? listEl.querySelector('[data-file-path="' + CSS.escape(file.filePath) + '"]') : null);
        var fileParentId = (fileItemEl && fileItemEl.dataset && fileItemEl.dataset.parentId) ? fileItemEl.dataset.parentId : null;

        // sprint 20260725: md/.out を webview 内の新しいタブで開く（file-tree 右クリック）
        addContextItem(contextMenu, i18n.notesOpenInNewTab || 'Open in new tab', function() {
            closeContextMenu();
            if (bridge && bridge.openFileInTab) { bridge.openFileInTab(file.filePath); }
        });
        addContextItem(contextMenu, i18n.notesNewOutline || 'New Outline here', function() {
            closeContextMenu();
            promptNewFile(fileParentId, fileId);
        });
        // ADR-008: 同階層に Markdown ファイルを新規作成
        addContextItem(contextMenu, i18n.notesNewMarkdownHere || 'New Markdown here', function() {
            closeContextMenu();
            promptNewMarkdownFile(fileParentId, fileId);
        });
        addContextItem(contextMenu, i18n.notesNewFolder || 'New Subfolder', function() {
            closeContextMenu();
            promptNewFolder(fileParentId, fileId);
        });
        addContextItem(contextMenu, i18n.notesRename || 'Rename', function() {
            closeContextMenu();
            var itemEl = listEl.querySelector('[data-file-path="' + CSS.escape(file.filePath) + '"]');
            if (itemEl) startRenameFile(itemEl, file);
        });
        // v0.207.36: お気に入りの追加 / 解除 toggle
        addContextItem(contextMenu, isFav ? (i18n.notesUnfavorite || '★ Unfavorite') : (i18n.notesFavorite || '☆ Add to Favorites'), function() {
            closeContextMenu();
            bridge.toggleFavorite(fileId);
        });
        // file.filePath は notesFileManager.listFiles() で path.join(mainFolderPath, entry)
        // を渡してくる絶対パス。OS clipboard へ直接コピー
        addContextItem(contextMenu, i18n.copyPath || 'Copy Path', function() {
            closeContextMenu();
            try { navigator.clipboard.writeText(file.filePath); } catch (err) { /* ignore */ }
        });
        // FR-MV-01: 別 Note へ移動 (QuickPick は host 側)。file item のみ (outliner/md)。
        addContextItem(contextMenu, i18n.notesMoveOtherNote || 'Move Other Note', function() {
            closeContextMenu();
            if (bridge.moveToOtherNote) { bridge.moveToOtherNote(file.id || fileId); }
        });
        // v11: Set Color メニュー項目 (stopProp=true でメニュー内での遷移を維持)
        addContextItem(contextMenu, i18n.notesSetColor || 'Set Color', function() {
            renderColorPalette(contextMenu, currentColor, function(colorName) {
                bridge.setItemColor(fileId, colorName);
                closeContextMenu();
            }, function() {
                // Back: 元のメニューを再構築
                showFileContextMenu(e, file);
            });
        }, false, true);
        addContextItem(contextMenu, i18n.notesDelete || 'Delete', async function() {
            closeContextMenu();
            await bridge.deleteFile(file.filePath);
        }, true);

        document.body.appendChild(contextMenu);
        setTimeout(function() { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
    }

    /** v0.207.36: 指定 file id がお気に入り登録済みかどうか */
    function isFavorite(fileId) {
        return !!(structure && Array.isArray(structure.favorites) && structure.favorites.indexOf(fileId) >= 0);
    }

    function showFolderContextMenu(e, folder) {
        closeContextMenu();
        contextMenu = document.createElement('div');
        contextMenu.className = 'file-panel-context-menu';
        contextMenu.style.left = e.clientX + 'px';
        contextMenu.style.top = e.clientY + 'px';

        var currentColor = folder.color || null;

        addContextItem(contextMenu, i18n.notesNewOutline || 'New Outline here', function() {
            closeContextMenu();
            promptNewFile(folder.id);
        });
        // ADR-008: フォルダ内に Markdown ファイルを新規作成
        addContextItem(contextMenu, i18n.notesNewMarkdownHere || 'New Markdown here', function() {
            closeContextMenu();
            promptNewMarkdownFile(folder.id);
        });
        addContextItem(contextMenu, i18n.notesNewFolder || 'New Subfolder', function() {
            closeContextMenu();
            promptNewFolder(folder.id);
        });
        addContextItem(contextMenu, i18n.notesRename || 'Rename', function() {
            closeContextMenu();
            var folderEl = listEl.querySelector('[data-folder-id="' + CSS.escape(folder.id) + '"]');
            if (folderEl) {
                var header = folderEl.querySelector('.file-panel-folder-header');
                if (header) startRenameFolder(header, folder);
            }
        });
        // v11: Set Color メニュー項目 (stopProp=true でメニュー内での遷移を維持)
        addContextItem(contextMenu, i18n.notesSetColor || 'Set Color', function() {
            renderColorPalette(contextMenu, currentColor, function(colorName) {
                bridge.setItemColor(folder.id, colorName);
                closeContextMenu();
            }, function() {
                // Back: 元のメニューを再構築
                showFolderContextMenu(e, folder);
            });
        }, false, true);
        addContextItem(contextMenu, i18n.notesDeleteFolder || 'Delete Folder', function() {
            closeContextMenu();
            bridge.deleteFolder(folder.id);
        }, true);

        document.body.appendChild(contextMenu);
        setTimeout(function() { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
    }

    function addContextItem(menu, label, onClick, danger, stopProp) {
        var item = document.createElement('div');
        item.className = 'file-panel-context-item' + (danger ? ' danger' : '');
        item.textContent = label;
        item.addEventListener('click', function(e) {
            if (stopProp) e.stopPropagation();
            onClick(e);
        });
        menu.appendChild(item);
    }

    function closeContextMenu() {
        if (contextMenu && contextMenu.parentNode) {
            contextMenu.parentNode.removeChild(contextMenu);
            contextMenu = null;
        }
    }

    // v11: カラーパレット UI をコンテキストメニュー内に描画
    function renderColorPalette(menu, currentColor, onPick, onBack) {
        // menu の innerHTML をクリアしてパレット UI に置換
        menu.innerHTML = '';

        // ← Set Color (Back ボタン)
        var backBtn = document.createElement('div');
        backBtn.className = 'file-panel-color-back';
        backBtn.textContent = '← ' + (i18n.notesSetColor || 'Set Color');
        backBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            onBack();
        });
        menu.appendChild(backBtn);

        // カラーグリッド (5x4 = 20色)
        var grid = document.createElement('div');
        grid.className = 'file-panel-color-grid';

        // NOTES_COLOR_PALETTE を参照 (グローバル window または require)
        var palette = (typeof NOTES_COLOR_PALETTE !== 'undefined')
            ? NOTES_COLOR_PALETTE
            : (typeof window !== 'undefined' && window.NOTES_COLOR_PALETTE)
                ? window.NOTES_COLOR_PALETTE
                : [];

        palette.forEach(function(c) {
            var swatch = document.createElement('div');
            swatch.className = 'file-panel-color-swatch' + (currentColor === c.name ? ' active' : '');
            swatch.style.backgroundColor = c.hex;
            swatch.dataset.color = c.name;
            swatch.title = c.name;
            swatch.addEventListener('click', function(e) {
                e.stopPropagation();
                onPick(c.name);
            });
            grid.appendChild(swatch);
        });

        menu.appendChild(grid);

        // None ボタン
        var noneBtn = document.createElement('div');
        noneBtn.className = 'file-panel-color-none';
        noneBtn.textContent = i18n.notesColorNone || 'None';
        noneBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            onPick(null);
        });
        menu.appendChild(noneBtn);
    }

    // ── Drag & Drop ──

    // v0.207.77 (D&D Feature B): outliner page-node からの drag 判定。
    // dragstart で application/x-fractal-out-node-page を setData している経路。
    var OUT_NODE_PAGE_MIME = 'application/x-fractal-out-node-page';

    function isOutNodePageDrag(e) {
        if (!e || !e.dataTransfer) return false;
        var types = Array.from(e.dataTransfer.types || []);
        return types.indexOf(OUT_NODE_PAGE_MIME) !== -1;
    }

    function readOutNodePagePayload(e) {
        try {
            var raw = e.dataTransfer.getData(OUT_NODE_PAGE_MIME);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    // node-move-to-other-outliner: outliner node（サブツリー）→ 別 .out への move 用 MIME。
    // dragstart（outliner.js）で notes モードの全 node に載る（page 有無問わず）。payload {outFileKey, nodeId}。
    var OUT_NODE_SUBTREE_MIME = 'application/x-fractal-out-node-subtree';

    function isOutNodeSubtreeDrag(e) {
        if (!e || !e.dataTransfer) return false;
        var types = Array.from(e.dataTransfer.types || []);
        return types.indexOf(OUT_NODE_SUBTREE_MIME) !== -1;
    }

    function readOutNodeSubtreePayload(e) {
        try {
            var raw = e.dataTransfer.getData(OUT_NODE_SUBTREE_MIME);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    function setupDragSource(el) {
        el.addEventListener('dragstart', function(e) {
            var target = el.closest('[data-item-id]') || el;
            dragItemId = target.dataset.itemId;
            dragItemType = target.dataset.itemType;
            dragSourceFileExt = target.dataset.fileExt || null;
            // v0.207.77: 'copyMove' にしないと、dropEffect='copy' (Feature A/B) との不一致で
            // ブラウザが drop event をキャンセルする (HTML5 D&D 仕様)。
            e.dataTransfer.effectAllowed = 'copyMove';
            // テキストを設定（VSCode webview互換）
            try { e.dataTransfer.setData('text/plain', dragItemId); } catch(err) { /* ignore */ }
            // ドラッグ中のスタイル
            setTimeout(function() { target.style.opacity = '0.4'; }, 0);
        });

        el.addEventListener('dragend', function() {
            var target = el.closest('[data-item-id]') || el;
            target.style.opacity = '';
            dragItemId = null;
            dragItemType = null;
            dragSourceFileExt = null;
            removeDropIndicator();
            lastDropLine = null; // TASK-A2: 谷間フォールバック状態もリセット
            clearAllDragOver();
        });
    }

    function setupDropTarget(el) {
        el.addEventListener('dragover', function(e) {
            // v0.207.77 (Feature B): outliner page-node からの drag を最優先で処理
            var fromOutliner = isOutNodePageDrag(e);
            // node-move-to-other-outliner: 通常 node（page なし）は subtree MIME のみ持つため、
            // ここで preventDefault しないと HTML5 D&D 仕様で drop が発火しない（HIGH-1 修正）。
            var fromOutlinerSubtree = isOutNodeSubtreeDrag(e);
            if (!dragItemId && !fromOutliner && !fromOutlinerSubtree) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';

            clearAllDragOver();
            removeDropIndicator();

            var target = el.closest('[data-item-id]') || el;
            if (!fromOutliner && !fromOutlinerSubtree && target.dataset.itemId === dragItemId) return;

            // node-move-to-other-outliner: outliner node（サブツリー）を .out item にドロップ → 別 outliner へ move
            // （page 付き node は Feature B の -out-node-page も持つが、.out item が drop 先のときは本経路を優先）
            if (
                fromOutlinerSubtree &&
                target.dataset.itemType === 'file' &&
                target.dataset.fileExt === 'out'
            ) {
                target.classList.add('file-panel-drag-over-md-into-out');
                return;
            }

            // フォルダヘッダーの場合: 上半分=前に挿入、中央=中に入れる、下半分=後に挿入
            // ファイルの場合: 上半分=前に挿入、下半分=後に挿入
            var rect = target.getBoundingClientRect();
            var y = e.clientY - rect.top;
            var ratio = y / rect.height;

            // Feature A: md ファイルを .out item にドロップ → import (中央のみ、黄色 highlight)。
            // FR-DD-01 (sprint 20260727-124904): 従来は ratio を見ず item 全域が import 扱いになり
            // 兄弟ドロップ (上/下) が不可能だったバグを、folder と同じ 0.25/0.75 の 3 ゾーンに是正
            // (ADRL-0002)。上/下 25% は fall-through して既存 before/after (兄弟挿入) を使う。
            if (
                !fromOutliner &&
                dragSourceFileExt === 'md' &&
                target.dataset.itemType === 'file' &&
                target.dataset.fileExt === 'out' &&
                ratio >= 0.25 && ratio <= 0.75
            ) {
                target.classList.add('file-panel-drag-over-md-into-out');
                return;
            }

            if (target.dataset.itemType === 'folder' || target.classList.contains('file-panel-folder-header')) {
                var folderWrapper = target.closest('.file-panel-folder') || target;
                // sprint 20260802-010347 再オープン② (TASK-06): フォルダ行の after 帯を
                // 「下端 25%」→「下端 40%」(ratio>0.60) に拡大（outliner と対称）。純粋な左右移動で
                // clientX escalation が効く帯を広げ反応性を改善。before(<0.25)/into-folder は帯境界のみ移動。
                // ファイル行（下記 else）は child 概念が無く after 帯が既に 50% と広いため 0.5 のまま。
                if (ratio < 0.25) {
                    showDropLine(target, 'before');
                } else if (ratio > 0.60) {
                    // 改善1: 最終子なら X 座標で「この階層の後ろ / 親フォルダの後ろ」を選ぶ
                    showDropLine(resolveAfterEscalation(target, e.clientX), 'after');
                } else {
                    // フォルダの中にドロップ
                    target.classList.add('file-panel-drag-over');
                }
            } else {
                if (ratio < 0.5) {
                    showDropLine(target, 'before');
                } else {
                    showDropLine(resolveAfterEscalation(target, e.clientX), 'after');
                }
            }
        });

        el.addEventListener('dragleave', function(e) {
            var target = el.closest('[data-item-id]') || el;
            target.classList.remove('file-panel-drag-over');
            target.classList.remove('file-panel-drag-over-md-into-out');
        });

        el.addEventListener('drop', function(e) {
            // v0.207.77 (Feature B): outliner page-node からの drop を最優先処理
            var outPayload = isOutNodePageDrag(e) ? readOutNodePagePayload(e) : null;
            // node-move-to-other-outliner: サブツリー move payload（notes 全 node に載る）
            var subtreePayload = isOutNodeSubtreeDrag(e) ? readOutNodeSubtreePayload(e) : null;
            e.preventDefault();
            if (!dragItemId && !outPayload && !subtreePayload) return;

            clearAllDragOver();
            removeDropIndicator();

            var target = el.closest('[data-item-id]') || el;
            if (!outPayload && !subtreePayload && target.dataset.itemId === dragItemId) return;

            var targetId = target.dataset.itemId;
            var targetType = target.dataset.itemType;
            var targetParentId = target.dataset.parentId || null;

            // node-move-to-other-outliner: node（サブツリー）→ 別 .out item への move（最優先）。
            // 移動先が .out file のときのみ本経路。それ以外（folder/md item）は下の Feature B（page-node→md 化）へ。
            if (subtreePayload && targetType === 'file' && target.dataset.fileExt === 'out') {
                var targetOutPath = target.dataset.filePath;
                // 自分自身の .out への drop は no-op（同一 outliner 内は tree D&D が担う）
                if (targetOutPath && subtreePayload.outFileKey !== targetOutPath
                    && typeof bridge.notesMoveOutNodeSubtreeIntoOut === 'function') {
                    bridge.notesMoveOutNodeSubtreeIntoOut(subtreePayload, targetOutPath);
                }
                return;
            }

            // Feature B: outliner page-node → Notes panel
            if (outPayload) {
                var rectB = target.getBoundingClientRect();
                var yB = e.clientY - rectB.top;
                var ratioB = yB / rectB.height;
                var insertParentB = null;
                var insertIndexB = 0;
                if ((targetType === 'folder' || target.classList.contains('file-panel-folder-header')) && ratioB >= 0.25 && ratioB <= 0.60) {
                    // フォルダ中央 → フォルダ内先頭
                    // sprint 20260802-010347 再オープン② (TASK-06): dragover の after 帯拡大(>0.60)と対称。
                    insertParentB = target.dataset.folderId || targetId;
                    insertIndexB = 0;
                } else {
                    insertParentB = targetParentId;
                    var siblingsB = getChildIdsOfParent(insertParentB);
                    var tIdxB = siblingsB.indexOf(targetId);
                    if (tIdxB === -1) tIdxB = siblingsB.length;
                    var aboveB = (targetType === 'folder' || target.classList.contains('file-panel-folder-header'))
                        ? ratioB < 0.25
                        : ratioB < 0.5;
                    insertIndexB = aboveB ? tIdxB : tIdxB + 1;
                }
                if (typeof bridge.notesImportOutPageNodeAsMd === 'function') {
                    bridge.notesImportOutPageNodeAsMd(outPayload, insertParentB, insertIndexB);
                }
                return;
            }

            var rect = target.getBoundingClientRect();
            var y = e.clientY - rect.top;
            var ratio = y / rect.height;

            // Feature A: md ファイル → .out item ドロップ → import。
            // FR-DD-01 (sprint 20260727-124904 / ADRL-0002): 中央 50% (ratio 0.25-0.75) のみ import。
            // 上/下 25% は fall-through して既存の兄弟挿入 (bridge.moveItem) — dragover 側の
            // 3 ゾーン表示と対で、従来「全域 import で兄弟ドロップ不可」だったバグの是正。
            if (
                dragSourceFileExt === 'md' &&
                targetType === 'file' &&
                target.dataset.fileExt === 'out' &&
                ratio >= 0.25 && ratio <= 0.75
            ) {
                if (typeof bridge.notesImportMdIntoOut === 'function') {
                    bridge.notesImportMdIntoOut(dragItemId, targetId);
                }
                return;
            }

            // フォルダヘッダーの中央にドロップ → フォルダ内に移動
            // sprint 20260802-010347 再オープン② (TASK-06): dragover の after 帯拡大(>0.60)と対称に
            // into-folder 帯を 0.25–0.60 に。下端 40% は after（兄弟挿入）へ fall-through。
            if ((targetType === 'folder' || target.classList.contains('file-panel-folder-header')) && ratio >= 0.25 && ratio <= 0.60) {
                var folderId = target.dataset.folderId || targetId;
                // 循環チェック: 自分自身のフォルダの中にはドロップしない
                if (dragItemType === 'folder' && folderId === dragItemId) return;
                bridge.moveItem(dragItemId, folderId, 0);
                return;
            }

            // 前/後に挿入
            var isBefore = (targetType === 'folder' || target.classList.contains('file-panel-folder-header')) ? ratio < 0.25 : ratio < 0.5;
            // 改善1: after は dragover の線と同じ escalation を適用 (線 = 実 drop の一致)
            if (!isBefore) {
                var esc = resolveAfterEscalation(target, e.clientX);
                if (esc !== target && esc.dataset && esc.dataset.itemId) {
                    target = esc;
                    targetId = esc.dataset.itemId;
                    targetParentId = esc.dataset.parentId || null;
                }
            }
            var parentId = targetParentId;
            var siblingIds = getChildIdsOfParent(parentId);
            var targetIndex = siblingIds.indexOf(targetId);
            if (targetIndex === -1) targetIndex = siblingIds.length;

            var insertIndex;
            if (isBefore) {
                insertIndex = targetIndex;
            } else {
                insertIndex = targetIndex + 1;
            }

            // 同じ親内の移動でドラッグ元が前にある場合、インデックス調整
            var dragCurrentParent = findParentIdOf(dragItemId);
            if (dragCurrentParent === parentId) {
                var dragCurrentIndex = siblingIds.indexOf(dragItemId);
                if (dragCurrentIndex !== -1 && dragCurrentIndex < insertIndex) {
                    insertIndex--;
                }
            }

            bridge.moveItem(dragItemId, parentId, insertIndex);
        });
    }

    /** children 内に drop-line 以外の要素があるか (空フォルダ判定) */
    function childrenHasItems(childrenEl) {
        for (var c = childrenEl.firstElementChild; c; c = c.nextElementSibling) {
            if (!c.classList || !c.classList.contains('file-panel-drop-line')) return true;
        }
        return false;
    }

    function setupFolderChildrenDrop(childrenEl, folderId) {
        childrenEl.addEventListener('dragover', function(e) {
            var fromOutliner = isOutNodePageDrag(e);
            if (!dragItemId && !fromOutliner) return;
            // 子要素がハンドルしない空エリアのみ
            if (e.target === childrenEl || e.target.className === 'file-panel-folder-children') {
                e.preventDefault();
                e.dataTransfer.dropEffect = fromOutliner ? 'copy' : 'move';
                clearAllDragOver();
                // 改善1: 子を持つフォルダの隙間では「children 全域ハイライト → 末尾追加」を廃止
                // (っっd+w が丸ごと選択される分かりづらい挙動)。直近の線を復元して線基準にする。
                if (!fromOutliner && childrenHasItems(childrenEl)) {
                    if (lastDropLine && lastDropLine.refItemId) {
                        restoreDropLineAt(e.clientX); // after は escalation 再評価 (改善1)
                    }
                    return;
                }
                childrenEl.classList.add('file-panel-drag-over');
            }
        });
        childrenEl.addEventListener('dragleave', function() {
            childrenEl.classList.remove('file-panel-drag-over');
        });
        childrenEl.addEventListener('drop', function(e) {
            if (e.target !== childrenEl && e.target.className !== 'file-panel-folder-children') return;
            var outPayload = isOutNodePageDrag(e) ? readOutNodePagePayload(e) : null;
            e.preventDefault();
            if (!dragItemId && !outPayload) return;
            clearAllDragOver();
            removeDropIndicator();
            var childIds = getChildIdsOfParent(folderId);
            if (outPayload) {
                if (typeof bridge.notesImportOutPageNodeAsMd === 'function') {
                    bridge.notesImportOutPageNodeAsMd(outPayload, folderId, childIds.length);
                }
                return;
            }
            // 改善1: 子を持つフォルダの隙間 drop は直近の線位置に挿入 (listEl フォールバックと同じ)
            if (childrenHasItems(childrenEl) && lastDropLine && lastDropLine.refItemId) {
                var refEl3 = listEl.querySelector('[data-item-id="' + lastDropLine.refItemId + '"]');
                if (refEl3 && refEl3.dataset.itemId !== dragItemId) {
                    var parentId3 = refEl3.dataset.parentId || null;
                    var sib3 = getChildIdsOfParent(parentId3);
                    var tIdx3 = sib3.indexOf(refEl3.dataset.itemId);
                    if (tIdx3 === -1) tIdx3 = sib3.length;
                    var idx3 = lastDropLine.position === 'before' ? tIdx3 : tIdx3 + 1;
                    var curParent3 = findParentIdOf(dragItemId);
                    if (curParent3 === parentId3) {
                        var curIdx3 = sib3.indexOf(dragItemId);
                        if (curIdx3 !== -1 && curIdx3 < idx3) idx3--;
                    }
                    lastDropLine = null;
                    bridge.moveItem(dragItemId, parentId3, idx3);
                    return;
                }
            }
            // 空フォルダ (or 線なし): フォルダ末尾に追加
            lastDropLine = null;
            bridge.moveItem(dragItemId, folderId, childIds.length);
        });
    }

    // TASK-A2 (sprint 20260727-124904): 直近の drop-line 状態。item 間の谷間 (margin 1px +
    // line 2px) では dragover の target が item から listEl に切り替わり、旧実装は
    // e.target!==listEl guard で preventDefault されず drop 不発 (線は残るのに失敗する =
    // 「線が嘘をつく」)。listEl 側のフォールバックがこの状態を参照して線どおりに drop させる。
    var lastDropLine = null; // { refItemId, position: 'before'|'after' } | null

    /** 谷間 (listEl / children の隙間) での線復元。after 線は X 座標の escalation を
     *  毎回再評価する — 「D の下の左寄り」は item 矩形の外に落ちることが多く、
     *  item 上の dragover を経由しないため、ここで評価しないと浅い階層 (B の後ろ) を
     *  選べない (手動検収 2026-07-27)。showDropLine が lastDropLine も更新するので
     *  drop は常に「表示中の線」どおりに落ちる。 */
    function restoreDropLineAt(clientX) {
        if (!lastDropLine || !lastDropLine.refItemId) return;
        var refEl = listEl.querySelector('[data-item-id="' + lastDropLine.refItemId + '"]');
        if (!refEl) return;
        if (lastDropLine.position === 'after') {
            refEl = resolveAfterEscalation(refEl, clientX);
        }
        showDropLine(refEl, lastDropLine.position);
    }

    // 改善1 (sprint 20260727-124904): 「フォルダ最終子の後ろ」と「フォルダ自身の後ろ (兄弟)」の
    // 曖昧さを、マウス X 座標 = インデント階層で解決する (標準的なツリー D&D の UX)。
    // hovered item がコンテナの最終子なら祖先フォルダへ escalate 候補を積み、
    // clientX が浅いインデント (左) なら浅い階層の「後ろ」を選ぶ。
    function lastRealChild(containerEl) {
        for (var c = containerEl.lastElementChild; c; c = c.previousElementSibling) {
            if (c.classList && c.classList.contains('file-panel-drop-line')) continue;
            if (c.dataset && c.dataset.itemId) return c;
        }
        return null;
    }

    function resolveAfterEscalation(targetEl, clientX) {
        // まず「展開中フォルダの最終子孫」まで下る (lastDropLine が浅い階層 = B を指した後、
        // 右へ動かして深い階層 = D の後ろに戻れるように。チェーンを両方向に張る)
        var deepest = targetEl;
        while (deepest && deepest.classList && deepest.classList.contains('file-panel-folder') &&
               !deepest.classList.contains('collapsed')) {
            var childrenEl0 = deepest.querySelector(':scope > .file-panel-folder-children');
            var lastChild = childrenEl0 ? lastRealChild(childrenEl0) : null;
            if (!lastChild) break;
            deepest = lastChild;
        }
        // deepest から祖先へ「最終子である限り」escalate 候補を積む
        var chain = [deepest];
        var cur = deepest;
        while (true) {
            // drop-line を無視して「コンテナの最終要素か」を判定
            var next = cur.nextElementSibling;
            while (next && next.classList && next.classList.contains('file-panel-drop-line')) {
                next = next.nextElementSibling;
            }
            if (next) break; // 最終子でない → これ以上 escalate しない
            var wrapper = cur.parentElement && cur.parentElement.closest
                ? cur.parentElement.closest('.file-panel-folder') : null;
            if (!wrapper || wrapper === cur || !wrapper.dataset || !wrapper.dataset.itemId) break;
            chain.push(wrapper);
            cur = wrapper;
        }
        if (chain.length === 1) return chain[0];
        // 深い方 (インデント大 = left 大) から見て、cursor X がその左端以上なら採用。
        // item は block 幅いっぱいなので左端 = children padding の開始位置 = 階層の視覚境界
        for (var i = 0; i < chain.length; i++) {
            if (clientX >= chain[i].getBoundingClientRect().left) return chain[i];
        }
        return chain[chain.length - 1]; // 最も左でも届かなければ最浅
    }

    function showDropLine(refEl, position) {
        removeDropIndicator();
        dropIndicator = document.createElement('div');
        dropIndicator.className = 'file-panel-drop-line';
        if (position === 'before') {
            refEl.parentNode.insertBefore(dropIndicator, refEl);
        } else {
            refEl.parentNode.insertBefore(dropIndicator, refEl.nextSibling);
        }
        var refItem = refEl.closest ? (refEl.closest('[data-item-id]') || refEl) : refEl;
        lastDropLine = refItem && refItem.dataset ? { refItemId: refItem.dataset.itemId, position: position } : null;
    }

    function removeDropIndicator() {
        if (dropIndicator && dropIndicator.parentNode) {
            dropIndicator.parentNode.removeChild(dropIndicator);
        }
        dropIndicator = null;
        // lastDropLine は消さない (谷間フォールバックの参照用。dragend / 実 drop でリセット)
    }

    function clearAllDragOver() {
        var els = listEl.querySelectorAll('.file-panel-drag-over');
        for (var i = 0; i < els.length; i++) {
            els[i].classList.remove('file-panel-drag-over');
        }
        var els2 = listEl.querySelectorAll('.file-panel-drag-over-md-into-out');
        for (var j = 0; j < els2.length; j++) {
            els2[j].classList.remove('file-panel-drag-over-md-into-out');
        }
    }

    // ── ヘルパー ──

    // v11: item の color を structure から取得
    function getItemColor(itemId) {
        if (!structure || !structure.items || !structure.items[itemId]) return null;
        return structure.items[itemId].color || null;
    }

    function getChildIdsOfParent(parentId) {
        if (!structure) return [];
        if (!parentId) return structure.rootIds || [];
        var item = structure.items[parentId];
        if (item && item.type === 'folder') return item.childIds || [];
        return [];
    }

    function findParentIdOf(itemId) {
        if (!structure) return null;
        if (structure.rootIds && structure.rootIds.indexOf(itemId) !== -1) return null;
        for (var id in structure.items) {
            var item = structure.items[id];
            if (item.type === 'folder' && item.childIds && item.childIds.indexOf(itemId) !== -1) {
                return id;
            }
        }
        return null;
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── 新規作成プロンプト ──

    // afterId が渡された場合、そのアイテムの直後に input row を表示し、
    // 確定時には bridge.createFile に afterId を渡してその直後に挿入させる。
    function promptNewFile(parentId, afterId) {
        var inputRow = document.createElement('div');
        inputRow.className = 'file-panel-item active';
        var input = document.createElement('input');
        input.className = 'file-panel-rename-input';
        input.type = 'text';
        input.value = '';
        input.placeholder = 'Enter title...';
        inputRow.appendChild(input);

        insertPromptRow(inputRow, parentId, afterId);
        input.focus();

        var done = false;
        function finish() {
            if (done) return;
            done = true;
            var val = input.value.trim();
            if (inputRow.parentNode) inputRow.parentNode.removeChild(inputRow);
            if (val) {
                bridge.createFile(val, parentId || null, afterId || null);
            }
        }
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { finish(); }
            if (e.key === 'Escape') { done = true; if (inputRow.parentNode) inputRow.parentNode.removeChild(inputRow); }
        });
    }

    // ADR-008: Markdown ファイル新規作成プロンプト
    function promptNewMarkdownFile(parentId, afterId) {
        if (!bridge.createMarkdownFile) {
            // 古い host bridge への安全弁
            return;
        }
        var inputRow = document.createElement('div');
        inputRow.className = 'file-panel-item active is-md';
        var iconWrap = document.createElement('span');
        iconWrap.innerHTML = ICON_FILE_MD;
        inputRow.appendChild(iconWrap.firstChild);
        var input = document.createElement('input');
        input.className = 'file-panel-rename-input';
        input.type = 'text';
        input.value = '';
        input.placeholder = 'Markdown title...';
        inputRow.appendChild(input);

        insertPromptRow(inputRow, parentId, afterId);
        input.focus();

        var done = false;
        function finish() {
            if (done) return;
            done = true;
            var val = input.value.trim();
            if (inputRow.parentNode) inputRow.parentNode.removeChild(inputRow);
            if (val) {
                bridge.createMarkdownFile(val, parentId || null, afterId || null);
            }
        }
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { finish(); }
            if (e.key === 'Escape') { done = true; if (inputRow.parentNode) inputRow.parentNode.removeChild(inputRow); }
        });
    }

    function promptNewFolder(parentId, afterId) {
        var inputRow = document.createElement('div');
        inputRow.className = 'file-panel-folder-header';
        inputRow.style.margin = '1px 4px';
        var input = document.createElement('input');
        input.className = 'file-panel-rename-input';
        input.type = 'text';
        input.value = '';
        input.placeholder = 'Folder name...';
        inputRow.appendChild(input);

        insertPromptRow(inputRow, parentId, afterId);
        input.focus();

        var done = false;
        function finish() {
            if (done) return;
            done = true;
            var val = input.value.trim();
            if (inputRow.parentNode) inputRow.parentNode.removeChild(inputRow);
            if (val) {
                bridge.createFolder(val, parentId || null, afterId || null);
            }
        }
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { finish(); }
            if (e.key === 'Escape') { done = true; if (inputRow.parentNode) inputRow.parentNode.removeChild(inputRow); }
        });
    }

    // 入力行を DOM に挿入する位置決定ロジック:
    //   afterId 指定 → そのアイテム要素の直後
    //   parentId 指定 → そのフォルダの children 先頭
    //   どちらも null → ルートリストの先頭
    function insertPromptRow(inputRow, parentId, afterId) {
        if (afterId) {
            var anchor = listEl.querySelector('[data-item-id="' + CSS.escape(afterId) + '"]');
            if (anchor && anchor.parentNode) {
                anchor.parentNode.insertBefore(inputRow, anchor.nextSibling);
                return;
            }
        }
        if (parentId) {
            var folderEl = listEl.querySelector('[data-folder-id="' + CSS.escape(parentId) + '"]');
            if (folderEl) {
                var childrenEl = folderEl.querySelector('.file-panel-folder-children');
                if (childrenEl) {
                    childrenEl.insertBefore(inputRow, childrenEl.firstChild);
                    return;
                }
            }
        }
        listEl.insertBefore(inputRow, listEl.firstChild);
    }

    // ── 検索 ──

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function switchTab(tabName) {
        currentTab = tabName;
        // タブボタンのactive切替
        if (panelEl) {
            var tabs = panelEl.querySelectorAll('.file-panel-tab');
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i].dataset.tab === tabName) {
                    tabs[i].classList.add('active');
                } else {
                    tabs[i].classList.remove('active');
                }
            }
        }
        // コンテンツ表示切替
        var notesContent = document.getElementById('filePanelContentNotes');
        var searchContent = document.getElementById('filePanelContentSearch');
        var toolsContent = document.getElementById('filePanelContentTools');
        if (notesContent) notesContent.style.display = tabName === 'notes' ? '' : 'none';
        if (searchContent) searchContent.style.display = tabName === 'search' ? '' : 'none';
        if (toolsContent) toolsContent.style.display = tabName === 'tools' ? '' : 'none';
        if (tabName === 'search' && searchInputEl) searchInputEl.focus();
        if (tabName === 'tools' && bridge.s3GetStatus) bridge.s3GetStatus();
    }

    function executeSearch() {
        if (!searchInputEl || !bridge.search) return;
        var query = searchInputEl.value.trim();
        if (!query) return;
        bridge.search(query, searchOptions);
    }

    var searchSectionOut = null;
    var searchSectionMd = null;
    var searchSectionExplore = null;
    var searchSectionOutBody = null;
    var searchSectionMdBody = null;
    var searchSectionExploreBody = null;
    var searchSectionOutTitle = null;
    var searchSectionMdTitle = null;
    var searchSectionExploreTitle = null;
    var searchCountOut = 0;
    var searchCountMd = 0;
    var searchCountExplore = 0;

    function buildSearchSection(label) {
        var section = document.createElement('div');
        section.className = 'file-panel-search-section';
        section.style.display = 'none';
        var title = document.createElement('div');
        title.className = 'file-panel-search-section-title';
        title.textContent = label;
        var body = document.createElement('div');
        section.appendChild(title);
        section.appendChild(body);
        return { section: section, body: body, title: title };
    }

    function onSearchStart(searchId) {
        currentSearchId = searchId;
        searchTotalCount = 0;
        searchCountOut = 0;
        searchCountMd = 0;
        searchCountExplore = 0;
        if (searchResultsEl) {
            searchResultsEl.innerHTML = '';
            var exploreSec = buildSearchSection((i18n.notesSearchExploreResults || 'Notes Exploreの検索結果'));
            var outSec = buildSearchSection((i18n.notesSearchOutlinerResults || 'Outlinerの検索結果'));
            var mdSec = buildSearchSection((i18n.notesSearchMarkdownResults || 'Markdownの検索結果'));
            searchSectionExplore = exploreSec.section;
            searchSectionExploreBody = exploreSec.body;
            searchSectionExploreTitle = exploreSec.title;
            searchSectionOut = outSec.section;
            searchSectionOutBody = outSec.body;
            searchSectionOutTitle = outSec.title;
            searchSectionMd = mdSec.section;
            searchSectionMdBody = mdSec.body;
            searchSectionMdTitle = mdSec.title;
            searchResultsEl.appendChild(searchSectionExplore);
            searchResultsEl.appendChild(searchSectionOut);
            searchResultsEl.appendChild(searchSectionMd);

            // Render explore (file/folder name) results immediately (client-side).
            // The backend streaming search covers content; this section covers names only.
            renderExploreResults();
        }
        if (searchCountEl) searchCountEl.textContent = i18n.notesSearching || 'Searching...';
    }

    /** Collect file/folder name matches against searchInputEl.value, render into
     *  the Explore section. Respects searchOptions (caseSensitive / wholeWord / useRegex). */
    function renderExploreResults() {
        if (!searchInputEl || !structure || !searchSectionExploreBody) return;
        var query = searchInputEl.value.trim();
        if (!query) return;

        var matcher = buildNameMatcher(query);
        if (!matcher) return;

        var matches = []; // [{ id, type: 'file'|'folder', title, filePath?, fileExt? }]
        var fileMap = buildFileMap(fileList);

        Object.keys(structure.items || {}).forEach(function(id) {
            var item = structure.items[id];
            if (!item) return;
            if (item.type === 'folder') {
                var t = item.title || '';
                if (matcher(t)) {
                    matches.push({ id: id, type: 'folder', title: t });
                }
            } else if (item.type === 'file') {
                var fileEntry = fileMap[id];
                var title = (item.title) || (fileEntry && fileEntry.title) || '';
                if (matcher(title)) {
                    var fp = fileEntry ? fileEntry.filePath : null;
                    var isMd = fp ? /\.md$/i.test(fp) : false;
                    matches.push({
                        id: id, type: 'file', title: title, filePath: fp,
                        fileExt: isMd ? 'md' : 'out',
                    });
                }
            }
        });

        if (matches.length === 0) {
            updateExploreSectionTitle();
            return;
        }

        searchSectionExplore.style.display = '';
        matches.forEach(function(m) {
            var matchEl = document.createElement('div');
            matchEl.className = 'file-panel-search-match';
            // Title (highlighted) + small badge for type
            matchEl.innerHTML = highlightSearchText(m.title || (i18n.notesUntitled || 'Untitled'), query);
            var badge = document.createElement('span');
            badge.style.cssText = 'opacity:0.5;font-size:10px;margin-left:4px;';
            badge.textContent = '[' + (m.type === 'folder' ? 'folder' : (m.fileExt || 'file')) + ']';
            matchEl.appendChild(badge);
            matchEl.addEventListener('click', function() {
                jumpToExploreItem(m);
            });
            searchSectionExploreBody.appendChild(matchEl);
            searchCountExplore++;
            searchTotalCount++;
        });
        updateExploreSectionTitle();
    }

    function updateExploreSectionTitle() {
        var base = i18n.notesSearchExploreResults || 'Notes Exploreの検索結果';
        if (searchSectionExploreTitle) {
            searchSectionExploreTitle.textContent = base + ' (' + searchCountExplore + ')';
        }
    }

    function buildNameMatcher(query) {
        try {
            var pattern = searchOptions.useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (searchOptions.wholeWord) pattern = '\\b' + pattern + '\\b';
            var flags = searchOptions.caseSensitive ? '' : 'i';
            var re = new RegExp(pattern, flags);
            return function(text) { return re.test(text || ''); };
        } catch (e) {
            return null;
        }
    }

    /** Switch to Notes tab, expand ancestor folders, scroll target into view, flash yellow. */
    function jumpToExploreItem(m) {
        switchTab('notes');
        if (!m || !m.id) return;
        // Expand ancestor folders (collapsed=false) so the target is visible
        expandAncestorFolders(m.id);
        // Defer to next frame so renderTree() has propagated any collapse state changes
        setTimeout(function() {
            var sel = m.type === 'folder'
                ? '[data-folder-id="' + CSS.escape(m.id) + '"] > .file-panel-folder-header'
                : '[data-item-id="' + CSS.escape(m.id) + '"]';
            var el = listEl ? listEl.querySelector(sel) : null;
            if (!el) return;
            if (typeof el.scrollIntoView === 'function') {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            el.classList.remove('file-panel-explore-flash');
            // Force reflow so re-adding the class restarts the animation
            void el.offsetWidth;
            el.classList.add('file-panel-explore-flash');
            setTimeout(function() {
                el.classList.remove('file-panel-explore-flash');
            }, 2200);
        }, 50);
    }

    function expandAncestorFolders(itemId) {
        if (!structure) return;
        var changed = false;
        var cursor = findParentIdOf(itemId);
        var safety = 0;
        while (cursor && safety++ < 100) {
            var folder = structure.items ? structure.items[cursor] : null;
            if (folder && folder.collapsed) {
                folder.collapsed = false;
                changed = true;
                // Notify host so the toggled state is persisted
                if (bridge && bridge.toggleFolder) bridge.toggleFolder(cursor);
            }
            cursor = findParentIdOf(cursor);
        }
        if (changed) renderTree();
    }

    function onSearchPartial(searchId, fileResult) {
        if (searchId !== currentSearchId) return;
        if (!searchResultsEl || !searchInputEl) return;

        var isMd = fileResult.fileType === 'md';
        var parentBody = isMd ? searchSectionMdBody : searchSectionOutBody;
        var parentSection = isMd ? searchSectionMd : searchSectionOut;
        if (!parentBody) return;
        parentSection.style.display = '';

        var groupEl = document.createElement('div');
        groupEl.className = 'file-panel-search-file-group';

        var headerEl = document.createElement('div');
        headerEl.className = 'file-panel-search-file-header' + (isMd ? ' is-md' : '');
        headerEl.textContent = fileResult.fileTitle + ' (' + fileResult.matches.length + ')';
        groupEl.appendChild(headerEl);

        var query = searchInputEl.value.trim();
        fileResult.matches.forEach(function(match, matchIdx) {
            var matchEl = document.createElement('div');
            matchEl.className = 'file-panel-search-match';
            matchEl.innerHTML = highlightSearchText(match.lineText, query);
            if (match.field !== 'text') {
                var badge = document.createElement('span');
                badge.style.cssText = 'opacity:0.5;font-size:10px;margin-left:4px;';
                badge.textContent = '[' + match.field + ']';
                matchEl.appendChild(badge);
            }
            matchEl.addEventListener('click', function() {
                if (fileResult.fileType === 'out' && match.nodeId && bridge.jumpToNode) {
                    bridge.jumpToNode(fileResult.fileId, match.nodeId);
                } else if (fileResult.fileType === 'md') {
                    if (fileResult.parentOutFileId && fileResult.pageId && bridge.jumpToMdPage) {
                        bridge.jumpToMdPage(fileResult.parentOutFileId, fileResult.pageId, match.lineNumber || 0, query, matchIdx);
                    } else if (fileResult.mdFilePath && bridge.openFile) {
                        // root-level .md は notes editor 内の markdown pane で開く
                        // (旧実装は openMdFileExternal で VSCode 標準エディタ起動だったが、
                        //  notes editor の content として表示するのが期待動作)。
                        // query/occurrence を渡すと、ロード後にヒット箇所へジャンプ + 黄色ハイライト。
                        if (fileResult.mdFilePath !== currentFile) {
                            currentFile = fileResult.mdFilePath;
                        }
                        bridge.openFile(fileResult.mdFilePath, query, matchIdx);
                    }
                }
            });
            groupEl.appendChild(matchEl);
            searchTotalCount++;
            if (isMd) searchCountMd++; else searchCountOut++;
        });

        parentBody.appendChild(groupEl);

        // セクションタイトルに件数反映
        var outBase = i18n.notesSearchOutlinerResults || 'Outlinerの検索結果';
        var mdBase = i18n.notesSearchMarkdownResults || 'Markdownの検索結果';
        if (searchSectionOutTitle) searchSectionOutTitle.textContent = outBase + ' (' + searchCountOut + ')';
        if (searchSectionMdTitle) searchSectionMdTitle.textContent = mdBase + ' (' + searchCountMd + ')';
    }

    function onSearchEnd(searchId) {
        if (searchId !== currentSearchId) return;
        if (searchCountEl) {
            searchCountEl.textContent = searchTotalCount + ' ' + (i18n.notesResults || 'results');
        }
    }

    function highlightSearchText(text, query) {
        var escaped = escapeHtml(text);
        if (!query) return escaped;
        try {
            var pattern = searchOptions.useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (searchOptions.wholeWord) pattern = '\\b' + pattern + '\\b';
            var flags = searchOptions.caseSensitive ? 'g' : 'gi';
            var re = new RegExp('(' + pattern + ')', flags);
            return escaped.replace(re, '<span class="file-panel-search-highlight">$1</span>');
        } catch (e) {
            return escaped;
        }
    }

    function setupSearch() {
        searchInputEl = document.getElementById('notesSearchInput');
        searchResultsEl = document.getElementById('notesSearchResults');
        searchCountEl = document.getElementById('notesSearchCount');

        if (searchInputEl) {
            searchInputEl.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                    executeSearch();
                } else if (e.key === 'Escape') {
                    switchTab('notes');
                }
            });
        }

        // Option toggles
        var caseBtn = document.getElementById('notesSearchCase');
        var wordBtn = document.getElementById('notesSearchWord');
        var regexBtn = document.getElementById('notesSearchRegex');

        function toggleOpt(btn, key) {
            if (!btn) return;
            btn.addEventListener('click', function() {
                searchOptions[key] = !searchOptions[key];
                btn.classList.toggle('active', searchOptions[key]);
            });
        }
        toggleOpt(caseBtn, 'caseSensitive');
        toggleOpt(wordBtn, 'wholeWord');
        toggleOpt(regexBtn, 'useRegex');

        // Search result listeners
        if (bridge.onSearchStart) {
            bridge.onSearchStart(onSearchStart);
        }
        if (bridge.onSearchPartial) {
            bridge.onSearchPartial(onSearchPartial);
        }
        if (bridge.onSearchEnd) {
            bridge.onSearchEnd(onSearchEnd);
        }
    }

    // ── 初期化 ──

    // ── Panel Resize ──

    function setupPanelResize() {
        resizeHandle = document.getElementById('notesResizeHandle');
        if (!resizeHandle || !panelEl) return;

        resizeHandle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartWidth = panelEl.offsetWidth;
            resizeHandle.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onPanelResizeMove);
            document.addEventListener('mouseup', onPanelResizeEnd);
        });
    }

    function onPanelResizeMove(e) {
        if (!isResizing || !panelEl) return;
        var newWidth = resizeStartWidth + (e.clientX - resizeStartX);
        var maxWidth = window.innerWidth * PANEL_MAX_WIDTH_RATIO;

        if (newWidth < PANEL_MIN_WIDTH - 40) {
            panelEl.style.opacity = '0.5';
            return;
        }
        panelEl.style.opacity = '';
        newWidth = Math.max(PANEL_MIN_WIDTH, Math.min(newWidth, maxWidth));
        panelEl.style.width = newWidth + 'px';
    }

    function onPanelResizeEnd() {
        if (!isResizing) return;
        isResizing = false;
        if (resizeHandle) resizeHandle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onPanelResizeMove);
        document.removeEventListener('mouseup', onPanelResizeEnd);

        if (!panelEl) return;
        panelEl.style.opacity = '';
        var finalWidth = panelEl.offsetWidth;
        if (finalWidth < PANEL_MIN_WIDTH) {
            panelEl.style.width = '';  // インラインstyleクリア
            bridge.togglePanel(true);
            panelEl.classList.add('collapsed');
        } else {
            lastSavedPanelWidth = finalWidth;
            if (bridge.savePanelWidth) {
                bridge.savePanelWidth(finalWidth);
            }
        }
    }

    function init(noteBridge, initialFileList, initialCurrentFile, initialStructure, initialPanelWidth, initialNoteFolderName) {
        bridge = noteBridge;
        fileList = initialFileList || [];
        currentFile = initialCurrentFile || null;
        structure = initialStructure || null;
        noteFolderName = initialNoteFolderName || '';  // FR-NT-01

        listEl = document.getElementById('notesFileList');
        panelEl = document.getElementById('notesFilePanel');
        var addBtn = document.getElementById('filePanelAdd');
        var addMdBtn = document.getElementById('filePanelAddMarkdown');
        var addFolderBtn = document.getElementById('filePanelAddFolder');
        var collapseBtn = document.getElementById('filePanelCollapse');

        // 初期パネル幅復元
        if (initialPanelWidth) {
            lastSavedPanelWidth = initialPanelWidth;
            if (panelEl && !panelEl.classList.contains('collapsed')) {
                panelEl.style.width = initialPanelWidth + 'px';
            }
        }

        if (addBtn) {
            addBtn.addEventListener('click', function() {
                promptNewFile(null);
            });
        }

        if (addMdBtn) {
            addMdBtn.addEventListener('click', function() {
                promptNewMarkdownFile(null);
            });
        }

        if (addFolderBtn) {
            addFolderBtn.addEventListener('click', function() {
                promptNewFolder(null);
            });
        }

        var todayBtn = document.getElementById('filePanelToday');
        if (todayBtn) {
            todayBtn.addEventListener('click', function() {
                if (bridge.openDailyNotes) bridge.openDailyNotes();
            });
        }

        // v0.207.37: お気に入り section ref (Notes タブ直下、空なら hidden)
        favoritesEl = document.getElementById('notesFavoritesList');

        var cleanupCurrentBtn = document.getElementById('filePanelCleanupCurrent');
        if (cleanupCurrentBtn) {
            cleanupCurrentBtn.addEventListener('click', function() {
                if (bridge.cleanupUnusedFilesCurrentNote) bridge.cleanupUnusedFilesCurrentNote();
            });
        }

        var cleanupToolsBtn = document.getElementById('filePanelCleanupTools');
        if (cleanupToolsBtn) {
            cleanupToolsBtn.addEventListener('click', function() {
                if (bridge.cleanupUnusedFilesAllNotes) bridge.cleanupUnusedFilesAllNotes();
            });
        }

        // v0.207.25: Custom Terminology を Amazon Translate に upload
        var updateTermBtn = document.getElementById('filePanelUpdateTranslateTerminology');
        if (updateTermBtn) {
            updateTermBtn.addEventListener('click', function() {
                if (bridge.updateTranslateTerminology) bridge.updateTranslateTerminology();
            });
        }

        if (collapseBtn) {
            collapseBtn.addEventListener('click', function() {
                if (panelEl) {
                    panelEl.style.width = '';  // インラインstyleクリア（CSS classが効くように）
                    panelEl.classList.add('collapsed');
                }
                bridge.togglePanel(true);
            });
        }

        // markdown pane の DOM は updateData で再生成されるため、
        // 個別 button.addEventListener では listener が剥がれる。
        // document に event delegation で張って、再生成後の button も拾う。
        document.addEventListener('click', function(e) {
            var t = e.target;
            if (!t) return;
            var btn = t.closest ? t.closest('.notes-panel-toggle-btn') : null;
            if (!btn) return;
            if (panelEl) {
                panelEl.classList.remove('collapsed');
                if (lastSavedPanelWidth) {
                    panelEl.style.width = lastSavedPanelWidth + 'px';
                }
            }
            bridge.togglePanel(false);
        });

        // FR-NT-01/02: note タイトル見出しの初期化 + inline 編集バインド
        titleLabelEl = document.getElementById('notesTitleLabel');
        if (titleLabelEl) {
            titleLabelEl.addEventListener('click', function() { beginNoteTitleEdit(); });
        }
        renderNoteTitle();

        // Listen for file list + structure updates
        if (bridge.onFileListChanged) {
            bridge.onFileListChanged(function(newList, newCurrentFile, newStructure, newNoteFolderName) {
                fileList = newList;
                if (newCurrentFile) currentFile = newCurrentFile;
                if (newStructure) structure = newStructure;
                if (typeof newNoteFolderName === 'string') noteFolderName = newNoteFolderName;
                renderNoteTitle();  // FR-NT-01: タイトル更新
                renderTree();
            });
        }

        // ルートエリアへのD&D（アイテム間の空白部分）
        // TASK-A2: init が複数回呼ばれる環境 (standalone harness は build 時 + spec で 2 回) で
        // listEl リスナーが二重登録され moveItem が 2 発火するため冪等化 (要素フラグで 1 回だけ。
        // v1.1.0 TASK-07 の task ボタン onclick 化と同族の対処)。
        if (listEl && !listEl.__rootDropWired) {
            listEl.__rootDropWired = true;
            listEl.addEventListener('dragover', function(e) {
                var fromOutliner = isOutNodePageDrag(e);
                if (!dragItemId && !fromOutliner) return;
                // 子要素が既にハンドルしている場合はスキップ
                if (e.target !== listEl) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = fromOutliner ? 'copy' : 'move';
                // TASK-A2: item 間の谷間では直近の drop-line を復元表示 (線と drop 可否を一致させる)。
                // after 線は X 座標の escalation を毎回再評価 (改善1: 谷間でも階層を選べる)。
                if (!fromOutliner && lastDropLine && lastDropLine.refItemId) {
                    restoreDropLineAt(e.clientX);
                }
            });
            listEl.addEventListener('drop', function(e) {
                if (e.target !== listEl) return;
                var outPayload = isOutNodePageDrag(e) ? readOutNodePagePayload(e) : null;
                e.preventDefault();
                if (!dragItemId && !outPayload) return;
                clearAllDragOver();
                removeDropIndicator();
                var rootIds = structure ? structure.rootIds : [];
                if (outPayload) {
                    if (typeof bridge.notesImportOutPageNodeAsMd === 'function') {
                        bridge.notesImportOutPageNodeAsMd(outPayload, null, rootIds.length);
                    }
                    return;
                }
                // TASK-A2: 谷間 drop は「表示中だった線」の位置に挿入する (線と実 drop の一致)。
                if (lastDropLine && lastDropLine.refItemId) {
                    var refEl1 = listEl.querySelector('[data-item-id="' + lastDropLine.refItemId + '"]');
                    if (refEl1 && refEl1.dataset.itemId !== dragItemId) {
                        var parentId1 = refEl1.dataset.parentId || null;
                        var sib1 = getChildIdsOfParent(parentId1);
                        var tIdx1 = sib1.indexOf(refEl1.dataset.itemId);
                        if (tIdx1 === -1) tIdx1 = sib1.length;
                        var idx1 = lastDropLine.position === 'before' ? tIdx1 : tIdx1 + 1;
                        var curParent1 = findParentIdOf(dragItemId);
                        if (curParent1 === parentId1) {
                            var curIdx1 = sib1.indexOf(dragItemId);
                            if (curIdx1 !== -1 && curIdx1 < idx1) idx1--;
                        }
                        lastDropLine = null;
                        bridge.moveItem(dragItemId, parentId1, idx1);
                        return;
                    }
                }
                lastDropLine = null;
                // ルート末尾に追加
                bridge.moveItem(dragItemId, null, rootIds.length);
            });
        }

        // Tab navigation
        var tabBtns = panelEl ? panelEl.querySelectorAll('.file-panel-tab') : [];
        for (var ti = 0; ti < tabBtns.length; ti++) {
            (function(btn) {
                btn.addEventListener('click', function() {
                    switchTab(btn.dataset.tab);
                });
            })(tabBtns[ti]);
        }

        // Search
        setupSearch();

        // S3
        setupS3();

        // Panel resize
        setupPanelResize();

        // Initial render
        renderTree();
    }

    // ── S3 Confirm Dialog (confirm() は VSCode webview sandbox で使えない) ──

    function showS3ConfirmDialog(title, message, onConfirm) {
        // 既存ダイアログがあれば削除
        var existing = document.getElementById('s3ConfirmOverlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 's3ConfirmOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';

        var dialog = document.createElement('div');
        dialog.style.cssText = 'background:var(--outliner-bg,#fff);border:1px solid var(--outliner-border,#ccc);border-radius:8px;padding:20px;max-width:400px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,0.3);';

        var titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:8px;color:#c44;';
        titleEl.textContent = title;

        var msgEl = document.createElement('div');
        msgEl.style.cssText = 'font-size:13px;margin-bottom:16px;line-height:1.5;';
        msgEl.textContent = message;

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = i18n.notesS3Cancel || 'Cancel';
        cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid var(--outliner-border,#ccc);border-radius:4px;background:transparent;color:inherit;cursor:pointer;font-size:13px;';
        cancelBtn.addEventListener('click', function() { overlay.remove(); });

        var confirmBtn = document.createElement('button');
        confirmBtn.textContent = i18n.notesS3Continue || 'Continue';
        confirmBtn.style.cssText = 'padding:6px 16px;border:none;border-radius:4px;background:#c44;color:#fff;cursor:pointer;font-size:13px;font-weight:500;';
        confirmBtn.addEventListener('click', function() { overlay.remove(); onConfirm(); });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(confirmBtn);
        dialog.appendChild(titleEl);
        dialog.appendChild(msgEl);
        dialog.appendChild(btnRow);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Escキーでキャンセル
        overlay.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') overlay.remove();
        });
        cancelBtn.focus();
    }

    // ── S3 Tab ──

    var s3Operating = false;

    function setupS3() {
        var bucketInput = document.getElementById('s3BucketPathInput');
        var savePathBtn = document.getElementById('s3SavePath');
        var statusEl = document.getElementById('s3CredentialStatus');
        var syncBtn = document.getElementById('s3BtnSync');
        var remoteDeleteBtn = document.getElementById('s3BtnRemoteDeleteUpload');
        var localDeleteBtn = document.getElementById('s3BtnLocalDeleteDownload');
        var progressEl = document.getElementById('s3Progress');
        var progressMsg = document.getElementById('s3ProgressMessage');
        var progressDetail = document.getElementById('s3ProgressDetail');

        if (!bucketInput || !bridge) return;

        function setS3ButtonsEnabled(enabled) {
            var hasBucket = bucketInput && bucketInput.value.trim().length > 0;
            var isEnabled = enabled && hasBucket;
            if (syncBtn) syncBtn.disabled = !isEnabled;
            if (remoteDeleteBtn) remoteDeleteBtn.disabled = !isEnabled;
            if (localDeleteBtn) localDeleteBtn.disabled = !isEnabled;
        }

        // Save bucket path
        if (savePathBtn) {
            savePathBtn.addEventListener('click', function() {
                var val = bucketInput.value.trim();
                if (val && bridge.s3SaveBucketPath) {
                    bridge.s3SaveBucketPath(val);
                    if (statusEl) {
                        statusEl.textContent = 'Bucket path saved.';
                        statusEl.className = 's3-status ok';
                    }
                    setS3ButtonsEnabled(true);
                }
            });
        }

        // Enable/disable buttons on input change
        bucketInput.addEventListener('input', function() {
            if (!s3Operating) setS3ButtonsEnabled(true);
        });

        // Sync button
        if (syncBtn) {
            syncBtn.addEventListener('click', function() {
                var bp = bucketInput.value.trim();
                if (!bp || s3Operating) return;
                s3Operating = true;
                setS3ButtonsEnabled(false);
                if (progressEl) progressEl.style.display = '';
                if (progressMsg) progressMsg.textContent = 'Starting sync...';
                if (progressDetail) progressDetail.textContent = '';
                if (bridge.s3Sync) bridge.s3Sync(bp);
            });
        }

        // Remote Delete & Upload button
        if (remoteDeleteBtn) {
            remoteDeleteBtn.addEventListener('click', function() {
                var bp = bucketInput.value.trim();
                if (!bp || s3Operating) return;
                showS3ConfirmDialog(
                    'Remote Delete & Upload',
                    'This will DELETE all remote data in s3://' + bp + ' and upload local data.',
                    function() {
                        s3Operating = true;
                        setS3ButtonsEnabled(false);
                        if (progressEl) progressEl.style.display = '';
                        if (progressMsg) progressMsg.textContent = 'Starting remote delete & upload...';
                        if (progressDetail) progressDetail.textContent = '';
                        if (bridge.s3RemoteDeleteAndUpload) bridge.s3RemoteDeleteAndUpload(bp);
                    }
                );
            });
        }

        // Local Delete & Download button
        if (localDeleteBtn) {
            localDeleteBtn.addEventListener('click', function() {
                var bp = bucketInput.value.trim();
                if (!bp || s3Operating) return;
                showS3ConfirmDialog(
                    'Local Delete & Download',
                    'This will DELETE all local files and download from s3://' + bp + '.',
                    function() {
                        s3Operating = true;
                        setS3ButtonsEnabled(false);
                        if (progressEl) progressEl.style.display = '';
                        if (progressMsg) progressMsg.textContent = 'Starting local delete & download...';
                        if (progressDetail) progressDetail.textContent = '';
                        if (bridge.s3LocalDeleteAndDownload) bridge.s3LocalDeleteAndDownload(bp);
                    }
                );
            });
        }

        // Progress listener
        if (bridge.onS3Progress) {
            bridge.onS3Progress(function(data) {
                if (progressMsg) progressMsg.textContent = data.message || '';
                if (progressDetail) progressDetail.textContent = data.currentFile || '';
                if (data.phase === 'complete' || data.phase === 'error') {
                    s3Operating = false;
                    setS3ButtonsEnabled(true);
                    if (data.phase === 'complete') {
                        if (statusEl) {
                            statusEl.textContent = data.message;
                            statusEl.className = 's3-status ok';
                        }
                        // 進捗を3秒後に隠す
                        setTimeout(function() {
                            if (progressEl && !s3Operating) progressEl.style.display = 'none';
                        }, 3000);
                    } else {
                        if (statusEl) {
                            statusEl.textContent = data.message;
                            statusEl.className = 's3-status error';
                        }
                    }
                }
            });
        }

        // Status listener (receives bucket path and credential info)
        if (bridge.onS3Status) {
            bridge.onS3Status(function(data) {
                if (bucketInput && data.bucketPath) {
                    bucketInput.value = data.bucketPath;
                }
                if (statusEl) {
                    if (data.hasCredentials) {
                        statusEl.textContent = 'Credentials configured (' + (data.region || 'us-east-1') + ')';
                        statusEl.className = 's3-status ok';
                    } else {
                        statusEl.textContent = 'AWS credentials not set. Configure in Settings.';
                        statusEl.className = 's3-status error';
                    }
                }
                if (!s3Operating) setS3ButtonsEnabled(data.hasCredentials);
            });
        }
    }

    function getCurrentOutFileId() {
        if (!currentFile) return null;
        for (var i = 0; i < fileList.length; i++) {
            if (fileList[i].filePath === currentFile) {
                return fileList[i].id;
            }
        }
        // Fallback: extract from file path
        return currentFile.replace(/^.*[/\\]/, '').replace(/\.out$/, '');
    }

    return { init: init, getCurrentOutFileId: getCurrentOutFileId };
})();

// Export for both browser (global) and CommonJS
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { notesFilePanel: notesFilePanel };
}
