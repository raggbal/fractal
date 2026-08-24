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

    // TASK-14b: remote（vscode server）では OS アプリ起動が不能 → host からの triggerFileDownload で
    // ブラウザダウンロードに縮退する。**<a download> は cross-origin（webview リソース URI）で無効 =
    // ナビゲーションになり webview がブロック画面に潰れる**（ユーザー実測 2026-08-23）ため、
    // fetch → blob → same-origin blob URL 経由でダウンロードする（viewer の fetch 経路と同じ到達性）
    window.addEventListener('message', function (e) {
        var m = e.data;
        if (!m || m.type !== 'triggerFileDownload' || !m.fileUri) { return; }
        fetch(m.fileUri).then(function (resp) {
            if (!resp.ok) { throw new Error('fetch ' + resp.status); }
            return resp.blob();
        }).then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = m.fileName || 'download';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { try { URL.revokeObjectURL(url); } catch (err) { /* noop */ } }, 10000);
        }).catch(function (err) {
            try {
                if (bridge && typeof bridge.notifyError === 'function') {
                    bridge.notifyError('Download failed: ' + (m.fileName || '') + ' (' + err + ')');
                }
            } catch (e2) { /* 縮退 */ }
        });
    });
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
    // bug-fix 2026-08-05: renderTree の全再構築が click 合成を殺すのを補う pointerup 保険の状態
    var _pointerDownItemId = null;

    // click / pointerup の両経路から呼ぶ単一の開閉口（currentFile ガードで二重送信防止）
    function openItemFile(filePath) {
        // sprint 20260815-075428: file viewer 表示中は currentFile ガードを外す。
        // viewer（html/pdf）を開いても currentFile は前の md/.out のままなので、同じ item を
        // 再クリックすると early return して viewer が閉じず戻れなくなる（実機検収 2026-08-15）
        var viewerShown = !!(window.__viewerDispatcher && window.__viewerDispatcher.isViewerShown
            && window.__viewerDispatcher.isViewerShown());
        // 2026-08-18 バグ修正: folder view 表示中も currentFile ガードを外す（viewer と同型 —
        // folder view を開いても currentFile は前の md/.out のままなので、同じ item の再クリックが
        // early return して folder view から戻れなくなる）
        var fvShown = !!(window.__folderViewDispatcher && window.__folderViewDispatcher.isFolderViewShown
            && window.__folderViewDispatcher.isFolderViewShown());
        if (filePath === currentFile && !viewerShown && !fvShown) return;
        currentFile = filePath;  // 即時更新で二重送信防止
        if (viewerShown && window.__viewerDispatcher.hideViewer) {
            window.__viewerDispatcher.hideViewer();   // 先に viewer を畳んでから開く
        }
        if (fvShown && window.__folderViewDispatcher.hideFolderView) {
            window.__folderViewDispatcher.hideFolderView(); // 先に folder view を畳んでから開く（タブ側の #16 ガードも解除される）
        }
        bridge.openFile(filePath);
    }

    // FR-TF-02 (sprint 20260809): kind==='file' item を OS 既定アプリで開く（openFile/openFileInTab は
    // .md/.out stem 前提で file に不達なので専用 bridge へ分岐）。click と pointerup 保険の両経路から
    // 呼ばれるため短時間の二重呼び出しを id + 時刻でデデュープ（openItemFile の currentFile ガード相当）。
    var _lastAttachOpenId = null;
    var _lastAttachOpenTs = 0;
    function openAttachExternal(id) {
        if (!id) return;
        var now = Date.now();
        if (_lastAttachOpenId === id && (now - _lastAttachOpenTs) < 400) return;
        _lastAttachOpenId = id;
        _lastAttachOpenTs = now;
        if (bridge && typeof bridge.openTreeFileExternal === 'function') {
            bridge.openTreeFileExternal(id);
        }
    }

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
    // 2026-08-24 ユーザー選定: .out 専用アイコン = ドキュメント枠 + 箇条書き 3 行
    //（md の「枠 + M」と同族の見た目でアウトライナーを表す。従来は無印 ICON_FILE と共用だった）
    var ICON_FILE_OUT = '<svg class="file-panel-item-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><line x1="8" y1="11" x2="8.01" y2="11"/><line x1="11.5" y1="11" x2="16" y2="11"/><line x1="8" y1="14.5" x2="8.01" y2="14.5"/><line x1="11.5" y1="14.5" x2="16" y2="14.5"/><line x1="8" y1="18" x2="8.01" y2="18"/><line x1="11.5" y1="18" x2="16" y2="18"/></svg>';
    // ADR-008: Notes 内 .md ファイル識別用アイコン (file の右下に "M" ラベル)
    var ICON_FILE_MD = '<svg class="file-panel-item-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><text x="8" y="19" font-size="8" font-weight="700" stroke="none" fill="currentColor">M</text></svg>';
    // FR-TF-02 (sprint 20260809): tree に登録された添付ファイル (kind:'file') 識別用の専用アイコン (paperclip)。
    // .out (ICON_FILE) / .md (ICON_FILE_MD) と視覚的に区別し、is-attach class + 専用 marker class を持つ。
    var ICON_FILE_ATTACH = '<svg class="file-panel-item-icon file-panel-attach-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    var ICON_FOLDER = '<svg class="file-panel-folder-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    // FR-FLV: folder link 用アイコン（既存 ICON_FOLDER と同一 glyph・item 用 class）
    // FR-FLV-03 再オープン①: フォルダ形は通常 tree フォルダと識別不能 — 🔗 チェーンリンク（lucide link 風）に変更
    var ICON_FOLDER_LINK = '<svg class="file-panel-item-icon file-panel-folderlink-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
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

    // FR-FLV-10: folder link click → folder view 表示（dispatcher は TASK-07 実装。
    // typeof ガード付き — 不在時は no-op。broken は呼び出し側で relink に分岐）
    function openFolderView(folderLinkId, title) {
        var d = window.__folderViewDispatcher;
        if (d && typeof d.showFolderView === 'function') {
            d.showFolderView(folderLinkId, title);
        }
    }

    function createFileElement(f, parentId) {
        var item = document.createElement('div');
        // FR-TF-02 (sprint 20260809): listFiles が付与する kind ('out'|'md'|'file') で 3 値描画。
        // 拡張子推測 (/\.md$/i) をやめる — 添付 file が `a.md` という名でも file として扱う (誤判定防止)。
        // 後方互換: kind 未付与の旧 entry は従来どおり拡張子で md/out を推測 (file 扱いにはしない)。
        var kind = f.kind || (/\.md$/i.test(f.filePath || '') ? 'md' : 'out');
        var isMd = kind === 'md';
        var isAttach = kind === 'file';
        // FR-FLV-03: folder link（第 4 kind）。broken = リンク切れ表示（listFiles の派生フラグ）
        var isFolderLink = kind === 'folder';
        var isBrokenLink = isFolderLink && !!f.broken;
        var itemClass = 'file-panel-item' + (f.filePath === currentFile ? ' active' : '');
        // v11: color class 反映
        var itemColor = getItemColor(f.id || f.filePath.replace(/^.*[/\\]/, '').replace(/\.(out|md)$/, ''));
        if (itemColor) {
            itemClass += ' notes-item-color-' + itemColor;
        }
        if (isMd) itemClass += ' is-md';
        if (isAttach) itemClass += ' is-attach';
        if (isFolderLink) itemClass += ' is-folder-link';
        if (isBrokenLink) itemClass += ' is-broken';
        item.className = itemClass;
        item.dataset.filePath = f.filePath;
        item.dataset.itemId = f.id || f.filePath.replace(/^.*[/\\]/, '').replace(/\.(out|md)$/, '');
        item.dataset.itemType = 'file';
        item.dataset.fileExt = kind;
        if (parentId) item.dataset.parentId = parentId;
        item.draggable = true;

        // 拡張子別アイコン（2026-08-23 — 表示のみ。office/pdf/html は emoji glyph、それ以外の添付は
        // 従来クリップ SVG に縮退。写像は MarkdownLinkParser.fileIconGlyph が単一真実）
        var attachGlyph = (isAttach && typeof MarkdownLinkParser !== 'undefined' && MarkdownLinkParser.fileIconGlyph)
            ? MarkdownLinkParser.fileIconGlyph(f.filePath) : '📎';
        var attachIcon = attachGlyph !== '📎'
            ? '<span class="file-panel-item-icon file-panel-glyph-icon" style="font-size:12px;line-height:1;">' + attachGlyph + '</span>'
            : ICON_FILE_ATTACH;
        var icon = isFolderLink ? ICON_FOLDER_LINK : (isAttach ? attachIcon : (isMd ? ICON_FILE_MD : (kind === 'out' ? ICON_FILE_OUT : ICON_FILE)));
        item.innerHTML = icon + '<span class="file-panel-item-title">' + escapeHtml(f.title || 'Untitled') + '</span>';

        item.addEventListener('click', function(e) {
            // FR-FLV-10/25: folder link — broken は再指定 / cmd+click は folder タブ / 通常はフォルダビュー
            if (isFolderLink) {
                if (isBrokenLink) {
                    if (bridge.relinkFolderLink) bridge.relinkFolderLink(f.id);
                    return;
                }
                if (e && (e.metaKey || e.ctrlKey)) {
                    var tm = window.__notesTabManager;
                    if (tm && typeof tm.openInNewTab === 'function') tm.openInNewTab(f.id, 'folder', f.title || 'Folder');
                    return;
                }
                openFolderView(f.id, f.title || 'Folder');
                return;
            }
            // FR-TF-02: 添付 file は OS 既定アプリで開く（cmd/ctrl 修飾も無視 = file はタブ化不可）。
            if (isAttach) { openAttachExternal(f.id); return; }
            // FR-CT-01: cmd/ctrl+click → webview 内タブ（右クリック Open in new tab と同経路）
            if (e && (e.metaKey || e.ctrlKey)) {
                if (bridge.openFileInTab) bridge.openFileInTab(f.filePath);
                return; // FR-CT-02: openFile は発火させない（currentFile も変えない）
            }
            openItemFile(f.filePath);
        });
        // bug-fix 2026-08-05: D&D 直後の 1 回目 click が無視される件。
        // D&D 応答の notesFileListChanged → renderTree() が item を全再構築するため、
        // ユーザーの mousedown〜mouseup の間に要素が差し替わると click 合成イベントが
        // 発火しない（mousedown/mouseup が別要素）。pointerup ベースの保険を張り、
        // 「直近の pointerdown と同じ item 上で pointerup」なら click 相当として openFile する。
        // click も発火した場合は openItemFile 内の currentFile ガードで二重送信されない。
        item.addEventListener('pointerdown', function(e) {
            if (e.button !== 0 || e.metaKey || e.ctrlKey) { _pointerDownItemId = null; return; }
            _pointerDownItemId = f.id || f.filePath;
        });
        item.addEventListener('pointerup', function(e) {
            if (e.button !== 0 || e.metaKey || e.ctrlKey) { return; }
            if (_pointerDownItemId !== (f.id || f.filePath)) { return; }
            _pointerDownItemId = null;
            if (dragItemId) { return; } // drag セッション中（dragend 前）は発火しない
            // FR-FLV-10: folder link も pointerup 保険（renderTree 全再構築で click 合成が死ぬ既知 race）
            if (isFolderLink) {
                if (isBrokenLink) {
                    if (bridge.relinkFolderLink) bridge.relinkFolderLink(f.id);
                } else {
                    openFolderView(f.id, f.title || 'Folder');
                }
                return;
            }
            // FR-TF-02: 添付 file は click と同じく OS 既定アプリで開く（openAttachExternal 内で二重呼び出し dedup）
            if (isAttach) { openAttachExternal(f.id); return; }
            openItemFile(f.filePath);
        });
        item.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            // FR-FLV-06: folder link の Rename は host InputBox（title のみ・実フォルダ名不変）
            if (isFolderLink) {
                if (bridge.renameFolderLink) bridge.renameFolderLink(f.id);
                return;
            }
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

        // FR-TF-10 (sprint 20260809): kind==='file' の添付ファイルは専用メニュー集合。
        // 表示: Open（OS 既定アプリ）/ Reveal in Finder / Rename（title のみ）/ Favorite /
        //       Copy Path（絶対パスは host→webview 応答で NFR-TF-02 非抵触）/ Set Color / Move Other Note / Delete。
        // 非表示: Copy In-App Link・Open in new tab（file は .md/.out stem を持たずタブ化・アプリ内リンク不可）。
        // 実体パスは .md/.out stem 前提の既存経路（deleteFile(filePath) 等）に流さず、id ベースの新 bridge を使う。
        var menuKind = file.kind || (/\.md$/i.test(file.filePath || '') ? 'md' : 'out');
        // FR-FLV-06: folder link の専用メニュー集合（requirement FR-FLV-06 表が唯一の正）。
        // 表示 8: Open / Open in new tab / Rename / Re-link / Reveal in Finder / Copy Path / Set Color / Remove Link
        // + 共通 3（New Outline here / New Markdown here / New Subfolder は従来どおり）。
        // 非表示: Favorite / Move Other Note / Copy In-App Link / Delete（実体削除は提供しない）/ Open in Standalone。
        if (menuKind === 'folder') {
            var folderLinkId = file.id || fileId;
            var folderBroken = !!file.broken;
            addContextItem(contextMenu, i18n.notesOpen || 'Open', function() {
                closeContextMenu();
                if (folderBroken) {
                    if (bridge.relinkFolderLink) bridge.relinkFolderLink(folderLinkId);
                } else {
                    openFolderView(folderLinkId, file.title || 'Folder');
                }
            });
            addContextItem(contextMenu, i18n.notesOpenInNewTab || 'Open in new tab', function() {
                closeContextMenu();
                var tm = window.__notesTabManager;
                if (!folderBroken && tm && typeof tm.openInNewTab === 'function') {
                    tm.openInNewTab(folderLinkId, 'folder', file.title || 'Folder');
                }
            });
            addContextItem(contextMenu, i18n.notesRename || 'Rename', function() {
                closeContextMenu();
                if (bridge.renameFolderLink) bridge.renameFolderLink(folderLinkId);
            });
            addContextItem(contextMenu, i18n.folderLinkRelink || 'Re-link', function() {
                closeContextMenu();
                if (bridge.relinkFolderLink) bridge.relinkFolderLink(folderLinkId);
            });
            addContextItem(contextMenu, i18n.notesRevealInFinder || 'Reveal in Finder', function() {
                closeContextMenu();
                if (bridge.revealFolderLink) bridge.revealFolderLink(folderLinkId);
            });
            addContextItem(contextMenu, i18n.copyPath || 'Copy Path', function() {
                closeContextMenu();
                if (bridge.copyFolderLinkPath) bridge.copyFolderLinkPath(folderLinkId);
            });
            addContextItem(contextMenu, i18n.notesSetColor || 'Set Color', function() {
                renderColorPalette(contextMenu, currentColor, function(colorName) {
                    bridge.setItemColor(fileId, colorName);
                    closeContextMenu();
                }, function() {
                    showFileContextMenu(e, file);
                });
            }, false, true);
            // 共通項目（従来どおり表示 — 早期 return 分岐でも落とさない: designer_failures 2026-08-09）
            addContextItem(contextMenu, i18n.notesNewOutline || 'New Outline here', function() {
                closeContextMenu();
                promptNewFile(fileParentId, fileId);
            });
            addContextItem(contextMenu, i18n.notesNewMarkdownHere || 'New Markdown here', function() {
                closeContextMenu();
                promptNewMarkdownFile(fileParentId, fileId);
            });
            addContextItem(contextMenu, i18n.notesNewFolder || 'New Subfolder', function() {
                closeContextMenu();
                promptNewFolder(fileParentId, fileId);
            });
            // FR-FTM-02 (sprint 20260818-183407): 共通 4 項目目 New link folder（その場所へ登録）
            addContextItem(contextMenu, i18n.notesNewLinkFolder || 'New link folder', function() {
                closeContextMenu();
                if (bridge.addFolderLink) bridge.addFolderLink(fileParentId || null);
            });
            // Remove Link = 台帳のみ除去（実フォルダに触れない — Delete と誤認しない文言）
            addContextItem(contextMenu, i18n.folderLinkRemove || 'Remove Link', function() {
                closeContextMenu();
                if (bridge.removeFolderLink) bridge.removeFolderLink(folderLinkId);
            }, true);
            document.body.appendChild(contextMenu);
            setTimeout(function() { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
            return;
        }
        if (menuKind === 'file') {
            var treeFileId = file.id || fileId;
            addContextItem(contextMenu, i18n.notesOpen || 'Open', function() {
                closeContextMenu();
                openAttachExternal(treeFileId);
            });
            addContextItem(contextMenu, i18n.notesRevealInFinder || 'Reveal in Finder', function() {
                closeContextMenu();
                if (bridge && bridge.revealTreeFileInOS) { bridge.revealTreeFileInOS(treeFileId); }
            });
            addContextItem(contextMenu, i18n.notesRename || 'Rename', function() {
                closeContextMenu();
                var itemElF = listEl ? listEl.querySelector('[data-file-path="' + CSS.escape(file.filePath) + '"]') : null;
                if (itemElF) startRenameFile(itemElF, file);
            });
            addContextItem(contextMenu, isFav ? (i18n.notesUnfavorite || '★ Unfavorite') : (i18n.notesFavorite || '☆ Add to Favorites'), function() {
                closeContextMenu();
                bridge.toggleFavorite(fileId);
            });
            addContextItem(contextMenu, i18n.copyPath || 'Copy Path', function() {
                closeContextMenu();
                if (bridge && bridge.copyTreeFilePath) { bridge.copyTreeFilePath(treeFileId); }
            });
            // FR-FTM-03 (sprint 20260818-183407): file item の Duplicate（実体複製 — DuplicationCore）
            addContextItem(contextMenu, i18n.notesDuplicateItem || 'Duplicate', function() {
                closeContextMenu();
                if (bridge.duplicateTreeItem) bridge.duplicateTreeItem(fileId);
            });
            addContextItem(contextMenu, i18n.notesSetColor || 'Set Color', function() {
                renderColorPalette(contextMenu, currentColor, function(colorName) {
                    bridge.setItemColor(fileId, colorName);
                    closeContextMenu();
                }, function() {
                    showFileContextMenu(e, file);
                });
            }, false, true);
            addContextItem(contextMenu, i18n.notesMoveOtherNote || 'Move Other Note', function() {
                closeContextMenu();
                if (bridge.moveToOtherNote) { bridge.moveToOtherNote(treeFileId); }
            });
            // FR-TF-10: 共通項目（その位置に新規作成）は file item でも従来どおり表示（design §7 / SYS-1 裁定 2026-08-10）
            addContextItem(contextMenu, i18n.notesNewOutline || 'New Outline here', function() {
                closeContextMenu();
                promptNewFile(fileParentId, fileId);
            });
            addContextItem(contextMenu, i18n.notesNewMarkdownHere || 'New Markdown here', function() {
                closeContextMenu();
                promptNewMarkdownFile(fileParentId, fileId);
            });
            addContextItem(contextMenu, i18n.notesNewFolder || 'New Subfolder', function() {
                closeContextMenu();
                promptNewFolder(fileParentId, fileId);
            });
            // FR-FTM-02 (sprint 20260818-183407): 共通 4 項目目 New link folder（その場所へ登録）
            addContextItem(contextMenu, i18n.notesNewLinkFolder || 'New link folder', function() {
                closeContextMenu();
                if (bridge.addFolderLink) bridge.addFolderLink(fileParentId || null);
            });
            addContextItem(contextMenu, i18n.notesDelete || 'Delete', function() {
                closeContextMenu();
                if (bridge && bridge.deleteTreeFile) { bridge.deleteTreeFile(treeFileId); }
            }, true);
            document.body.appendChild(contextMenu);
            setTimeout(function() { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
            return;
        }

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
        // FR-FTM-02 (sprint 20260818-183407): 共通 4 項目目 New link folder（その場所へ登録）
        addContextItem(contextMenu, i18n.notesNewLinkFolder || 'New link folder', function() {
            closeContextMenu();
            if (bridge.addFolderLink) bridge.addFolderLink(fileParentId || null);
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
        // FR-FTM-03 (sprint 20260818-183407): out/md item の Duplicate（実体複製 — DuplicationCore）
        addContextItem(contextMenu, i18n.notesDuplicateItem || 'Duplicate', function() {
            closeContextMenu();
            if (bridge.duplicateTreeItem) bridge.duplicateTreeItem(fileId);
        });
        // FR-B04: アプリ内リンクをコピー（file item = .out / .md のみ。folder は showFolderContextMenu で別扱い）。
        // out → InAppLinkUtils.buildOutLink(folder, id) / md → InAppLinkUtils.buildMdLink(folder, id)。
        // clipboard は outliner.js:7054 / :7427 と同じ [title](link) markdown（title の [] を除去）。
        if (typeof window !== 'undefined' && window.InAppLinkUtils) {
            var isMdFileForLink = /\.md$/i.test(file.filePath);
            var linkFileId = file.id || file.filePath.replace(/^.*[/\\]/, '').replace(/\.(out|md)$/i, '');
            addContextItem(contextMenu, i18n.copyInAppLink || 'Copy In-App Link', function() {
                closeContextMenu();
                if (!noteFolderName) return;
                var link = isMdFileForLink
                    ? window.InAppLinkUtils.buildMdLink(noteFolderName, linkFileId)
                    : window.InAppLinkUtils.buildOutLink(noteFolderName, linkFileId);
                var title = (file.title || 'Untitled').replace(/[\[\]]/g, '');
                try { navigator.clipboard.writeText('[' + title + '](' + link + ')'); } catch (err) { /* ignore */ }
            });
        }
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
        // FR-FTM-02 (sprint 20260818-183407): 共通 4 項目目 New link folder（このフォルダ内へ登録）
        addContextItem(contextMenu, i18n.notesNewLinkFolder || 'New link folder', function() {
            closeContextMenu();
            if (bridge.addFolderLink) bridge.addFolderLink(folder.id);
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

    // TASK-19 (sprint 20260804-145603): md editor 内 subpage リンク → ツリー D&D。
    // editor.js の dragstart（a[data-subpage] のみ）が setData する。Link は積まれない。
    var MD_SUBPAGE_MIME = 'application/x-fractal-md-subpage';
    function isMdSubpageDrag(e) {
        if (!e || !e.dataTransfer) return false;
        var types = Array.from(e.dataTransfer.types || []);
        return types.indexOf(MD_SUBPAGE_MIME) !== -1;
    }
    function readMdSubpagePayload(e) {
        try {
            var raw = e.dataTransfer.getData(MD_SUBPAGE_MIME);
            if (!raw) return null;
            var p = JSON.parse(raw);
            return (p && p.href && p.sourceMdPath) ? p : null;
        } catch (err) { return null; }
    }

    // FR-TF-05b (sprint 20260809): Outliner の file node（📎 アイコン）→ tree への drag。
    // outliner.js dragstart が application/x-fractal-out-node-file を setData（payload {outFileKey, nodeId}・絶対パス不含）。
    var OUT_NODE_FILE_MIME = 'application/x-fractal-out-node-file';
    function isOutNodeFileDrag(e) {
        if (!e || !e.dataTransfer) return false;
        var types = Array.from(e.dataTransfer.types || []);
        return types.indexOf(OUT_NODE_FILE_MIME) !== -1;
    }
    function readOutNodeFilePayload(e) {
        try {
            var raw = e.dataTransfer.getData(OUT_NODE_FILE_MIME);
            if (!raw) return null;
            var p = JSON.parse(raw);
            return (p && p.outFileKey && p.nodeId) ? p : null;
        } catch (err) { return null; }
    }

    // FR-TF-06b (sprint 20260809): md editor 内の file リンク（📎 アンカー）→ tree への drag。
    // editor.js dragstart が application/x-fractal-md-filelink を setData（payload {href, sourceMdPath}）。
    // 重要: md-subpage と payload shape（href/sourceMdPath）が同一のため、必ず MIME 種別で判別する
    // （payload 形状で分岐すると subpage/filelink を取り違える — designer_failures「2 端配線」の教訓）。
    var MD_FILELINK_MIME = 'application/x-fractal-md-filelink';
    function isMdFileLinkDrag(e) {
        if (!e || !e.dataTransfer) return false;
        var types = Array.from(e.dataTransfer.types || []);
        return types.indexOf(MD_FILELINK_MIME) !== -1;
    }
    function readMdFileLinkPayload(e) {
        try {
            var raw = e.dataTransfer.getData(MD_FILELINK_MIME);
            if (!raw) return null;
            var p = JSON.parse(raw);
            return (p && p.href && p.sourceMdPath) ? p : null;
        } catch (err) { return null; }
    }

    // 外部 drop / subpage / out-node-file / md-filelink の drop 位置 → 兄弟挿入 {parentId, index} 解決。
    function computeSiblingInsert(targetEl, e) {
        var rect = targetEl.getBoundingClientRect();
        var ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0;
        var parentId = targetEl.dataset.parentId || null;
        var sib = getChildIdsOfParent(parentId);
        var idx = sib.indexOf(targetEl.dataset.itemId);
        if (idx === -1) idx = sib.length;
        return { parentId: parentId, index: ratio < 0.5 ? idx : idx + 1 };
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
    // FR-FLV-20 (W2 受信 — sprint 20260817-053313): フォルダビューのエントリ → Note ツリー移動。
    // payload = { folderLinkId, relPath, isDir }（絶対パス不含 = INV-4）。isDir=true は不受理通知。
    var FOLDER_VIEW_ENTRY_MIME = 'application/x-fractal-folderview-entry';

    function isFolderViewEntryDrag(e) {
        if (!e || !e.dataTransfer) return false;
        var types = Array.from(e.dataTransfer.types || []);
        return types.indexOf(FOLDER_VIEW_ENTRY_MIME) !== -1;
    }

    function readFolderViewEntryPayload(e) {
        try {
            var raw = e.dataTransfer.getData(FOLDER_VIEW_ENTRY_MIME);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    /** W2 の共通 dispatch: isDir 不受理通知 or bridge.folderViewMoveToTree（#14） */
    function dispatchFolderViewEntryDrop(payload, parentId, index) {
        if (!payload || !payload.folderLinkId || payload.relPath === undefined) return;
        if (payload.isDir) {
            if (typeof bridge.notifyError === 'function') {
                bridge.notifyError(i18n.folderViewNoFolderDrop || 'Folders cannot be dropped here.');
            }
            return;
        }
        if (typeof bridge.folderViewMoveToTree === 'function') {
            bridge.folderViewMoveToTree(payload.folderLinkId, payload.relPath, parentId, index);
        }
    }

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

    // FR-T01 (sprint 20260805-124854): Finder / VS Code Explorer からの外部ファイル D&D 判定。
    // outliner.js:1357 isFilesDragEvent の二段構え（dragover 中は types に 'Files'・drop 時は
    // 環境により types に載らないので files 実体でフォールバック）を file-panel 内に移植。
    function isExternalFilesDrag(e) {
        if (!e || !e.dataTransfer) return false;
        var types = Array.from(e.dataTransfer.types || []);
        if (types.indexOf('Files') !== -1) return true;
        // drop 時フォールバック（症状 B 対策 / dragover 中は files が空なので types 判定が効く）
        return !!(e.dataTransfer.files && e.dataTransfer.files.length > 0);
    }

    // FR-TF-17 (§4k): VS Code Explorer からの drag は files が空で application/vnd.code.uri-list
    // のみ載る（isExternalFilesDrag では構造的に受理不能）。outliner.js isVscodeUriDragEvent の字面移植。
    // text/uri-list は受けない（md editor の URL drag 用 — tree では登録意味論が未定義。ADRL-C）。
    function isVscodeUriListDrag(e) {
        return !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('application/vnd.code.uri-list') >= 0);
    }

    // FR-TF-17 (§4k): uri-list drop → uris[] を host へ送るだけ（FileReader 非使用・host fs 直読み）。
    // 50MB cap なし（ADRL-C Decision 2 = outliner v12 前例の既決踏襲）。0 件なら bridge を呼ばない。
    function registerVscodeUriDrop(e, parentId, index) {
        var raw = '';
        try { raw = e.dataTransfer.getData('application/vnd.code.uri-list') || ''; } catch (err) { raw = ''; }
        var uris = raw.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
        if (uris.length === 0) return;
        if (typeof bridge.notesRegisterExternalUris === 'function') {
            bridge.notesRegisterExternalUris(uris, parentId, index);
        }
    }

    // ArrayBuffer → base64（添付 file の bytes 転送用。VS Code webview↔host は文字列が確実）。
    function arrayBufferToBase64(buffer) {
        try {
            var bytes = new Uint8Array(buffer || new ArrayBuffer(0));
            var binary = '';
            var chunk = 0x8000; // apply の引数上限を避けて分割
            for (var i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            if (typeof btoa === 'function') return btoa(binary);
            if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
            return '';
        } catch (err) { return ''; }
    }

    var MAX_ATTACH_BYTES = 50 * 1024 * 1024; // FR-TF-01: 50MB 超の添付は per-file skip

    // FR-TF-01 (sprint 20260809): 外部 files を FileReader で読み bridge.notesRegisterExternalMd を 1 回呼ぶ。
    // 振り分け: .md → readAsText → {kind:'md', name, content}（従来経路 不変） /
    //          その他 → readAsArrayBuffer → base64 → {kind:'file', name, bytes}（添付 file 経路 新設）。
    // 50MB 超の file は per-file で skip し bridge.notifyError で明示通知（旧 registerExternalMdFiles の
    // 「非 md を silent skip」は撤廃）。md/file が 0 件なら bridge を呼ばない。挿入位置は呼び出し側が決定。
    function registerExternalDroppedFiles(e, parentId, index) {
        var files = [];
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            files = Array.prototype.slice.call(e.dataTransfer.files);
        } else if (e.dataTransfer && e.dataTransfer.items) {
            // 環境により files が空で items のみ載る場合のフォールバック
            var items = Array.prototype.slice.call(e.dataTransfer.items);
            for (var k = 0; k < items.length; k++) {
                if (items[k].kind === 'file') {
                    var gf = items[k].getAsFile();
                    if (gf) files.push(gf);
                }
            }
        }
        if (files.length === 0) return;
        var readOne = function(file) {
            return new Promise(function(resolve) {
                var name = file.name || '';
                if (/\.md$/i.test(name)) {
                    var tr = new FileReader();
                    tr.onload = function() { resolve({ kind: 'md', name: name, content: String(tr.result || '') }); };
                    tr.onerror = function() { resolve(null); };
                    tr.readAsText(file);
                    return;
                }
                // 非 md = 添付 file。50MB 超は skip + 明示通知（silent skip しない）。
                if (typeof file.size === 'number' && file.size > MAX_ATTACH_BYTES) {
                    if (bridge && typeof bridge.notifyError === 'function') {
                        bridge.notifyError((i18n.notesAttachTooLarge || 'File too large (skipped, max 50MB): ') + name);
                    }
                    resolve(null);
                    return;
                }
                var br = new FileReader();
                br.onload = function() { resolve({ kind: 'file', name: name, bytes: arrayBufferToBase64(br.result) }); };
                br.onerror = function() { resolve(null); };
                br.readAsArrayBuffer(file);
            });
        };
        Promise.all(files.map(readOne)).then(function(results) {
            var itemsPayload = results.filter(function(r) { return r; });
            if (itemsPayload.length === 0) return;
            if (typeof bridge.notesRegisterExternalMd === 'function') {
                bridge.notesRegisterExternalMd(itemsPayload, parentId, index);
            }
        });
    }

    function setupDragSource(el) {
        el.addEventListener('dragstart', function(e) {
            var target = el.closest('[data-item-id]') || el;
            dragItemId = target.dataset.itemId;
            dragItemType = target.dataset.itemType;
            dragSourceFileExt = target.dataset.fileExt || null;
            // FR-FLV (W3 不受理判定 — sprint 20260817-053313): tree 内部 drag の種別を同一 document の
            // フォルダビューへ伝える one-shot グローバル（.out/folder item は text/plain しか積まず
            // MIME 判別不能。body.fr-drag-active はパネル外 dragleave で clear されるため使えない）。
            // set = ここ / clear = 下の dragend（対配線 — one-shot state の原則）
            window.__notesTreeDragKind = dragSourceFileExt || dragItemType || 'item';
            // FR-TF-16: 内部 drag の開始時点から hover 抑止（dragover を待たない）
            setDragHoverSuppression();
            // v0.207.77: 'copyMove' にしないと、dropEffect='copy' (Feature A/B) との不一致で
            // ブラウザが drop event をキャンセルする (HTML5 D&D 仕様)。
            e.dataTransfer.effectAllowed = 'copyMove';
            // テキストを設定（VSCode webview互換）
            try { e.dataTransfer.setData('text/plain', dragItemId); } catch(err) { /* ignore */ }
            // FR-B08 (sprint 20260804-145603): md item は Note Outliner tree へも drop できるよう
            // 内部 MIME を積む（受け側 = outliner.js の isTreeMdDragEvent → notesImportMdIntoOut）。
            // panel 内 D&D は module 変数（dragItemId 等）で動くため setData 追加は既存挙動に非干渉。
            if (dragSourceFileExt === 'md') {
                try {
                    e.dataTransfer.setData('application/x-fractal-tree-md', JSON.stringify({
                        id: dragItemId,
                        filePath: target.dataset.filePath || null,
                    }));
                } catch(err) { /* ignore */ }
            }
            // FR-TF-05a/06a (sprint 20260809): 添付 file item を Outliner / Markdown Editor へ drop できるよう
            // 内部 MIME を積む（受け側 = outliner.js handleTreeFileDrop / editor.js tree-file 分岐）。
            // payload は {id} のみ（絶対パス・filename を webview 間に流さない = NFR-TF-02）。md 経路とは別 MIME で不干渉。
            if (dragSourceFileExt === 'file') {
                try {
                    e.dataTransfer.setData('application/x-fractal-tree-file', JSON.stringify({ id: dragItemId }));
                } catch(err) { /* ignore */ }
            }
            // ドラッグ中のスタイル
            setTimeout(function() { target.style.opacity = '0.4'; }, 0);
        });

        el.addEventListener('dragend', function() {
            var target = el.closest('[data-item-id]') || el;
            target.style.opacity = '';
            dragItemId = null;
            dragItemType = null;
            dragSourceFileExt = null;
            window.__notesTreeDragKind = null; // one-shot clear（set = dragstart と対）
            removeDropIndicator();
            lastDropLine = null; // TASK-A2: 谷間フォールバック状態もリセット
            clearAllDragOver();
            clearDragHoverSuppression(); // FR-TF-16: 内部 drag 終了で hover 抑止解除
        });
    }

    function setupDropTarget(el) {
        el.addEventListener('dragover', function(e) {
            // v0.207.77 (Feature B): outliner page-node からの drag を最優先で処理
            var fromOutliner = isOutNodePageDrag(e);
            // node-move-to-other-outliner: 通常 node（page なし）は subtree MIME のみ持つため、
            // ここで preventDefault しないと HTML5 D&D 仕様で drop が発火しない（HIGH-1 修正）。
            var fromOutlinerSubtree = isOutNodeSubtreeDrag(e);
            // TASK-19: md editor 内 subpage リンクからの drag も受理。
            // 早期 return せず通常の line 表示ロジック（下の before/after/into-folder）へ流す
            //（Outliner page → ツリーと同じ補助線 UX。md-into-out 分岐は dragSourceFileExt
            //  が null なので発火しない = 誤 highlight なし）
            var fromMdSubpage = isMdSubpageDrag(e);
            // FR-TF-05b/06b (sprint 20260809): Outliner file node / md file リンクからの drag（別 webview 由来）。
            // dragItemId は載らない外部 MIME 経路。subpage と同じく補助線 UX で受理する。
            var fromOutNodeFile = isOutNodeFileDrag(e);
            var fromMdFileLink = isMdFileLinkDrag(e);
            // FR-FLV-20 (W2): フォルダビューのエントリ drag（custom MIME 群と同列で受理）
            var fromFolderView = isFolderViewEntryDrag(e);
            // FR-T01: 外部 files（Finder / VS Code Explorer）は最後に判定（内部 drag / outliner /
            // subpage が最優先。内部 drag は tree-md MIME 等も積むので dragItemId 非 null を先に弾く）。
            // FR-TF-17: Explorer drag は files が空で vnd.code.uri-list のみ載るため OR で受理
            //（これが無いと dragover 非 preventDefault で drop 自体が不発 = Explorer D&D 不能の主因）。
            var fromExternal = !dragItemId && !fromOutliner && !fromOutlinerSubtree && !fromMdSubpage && !fromOutNodeFile && !fromMdFileLink && !fromFolderView && (isExternalFilesDrag(e) || isVscodeUriListDrag(e));
            if (!dragItemId && !fromOutliner && !fromOutlinerSubtree && !fromMdSubpage && !fromOutNodeFile && !fromMdFileLink && !fromFolderView && !fromExternal) return;
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
            // FR-TF-03 (sprint 20260809): tree file → .out item も同じ中央ゾーンで import 対象（md と対称）。
            if (
                !fromOutliner &&
                (dragSourceFileExt === 'md' || dragSourceFileExt === 'file') &&
                target.dataset.itemType === 'file' &&
                target.dataset.fileExt === 'out' &&
                ratio >= 0.25 && ratio <= 0.75
            ) {
                target.classList.add('file-panel-drag-over-md-into-out');
                return;
            }

            // FR-TF-04 (sprint 20260809): tree file → md item 中央 → md 本文へ 📎 添付ゾーン（新設）。
            if (
                !fromOutliner &&
                dragSourceFileExt === 'file' &&
                target.dataset.itemType === 'file' &&
                target.dataset.fileExt === 'md' &&
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
            // TASK-19: md editor 内 subpage リンク → ツリー item 上に drop（挿入位置 = target の前後）
            var mdSubpagePayload = (!outPayload && !subtreePayload) && isMdSubpageDrag(e) ? readMdSubpagePayload(e) : null;
            // FR-TF-05b/06b (sprint 20260809): Outliner file node / md file リンク → tree item 上に drop。
            // md-filelink は md-subpage と payload shape が同一のため、必ず自分の MIME で判別する
            // （isMdFileLinkDrag は x-fractal-md-filelink・isMdSubpageDrag は x-fractal-md-subpage で不干渉）。
            var outNodeFilePayload = (!outPayload && !subtreePayload) && isOutNodeFileDrag(e) ? readOutNodeFilePayload(e) : null;
            var mdFileLinkPayload = (!outPayload && !subtreePayload && !mdSubpagePayload) && isMdFileLinkDrag(e) ? readMdFileLinkPayload(e) : null;
            // FR-FLV-20 (W2 受信): フォルダビューのエントリ → target item の前/後に移動登録
            var folderViewPayload = (!outPayload && !subtreePayload && !mdSubpagePayload && !outNodeFilePayload && !mdFileLinkPayload)
                && isFolderViewEntryDrag(e) ? readFolderViewEntryPayload(e) : null;
            e.preventDefault();
            if (folderViewPayload && !dragItemId) {
                clearAllDragOver();
                removeDropIndicator();
                var targetFV = el.closest('[data-item-id]') || el;
                var rectFV = targetFV.getBoundingClientRect();
                var ratioFV = rectFV.height ? (e.clientY - rectFV.top) / rectFV.height : 0;
                var insFV;
                // フォルダ中央帯（0.25-0.60 — Feature B と同帯）= フォルダ内末尾。上下帯 = 兄弟挿入
                if ((targetFV.dataset.itemType === 'folder' || targetFV.classList.contains('file-panel-folder-header'))
                    && ratioFV >= 0.25 && ratioFV <= 0.60) {
                    var fvFolderId = targetFV.dataset.folderId || targetFV.dataset.itemId;
                    insFV = { parentId: fvFolderId, index: getChildIdsOfParent(fvFolderId).length };
                } else {
                    insFV = computeSiblingInsert(targetFV, e);
                }
                dispatchFolderViewEntryDrop(folderViewPayload, insFV.parentId, insFV.index);
                return;
            }
            if (mdSubpagePayload && !dragItemId) {
                clearAllDragOver();
                removeDropIndicator();
                var targetSp = el.closest('[data-item-id]') || el;
                var rectSp = targetSp.getBoundingClientRect();
                var ratioSp = (e.clientY - rectSp.top) / rectSp.height;
                var parentSp = targetSp.dataset.parentId || null;
                var sibSp = getChildIdsOfParent(parentSp);
                var idxSp = sibSp.indexOf(targetSp.dataset.itemId);
                if (idxSp === -1) idxSp = sibSp.length;
                if (typeof bridge.notesRegisterSubpageFromMd === 'function') {
                    bridge.notesRegisterSubpageFromMd(mdSubpagePayload, parentSp, ratioSp < 0.5 ? idxSp : idxSp + 1);
                }
                return;
            }
            // FR-TF-05b (受信): Outliner file node → tree item 上に drop → structure 登録（挿入位置 = target 前後）。
            if (outNodeFilePayload && !dragItemId) {
                clearAllDragOver();
                removeDropIndicator();
                var insOF = computeSiblingInsert(el.closest('[data-item-id]') || el, e);
                if (typeof bridge.notesRegisterFileFromOutNode === 'function') {
                    bridge.notesRegisterFileFromOutNode(outNodeFilePayload, insOF.parentId, insOF.index);
                }
                return;
            }
            // FR-TF-06b (受信): md editor 内 file リンク → tree item 上に drop → structure 登録。
            // MIME 種別で判別済みのため subpage 経路（notesRegisterSubpageFromMd）へ流入しない。
            if (mdFileLinkPayload && !dragItemId) {
                clearAllDragOver();
                removeDropIndicator();
                var insFL = computeSiblingInsert(el.closest('[data-item-id]') || el, e);
                if (typeof bridge.notesRegisterFileFromMdLink === 'function') {
                    bridge.notesRegisterFileFromMdLink(mdFileLinkPayload, insFL.parentId, insFL.index);
                }
                return;
            }
            // FR-T01: 外部 files（.md）を item 上に drop → その item の前/後（ratio<0.5=前）に登録。
            // 内部 drag / outliner / subpage / out-node-file / md-filelink が全て無いときのみ（内部 drag 最優先を保つ）。
            if (!dragItemId && !outPayload && !subtreePayload && !mdSubpagePayload && !outNodeFilePayload && !mdFileLinkPayload && isExternalFilesDrag(e)) {
                clearAllDragOver();
                removeDropIndicator();
                var targetEx = el.closest('[data-item-id]') || el;
                var rectEx = targetEx.getBoundingClientRect();
                var ratioEx = (e.clientY - rectEx.top) / rectEx.height;
                var parentEx = targetEx.dataset.parentId || null;
                var sibEx = getChildIdsOfParent(parentEx);
                var idxEx = sibEx.indexOf(targetEx.dataset.itemId);
                if (idxEx === -1) idxEx = sibEx.length;
                registerExternalDroppedFiles(e, parentEx, ratioEx < 0.5 ? idxEx : idxEx + 1);
                return;
            }
            // FR-TF-17: VS Code Explorer uri-list → item の前/後に登録（Files 分岐の後 = Files 優先の
            // dispatch 順は outliner.js の Finder→uri-list 順と対称）。
            if (!dragItemId && !outPayload && !subtreePayload && !mdSubpagePayload && !outNodeFilePayload && !mdFileLinkPayload && isVscodeUriListDrag(e)) {
                clearAllDragOver();
                removeDropIndicator();
                var targetUl = el.closest('[data-item-id]') || el;
                var rectUl = targetUl.getBoundingClientRect();
                var ratioUl = (e.clientY - rectUl.top) / rectUl.height;
                var parentUl = targetUl.dataset.parentId || null;
                var sibUl = getChildIdsOfParent(parentUl);
                var idxUl = sibUl.indexOf(targetUl.dataset.itemId);
                if (idxUl === -1) idxUl = sibUl.length;
                registerVscodeUriDrop(e, parentUl, ratioUl < 0.5 ? idxUl : idxUl + 1);
                return;
            }
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

            // FR-TF-03 (sprint 20260809): tree file → .out item 中央 → .out に file node 取込（md と対称）。
            if (
                dragSourceFileExt === 'file' &&
                targetType === 'file' &&
                target.dataset.fileExt === 'out' &&
                ratio >= 0.25 && ratio <= 0.75
            ) {
                if (typeof bridge.notesImportFileIntoOut === 'function') {
                    bridge.notesImportFileIntoOut(dragItemId, targetId);
                }
                return;
            }

            // FR-TF-04 (sprint 20260809): tree file → md item 中央 → md 本文に 📎 リンク添付（新設ゾーン）。
            if (
                dragSourceFileExt === 'file' &&
                targetType === 'file' &&
                target.dataset.fileExt === 'md' &&
                ratio >= 0.25 && ratio <= 0.75
            ) {
                if (typeof bridge.notesAttachFileIntoMd === 'function') {
                    bridge.notesAttachFileIntoMd(dragItemId, targetId);
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
            // FR-FLV-20 (W2): フォルダビューのエントリ → フォルダ内末尾
            var fromFolderView = isFolderViewEntryDrag(e);
            // FR-T01: 外部 files（.md）— 内部 drag / outliner が無いときのみ
            // FR-TF-17: Explorer uri-list も同列で受理（files が空のため OR が必須）
            var fromExternal = !dragItemId && !fromOutliner && !fromFolderView && (isExternalFilesDrag(e) || isVscodeUriListDrag(e));
            if (!dragItemId && !fromOutliner && !fromFolderView && !fromExternal) return;
            // 子要素がハンドルしない空エリアのみ
            if (e.target === childrenEl || e.target.className === 'file-panel-folder-children') {
                e.preventDefault();
                e.dataTransfer.dropEffect = (fromOutliner || fromFolderView || fromExternal) ? 'copy' : 'move';
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
            // FR-FLV-20 (W2 受信): フォルダビューのエントリ → フォルダ内末尾に移動登録
            if (!dragItemId && !outPayload && isFolderViewEntryDrag(e)) {
                clearAllDragOver();
                removeDropIndicator();
                lastDropLine = null;
                dispatchFolderViewEntryDrop(readFolderViewEntryPayload(e), folderId, getChildIdsOfParent(folderId).length);
                return;
            }
            // FR-T01: 外部 files（.md）→ フォルダ内末尾に登録（内部 drag / outliner が無いときのみ）
            if (!dragItemId && !outPayload && isExternalFilesDrag(e)) {
                clearAllDragOver();
                removeDropIndicator();
                lastDropLine = null;
                registerExternalDroppedFiles(e, folderId, getChildIdsOfParent(folderId).length);
                return;
            }
            // FR-TF-17: Explorer uri-list → フォルダ内末尾に登録（Files 分岐の後 = Files 優先）
            if (!dragItemId && !outPayload && isVscodeUriListDrag(e)) {
                clearAllDragOver();
                removeDropIndicator();
                lastDropLine = null;
                registerVscodeUriDrop(e, folderId, getChildIdsOfParent(folderId).length);
                return;
            }
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

    // FR-TF-16 (sprint 20260809 再オープン③): drag セッション中の hover 色抑止フラグ。
    // CSS 側（notes-body-html.js）が body.fr-drag-active 下の item/folder :hover を transparent にする。
    // set/clear は受け側完結（外部/cross-webview drag では drag 元の dragend がこの webview に
    // 届かない — HTML5 仕様）: set = dragenter/dragover capture（冪等）+ 内部 dragstart、
    // clear = relaxed dragleave（panel 外へ）+ drop + dragend + window 安全網。
    function setDragHoverSuppression() {
        document.body.classList.add('fr-drag-active');
    }
    function clearDragHoverSuppression() {
        document.body.classList.remove('fr-drag-active');
    }
    // drag セッション終了の一括掃除（hover 抑止 + highlight + 補助線を 1 ラッパに束ねる —
    // 片系統だけ消す掃除経路を作らない: generator_failures 2026-08-02「掃除の片肺化」回避）。
    // lastDropLine は触らない（listEl 谷間 drop が挿入位置の参照に使う。dragend/実 drop でリセット済み）。
    function clearDragSessionVisuals() {
        clearDragHoverSuppression();
        if (listEl) clearAllDragOver();
        removeDropIndicator();
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

    /**
     * FR-SEF-01 (sprint 20260822-203347): ext: クエリ構文の stateless parse。
     * input.value の pure 関数 — module 状態を持たない（executeSearch 非経由で
     * 駆動される既存 spec を壊さないための裁定 = design-review iteration 1 TDD-1）。
     * 正典（window.SearchExtFilter = search-ext-filter.js）不在時は従来挙動に縮退。
     */
    function currentSearch() {
        var raw = searchInputEl ? searchInputEl.value : '';
        return (window.SearchExtFilter && window.SearchExtFilter.parseExtQuery)
            ? window.SearchExtFilter.parseExtQuery(raw)
            : { body: String(raw).trim(), exts: null };
    }

    function executeSearch() {
        if (!searchInputEl || !bridge.search) return;
        var q = currentSearch();
        if (!q.body) return;   // ext: 単独（本文空）も既存の空クエリ挙動 = 検索非実行（FR-SEF-01）
        bridge.search(q.body, Object.assign({}, searchOptions, { exts: q.exts }));
    }

    var searchSectionOut = null;
    var searchSectionMd = null;
    var searchSectionExplore = null;
    var searchSectionFiles = null;
    var searchSectionOutBody = null;
    var searchSectionMdBody = null;
    var searchSectionExploreBody = null;
    var searchSectionFilesBody = null;
    var searchSectionOutTitle = null;
    var searchSectionMdTitle = null;
    var searchSectionExploreTitle = null;
    var searchSectionFilesTitle = null;
    var searchCountOut = 0;
    var searchCountMd = 0;
    var searchCountExplore = 0;
    var searchCountFiles = 0;

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
        searchCountFiles = 0;
        if (searchResultsEl) {
            searchResultsEl.innerHTML = '';
            var exploreSec = buildSearchSection((i18n.notesSearchExploreResults || 'Notes Exploreの検索結果'));
            var outSec = buildSearchSection((i18n.notesSearchOutlinerResults || 'Outlinerの検索結果'));
            var mdSec = buildSearchSection((i18n.notesSearchMarkdownResults || 'Markdownの検索結果'));
            // FR-DS-05: 第 4 セクション（tree file 添付の中身ヒット — fileType:'file'）
            var filesSec = buildSearchSection((i18n.notesSearchFilesResults || 'Filesの検索結果'));
            searchSectionExplore = exploreSec.section;
            searchSectionExploreBody = exploreSec.body;
            searchSectionExploreTitle = exploreSec.title;
            searchSectionOut = outSec.section;
            searchSectionOutBody = outSec.body;
            searchSectionOutTitle = outSec.title;
            searchSectionMd = mdSec.section;
            searchSectionMdBody = mdSec.body;
            searchSectionMdTitle = mdSec.title;
            searchSectionFiles = filesSec.section;
            searchSectionFilesBody = filesSec.body;
            searchSectionFilesTitle = filesSec.title;
            searchResultsEl.appendChild(searchSectionExplore);
            searchResultsEl.appendChild(searchSectionOut);
            searchResultsEl.appendChild(searchSectionMd);
            searchResultsEl.appendChild(searchSectionFiles);

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
        // FR-SEF-02: ext: を strip した本文で照合（stateless — currentSearch() を都度適用）
        var q = currentSearch();
        var query = q.body;
        if (!query) return;

        var matcher = buildNameMatcher(query);
        if (!matcher) return;

        var matches = []; // [{ id, type: 'file'|'folder', title, filePath?, fileExt? }]
        var fileMap = buildFileMap(fileList);

        Object.keys(structure.items || {}).forEach(function(id) {
            var item = structure.items[id];
            if (!item) return;
            if (item.type === 'folder') {
                // FR-SEF-02: exts 指定時はフォルダ名マッチ非表示（フォルダに拡張子はない）
                var t = item.title || '';
                if (!q.exts && matcher(t)) {
                    matches.push({ id: id, type: 'folder', title: t });
                }
            } else if (item.type === 'file') {
                var fileEntry = fileMap[id];
                var title = (item.title) || (fileEntry && fileEntry.title) || '';
                var fp = fileEntry ? fileEntry.filePath : null;
                // FR-TF-12 (sprint 20260809): kind は listFiles 付与値を優先（無ければ拡張子推測。file 扱いにはしない）。
                var fkind = (fileEntry && fileEntry.kind) || (fp ? (/\.md$/i.test(fp) ? 'md' : 'out') : 'out');
                // 添付 file はタイトルに加えファイル名（basename）部分一致でもヒットさせる。
                var basename = fp ? fp.replace(/^.*[/\\]/, '') : '';
                var hit = matcher(title) || (fkind === 'file' && basename && matcher(basename));
                // FR-SEF-02: exts 指定時は kind 別拡張子で絞り込む（md→'md' / out→'out' /
                // 添付 file→実 extname）。q.exts 非 null は正典存在を含意（currentSearch の縮退契約）
                if (hit && q.exts) {
                    var extKey = fkind === 'file'
                        ? window.SearchExtFilter.extOfName(basename || title)
                        : fkind;
                    hit = window.SearchExtFilter.matchesExt(extKey, q.exts);
                }
                if (hit) {
                    matches.push({
                        id: id, type: 'file', title: title, filePath: fp,
                        fileExt: fkind,
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
            var flags = searchOptions.caseSensitive ? '' : 'i';
            var re;
            if (searchOptions.wholeWord && window.WholeWord) {
                // FR-MLG-02 (sprint 20260818-183407): CJK 素通し + Unicode lookaround（whole-word.js 単一真実）
                re = window.WholeWord.buildWholeWordRegex(pattern, query, flags);
            } else {
                if (searchOptions.wholeWord) pattern = '\\b' + pattern + '\\b'; // helper 未ロード時の従来 fallback
                re = new RegExp(pattern, flags);
            }
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

        // 三値分岐（FR-DS-05）: 'md' / 'file'（添付中身ヒット）/ それ以外 = 'out'。
        // 'file' を md/out に流すと誤セクション + クリック no-op になる（research 統合結論 #1）
        var isMd = fileResult.fileType === 'md';
        var isFile = fileResult.fileType === 'file';
        var parentBody = isFile ? searchSectionFilesBody : (isMd ? searchSectionMdBody : searchSectionOutBody);
        var parentSection = isFile ? searchSectionFiles : (isMd ? searchSectionMd : searchSectionOut);
        if (!parentBody) return;
        parentSection.style.display = '';

        var groupEl = document.createElement('div');
        groupEl.className = 'file-panel-search-file-group';

        var headerEl = document.createElement('div');
        headerEl.className = 'file-panel-search-file-header' + (isMd ? ' is-md' : '');
        headerEl.textContent = fileResult.fileTitle + ' (' + fileResult.matches.length + ')';
        groupEl.appendChild(headerEl);

        var query = currentSearch().body;   // FR-SEF-01: ハイライトは本文クエリ（ext: 非混入）
        fileResult.matches.forEach(function(match, matchIdx) {
            var matchEl = document.createElement('div');
            matchEl.className = 'file-panel-search-match';
            matchEl.innerHTML = highlightSearchText(match.lineText, query);
            // FR-DS-09: 添付ヒットの位置（p.5 / slide 3 / シート名!B12）— docx は loc なし
            if (isFile && match.loc) {
                var locBadge = document.createElement('span');
                locBadge.className = 'file-panel-search-loc';
                locBadge.style.cssText = 'opacity:0.6;font-size:10px;margin-left:4px;';
                locBadge.textContent = '[' + match.loc + ']';
                matchEl.appendChild(locBadge);
            }
            if (match.field !== 'text') {
                var badge = document.createElement('span');
                badge.style.cssText = 'opacity:0.5;font-size:10px;margin-left:4px;';
                badge.textContent = '[' + match.field + ']';
                matchEl.appendChild(badge);
            }
            matchEl.addEventListener('click', function() {
                if (fileResult.fileType === 'file') {
                    // rev.2: fileId は `files/<rel>` — prefix を剥いた相対パスで path ベース起動
                    // （台帳未登録の node📎/md📎 添付も開けるよう openTreeFileExternal(id) から改訂）
                    if (bridge && typeof bridge.openNoteFilesExternal === 'function') {
                        var rel = String(fileResult.fileId || '').replace(/^files\//, '');
                        // FR-VFB-04: 検索語 + 位置ヒント（loc = p.N 等）を viewer へ引き渡す（open + 自動 find）
                        bridge.openNoteFilesExternal(rel, currentSearch().body, match.loc || '');
                    }
                } else if (fileResult.fileType === 'out' && match.nodeId && bridge.jumpToNode) {
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
            if (isFile) searchCountFiles++; else if (isMd) searchCountMd++; else searchCountOut++;
        });

        // FR-DS-10: 逆参照（後追い notesSearchBacklinks）の後付け先マーカー
        if (isFile) { groupEl.setAttribute('data-file-id', fileResult.fileId); }
        parentBody.appendChild(groupEl);

        // セクションタイトルに件数反映
        var outBase = i18n.notesSearchOutlinerResults || 'Outlinerの検索結果';
        var mdBase = i18n.notesSearchMarkdownResults || 'Markdownの検索結果';
        var filesBase = i18n.notesSearchFilesResults || 'Filesの検索結果';
        if (searchSectionOutTitle) searchSectionOutTitle.textContent = outBase + ' (' + searchCountOut + ')';
        if (searchSectionMdTitle) searchSectionMdTitle.textContent = mdBase + ' (' + searchCountMd + ')';
        if (searchSectionFilesTitle) searchSectionFilesTitle.textContent = filesBase + ' (' + searchCountFiles + ')';
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
            var flags = searchOptions.caseSensitive ? 'g' : 'gi';
            var re;
            if (searchOptions.wholeWord && window.WholeWord) {
                // FR-MLG-02: capture group を含めて helper に渡す（境界は group の外側に付く）
                re = window.WholeWord.buildWholeWordRegex('(' + pattern + ')', query, flags);
            } else {
                if (searchOptions.wholeWord) pattern = '\\b' + pattern + '\\b'; // helper 未ロード時の従来 fallback
                re = new RegExp('(' + pattern + ')', flags);
            }
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
        if (bridge.onSearchBacklinks) {
            bridge.onSearchBacklinks(onSearchBacklinks);
        }
    }

    // FR-DS-10 / ADRL-0061: 逆参照の後追い受信 — 該当 file ヒットの group に参照元リンクを追加描画。
    // クリック: node 参照元 = jumpToNode（検索 out ヒットと同じ）/ md 参照元 = note md ダイレクト表示（openFile）
    function onSearchBacklinks(searchId, fileId, backlinks) {
        if (searchId !== currentSearchId) return;
        if (!searchResultsEl || !backlinks || backlinks.length === 0) return;
        var groupEl = searchResultsEl.querySelector('[data-file-id="' + (window.CSS && CSS.escape ? CSS.escape(fileId) : fileId) + '"]');
        if (!groupEl) return;
        var refsEl = document.createElement('div');
        refsEl.className = 'file-panel-search-backlinks';
        refsEl.style.cssText = 'margin:2px 0 4px 12px;font-size:11px;opacity:0.85;';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = (i18n.notesSearchReferencedBy || '参照元') + ': ';
        labelSpan.style.opacity = '0.7';
        refsEl.appendChild(labelSpan);
        backlinks.forEach(function(ref, i) {
            if (i > 0) { refsEl.appendChild(document.createTextNode('  ')); }
            var linkEl = document.createElement('a');
            linkEl.className = 'file-panel-search-backlink';
            linkEl.style.cssText = 'cursor:pointer;text-decoration:underline;';
            linkEl.textContent = (ref.kind === 'node' ? '📓 ' : '📄 ') + ref.label;
            linkEl.addEventListener('click', function(e) {
                e.stopPropagation();
                if (ref.kind === 'node' && ref.outFileId && ref.nodeId && bridge.jumpToNode) {
                    bridge.jumpToNode(ref.outFileId, ref.nodeId);
                } else if (ref.kind === 'md' && ref.mdPath && bridge.openFile) {
                    // md 参照元は note md ダイレクト表示（親 outliner / sidepanel 解決はしない — ユーザー裁定）
                    if (ref.mdPath !== currentFile) { currentFile = ref.mdPath; }
                    bridge.openFile(ref.mdPath, '', 0);
                }
            });
            refsEl.appendChild(linkEl);
        });
        groupEl.appendChild(refsEl);
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

        // FR-TF-16: drag 中 hover 抑止の set/clear 配線（受け側完結ライフサイクル）。
        // capture で拾う: 個別 handler（setupDropTarget 等）が preventDefault/return しても
        // フラグ管理は必ず走る。__hoverSupWired で冪等化（standalone harness は init が 2 回走る）。
        if (panelEl && !panelEl.__hoverSupWired) {
            panelEl.__hoverSupWired = true;
            // set: panel 内に drag が入った/動いた（外部 Files / uri-list / cross-webview MIME / 内部すべて）
            panelEl.addEventListener('dragenter', setDragHoverSuppression, true);
            panelEl.addEventListener('dragover', setDragHoverSuppression, true);
            // clear①: panel の外へ出た（relaxed 判定 — relatedTarget が panel 外 or null。
            // panel 内の要素間移動では clear しない = 抑止が途切れて hover が明滅するのを防ぐ）
            panelEl.addEventListener('dragleave', function(e) {
                var rt = e.relatedTarget;
                if (!rt || !panelEl.contains(rt)) clearDragHoverSuppression();
            });
            // clear②③④: drop / dragend の window capture 安全網（panel 内 drop・内部 drag の
            // dragend・panel 外 drop での終了をすべて拾う。既存の highlight/補助線掃除も束ねる）
            window.addEventListener('drop', clearDragSessionVisuals, true);
            window.addEventListener('dragend', clearDragSessionVisuals, true);
        }
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

        // FR-FTM-01 (sprint 20260818-183407): +file（ファイル選択ダイアログ → tree 登録）
        var addFileEntityBtn = document.getElementById('filePanelAddFileEntity');
        if (addFileEntityBtn) {
            addFileEntityBtn.addEventListener('click', function() {
                if (bridge.addTreeFilesViaDialog) bridge.addTreeFilesViaDialog();
            });
        }

        // FR-FLV-01: +folder（ローカルフォルダリンク追加 — host showOpenDialog）
        var addFolderLinkBtn = document.getElementById('filePanelAddFolderLink');
        if (addFolderLinkBtn) {
            addFolderLinkBtn.addEventListener('click', function() {
                if (bridge.addFolderLink) bridge.addFolderLink();
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
                var fromMdSubpageR = isMdSubpageDrag(e);
                // FR-TF-05b/06b 信頼性 (§4i(2) 2026-08-10): file 系 MIME も余白 dragover で受理する。
                // これが無いと谷間/余白 drop が非 preventDefault で不発（「補助線だけ出て移動しない」）。
                var fromOutNodeFileR = isOutNodeFileDrag(e);
                var fromMdFileLinkR = isMdFileLinkDrag(e);
                // FR-FLV-20 (W2): フォルダビューのエントリ — 余白 drop（ルート末尾）も受理
                var fromFolderViewR = isFolderViewEntryDrag(e);
                // FR-T01: 外部 files（.md）— 内部 drag / outliner / subpage / file 系が無いときのみ
                // FR-TF-17: Explorer uri-list も同列で受理（files が空のため OR が必須）
                var fromExternalR = !dragItemId && !fromOutliner && !fromMdSubpageR && !fromOutNodeFileR && !fromMdFileLinkR && !fromFolderViewR && (isExternalFilesDrag(e) || isVscodeUriListDrag(e));
                if (!dragItemId && !fromOutliner && !fromMdSubpageR && !fromOutNodeFileR && !fromMdFileLinkR && !fromFolderViewR && !fromExternalR) return;
                // 子要素が既にハンドルしている場合はスキップ
                if (e.target !== listEl) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = (fromOutliner || fromMdSubpageR || fromOutNodeFileR || fromMdFileLinkR || fromFolderViewR || fromExternalR) ? 'copy' : 'move';
                // TASK-A2: item 間の谷間では直近の drop-line を復元表示 (線と drop 可否を一致させる)。
                // after 線は X 座標の escalation を毎回再評価 (改善1: 谷間でも階層を選べる)。
                if (!fromOutliner && lastDropLine && lastDropLine.refItemId) {
                    restoreDropLineAt(e.clientX);
                }
            });
            listEl.addEventListener('drop', function(e) {
                if (e.target !== listEl) return;
                var outPayload = isOutNodePageDrag(e) ? readOutNodePagePayload(e) : null;
                var mdSubpagePayloadR = !outPayload && isMdSubpageDrag(e) ? readMdSubpagePayload(e) : null;
                // FR-TF-05b/06b 信頼性 (§4i(2)): file 系 MIME の余白 drop → ルート末尾に登録
                var outNodeFilePayloadR = (!outPayload && !mdSubpagePayloadR) && isOutNodeFileDrag(e) ? readOutNodeFilePayload(e) : null;
                var mdFileLinkPayloadR = (!outPayload && !mdSubpagePayloadR && !outNodeFilePayloadR) && isMdFileLinkDrag(e) ? readMdFileLinkPayload(e) : null;
                e.preventDefault();
                var rootIdsF = structure ? structure.rootIds : [];
                // FR-FLV-20 (W2 受信): フォルダビューのエントリ → ルート末尾に移動登録
                if (!dragItemId && !outPayload && !mdSubpagePayloadR && !outNodeFilePayloadR && !mdFileLinkPayloadR && isFolderViewEntryDrag(e)) {
                    clearAllDragOver();
                    removeDropIndicator();
                    lastDropLine = null;
                    dispatchFolderViewEntryDrop(readFolderViewEntryPayload(e), null, rootIdsF.length);
                    return;
                }
                if (outNodeFilePayloadR && !dragItemId) {
                    clearAllDragOver();
                    removeDropIndicator();
                    lastDropLine = null;
                    if (typeof bridge.notesRegisterFileFromOutNode === 'function') {
                        bridge.notesRegisterFileFromOutNode(outNodeFilePayloadR, null, rootIdsF.length);
                    }
                    return;
                }
                if (mdFileLinkPayloadR && !dragItemId) {
                    clearAllDragOver();
                    removeDropIndicator();
                    lastDropLine = null;
                    if (typeof bridge.notesRegisterFileFromMdLink === 'function') {
                        bridge.notesRegisterFileFromMdLink(mdFileLinkPayloadR, null, rootIdsF.length);
                    }
                    return;
                }
                // FR-T01: 外部 files（.md）→ ルート末尾に登録（内部 drag / outliner / subpage が無いとき）
                if (!dragItemId && !outPayload && !mdSubpagePayloadR && isExternalFilesDrag(e)) {
                    clearAllDragOver();
                    removeDropIndicator();
                    lastDropLine = null;
                    var rootIdsEx = structure ? structure.rootIds : [];
                    registerExternalDroppedFiles(e, null, rootIdsEx.length);
                    return;
                }
                // FR-TF-17: Explorer uri-list → ルート末尾に登録（Files 分岐の後 = Files 優先）
                if (!dragItemId && !outPayload && !mdSubpagePayloadR && isVscodeUriListDrag(e)) {
                    clearAllDragOver();
                    removeDropIndicator();
                    lastDropLine = null;
                    var rootIdsUl = structure ? structure.rootIds : [];
                    registerVscodeUriDrop(e, null, rootIdsUl.length);
                    return;
                }
                if (!dragItemId && !outPayload && !mdSubpagePayloadR) return;
                clearAllDragOver();
                removeDropIndicator();
                var rootIds = structure ? structure.rootIds : [];
                if (outPayload) {
                    if (typeof bridge.notesImportOutPageNodeAsMd === 'function') {
                        bridge.notesImportOutPageNodeAsMd(outPayload, null, rootIds.length);
                    }
                    return;
                }
                // TASK-19: subpage → ルート末尾へ
                if (mdSubpagePayloadR && !dragItemId) {
                    if (typeof bridge.notesRegisterSubpageFromMd === 'function') {
                        bridge.notesRegisterSubpageFromMd(mdSubpagePayloadR, null, rootIds.length);
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
