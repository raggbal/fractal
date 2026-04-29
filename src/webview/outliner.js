/**
 * Outliner — アウトライナUI本体
 *
 * DOM レンダリング、キーハンドラ、折りたたみ制御を担当。
 * ページノードクリック時はホストに openPage を送信し、
 * VSCode が fractal.editor を ViewColumn.Beside で開く。
 * window.outlinerHostBridge 経由でホスト通信。
 */

// eslint-disable-next-line no-unused-vars
var Outliner = (function() {
    'use strict';

    var model;          // OutlinerModel instance
    var searchEngine;   // OutlinerSearch.SearchEngine instance
    var host;           // window.outlinerHostBridge
    var treeEl;         // .outliner-tree DOM element
    var searchInput;    // .outliner-search-input element
    var breadcrumbEl;   // .outliner-breadcrumb element
    var pageTitleEl;     // .outliner-page-title container
    var pageTitleInput;  // .outliner-page-title-input element

    var focusedNodeId = null;
    var currentScope = { type: 'document' };
    var currentSearchResult = null;  // Set<string> or null
    var searchFocusMode = false;     // true: マッチノード頂点+子のみ, false: ルートまで表示
    var pageDir = null;              // outファイル個別のpageDir設定
    var currentOutFileKey = null;    // 同一性判定用の .out ファイル絶対パス (host から updateData で注入)
    var sidePanelWidthSetting = null; // outファイル個別のサイドパネル幅
    var pinnedTags = [];             // 固定タグ配列 (例: ['#TASK', '#TODO'])
    var searchModeToggleBtn = null;  // toggle button element
    var menuBtn = null;              // menu button element
    var undoBtn = null;              // undo button element
    var redoBtn = null;              // redo button element
    var contextMenuEl = null;

    var syncDebounceTimer = null;
    var SYNC_DEBOUNCE_MS = 1000;

    // --- 外部変更検知用 ---
    var isActivelyEditing = false;
    var editingIdleTimer = null;
    var queuedExternalUpdate = null;
    var EDITING_IDLE_TIMEOUT = 1500;

    // --- Navigation history (Back/Forward) ---
    var navBackStack = [];
    var navForwardStack = [];
    var isNavigating = false;
    var MAX_NAV_HISTORY = 50;
    var navBackBtn = null;
    var navForwardBtn = null;

    // --- Daily Notes ---
    var isDailyNotes = false;
    var dailyNavBar = null;
    var dailyCurrentDate = null;  // YYYY-MM-DD

    // --- 複数ノード選択 ---
    var selectedNodeIds = new Set();    // 選択中のノードIDセット
    var selectionAnchorId = null;       // Shift選択の起点ノードID

    // --- 内部クリップボード（ページメタデータ保持用） ---
    var internalClipboard = null;  // { plainText, isCut, nodes: [{text, level, isPage, pageId}] }

    // --- ドラッグ&ドロップ ---
    var dragState = null;       // { nodeId, nodeEl } or null
    var dropIndicator = null;   // DOM element for drop indicator

    // --- 画像 ---
    var imageDir = null;           // .out JSON の imageDir フィールド
    var fileDir = null;            // .out JSON の fileDir フィールド
    var selectedImageInfo = null;  // { nodeId, index, element } or null
    var imageDragState = null;     // { nodeId, fromIndex } or null

    // --- Undo/Redo ---
    //
    // 設計:
    // - baselineSnapshot: 「これ以上戻れない」初期状態。init/updateData/外部変更時に設定。
    //   undoStack には入れない（ボタンが不必要に active にならないため）。
    // - undoStack: 編集前の状態を積む。saveSnapshot() は編集操作の直前に呼ばれる。
    // - redoStack: undo時に現在の状態を積む。
    // - saveSnapshotDebounced(): テキスト入力用。500ms debounce で入力後の状態を積む。
    //
    // フロー:
    //   初期化: baselineSnapshot = serialize() → undo disabled
    //   最初の編集: saveSnapshot() → undoStack が空なので baselineSnapshot を push → 編集実行
    //   undo: current → redo, pop undo → restore (skip if top === current)
    //
    var undoStack = [];
    var redoStack = [];
    var MAX_UNDO = 200;
    var isUndoRedo = false;
    var snapshotDebounceTimer = null;
    var SNAPSHOT_DEBOUNCE_MS = 500;
    var baselineSnapshot = null; // 初期状態（undoStackには入れない）

    function saveSnapshot() {
        if (isUndoRedo) { return; }
        var snapshot = JSON.stringify(model.serialize());
        // 前回と同じなら保存しない
        if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshot) { return; }
        // 最初の編集: baseline を undoStack に入れてから現在の状態を積む
        // （baseline と同じ場合でも push する — Enter等の構造変更ハンドラは
        //   モデル変更前に saveSnapshot() を呼ぶため、この時点では baseline と同じ。
        //   push しないと Undo 先がなくなる）
        if (undoStack.length === 0 && baselineSnapshot) {
            undoStack.push(baselineSnapshot);
        }
        undoStack.push(snapshot);
        if (undoStack.length > MAX_UNDO) { undoStack.shift(); }
        redoStack.length = 0;
        updateUndoRedoButtons();
    }

    /** 初期状態を記録（undoStackには入れない） */
    function saveBaseline() {
        baselineSnapshot = JSON.stringify(model.serialize());
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoRedoButtons();
    }

    /** テキスト入力用デバウンス付きスナップショット（500ms後に保存） */
    function saveSnapshotDebounced() {
        if (isUndoRedo) { return; }
        clearTimeout(snapshotDebounceTimer);
        snapshotDebounceTimer = setTimeout(function() {
            snapshotDebounceTimer = null;
            saveSnapshot();
        }, SNAPSHOT_DEBOUNCE_MS);
    }

    function undo() {
        // デバウンス中のスナップショットをフラッシュ
        if (snapshotDebounceTimer) {
            clearTimeout(snapshotDebounceTimer);
            snapshotDebounceTimer = null;
            saveSnapshot();
        }
        if (undoStack.length === 0) { return; }
        isUndoRedo = true;
        var currentSnapshot = JSON.stringify(model.serialize());
        // top が現在と同じならスキップ（実質的に変化がないため）
        if (undoStack[undoStack.length - 1] === currentSnapshot) {
            undoStack.pop();
            if (undoStack.length === 0) {
                isUndoRedo = false;
                updateUndoRedoButtons();
                return;
            }
        }
        redoStack.push(currentSnapshot);
        var snapshot = undoStack.pop();
        model = new OutlinerModel(JSON.parse(snapshot));
        searchEngine = new OutlinerSearch.SearchEngine(model);
        renderTree();
        if (focusedNodeId && model.getNode(focusedNodeId)) {
            focusNode(focusedNodeId);
        }
        syncToHostImmediate();
        isUndoRedo = false;
        updateUndoRedoButtons();
    }

    function redo() {
        if (redoStack.length === 0) { return; }
        isUndoRedo = true;
        var currentSnapshot = JSON.stringify(model.serialize());
        // top が現在と同じならスキップ
        if (redoStack[redoStack.length - 1] === currentSnapshot) {
            redoStack.pop();
            if (redoStack.length === 0) {
                isUndoRedo = false;
                updateUndoRedoButtons();
                return;
            }
        }
        undoStack.push(currentSnapshot);
        var snapshot = redoStack.pop();
        model = new OutlinerModel(JSON.parse(snapshot));
        searchEngine = new OutlinerSearch.SearchEngine(model);
        renderTree();
        if (focusedNodeId && model.getNode(focusedNodeId)) {
            focusNode(focusedNodeId);
        }
        syncToHostImmediate();
        isUndoRedo = false;
        updateUndoRedoButtons();
    }

    // --- 初期化 ---

    var i18n = window.__outlinerMessages || {};

    // 検索モードアイコン (Lucide風SVG)
    var ICON_TREE_MODE = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>';
    var ICON_FOCUS_MODE = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
    var ICON_MENU = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
    var ICON_UNDO = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 0 1 3-7.7A9 9 0 0 1 21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3"/></svg>';
    var ICON_REDO = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M21 13a9 9 0 0 0-3-7.7A9 9 0 0 0 3 12a9 9 0 0 0 9 9 9 9 0 0 0 6.7-3"/></svg>';

    function init(data, outFileKey) {
        host = window.outlinerHostBridge;
        model = new OutlinerModel(data);
        searchEngine = new OutlinerSearch.SearchEngine(model);
        if (outFileKey) {
            currentOutFileKey = outFileKey;
        }

        // JSONから検索モードを復元
        if (data && data.searchFocusMode) {
            searchFocusMode = true;
        }
        // JSONからpageDirを復元
        if (data && data.pageDir) {
            pageDir = data.pageDir;
        }
        // JSONからimageDirを復元
        if (data && data.imageDir) {
            imageDir = data.imageDir;
        }
        // JSONからfileDirを復元
        if (data && data.fileDir) {
            fileDir = data.fileDir;
        }
        // JSONからpinnedTagsを復元
        if (data && data.pinnedTags) {
            pinnedTags = data.pinnedTags;
        }
        // JSONからサイドパネル幅を復元
        if (data && data.sidePanelWidth) {
            sidePanelWidthSetting = data.sidePanelWidth;
        }

        treeEl = document.querySelector('.outliner-tree');
        searchInput = document.querySelector('.outliner-search-input');
        breadcrumbEl = document.querySelector('.outliner-breadcrumb');
        if (searchInput) { defaultSearchPlaceholder = searchInput.placeholder; }
        searchModeToggleBtn = document.querySelector('.outliner-search-mode-toggle');
        menuBtn = document.querySelector('.outliner-menu-btn');
        undoBtn = document.querySelector('.outliner-undo-btn');
        redoBtn = document.querySelector('.outliner-redo-btn');
        navBackBtn = document.querySelector('.outliner-nav-back-btn');
        navForwardBtn = document.querySelector('.outliner-nav-forward-btn');

        // ページタイトル
        pageTitleEl = document.querySelector('.outliner-page-title');
        pageTitleInput = document.querySelector('.outliner-page-title-input');
        if (pageTitleInput) {
            pageTitleInput.value = model.title || '';
            setupPageTitle();
        }

        // ボタンアイコン初期化
        if (searchModeToggleBtn) {
            updateSearchModeButton();
        }
        if (menuBtn) {
            menuBtn.innerHTML = ICON_MENU;
        }
        if (undoBtn) {
            undoBtn.innerHTML = ICON_UNDO;
        }
        if (redoBtn) {
            redoBtn.innerHTML = ICON_REDO;
        }

        renderTree();
        setupSearchBar();
        setupDailyNavBar();
        setupPinnedSettingsButton();
        updatePinnedTagBar();
        setupKeyHandlers();
        setupContextMenu();
        setupHostMessages();
        setupTextSearchReplace();
        initSidePanel();

        // 初期ベースライン（undoStackには入れない → ボタンdisabled）
        saveBaseline();

        // D&D: treeEl全体のdragover/drop（空エリアへのドロップ対応）
        treeEl.addEventListener('dragover', function(e) {
            // Files D&D (Finder or VSCode Explorer) has priority
            if (isAnyFilesDragEvent(e)) {
                e.preventDefault();
                treeEl.classList.add('outliner-tree-drop-zone-active');
                return;
            }
            // Existing node reorder D&D
            if (!dragState) { return; }
            e.preventDefault();
        });
        treeEl.addEventListener('drop', function(e) {
            // Files D&D: distinguish Finder (Files type) vs VSCode Explorer (uri-list type)
            if (isFilesDragEvent(e)) {
                // Finder path
                e.preventDefault();
                treeEl.classList.remove('outliner-tree-drop-zone-active');
                removeDropIndicator();
                handleFilesDrop(e, null, 'root-end');
                return;
            }
            if (isVscodeUriDragEvent(e)) {
                // VSCode Explorer path (v12 拡張)
                e.preventDefault();
                treeEl.classList.remove('outliner-tree-drop-zone-active');
                removeDropIndicator();
                handleVscodeUrisDrop(e, null, 'root-end');
                return;
            }
            // Existing node reorder D&D
            if (!dragState) { return; }
            if (e.target === treeEl) {
                e.preventDefault();
                saveSnapshot();
                var lastRootId = model.rootIds.length > 0 ? model.rootIds[model.rootIds.length - 1] : null;
                var movedId = dragState.nodeId;
                model.moveNode(movedId, null, lastRootId);
                dragState.nodeEl.classList.remove('is-dragging');
                dragState = null;
                removeDropIndicator();
                renderTree();
                focusNode(movedId);
                scheduleSyncToHost();
            }
        });
        treeEl.addEventListener('dragleave', function(e) {
            if (e.target === treeEl) {
                treeEl.classList.remove('outliner-tree-drop-zone-active');
            }
        });

        // 空の場合、最初のノードを追加
        if (model.rootIds.length === 0) {
            var firstNode = model.addNode(null, null, '');
            renderTree();
            focusNode(firstNode.id);
        } else {
            // 非空の場合、最初のノードにフォーカス
            // webviewが完全にレンダリングされるまで待つ
            setTimeout(function() {
                focusFirstVisibleNode();
            }, 100);
        }
    }

    // --- ドラッグ&ドロップ ヘルパー ---

    /** Check if drag event contains Files (OS file drop / Finder) */
    function isFilesDragEvent(e) {
        return e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
    }

    /** Check if drag event contains VSCode Explorer URI list (v12 拡張) */
    function isVscodeUriDragEvent(e) {
        return e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('application/vnd.code.uri-list') >= 0;
    }

    /** Check if drag event is any file drop (Finder OR VSCode Explorer) */
    function isAnyFilesDragEvent(e) {
        return isFilesDragEvent(e) || isVscodeUriDragEvent(e);
    }

    /** Classify dropped file by extension */
    function classifyDroppedFile(file) {
        // OL-19B 拡張: drawio 多重拡張子は前置判定で 'file' に丸める（filePath 添付経路へ）
        // outliner では .drawio (XML) も棄却ではなく filePath 添付として受け入れる（既存 OL-19B 「Import any files」原則）
        var lower = ((file && file.name) || '').toLowerCase();
        if (lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png')) return 'file';
        if (lower.endsWith('.drawio')) return 'file';
        var ext = (file.name.split('.').pop() || '').toLowerCase();
        if (ext === 'md') return 'md';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].indexOf(ext) >= 0) return 'image';
        return 'file';
    }

    /** Read file content by kind */
    function readFileByKind(file, kind) {
        return new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function() { reject(reader.error); };
            if (kind === 'md') {
                reader.onload = function() { resolve({ content: reader.result }); };
                reader.readAsText(file);
            } else if (kind === 'image') {
                reader.onload = function() { resolve({ dataUrl: reader.result }); };
                reader.readAsDataURL(file);
            } else {
                reader.onload = function() { resolve({ bytes: new Uint8Array(reader.result) }); };
                reader.readAsArrayBuffer(file);
            }
        });
    }

    /** Handle Files D&D drop event */
    async function handleFilesDrop(e, targetNodeId, position) {
        var dt = e.dataTransfer;
        var items = [];
        var rejectedFolders = [];
        var MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

        // 1. Filter out folders and oversized files
        for (var i = 0; i < dt.items.length; i++) {
            var item = dt.items[i];
            var entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
            if (entry && entry.isDirectory) {
                rejectedFolders.push(entry.name);
                continue;
            }
            var file = item.getAsFile();
            if (file) {
                if (file.size > MAX_FILE_SIZE) {
                    host.notifyDropFileTooLarge(file.name);
                    continue;
                }
                items.push(file);
            }
        }

        if (rejectedFolders.length > 0) {
            host.notifyDropFolderRejected(rejectedFolders);
        }
        if (items.length === 0) return;

        // 2. Read each file by kind
        var imports = [];
        for (var j = 0; j < items.length; j++) {
            var f = items[j];
            var kind = classifyDroppedFile(f);
            try {
                var content = await readFileByKind(f, kind);
                imports.push({ kind: kind, name: f.name, ...content });
            } catch (err) {
                // Skip failed reads
                console.warn('Failed to read file:', f.name, err);
            }
        }

        if (imports.length === 0) return;

        // 3. Send to host
        host.dropFilesImport(imports, targetNodeId, position);
    }

    /**
     * Handle VSCode Explorer D&D drop event (v12 拡張)
     * Unlike Finder path, this sends URIs directly to host without FileReader.
     * No 50MB limit (webview memory not involved).
     */
    function handleVscodeUrisDrop(e, targetNodeId, position) {
        var raw = e.dataTransfer.getData('application/vnd.code.uri-list') || '';
        var uris = raw.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
        if (uris.length === 0) return;
        host.dropVscodeUrisImport(uris, targetNodeId, position);
    }

    function showDropIndicator(targetEl, position) {
        removeDropIndicator();
        dropIndicator = document.createElement('div');
        dropIndicator.className = 'outliner-drop-indicator';

        var rect = targetEl.getBoundingClientRect();
        var treeRect = treeEl.getBoundingClientRect();

        dropIndicator.style.position = 'absolute';
        dropIndicator.style.left = '0';
        dropIndicator.style.right = '0';

        if (position === 'before') {
            dropIndicator.style.top = (rect.top - treeRect.top + treeEl.scrollTop) + 'px';
            dropIndicator.style.height = '2px';
        } else if (position === 'after') {
            dropIndicator.style.top = (rect.bottom - treeRect.top + treeEl.scrollTop) + 'px';
            dropIndicator.style.height = '2px';
        } else {
            // child: ターゲット全体をハイライト
            dropIndicator.style.top = (rect.top - treeRect.top + treeEl.scrollTop) + 'px';
            dropIndicator.style.height = rect.height + 'px';
            dropIndicator.style.background = 'rgba(0, 120, 212, 0.1)';
            dropIndicator.style.border = '1px dashed var(--vscode-focusBorder, #007acc)';
            dropIndicator.style.borderRadius = '4px';
        }

        treeEl.style.position = 'relative';
        treeEl.appendChild(dropIndicator);
    }

    function removeDropIndicator() {
        if (dropIndicator) {
            dropIndicator.remove();
            dropIndicator = null;
        }
    }

    // --- レンダリング ---

    function renderTree() {
        treeEl.innerHTML = '';
        updateBreadcrumb();

        if (model.rootIds.length === 0) {
            treeEl.innerHTML = '<div class="outliner-empty">' +
                '<div>' + (i18n.outlinerNoItems || 'No items yet') + '</div>' +
                '<div class="outliner-empty-hint">' + (i18n.outlinerAddHint || 'Press Enter to add an item') + '</div>' +
                '</div>';
            return;
        }

        // スコープ内で子ノードが0個の場合: ヘッダー + 空表示
        if (currentScope.type === 'subtree' && currentScope.rootId) {
            var scopeRootNode = model.getNode(currentScope.rootId);
            if (scopeRootNode && (!scopeRootNode.children || scopeRootNode.children.length === 0)) {
                // スコープヘッダーは表示
                var emptyHeaderEl = createNodeElement(scopeRootNode, 0, null);
                emptyHeaderEl.classList.add('outliner-scope-header');
                treeEl.appendChild(emptyHeaderEl);
                // 空メッセージ
                var emptyDiv = document.createElement('div');
                emptyDiv.className = 'outliner-empty outliner-scope-empty';
                emptyDiv.innerHTML = '<div>' + (i18n.outlinerNoItems || 'No items yet') + '</div>' +
                    '<div class="outliner-empty-hint">' + (i18n.outlinerAddHint || 'Press Enter to add an item') + '</div>';
                emptyDiv.tabIndex = 0;
                emptyDiv.addEventListener('keydown', function(ev) {
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        var newNode = model.addNodeAtStart(currentScope.rootId, '');
                        renderTree();
                        focusNodeAtStart(newNode.id);
                        scheduleSyncToHost();
                    }
                });
                emptyDiv.addEventListener('click', function() {
                    var newNode = model.addNodeAtStart(currentScope.rootId, '');
                    renderTree();
                    focusNodeAtStart(newNode.id);
                    scheduleSyncToHost();
                });
                treeEl.appendChild(emptyDiv);
                emptyDiv.focus();
                return;
            }
        }

        // 検索時のマッチIDをキャッシュ (renderInlineText内での再計算を避ける)
        var searchQuery = null;
        if (currentSearchResult && searchInput) {
            searchQuery = OutlinerSearch.parseQuery(searchInput.value || '');
        }

        var fragment = document.createDocumentFragment();

        if (searchFocusMode && currentSearchResult) {
            // フォーカスモード: マッチノードをフラットに頂点として表示
            renderFocusNodes(fragment, searchQuery);
        } else {
            var rootIds;
            if (currentScope.type === 'subtree' && currentScope.rootId) {
                // スコープヘッダー: スコープ対象ノードをバレットなしで表示
                var scopeNode = model.getNode(currentScope.rootId);
                if (scopeNode) {
                    var headerEl = createNodeElement(scopeNode, 0, searchQuery);
                    headerEl.classList.add('outliner-scope-header');
                    fragment.appendChild(headerEl);
                }
                // スコープ対象の子ノードをトップレベルとして表示
                rootIds = (scopeNode && scopeNode.children && scopeNode.children.length > 0)
                    ? scopeNode.children
                    : [];
            } else {
                rootIds = model.rootIds;
            }
            renderNodes(rootIds, fragment, 0, searchQuery);
        }
        treeEl.appendChild(fragment);
    }

    function renderNodes(nodeIds, parentEl, depth, searchQuery) {
        for (var i = 0; i < nodeIds.length; i++) {
            var nodeId = nodeIds[i];
            var node = model.getNode(nodeId);
            if (!node) { continue; }

            // 検索結果フィルタ
            if (currentSearchResult && !currentSearchResult.has(nodeId)) {
                continue;
            }

            var nodeEl = createNodeElement(node, depth, searchQuery);
            parentEl.appendChild(nodeEl);

            // 子ノード
            if (node.children && node.children.length > 0) {
                var childrenEl = document.createElement('div');
                childrenEl.className = 'outliner-children';
                childrenEl.dataset.parent = nodeId;
                if (node.collapsed && !currentSearchResult) {
                    childrenEl.classList.add('is-collapsed');
                }
                renderNodes(node.children, childrenEl, depth + 1, searchQuery);
                parentEl.appendChild(childrenEl);
            }
        }
    }

    /** フォーカスモード用: マッチノードの祖先パンくずを生成 */
    function createFocusAncestryBreadcrumb(nodeId) {
        var node = model.getNode(nodeId);
        if (!node || !node.parentId) return null;
        var ancestors = [];
        var cur = model.getNode(node.parentId);
        var stopId = (currentScope.type === 'subtree') ? currentScope.rootId : null;
        while (cur) {
            ancestors.unshift(cur);
            if (stopId && cur.id === stopId) break;
            cur = cur.parentId ? model.getNode(cur.parentId) : null;
        }
        if (ancestors.length === 0) return null;
        var breadcrumbEl = document.createElement('div');
        breadcrumbEl.className = 'outliner-focus-ancestry';
        for (var i = 0; i < ancestors.length; i++) {
            if (i > 0) {
                var sep = document.createElement('span');
                sep.className = 'outliner-focus-ancestry-sep';
                sep.textContent = ' \u203A ';
                breadcrumbEl.appendChild(sep);
            }
            var item = document.createElement('span');
            item.className = 'outliner-focus-ancestry-item';
            var text = (ancestors[i].text || '').replace(/[*_~`]+/g, '').slice(0, 30);
            item.textContent = text || '(empty)';
            item.title = ancestors[i].text || '';
            breadcrumbEl.appendChild(item);
        }
        return breadcrumbEl;
    }

    /** フォーカスモード: マッチノードを頂点として、その子孫のみ表示 */
    function renderFocusNodes(parentEl, searchQuery) {
        // マッチノード（子孫でも祖先でもなく、直接マッチしたもの）を検索で再判定
        var query = OutlinerSearch.parseQuery(searchInput.value || '');
        if (!query) { return; }
        // スコープを考慮した候補ノード（scope-in時はスコープ内のみ）
        var allNodeIds = (currentScope.type === 'subtree' && currentScope.rootId)
            ? [currentScope.rootId].concat(model.getDescendantIds(currentScope.rootId))
            : Object.keys(model.nodes);
        var directMatches = [];
        for (var i = 0; i < allNodeIds.length; i++) {
            var nid = allNodeIds[i];
            if (searchEngine._matches(nid, query)) {
                directMatches.push(nid);
            }
        }
        // 各マッチノードを頂点 (depth=0) として描画
        for (var m = 0; m < directMatches.length; m++) {
            var matchId = directMatches[m];
            var node = model.getNode(matchId);
            if (!node) { continue; }
            // 祖先パンくず表示（ノード要素の前）
            var ancestryEl = createFocusAncestryBreadcrumb(matchId);
            if (ancestryEl) {
                parentEl.appendChild(ancestryEl);
            }
            var nodeEl = createNodeElement(node, 0, searchQuery);
            parentEl.appendChild(nodeEl);
            // 子孫を通常描画 (フィルタなし、全子を表示)
            if (node.children && node.children.length > 0) {
                var childrenEl = document.createElement('div');
                childrenEl.className = 'outliner-children';
                childrenEl.dataset.parent = matchId;
                renderFocusChildren(node.children, childrenEl, 1, searchQuery);
                parentEl.appendChild(childrenEl);
            }
        }
    }

    /** フォーカスモード用: 子孫を全て表示 (検索フィルタなし) */
    function renderFocusChildren(nodeIds, parentEl, depth, searchQuery) {
        for (var i = 0; i < nodeIds.length; i++) {
            var nodeId = nodeIds[i];
            var node = model.getNode(nodeId);
            if (!node) { continue; }
            var nodeEl = createNodeElement(node, depth, searchQuery);
            parentEl.appendChild(nodeEl);
            if (node.children && node.children.length > 0) {
                var childrenEl = document.createElement('div');
                childrenEl.className = 'outliner-children';
                childrenEl.dataset.parent = nodeId;
                if (node.collapsed) {
                    childrenEl.classList.add('is-collapsed');
                }
                renderFocusChildren(node.children, childrenEl, depth + 1, searchQuery);
                parentEl.appendChild(childrenEl);
            }
        }
    }

    function createNodeElement(node, depth, searchQuery) {
        var el = document.createElement('div');
        el.className = 'outliner-node';
        el.dataset.id = node.id;
        el.dataset.depth = depth;
        if (node.checked !== null && node.checked !== undefined) {
            el.dataset.checked = String(node.checked);
        }
        if (focusedNodeId === node.id) {
            el.classList.add('is-focused');
        }
        // 直接マッチしたノードのみハイライト
        if (searchQuery && currentSearchResult && searchEngine._matches(node.id, searchQuery)) {
            el.classList.add('is-search-match');
        }

        // インデント
        var indentEl = document.createElement('div');
        indentEl.className = 'outliner-node-indent';
        indentEl.style.width = (depth * 24) + 'px';
        el.appendChild(indentEl);

        // Scope Inボタン（ホバー時に表示）
        var scopeBtn = document.createElement('div');
        scopeBtn.className = 'outliner-scope-btn';
        scopeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>';
        scopeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            setScope({ type: 'subtree', rootId: node.id });
        });
        el.appendChild(scopeBtn);

        // バレット
        var bulletEl = document.createElement('div');
        bulletEl.className = 'outliner-bullet';
        var hasChildren = (node.children && node.children.length > 0);
        bulletEl.dataset.hasChildren = hasChildren;
        if (node.collapsed) {
            bulletEl.dataset.collapsed = 'true';
            if (hasChildren) {
                var countEl = document.createElement('span');
                countEl.className = 'outliner-child-count';
                countEl.textContent = String(node.children.length);
                bulletEl.appendChild(countEl);
            }
        }
        bulletEl.addEventListener('click', function(e) {
            if (e.altKey) {
                setScope({ type: 'subtree', rootId: node.id });
            } else {
                toggleCollapse(node.id);
            }
        });
        // D&D: バレットからドラッグ開始
        bulletEl.draggable = true;
        bulletEl.style.cursor = 'grab';
        bulletEl.addEventListener('dragstart', function(e) {
            e.stopPropagation();
            dragState = { nodeId: node.id, nodeEl: el };
            el.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', node.id);
        });
        bulletEl.addEventListener('dragend', function() {
            if (dragState) {
                dragState.nodeEl.classList.remove('is-dragging');
                dragState = null;
            }
            removeDropIndicator();
        });
        el.appendChild(bulletEl);

        // チェックボックス (タスクノード)
        if (node.checked !== null && node.checked !== undefined) {
            var cbWrap = document.createElement('div');
            cbWrap.className = 'outliner-checkbox';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!node.checked;
            cb.addEventListener('change', function() {
                saveSnapshot();
                node.checked = cb.checked;
                el.dataset.checked = String(cb.checked);
                scheduleSyncToHost();
            });
            cbWrap.appendChild(cb);
            el.appendChild(cbWrap);
        }

        // ページアイコン
        if (node.isPage) {
            var pageIcon = document.createElement('div');
            pageIcon.className = 'outliner-page-icon';
            pageIcon.textContent = '\uD83D\uDCC4'; // 📄
            pageIcon.addEventListener('click', function(e) {
                e.stopPropagation();
                openPage(node.id);
            });
            el.appendChild(pageIcon);
        }

        // ファイルアイコン
        if (node.filePath) {
            var fileIcon = document.createElement('div');
            fileIcon.className = 'outliner-file-icon';
            fileIcon.textContent = '\uD83D\uDCCE'; // 📎
            fileIcon.addEventListener('click', function(e) {
                e.stopPropagation();
                host.openAttachedFile(node.id);
            });
            el.appendChild(fileIcon);
        }

        // テキスト
        var textEl = document.createElement('div');
        textEl.className = 'outliner-text';
        textEl.contentEditable = 'true';
        textEl.spellcheck = false;
        textEl.innerHTML = renderInlineText(node.text);
        textEl.dataset.nodeId = node.id;

        textEl.addEventListener('focus', function() {
            clearImageSelection();
            setFocusedNode(node.id);
            // 編集モードに切替: マーカーを生テキストで表示 (フォーマットは非適用)
            var sourceText = node.text || '';
            var renderedOff = getCursorOffset(textEl);
            textEl.innerHTML = renderEditingText(sourceText);
            if (renderedOff > 0) {
                var sourceOff = renderedOffsetToSource(sourceText, renderedOff);
                setCursorAtOffset(textEl, sourceOff);
            }
        });
        textEl.addEventListener('blur', function() {
            // 表示モードに切替: フルフォーマット適用
            textEl.innerHTML = renderInlineText(node.text || '');
        });

        textEl.addEventListener('mousedown', function(e) {
            // リンククリック: blur状態のノードの<a>タグをクリックでリンクを開く
            if (focusedNodeId !== node.id && !e.shiftKey) {
                var a = e.target.closest ? e.target.closest('a') : null;
                if (a && a.getAttribute('href')) {
                    e.preventDefault();
                    e.stopPropagation();
                    host.openLink(a.getAttribute('href'));
                    return;
                }
            }
            if (e.shiftKey && focusedNodeId && focusedNodeId !== node.id) {
                // Shift+Click: 範囲選択
                e.preventDefault();
                if (!selectionAnchorId) { selectionAnchorId = focusedNodeId; }
                selectRange(selectionAnchorId, node.id);
            } else if (!e.shiftKey) {
                // 通常クリック: 選択クリア（右クリック時は選択を維持）
                if (e.button !== 2 || selectedNodeIds.size === 0) {
                    clearSelection();
                }
            }
        });

        // リンクのデフォルト動作を防止（VSCode webviewがリンクを二重に開くのを防ぐ）
        textEl.addEventListener('click', function(e) {
            var a = e.target.closest ? e.target.closest('a') : null;
            if (a) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // タグダブルクリック検索
        textEl.addEventListener('dblclick', function(e) {
            var tag = e.target.closest('.outliner-tag');
            if (tag) {
                e.preventDefault();
                e.stopPropagation();
                pushNavState();
                isNavigating = true;
                searchInput.value = tag.textContent;
                executeSearch();
                isNavigating = false;
                updateNavButtons();
                searchInput.focus();
            }
        });

        var isComposing = false;
        textEl.addEventListener('compositionstart', function() { isComposing = true; });
        textEl.addEventListener('compositionend', function() {
            isComposing = false;
            // IME確定後に編集モード再描画 (タグのみ)
            var plainText = getPlainText(textEl);
            model.updateText(node.id, plainText);
            var off = getCursorOffset(textEl);
            textEl.innerHTML = renderEditingText(plainText);
            setCursorAtOffset(textEl, off);
            scheduleSyncToHost();
        });
        textEl.addEventListener('input', function() {
            var plainText = getPlainText(textEl);
            model.updateText(node.id, plainText);
            if (!isComposing) {
                // 編集モード再描画 (タグのみハイライト、マーカーは生表示)
                var off = getCursorOffset(textEl);
                textEl.innerHTML = renderEditingText(plainText);
                setCursorAtOffset(textEl, off);
            }
            saveSnapshotDebounced();
            scheduleSyncToHost();
        });

        textEl.addEventListener('paste', function(e) {
            handleNodePaste(e, node.id, textEl);
        });

        textEl.addEventListener('keydown', function(e) {
            handleNodeKeydown(e, node.id, textEl);
        });

        // コンテンツラッパー (テキスト + サブテキスト)
        var contentEl = document.createElement('div');
        contentEl.className = 'outliner-node-content';
        contentEl.appendChild(textEl);

        // サブテキスト
        var subtextEl = document.createElement('div');
        subtextEl.className = 'outliner-subtext';
        subtextEl.dataset.nodeId = node.id;
        if (node.subtext) {
            subtextEl.classList.add('has-content');
            subtextEl.textContent = getSubtextPreview(node.subtext);
        }

        subtextEl.addEventListener('focus', function() {
            // 編集モード: 全文表示
            subtextEl.classList.add('is-editing');
            subtextEl.classList.add('has-content');
            subtextEl.textContent = node.subtext || '';
        });

        subtextEl.addEventListener('blur', function() {
            // モデル更新
            var raw = getSubtextPlainText(subtextEl);
            model.updateSubtext(node.id, raw);
            // 省略表示に切替
            subtextEl.classList.remove('is-editing');
            if (raw) {
                subtextEl.classList.add('has-content');
                subtextEl.textContent = getSubtextPreview(raw);
            } else {
                subtextEl.classList.remove('has-content');
                subtextEl.textContent = '';
            }
            scheduleSyncToHost();
        });

        subtextEl.addEventListener('input', function() {
            // リアルタイムでモデル更新
            var raw = getSubtextPlainText(subtextEl);
            model.updateSubtext(node.id, raw);
            saveSnapshotDebounced();
            scheduleSyncToHost();
        });

        subtextEl.addEventListener('keydown', function(e) {
            handleSubtextKeydown(e, node.id, subtextEl, textEl);
        });

        contentEl.appendChild(subtextEl);

        // 画像サムネイル行
        var imagesEl = document.createElement('div');
        imagesEl.className = 'outliner-images';
        imagesEl.dataset.nodeId = node.id;
        if (node.images && node.images.length > 0) {
            renderNodeImages(imagesEl, node);
        }
        contentEl.appendChild(imagesEl);

        el.appendChild(contentEl);

        // D&D: ノード要素にドロップターゲットイベント
        el.addEventListener('dragover', function(e) {
            // Files D&D (Finder or VSCode Explorer) has priority
            if (isAnyFilesDragEvent(e)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                var rect = el.getBoundingClientRect();
                var y = e.clientY - rect.top;
                var h = rect.height;
                if (y < h * 0.25) showDropIndicator(el, 'before');
                else if (y > h * 0.75) showDropIndicator(el, 'after');
                else showDropIndicator(el, 'child');
                return;
            }
            // Existing node reorder D&D
            if (!dragState) { return; }
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            var targetId = el.dataset.id;
            if (targetId === dragState.nodeId || model.isDescendant(targetId, dragState.nodeId)) {
                e.dataTransfer.dropEffect = 'none';
                removeDropIndicator();
                return;
            }

            var rect = el.getBoundingClientRect();
            var y = e.clientY - rect.top;
            var h = rect.height;
            if (y < h * 0.25) {
                showDropIndicator(el, 'before');
            } else if (y > h * 0.75) {
                showDropIndicator(el, 'after');
            } else {
                showDropIndicator(el, 'child');
            }
        });
        el.addEventListener('dragleave', function(e) {
            if (el.contains(e.relatedTarget)) { return; }
            removeDropIndicator();
        });
        el.addEventListener('drop', function(e) {
            e.preventDefault();
            e.stopPropagation();
            // Files D&D: distinguish Finder vs VSCode Explorer
            if (isFilesDragEvent(e)) {
                // Finder path
                treeEl.classList.remove('outliner-tree-drop-zone-active');
                var rect = el.getBoundingClientRect();
                var y = e.clientY - rect.top;
                var h = rect.height;
                var pos = (y < h * 0.25) ? 'before' : (y > h * 0.75) ? 'after' : 'child';
                var targetId = el.dataset.id;
                removeDropIndicator();
                handleFilesDrop(e, targetId, pos);
                return;
            }
            if (isVscodeUriDragEvent(e)) {
                // VSCode Explorer path (v12 拡張)
                treeEl.classList.remove('outliner-tree-drop-zone-active');
                var rect = el.getBoundingClientRect();
                var y = e.clientY - rect.top;
                var h = rect.height;
                var pos = (y < h * 0.25) ? 'before' : (y > h * 0.75) ? 'after' : 'child';
                var targetId = el.dataset.id;
                removeDropIndicator();
                handleVscodeUrisDrop(e, targetId, pos);
                return;
            }
            // Existing node reorder D&D
            if (!dragState) { return; }

            var targetId = el.dataset.id;
            if (targetId === dragState.nodeId || model.isDescendant(targetId, dragState.nodeId)) {
                removeDropIndicator();
                return;
            }

            var rect = el.getBoundingClientRect();
            var y = e.clientY - rect.top;
            var h = rect.height;

            saveSnapshot();
            var movedNodeId = dragState.nodeId;
            var targetNode = model.getNode(targetId);

            if (y < h * 0.25) {
                // before: targetの前に兄弟として挿入
                var info = model._getSiblingInfo(targetId);
                var afterId = info && info.index > 0 ? info.siblings[info.index - 1] : null;
                model.moveNode(movedNodeId, targetNode.parentId, afterId);
            } else if (y > h * 0.75) {
                // after: targetの後に兄弟として挿入
                model.moveNode(movedNodeId, targetNode.parentId, targetId);
            } else {
                // child: targetの子の先頭に挿入
                model.moveNode(movedNodeId, targetId, null);
                targetNode.collapsed = false;
            }

            dragState.nodeEl.classList.remove('is-dragging');
            dragState = null;
            removeDropIndicator();

            renderTree();
            focusNode(movedNodeId);
            scheduleSyncToHost();
        });

        return el;
    }

    /** contenteditable要素から改行を正規化してプレーンテキストを取得 */
    function getSubtextPlainText(element) {
        var result = '';
        var children = element.childNodes;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 1 && child.tagName === 'BR') {
                result += '\n';
            } else if (child.nodeType === 3) {
                result += child.textContent;
            } else if (child.nodeType === 1) {
                // div等のブロック要素（ブラウザが挿入する場合がある）
                if (result.length > 0 && result[result.length - 1] !== '\n') {
                    result += '\n';
                }
                result += getSubtextPlainText(child);
            }
        }
        return result;
    }

    /** サブテキストの省略表示テキストを生成 */
    function getSubtextPreview(subtext) {
        if (!subtext) { return ''; }
        var firstLine = subtext.split('\n')[0];
        var hasMore = subtext.indexOf('\n') >= 0;
        return hasMore ? firstLine + ' ...' : firstLine;
    }

    // --- 画像サムネイル ---

    function resolveImageSrc(imagePath) {
        var baseUri = window.__outlinerImageBaseUri;
        if (!baseUri) { return imagePath; }
        return baseUri + '/' + imagePath.replace(/^\.\//, '');
    }

    /** コンテナ内のマウス位置から最も近いドロップインデックスを算出 */
    function getImageDropIndex(container, clientX, clientY) {
        var thumbs = container.querySelectorAll('.outliner-image-thumb');
        if (thumbs.length === 0) { return 0; }
        var bestIdx = 0;
        var bestDist = Infinity;
        for (var i = 0; i < thumbs.length; i++) {
            var rect = thumbs[i].getBoundingClientRect();
            var leftEdge = rect.left;
            var rightEdge = rect.right;
            var centerY = rect.top + rect.height / 2;
            var dy = Math.abs(clientY - centerY);
            // 左端との距離 → before this image
            var dLeft = Math.sqrt(Math.pow(clientX - leftEdge, 2) + Math.pow(dy, 2));
            if (dLeft < bestDist) { bestDist = dLeft; bestIdx = i; }
            // 右端との距離 → after this image
            var dRight = Math.sqrt(Math.pow(clientX - rightEdge, 2) + Math.pow(dy, 2));
            if (dRight < bestDist) { bestDist = dRight; bestIdx = i + 1; }
        }
        return bestIdx;
    }

    /** ドロップインジケーターを表示（指定インデックスの左に青線） */
    function showImageDropIndicator(container, dropIdx) {
        var thumbs = container.querySelectorAll('.outliner-image-thumb');
        for (var t = 0; t < thumbs.length; t++) {
            thumbs[t].classList.remove('drop-before', 'drop-after');
        }
        if (dropIdx <= 0 && thumbs.length > 0) {
            thumbs[0].classList.add('drop-before');
        } else if (dropIdx >= thumbs.length && thumbs.length > 0) {
            thumbs[thumbs.length - 1].classList.add('drop-after');
        } else if (dropIdx > 0 && dropIdx < thumbs.length) {
            thumbs[dropIdx].classList.add('drop-before');
        }
    }

    function clearImageDropIndicators(container) {
        var thumbs = container.querySelectorAll('.outliner-image-thumb');
        for (var t = 0; t < thumbs.length; t++) {
            thumbs[t].classList.remove('drop-before', 'drop-after', 'is-dragging');
        }
    }

    function renderNodeImages(container, node) {
        container.innerHTML = '';
        if (!node || !node.images || node.images.length === 0) { return; }

        for (var i = 0; i < node.images.length; i++) {
            (function(idx) {
                var img = document.createElement('img');
                img.className = 'outliner-image-thumb';
                img.dataset.index = idx;
                img.dataset.nodeId = node.id;
                img.src = resolveImageSrc(node.images[idx]);
                img.draggable = true;
                img.alt = '';

                img.addEventListener('click', function(e) {
                    e.stopPropagation();
                    clearImageSelection();
                    img.classList.add('is-selected');
                    selectedImageInfo = { nodeId: node.id, index: idx, element: img };
                });

                img.addEventListener('dblclick', function(e) {
                    e.stopPropagation();
                    showImageOverlay(img.src);
                });

                img.addEventListener('dragstart', function(e) {
                    e.stopPropagation();
                    imageDragState = { nodeId: node.id, fromIndex: idx };
                    img.classList.add('is-dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', 'outliner-image');
                });

                img.addEventListener('dragend', function() {
                    imageDragState = null;
                    clearImageDropIndicators(container);
                });

                container.appendChild(img);
            })(i);
        }

        // コンテナレベルでのD&D（画像間の隙間でもドロップ可能にする）
        container.addEventListener('dragover', function(e) {
            if (!imageDragState || imageDragState.nodeId !== node.id) { return; }
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            var dropIdx = getImageDropIndex(container, e.clientX, e.clientY);
            showImageDropIndicator(container, dropIdx);
        });

        container.addEventListener('dragleave', function(e) {
            if (container.contains(e.relatedTarget)) { return; }
            clearImageDropIndicators(container);
        });

        container.addEventListener('drop', function(e) {
            if (!imageDragState || imageDragState.nodeId !== node.id) { return; }
            e.preventDefault();
            e.stopPropagation();
            var toIdx = getImageDropIndex(container, e.clientX, e.clientY);
            if (imageDragState.fromIndex !== toIdx && imageDragState.fromIndex !== toIdx - 1) {
                saveSnapshot();
                model.moveImage(node.id, imageDragState.fromIndex, toIdx);
                renderNodeImages(container, model.getNode(node.id));
                scheduleSyncToHost();
            }
            imageDragState = null;
            clearImageDropIndicators(container);
        });
    }

    function clearImageSelection() {
        if (selectedImageInfo) {
            selectedImageInfo.element.classList.remove('is-selected');
            selectedImageInfo = null;
        }
    }

    function showImageOverlay(src) {
        var overlay = document.createElement('div');
        overlay.className = 'outliner-image-overlay';

        var largeImg = document.createElement('img');
        largeImg.className = 'outliner-image-large';
        largeImg.src = src;

        overlay.appendChild(largeImg);

        var hint = document.createElement('div');
        hint.className = 'outliner-image-overlay-hint';
        hint.textContent = 'Pinch to zoom · Drag to pan · Double-click to reset · ESC to close';
        overlay.appendChild(hint);

        document.body.appendChild(overlay);

        // Pinch zoom + drag pan (Mac touchpad pinch reports as wheel + ctrlKey)
        var scale = 1, tx = 0, ty = 0;
        var isDragging = false, dragStartX = 0, dragStartY = 0;
        var MIN_SCALE = 0.2, MAX_SCALE = 16;
        function apply() {
            largeImg.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
        }
        overlay.addEventListener('wheel', function(ev) {
            if (!ev.ctrlKey) return;
            ev.preventDefault();
            var delta = -ev.deltaY * 0.01;
            var newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * (1 + delta)));
            if (newScale === scale) return;
            var rect = largeImg.getBoundingClientRect();
            var ox = ev.clientX - rect.left;
            var oy = ev.clientY - rect.top;
            tx += ox * (1 - newScale / scale);
            ty += oy * (1 - newScale / scale);
            scale = newScale;
            apply();
        }, { passive: false });
        largeImg.addEventListener('mousedown', function(ev) {
            ev.preventDefault();
            isDragging = true;
            dragStartX = ev.clientX - tx;
            dragStartY = ev.clientY - ty;
            largeImg.style.cursor = 'grabbing';
        });
        var onMove = function(ev) {
            if (!isDragging) return;
            tx = ev.clientX - dragStartX;
            ty = ev.clientY - dragStartY;
            apply();
        };
        var onUp = function() {
            isDragging = false;
            largeImg.style.cursor = 'default';
        };
        overlay.addEventListener('mousemove', onMove);
        overlay.addEventListener('mouseup', onUp);
        overlay.addEventListener('mouseleave', onUp);
        largeImg.addEventListener('dblclick', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            scale = 1; tx = 0; ty = 0;
            apply();
        });

        overlay.addEventListener('click', function(ev) {
            if (ev.target === overlay) { overlay.remove(); }
        });
        var escHandler = function(ev) {
            if (ev.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * テキスト中のURLをMarkdownリンク形式 [URL](URL) に変換する。
     * 既にMarkdownリンク内にあるURL（[text](url) の url 部分）は変換しない。
     */
    function convertUrlsToMarkdownLinks(text) {
        if (!text) { return text; }
        if (typeof MarkdownLinkParser === 'undefined') { return text; }
        // balanced paren 対応で 1 パス走査: URL 内の () をネスト追跡、末尾句読点を除外。
        // 既に Markdown link 内 ([ の直後 or ]( の直後) にある URL はスキップする。
        var out = '';
        var i = 0;
        var len = text.length;
        while (i < len) {
            var head = text.slice(i, i + 8).toLowerCase();
            if (head.indexOf('http://') === 0 || head.indexOf('https://') === 0) {
                var prevCh = i > 0 ? text.charAt(i - 1) : '';
                var prev2 = i > 1 ? text.slice(i - 2, i) : '';
                var inLink = prevCh === '[' || prev2 === '](';
                if (!inLink) {
                    var found = MarkdownLinkParser.extractUrlWithBalancedParens(text, i);
                    if (found) {
                        out += '[' + found.url + '](' + found.url + ')';
                        i = found.endIndex;
                        continue;
                    }
                }
            }
            out += text.charAt(i);
            i++;
        }
        return out;
    }

    /** リンクhrefからリンク種別のCSSクラスを返す */
    function classifyLinkHref(href) {
        if (!href) return '';
        if (href.startsWith('fractal://note/')) {
            return /\/page\/[^/?]+$/.test(href) ? 'link-fractal-page' : 'link-fractal-node';
        }
        if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('#') &&
            /\.(?:md|markdown)(?:[#?]|$)/i.test(href)) {
            return 'link-internal-md';
        }
        return '';
    }

    /** プレーンテキストからインラインMarkdownをHTMLに変換 */
    function renderInlineText(text) {
        if (!text) { return ''; }

        // エスケープ
        var html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // インラインコード (先に処理してコード内を保護)
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // 太字
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // 斜体 — **の一部である*にマッチしないよう lookbehind/lookahead を使用
        html = html.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '<em>$1</em>');

        // 取り消し線
        html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        // リンク — Markdownリンクと生URLを一時退避してからタグ変換（URL内の@をタグ化しない）
        var linkPlaceholders = [];
        // まず Markdown リンク [text](url) を balanced paren parser で退避
        if (typeof MarkdownLinkParser !== 'undefined') {
            var inlineLinks = MarkdownLinkParser.parseMarkdownLinks(html);
            // end 降順に置換 (index ズレ回避)
            var sortedInline = inlineLinks.slice().sort(function(a, b) { return b.end - a.end; });
            for (var ili = 0; ili < sortedInline.length; ili++) {
                var il = sortedInline[ili];
                if (il.kind === 'link' && il.alt.length > 0) {
                    var ilClass = classifyLinkHref(il.url);
                    var ilClassAttr = ilClass ? ' class="' + ilClass + '"' : '';
                    var ilTag = '<a href="' + il.url + '"' + ilClassAttr + ' title="' + il.url + '">' + il.alt + '</a>';
                    linkPlaceholders.push(ilTag);
                    html = html.slice(0, il.start) + '\x00LINK' + (linkPlaceholders.length - 1) + '\x00' + html.slice(il.end);
                } else if (il.kind === 'image') {
                    // image syntax in outliner は通常のテキストとして表示するので退避のみ
                    linkPlaceholders.push(html.slice(il.start, il.end));
                    html = html.slice(0, il.start) + '\x00LINK' + (linkPlaceholders.length - 1) + '\x00' + html.slice(il.end);
                }
            }
        }
        // 次に生 URL (https://...) も balanced paren 対応で退避
        var rawUrlOut = '';
        var rawUrlI = 0;
        while (rawUrlI < html.length) {
            var rawHead = html.slice(rawUrlI, rawUrlI + 8).toLowerCase();
            if ((rawHead.indexOf('http://') === 0 || rawHead.indexOf('https://') === 0) && typeof MarkdownLinkParser !== 'undefined') {
                var rawFound = MarkdownLinkParser.extractUrlWithBalancedParens(html, rawUrlI);
                if (rawFound) {
                    linkPlaceholders.push(rawFound.url);
                    rawUrlOut += '\x00LINK' + (linkPlaceholders.length - 1) + '\x00';
                    rawUrlI = rawFound.endIndex;
                    continue;
                }
            }
            rawUrlOut += html.charAt(rawUrlI);
            rawUrlI++;
        }
        html = rawUrlOut;

        // タグ (#tag / @tag) — \w では日本語にマッチしないため Unicode プロパティを使用
        html = html.replace(/(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu, '<span class="outliner-tag">$1</span>');
        html = html.replace(/\x00LINK(\d+)\x00/g, function(_, idx) {
            return linkPlaceholders[parseInt(idx, 10)];
        });

        // 末尾スペースをNBSPに変換 (contenteditableで末尾空白が描画されない問題を回避)
        html = html.replace(/ $/, '\u00A0');

        return html;
    }

    /**
     * ソーステキスト（マーカー付き）からマーカーを除去してレンダリング後テキストを返す。
     * renderInlineText と同じ正規表現順序で処理する。
     */
    function stripInlineMarkers(text) {
        if (!text) { return ''; }
        text = text.replace(/`([^`]+)`/g, '$1');
        text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
        text = text.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '$1');
        text = text.replace(/~~([^~]+)~~/g, '$1');
        return text;
    }

    /**
     * 編集モード用のテキストレンダリング。
     * マーカー(*、**、~~、`)はそのまま表示し、タグのみハイライトする。
     * textContent がソーステキストと一致するため、オフセット計算が安全。
     */
    function renderEditingText(text) {
        if (!text) { return ''; }
        var html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        // タグのみハイライト (テキスト内容を変えないのでオフセットに影響なし)
        // URL内の@をタグ化しないよう、URLを一時退避してからタグ変換
        var urlPlaceholders = [];
        html = html.replace(/https?:\/\/\S+/g, function(match) {
            urlPlaceholders.push(match);
            return '\x00URL' + (urlPlaceholders.length - 1) + '\x00';
        });
        html = html.replace(/(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu, '<span class="outliner-tag">$1</span>');
        html = html.replace(/\x00URL(\d+)\x00/g, function(_, idx) {
            return urlPlaceholders[parseInt(idx, 10)];
        });
        // 末尾スペースをNBSPに変換
        html = html.replace(/ $/, '\u00A0');
        return html;
    }

    /**
     * レンダリング後テキストのオフセットをソーステキストのオフセットに変換する。
     * sourceText: マーカー付きテキスト, renderedOffset: マーカー除去後のオフセット
     */
    function renderedOffsetToSource(sourceText, renderedOffset) {
        var rendered = stripInlineMarkers(sourceText);
        var map = buildRenderedToSourceMap(sourceText, rendered);
        if (renderedOffset >= map.length) { return sourceText.length; }
        return map[renderedOffset];
    }

    /**
     * ソーステキストのオフセットをレンダリング後テキストのオフセットに変換する。
     */
    function sourceOffsetToRendered(sourceText, sourceOffset) {
        var rendered = stripInlineMarkers(sourceText);
        var map = buildRenderedToSourceMap(sourceText, rendered);
        // mapの中からsourceOffset以上の最初のエントリのインデックスを返す
        for (var i = 0; i < map.length; i++) {
            if (map[i] >= sourceOffset) { return i; }
        }
        return rendered.length;
    }

    /**
     * レンダリング後テキストの各位置がソーステキストのどの位置に対応するかのマップを構築。
     * map[renderedPos] = sourcePos
     */
    function buildRenderedToSourceMap(sourceText, renderedText) {
        var map = [];
        var si = 0;
        for (var ri = 0; ri < renderedText.length; ri++) {
            while (si < sourceText.length && sourceText[si] !== renderedText[ri]) {
                si++;
            }
            map.push(si);
            si++;
        }
        // 末尾位置
        map.push(sourceText.length);
        return map;
    }

    /** contenteditable からプレーンテキストを取得 (NBSPは通常スペースに正規化) */
    function getPlainText(el) {
        return (el.textContent || '').replace(/\u00A0/g, ' ');
    }

    /**
     * インラインフォーマット適用 (Cmd+B/I/E, Cmd+Shift+S)
     * テキスト選択中: 選択範囲をマーカーで囲む / すでに囲まれていたら除去
     * 選択なし: カーソル位置にマーカーペアを挿入してその間にカーソル配置
     */
    function applyInlineFormat(nodeId, textEl, marker) {
        var node = model.getNode(nodeId);
        if (!node) { return; }
        var text = node.text;
        var sel = window.getSelection();
        var off = getCursorOffset(textEl);

        if (sel && !sel.isCollapsed) {
            // 選択範囲あり (編集モードなのでオフセットはソーステキスト空間)
            var range = sel.getRangeAt(0);
            var preRange = range.cloneRange();
            preRange.selectNodeContents(textEl);
            preRange.setEnd(range.startContainer, range.startOffset);
            var startOff = preRange.toString().length;
            var endOff = startOff + range.toString().length;

            var selected = text.slice(startOff, endOff);
            var before = text.slice(0, startOff);
            var after = text.slice(endOff);

            // トグル: すでにマーカーで囲まれている場合は除去
            if (before.endsWith(marker) && after.startsWith(marker)) {
                // ケース1: マーカーが選択範囲の外側にある (例: **|text|**)
                var newText = before.slice(0, -marker.length) + selected + after.slice(marker.length);
                model.updateText(nodeId, newText);
                textEl.innerHTML = renderEditingText(newText);
                setCursorAtOffset(textEl, endOff - marker.length);
            } else if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > 2 * marker.length) {
                // ケース2: マーカーが選択範囲の内側にある (例: |**text**| を選択してCmd+B)
                var stripped = selected.slice(marker.length, -marker.length);
                var newText1b = before + stripped + after;
                model.updateText(nodeId, newText1b);
                textEl.innerHTML = renderEditingText(newText1b);
                setCursorAtOffset(textEl, startOff + stripped.length);
            } else {
                var newText2 = before + marker + selected + marker + after;
                model.updateText(nodeId, newText2);
                textEl.innerHTML = renderEditingText(newText2);
                // カーソルを閉じマーカーの直後に配置
                setCursorAtOffset(textEl, endOff + 2 * marker.length);
            }
        } else {
            // 選択なし: マーカーペア挿入
            var newText3 = text.slice(0, off) + marker + marker + text.slice(off);
            model.updateText(nodeId, newText3);
            textEl.innerHTML = renderEditingText(newText3);
            setCursorAtOffset(textEl, off + marker.length);
        }
        scheduleSyncToHost();
    }

    // --- カーソル操作 ---

    function setCursorToEnd(el) {
        var range = document.createRange();
        var sel = window.getSelection();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setCursorToStart(el) {
        var range = document.createRange();
        var sel = window.getSelection();
        range.selectNodeContents(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setCursorAtOffset(el, offset) {
        var range = document.createRange();
        var sel = window.getSelection();
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var textNode = walker.nextNode();
        if (!textNode) {
            range.selectNodeContents(el);
            range.collapse(true);
        } else {
            var pos = 0;
            do {
                var len = textNode.textContent.length;
                if (pos + len >= offset) {
                    range.setStart(textNode, offset - pos);
                    range.collapse(true);
                    break;
                }
                pos += len;
            } while ((textNode = walker.nextNode()));
            if (!textNode) {
                range.selectNodeContents(el);
                range.collapse(false);
            }
        }
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function getCursorOffset(el) {
        var sel = window.getSelection();
        if (!sel.rangeCount) { return 0; }
        var range = sel.getRangeAt(0);
        var preRange = range.cloneRange();
        preRange.selectNodeContents(el);
        preRange.setEnd(range.startContainer, range.startOffset);
        return preRange.toString().length;
    }

    // --- フォーカス管理 ---

    function setFocusedNode(nodeId) {
        if (focusedNodeId === nodeId) { return; }
        if (focusedNodeId) {
            var prevEl = treeEl.querySelector('.outliner-node[data-id="' + focusedNodeId + '"]');
            if (prevEl) {
                prevEl.classList.remove('is-focused');
                // 前ノードのsubtextをプレビュー表示に戻す
                var prevSubtext = prevEl.querySelector('.outliner-subtext');
                if (prevSubtext && !prevSubtext.classList.contains('is-editing')) {
                    var prevNode = model.getNode(focusedNodeId);
                    if (prevNode && prevNode.subtext) {
                        prevSubtext.textContent = getSubtextPreview(prevNode.subtext);
                    }
                }
            }
        }
        focusedNodeId = nodeId;
        var el = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"]');
        if (el) {
            el.classList.add('is-focused');
            // フォーカスしたノードのsubtextを全文表示
            var subtextEl = el.querySelector('.outliner-subtext');
            if (subtextEl && !subtextEl.classList.contains('is-editing')) {
                var focusNode = model.getNode(nodeId);
                if (focusNode && focusNode.subtext) {
                    subtextEl.textContent = focusNode.subtext;
                }
            }
        }
    }

    // --- 複数ノード選択管理 ---

    /** 選択をクリアしてDOM反映 */
    function clearSelection() {
        selectedNodeIds.forEach(function(id) {
            var el = treeEl.querySelector('.outliner-node[data-id="' + id + '"]');
            if (el) { el.classList.remove('is-selected'); }
        });
        selectedNodeIds.clear();
        selectionAnchorId = null;
    }

    /** DOMの選択ハイライトだけクリア (anchorはリセットしない) */
    function clearSelectionVisual() {
        selectedNodeIds.forEach(function(id) {
            var el = treeEl.querySelector('.outliner-node[data-id="' + id + '"]');
            if (el) { el.classList.remove('is-selected'); }
        });
        selectedNodeIds.clear();
    }

    /** 指定範囲のノードを選択 (fromId〜toId の表示順) */
    function selectRange(fromId, toId) {
        clearSelectionVisual();  // anchorを維持したままビジュアルだけクリア
        var flat = model.getFlattenedIds(true);
        var i1 = flat.indexOf(fromId);
        var i2 = flat.indexOf(toId);
        if (i1 < 0 || i2 < 0) { return; }
        var start = Math.min(i1, i2);
        var end = Math.max(i1, i2);
        for (var i = start; i <= end; i++) {
            selectedNodeIds.add(flat[i]);
            var el = treeEl.querySelector('.outliner-node[data-id="' + flat[i] + '"]');
            if (el) { el.classList.add('is-selected'); }
        }
    }

    /** 選択中ノードのテキストをインデント付きで取得 (表示順) */
    function getSelectedText() {
        var flat = model.getFlattenedIds(true);
        // 選択ノードの最小深さを求めて相対インデントにする
        var minDepth = Infinity;
        var selectedFlat = [];
        for (var i = 0; i < flat.length; i++) {
            if (selectedNodeIds.has(flat[i])) {
                var depth = model.getDepth(flat[i]);
                if (depth < minDepth) { minDepth = depth; }
                selectedFlat.push(flat[i]);
            }
        }
        var lines = [];
        for (var j = 0; j < selectedFlat.length; j++) {
            var node = model.getNode(selectedFlat[j]);
            if (!node) { continue; }
            var relDepth = model.getDepth(selectedFlat[j]) - minDepth;
            var indent = '';
            for (var k = 0; k < relDepth; k++) { indent += '\t'; }
            lines.push(indent + node.text);
        }
        return lines.join('\n');
    }

    /** 選択中ノードのテキスト+ページメタデータを取得 (表示順) */
    function getSelectedNodesData() {
        var flat = model.getFlattenedIds(true);
        var minDepth = Infinity;
        var selectedFlat = [];
        for (var i = 0; i < flat.length; i++) {
            if (selectedNodeIds.has(flat[i])) {
                var depth = model.getDepth(flat[i]);
                if (depth < minDepth) { minDepth = depth; }
                selectedFlat.push(flat[i]);
            }
        }
        var nodes = [];
        for (var j = 0; j < selectedFlat.length; j++) {
            var nd = model.getNode(selectedFlat[j]);
            if (!nd) { continue; }
            var relDepth = model.getDepth(selectedFlat[j]) - minDepth;
            nodes.push({
                text: nd.text,
                level: relDepth,
                isPage: nd.isPage || false,
                pageId: nd.pageId || null,
                images: (nd.images && nd.images.length > 0) ? nd.images.slice() : [],
                filePath: nd.filePath || null
            });
        }
        return nodes;
    }

    /** 内部クリップボードの照合（テキスト一致チェック） */
    function getValidInternalClipboard(clipText) {
        if (!internalClipboard) { return null; }
        if (internalClipboard.plainText !== clipText) { return null; }
        return internalClipboard;
    }

    /** HTMLクリップボードからcross-outlinerメタデータを抽出 */
    function extractOutlinerClipboardMeta(html) {
        if (!html) { return null; }
        var match = html.match(/data-outliner-clipboard="([^"]*)"/);
        if (!match) { return null; }
        try {
            return JSON.parse(decodeURIComponent(match[1]));
        } catch (e) { return null; }
    }

    /** 選択ノードデータからネストされた <ul>/<li> HTML を生成（clipboard text/html 用） */
    function buildSelectedNodesHtml(nodesData) {
        if (!nodesData || nodesData.length === 0) { return ''; }
        var esc = function(s) {
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };
        var html = '';
        var prevLevel = -1;
        for (var i = 0; i < nodesData.length; i++) {
            var level = nodesData[i].level;
            if (level > prevLevel) {
                // ネスト深化: 新しい <ul> を開く
                for (var j = prevLevel; j < level; j++) {
                    html += '<ul>';
                }
            } else if (level < prevLevel) {
                // ネスト浅化: 現在の </li> を閉じ、差分の </ul></li> を閉じる
                html += '</li>';
                for (var j = prevLevel; j > level; j--) {
                    html += '</ul></li>';
                }
            } else if (i > 0) {
                // 同レベル: 前の </li> を閉じる
                html += '</li>';
            }
            html += '<li>' + esc(nodesData[i].text);
            prevLevel = level;
        }
        // 残りのタグを閉じる
        html += '</li>';
        for (var j = prevLevel; j > 0; j--) {
            html += '</ul></li>';
        }
        html += '</ul>';
        return html;
    }

    /** クリップボードに text/plain + text/html を書き込む (cross-outlinerメタデータ埋め込み) */
    function writeClipboardWithHtml(plainText, nodesData, isCut) {
        var htmlText = buildSelectedNodesHtml(nodesData);
        // メタデータをHTMLに埋め込み (cross-webview paste用)
        var metaJson = JSON.stringify({ nodes: nodesData, sourceOutFileKey: currentOutFileKey, isCut: !!isCut });
        htmlText = htmlText.replace(/^<ul>/, '<ul data-outliner-clipboard="' + encodeURIComponent(metaJson) + '">');
        try {
            navigator.clipboard.write([
                new ClipboardItem({
                    'text/plain': new Blob([plainText], { type: 'text/plain' }),
                    'text/html': new Blob([htmlText], { type: 'text/html' })
                })
            ]);
        } catch (err) {
            navigator.clipboard.writeText(plainText);
        }
    }

    /** 選択中ノードを削除 */
    function deleteSelectedNodes() {
        if (selectedNodeIds.size === 0) { return; }
        saveSnapshot();
        var flat = model.getFlattenedIds(true);
        // 最初の選択ノードの前のノードにフォーカスを戻す
        var firstIdx = -1;
        for (var i = 0; i < flat.length; i++) {
            if (selectedNodeIds.has(flat[i])) { firstIdx = i; break; }
        }
        var focusTarget = firstIdx > 0 ? flat[firstIdx - 1] : null;
        // 逆順で削除 (子→親の順)
        for (var j = flat.length - 1; j >= 0; j--) {
            if (selectedNodeIds.has(flat[j])) {
                model.removeNode(flat[j]);
            }
        }
        clearSelection();
        // スコープ対象ノードが削除された場合、ドキュメントスコープに戻す
        if (currentScope.type === 'subtree' && !model.getNode(currentScope.rootId)) {
            setScope({ type: 'document' });
        }
        renderTree();
        if (focusTarget && model.getNode(focusTarget)) {
            focusNode(focusTarget);
        } else if (model.rootIds.length > 0) {
            focusNode(model.rootIds[0]);
        }
        scheduleSyncToHost();
    }

    /** paste イベントハンドラ (keydownではなくpasteイベントで処理) */
    function handleNodePaste(e, nodeId, textEl) {
        // 画像ペースト判定（テキストより先に判定）
        if (e.clipboardData && e.clipboardData.items) {
            for (var ci = 0; ci < e.clipboardData.items.length; ci++) {
                var clipItem = e.clipboardData.items[ci];
                if (clipItem.kind === 'file' && clipItem.type.startsWith('image/')) {
                    e.preventDefault();
                    var imgFile = clipItem.getAsFile();
                    if (imgFile) {
                        var reader = new FileReader();
                        var capturedNodeId = nodeId;
                        reader.onload = function(ev) {
                            host.saveOutlinerImage(capturedNodeId, ev.target.result, null);
                        };
                        reader.readAsDataURL(imgFile);
                    }
                    return;
                }
            }
        }

        var clipText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (!clipText) { return; }

        e.preventDefault();

        var node = model.getNode(nodeId);
        if (!node) { return; }

        // 内部クリップボードの照合 (Priority 1: 同一webview)
        var intClip = getValidInternalClipboard(clipText);
        var clipNodes = intClip ? intClip.nodes : null;
        var isCutPaste = intClip ? intClip.isCut : false;
        var clipSourceKey = intClip ? (intClip.sourceOutFileKey || null) : null;

        // Priority 2: HTMLクリップボードからcross-outlinerメタデータ抽出
        if (!intClip) {
            var htmlData = e.clipboardData ? e.clipboardData.getData('text/html') : '';
            var crossMeta = extractOutlinerClipboardMeta(htmlData);
            if (crossMeta && crossMeta.nodes) {
                clipNodes = crossMeta.nodes;
                isCutPaste = !!crossMeta.isCut; // cross-webview でも cut 情報を保持
                clipSourceKey = crossMeta.sourceOutFileKey || null;
            }
        }

        // カット時は1回消費
        if (intClip && intClip.isCut) {
            internalClipboard = null;
        }

        // 複数選択時: 選択ノードを置換
        if (selectedNodeIds.size > 0) {
            saveSnapshot();
            var flat = model.getFlattenedIds(true);
            var firstIdx = -1;
            for (var fi = 0; fi < flat.length; fi++) {
                if (selectedNodeIds.has(flat[fi])) { firstIdx = fi; break; }
            }
            var insertParentId = null;
            var insertAfter = firstIdx > 0 ? flat[firstIdx - 1] : null;
            var firstSelected = flat[firstIdx];
            var firstSelNode = model.getNode(firstSelected);
            if (firstSelNode) { insertParentId = firstSelNode.parentId; }
            for (var di = flat.length - 1; di >= 0; di--) {
                if (selectedNodeIds.has(flat[di])) { model.removeNode(flat[di]); }
            }
            clearSelection();
            pasteNodesFromText(clipText, insertParentId, insertAfter, clipNodes, isCutPaste, clipSourceKey);
            return;
        }

        // 内部クリップボードにページノードまたは画像が含まれるか判定
        var hasMetadataInClipboard = clipNodes && clipNodes.some(function(cn) {
            return cn.isPage || (cn.images && cn.images.length > 0) || cn.filePath;
        });

        // 単一行かつメタデータなし: 現在ノードのカーソル位置に挿入
        if (!clipText.includes('\n') && !hasMetadataInClipboard) {
            saveSnapshot();
            // URLペースト自動変換: テキスト中のURLを[URL](URL)形式に変換
            var insertText = convertUrlsToMarkdownLinks(clipText);
            var curOff = getCursorOffset(textEl);
            var curText = node.text || '';
            var newSingleText = curText.slice(0, curOff) + insertText + curText.slice(curOff);
            model.updateText(nodeId, newSingleText);
            textEl.innerHTML = renderEditingText(newSingleText);
            setCursorAtOffset(textEl, curOff + insertText.length);
            scheduleSyncToHost();
            return;
        }

        // 複数行: インデント構造を保持して一括挿入
        saveSnapshot();
        var currentText = (node.text || '').trim();

        if (currentText === '') {
            // 空ノード: 現在ノードを削除して、全行を pasteNodesFromText で挿入
            var parentId = node.parentId;
            // 同じ親の兄弟リストから直前のノードを探す
            var siblings = parentId ? (model.getNode(parentId).children || []) : model.rootIds;
            var sibIdx = siblings.indexOf(nodeId);
            var insertAfterForEmpty = sibIdx > 0 ? siblings[sibIdx - 1] : null;
            model.removeNode(nodeId);
            pasteNodesFromText(clipText, parentId, insertAfterForEmpty, clipNodes, isCutPaste, clipSourceKey);
        } else {
            // テキストありノード: 現在ノードの後に全行を挿入
            pasteNodesFromText(clipText, node.parentId, nodeId, clipNodes, isCutPaste, clipSourceKey);
        }
    }

    /** インデント付きテキストからノード階層を構築してモデルに追加 */
    function pasteNodesFromText(text, baseParentId, afterId, clipboardNodes, isCut, clipSourceKey) {
        var lines = text.split('\n');
        if (lines.length === 0) { return; }

        // 各行のインデントレベルを計算
        // 内部コピー形式はタブ区切り。外部ペースト(スペースのみ)にも対応。
        // タブの後のスペースはテキストの一部として扱う。
        var parsed = [];
        var clipNodeIndexMap = []; // parsed[n] → clipboardNodes[originalIndex] のマッピング
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var tabs = 0;
            var j = 0;
            var sawTab = false;
            while (j < line.length) {
                if (line[j] === '\t') { tabs++; j++; sawTab = true; }
                else if (line[j] === ' ' && !sawTab) {
                    // スペースのみの行（外部ペースト）: 2〜4スペースを1レベルとして扱う
                    var spaceCount = 0;
                    while (j < line.length && line[j] === ' ') { spaceCount++; j++; }
                    tabs += Math.max(1, Math.round(spaceCount / 2));
                }
                else { break; }
            }
            var content = line.substring(j);
            // 外部ペースト (MD editor 等) から来たリスト: 先頭の `- ` / `* ` / `+ ` / `1.` バレットを除去。
            // 内部コピー (clipboardNodes あり) はそのまま — ノードのテキストとして保持。
            if (!clipboardNodes) {
                content = content.replace(/^(?:[-*+]|\d+\.)[ \t]+/, '');
            }
            if (content === '') { continue; } // 空行スキップ
            parsed.push({ level: tabs, text: content });
            clipNodeIndexMap.push(i);
        }
        if (parsed.length === 0) { return; }

        // 最小レベルを0に正規化
        var minLevel = Infinity;
        for (var p = 0; p < parsed.length; p++) {
            if (parsed[p].level < minLevel) { minLevel = parsed[p].level; }
        }
        for (var q = 0; q < parsed.length; q++) {
            parsed[q].level -= minLevel;
        }

        // ツリー構造の正規化: 先頭行はlevel 0、各行は前行+1以下に制約
        // (先頭行がlevel 0でない場合、有効な親がなくツリーが壊れるため)
        if (parsed.length > 0 && parsed[0].level > 0) {
            var cap = 0;
            for (var r = 0; r < parsed.length; r++) {
                if (parsed[r].level > cap) {
                    parsed[r].level = cap;
                }
                cap = parsed[r].level + 1;
            }
        }

        // ノード作成 (レベルに応じて親子関係を設定)
        // levelToLastId[level] = そのレベルで最後に作成されたノードID
        var levelToLastId = {};
        var lastId = null;

        for (var n = 0; n < parsed.length; n++) {
            var level = parsed[n].level;
            var parentId = null;
            var after = null;

            if (level === 0) {
                // ベースレベル: 指定された親の子として追加
                parentId = baseParentId;
                after = (n === 0) ? afterId : levelToLastId[0] || afterId;
            } else {
                // 子レベル: 直近の (level-1) ノードの子として追加
                parentId = levelToLastId[level - 1] || baseParentId;
                after = null; // 親の子リスト末尾に追加
            }

            // URLテキストをMarkdownリンク形式に変換（内部クリップボード経由でない場合のみ）
            var nodeText = parsed[n].text;
            if (!clipboardNodes) {
                nodeText = convertUrlsToMarkdownLinks(nodeText);
            }

            var newNode = model.addNode(parentId, after, nodeText);

            // ページメタデータ・画像復元
            if (clipboardNodes && clipboardNodes[clipNodeIndexMap[n]]) {
                var clipNode = clipboardNodes[clipNodeIndexMap[n]];
                // 同一性判定は outFileKey (絶対パス) で確実に行う。
                // 相対パス文字列での同一性比較は偶然一致しうるため使わない (retro 教訓①)。
                var isCrossFile = !!clipSourceKey && clipSourceKey !== currentOutFileKey;
                var clipImages = clipNode.images || [];
                // 画像配列はまず placeholder として流用。host からの updateNodeImages postback で上書きされる。
                if (clipImages.length > 0) {
                    newNode.images = clipImages.slice();
                }
                if (clipNode.isPage && clipNode.pageId) {
                    if (isCut) {
                        // cut: 元の pageId をそのまま使う (移動扱い)
                        newNode.isPage = true;
                        newNode.pageId = clipNode.pageId;
                        if (isCrossFile) {
                            // cross-file: .md と画像を物理移動、新 path を postback で受け取る
                            host.handlePageAssetsCross(clipNode.pageId, null, text, newNode.id, clipImages, true);
                        }
                        // same-file cut: 何もしない (同じ pagesDir なので file 位置不変)
                    } else {
                        // copy: 新 pageId + .md と画像を新 filename で実体コピー (常に host 経由)
                        var newPageId = model.generatePageId();
                        newNode.isPage = true;
                        newNode.pageId = newPageId;
                        host.handlePageAssetsCross(clipNode.pageId, newPageId, text, newNode.id, clipImages, false);
                    }
                } else if (clipImages.length > 0) {
                    // 非 isPage + images のみのケース
                    if (isCut) {
                        if (isCrossFile) {
                            host.copyImagesCross(clipImages, text, newNode.id, true);
                        }
                        // same-file cut: no-op
                    } else {
                        // copy: 常に新 filename で実体コピー
                        host.copyImagesCross(clipImages, text, newNode.id, false);
                    }
                }
                // filePath 処理 (isPage と filePath は相互排他的なので独立分岐)
                if (clipNode.filePath) {
                    // page コピーと同じパターン: まず filePath を即座に設定
                    newNode.filePath = clipNode.filePath;
                    if (isCut) {
                        if (isCrossFile) {
                            // cross-file cut: ファイルを物理移動
                            host.handleFileAssetCross(clipNode.filePath, text, newNode.id, true);
                        }
                        // same-file cut: filePath はそのまま有効 (同じ fileDir)
                    } else {
                        // copy: ファイルを新 filename で実体コピー (常に host 経由)
                        // host からの updateNodeFilePath postback で新パスに上書きされる
                        host.handleFileAssetCross(clipNode.filePath, text, newNode.id, false);
                    }
                }
            }

            levelToLastId[level] = newNode.id;
            lastId = newNode.id;
            // 深いレベルをクリア (新しい親が変わったため)
            for (var cl = level + 1; cl <= 10; cl++) {
                delete levelToLastId[cl];
            }
        }

        renderTree();
        if (lastId) { focusNode(lastId); }
        scheduleSyncToHost();
    }

    function focusNode(nodeId) {
        var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"]');
        if (!nodeEl) { return; }
        var textEl = nodeEl.querySelector('.outliner-text');
        if (textEl) {
            setFocusedNode(nodeId);
            textEl.focus();
            setCursorToEnd(textEl);
        }
    }

    function focusNodeAtStart(nodeId) {
        var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"]');
        if (!nodeEl) { return; }
        var textEl = nodeEl.querySelector('.outliner-text');
        if (textEl) {
            setFocusedNode(nodeId);
            textEl.focus();
            setCursorToStart(textEl);
        }
    }

    /** 表示されている最初のノードにフォーカス（先頭にカーソル） */
    function focusFirstVisibleNode() {
        var firstNodeEl = treeEl.querySelector('.outliner-node');
        if (firstNodeEl) {
            focusNodeElAtStart(firstNodeEl);
        }
    }

    /** DOM上で前のノード要素を取得（現在のDOM要素から探索、重複ID・collapsed対応） */
    function getDomPrevNodeEl(currentTextEl) {
        var currentNodeEl = currentTextEl.closest('.outliner-node');
        if (!currentNodeEl) { return null; }
        var allNodes = treeEl.querySelectorAll('.outliner-node');
        for (var i = 0; i < allNodes.length; i++) {
            if (allNodes[i] === currentNodeEl) {
                for (var j = i - 1; j >= 0; j--) {
                    if (!allNodes[j].closest('.is-collapsed')) { return allNodes[j]; }
                }
                return null;
            }
        }
        return null;
    }

    /** DOM上で次のノード要素を取得（現在のDOM要素から探索、重複ID・collapsed対応） */
    function getDomNextNodeEl(currentTextEl) {
        var currentNodeEl = currentTextEl.closest('.outliner-node');
        if (!currentNodeEl) { return null; }
        var allNodes = treeEl.querySelectorAll('.outliner-node');
        for (var i = 0; i < allNodes.length; i++) {
            if (allNodes[i] === currentNodeEl) {
                for (var j = i + 1; j < allNodes.length; j++) {
                    if (!allNodes[j].closest('.is-collapsed')) { return allNodes[j]; }
                }
                return null;
            }
        }
        return null;
    }

    /** DOM要素を直接フォーカス（重複ID問題を回避） */
    function focusNodeEl(nodeEl) {
        if (!nodeEl) { return; }
        var textEl = nodeEl.querySelector('.outliner-text');
        if (textEl) {
            var nodeId = nodeEl.dataset.id;
            if (nodeId) { setFocusedNode(nodeId); }
            textEl.focus();
            setCursorToEnd(textEl);
        }
    }

    /** DOM要素を直接フォーカス（先頭にカーソル、重複ID問題を回避） */
    function focusNodeElAtStart(nodeEl) {
        if (!nodeEl) { return; }
        var textEl = nodeEl.querySelector('.outliner-text');
        if (textEl) {
            var nodeId = nodeEl.dataset.id;
            if (nodeId) { setFocusedNode(nodeId); }
            textEl.focus();
            setCursorToStart(textEl);
        }
    }

    // --- キーハンドラ ---

    function handleNodeKeydown(e, nodeId, textEl) {
        // IME composing中は全てのキー操作を無視
        if (e.isComposing || e.keyCode === 229) { return; }

        var node = model.getNode(nodeId);
        if (!node) { return; }

        // スコープヘッダーノードかどうか判定
        var isScopeHeader = (currentScope.type === 'subtree' && currentScope.rootId === nodeId);

        var offset = getCursorOffset(textEl);
        var textLen = (textEl.textContent || '').length;
        var isAtStart = (offset === 0);
        var isAtEnd = (offset >= textLen);

        // 選択状態でShift/Ctrl/Meta以外のキーが押されたら選択をクリア
        // (ただし Shift+Arrow, Cmd+C/X/V/A, Backspace/Delete は除く)
        if (selectedNodeIds.size > 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey
            && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'Tab') {
            clearSelection();
        }

        switch (e.key) {
            case 'Enter':
                // Cmd+Enter: ノード種別に応じてアクション
                //   isPage  → side panel で page MD を開く (既存挙動)
                //   filePath → 外部アプリで添付ファイルを開く (FR-OL-CMDENTER-1, sprint v14)
                //   それ以外 → 何もしない (preventDefault のみ)
                // 注: isPage と filePath は data-model.md §4.2 で「相互排他」が
                //     保証されており、else if で順次判定して安全 (排他性に依存)
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    var pageNode = model.getNode(nodeId);
                    if (!pageNode) return;
                    if (pageNode.isPage) {
                        openPage(nodeId);
                    } else if (pageNode.filePath) {
                        // FR-OL-CMDENTER-1: file 添付ノードを外部アプリで開く
                        host.openAttachedFile(nodeId);
                    }
                    // 添付なし: preventDefault のみ、新規動作なし (既存挙動維持)
                    return;
                }
                e.preventDefault();
                // @page チェック (Enter確定時)
                if (model.checkPageTrigger(nodeId)) {
                    makePage(nodeId);
                    renderTree();
                    focusNode(nodeId);
                    scheduleSyncToHost();
                    return;
                }
                saveSnapshot();
                if (e.altKey) {
                    // Option+Enter: 子ノードとして追加 (既に子がいれば先頭に)
                    handleShiftEnter(node, textEl, offset);
                } else if (e.shiftKey) {
                    // Shift+Enter: サブテキスト追加/フォーカス
                    openSubtext(nodeId);
                } else if (isScopeHeader) {
                    // スコープヘッダー: Enterで子ノード追加（兄弟追加はスコープ外になるため）
                    handleScopeHeaderEnter(node, textEl, offset);
                } else {
                    handleEnter(node, textEl, offset);
                }
                break;

            case ' ':
                // タグspan内でSpaceを押した場合、spanの外に脱出+スペース挿入
                var sel = window.getSelection();
                if (sel.rangeCount) {
                    var r = sel.getRangeAt(0);
                    var tagSpan = r.startContainer.parentElement;
                    if (!tagSpan) { tagSpan = r.startContainer; }
                    if (tagSpan.classList && tagSpan.classList.contains('outliner-tag')) {
                        e.preventDefault();
                        // spanの直後にNBSP+通常スペースを挿入
                        // (末尾空白が描画されない問題を回避するためNBSPを使用)
                        var spaceNode = document.createTextNode('\u00A0');
                        tagSpan.parentNode.insertBefore(spaceNode, tagSpan.nextSibling);
                        var newRange = document.createRange();
                        newRange.setStart(spaceNode, 1);
                        newRange.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(newRange);
                        // モデルはNBSPを通常スペースとして保存
                        var updatedText = getPlainText(textEl).replace(/\u00A0/g, ' ');
                        model.updateText(nodeId, updatedText);
                        scheduleSyncToHost();
                        return;
                    }
                }
                // Space 確定時に @page チェック
                // デフォルト動作は許可 (preventDefault しない)
                setTimeout(function() {
                    var currentText = getPlainText(textEl);
                    model.updateText(nodeId, currentText);
                    if (model.checkPageTrigger(nodeId)) {
                        makePage(nodeId);
                        renderTree();
                        focusNode(nodeId);
                        scheduleSyncToHost();
                    }
                }, 0);
                break;

            case 'Backspace': {
                var bsSel = window.getSelection();
                var hasSelection = bsSel && !bsSel.isCollapsed;
                // スコープヘッダー: 先頭でのBackspace（親合流・削除）を禁止（選択範囲がある場合はテキスト削除を許可）
                if (isScopeHeader && isAtStart && !hasSelection) {
                    e.preventDefault();
                    break;
                }
                // 選択範囲がある場合: ブラウザのデフォルト動作（選択テキスト削除）に任せる
                // input イベントハンドラで getPlainText → model.updateText が自動同期
                if (hasSelection) {
                    saveSnapshot();
                    break;
                }
                // 以下は既存ロジック（カーソルのみの場合）
                // 先頭に空白がある場合: contenteditableでは先頭空白をBackspaceで消せないため
                // カーソルが先頭空白内(offset ≤ 空白長)にいればtrim処理
                var nodeText = node.text || '';
                var leadingSpaceLen = nodeText.length - nodeText.replace(/^\s+/, '').length;
                if (leadingSpaceLen > 0 && offset <= leadingSpaceLen) {
                    e.preventDefault();
                    saveSnapshot();
                    var trimmed = nodeText.replace(/^\s+/, '');
                    model.updateText(nodeId, trimmed);
                    textEl.innerHTML = renderEditingText(trimmed);
                    setCursorAtOffset(textEl, 0);
                    scheduleSyncToHost();
                } else if (isAtStart) {
                    e.preventDefault();
                    saveSnapshot();
                    handleBackspaceAtStart(node, textEl);
                }
                break;
            }

            case 'Tab':
                // スコープヘッダー: インデント変更を禁止
                if (isScopeHeader) {
                    e.preventDefault();
                    break;
                }
                e.preventDefault();
                // 複数ノード選択時: 全選択ノードを一括インデント/デインデント
                if (selectedNodeIds.size > 0) {
                    var flat = model.getFlattenedIds(true);
                    var sortedIds = flat.filter(function(id) { return selectedNodeIds.has(id); });
                    if (sortedIds.length > 0) {
                        saveSnapshot();
                        var anyMoved = false;
                        if (e.shiftKey) {
                            // 選択ルート（親が選択外のノード）のみoutdent。子は親に追従
                            var selRootIds = [];
                            var selRootSet = new Set();
                            for (var si = 0; si < sortedIds.length; si++) {
                                var sn = model.getNode(sortedIds[si]);
                                if (!sn) { continue; }
                                if (currentScope.type === 'subtree' && currentScope.rootId && sn.parentId === currentScope.rootId) {
                                    continue;
                                }
                                if (!sn.parentId || !selectedNodeIds.has(sn.parentId)) {
                                    selRootIds.push(sortedIds[si]);
                                    selRootSet.add(sortedIds[si]);
                                }
                            }
                            // 一番上の選択ルートがoutdent不可ならスキップ
                            var topRoot = selRootIds.length > 0 ? model.getNode(selRootIds[0]) : null;
                            if (topRoot && topRoot.parentId) {
                                // 逆順で処理（挿入位置の正確性を保つため）
                                for (var ri = selRootIds.length - 1; ri >= 0; ri--) {
                                    if (model.outdentNode(selRootIds[ri], selRootSet)) { anyMoved = true; }
                                }
                            }
                        } else {
                            // Tab: 選択ルート（親が選択外のノード）のみindent。子は親に追従。
                            // Shift+Tab (outdent) 側と対称な挙動にして、兄弟が連続indentで
                            // 深くネストされていく問題を防ぐ。
                            var indentRootIds = [];
                            for (var si2 = 0; si2 < sortedIds.length; si2++) {
                                var sn2 = model.getNode(sortedIds[si2]);
                                if (!sn2) { continue; }
                                if (!sn2.parentId || !selectedNodeIds.has(sn2.parentId)) {
                                    indentRootIds.push(sortedIds[si2]);
                                }
                            }
                            // 一番上の選択ルートがindent不可（前に兄弟なし）ならスキップ
                            var topRootNode = indentRootIds.length > 0 ? model.getNode(indentRootIds[0]) : null;
                            var topRootInfo = topRootNode ? model._getSiblingInfo(indentRootIds[0]) : null;
                            if (topRootInfo && topRootInfo.index > 0) {
                                for (var ti = 0; ti < indentRootIds.length; ti++) {
                                    if (model.indentNode(indentRootIds[ti])) { anyMoved = true; }
                                }
                            }
                        }
                        if (anyMoved) {
                            renderTree();
                            // 選択状態をDOMに復元
                            sortedIds.forEach(function(id) {
                                var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + id + '"]');
                                if (nodeEl) { nodeEl.classList.add('is-selected'); }
                            });
                            // フォーカスを元のノードに戻す（連続Tab操作を可能にする）
                            var focusTargetEl = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"] .outliner-text');
                            if (focusTargetEl) {
                                focusTargetEl.focus();
                            }
                            scheduleSyncToHost();
                        }
                    }
                    break;
                }
                if (e.shiftKey) {
                    // スコープルートの直接の子: デインデントするとスコープ外になるため禁止
                    if (currentScope.type === 'subtree' && currentScope.rootId && node.parentId === currentScope.rootId) {
                        break;
                    }
                    saveSnapshot();
                    handleShiftTab(node, textEl);
                } else {
                    saveSnapshot();
                    handleTab(node, textEl);
                }
                break;

            case 'ArrowUp':
                if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
                    // スコープヘッダー: 移動を禁止
                    if (isScopeHeader) { e.preventDefault(); break; }
                    e.preventDefault();
                    saveSnapshot();
                    if (model.moveUp(nodeId)) {
                        renderTree();
                        focusNode(nodeId);
                        scheduleSyncToHost();
                    }
                } else if (e.shiftKey) {
                    // Shift+↑: 複数ノード選択を上に拡張
                    e.preventDefault();
                    if (!selectionAnchorId) {
                        // 初回: 自行のみ選択、フォーカス移動なし
                        selectionAnchorId = nodeId;
                        selectRange(selectionAnchorId, nodeId);
                    } else {
                        // 2回目以降: 従来通り拡張
                        var prevEl = getDomPrevNodeEl(textEl);
                        if (prevEl) {
                            var prevElId = prevEl.dataset.id;
                            if (prevElId) { selectRange(selectionAnchorId, prevElId); }
                            focusNodeEl(prevEl);
                        }
                    }
                } else {
                    e.preventDefault();
                    clearSelection();
                    var prevEl2 = getDomPrevNodeEl(textEl);
                    if (prevEl2) { focusNodeEl(prevEl2); }
                }
                break;

            case 'ArrowDown':
                if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
                    // スコープヘッダー: 移動を禁止
                    if (isScopeHeader) { e.preventDefault(); break; }
                    e.preventDefault();
                    saveSnapshot();
                    if (model.moveDown(nodeId)) {
                        renderTree();
                        focusNode(nodeId);
                        scheduleSyncToHost();
                    }
                } else if (e.shiftKey) {
                    // Shift+↓: 複数ノード選択を下に拡張
                    e.preventDefault();
                    if (!selectionAnchorId) {
                        // 初回: 自行のみ選択、フォーカス移動なし
                        selectionAnchorId = nodeId;
                        selectRange(selectionAnchorId, nodeId);
                    } else {
                        // 2回目以降: 従来通り拡張
                        var nextEl = getDomNextNodeEl(textEl);
                        if (nextEl) {
                            var nextElId = nextEl.dataset.id;
                            if (nextElId) { selectRange(selectionAnchorId, nextElId); }
                            focusNodeEl(nextEl);
                        }
                    }
                } else {
                    e.preventDefault();
                    clearSelection();
                    var nextEl2 = getDomNextNodeEl(textEl);
                    if (nextEl2) { focusNodeEl(nextEl2); }
                }
                break;

            case 'ArrowLeft':
                if (isAtStart && node.children && node.children.length > 0 && !node.collapsed) {
                    e.preventDefault();
                    toggleCollapse(nodeId);
                }
                break;

            case 'ArrowRight':
                if (isAtEnd && node.collapsed) {
                    e.preventDefault();
                    toggleCollapse(nodeId);
                }
                break;

            case 'Escape':
                e.preventDefault();
                if (currentSearchResult) {
                    clearSearch();
                }
                break;

            case 'z':
                if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
                    e.preventDefault();
                    undo();
                    return;
                }
                if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
                    e.preventDefault();
                    redo();
                    return;
                }
                break;

            case 'y':
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    redo();
                    return;
                }
                break;
        }

        // 複数選択時の Backspace/Delete で選択ノードを削除
        if ((e.key === 'Backspace' || e.key === 'Delete') && selectedNodeIds.size > 0) {
            e.preventDefault();
            deleteSelectedNodes();
            return;
        }

        // Cmd+] スコープイン / Cmd+Shift+] スコープアウト (e.code で判定 — JISキーボード等で e.key が異なるため)
        if ((e.metaKey || e.ctrlKey) && (e.key === ']' || e.code === 'BracketRight')) {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
                setScope({ type: 'document' });
            } else {
                if (focusedNodeId) { setScope({ type: 'subtree', rootId: focusedNodeId }); }
            }
            return;
        }

        // Cmd+Shift+F: ヘッダフィルタ検索にフォーカス（以前の Cmd+F の役割）
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            e.stopPropagation();
            if (searchInput) { searchInput.focus(); searchInput.select(); }
            return;
        }

        // Cmd+H: テキスト検索/置換ボックス（置換行展開）
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'h' || e.key === 'H')) {
            e.preventDefault();
            e.stopPropagation();
            openTextSearchBox(true);
            return;
        }

        // Cmd+Shift+C: ページパスをコピー
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
            e.preventDefault();
            e.stopPropagation();
            if (selectedNodeIds.size > 0) {
                var pageIds = [];
                var sortedIds = model.getFlattenedIds(true).filter(function(id) {
                    return selectedNodeIds.has(id);
                });
                sortedIds.forEach(function(id) {
                    var n = model.getNode(id);
                    if (n && n.isPage && n.pageId) {
                        pageIds.push(n.pageId);
                    }
                });
                if (pageIds.length > 0) {
                    host.copyPagePaths(pageIds);
                }
            } else {
                if (node.isPage && node.pageId) {
                    host.copyPagePaths([node.pageId]);
                }
            }
            return;
        }

        // その他ショートカット
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
            switch (e.key) {
                case 's':
                    e.preventDefault();
                    syncToHostImmediate();
                    host.save();
                    break;
                case 'f':
                    e.preventDefault();
                    e.stopPropagation();
                    openTextSearchBox(false);
                    break;
                case '.':
                    e.preventDefault();
                    toggleCollapse(nodeId);
                    break;
                case 'c':
                    if (selectedNodeIds.size > 0) {
                        // 複数選択時はノードテキスト+ページメタデータをコピー（text/html付き）
                        e.preventDefault();
                        var copyText = getSelectedText();
                        var copyNodesData = getSelectedNodesData();
                        writeClipboardWithHtml(copyText, copyNodesData, false);
                        internalClipboard = {
                            plainText: copyText,
                            isCut: false,
                            nodes: copyNodesData,
                            sourceOutFileKey: currentOutFileKey
                        };
                        host.saveOutlinerClipboard(copyText, false, copyNodesData);
                    } else {
                        // 単一ノード: テキスト選択があればブラウザデフォルト、
                        // なければノード全体のテキストをコピー
                        var selC = window.getSelection();
                        if (!selC || selC.isCollapsed) {
                            e.preventDefault();
                            var singleText = node.text || '';
                            var singleNodesData = [{
                                text: singleText, level: 0,
                                isPage: node.isPage || false,
                                pageId: node.pageId || null,
                                images: (node.images && node.images.length > 0) ? node.images.slice() : [],
                                filePath: node.filePath || null
                            }];
                            writeClipboardWithHtml(singleText, singleNodesData, false);
                            internalClipboard = {
                                plainText: singleText,
                                isCut: false,
                                nodes: singleNodesData,
                                sourceOutFileKey: currentOutFileKey
                            };
                            host.saveOutlinerClipboard(singleText, false, singleNodesData);
                        }
                    }
                    break;
                case 'x':
                    if (selectedNodeIds.size > 0) {
                        // 複数選択時はカット（ページメタデータ付き、text/html付き）
                        e.preventDefault();
                        var cutText = getSelectedText();
                        var cutNodesData = getSelectedNodesData();
                        writeClipboardWithHtml(cutText, cutNodesData, true);
                        internalClipboard = {
                            plainText: cutText,
                            isCut: true,
                            nodes: cutNodesData,
                            sourceOutFileKey: currentOutFileKey
                        };
                        host.saveOutlinerClipboard(cutText, true, cutNodesData);
                        deleteSelectedNodes();
                    } else {
                        // 単一ノード: テキスト選択があればブラウザデフォルト、
                        // なければノード全体をカット（空にする）
                        var selX = window.getSelection();
                        if (!selX || selX.isCollapsed) {
                            e.preventDefault();
                            var cutSingleText = node.text || '';
                            var cutSingleNodesData = [{
                                text: cutSingleText, level: 0,
                                isPage: node.isPage || false,
                                pageId: node.pageId || null,
                                images: (node.images && node.images.length > 0) ? node.images.slice() : [],
                                filePath: node.filePath || null
                            }];
                            writeClipboardWithHtml(cutSingleText, cutSingleNodesData, true);
                            internalClipboard = {
                                plainText: cutSingleText,
                                isCut: true,
                                nodes: cutSingleNodesData,
                                sourceOutFileKey: currentOutFileKey
                            };
                            host.saveOutlinerClipboard(cutSingleText, true, cutSingleNodesData);
                            saveSnapshot();
                            // カット: ページ属性とテキストを除去（ノード自体は残す）
                            if (node.isPage) {
                                node.isPage = false;
                                node.pageId = null;
                            }
                            if (node.images && node.images.length > 0) {
                                node.images = [];
                            }
                            model.updateText(nodeId, '');
                            textEl.innerHTML = '';
                            scheduleSyncToHost();
                        }
                    }
                    break;
                // case 'v': paste イベントで処理するため keydown では不要
                case 'a':
                    // Cmd+A: 全ノード選択
                    e.preventDefault();
                    var allIds = model.getFlattenedIds(true);
                    if (allIds.length > 0) {
                        selectionAnchorId = allIds[0];
                        selectRange(allIds[0], allIds[allIds.length - 1]);
                    }
                    break;
                case 'b':
                    // Cmd+B: 太字 (stopPropagationでVSCodeのサイドバー切替を防止)
                    e.preventDefault();
                    e.stopPropagation();
                    applyInlineFormat(nodeId, textEl, '**');
                    return;
                case 'i':
                    // Cmd+I: 斜体
                    e.preventDefault();
                    e.stopPropagation();
                    applyInlineFormat(nodeId, textEl, '*');
                    return;
                case 'e':
                    // Cmd+E: インラインコード
                    e.preventDefault();
                    e.stopPropagation();
                    applyInlineFormat(nodeId, textEl, '`');
                    return;
            }
        }

        // Cmd+Shift ショートカット
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
            if (e.key === 's' || e.key === 'S') {
                // Cmd+Shift+S: 取り消し線
                e.preventDefault();
                e.stopPropagation();
                applyInlineFormat(nodeId, textEl, '~~');
                return;
            }
        }
    }

    function handleEnter(node, textEl, offset) {
        var text = node.text;
        var beforeText = text.slice(0, offset);
        var afterText = text.slice(offset);

        // タスクパターン検出: "- [ ] " or "- [x] "
        if (text.match(/^[-*+] \[[ xX]\] /)) {
            var taskText = text.replace(/^[-*+] \[[ xX]\] /, '');
            var isChecked = /^[-*+] \[[xX]\] /.test(text);
            model.updateText(node.id, taskText);
            node.checked = isChecked;
            renderTree();
            focusNode(node.id);
            scheduleSyncToHost();
            return;
        }

        // Enter は常に兄弟として挿入する（子ノードが存在しても）。
        // カーソル先頭 (offset===0) かつ現ノードに text がある場合は、
        // 「空ノードを前に挿入し、現ノード(テキスト+子)はそのまま」の挙動にする。
        // これにより `|a` / `- b(child)` で Enter すると
        //   - ↵
        //   - a
        //     - b
        // となり、a が子ノードに追い出される旧バグを回避。
        var newNode;
        if (offset === 0 && text.length > 0) {
            // 現ノードは変更せず、前に空ノードを挿入
            var siblings = node.parentId
                ? (model.getNode(node.parentId) || {}).children || []
                : model.rootIds;
            var idxInSiblings = siblings.indexOf(node.id);
            if (idxInSiblings <= 0) {
                newNode = model.addNodeAtStart(node.parentId, '');
            } else {
                newNode = model.addNode(node.parentId, siblings[idxInSiblings - 1], '');
            }
        } else {
            // 通常: 現テキストを beforeText に更新し、afterText で兄弟を後ろに作成
            model.updateText(node.id, beforeText);
            newNode = model.addNode(node.parentId, node.id, afterText);
            // 現ノードが展開された子を持っていたら、その子を新兄弟へ移す。
            // これで新ノードは「視覚的にすぐ下の行」に挿入される。
            //   - a|           - a
            //     - b    →     - |
            //                    - b
            if (node.children && node.children.length > 0 && !node.collapsed) {
                var movingChildren = node.children.slice();
                for (var mc = 0; mc < movingChildren.length; mc++) {
                    var childNode = model.getNode(movingChildren[mc]);
                    if (childNode) { childNode.parentId = newNode.id; }
                }
                newNode.children = movingChildren;
                node.children = [];
            }
        }

        // タスクノードの継承
        if (node.checked !== null && node.checked !== undefined) {
            newNode.checked = false;
        }

        renderTree();
        focusNodeAtStart(newNode.id);
        scheduleSyncToHost();
    }

    /** スコープヘッダーでのEnter: 子ノードとして追加（兄弟追加はスコープ外になるため） */
    function handleScopeHeaderEnter(node, textEl, offset) {
        var text = node.text;
        var afterText = text.slice(offset);
        // ヘッダーテキストはカーソル位置までに更新
        model.updateText(node.id, text.slice(0, offset));
        // 子ノードの先頭に新ノード追加
        var newNode = model.addNodeAtStart(node.id, afterText);
        // タスクノード継承
        if (node.checked !== null && node.checked !== undefined) {
            newNode.checked = false;
        }
        renderTree();
        focusNodeAtStart(newNode.id);
        scheduleSyncToHost();
    }

    function handleShiftEnter(node, textEl, offset) {
        var text = node.text;
        var beforeText = text.slice(0, offset);
        var afterText = text.slice(offset);

        // 現在のテキストを前半に更新
        model.updateText(node.id, beforeText);

        // 子ノードとして先頭に追加
        var newNode = model.addNodeAtStart(node.id, afterText);

        // タスクノードの継承
        if (node.checked !== null && node.checked !== undefined) {
            newNode.checked = false;
        }

        // 折りたたまれている場合は展開
        if (node.collapsed) {
            node.collapsed = false;
        }

        renderTree();
        focusNodeAtStart(newNode.id);
        scheduleSyncToHost();
    }

    /** サブテキストを開いてフォーカス */
    function openSubtext(nodeId) {
        var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"]');
        if (!nodeEl) { return; }
        var subtextEl = nodeEl.querySelector('.outliner-subtext');
        if (!subtextEl) { return; }

        var node = model.getNode(nodeId);
        if (!node) { return; }

        // 編集モードに切替
        subtextEl.contentEditable = 'true';
        subtextEl.classList.add('is-editing');
        subtextEl.classList.add('has-content');
        subtextEl.textContent = node.subtext || '';
        subtextEl.focus();

        // カーソルを末尾に
        var range = document.createRange();
        var sel = window.getSelection();
        range.selectNodeContents(subtextEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /** サブテキストから抜ける */
    function closeSubtext(nodeId, subtextEl) {
        var node = model.getNode(nodeId);
        if (!node) { return; }

        // テキスト保存
        var raw = getSubtextPlainText(subtextEl);
        model.updateSubtext(nodeId, raw);

        // 編集モード解除 — ノードにフォーカスが残るので全文表示にする
        subtextEl.contentEditable = 'false';
        subtextEl.classList.remove('is-editing');
        if (raw) {
            subtextEl.classList.add('has-content');
            subtextEl.textContent = raw;  // 全文表示（フォーカスノードなので省略しない）
        } else {
            subtextEl.classList.remove('has-content');
            subtextEl.textContent = '';
        }
        scheduleSyncToHost();

        // メインテキストにフォーカス戻す
        focusNode(nodeId);
    }

    /** サブテキスト用キーハンドラ */
    function handleSubtextKeydown(e, nodeId, subtextEl, textEl) {
        if (e.isComposing || e.keyCode === 229) { return; }

        if (e.key === 'Enter' && e.shiftKey) {
            // Shift+Enter: サブテキストから抜ける
            e.preventDefault();
            closeSubtext(nodeId, subtextEl);
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            // Enter: サブテキスト内で改行 (デフォルト動作を許可)
            // ただし contenteditable の改行は insertLineBreak で処理
            return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            closeSubtext(nodeId, subtextEl);
            return;
        }

        // Cmd+S: 保存
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            var raw = getSubtextPlainText(subtextEl);
            model.updateSubtext(nodeId, raw);
            syncToHostImmediate();
            host.save();
        }
    }

    function handleBackspaceAtStart(node, textEl) {
        var prevId = model.getPreviousVisibleId(node.id);

        if (!prevId) {
            if ((node.text || '').length === 0 && model.rootIds.length > 1) {
                var nextId = model.getNextVisibleId(node.id);
                model.removeNode(node.id);
                if (currentScope.type === 'subtree' && !model.getNode(currentScope.rootId)) {
                    setScope({ type: 'document' });
                }
                renderTree();
                if (nextId) { focusNodeAtStart(nextId); }
                scheduleSyncToHost();
            }
            return;
        }

        var prevNode = model.getNode(prevId);
        if (!prevNode) { return; }

        if ((node.text || '').length === 0 && (!node.children || node.children.length === 0)) {
            // 空ノード+子なし: 単純削除
            model.removeNode(node.id);
            if (currentScope.type === 'subtree' && !model.getNode(currentScope.rootId)) {
                setScope({ type: 'document' });
            }
            renderTree();
            focusNode(prevId);
            scheduleSyncToHost();
        } else if ((node.text || '').length === 0 && node.children && node.children.length > 0) {
            // 空ノード+子あり: 子を親レベルに昇格（デインデント）して空ノード削除
            var emptyParentId = node.parentId;
            var parentSiblings = emptyParentId ? model.getNode(emptyParentId).children : model.rootIds;
            var emptyIndex = parentSiblings.indexOf(node.id);
            // 子ノードのIDをコピーし、nodeのchildrenをクリア（removeNodeの再帰削除を防ぐ）
            var promotedIds = node.children.slice();
            node.children = [];
            // 親のchildren/rootIdsから空ノードを除去してノード削除
            parentSiblings.splice(emptyIndex, 1);
            delete model.nodes[node.id];
            // 子ノードを元の位置に挿入（デインデント）
            for (var ci = 0; ci < promotedIds.length; ci++) {
                var promotedNode = model.nodes[promotedIds[ci]];
                if (promotedNode) {
                    promotedNode.parentId = emptyParentId;
                    parentSiblings.splice(emptyIndex + ci, 0, promotedIds[ci]);
                }
            }
            if (currentScope.type === 'subtree' && !model.getNode(currentScope.rootId)) {
                setScope({ type: 'document' });
            }
            renderTree();
            focusNode(prevId);
            scheduleSyncToHost();
        } else {
            var prevText = prevNode.text || '';
            var curText = node.text || '';
            var cursorPos = prevText.length;

            model.updateText(prevId, prevText + curText);

            // 子ノードを前のノードに移動
            if (node.children && node.children.length > 0) {
                for (var i = 0; i < node.children.length; i++) {
                    var childId = node.children[i];
                    model.nodes[childId].parentId = prevId;
                    prevNode.children.push(childId);
                }
            }

            model.removeNode(node.id);
            if (currentScope.type === 'subtree' && !model.getNode(currentScope.rootId)) {
                setScope({ type: 'document' });
            }
            renderTree();

            var prevNodeEl = treeEl.querySelector('.outliner-node[data-id="' + prevId + '"]');
            if (prevNodeEl) {
                var prevTextEl = prevNodeEl.querySelector('.outliner-text');
                if (prevTextEl) {
                    prevTextEl.focus();
                    setCursorAtOffset(prevTextEl, cursorPos);
                }
            }
            scheduleSyncToHost();
        }
    }

    function handleTab(node, textEl) {
        if (model.indentNode(node.id)) {
            var offset = getCursorOffset(textEl);
            renderTree();
            var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + node.id + '"]');
            if (nodeEl) {
                var newTextEl = nodeEl.querySelector('.outliner-text');
                if (newTextEl) {
                    newTextEl.focus();
                    setCursorAtOffset(newTextEl, offset);
                }
            }
            scheduleSyncToHost();
        }
    }

    function handleShiftTab(node, textEl) {
        if (model.outdentNode(node.id)) {
            var offset = getCursorOffset(textEl);
            renderTree();
            var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + node.id + '"]');
            if (nodeEl) {
                var newTextEl = nodeEl.querySelector('.outliner-text');
                if (newTextEl) {
                    newTextEl.focus();
                    setCursorAtOffset(newTextEl, offset);
                }
            }
            scheduleSyncToHost();
        }
    }

    // --- 折りたたみ ---

    function toggleCollapse(nodeId) {
        var node = model.getNode(nodeId);
        if (!node || !node.children || node.children.length === 0) { return; }

        node.collapsed = !node.collapsed;

        var childrenEl = treeEl.querySelector('.outliner-children[data-parent="' + nodeId + '"]');
        if (childrenEl) {
            if (node.collapsed) {
                childrenEl.classList.add('is-collapsed');
            } else {
                childrenEl.classList.remove('is-collapsed');
            }
        }

        var bulletEl = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"] .outliner-bullet');
        if (bulletEl) {
            if (node.collapsed) {
                bulletEl.dataset.collapsed = 'true';
                // 子の数を表示
                var existingCount = bulletEl.querySelector('.outliner-child-count');
                if (!existingCount && node.children.length > 0) {
                    var countEl = document.createElement('span');
                    countEl.className = 'outliner-child-count';
                    countEl.textContent = String(node.children.length);
                    bulletEl.appendChild(countEl);
                }
            } else {
                delete bulletEl.dataset.collapsed;
                // 子の数を非表示
                var countEl = bulletEl.querySelector('.outliner-child-count');
                if (countEl) { countEl.remove(); }
            }
        }

        scheduleSyncToHost();
    }

    // --- ページ機能 ---

    function makePage(nodeId) {
        saveSnapshot();
        var node = model.getNode(nodeId);
        if (!node) { return; }
        // Clear filePath when making page (mutual exclusion)
        node.filePath = null;
        var pageId = model.makePage(nodeId);
        if (!pageId) { return; }

        host.makePage(nodeId, pageId, node.text);
        renderTree();
        scheduleSyncToHost();
    }

    function removePage(nodeId) {
        saveSnapshot();
        var pageId = model.removePage(nodeId);
        if (pageId) {
            host.removePage(nodeId, pageId);
        }
        renderTree();
        scheduleSyncToHost();
    }

    /** ページノードクリック → ホストにサイドパネルで開くよう要求 */
    function openPage(nodeId) {
        var node = model.getNode(nodeId);
        if (!node || !node.isPage || !node.pageId) { return; }
        sidePanelOriginNodeId = nodeId;
        host.openPageInSidePanel(nodeId, node.pageId);
    }

    // --- ページタイトル ---

    function setupPageTitle() {
        var isComposing = false;
        pageTitleInput.addEventListener('compositionstart', function() {
            isComposing = true;
        });
        pageTitleInput.addEventListener('compositionend', function() {
            isComposing = false;
            model.title = pageTitleInput.value;
            scheduleSyncToHost();
        });
        pageTitleInput.addEventListener('input', function() {
            if (!isComposing) {
                model.title = pageTitleInput.value;
                scheduleSyncToHost();
            }
        });
        // Enterでツリーにフォーカス移動
        pageTitleInput.addEventListener('keydown', function(e) {
            if (e.isComposing || e.keyCode === 229) { return; }
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                focusFirstVisibleNode();
            }
        });
    }

    // --- 検索 ---

    var searchClearBtn = null;

    function updateSearchClearButton() {
        if (searchClearBtn) {
            searchClearBtn.style.display = (searchInput && searchInput.value.length > 0) ? '' : 'none';
        }
    }

    function setupSearchBar() {
        if (!searchInput) { return; }

        // クリアボタン
        searchClearBtn = document.querySelector('.outliner-search-clear-btn');
        if (searchClearBtn) {
            searchClearBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            searchClearBtn.addEventListener('click', function() {
                clearSearch();
                updatePinnedTagBar();
                updateSearchClearButton();
                if (focusedNodeId) { focusNode(focusedNodeId); }
            });
        }

        var debounceTimer = null;
        var isSearchComposing = false;

        searchInput.addEventListener('compositionstart', function() {
            isSearchComposing = true;
        });
        searchInput.addEventListener('compositionend', function() {
            isSearchComposing = false;
            clearTimeout(debounceTimer);
            executeSearch();
            updateSearchClearButton();
        });

        searchInput.addEventListener('input', function() {
            if (isSearchComposing) return;
            updatePinnedTagBar();
            updateSearchClearButton();
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function() {
                executeSearch();
            }, 200);
        });

        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                clearSearch();
                if (focusedNodeId) { focusNode(focusedNodeId); }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (currentSearchResult && currentSearchResult.size > 0) {
                    var firstMatch = currentSearchResult.values().next().value;
                    focusNode(firstMatch);
                }
            }
        });

        // 検索モード切替ボタン
        if (searchModeToggleBtn) {
            searchModeToggleBtn.addEventListener('click', function() {
                pushNavState();
                isNavigating = true;
                searchFocusMode = !searchFocusMode;
                updateSearchModeButton();
                if (searchInput.value.trim()) {
                    executeSearch();
                }
                isNavigating = false;
                updateNavButtons();
                scheduleSyncToHost();
            });
        }

        // メニューボタン
        if (menuBtn) {
            menuBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                toggleMenuDropdown();
            });
        }

        // Undo/Redo ボタン
        if (undoBtn) {
            undoBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            undoBtn.addEventListener('click', function() { undo(); });
        }
        if (redoBtn) {
            redoBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            redoBtn.addEventListener('click', function() { redo(); });
        }

        // Navigation Back/Forward ボタン
        if (navBackBtn) {
            navBackBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            navBackBtn.addEventListener('click', function() { navigateBack(); });
        }
        if (navForwardBtn) {
            navForwardBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            navForwardBtn.addEventListener('click', function() { navigateForward(); });
        }
    }

    function toggleMenuDropdown() {
        var existing = document.querySelector('.outliner-menu-dropdown');
        if (existing) {
            existing.remove();
            return;
        }
        var dropdown = document.createElement('div');
        dropdown.className = 'outliner-menu-dropdown';

        // Open in Text Editor
        var openTextEditorItem = document.createElement('button');
        openTextEditorItem.className = 'menu-item';
        openTextEditorItem.textContent = i18n.openInTextEditor || 'Open in Text Editor';
        openTextEditorItem.title = i18n.openInTextEditor || 'Open in Text Editor';
        openTextEditorItem.addEventListener('click', function() {
            dropdown.remove();
            host.openInTextEditor();
        });
        dropdown.appendChild(openTextEditorItem);

        // Copy File Path
        var copyPathItem = document.createElement('button');
        copyPathItem.className = 'menu-item';
        copyPathItem.textContent = i18n.copyPath || 'Copy File Path';
        copyPathItem.addEventListener('click', function() {
            dropdown.remove();
            host.copyFilePath();
        });
        dropdown.appendChild(copyPathItem);

        // Notes mode ではpageDirが自動管理のため Set page directory を非表示
        if (!document.querySelector('.notes-layout')) {
            var setPageDirItem = document.createElement('button');
            setPageDirItem.className = 'menu-item';
            setPageDirItem.textContent = i18n.outlinerSetPageDir || 'Set page directory...';
            setPageDirItem.addEventListener('click', function() {
                dropdown.remove();
                host.setPageDir();
            });
            dropdown.appendChild(setPageDirItem);

            // 画像フォルダ設定
            var setImageDirItem = document.createElement('button');
            setImageDirItem.className = 'menu-item';
            setImageDirItem.textContent = i18n.outlinerSetImageDir || 'Set image directory...';
            setImageDirItem.addEventListener('click', function() {
                dropdown.remove();
                host.setOutlinerImageDir();
            });
            dropdown.appendChild(setImageDirItem);

            // ファイルフォルダ設定
            var setFileDirItem = document.createElement('button');
            setFileDirItem.className = 'menu-item';
            setFileDirItem.textContent = i18n.outlinerSetFileDir || 'Set file directory...';
            setFileDirItem.addEventListener('click', function() {
                dropdown.remove();
                host.setFileDir();
            });
            dropdown.appendChild(setFileDirItem);
        }

        // .mdファイルインポート
        var importMdItem = document.createElement('button');
        importMdItem.className = 'menu-item';
        importMdItem.textContent = 'Import .md files...';
        importMdItem.addEventListener('click', function() {
            dropdown.remove();
            host.importMdFilesDialog(focusedNodeId);
        });
        dropdown.appendChild(importMdItem);

        // 任意ファイルインポート
        var importFileItem = document.createElement('button');
        importFileItem.className = 'menu-item';
        importFileItem.textContent = 'Import any files...';
        importFileItem.addEventListener('click', function() {
            dropdown.remove();
            host.importFilesDialog(focusedNodeId);
        });
        dropdown.appendChild(importFileItem);

        // 検索バーを基準に配置（メニューボタンの直下に表示）
        var searchBar = document.querySelector('.outliner-search-bar');
        searchBar.style.position = 'relative';
        searchBar.appendChild(dropdown);

        // メニューボタンの位置を基準にright値を計算
        var barRect = searchBar.getBoundingClientRect();
        var btnRect = menuBtn.getBoundingClientRect();
        var rightOffset = barRect.right - btnRect.right;
        dropdown.style.right = rightOffset + 'px';

        // 画面端はみ出し防止
        var dropRect = dropdown.getBoundingClientRect();
        if (dropRect.right > window.innerWidth) {
            dropdown.style.right = (barRect.right - window.innerWidth + 8) + 'px';
        }
        if (dropRect.left < 0) {
            dropdown.style.right = 'auto';
            dropdown.style.left = '0';
        }

        // 外側クリックで閉じる
        setTimeout(function() {
            document.addEventListener('click', function closeMenu() {
                dropdown.remove();
                document.removeEventListener('click', closeMenu);
            }, { once: true });
        }, 0);
    }

    // --- 固定タグ設定ダイアログ ---

    function openPinnedTagsDialog() {
        // オーバーレイ
        var overlay = document.createElement('div');
        overlay.className = 'pinned-tags-overlay';

        // ダイアログ
        var dialog = document.createElement('div');
        dialog.className = 'pinned-tags-dialog';

        // ヘッダー
        var header = document.createElement('div');
        header.className = 'pinned-tags-dialog-header';
        var title = document.createElement('span');
        title.textContent = i18n.outlinerPinnedTags || 'Pinned Tags';
        var closeBtn = document.createElement('button');
        closeBtn.className = 'pinned-tags-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', function() { overlay.remove(); });
        header.appendChild(title);
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        // タグリスト
        var listEl = document.createElement('div');
        listEl.className = 'pinned-tags-list';
        dialog.appendChild(listEl);

        var dragSrcIdx = null;

        function renderTagList() {
            listEl.innerHTML = '';
            for (var i = 0; i < pinnedTags.length; i++) {
                (function(idx) {
                    var row = document.createElement('div');
                    row.className = 'pinned-tag-row';
                    row.draggable = true;
                    row.dataset.idx = idx;

                    // ドラッグハンドル
                    var handle = document.createElement('span');
                    handle.className = 'pinned-tag-drag-handle';
                    handle.textContent = '\u2261'; // ≡ (hamburger)

                    var input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'pinned-tag-input';
                    input.value = pinnedTags[idx];
                    input.addEventListener('change', function() {
                        var val = input.value.trim();
                        if (!val) {
                            pinnedTags.splice(idx, 1);
                            renderTagList();
                        } else {
                            if (val.charAt(0) !== '#') { val = '#' + val; }
                            pinnedTags[idx] = val;
                        }
                        updatePinnedTagBar();
                        syncToHostImmediate();
                    });
                    var delBtn = document.createElement('button');
                    delBtn.className = 'pinned-tag-delete';
                    delBtn.textContent = '\u00d7';
                    delBtn.addEventListener('click', function() {
                        pinnedTags.splice(idx, 1);
                        renderTagList();
                        updatePinnedTagBar();
                        syncToHostImmediate();
                    });

                    // D&D イベント
                    row.addEventListener('dragstart', function(e) {
                        dragSrcIdx = idx;
                        row.classList.add('is-dragging');
                        e.dataTransfer.effectAllowed = 'move';
                    });
                    row.addEventListener('dragend', function() {
                        row.classList.remove('is-dragging');
                        dragSrcIdx = null;
                        // ドロップインジケーターを全クリア
                        var rows = listEl.querySelectorAll('.pinned-tag-row');
                        for (var r = 0; r < rows.length; r++) {
                            rows[r].classList.remove('drag-over-above', 'drag-over-below');
                        }
                    });
                    row.addEventListener('dragover', function(e) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        // ドロップ位置インジケーター
                        var rect = row.getBoundingClientRect();
                        var midY = rect.top + rect.height / 2;
                        var rows = listEl.querySelectorAll('.pinned-tag-row');
                        for (var r = 0; r < rows.length; r++) {
                            rows[r].classList.remove('drag-over-above', 'drag-over-below');
                        }
                        if (e.clientY < midY) {
                            row.classList.add('drag-over-above');
                        } else {
                            row.classList.add('drag-over-below');
                        }
                    });
                    row.addEventListener('dragleave', function() {
                        row.classList.remove('drag-over-above', 'drag-over-below');
                    });
                    row.addEventListener('drop', function(e) {
                        e.preventDefault();
                        row.classList.remove('drag-over-above', 'drag-over-below');
                        if (dragSrcIdx === null || dragSrcIdx === idx) return;
                        // 挿入位置を計算
                        var rect = row.getBoundingClientRect();
                        var midY = rect.top + rect.height / 2;
                        var targetIdx = e.clientY < midY ? idx : idx + 1;
                        // 配列を並べ替え
                        var tag = pinnedTags.splice(dragSrcIdx, 1)[0];
                        if (dragSrcIdx < targetIdx) { targetIdx--; }
                        pinnedTags.splice(targetIdx, 0, tag);
                        dragSrcIdx = null;
                        renderTagList();
                        updatePinnedTagBar();
                        syncToHostImmediate();
                    });

                    row.appendChild(handle);
                    row.appendChild(input);
                    row.appendChild(delBtn);
                    listEl.appendChild(row);
                })(i);
            }
        }
        renderTagList();

        // 追加行
        var addRow = document.createElement('div');
        addRow.className = 'pinned-tags-add-row';
        var addInput = document.createElement('input');
        addInput.type = 'text';
        addInput.className = 'pinned-tag-add-input';
        addInput.placeholder = '#tagname';
        var addBtn = document.createElement('button');
        addBtn.className = 'pinned-tag-add-btn';
        addBtn.textContent = 'Add';

        function addTag() {
            var val = addInput.value.trim();
            if (!val) { return; }
            if (val.charAt(0) !== '#') { val = '#' + val; }
            // 重複チェック
            for (var j = 0; j < pinnedTags.length; j++) {
                if (pinnedTags[j] === val) { addInput.value = ''; return; }
            }
            pinnedTags.push(val);
            addInput.value = '';
            renderTagList();
            updatePinnedTagBar();
            syncToHostImmediate();
        }

        addBtn.addEventListener('click', addTag);
        addInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); addTag(); }
        });
        addRow.appendChild(addInput);
        addRow.appendChild(addBtn);
        dialog.appendChild(addRow);

        // オーバーレイクリックで閉じる
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) { overlay.remove(); }
        });

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        addInput.focus();
    }

    function executeSearch() {
        pushNavState();
        var queryStr = searchInput.value.trim();
        if (!queryStr) {
            clearSearch();
            return;
        }
        var query = OutlinerSearch.parseQuery(queryStr);
        currentSearchResult = searchEngine.search(query, currentScope, { focusMode: searchFocusMode });
        expandCollapsedParentsForSearch();
        renderTree();
    }

    /** 検索結果にマッチした子孫を持つ折り畳み親を自動展開（展開しっぱなし） */
    function expandCollapsedParentsForSearch() {
        if (!currentSearchResult) return;
        currentSearchResult.forEach(function(nodeId) {
            var node = model.getNode(nodeId);
            if (!node) return;
            var current = node;
            while (current && current.parentId) {
                var parent = model.getNode(current.parentId);
                if (parent && parent.collapsed) {
                    parent.collapsed = false;
                }
                current = parent;
            }
        });
    }

    function clearSearch() {
        pushNavState();
        searchInput.value = '';
        currentSearchResult = null;
        renderTree();
        updateSearchClearButton();
    }

    function updateSearchModeButton() {
        if (!searchModeToggleBtn) { return; }
        searchModeToggleBtn.innerHTML = searchFocusMode ? ICON_FOCUS_MODE : ICON_TREE_MODE;
        searchModeToggleBtn.title = searchFocusMode
            ? (i18n.outlinerFocusMode || 'Focus mode: matched node + children only')
            : (i18n.outlinerTreeMode || 'Tree mode: show ancestors to root');
    }

    function updateUndoRedoButtons() {
        if (undoBtn) {
            undoBtn.disabled = (undoStack.length === 0);
        }
        if (redoBtn) {
            redoBtn.disabled = (redoStack.length === 0);
        }
    }

    // --- Navigation history ---
    function getCurrentNavState() {
        return {
            searchText: searchInput ? searchInput.value : '',
            searchFocusMode: searchFocusMode,
            scope: currentScope.type === 'subtree'
                ? { type: 'subtree', rootId: currentScope.rootId }
                : { type: 'document' }
        };
    }

    function pushNavState() {
        if (isNavigating) return;
        var entry = getCurrentNavState();
        if (navBackStack.length > 0) {
            var last = navBackStack[navBackStack.length - 1];
            if (last.searchText === entry.searchText &&
                last.searchFocusMode === entry.searchFocusMode &&
                last.scope.type === entry.scope.type &&
                last.scope.rootId === entry.scope.rootId) {
                return;
            }
        }
        navBackStack.push(entry);
        if (navBackStack.length > MAX_NAV_HISTORY) {
            navBackStack.shift();
        }
        navForwardStack.length = 0;
        updateNavButtons();
    }

    function navigateBack() {
        if (navBackStack.length === 0) return;
        navForwardStack.push(getCurrentNavState());
        var entry = navBackStack.pop();
        isNavigating = true;
        restoreNavState(entry);
        isNavigating = false;
        updateNavButtons();
    }

    function navigateForward() {
        if (navForwardStack.length === 0) return;
        navBackStack.push(getCurrentNavState());
        var entry = navForwardStack.pop();
        isNavigating = true;
        restoreNavState(entry);
        isNavigating = false;
        updateNavButtons();
    }

    function restoreNavState(entry) {
        // 1. スコープ復元
        if (entry.scope.type === 'subtree' && entry.scope.rootId) {
            if (model.getNode(entry.scope.rootId)) {
                currentScope = { type: 'subtree', rootId: entry.scope.rootId };
            } else {
                currentScope = { type: 'document' };
            }
        } else {
            currentScope = { type: 'document' };
        }
        updateBreadcrumb();
        // 2. 検索モード復元
        searchFocusMode = entry.searchFocusMode;
        updateSearchModeButton();
        // 3. 検索テキスト復元
        if (searchInput) {
            searchInput.value = entry.searchText;
        }
        // 4. 検索実行 or クリア
        if (entry.searchText.trim()) {
            var query = OutlinerSearch.parseQuery(entry.searchText);
            currentSearchResult = searchEngine.search(query, currentScope, { focusMode: searchFocusMode });
            expandCollapsedParentsForSearch();
        } else {
            currentSearchResult = null;
        }
        // 5. ツリー再描画
        renderTree();
        updatePinnedTagBar();
        updateSearchClearButton();
    }

    function updateNavButtons() {
        if (navBackBtn) { navBackBtn.disabled = (navBackStack.length === 0); }
        if (navForwardBtn) { navForwardBtn.disabled = (navForwardStack.length === 0); }
    }

    var defaultSearchPlaceholder = '';
    function updateScopeSearchIndicator() {
        if (!searchInput) { return; }
        if (currentScope.type === 'subtree') {
            searchInput.placeholder = i18n.outlinerSearchInScope || 'Search in scope';
        } else {
            searchInput.placeholder = defaultSearchPlaceholder;
        }
    }

    function setScope(scope) {
        pushNavState();
        var previousRootId = (currentScope.type === 'subtree') ? currentScope.rootId : null;
        currentScope = scope;
        updateBreadcrumb();
        updateScopeSearchIndicator();
        if (searchInput.value.trim()) { executeSearch(); }
        renderTree();
        // scope out時は直前のscopeノードにカーソルを移動
        if (previousRootId && previousRootId !== scope.rootId) {
            var targetEl = treeEl.querySelector('.outliner-node[data-id="' + previousRootId + '"]');
            if (targetEl) {
                focusNodeElAtStart(targetEl);
                targetEl.scrollIntoView({ block: 'nearest' });
                return;
            }
        }
        // scope-in時: スコープヘッダーの末尾にカーソル
        if (currentScope.type === 'subtree' && currentScope.rootId) {
            focusNode(currentScope.rootId);
        } else {
            focusFirstVisibleNode();
        }
    }

    function jumpToAndHighlightNode(nodeId) {
        var node = model.getNode(nodeId);
        if (!node) return;

        // scope をリセット
        if (currentScope.type === 'subtree') {
            currentScope = { type: 'document' };
            updateBreadcrumb();
        }

        // 親ノードを展開
        var parent = model.getParent(nodeId);
        while (parent) {
            if (parent.collapsed) {
                parent.collapsed = false;
            }
            parent = model.getParent(parent.id);
        }

        renderTree();

        var el = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"]');
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('outliner-search-jump-highlight');
            setTimeout(function() {
                el.classList.remove('outliner-search-jump-highlight');
            }, 2000);
            // focus without re-scrolling (preserve scrollIntoView center position,
            // important for image-heavy nodes where focus target ≠ visual center)
            var textEl = el.querySelector('.outliner-text');
            if (textEl) {
                setFocusedNode(nodeId);
                try { textEl.focus({ preventScroll: true }); }
                catch (e) { textEl.focus(); }
                setCursorToEnd(textEl);
            }
        } else {
            focusNode(nodeId);
        }
    }

    function updateBreadcrumb() {
        if (!breadcrumbEl) { return; }
        breadcrumbEl.innerHTML = '';
        if (currentScope.type === 'document') {
            breadcrumbEl.classList.remove('is-visible');
            return;
        }
        breadcrumbEl.classList.add('is-visible');

        // 祖先チェーンを構築 (rootから現在のスコープノードまで)
        var ancestors = [];
        var cur = model.getNode(currentScope.rootId);
        while (cur) {
            ancestors.unshift(cur);
            cur = cur.parentId ? model.getNode(cur.parentId) : null;
        }

        // TOP ボタン（先頭）
        var topBtn = document.createElement('span');
        topBtn.className = 'outliner-breadcrumb-top';
        topBtn.textContent = i18n.outlinerTop || 'TOP';
        topBtn.addEventListener('click', function() {
            setScope({ type: 'document' });
        });
        breadcrumbEl.appendChild(topBtn);

        // パンくずアイテムを生成
        for (var i = 0; i < ancestors.length; i++) {
            var sep = document.createElement('span');
            sep.className = 'outliner-breadcrumb-separator';
            sep.textContent = '›';
            breadcrumbEl.appendChild(sep);
            var item = document.createElement('span');
            item.className = 'outliner-breadcrumb-item';
            var nodeText = ancestors[i].text || '';
            // インラインマーカーを除去して表示
            item.textContent = nodeText.replace(/[*_~`]+/g, '').slice(0, 30) || '(empty)';
            item.title = nodeText;
            item.dataset.nodeId = ancestors[i].id;
            item.addEventListener('click', (function(nid) {
                return function() {
                    setScope({ type: 'subtree', rootId: nid });
                };
            })(ancestors[i].id));
            breadcrumbEl.appendChild(item);
        }
    }

    // --- コンテキストメニュー ---

    function setupContextMenu() {
        document.addEventListener('contextmenu', function(e) {
            // Skip if right-click is inside side panel editor (editor.js handles it)
            if (e.target.closest && e.target.closest('.side-panel-editor-root')) {
                return;
            }
            var nodeEl = e.target.closest('.outliner-node');
            if (!nodeEl) {
                hideContextMenu();
                return;
            }
            e.preventDefault();
            showContextMenu(nodeEl.dataset.id, e.clientX, e.clientY);
        });

        document.addEventListener('click', function(e) {
            if (contextMenuEl && !contextMenuEl.contains(e.target)) {
                hideContextMenu();
            }
        });
    }

    function showContextMenu(nodeId, x, y) {
        hideContextMenu();
        var node = model.getNode(nodeId);
        if (!node) { return; }

        contextMenuEl = document.createElement('div');
        contextMenuEl.className = 'outliner-context-menu';
        contextMenuEl.style.left = x + 'px';
        contextMenuEl.style.top = y + 'px';

        // --- 複数選択時のページパスコピー ---
        if (selectedNodeIds.size > 0) {
            var selectedPageIds = [];
            var sortedSelectedIds = model.getFlattenedIds(true).filter(function(id) {
                return selectedNodeIds.has(id);
            });
            sortedSelectedIds.forEach(function(id) {
                var n = model.getNode(id);
                if (n && n.isPage && n.pageId) {
                    selectedPageIds.push(n.pageId);
                }
            });
            if (selectedPageIds.length > 0) {
                addMenuItem(contextMenuEl, i18n.outlinerCopyPagePath || 'Copy Page Path', function() {
                    host.copyPagePaths(selectedPageIds);
                    hideContextMenu();
                }, modLabel + '+Shift+C');
                addMenuSeparator(contextMenuEl);
            }
        }

        // --- ページ操作 ---
        if (node.isPage) {
            addMenuItem(contextMenuEl, i18n.outlinerOpenPage || 'Open Page', function() {
                openPage(nodeId);
                hideContextMenu();
            }, modLabel + '+Enter');
            if (selectedNodeIds.size === 0) {
                addMenuItem(contextMenuEl, i18n.outlinerCopyPagePath || 'Copy Page Path', function() {
                    host.copyPagePaths([node.pageId]);
                    hideContextMenu();
                }, modLabel + '+Shift+C');
            }
            addMenuItem(contextMenuEl, i18n.outlinerDeletePage || 'Delete Page', function() {
                removePage(nodeId);
                hideContextMenu();
            });
        } else {
            addMenuItem(contextMenuEl, i18n.outlinerMakePage || 'Make Page', function() {
                makePage(nodeId);
                hideContextMenu();
            }, '@page');
        }

        // --- ファイル操作 ---
        if (node.filePath) {
            addMenuItem(contextMenuEl, i18n.outlinerOpenFile || 'Open File', function() {
                host.openAttachedFile(nodeId);
                hideContextMenu();
            });
            // FR-OL-COPYPATH-1: file 添付ノードの絶対 path を clipboard へコピー
            addMenuItem(contextMenuEl, i18n.outlinerCopyFilePath || 'Copy File Path', function() {
                host.copyAttachedFilePath(nodeId);
                hideContextMenu();
            });
            addMenuItem(contextMenuEl, i18n.outlinerRemoveFile || 'Remove File', function() {
                saveSnapshot();
                node.filePath = null;
                renderTree();
                scheduleSyncToHost();
                hideContextMenu();
            });
        }

        addMenuSeparator(contextMenuEl);

        // --- ノード追加 ---
        addMenuItem(contextMenuEl, i18n.outlinerAddSibling || 'Add Sibling Node', function() {
            hideContextMenu();
            var textEl = document.querySelector('.outliner-node[data-id="' + nodeId + '"] .outliner-text');
            if (textEl) {
                var len = textEl.textContent.length;
                handleEnter(node, textEl, len);
            }
        }, 'Enter');
        addMenuItem(contextMenuEl, i18n.outlinerAddChild || 'Add Child Node', function() {
            hideContextMenu();
            var textEl = document.querySelector('.outliner-node[data-id="' + nodeId + '"] .outliner-text');
            if (textEl) {
                var len = textEl.textContent.length;
                handleShiftEnter(node, textEl, len);
            }
        }, isMacPlatform ? 'Option+Enter' : 'Alt+Enter');

        addMenuSeparator(contextMenuEl);

        // --- インデント ---
        addMenuItem(contextMenuEl, i18n.outlinerIndent || 'Indent', function() {
            var textEl = document.querySelector('.outliner-node[data-id="' + nodeId + '"] .outliner-text');
            if (textEl) {
                handleTab(node, textEl);
            }
            hideContextMenu();
        }, 'Tab');
        addMenuItem(contextMenuEl, i18n.outlinerDedent || 'Dedent', function() {
            var textEl = document.querySelector('.outliner-node[data-id="' + nodeId + '"] .outliner-text');
            if (textEl) {
                handleShiftTab(node, textEl);
            }
            hideContextMenu();
        }, 'Shift+Tab');

        addMenuSeparator(contextMenuEl);

        // --- チェックボックス ---
        if (node.checked !== null && node.checked !== undefined) {
            addMenuItem(contextMenuEl, i18n.outlinerRemoveCheckbox || 'Remove Checkbox', function() {
                saveSnapshot();
                node.checked = null;
                renderTree();
                focusNode(nodeId);
                scheduleSyncToHost();
                hideContextMenu();
            });
        } else {
            addMenuItem(contextMenuEl, i18n.outlinerAddCheckbox || 'Add Checkbox', function() {
                saveSnapshot();
                node.checked = false;
                renderTree();
                focusNode(nodeId);
                scheduleSyncToHost();
                hideContextMenu();
            });
        }

        // --- サブテキスト ---
        var subtextLabel = (node.subtext) ? (i18n.outlinerEditSubtext || 'Edit Subtext') : (i18n.outlinerAddSubtext || 'Add Subtext');
        addMenuItem(contextMenuEl, subtextLabel, function() {
            hideContextMenu();
            openSubtext(nodeId);
        }, 'Shift+Enter');

        addMenuSeparator(contextMenuEl);

        // --- スコープ ---
        addMenuItem(contextMenuEl, i18n.outlinerScope || 'Scope', function() {
            setScope({ type: 'subtree', rootId: nodeId });
            hideContextMenu();
        }, modLabel + '+]');
        if (currentScope.type !== 'document') {
            addMenuItem(contextMenuEl, i18n.outlinerClearScope || 'Clear Scope', function() {
                setScope({ type: 'document' });
                hideContextMenu();
            }, modLabel + '+Shift+]');
        }

        addMenuSeparator(contextMenuEl);

        // --- 移動 ---
        addMenuItem(contextMenuEl, i18n.outlinerMoveUp || 'Move Up', function() {
            saveSnapshot();
            if (model.moveUp(nodeId)) {
                renderTree();
                focusNode(nodeId);
                scheduleSyncToHost();
            }
            hideContextMenu();
        }, modLabel + '+Shift+↑');
        addMenuItem(contextMenuEl, i18n.outlinerMoveDown || 'Move Down', function() {
            saveSnapshot();
            if (model.moveDown(nodeId)) {
                renderTree();
                focusNode(nodeId);
                scheduleSyncToHost();
            }
            hideContextMenu();
        }, modLabel + '+Shift+↓');

        addMenuSeparator(contextMenuEl);

        // --- 削除 (スコープヘッダーノードは削除不可) ---
        var isCtxScopeHeader = (currentScope.type === 'subtree' && currentScope.rootId === nodeId);
        if (!isCtxScopeHeader) {
            addMenuItem(contextMenuEl, i18n.outlinerDeleteNode || 'Delete Node', function() {
                saveSnapshot();
                var nextId = model.getNextVisibleId(nodeId) || model.getPreviousVisibleId(nodeId);
                model.removeNode(nodeId);
                if (currentScope.type === 'subtree' && !model.getNode(currentScope.rootId)) {
                    setScope({ type: 'document' });
                }
                renderTree();
                if (nextId && model.getNode(nextId)) { focusNode(nextId); }
                scheduleSyncToHost();
                hideContextMenu();
            }, 'Backspace');
        }

        // --- アプリ内リンクをコピー (Notes mode のみ) ---
        var notesLayoutEl = document.querySelector('.notes-layout');
        if (notesLayoutEl && selectedNodeIds.size <= 1) {
            addMenuSeparator(contextMenuEl);
            addMenuItem(contextMenuEl, i18n.copyInAppLink || 'Copy In-App Link', function() {
                var folderName = notesLayoutEl.dataset.noteFolderName;
                var outFileId = (typeof notesFilePanel !== 'undefined' && notesFilePanel.getCurrentOutFileId)
                    ? notesFilePanel.getCurrentOutFileId() : null;
                if (!folderName || !outFileId) { hideContextMenu(); return; }
                var node = model.getNode(nodeId);
                var text = stripInlineMarkers(node ? node.text : '') || 'Untitled';
                // Remove #tag and @tag from display text
                text = text.replace(/\s*[#@]\S+/g, '').trim() || 'Untitled';
                var link = 'fractal://note/' +
                    encodeURIComponent(folderName) + '/' +
                    encodeURIComponent(outFileId) + '/' +
                    encodeURIComponent(nodeId);
                var mdLink = '[' + text.replace(/[\[\]]/g, '') + '](' + link + ')';
                navigator.clipboard.writeText(mdLink);
                hideContextMenu();
            });
        }

        document.body.appendChild(contextMenuEl);

        var rect = contextMenuEl.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenuEl.style.left = (window.innerWidth - rect.width - 8) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            contextMenuEl.style.top = (window.innerHeight - rect.height - 8) + 'px';
        }
    }

    var isMacPlatform = navigator.platform.indexOf('Mac') !== -1;
    var modLabel = isMacPlatform ? 'Cmd' : 'Ctrl';

    function addMenuItem(parent, text, handler, shortcut) {
        var item = document.createElement('div');
        item.className = 'outliner-context-menu-item';
        var labelSpan = document.createElement('span');
        labelSpan.className = 'context-menu-label';
        labelSpan.textContent = text;
        item.appendChild(labelSpan);
        if (shortcut) {
            var kbdSpan = document.createElement('span');
            kbdSpan.className = 'context-menu-shortcut';
            kbdSpan.textContent = shortcut;
            item.appendChild(kbdSpan);
        }
        item.addEventListener('click', handler);
        parent.appendChild(item);
    }

    function addMenuSeparator(parent) {
        var sep = document.createElement('div');
        sep.className = 'outliner-context-menu-separator';
        parent.appendChild(sep);
    }

    function hideContextMenu() {
        if (contextMenuEl) {
            contextMenuEl.remove();
            contextMenuEl = null;
        }
    }

    // --- サイドパネル (editor.js の EditorInstance / SidePanelHostBridge を使用) ---

    var sidePanelEl = null;
    var sidePanelFilename = null;
    var sidePanelClose = null;
    var sidePanelOverlay = null;
    var sidePanelIframeContainer = null;
    var sidePanelSidebar = null;
    var sidePanelTocEl = null;
    var sidePanelOpenOutlineBtn = null;
    var sidePanelSidebarCloseBtn = null;
    var sidePanelImageDirEl = null;
    var sidePanelImageDirPath = null;
    var sidePanelImageDirSource = null;
    var sidePanelImageDirBtn = null;
    var sidePanelFileDirEl = null;
    var sidePanelFileDirPath = null;
    var sidePanelFileDirSource = null;
    var sidePanelFileDirBtn = null;
    var sidePanelInstance = null;
    var sidePanelHostBridge = null;
    var sidePanelFilePath = null;
    var sidePanelOriginNodeId = null;  // サイドパネルを開いたノードID（閉じた時にフォーカスを戻す）
    var sidePanelTocVisible = true;
    var sidePanelExpanded = false;
    var sidePanelImagePending = false;

    // v10: Translation state for side panel
    var sidePanelTranslateSourceLang = 'en';
    var sidePanelTranslateTargetLang = 'ja';
    var sidePanelPreTranslationState = null; // saved original MD state for "back" restore
    var translateLoadingOverlay = null;

    function showTranslateLoading() {
        if (!translateLoadingOverlay) {
            translateLoadingOverlay = document.createElement('div');
            translateLoadingOverlay.className = 'translate-loading-overlay';
            translateLoadingOverlay.innerHTML = '<div class="translate-loading-spinner"></div><div class="translate-loading-text">Translating...</div>';
            document.body.appendChild(translateLoadingOverlay);
        }
        translateLoadingOverlay.style.display = 'flex';
    }

    function hideTranslateLoading() {
        if (translateLoadingOverlay) {
            translateLoadingOverlay.style.display = 'none';
        }
    }

    function updateSidePanelTranslateLangBtn() {
        if (!sidePanelEl) return;
        var btn = sidePanelEl.querySelector('[data-action="translateLang"]');
        if (btn) {
            btn.textContent = sidePanelTranslateTargetLang;
            btn.title = 'Translate to ' + sidePanelTranslateTargetLang + ' (from ' + sidePanelTranslateSourceLang + ')';
        }
    }

    function initSidePanel() {
        sidePanelEl = document.querySelector('.side-panel');
        sidePanelFilename = document.querySelector('.side-panel-filename');
        sidePanelClose = document.querySelector('.side-panel-close');
        sidePanelOverlay = document.querySelector('.side-panel-overlay');
        sidePanelIframeContainer = document.querySelector('.side-panel-iframe-container');
        sidePanelSidebar = document.querySelector('.side-panel-sidebar');
        sidePanelTocEl = document.querySelector('.side-panel-toc');
        sidePanelOpenOutlineBtn = document.querySelector('.side-panel-outline-btn');
        sidePanelSidebarCloseBtn = document.querySelector('#sidePanelSidebarClose');
        sidePanelImageDirEl = document.querySelector('.side-panel-imagedir');
        sidePanelImageDirPath = document.querySelector('#sidePanelImageDirPath');
        sidePanelImageDirSource = document.querySelector('#sidePanelImageDirSource');
        sidePanelImageDirBtn = document.querySelector('#sidePanelImageDirBtn');
        sidePanelFileDirEl = document.querySelector('.side-panel-filedir');
        sidePanelFileDirPath = document.querySelector('#sidePanelFileDirPath');
        sidePanelFileDirSource = document.querySelector('#sidePanelFileDirSource');
        sidePanelFileDirBtn = document.querySelector('#sidePanelFileDirBtn');

        if (sidePanelClose) {
            sidePanelClose.addEventListener('click', closeSidePanel);
        }
        if (sidePanelOverlay) {
            sidePanelOverlay.addEventListener('click', closeSidePanel);
        }

        // Expand toggle — delegated on sidePanelEl so it survives
        // .side-panel-header-actions innerHTML rebuilds from the translate flow.
        if (sidePanelEl) {
            sidePanelEl.addEventListener('click', function(e) {
                var expandBtn = e.target && e.target.closest ? e.target.closest('.side-panel-expand') : null;
                if (!expandBtn || !sidePanelEl.contains(expandBtn)) return;
                sidePanelExpanded = !sidePanelExpanded;
                if (sidePanelExpanded) {
                    sidePanelEl.classList.add('expanded');
                    expandBtn.classList.add('active');
                    sidePanelEl.style.width = '';
                    sidePanelEl.style.maxWidth = '';
                } else {
                    sidePanelEl.classList.remove('expanded');
                    expandBtn.classList.remove('active');
                    if (sidePanelWidthSetting) {
                        sidePanelEl.style.width = sidePanelWidthSetting + 'px';
                        sidePanelEl.style.maxWidth = sidePanelWidthSetting + 'px';
                    } else {
                        sidePanelEl.style.width = '';
                        sidePanelEl.style.maxWidth = '';
                    }
                }
            });
        }

        // Side panel resize
        setupSidePanelResize();

        // Open in tab
        var sidePanelOpenTabBtn = document.querySelector('.side-panel-open-tab');
        if (sidePanelOpenTabBtn) {
            sidePanelOpenTabBtn.addEventListener('click', function() {
                if (sidePanelFilePath) {
                    host.openLinkInTab(sidePanelFilePath);
                    closeSidePanelImmediate();
                }
            });
        }

        // Copy path
        var sidePanelCopyPathBtn = document.querySelector('.side-panel-copy-path');
        if (sidePanelCopyPathBtn) {
            sidePanelCopyPathBtn.addEventListener('click', function() {
                if (!sidePanelFilePath) return;
                navigator.clipboard.writeText(sidePanelFilePath).then(function() {
                    var originalHTML = sidePanelCopyPathBtn.innerHTML;
                    sidePanelCopyPathBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
                    setTimeout(function() {
                        sidePanelCopyPathBtn.innerHTML = originalHTML;
                    }, 2000);
                }).catch(function(err) {
                    console.error('Failed to copy path:', err);
                });
            });
        }

        // Copy In-App Link button (Notes mode only)
        var sidePanelCopyInAppLinkBtn = document.querySelector('.side-panel-copy-inapp-link');
        if (sidePanelCopyInAppLinkBtn) {
            // Show only in Notes mode
            var notesLayoutForBtn = document.querySelector('.notes-layout');
            if (notesLayoutForBtn) {
                sidePanelCopyInAppLinkBtn.style.display = '';
                sidePanelCopyInAppLinkBtn.addEventListener('click', function() {
                    if (!sidePanelOriginNodeId) return;
                    var folderName = notesLayoutForBtn.dataset.noteFolderName;
                    var outFileId = (typeof notesFilePanel !== 'undefined' && notesFilePanel.getCurrentOutFileId)
                        ? notesFilePanel.getCurrentOutFileId() : null;
                    if (!folderName || !outFileId) return;
                    var originNode = model.getNode(sidePanelOriginNodeId);
                    var pageId = originNode ? originNode.pageId : null;
                    if (!pageId) return;
                    // Display text: prefer H1 from sidepanel md, fallback to node text
                    var linkDisplayText = '';
                    if (sidePanelInstance && sidePanelInstance.container) {
                        var spH1 = sidePanelInstance.container.querySelector('.editor h1');
                        if (spH1) { linkDisplayText = (spH1.textContent || '').trim(); }
                    }
                    if (!linkDisplayText) {
                        linkDisplayText = stripInlineMarkers(originNode.text || '') || 'Untitled';
                    }
                    // Page link: fractal://note/{folder}/{outFileId}/page/{pageId}
                    var link = 'fractal://note/' +
                        encodeURIComponent(folderName) + '/' +
                        encodeURIComponent(outFileId) + '/page/' +
                        encodeURIComponent(pageId);
                    var mdLink = '[' + linkDisplayText.replace(/[\[\]]/g, '') + '](' + link + ')';
                    navigator.clipboard.writeText(mdLink).then(function() {
                        var originalHTML = sidePanelCopyInAppLinkBtn.innerHTML;
                        sidePanelCopyInAppLinkBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
                        setTimeout(function() {
                            sidePanelCopyInAppLinkBtn.innerHTML = originalHTML;
                        }, 2000);
                    });
                });
            }
        }

        // Outline sidebar open/close
        if (sidePanelOpenOutlineBtn) {
            sidePanelOpenOutlineBtn.addEventListener('click', function() {
                if (!sidePanelTocEl || sidePanelTocEl.children.length === 0) { return; }
                sidePanelTocVisible = true;
                openSidePanelSidebar();
            });
        }
        if (sidePanelSidebarCloseBtn) {
            sidePanelSidebarCloseBtn.addEventListener('click', function() {
                sidePanelTocVisible = false;
                closeSidePanelSidebar();
            });
        }

        // ESC to close side panel (but not if action panel, command palette, or image lightbox is open)
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && sidePanelEl && sidePanelEl.classList.contains('open')) {
                // Don't close side panel if a modal panel (action panel, command palette) is handling ESC
                var ap = document.querySelector('.action-panel');
                var cp = document.querySelector('.command-palette');
                if ((ap && ap.style.display !== 'none') || (cp && cp.style.display !== 'none')) return;
                // v11: Don't close side panel if image lightbox is open — lightbox handles ESC separately
                if (document.querySelector('.outliner-image-overlay')) return;
                e.preventDefault();
                e.stopPropagation();
                closeSidePanel();
            }
        });
    }

    function setupSidePanelResize() {
        var spResizeHandle = document.getElementById('sidePanelResizeHandle');
        if (!spResizeHandle || !sidePanelEl) return;

        var spResizing = false;
        var spStartX = 0;
        var spStartWidth = 0;

        spResizeHandle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            spResizing = true;
            spStartX = e.clientX;
            spStartWidth = sidePanelEl.offsetWidth;
            spResizeHandle.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            sidePanelEl.classList.remove('expanded');
            sidePanelExpanded = false;
            var iframes = sidePanelEl.querySelectorAll('iframe');
            iframes.forEach(function(f) { f.style.pointerEvents = 'none'; });

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        });

        function onMove(e) {
            if (!spResizing) return;
            var delta = spStartX - e.clientX;
            var newWidth = spStartWidth + delta;
            var maxW = (sidePanelEl.parentElement || document.body).offsetWidth * 0.95;
            newWidth = Math.max(320, Math.min(newWidth, maxW));
            sidePanelEl.style.width = newWidth + 'px';
            sidePanelEl.style.maxWidth = newWidth + 'px';
        }

        function onEnd() {
            if (!spResizing) return;
            spResizing = false;
            spResizeHandle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            var iframes = sidePanelEl.querySelectorAll('iframe');
            iframes.forEach(function(f) { f.style.pointerEvents = ''; });
            sidePanelWidthSetting = sidePanelEl.offsetWidth;
            syncToHostImmediate();
        }
    }

    // v10: Show translation result by reopening side panel with translated markdown (readonly)
    function showTranslationInSidePanel(translatedMarkdown, sourceLang, targetLang) {
        // AWS Translate mangles MD syntax — normalize before rendering
        if (window.__editorUtils && window.__editorUtils.normalizeTranslatedMarkdown) {
            translatedMarkdown = window.__editorUtils.normalizeTranslatedMarkdown(translatedMarkdown);
        }
        console.log('[Translate] Result received. Length:', (translatedMarkdown || '').length, 'Preview:', (translatedMarkdown || '').substring(0, 200));
        // Capture the current (pre-translation) header actions HTML BEFORE closing the panel,
        // because closeSidePanelImmediate clears sidePanelPreTranslationState.
        var preservedState = sidePanelPreTranslationState;
        if (preservedState && sidePanelEl) {
            var preHeader = sidePanelEl.querySelector('.side-panel-header');
            if (preHeader) {
                var preActions = preHeader.querySelector('.side-panel-header-actions');
                if (preActions && !preservedState.actionsHtml) {
                    preservedState.actionsHtml = preActions.innerHTML;
                }
            }
        }
        // Close current side panel MD (this nulls sidePanelPreTranslationState)
        if (sidePanelInstance) {
            closeSidePanelImmediate();
        }
        // Restore preserved state so later close handlers can rebuild default header actions
        sidePanelPreTranslationState = preservedState;

        // Reopen as translation result panel
        var spContainer = window.EditorInstance.createSidePanelContainer();
        if (sidePanelIframeContainer) {
            sidePanelIframeContainer.innerHTML = '';
            sidePanelIframeContainer.appendChild(spContainer);
        }

        // Minimal bridge (no host operations for readonly result)
        sidePanelHostBridge = {
            _sendMessage: function() {},
            onMessage: function() {},
            sidePanelOpenInTextEditor: function() {},
            requestInsertImage: function() {},
            requestInsertFile: function() {},
            requestInsertLink: function() {},
            syncContent: function() {},
            reportEditingState: function() {},
            reportFocus: function() {},
            reportBlur: function() {}
        };

        sidePanelInstance = new window.EditorInstance(spContainer, sidePanelHostBridge, {
            initialContent: translatedMarkdown,
            documentBaseUri: '',
            isSidePanel: true,
            readonly: true
        });

        // Update filename label
        if (sidePanelFilename) {
            sidePanelFilename.textContent = 'Translation (' + sourceLang + ' → ' + targetLang + ')';
        }

        // Inject "← Back" button into header, replacing action buttons (read-only panel).
        // Save original actions HTML so openSidePanel on restore can rebuild default buttons.
        if (sidePanelEl) {
            var header = sidePanelEl.querySelector('.side-panel-header');
            if (header) {
                var actions = header.querySelector('.side-panel-header-actions');
                if (actions) {
                    if (sidePanelPreTranslationState && !sidePanelPreTranslationState.actionsHtml) {
                        sidePanelPreTranslationState.actionsHtml = actions.innerHTML;
                    }
                    actions.innerHTML = '<button class="side-panel-header-btn" data-action="translateBack" title="Back to original">← Back</button>';
                    var backBtn = actions.querySelector('[data-action="translateBack"]');
                    if (backBtn) {
                        backBtn.addEventListener('click', function() {
                            var s = sidePanelPreTranslationState;
                            if (s && s.filePath) {
                                // Restore original header actions HTML before reopening
                                if (s.actionsHtml) { actions.innerHTML = s.actionsHtml; }
                                sidePanelPreTranslationState = null;
                                openSidePanel(s.markdown, s.filePath, s.fileName, s.toc, s.documentBaseUri);
                            } else {
                                closeSidePanel();
                            }
                        });
                    }
                }
            }
        }

        // Show side panel
        if (sidePanelEl) {
            sidePanelEl.style.display = 'flex';
            requestAnimationFrame(function() { sidePanelEl.classList.add('open'); });
        }
        if (sidePanelOverlay) {
            sidePanelOverlay.style.display = 'block';
            requestAnimationFrame(function() { sidePanelOverlay.classList.add('open'); });
        }
    }

    function openSidePanel(markdown, filePath, fileName, toc, spDocumentBaseUri) {
        if (sidePanelInstance) {
            closeSidePanelImmediate();
        }
        sidePanelFilePath = filePath;
        if (sidePanelFilename) { sidePanelFilename.textContent = fileName; }

        // Create EditorInstance container and instance
        var spContainer = window.EditorInstance.createSidePanelContainer();
        if (sidePanelIframeContainer) {
            sidePanelIframeContainer.innerHTML = '';
            sidePanelIframeContainer.appendChild(spContainer);
        }

        var LUCIDE_ICONS = window.__editorUtils ? window.__editorUtils.LUCIDE_ICONS : {};
        var escapeHtml = window.__editorUtils ? window.__editorUtils.escapeHtml : function(s) { return s; };

        sidePanelHostBridge = new window.SidePanelHostBridge(host, filePath, {
            onTocUpdate: updateSidePanelTocFromMarkdown,
            onImageRequest: function() { sidePanelImagePending = true; }
        });

        sidePanelInstance = new window.EditorInstance(spContainer, sidePanelHostBridge, {
            initialContent: markdown,
            documentBaseUri: spDocumentBaseUri || '',
            isSidePanel: true
        });

        // Setup header buttons (undo/redo/source)
        if (sidePanelEl) {
            var header = sidePanelEl.querySelector('.side-panel-header');
            if (header) {
                header.querySelectorAll('button[data-action]').forEach(function(btn) {
                    // translateLang shows text label (ja → en), not an icon
                    if (btn.dataset.action === 'translateLang') return;
                    var icon = LUCIDE_ICONS[btn.dataset.action];
                    if (icon) { btn.innerHTML = icon; }
                });
                var undoBtn = header.querySelector('[data-action="undo"]');
                var redoBtn = header.querySelector('[data-action="redo"]');
                var openTextEditorBtn = header.querySelector('[data-action="openInTextEditor"]');
                var sourceBtn = header.querySelector('[data-action="source"]');
                var translateLangBtn = header.querySelector('[data-action="translateLang"]');
                var translateBtn = header.querySelector('[data-action="translate"]');

                if (undoBtn) { undoBtn.addEventListener('click', function() { if (sidePanelInstance) sidePanelInstance._undo(); }); }
                if (redoBtn) { redoBtn.addEventListener('click', function() { if (sidePanelInstance) sidePanelInstance._redo(); }); }
                if (openTextEditorBtn) { openTextEditorBtn.addEventListener('click', function() { if (sidePanelFilePath) host.sidePanelOpenInTextEditor(sidePanelFilePath); }); }
                if (sourceBtn) { sourceBtn.addEventListener('click', function() { if (sidePanelInstance) sidePanelInstance._toggleSourceMode(); }); }
                if (translateLangBtn) {
                    translateLangBtn.textContent = sidePanelTranslateTargetLang;
                    translateLangBtn.title = 'Translate to ' + sidePanelTranslateTargetLang + ' (from ' + sidePanelTranslateSourceLang + ')';
                    translateLangBtn.addEventListener('click', function() {
                        host.translateSelectLang(sidePanelTranslateSourceLang, sidePanelTranslateTargetLang, sidePanelFilePath);
                    });
                }
                if (translateBtn) {
                    translateBtn.addEventListener('click', function() {
                        if (!sidePanelInstance) return;
                        var selectionText = sidePanelInstance._getSelectionText ? sidePanelInstance._getSelectionText() : '';
                        var text = selectionText || (sidePanelInstance._getMarkdown ? sidePanelInstance._getMarkdown() : '');
                        console.log('[Translate] Button clicked. Text length:', text.length, 'langs:', sidePanelTranslateSourceLang, '→', sidePanelTranslateTargetLang);
                        if (text) {
                            // Save original state so user can restore via "back" button on result panel
                            sidePanelPreTranslationState = {
                                markdown: sidePanelInstance._getMarkdown ? sidePanelInstance._getMarkdown() : '',
                                filePath: sidePanelFilePath,
                                fileName: sidePanelFilename ? sidePanelFilename.textContent : '',
                                toc: null,
                                documentBaseUri: sidePanelInstance.options ? sidePanelInstance.options.documentBaseUri : ''
                            };
                            showTranslateLoading();
                            host.translateContent(text, sidePanelTranslateSourceLang, sidePanelTranslateTargetLang, sidePanelFilePath);
                        } else {
                            console.warn('[Translate] No text to translate');
                        }
                    });
                }

                sidePanelInstance._setUndoUpdateCallback(function(undoDisabled, redoDisabled) {
                    if (undoBtn) { undoBtn.disabled = undoDisabled; undoBtn.style.opacity = undoDisabled ? '0.3' : '1'; }
                    if (redoBtn) { redoBtn.disabled = redoDisabled; redoBtn.style.opacity = redoDisabled ? '0.3' : '1'; }
                });
                if (undoBtn) { undoBtn.disabled = true; undoBtn.style.opacity = '0.3'; }
                if (redoBtn) { redoBtn.disabled = true; redoBtn.style.opacity = '0.3'; }
            }
        }

        // Render TOC
        renderSidePanelToc(toc);

        // Setup image dir display
        setupSidePanelImageDir();

        // Apply saved width
        if (sidePanelWidthSetting && sidePanelEl) {
            sidePanelEl.style.width = sidePanelWidthSetting + 'px';
            sidePanelEl.style.maxWidth = sidePanelWidthSetting + 'px';
        }

        // Show panel with animation
        if (sidePanelEl) { sidePanelEl.style.display = 'flex'; }
        if (sidePanelOverlay) { sidePanelOverlay.style.display = 'block'; }
        requestAnimationFrame(function() {
            if (sidePanelEl) { sidePanelEl.classList.add('open'); }
            if (sidePanelOverlay) { sidePanelOverlay.classList.add('open'); }
        });

        // アニメーション完了後にエディタに自動フォーカス
        setTimeout(function() {
            requestAnimationFrame(function() {
                if (sidePanelInstance && sidePanelInstance.container) {
                    var spEditor = sidePanelInstance.container.querySelector('.editor');
                    if (spEditor) {
                        spEditor.focus();
                        // カーソルを先頭に設定
                        try {
                            var firstBlock = spEditor.querySelector(':scope > *');
                            if (firstBlock) {
                                var range = document.createRange();
                                var sel = window.getSelection();
                                range.setStart(firstBlock, 0);
                                range.collapse(true);
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                        } catch (e) { /* ignore */ }
                    }
                }
            });
        }, 400);
    }

    function closeSidePanel() {
        restoreHeaderActionsFromTranslation();
        sidePanelPreTranslationState = null;
        if (sidePanelEl) { sidePanelEl.classList.remove('open'); }
        if (sidePanelOverlay) { sidePanelOverlay.classList.remove('open'); }
        setTimeout(function() { closeSidePanelImmediate(); }, 200);
    }

    // v10: If a translation panel is currently shown, restore the default header action
    // buttons (undo/redo/translateLang/...) before the panel is destroyed. Otherwise the
    // next openSidePanel() would reuse the same DOM with only the "← Back" button left.
    function restoreHeaderActionsFromTranslation() {
        if (!sidePanelPreTranslationState || !sidePanelPreTranslationState.actionsHtml) return;
        if (!sidePanelEl) return;
        var header = sidePanelEl.querySelector('.side-panel-header');
        if (!header) return;
        var actions = header.querySelector('.side-panel-header-actions');
        if (actions) {
            actions.innerHTML = sidePanelPreTranslationState.actionsHtml;
        }
    }

    function closeSidePanelImmediate() {
        restoreHeaderActionsFromTranslation();
        sidePanelPreTranslationState = null;
        if (sidePanelEl) { sidePanelEl.style.display = 'none'; }
        if (sidePanelOverlay) { sidePanelOverlay.style.display = 'none'; }
        if (sidePanelExpanded) {
            if (sidePanelEl) { sidePanelEl.classList.remove('expanded'); }
            sidePanelExpanded = false;
            var expandBtn = document.querySelector('.side-panel-expand');
            if (expandBtn) { expandBtn.classList.remove('active'); }
        }
        if (sidePanelInstance) {
            sidePanelInstance.destroy();
            sidePanelInstance = null;
        }
        sidePanelHostBridge = null;
        if (sidePanelIframeContainer) { sidePanelIframeContainer.innerHTML = ''; }
        sidePanelFilePath = null;
        host.notifySidePanelClosed();
        if (sidePanelOriginNodeId) {
            focusNode(sidePanelOriginNodeId);
            sidePanelOriginNodeId = null;
        }
        // else: サイドパネルを開いた経緯が不明な場合（検索ジャンプ等）は
        // 現在のフォーカスを保持する。先頭ノードへ戻すと検索結果からの
        // ジャンプ位置が失われるため。
    }

    function renderSidePanelToc(toc) {
        if (!sidePanelTocEl) { return; }
        var escapeHtml = window.__editorUtils ? window.__editorUtils.escapeHtml : function(s) { return s; };
        if (toc && toc.length > 0) {
            sidePanelTocEl.innerHTML = toc.map(function(item) {
                return '<a class="side-panel-toc-item" data-level="' + item.level +
                    '" data-anchor="' + escapeHtml(item.anchor) + '" title="' + escapeHtml(item.text) + '">' +
                    escapeHtml(item.text) + '</a>';
            }).join('');
            bindSidePanelTocClicks();
            if (sidePanelTocVisible) { openSidePanelSidebar(); }
        } else {
            sidePanelTocEl.innerHTML = '';
            closeSidePanelSidebar();
        }
    }

    function bindSidePanelTocClicks() {
        if (!sidePanelTocEl) { return; }
        sidePanelTocEl.querySelectorAll('.side-panel-toc-item').forEach(function(item) {
            item.addEventListener('click', function() {
                var anchor = item.dataset.anchor;
                if (sidePanelHostBridge) {
                    sidePanelHostBridge._sendMessage({ type: 'scrollToAnchor', anchor: anchor });
                }
                sidePanelTocEl.querySelectorAll('.side-panel-toc-item').forEach(function(i) {
                    i.classList.remove('active');
                });
                item.classList.add('active');
            });
        });
    }

    function updateSidePanelTocFromMarkdown(markdown) {
        if (!sidePanelTocEl) { return; }
        var lines = markdown.split('\n');
        var toc = [];
        var inCodeBlock = false;
        for (var k = 0; k < lines.length; k++) {
            var line = lines[k];
            if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
            if (inCodeBlock) { continue; }
            var match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match) {
                var text = match[2].trim();
                var anchor = text.toLowerCase()
                    .replace(/[^\w\s\u3000-\u9fff\u{20000}-\u{2fa1f}\-]/gu, '')
                    .replace(/\s+/g, '-');
                toc.push({ level: match[1].length, text: text, anchor: anchor });
            }
        }
        renderSidePanelToc(toc);
    }

    function setupSidePanelImageDir() {
        if (sidePanelImageDirBtn) {
            sidePanelImageDirBtn.onclick = function() {
                if (sidePanelHostBridge) { sidePanelHostBridge.requestSetImageDir(); }
            };
        }
        host.getSidePanelImageDir(sidePanelFilePath);
    }

    function updateSidePanelImageDir(displayPath, source) {
        if (sidePanelImageDirPath) {
            sidePanelImageDirPath.textContent = displayPath || '';
            sidePanelImageDirPath.title = displayPath || '';
        }
        if (sidePanelImageDirSource) {
            var labels = {
                file: i18n.imageDirSourceFile || 'File',
                settings: i18n.imageDirSourceSettings || 'Settings',
                'default': i18n.imageDirSourceDefault || 'Default'
            };
            sidePanelImageDirSource.textContent = labels[source] || source || '';
        }
    }

    function updateSidePanelFileDir(displayPath, source) {
        if (sidePanelFileDirPath) {
            sidePanelFileDirPath.textContent = displayPath || '';
            sidePanelFileDirPath.title = displayPath || '';
        }
        if (sidePanelFileDirSource) {
            var labels = {
                file: i18n.fileDirSourceFile || 'File',
                settings: i18n.fileDirSourceSettings || 'Settings',
                'default': i18n.fileDirSourceDefault || 'Default'
            };
            sidePanelFileDirSource.textContent = labels[source] || source || '';
        }
    }

    function openSidePanelSidebar() {
        if (sidePanelSidebar) { sidePanelSidebar.classList.add('visible'); }
        if (sidePanelOpenOutlineBtn) { sidePanelOpenOutlineBtn.classList.add('hidden'); }
    }

    function closeSidePanelSidebar() {
        if (sidePanelSidebar) { sidePanelSidebar.classList.remove('visible'); }
        if (sidePanelOpenOutlineBtn) { sidePanelOpenOutlineBtn.classList.remove('hidden'); }
    }

    // --- 外部変更の編集中ガード ---

    function markActivelyEditing() {
        isActivelyEditing = true;
        clearTimeout(editingIdleTimer);
        editingIdleTimer = setTimeout(function() {
            isActivelyEditing = false;
            applyQueuedExternalUpdate();
        }, EDITING_IDLE_TIMEOUT);
    }

    function applyExternalUpdate(data) {
        var savedFocus = focusedNodeId;

        model = new OutlinerModel(data);
        searchEngine = new OutlinerSearch.SearchEngine(model);
        pageDir = data.pageDir || null;
        sidePanelWidthSetting = data.sidePanelWidth || null;
        pinnedTags = data.pinnedTags || [];
        // isDailyNotes は変更しない（外部変更はファイル切替ではない）
        // currentScope も変更しない（スコープ保持）

        updatePinnedTagBar();

        if (pageTitleInput && document.activeElement !== pageTitleInput) {
            pageTitleInput.value = model.title || '';
        }

        renderTree();

        // フォーカス復元: focusNode() は textEl.focus() を呼ぶためVSCodeが
        // このパネルをアクティブにしてしまう。外部変更時はCSSクラスのみ設定し
        // DOMフォーカスは奪わない。
        if (savedFocus && model.getNode(savedFocus)) {
            setFocusedNode(savedFocus);
        }
        // 初期ベースライン（undoStackには入れない → ボタンdisabled）
        saveBaseline();
    }

    function applyQueuedExternalUpdate() {
        if (queuedExternalUpdate === null) return;
        var data = queuedExternalUpdate.data;
        queuedExternalUpdate = null;
        applyExternalUpdate(data);
    }

    // --- ホスト通信 ---

    function scheduleSyncToHost() {
        markActivelyEditing();
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(function() {
            syncToHostImmediate();
        }, SYNC_DEBOUNCE_MS);
    }

    function syncToHostImmediate() {
        clearTimeout(syncDebounceTimer);
        var data = model.serialize();
        data.searchFocusMode = searchFocusMode;
        if (pageDir) { data.pageDir = pageDir; }
        if (imageDir) { data.imageDir = imageDir; }
        if (fileDir) { data.fileDir = fileDir; }
        if (sidePanelWidthSetting) { data.sidePanelWidth = sidePanelWidthSetting; }
        if (pinnedTags && pinnedTags.length > 0) { data.pinnedTags = pinnedTags; }
        host.syncData(JSON.stringify(data, null, 2));
    }

    // --- 固定タグバー & Daily Notes ナビバー (統合) ---

    function updatePinnedTagBar() {
        var bar = document.querySelector('.outliner-pinned-nav-bar');
        if (!bar) return;

        // 固定タグボタン生成
        var tagsArea = bar.querySelector('.outliner-pinned-tags-area');
        if (tagsArea) {
            tagsArea.innerHTML = '';
            for (var i = 0; i < pinnedTags.length; i++) {
                var btn = document.createElement('button');
                btn.className = 'outliner-pinned-tag-btn';
                btn.textContent = pinnedTags[i];
                btn.dataset.tag = pinnedTags[i];
                if (isTagInSearchText(searchInput ? searchInput.value.trim() : '', pinnedTags[i])) {
                    btn.classList.add('is-active');
                }
                btn.addEventListener('click', handlePinnedTagClick);
                tagsArea.appendChild(btn);
            }
        }

        // Daily Nav表示制御
        var dailyArea = bar.querySelector('.outliner-daily-nav-area');
        if (dailyArea) {
            dailyArea.style.display = isDailyNotes ? 'flex' : 'none';
        }

    }

    /** 検索テキスト内にタグがトークンとして含まれているか判定 */
    function isTagInSearchText(text, tag) {
        if (!text || !tag) return false;
        var tokens = text.split(/\s+/);
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i] === tag) return true;
        }
        return false;
    }

    /** 検索テキストからタグトークンを除去（前後のスペースも整理） */
    function removeTagFromSearchText(text, tag) {
        if (!text || !tag) return '';
        var tokens = text.split(/\s+/);
        var result = [];
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i] !== tag) {
                result.push(tokens[i]);
            }
        }
        return result.join(' ');
    }

    function handlePinnedTagClick(e) {
        var tag = e.currentTarget.dataset.tag;

        pushNavState();
        isNavigating = true;

        var currentText = searchInput ? searchInput.value.trim() : '';
        var isActive = isTagInSearchText(currentText, tag);

        if (isActive) {
            // OFF: 検索テキストからタグを除去
            var newText = removeTagFromSearchText(currentText, tag);
            searchInput.value = newText;
            if (newText.trim()) {
                executeSearch();
            } else {
                clearSearch();
            }
        } else {
            // ON: scope out + フォーカスモード + タグ追記
            if (currentScope.type === 'subtree') {
                currentScope = { type: 'document' };
                updateBreadcrumb();
            }
            if (!searchFocusMode) {
                searchFocusMode = true;
                updateSearchModeButton();
            }
            if (currentText) {
                searchInput.value = currentText + ' ' + tag;
            } else {
                searchInput.value = tag;
            }
            executeSearch();
        }

        updatePinnedTagBar();
        updateSearchClearButton();
        isNavigating = false;
        updateNavButtons();
    }

    function setupPinnedSettingsButton() {
        var pinnedSettingsBtn = document.querySelector('.outliner-pinned-settings-btn');
        if (pinnedSettingsBtn) {
            pinnedSettingsBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            pinnedSettingsBtn.addEventListener('click', function() {
                openPinnedTagsDialog();
            });
        }
    }

    function setupDailyNavBar() {
        dailyNavBar = document.querySelector('.outliner-pinned-nav-bar');
        if (!dailyNavBar) return;

        var todayBtn = document.getElementById('dailyNavToday');
        var prevBtn = document.getElementById('dailyNavPrev');
        var nextBtn = document.getElementById('dailyNavNext');
        var calendarBtn = document.getElementById('dailyNavCalendar');
        var pickerEl = document.getElementById('dailyNavPicker');
        var pickerMonth = new Date();

        if (todayBtn) todayBtn.addEventListener('click', function() {
            dailyCurrentDate = null;
            host.postDailyNotes('notesOpenDailyNotes');
        });
        if (prevBtn) prevBtn.addEventListener('click', function() {
            host.postDailyNotes('notesNavigateDailyNotes', -1, dailyCurrentDate);
        });
        if (nextBtn) nextBtn.addEventListener('click', function() {
            host.postDailyNotes('notesNavigateDailyNotes', 1, dailyCurrentDate);
        });

        if (calendarBtn && pickerEl) {
            calendarBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                pickerEl.style.display = pickerEl.style.display === 'none' ? '' : 'none';
                if (pickerEl.style.display !== 'none') {
                    if (dailyCurrentDate) {
                        pickerMonth = new Date(dailyCurrentDate);
                    } else {
                        pickerMonth = new Date();
                    }
                    renderDailyPicker();
                }
            });

            document.addEventListener('click', function() {
                if (pickerEl) pickerEl.style.display = 'none';
            });
            pickerEl.addEventListener('click', function(e) { e.stopPropagation(); });

            var prevMonthBtn = document.getElementById('dailyPickerPrevMonth');
            var nextMonthBtn = document.getElementById('dailyPickerNextMonth');
            if (prevMonthBtn) prevMonthBtn.addEventListener('click', function() {
                pickerMonth.setMonth(pickerMonth.getMonth() - 1);
                renderDailyPicker();
            });
            if (nextMonthBtn) nextMonthBtn.addEventListener('click', function() {
                pickerMonth.setMonth(pickerMonth.getMonth() + 1);
                renderDailyPicker();
            });
        }

        function renderDailyPicker() {
            var titleEl = document.getElementById('dailyPickerTitle');
            var gridEl = document.getElementById('dailyPickerGrid');
            if (!titleEl || !gridEl) return;

            var y = pickerMonth.getFullYear();
            var m = pickerMonth.getMonth();
            titleEl.textContent = y + '-' + String(m + 1).padStart(2, '0');
            gridEl.innerHTML = '';

            var firstDay = new Date(y, m, 1).getDay();
            var daysInMonth = new Date(y, m + 1, 0).getDate();
            var today = new Date();

            for (var i = 0; i < firstDay; i++) {
                var empty = document.createElement('span');
                empty.className = 'outliner-daily-picker-empty';
                gridEl.appendChild(empty);
            }
            for (var d = 1; d <= daysInMonth; d++) {
                var cell = document.createElement('button');
                cell.className = 'outliner-daily-picker-day';
                cell.textContent = String(d);
                var dateStr = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
                if (dateStr === dailyCurrentDate) cell.classList.add('selected');
                if (y === today.getFullYear() && m === today.getMonth() && d === today.getDate()) {
                    cell.classList.add('today');
                }
                cell.dataset.date = dateStr;
                cell.addEventListener('click', function() {
                    pickerEl.style.display = 'none';
                    host.postDailyNotes('notesNavigateToDate', this.dataset.date);
                });
                gridEl.appendChild(cell);
            }
        }
    }

    function setupHostMessages() {
        host.onMessage(function(msg) {
            switch (msg.type) {
                case 'updateNodeImages': {
                    // host が paste asset (copy/move) 完了後に新 images path を返してくる
                    if (!msg.nodeId) break;
                    var tNode = model.getNode(msg.nodeId);
                    if (!tNode) break;
                    tNode.images = Array.isArray(msg.newImages) ? msg.newImages.slice() : [];
                    renderTree();
                    scheduleSyncToHost();
                    break;
                }

                case 'updateNodeFilePath': {
                    // host が file asset copy/move 完了後に新 filePath を返してくる
                    if (!msg.nodeId) break;
                    var fNode = model.getNode(msg.nodeId);
                    if (!fNode) break;
                    fNode.filePath = msg.newFilePath || null;
                    renderTree();
                    scheduleSyncToHost();
                    break;
                }

                case 'updateData':
                    // file identity を先に反映 (同一性判定の唯一の根拠)
                    if (msg.outFileKey !== undefined) {
                        currentOutFileKey = msg.outFileKey;
                    }
                    // --- Notes ファイル切替（fileChangeIdあり）は従来通り即時適用 ---
                    if (msg.fileChangeId !== undefined) {
                        // 編集中ガード状態をリセット（ファイル切替は最優先）
                        isActivelyEditing = false;
                        clearTimeout(editingIdleTimer);
                        queuedExternalUpdate = null;

                        var savedFocus = focusedNodeId;
                        model = new OutlinerModel(msg.data);
                        searchEngine = new OutlinerSearch.SearchEngine(model);
                        pageDir = msg.data.pageDir || null;
                        sidePanelWidthSetting = msg.data.sidePanelWidth || null;
                        pinnedTags = msg.data.pinnedTags || [];
                        isDailyNotes = !!msg.isDailyNotes;
                        updatePinnedTagBar();
                        // Notes ファイル切替: 検索・スコープを全リセット
                        navBackStack.length = 0;
                        navForwardStack.length = 0;
                        updateNavButtons();
                        if (searchInput) {
                            searchInput.value = '';
                        }
                        currentSearchResult = null;
                        currentScope = { type: 'document' };
                        if (msg.scopeToNodeId) {
                            var preScopeTarget = model.getNode(msg.scopeToNodeId);
                            if (preScopeTarget) {
                                currentScope = { type: 'subtree', rootId: msg.scopeToNodeId };
                            }
                        }
                        updateBreadcrumb();
                        updatePinnedTagBar();
                        if (pageTitleInput && document.activeElement !== pageTitleInput) {
                            pageTitleInput.value = model.title || '';
                        }
                        if (model.rootIds.length === 0) {
                            var firstNode = model.addNode(null, null, '');
                            renderTree();
                            focusNode(firstNode.id);
                            scheduleSyncToHost();
                        } else {
                            renderTree();
                            if (msg.scopeToNodeId && currentScope.type === 'subtree') {
                                focusNode(msg.scopeToNodeId);
                            } else if (savedFocus && model.getNode(savedFocus)) {
                                focusNode(savedFocus);
                            }
                        }
                        if (msg.scopeToNodeId && isDailyNotes) {
                            var dayNode = model.getNode(msg.scopeToNodeId);
                            if (dayNode) {
                                var monthNode = model.getParent(msg.scopeToNodeId);
                                var yearNode = monthNode ? model.getParent(monthNode.id) : null;
                                if (yearNode && monthNode) {
                                    dailyCurrentDate = yearNode.text + '-' +
                                        String(monthNode.text).padStart(2, '0') + '-' +
                                        String(dayNode.text).padStart(2, '0');
                                }
                            }
                        }
                        if (msg.jumpToNodeId) {
                            setTimeout(function() {
                                jumpToAndHighlightNode(msg.jumpToNodeId);
                            }, 300);
                        }
                        // 新データの初期ベースライン（undoStackクリア → ボタンdisabled）
                        saveBaseline();
                        updateScopeSearchIndicator();
                        break;
                    }

                    // --- 外部変更（fileChangeIdなし）→ 編集中ガード ---
                    if (isActivelyEditing) {
                        queuedExternalUpdate = { data: msg.data };
                        break;
                    }

                    // アイドル状態 → 即時適用（フォーカス・スコープ・isDailyNotes保持）
                    applyExternalUpdate(msg.data);
                    break;

                case 'pageCreated':
                    var pageNode = model.getNode(msg.nodeId);
                    if (pageNode) {
                        renderTree();
                        focusNode(msg.nodeId);
                    }
                    break;

                case 'importMdFilesResult': {
                    var results = msg.results;
                    var impTargetId = msg.targetNodeId;
                    var impPosition = msg.position;

                    if (!results || results.length === 0) break;

                    var lastInsertedId = null;

                    for (var ri = 0; ri < results.length; ri++) {
                        var r = results[ri];
                        var newNode;

                        if (ri === 0) {
                            // 最初のファイル: ドロップ位置に従う
                            if (!impTargetId) {
                                // ルート末尾
                                var lastRootId2 = model.rootIds.length > 0 ? model.rootIds[model.rootIds.length - 1] : null;
                                newNode = model.addNode(null, lastRootId2, r.title);
                            } else if (impPosition === 'before') {
                                var info2 = model._getSiblingInfo(impTargetId);
                                var afterId2 = info2 && info2.index > 0 ? info2.siblings[info2.index - 1] : null;
                                newNode = model.addNode(model.getNode(impTargetId).parentId, afterId2, r.title);
                            } else if (impPosition === 'child') {
                                newNode = model.addNodeAtStart(impTargetId, r.title);
                                model.getNode(impTargetId).collapsed = false;
                            } else {
                                // after
                                newNode = model.addNode(model.getNode(impTargetId).parentId, impTargetId, r.title);
                            }
                        } else {
                            // 2番目以降: 前のノードの直後に兄弟として挿入
                            var prevNode2 = model.getNode(lastInsertedId);
                            newNode = model.addNode(prevNode2.parentId, lastInsertedId, r.title);
                        }

                        newNode.isPage = true;
                        newNode.pageId = r.pageId;
                        lastInsertedId = newNode.id;
                    }

                    renderTree();
                    if (lastInsertedId) focusNode(lastInsertedId);
                    scheduleSyncToHost();
                    break;
                }

                case 'importFilesResult': {
                    var results = msg.results;
                    var impTargetId = msg.targetNodeId;
                    var impPosition = msg.position;

                    if (!results || results.length === 0) break;

                    saveSnapshot();
                    var lastInsertedId = null;

                    for (var ri = 0; ri < results.length; ri++) {
                        var r = results[ri];
                        var newNode;

                        if (ri === 0) {
                            // 最初のファイル: ドロップ位置に従う
                            if (!impTargetId) {
                                // ルート末尾
                                var lastRootId3 = model.rootIds.length > 0 ? model.rootIds[model.rootIds.length - 1] : null;
                                newNode = model.addNode(null, lastRootId3, r.title);
                            } else if (impPosition === 'before') {
                                var info3 = model._getSiblingInfo(impTargetId);
                                var afterId3 = info3 && info3.index > 0 ? info3.siblings[info3.index - 1] : null;
                                newNode = model.addNode(model.getNode(impTargetId).parentId, afterId3, r.title);
                            } else if (impPosition === 'child') {
                                newNode = model.addNodeAtStart(impTargetId, r.title);
                                model.getNode(impTargetId).collapsed = false;
                            } else {
                                // after
                                newNode = model.addNode(model.getNode(impTargetId).parentId, impTargetId, r.title);
                            }
                        } else {
                            // 2番目以降: 前のノードの直後に兄弟として挿入
                            var prevNode3 = model.getNode(lastInsertedId);
                            newNode = model.addNode(prevNode3.parentId, lastInsertedId, r.title);
                        }

                        // Set filePath instead of isPage/pageId (mutual exclusion)
                        newNode.isPage = false;
                        newNode.pageId = null;
                        newNode.filePath = r.filePath;
                        lastInsertedId = newNode.id;
                    }

                    renderTree();
                    if (lastInsertedId) focusNode(lastInsertedId);
                    scheduleSyncToHost();
                    break;
                }

                case 'dropFilesResult': {
                    // D&D file import result (mixed md/image/file)
                    var results = msg.results || [];
                    var targetId = msg.targetNodeId;
                    var position = msg.position;

                    // Check if any results are ok
                    var anyOk = results.some(function(r) { return r.ok; });
                    if (!anyOk) break;

                    saveSnapshot();  // 1 D&D = 1 snapshot

                    var lastInsertedId = null;

                    for (var ri = 0; ri < results.length; ri++) {
                        var r = results[ri];
                        if (!r.ok) continue;  // Skip failed items

                        var newNode;
                        var insertParentId, insertAfterId;

                        if (lastInsertedId === null) {
                            // First node: use position
                            if (position === 'root-end' || !targetId) {
                                var lastRootId4 = model.rootIds.length > 0 ? model.rootIds[model.rootIds.length - 1] : null;
                                newNode = model.addNode(null, lastRootId4, '');
                            } else if (position === 'before') {
                                var beforeNode = model.getNode(targetId);
                                insertParentId = beforeNode.parentId;
                                var siblings = insertParentId ? model.getNode(insertParentId).children : model.rootIds;
                                var idx = siblings.indexOf(targetId);
                                insertAfterId = idx > 0 ? siblings[idx - 1] : null;
                                newNode = model.addNode(insertParentId, insertAfterId, '');
                            } else if (position === 'child') {
                                newNode = model.addNodeAtStart(targetId, '');
                                var t = model.getNode(targetId);
                                if (t.collapsed) t.collapsed = false;
                            } else { // 'after'
                                var afterNode = model.getNode(targetId);
                                newNode = model.addNode(afterNode.parentId, targetId, '');
                            }
                        } else {
                            // Subsequent nodes: sibling after previous
                            var prev = model.getNode(lastInsertedId);
                            newNode = model.addNode(prev.parentId, lastInsertedId, '');
                        }
                        lastInsertedId = newNode.id;

                        // Kind-specific node setup
                        if (r.kind === 'md') {
                            newNode.text = r.title;
                            newNode.isPage = true;
                            newNode.pageId = r.pageId;
                            newNode.filePath = null;
                        } else if (r.kind === 'image') {
                            newNode.text = '';
                            newNode.isPage = false;
                            newNode.pageId = null;
                            newNode.filePath = null;
                            model.addImage(newNode.id, r.imagePath);
                        } else { // 'file'
                            newNode.text = r.title;
                            newNode.isPage = false;
                            newNode.pageId = null;
                            newNode.filePath = r.filePath;
                        }
                    }

                    renderTree();
                    if (lastInsertedId) focusNode(lastInsertedId);
                    scheduleSyncToHost();
                    break;
                }

                case 'pageDirChanged':
                    pageDir = msg.pageDir || null;
                    break;

                case 'outlinerImageSaved':
                    if (msg.nodeId && msg.imagePath) {
                        saveSnapshot();
                        model.addImage(msg.nodeId, msg.imagePath);
                        var imgContainer = document.querySelector('.outliner-images[data-node-id="' + msg.nodeId + '"]');
                        if (imgContainer) {
                            renderNodeImages(imgContainer, model.getNode(msg.nodeId));
                        }
                        scheduleSyncToHost();
                    }
                    break;

                case 'outlinerImageDirChanged':
                    imageDir = msg.imageDir || null;
                    scheduleSyncToHost();
                    break;

                case 'outlinerFileDirChanged':
                    fileDir = msg.fileDir || null;
                    scheduleSyncToHost();
                    break;

                case 'outlinerImageDirStatus':
                    break;

                case 'notesNavigateInAppLink':
                    // Node link navigation: close sidepanel + jump to node
                    var notesBridge = window.notesHostBridge;
                    if (notesBridge) {
                        // Close sidepanel immediately if open
                        if (sidePanelEl && sidePanelEl.classList.contains('open')) {
                            closeSidePanelImmediate();
                        }
                        notesBridge.jumpToNode(msg.outFileId, msg.nodeId);
                    }
                    break;


                // --- サイドパネル関連メッセージ ---
                case 'openSidePanel':
                    openSidePanel(msg.markdown, msg.filePath, msg.fileName, msg.toc, msg.documentBaseUri);
                    break;

                case 'sidePanelMessage':
                    if (sidePanelHostBridge) {
                        sidePanelHostBridge._sendMessage(msg.data);
                    }
                    break;

                case 'scrollToLine':
                    if (sidePanelHostBridge) {
                        sidePanelHostBridge._sendMessage({ type: 'scrollToLine', lineNumber: msg.lineNumber });
                    }
                    break;

                case 'scrollToText':
                    if (sidePanelHostBridge) {
                        sidePanelHostBridge._sendMessage({ type: 'scrollToText', text: msg.text, occurrence: msg.occurrence });
                    }
                    break;

                case 'sidePanelImageDirStatus':
                    updateSidePanelImageDir(msg.displayPath, msg.source);
                    break;

                case 'sidePanelFileDirStatus':
                    updateSidePanelFileDir(msg.displayPath, msg.source);
                    break;

                case 'insertImageHtml':
                    if (sidePanelInstance && sidePanelHostBridge) {
                        sidePanelHostBridge._sendMessage({
                            type: 'insertImageHtml',
                            markdownPath: msg.markdownPath,
                            displayUri: msg.displayUri,
                            dataUri: msg.dataUri
                        });
                    }
                    break;

                case 'insertLinkHtml':
                    if (sidePanelInstance && sidePanelHostBridge) {
                        sidePanelHostBridge._sendMessage({
                            type: 'insertLinkHtml',
                            url: msg.url,
                            text: msg.text
                        });
                    }
                    break;

                case 'insertFileLink':
                    if (sidePanelInstance && sidePanelHostBridge) {
                        sidePanelHostBridge._sendMessage({
                            type: 'insertFileLink',
                            markdownPath: msg.markdownPath,
                            fileName: msg.fileName
                        });
                    }
                    break;

                case 'sidePanelAssetContext':
                    if (sidePanelHostBridge) {
                        sidePanelHostBridge._assetContext = {
                            imageDir: msg.imageDir,
                            fileDir: msg.fileDir,
                            mdDir: msg.mdDir
                        };
                    }
                    break;

                case 'pasteWithAssetCopyResult':
                    if (sidePanelInstance && sidePanelHostBridge) {
                        sidePanelHostBridge._sendMessage({
                            type: 'pasteWithAssetCopyResult',
                            markdown: msg.markdown
                        });
                    }
                    break;

                case 'translateResult':
                    // v10: Show translation result by replacing side panel MD content in readonly mode.
                    // Re-opens side panel with translated markdown, but in readonly display.
                    hideTranslateLoading();
                    showTranslationInSidePanel(msg.translatedMarkdown, msg.sourceLang, msg.targetLang);
                    break;

                case 'translateError':
                    hideTranslateLoading();
                    alert('Translation Error: ' + (msg.message || 'Failed'));
                    break;

                case 'translateLangSelected':
                    // v10: Update outliner-level side panel translation state
                    sidePanelTranslateSourceLang = msg.sourceLang || 'en';
                    sidePanelTranslateTargetLang = msg.targetLang || 'ja';
                    updateSidePanelTranslateLangBtn();
                    break;

                case 'scopeIn':
                    if (focusedNodeId) { setScope({ type: 'subtree', rootId: focusedNodeId }); }
                    break;

                case 'scopeOut':
                    setScope({ type: 'document' });
                    break;
            }
        });
    }

    // --- テキスト検索 & 置換ボックス (MDエディタの機能を踏襲) ---

    var textSearchBox = null;
    var textSearchInput = null;
    var textReplaceInput = null;
    var textSearchCountEl = null;
    var textSearchReplaceRow = null;
    var textSearchCaseEl = null;
    var textSearchWordEl = null;
    var textSearchRegexEl = null;
    // マッチエントリ: { nodeId, field: 'text'|'subtext', sourceStart, sourceEnd, renderedStart, renderedEnd }
    var textSearchMatches = [];
    var textSearchCurrentIndex = -1;

    function setupTextSearchReplace() {
        if (textSearchBox) { return; }
        var box = document.createElement('div');
        box.className = 'search-replace-box outliner-search-replace-box';
        box.style.display = 'none';
        box.innerHTML =
            '<div class="search-row">' +
              '<input type="text" class="search-input" placeholder="Search..." />' +
              '<span class="search-count">0/0</span>' +
              '<button class="search-prev" title="Previous">\u25B2</button>' +
              '<button class="search-next" title="Next">\u25BC</button>' +
              '<button class="toggle-replace" title="Toggle Replace">\u21A9</button>' +
              '<button class="close-search" title="Close">\u2715</button>' +
            '</div>' +
            '<div class="replace-row" style="display:none">' +
              '<input type="text" class="replace-input" placeholder="Replace..." />' +
              '<button class="replace-one" title="Replace">Replace</button>' +
              '<button class="replace-all" title="Replace All">All</button>' +
            '</div>' +
            '<div class="search-options">' +
              '<label><input type="checkbox" class="search-case-sensitive" /> Aa</label>' +
              '<label><input type="checkbox" class="search-whole-word" /> Ab|</label>' +
              '<label><input type="checkbox" class="search-regex" /> .*</label>' +
            '</div>';
        document.body.appendChild(box);

        textSearchBox = box;
        textSearchInput = box.querySelector('.search-input');
        textReplaceInput = box.querySelector('.replace-input');
        textSearchCountEl = box.querySelector('.search-count');
        textSearchReplaceRow = box.querySelector('.replace-row');
        textSearchCaseEl = box.querySelector('.search-case-sensitive');
        textSearchWordEl = box.querySelector('.search-whole-word');
        textSearchRegexEl = box.querySelector('.search-regex');

        textSearchInput.addEventListener('input', performTextSearch);
        textSearchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                goToTextMatch(textSearchCurrentIndex + (e.shiftKey ? -1 : 1));
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeTextSearchBox();
            }
        });
        textReplaceInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                replaceCurrentTextMatch();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeTextSearchBox();
            }
        });

        box.querySelector('.search-prev').addEventListener('click', function() {
            goToTextMatch(textSearchCurrentIndex - 1);
        });
        box.querySelector('.search-next').addEventListener('click', function() {
            goToTextMatch(textSearchCurrentIndex + 1);
        });
        box.querySelector('.close-search').addEventListener('click', closeTextSearchBox);
        box.querySelector('.toggle-replace').addEventListener('click', function() {
            if (textSearchReplaceRow.style.display === 'none') {
                textSearchReplaceRow.style.display = 'flex';
                textReplaceInput.focus();
            } else {
                textSearchReplaceRow.style.display = 'none';
                textSearchInput.focus();
            }
        });
        box.querySelector('.replace-one').addEventListener('click', replaceCurrentTextMatch);
        box.querySelector('.replace-all').addEventListener('click', replaceAllTextMatches);
        textSearchCaseEl.addEventListener('change', performTextSearch);
        textSearchWordEl.addEventListener('change', performTextSearch);
        textSearchRegexEl.addEventListener('change', performTextSearch);

        // ボックス内キーイベントが外に漏れないようにする（ノードハンドラ等の誤発火防止）
        box.addEventListener('keydown', function(e) {
            e.stopPropagation();
        });
    }

    function openTextSearchBox(showReplace) {
        setupTextSearchReplace();
        textSearchBox.style.display = 'block';
        textSearchReplaceRow.style.display = showReplace ? 'flex' : 'none';

        // 選択テキストがあれば検索ワードに反映
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
            var sText = sel.toString();
            if (sText && sText.length < 100 && sText.indexOf('\n') < 0) {
                textSearchInput.value = sText;
            }
        }
        textSearchInput.focus();
        textSearchInput.select();
        performTextSearch();
    }

    function closeTextSearchBox() {
        if (!textSearchBox) { return; }
        textSearchBox.style.display = 'none';
        clearTextSearchHighlights();
        textSearchMatches = [];
        textSearchCurrentIndex = -1;
        if (textSearchCountEl) { textSearchCountEl.textContent = '0/0'; }
    }

    function isTextSearchOpen() {
        return !!(textSearchBox && textSearchBox.style.display !== 'none');
    }

    /** 現在のスコープに属するノードIDリストをDFS順で返す */
    function getScopedNodeIds() {
        if (currentScope.type === 'subtree' && currentScope.rootId && model.getNode(currentScope.rootId)) {
            return [currentScope.rootId].concat(model.getDescendantIds(currentScope.rootId));
        }
        return model.getFlattenedIds(false);
    }

    /** 正規表現生成 (検索ワードとオプションから) */
    function buildTextSearchRegex() {
        var term = textSearchInput.value;
        if (!term) { return null; }
        var pattern = term;
        if (!textSearchRegexEl.checked) {
            pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (textSearchWordEl.checked) {
            pattern = '\\b' + pattern + '\\b';
        }
        try {
            return new RegExp(pattern, textSearchCaseEl.checked ? 'g' : 'gi');
        } catch (e) {
            return 'invalid';
        }
    }

    function performTextSearch() {
        if (!textSearchBox) { return; }
        clearTextSearchHighlights();
        textSearchMatches = [];
        textSearchCurrentIndex = -1;

        var regex = buildTextSearchRegex();
        if (regex === null) {
            textSearchCountEl.textContent = '0/0';
            return;
        }
        if (regex === 'invalid') {
            textSearchCountEl.textContent = 'Invalid';
            return;
        }

        var ids = getScopedNodeIds();
        for (var i = 0; i < ids.length; i++) {
            var node = model.getNode(ids[i]);
            if (!node) { continue; }

            // text フィールド: rendered text (markers除去後) で検索
            var srcText = node.text || '';
            if (srcText) {
                var renderedText = stripInlineMarkers(srcText);
                collectMatches(regex, renderedText, node.id, 'text', srcText);
            }

            // subtext フィールド: markersなし → rendered = source
            var sub = node.subtext || '';
            if (sub) {
                collectMatches(regex, sub, node.id, 'subtext', sub);
            }
        }

        if (textSearchMatches.length > 0) {
            goToTextMatch(0);
        } else {
            textSearchCountEl.textContent = '0/0';
        }
    }

    function collectMatches(regex, rendered, nodeId, field, sourceText) {
        regex.lastIndex = 0;
        var m;
        while ((m = regex.exec(rendered)) !== null) {
            if (m[0].length === 0) { regex.lastIndex++; continue; } // ゼロ幅マッチ回避
            var rs = m.index;
            var re = m.index + m[0].length;
            var ss, se;
            if (field === 'text') {
                ss = renderedOffsetToSource(sourceText, rs);
                se = renderedOffsetToSource(sourceText, re);
            } else {
                ss = rs;
                se = re;
            }
            textSearchMatches.push({
                nodeId: nodeId,
                field: field,
                sourceStart: ss,
                sourceEnd: se,
                renderedStart: rs,
                renderedEnd: re
            });
        }
    }

    function clearTextSearchHighlights() {
        var hits = treeEl ? treeEl.querySelectorAll('.outliner-search-hit, .outliner-search-hit-current') : [];
        for (var i = 0; i < hits.length; i++) {
            var el = hits[i];
            var parent = el.parentNode;
            if (!parent) { continue; }
            while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
            parent.removeChild(el);
            parent.normalize();
        }
    }

    /** 指定ノードの指定フィールドDOM要素を取得 (描画モードのみ対象) */
    function getFieldElement(nodeId, field) {
        if (!treeEl) { return null; }
        var nodeEl = treeEl.querySelector('.outliner-node[data-id="' + nodeId + '"]');
        if (!nodeEl) { return null; }
        if (field === 'text') {
            return nodeEl.querySelector('.outliner-text');
        }
        return nodeEl.querySelector('.outliner-subtext');
    }

    /**
     * 要素内のレンダリング後オフセット範囲 [rStart, rEnd] をラップして <span> 化する。
     * 複数のテキストノードにまたがる場合は分割してそれぞれをラップする。
     */
    function wrapRenderedRange(el, rStart, rEnd, cls) {
        if (!el || rStart >= rEnd) { return; }
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var pos = 0;
        var node;
        var ops = [];
        while ((node = walker.nextNode())) {
            var txt = node.nodeValue || '';
            var nodeStart = pos;
            var nodeEnd = pos + txt.length;
            if (nodeEnd <= rStart) { pos = nodeEnd; continue; }
            if (nodeStart >= rEnd) { break; }
            var localStart = Math.max(0, rStart - nodeStart);
            var localEnd = Math.min(txt.length, rEnd - nodeStart);
            if (localStart < localEnd) {
                ops.push({ node: node, start: localStart, end: localEnd });
            }
            pos = nodeEnd;
        }
        // 逆順に処理 (splitText によるオフセットずれを回避)
        for (var i = ops.length - 1; i >= 0; i--) {
            var op = ops[i];
            try {
                var textNode = op.node;
                if (op.end < (textNode.nodeValue || '').length) {
                    textNode.splitText(op.end);
                }
                if (op.start > 0) {
                    textNode = textNode.splitText(op.start);
                }
                var span = document.createElement('span');
                span.className = cls;
                textNode.parentNode.insertBefore(span, textNode);
                span.appendChild(textNode);
            } catch (e) {
                // 失敗時はスキップ (編集モード遷移中等の稀なケース)
            }
        }
    }

    function paintTextSearchHighlights() {
        clearTextSearchHighlights();
        if (textSearchMatches.length === 0) { return; }
        for (var i = 0; i < textSearchMatches.length; i++) {
            var m = textSearchMatches[i];
            var el = getFieldElement(m.nodeId, m.field);
            if (!el) { continue; }
            // 編集中の要素はスキップ (innerHTMLが書き換わるため)
            if (document.activeElement === el) { continue; }
            var cls = (i === textSearchCurrentIndex) ? 'outliner-search-hit-current' : 'outliner-search-hit';
            wrapRenderedRange(el, m.renderedStart, m.renderedEnd, cls);
        }
    }

    /** ノードの祖先 collapsed を全て解除してツリーを再描画 (必要な場合のみ) */
    function ensureNodeExpanded(nodeId) {
        var changed = false;
        var n = model.getNode(nodeId);
        if (!n) { return false; }
        var cur = n.parentId ? model.getNode(n.parentId) : null;
        while (cur) {
            if (cur.collapsed) { cur.collapsed = false; changed = true; }
            cur = cur.parentId ? model.getNode(cur.parentId) : null;
        }
        if (changed) { renderTree(); }
        return changed;
    }

    function goToTextMatch(index) {
        if (textSearchMatches.length === 0) {
            textSearchCountEl.textContent = '0/0';
            return;
        }
        if (index < 0) { index = textSearchMatches.length - 1; }
        if (index >= textSearchMatches.length) { index = 0; }
        textSearchCurrentIndex = index;
        var m = textSearchMatches[index];

        // 折畳みされていれば展開
        ensureNodeExpanded(m.nodeId);

        // ハイライト再描画 (current を区別)
        paintTextSearchHighlights();

        // スクロール
        var el = getFieldElement(m.nodeId, m.field);
        if (el) {
            var hit = el.querySelector('.outliner-search-hit-current');
            var target = hit || el;
            if (target.scrollIntoView) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        textSearchCountEl.textContent = (index + 1) + '/' + textSearchMatches.length;
    }

    /** 1ノードの text または subtext を再描画 (blur 状態のみ) */
    function rerenderNodeField(nodeId, field) {
        var el = getFieldElement(nodeId, field);
        if (!el) { return; }
        if (document.activeElement === el) { return; } // 編集中は触らない
        var node = model.getNode(nodeId);
        if (!node) { return; }
        if (field === 'text') {
            el.innerHTML = renderInlineText(node.text || '');
        } else {
            var sub = node.subtext || '';
            if (sub) {
                el.classList.add('has-content');
                el.textContent = getSubtextPreview(sub);
            } else {
                el.classList.remove('has-content');
                el.textContent = '';
            }
        }
    }

    function replaceCurrentTextMatch() {
        if (textSearchCurrentIndex < 0 || textSearchCurrentIndex >= textSearchMatches.length) { return; }
        var m = textSearchMatches[textSearchCurrentIndex];
        var node = model.getNode(m.nodeId);
        if (!node) { return; }

        saveSnapshot();
        var replaceValue = textReplaceInput.value;
        var src = (m.field === 'text') ? (node.text || '') : (node.subtext || '');
        var newSrc = src.slice(0, m.sourceStart) + replaceValue + src.slice(m.sourceEnd);
        if (m.field === 'text') {
            model.updateText(node.id, newSrc);
        } else {
            model.updateSubtext(node.id, newSrc);
        }
        rerenderNodeField(m.nodeId, m.field);
        scheduleSyncToHost();

        // 再検索して次のマッチへ
        var preferIndex = textSearchCurrentIndex;
        performTextSearch();
        if (textSearchMatches.length > 0) {
            goToTextMatch(Math.min(preferIndex, textSearchMatches.length - 1));
        }
    }

    function replaceAllTextMatches() {
        if (textSearchMatches.length === 0) { return; }
        saveSnapshot();
        var replaceValue = textReplaceInput.value;

        // (nodeId, field) でグループ化
        var groups = {};
        for (var i = 0; i < textSearchMatches.length; i++) {
            var m = textSearchMatches[i];
            var key = m.nodeId + '\u0000' + m.field;
            if (!groups[key]) { groups[key] = { nodeId: m.nodeId, field: m.field, items: [] }; }
            groups[key].items.push(m);
        }
        var keys = Object.keys(groups);
        for (var k = 0; k < keys.length; k++) {
            var g = groups[keys[k]];
            var node = model.getNode(g.nodeId);
            if (!node) { continue; }
            // sourceStart 降順 (後ろから置換してオフセットを壊さない)
            g.items.sort(function(a, b) { return b.sourceStart - a.sourceStart; });
            var src = (g.field === 'text') ? (node.text || '') : (node.subtext || '');
            for (var j = 0; j < g.items.length; j++) {
                var it = g.items[j];
                src = src.slice(0, it.sourceStart) + replaceValue + src.slice(it.sourceEnd);
            }
            if (g.field === 'text') {
                model.updateText(node.id, src);
            } else {
                model.updateSubtext(node.id, src);
            }
            rerenderNodeField(g.nodeId, g.field);
        }
        scheduleSyncToHost();

        // 再検索 (通常は 0 件になる)
        performTextSearch();
    }

    // --- グローバルキーハンドラ ---

    function setupKeyHandlers() {
        document.addEventListener('keydown', function(e) {
            // Cmd+F / Cmd+H / Cmd+Shift+F グローバルフォールバック
            //   (ノード編集中は textEl の handleNodeKeydown 側で stopPropagation 済み)
            //   (サイドパネル MD エディタにフォーカスがある場合は editor.js 側に委譲)
            if ((e.metaKey || e.ctrlKey) && !e.altKey) {
                var ae = document.activeElement;
                var inBox = !!(textSearchBox && ae && textSearchBox.contains(ae));
                var inSidePanel = !!(ae && ae.closest && ae.closest('.side-panel-editor-root'));
                if (!inBox && !inSidePanel) {
                    if (!e.shiftKey && (e.key === 'f' || e.key === 'F')) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
                        openTextSearchBox(false);
                        return;
                    }
                    if (!e.shiftKey && (e.key === 'h' || e.key === 'H')) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
                        openTextSearchBox(true);
                        return;
                    }
                    if (e.shiftKey && (e.key === 'f' || e.key === 'F')) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
                        if (searchInput) { searchInput.focus(); searchInput.select(); }
                        return;
                    }
                }
            }

            // 画像選択中の Delete/Backspace
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImageInfo) {
                e.preventDefault();
                saveSnapshot();
                var imgNodeId = selectedImageInfo.nodeId;
                model.removeImage(imgNodeId, selectedImageInfo.index);
                var imgC = document.querySelector('.outliner-images[data-node-id="' + imgNodeId + '"]');
                if (imgC) { renderNodeImages(imgC, model.getNode(imgNodeId)); }
                clearImageSelection();
                scheduleSyncToHost();
                return;
            }

            // グローバル Cmd+] スコープイン / Cmd+Shift+] スコープアウト (ノード内keydownで未処理の場合)
            if ((e.metaKey || e.ctrlKey) && (e.key === ']' || e.code === 'BracketRight')) {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) {
                    setScope({ type: 'document' });
                } else {
                    if (focusedNodeId) { setScope({ type: 'subtree', rootId: focusedNodeId }); }
                }
                return;
            }
            // Ctrl/Cmd+N: 新規ノード
            if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
                e.preventDefault();
                saveSnapshot();
                var newNode = model.addNode(null, model.rootIds[model.rootIds.length - 1], '');
                renderTree();
                focusNode(newNode.id);
                scheduleSyncToHost();
            }
            // グローバル Undo/Redo (検索バーフォーカス時も動作)
            if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
                // ノード内keydownで処理済みの場合はスキップ
                if (document.activeElement && document.activeElement.classList.contains('outliner-text')) { return; }
                // editor.js capture handler で sidepanel markdown の undo が処理済みならスキップ
                if (e.defaultPrevented) { return; }
                e.preventDefault();
                undo();
            }
            if ((e.metaKey || e.ctrlKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
                if (document.activeElement && document.activeElement.classList.contains('outliner-text')) { return; }
                // editor.js capture handler で sidepanel markdown の redo が処理済みならスキップ
                if (e.defaultPrevented) { return; }
                e.preventDefault();
                redo();
            }
        });
    }

    // --- Public API ---

    return {
        init: init,
        getModel: function() { return model; },
        flushSync: function() { if (model) syncToHostImmediate(); },
        resetSearchAndScope: function() {
            if (searchInput) searchInput.value = '';
            currentSearchResult = null;
            currentScope = { type: 'document' };
            if (typeof updateBreadcrumb === 'function') updateBreadcrumb();
            if (typeof renderTree === 'function') renderTree();
        }
    };
})();
