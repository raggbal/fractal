/**
 * OutlinerTable — Outliner Table Editor (Notion / Coda style table view)
 *
 * Phase B (TASK-B2): Outliner cell render & operation compatibility.
 *
 * Provides full Outliner-cell editing parity with the existing Outliner editor:
 *   - cmd+B / cmd+I / cmd+E / cmd+Shift+S inline format toggle
 *   - cmd+enter -> host.openMdPage / openAttachedFile
 *   - Tab / Shift+Tab tree-wide indent / outdent
 *   - Enter sibling add (handles offset / leading children move)
 *   - Backspace at start (delete + child promotion)
 *   - cmd+x / cmd+c / cmd+v node clipboard
 *   - tag / link rendering (delegates to OutlinerCell.renderInlineText)
 *   - Shift+Enter subtext open/close
 *   - cmd+z / cmd+shift+z undo/redo (cell-local snapshot stack)
 *   - cmd+Shift+C copy page path (host.copyPagePaths)
 *   - file attach via D&D (host.attachFile)
 *
 * Subsequent tasks add:
 *   - TASK-B3: Text cell rich text
 *   - TASK-B4: Row recycling (collapse/indent 連動)
 *   - TASK-B5: Column add/remove/reorder UI
 *   - TASK-B6: Header search box
 *   - TASK-B7: Switch view button (Outliner ↔ Table)
 *   - TASK-B8: Undo / redo improvements
 *   - TASK-B9: i18n
 *   - TASK-C*: Multiselect column (chips, dropdown)
 *
 * UMD pattern (mirrors outliner-cell.js): works as `window.OutlinerTable` in webview /
 * standalone HTML AND as `module.exports` in Node.js (for unit-level tests).
 *
 * design: design/system.md §4.3 / §4.3.4 (Cell ↔ Tree boundary)
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.OutlinerTable = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // --- module-private state ---
    var model = null;
    var columns = [];
    var rawDataExtras = {};
    var host = null;
    var initialData = null;
    var rootEl = null;
    var focusedNodeId = null;

    // undo / redo stacks (cell-local; Table editor 単独の stack)
    var undoStack = [];
    var redoStack = [];
    var MAX_UNDO = 100;
    var isUndoRedo = false;
    var snapshotDebounceTimer = null;
    var SNAPSHOT_DEBOUNCE_MS = 500;

    // sync-to-host debounce
    var syncDebounceTimer = null;
    var SYNC_DEBOUNCE_MS = 1000;

    // outliner.js と同じ knownKeys 集合 + columns。
    // columns は Table editor が直接管理するため、rawDataExtras には入れない。
    // schemaVersion は v7.3 で撤回された field、知っているが書かない (drop)。
    var KNOWN_TOP_KEYS = [
        'title', 'pageDir', 'fileDir', 'imageDir', 'rootIds', 'nodes',
        'pinnedTags', 'searchFocusMode', 'sidePanelWidth', 'sidePanelOutlineWidth',
        'schemaVersion', 'columns', 'version'
    ];

    // --- ID helpers (design/system.md §3.3) ---

    function generateColumnId() {
        return 'col_' + Math.random().toString(36).slice(2, 10);
    }

    function generateOptionId() {
        return 'opt_' + Math.random().toString(36).slice(2, 10);
    }

    // --- column / data lifecycle ---

    /**
     * 列定義の不変条件を維持 (design/system.md §3.2):
     *  - 1 個以上の type:'outliner' 列が必ず存在
     *  - 無ければ自動補完 (order = -1, 先頭に置く)
     *  - その後 order でソート
     */
    function ensureColumnsValid() {
        var injected = false;
        var hasOutliner = false;
        for (var i = 0; i < columns.length; i++) {
            if (columns[i] && columns[i].type === 'outliner') { hasOutliner = true; break; }
        }
        if (!hasOutliner) {
            columns.unshift({
                id: 'col_outliner',
                type: 'outliner',
                name: 'Outline',
                order: -1
            });
            injected = true;
        }
        // 安定 sort: a.order - b.order が等しい場合は元順序を維持
        columns = columns
            .map(function (c, idx) { return { c: c, idx: idx }; })
            .sort(function (a, b) {
                if (a.c.order !== b.c.order) { return a.c.order - b.c.order; }
                return a.idx - b.idx;
            })
            .map(function (e) { return e.c; });
        return injected;
    }

    function captureRawDataExtras(data) {
        var extras = {};
        if (data && typeof data === 'object') {
            for (var k in data) {
                if (Object.prototype.hasOwnProperty.call(data, k) &&
                    KNOWN_TOP_KEYS.indexOf(k) === -1) {
                    extras[k] = data[k];
                }
            }
        }
        return extras;
    }

    /**
     * 初期化エントリ。
     */
    function init(data, hostBridge, container) {
        host = hostBridge || (typeof window !== 'undefined' ? window.outlinerTableHostBridge : null);
        initialData = data || {};
        rootEl = container || (typeof document !== 'undefined' ? document.querySelector('.otable-root') : null);

        var ModelCtor = (typeof OutlinerModel !== 'undefined') ? OutlinerModel
            : (typeof require === 'function' ? require('./outliner-model') : null);
        if (!ModelCtor) {
            throw new Error('[OutlinerTable] OutlinerModel が見つかりません');
        }
        model = new ModelCtor(initialData);

        columns = Array.isArray(initialData.columns) ? initialData.columns.slice() : [];
        var hadOriginalColumns = Array.isArray(initialData.columns);
        var injected = ensureColumnsValid();
        OutlinerTableState._hadOriginalColumns = hadOriginalColumns;
        OutlinerTableState._autoOutlinerInjected = injected && !hadOriginalColumns;

        rawDataExtras = captureRawDataExtras(initialData);

        // baseline snapshot (undo)
        undoStack = [];
        redoStack = [];

        renderTable();
    }

    function applyExternalUpdate(newData) {
        initialData = newData || {};
        var ModelCtor = (typeof OutlinerModel !== 'undefined') ? OutlinerModel
            : (typeof require === 'function' ? require('./outliner-model') : null);
        if (!ModelCtor) { return; }
        model = new ModelCtor(initialData);
        columns = Array.isArray(initialData.columns) ? initialData.columns.slice() : [];
        var hadOriginalColumns = Array.isArray(initialData.columns);
        var injected = ensureColumnsValid();
        OutlinerTableState._hadOriginalColumns = hadOriginalColumns;
        OutlinerTableState._autoOutlinerInjected = injected && !hadOriginalColumns;
        rawDataExtras = captureRawDataExtras(initialData);
        renderTable();
    }

    function serialize() {
        var data = model.serialize();

        if (initialData.pageDir) { data.pageDir = initialData.pageDir; }
        if (initialData.fileDir) { data.fileDir = initialData.fileDir; }
        if (initialData.imageDir) { data.imageDir = initialData.imageDir; }
        if (Array.isArray(initialData.pinnedTags) && initialData.pinnedTags.length > 0) {
            data.pinnedTags = initialData.pinnedTags.slice();
        }
        if (initialData.searchFocusMode) { data.searchFocusMode = initialData.searchFocusMode; }
        if (initialData.sidePanelWidth) { data.sidePanelWidth = initialData.sidePanelWidth; }
        if (initialData.sidePanelOutlineWidth) { data.sidePanelOutlineWidth = initialData.sidePanelOutlineWidth; }

        var shouldEmitColumns = false;
        if (OutlinerTableState._hadOriginalColumns) {
            shouldEmitColumns = true;
        } else if (columns.length > 1) {
            shouldEmitColumns = true;
        } else if (columns.length === 1 && !OutlinerTableState._autoOutlinerInjected) {
            shouldEmitColumns = true;
        }
        if (shouldEmitColumns) {
            data.columns = columns.slice();
        }

        for (var rk in rawDataExtras) {
            if (Object.prototype.hasOwnProperty.call(rawDataExtras, rk) && !(rk in data)) {
                data[rk] = rawDataExtras[rk];
            }
        }
        return data;
    }

    function syncToHostImmediate() {
        if (!host || typeof host.syncData !== 'function') { return; }
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
        var data = serialize();
        host.syncData(JSON.stringify(data, null, 2));
    }

    function scheduleSyncToHost() {
        if (!host || typeof host.syncData !== 'function') { return; }
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(function () {
            syncDebounceTimer = null;
            syncToHostImmediate();
        }, SYNC_DEBOUNCE_MS);
    }

    // --- undo / redo (cell-local; Table editor 単独の stack) ---

    function saveSnapshot() {
        if (isUndoRedo) { return; }
        var snapshot = JSON.stringify(model.serialize());
        if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snapshot) { return; }
        undoStack.push(snapshot);
        if (undoStack.length > MAX_UNDO) { undoStack.shift(); }
        redoStack.length = 0;
    }

    function saveSnapshotDebounced() {
        if (isUndoRedo) { return; }
        clearTimeout(snapshotDebounceTimer);
        snapshotDebounceTimer = setTimeout(function () {
            snapshotDebounceTimer = null;
            saveSnapshot();
        }, SNAPSHOT_DEBOUNCE_MS);
    }

    function applyUndoSnapshot(snapshot) {
        try {
            var parsed = JSON.parse(snapshot);
            // 既存 columns / rawDataExtras を保ったまま model 部分だけ差し替え
            var ModelCtor = (typeof OutlinerModel !== 'undefined') ? OutlinerModel
                : (typeof require === 'function' ? require('./outliner-model') : null);
            if (!ModelCtor) { return; }
            // model serialize() の出力には columns 等は含まないので、既存 initialData の補助 fields を merge
            var merged = Object.assign({}, parsed);
            model = new ModelCtor(merged);
            renderTable();
        } catch (_) { /* ignore */ }
    }

    function undo() {
        if (undoStack.length < 1) { return false; }
        // current state を redo stack に push してから undo stack から取り出す
        var current = JSON.stringify(model.serialize());
        // 末尾が current と同じなら 1 個 pop して 1 つ前に戻る
        var target;
        if (undoStack[undoStack.length - 1] === current && undoStack.length >= 2) {
            redoStack.push(undoStack.pop());
            target = undoStack[undoStack.length - 1];
        } else {
            target = undoStack.pop();
            redoStack.push(current);
        }
        if (!target) { return false; }
        isUndoRedo = true;
        applyUndoSnapshot(target);
        isUndoRedo = false;
        scheduleSyncToHost();
        return true;
    }

    function redo() {
        if (redoStack.length < 1) { return false; }
        var target = redoStack.pop();
        var current = JSON.stringify(model.serialize());
        undoStack.push(current);
        isUndoRedo = true;
        applyUndoSnapshot(target);
        isUndoRedo = false;
        scheduleSyncToHost();
        return true;
    }

    // --- cell host adapter (provides everything OutlinerCell needs) ---

    function _cellHost() {
        return {
            // image host adapter (Phase 4)
            getImageBaseUri: function () { return ''; }, // standalone test 環境では空 prefix
            getModel: function () { return model; },
            saveSnapshot: function () { saveSnapshot(); },
            scheduleSyncToHost: function () { scheduleSyncToHost(); },
            syncToHostImmediate: function () { syncToHostImmediate(); },
            getImageDragState: function () { return _imageDragState; },
            setImageDragState: function (s) { _imageDragState = s; },
            getSelectedImageInfo: function () { return _selectedImageInfo; },
            setSelectedImageInfo: function (s) { _selectedImageInfo = s; },
            isReadOnly: function () { return false; },
            // subtext host adapter (Phase 5)
            focusNode: function (id) { focusOutlinerCell(id); },
            save: function () { syncToHostImmediate(); }
        };
    }
    var _imageDragState = null;
    var _selectedImageInfo = null;

    // --- DOM utilities ---

    function getRowEl(nodeId) {
        if (!rootEl) { return null; }
        return rootEl.querySelector('.otable-row[data-node-id="' + nodeId + '"]');
    }

    function getOutlinerCellEl(nodeId) {
        var row = getRowEl(nodeId);
        if (!row) { return null; }
        return row.querySelector('.otable-cell-outliner');
    }

    function getOutlinerTextEl(nodeId) {
        var cell = getOutlinerCellEl(nodeId);
        if (!cell) { return null; }
        return cell.querySelector('.outliner-text');
    }

    function focusOutlinerCell(nodeId) {
        focusedNodeId = nodeId;
        var textEl = getOutlinerTextEl(nodeId);
        if (textEl && typeof textEl.focus === 'function') {
            textEl.focus();
            if (OutlinerCell && OutlinerCell.setCursorToEnd) {
                OutlinerCell.setCursorToEnd(textEl);
            }
        }
    }

    function focusOutlinerCellAtStart(nodeId) {
        focusedNodeId = nodeId;
        var textEl = getOutlinerTextEl(nodeId);
        if (textEl && typeof textEl.focus === 'function') {
            textEl.focus();
            if (OutlinerCell && OutlinerCell.setCursorToStart) {
                OutlinerCell.setCursorToStart(textEl);
            }
        }
    }

    // --- rendering ---

    function ensureBodyEl() {
        if (!rootEl) { return null; }
        var body = rootEl.querySelector('.otable-body');
        if (!body) {
            body = document.createElement('div');
            body.className = 'otable-body';
            rootEl.appendChild(body);
        }
        return body;
    }

    function renderColumnHeaders(body) {
        var existing = body.querySelector('.otable-column-headers');
        if (existing) { existing.parentNode.removeChild(existing); }
        var headerRow = document.createElement('div');
        headerRow.className = 'otable-column-headers';
        for (var i = 0; i < columns.length; i++) {
            var col = columns[i];
            var th = document.createElement('div');
            th.className = 'otable-column-header otable-column-type-' + col.type;
            th.dataset.colId = col.id;
            th.textContent = col.name || col.type;
            // TASK-B5: D&D handle for column reorder + context menu for delete
            th.draggable = true;
            attachColumnHeaderHandlers(th, col);
            headerRow.appendChild(th);
        }
        // TASK-B5: "+ add column" button at the right end
        var addBtn = document.createElement('div');
        addBtn.className = 'otable-add-column-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add column';
        addBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openAddColumnModal();
        });
        headerRow.appendChild(addBtn);
        body.appendChild(headerRow);
        return headerRow;
    }

    // ── TASK-B5: column header D&D + right-click context menu ──

    var _draggingColId = null;

    function attachColumnHeaderHandlers(th, col) {
        th.addEventListener('dragstart', function (e) {
            _draggingColId = col.id;
            try { e.dataTransfer.effectAllowed = 'move'; } catch (_) { /* ignore */ }
            try { e.dataTransfer.setData('text/plain', col.id); } catch (_) { /* ignore */ }
            th.classList.add('otable-col-dragging');
        });
        th.addEventListener('dragend', function () {
            th.classList.remove('otable-col-dragging');
            _draggingColId = null;
            var headers = document.querySelectorAll('.otable-column-header');
            for (var i = 0; i < headers.length; i++) {
                headers[i].classList.remove('otable-col-drop-target');
            }
        });
        th.addEventListener('dragover', function (e) {
            if (!_draggingColId || _draggingColId === col.id) { return; }
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ }
            th.classList.add('otable-col-drop-target');
        });
        th.addEventListener('dragleave', function () {
            th.classList.remove('otable-col-drop-target');
        });
        th.addEventListener('drop', function (e) {
            if (!_draggingColId || _draggingColId === col.id) { return; }
            e.preventDefault();
            th.classList.remove('otable-col-drop-target');
            var fromCol = columns.find(function (c) { return c.id === _draggingColId; });
            var toCol = col;
            if (!fromCol || !toCol) { return; }
            var sorted = columns.slice().sort(function (a, b) { return a.order - b.order; });
            var fromIdx = sorted.findIndex(function (c) { return c.id === fromCol.id; });
            var toIdx = sorted.findIndex(function (c) { return c.id === toCol.id; });
            if (fromIdx < 0 || toIdx < 0) { return; }
            reorderColumns(fromIdx, toIdx);
        });
        th.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openColumnHeaderMenu(col, e.clientX, e.clientY);
        });
    }

    // ── TASK-B5: column add / remove / reorder ──

    function addColumn(type, name) {
        if (type !== 'text' && type !== 'multiselect') { return null; }
        var maxOrder = -1;
        for (var i = 0; i < columns.length; i++) {
            if (columns[i].order > maxOrder) { maxOrder = columns[i].order; }
        }
        saveSnapshot();
        var newCol = {
            id: generateColumnId(),
            type: type,
            name: name || (type === 'text' ? 'Text' : 'Tags'),
            order: maxOrder + 1
        };
        if (type === 'multiselect') { newCol.options = []; }
        columns.push(newCol);
        ensureColumnsValid();
        // adding any column flips _hadOriginalColumns true so serialize emits columns
        OutlinerTableState._hadOriginalColumns = true;
        OutlinerTableState._autoOutlinerInjected = false;
        forceRebuildRows();
        renderTable();
        scheduleSyncToHost();
        return newCol;
    }

    function removeColumn(colId) {
        var col = null;
        for (var i = 0; i < columns.length; i++) {
            if (columns[i].id === colId) { col = columns[i]; break; }
        }
        if (!col || col.type === 'outliner') { return false; }
        saveSnapshot();
        columns = columns.filter(function (c) { return c.id !== colId; });
        // cleanup columnValues across all nodes
        if (model && model.nodes) {
            for (var nid in model.nodes) {
                if (Object.prototype.hasOwnProperty.call(model.nodes, nid)) {
                    var n = model.nodes[nid];
                    if (n.columnValues && Object.prototype.hasOwnProperty.call(n.columnValues, colId)) {
                        delete n.columnValues[colId];
                    }
                }
            }
        }
        forceRebuildRows();
        renderTable();
        scheduleSyncToHost();
        return true;
    }

    function reorderColumns(fromOrder, toOrder) {
        if (fromOrder === toOrder) { return; }
        saveSnapshot();
        var sorted = columns.slice().sort(function (a, b) { return a.order - b.order; });
        if (fromOrder < 0 || fromOrder >= sorted.length) { return; }
        if (toOrder < 0 || toOrder >= sorted.length) { return; }
        var moved = sorted.splice(fromOrder, 1)[0];
        sorted.splice(toOrder, 0, moved);
        for (var i = 0; i < sorted.length; i++) { sorted[i].order = i; }
        columns = sorted;
        OutlinerTableState._hadOriginalColumns = true;
        OutlinerTableState._autoOutlinerInjected = false;
        forceRebuildRows();
        renderTable();
        scheduleSyncToHost();
    }

    function forceRebuildRows() {
        if (!rootEl) { return; }
        var existing = rootEl.querySelector('.otable-rows');
        if (existing) { existing.parentNode.removeChild(existing); }
    }

    // ── TASK-B5: add column modal ──

    function openAddColumnModal() {
        var existing = document.querySelector('.otable-modal-overlay');
        if (existing) { existing.parentNode.removeChild(existing); }

        var overlay = document.createElement('div');
        overlay.className = 'otable-modal-overlay otable-add-column-modal';

        var modal = document.createElement('div');
        modal.className = 'otable-modal';

        var title = document.createElement('div');
        title.className = 'otable-modal-title';
        title.textContent = 'Add column';
        modal.appendChild(title);

        var nameLabel = document.createElement('label');
        nameLabel.className = 'otable-modal-label';
        nameLabel.textContent = 'Name';
        modal.appendChild(nameLabel);
        var nameInput = document.createElement('input');
        nameInput.className = 'otable-modal-input';
        nameInput.type = 'text';
        nameInput.value = '';
        nameInput.placeholder = 'Column name';
        modal.appendChild(nameInput);

        var typeLabel = document.createElement('label');
        typeLabel.className = 'otable-modal-label';
        typeLabel.textContent = 'Type';
        modal.appendChild(typeLabel);
        var typeSelect = document.createElement('select');
        typeSelect.className = 'otable-modal-select';
        var optText = document.createElement('option');
        optText.value = 'text'; optText.textContent = 'Text';
        var optMulti = document.createElement('option');
        optMulti.value = 'multiselect'; optMulti.textContent = 'Multiselect';
        typeSelect.appendChild(optText);
        typeSelect.appendChild(optMulti);
        modal.appendChild(typeSelect);

        var btnRow = document.createElement('div');
        btnRow.className = 'otable-modal-buttons';
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'otable-modal-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { closeModal(overlay); });
        var okBtn = document.createElement('button');
        okBtn.className = 'otable-modal-ok';
        okBtn.textContent = 'Add';
        okBtn.addEventListener('click', function () {
            var nameVal = (nameInput.value || '').trim() || (typeSelect.value === 'text' ? 'Text' : 'Tags');
            addColumn(typeSelect.value, nameVal);
            closeModal(overlay);
        });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        modal.appendChild(btnRow);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        nameInput.focus();

        nameInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { closeModal(overlay); }
            else if (e.key === 'Enter') { okBtn.click(); }
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) { closeModal(overlay); }
        });
    }

    function closeModal(overlay) {
        if (overlay && overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
    }

    // ── TASK-B5: column header context menu ──

    function openColumnHeaderMenu(col, x, y) {
        var existing = document.querySelector('.otable-context-menu');
        if (existing) { existing.parentNode.removeChild(existing); }

        var menu = document.createElement('div');
        menu.className = 'otable-context-menu';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        var deleteItem = document.createElement('div');
        deleteItem.className = 'otable-context-menu-item';
        deleteItem.textContent = 'Delete column';
        deleteItem.dataset.colId = col.id;
        if (col.type === 'outliner') {
            deleteItem.classList.add('disabled');
            deleteItem.dataset.disabled = 'true';
            deleteItem.title = 'Outliner column cannot be deleted';
        } else {
            deleteItem.addEventListener('click', function () {
                removeMenu();
                openConfirmRemoveColumnModal(col);
            });
        }
        menu.appendChild(deleteItem);

        document.body.appendChild(menu);

        function removeMenu() {
            if (menu.parentNode) { menu.parentNode.removeChild(menu); }
            document.removeEventListener('click', outsideClick, true);
        }
        function outsideClick(e) {
            if (!menu.contains(e.target)) { removeMenu(); }
        }
        setTimeout(function () {
            document.addEventListener('click', outsideClick, true);
        }, 0);
    }

    function openConfirmRemoveColumnModal(col) {
        var existing = document.querySelector('.otable-modal-overlay');
        if (existing) { existing.parentNode.removeChild(existing); }
        var overlay = document.createElement('div');
        overlay.className = 'otable-modal-overlay otable-remove-column-modal';
        var modal = document.createElement('div');
        modal.className = 'otable-modal';

        var title = document.createElement('div');
        title.className = 'otable-modal-title';
        title.textContent = 'Delete column?';
        modal.appendChild(title);

        var msg = document.createElement('div');
        msg.className = 'otable-modal-message';
        msg.textContent = 'Are you sure you want to delete column "' + (col.name || col.id) + '"? All values in this column will be removed.';
        modal.appendChild(msg);

        var btnRow = document.createElement('div');
        btnRow.className = 'otable-modal-buttons';
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'otable-modal-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { closeModal(overlay); });
        var okBtn = document.createElement('button');
        okBtn.className = 'otable-modal-ok';
        okBtn.textContent = 'Delete';
        okBtn.addEventListener('click', function () {
            removeColumn(col.id);
            closeModal(overlay);
        });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        modal.appendChild(btnRow);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        cancelBtn.focus();

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) { closeModal(overlay); }
        });
    }

    /**
     * Build a single row DOM element with all cells for a node.
     * Used by both initial render and TASK-B4 row recycling.
     */
    function buildRow(nodeId) {
        var node = model.getNode(nodeId);
        if (!node) { return null; }
        var row = document.createElement('div');
        row.className = 'otable-row';
        row.dataset.nodeId = nodeId;
        for (var k = 0; k < columns.length; k++) {
            var col = columns[k];
            var cell = document.createElement('div');
            cell.className = 'otable-cell otable-cell-' + col.type;
            cell.dataset.colId = col.id;
            cell.dataset.nodeId = nodeId;
            if (col.type === 'outliner') {
                renderOutlinerCell(cell, node);
            } else if (col.type === 'text') {
                renderTextCell(cell, node, col);
            } else if (col.type === 'multiselect') {
                renderMultiselectCellSkeleton(cell, node, col);
            }
            row.appendChild(cell);
        }
        // tag row col signature so we can detect schema-level cell mismatch
        row.dataset.colSig = _colSignature();
        return row;
    }

    /**
     * Update an existing row's cells in-place (preserving the row DOM element).
     * Outliner cell is fully re-rendered (collapse/children/depth change handling).
     * Text cell is re-rendered only if its value differs from current model state
     * (to preserve cursor when an unrelated row's structure changes).
     *
     * If `opts.preserveFocus` is true and the active focus is inside this row's
     * outliner-text or otable-text-content, the corresponding cell is not
     * clobbered (cursor preservation for live editing).
     */
    function updateRowInPlace(row, nodeId, opts) {
        opts = opts || {};
        var node = model.getNode(nodeId);
        if (!node) { return; }
        // schema mismatch (column count/order changed) → rebuild
        if (row.dataset.colSig !== _colSignature()) {
            var rebuilt = buildRow(nodeId);
            if (rebuilt) { row.parentNode.replaceChild(rebuilt, row); }
            return;
        }
        var cells = row.querySelectorAll('.otable-cell');
        for (var k = 0; k < columns.length && k < cells.length; k++) {
            var col = columns[k];
            var cell = cells[k];
            if (col.type === 'outliner') {
                var textInside = cell.querySelector('.outliner-text');
                if (opts.preserveFocus && textInside && document.activeElement === textInside) {
                    var bullet = cell.querySelector('.outliner-bullet');
                    if (bullet) { _updateBullet(bullet, node); }
                    continue;
                }
                renderOutlinerCell(cell, node);
            } else if (col.type === 'text') {
                var textEl = cell.querySelector('.otable-text-content');
                var currentValue = getTextCellValue(nodeId, col.id);
                if (textEl) {
                    if (opts.preserveFocus && document.activeElement === textEl) {
                        continue;
                    }
                    var lastValue = textEl.dataset.lastValue;
                    if (lastValue !== currentValue) {
                        textEl.innerHTML = OutlinerCell.renderInlineText(currentValue);
                        textEl.dataset.lastValue = currentValue;
                    }
                } else {
                    renderTextCell(cell, node, col);
                }
            } else if (col.type === 'multiselect') {
                renderMultiselectCellSkeleton(cell, node, col);
            }
        }
    }

    function _updateBullet(bullet, node) {
        bullet.dataset.nodeId = node.id;
        if (node.children && node.children.length > 0) {
            bullet.dataset.hasChildren = 'true';
            bullet.dataset.collapsed = node.collapsed ? 'true' : 'false';
        } else {
            bullet.removeAttribute('data-has-children');
            bullet.removeAttribute('data-collapsed');
        }
    }

    function _colSignature() {
        return columns.map(function (c) { return c.id + ':' + c.type; }).join('|');
    }

    /**
     * TASK-B4: row recycling — reconcile DOM rows with model.getFlattenedIds().
     * Existing rows are recycled by nodeId; new ones are built; obsolete ones
     * removed. Order is restored via insertAdjacentElement.
     */
    function syncRowsToVisibleIds(body, opts) {
        opts = opts || {};
        var rowsContainer = body.querySelector('.otable-rows');
        if (!rowsContainer) {
            rowsContainer = document.createElement('div');
            rowsContainer.className = 'otable-rows';
            body.appendChild(rowsContainer);
        }
        var visibleIds = model.getFlattenedIds(true);
        var existingRows = {};
        var rowEls = rowsContainer.querySelectorAll('.otable-row');
        for (var i = 0; i < rowEls.length; i++) {
            existingRows[rowEls[i].dataset.nodeId] = rowEls[i];
        }
        // 1. remove obsolete rows
        for (var id in existingRows) {
            if (Object.prototype.hasOwnProperty.call(existingRows, id) && visibleIds.indexOf(id) === -1) {
                existingRows[id].parentNode.removeChild(existingRows[id]);
            }
        }
        // 2. iterate visibleIds and ensure DOM order matches
        var prev = null;
        for (var j = 0; j < visibleIds.length; j++) {
            var nodeId = visibleIds[j];
            var row = existingRows[nodeId];
            if (!row) {
                row = buildRow(nodeId);
                if (!row) { continue; }
            } else {
                updateRowInPlace(row, nodeId, opts);
            }
            if (prev) {
                if (row.previousElementSibling !== prev) {
                    prev.insertAdjacentElement('afterend', row);
                }
            } else {
                if (rowsContainer.firstElementChild !== row) {
                    rowsContainer.insertBefore(row, rowsContainer.firstElementChild);
                }
            }
            prev = row;
        }
        return rowsContainer;
    }

    /**
     * Legacy `renderRows`: full rebuild — used only on first render.
     * Subsequent updates use `syncRowsToVisibleIds` (row recycling, TASK-B4).
     */
    function renderRows(body) {
        var existing = body.querySelector('.otable-rows');
        if (existing) { existing.parentNode.removeChild(existing); }
        var rowsContainer = document.createElement('div');
        rowsContainer.className = 'otable-rows';

        var visibleIds = model.getFlattenedIds(true);
        for (var j = 0; j < visibleIds.length; j++) {
            var row = buildRow(visibleIds[j]);
            if (row) { rowsContainer.appendChild(row); }
        }
        body.appendChild(rowsContainer);
        return rowsContainer;
    }

    /**
     * Outliner cell render — TASK-B2 本実装。
     *
     * cell DOM 構造:
     *   <div class="otable-cell otable-cell-outliner">
     *     <div class="outliner-bullet" data-collapsed="false">●</div>
     *     <div class="outliner-text" contenteditable>...</div>
     *     <div class="outliner-subtext">...</div>
     *     <div class="outliner-images">...</div>
     *   </div>
     */
    function renderOutlinerCell(cell, node) {
        cell.innerHTML = '';
        cell.dataset.depth = String(model.getDepth ? model.getDepth(node.id) : 0);

        // Bullet (collapse/expand toggle)
        var bullet = document.createElement('div');
        bullet.className = 'outliner-bullet';
        bullet.dataset.nodeId = node.id;
        if (node.children && node.children.length > 0) {
            bullet.dataset.hasChildren = 'true';
            bullet.dataset.collapsed = node.collapsed ? 'true' : 'false';
            if (node.collapsed) {
                var countEl = document.createElement('span');
                countEl.className = 'outliner-child-count';
                countEl.textContent = String(node.children.length);
                bullet.appendChild(countEl);
            }
        }
        bullet.textContent = bullet.textContent || '●';
        bullet.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (node.children && node.children.length > 0) {
                toggleCollapse(node.id);
            }
        });
        cell.appendChild(bullet);

        // Text element
        var textEl = document.createElement('div');
        textEl.className = 'outliner-text';
        textEl.contentEditable = 'true';
        textEl.spellcheck = false;
        textEl.dataset.nodeId = node.id;
        textEl.innerHTML = OutlinerCell.renderInlineText(node.text || '');

        attachOutlinerTextHandlers(textEl, node);

        cell.appendChild(textEl);

        // Subtext
        var subtextEl = document.createElement('div');
        subtextEl.className = 'outliner-subtext';
        subtextEl.dataset.nodeId = node.id;
        if (node.subtext) {
            subtextEl.classList.add('has-content');
            subtextEl.textContent = OutlinerCell.getSubtextPreview
                ? OutlinerCell.getSubtextPreview(node.subtext)
                : (node.subtext.split('\n')[0] || '');
        }
        attachSubtextHandlers(subtextEl, textEl, node);
        cell.appendChild(subtextEl);

        // Images
        var imagesEl = document.createElement('div');
        imagesEl.className = 'outliner-images';
        imagesEl.dataset.nodeId = node.id;
        if (node.images && node.images.length > 0) {
            try {
                OutlinerCell.renderNodeImages(imagesEl, node, _cellHost());
            } catch (err) {
                // standalone 環境で resolveImageSrc が失敗するケース等は無視
            }
        }
        cell.appendChild(imagesEl);

        // Drop target for files (drag & drop attach)
        attachCellDropHandlers(cell, node);
    }

    function attachOutlinerTextHandlers(textEl, node) {
        var nodeId = node.id;
        var isComposing = false;

        textEl.addEventListener('focus', function () {
            focusedNodeId = nodeId;
            var sourceText = node.text || '';
            var renderedOff = OutlinerCell.getCursorOffset
                ? OutlinerCell.getCursorOffset(textEl) : 0;
            textEl.innerHTML = OutlinerCell.renderEditingText(sourceText);
            if (renderedOff > 0 && OutlinerCell.renderedOffsetToSource && OutlinerCell.setCursorAtOffset) {
                var sourceOff = OutlinerCell.renderedOffsetToSource(sourceText, renderedOff);
                OutlinerCell.setCursorAtOffset(textEl, sourceOff);
            }
        });

        textEl.addEventListener('blur', function () {
            // commit and re-render in display mode
            var plain = OutlinerCell.getPlainText(textEl);
            model.updateText(nodeId, plain);
            textEl.innerHTML = OutlinerCell.renderInlineText(plain);
        });

        // Link click handling (when not focused)
        textEl.addEventListener('mousedown', function (e) {
            if (focusedNodeId !== nodeId && !e.shiftKey) {
                var a = e.target.closest ? e.target.closest('a') : null;
                if (a && a.getAttribute('href')) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (host && typeof host.openLink === 'function') {
                        host.openLink(a.getAttribute('href'));
                    }
                    return;
                }
            }
        });
        textEl.addEventListener('click', function (e) {
            var a = e.target.closest ? e.target.closest('a') : null;
            if (a) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        textEl.addEventListener('compositionstart', function () { isComposing = true; });
        textEl.addEventListener('compositionend', function () {
            isComposing = false;
            var plain = OutlinerCell.getPlainText(textEl);
            model.updateText(nodeId, plain);
            var off = OutlinerCell.getCursorOffset(textEl);
            textEl.innerHTML = OutlinerCell.renderEditingText(plain);
            OutlinerCell.setCursorAtOffset(textEl, off);
            scheduleSyncToHost();
        });

        textEl.addEventListener('input', function () {
            var plain = OutlinerCell.getPlainText(textEl);
            model.updateText(nodeId, plain);
            if (!isComposing) {
                var off = OutlinerCell.getCursorOffset(textEl);
                textEl.innerHTML = OutlinerCell.renderEditingText(plain);
                OutlinerCell.setCursorAtOffset(textEl, off);
            }
            saveSnapshotDebounced();
            scheduleSyncToHost();
        });

        textEl.addEventListener('paste', function (e) {
            handleNodePaste(e, nodeId, textEl);
        });

        textEl.addEventListener('keydown', function (e) {
            handleNodeKeydown(e, nodeId, textEl);
        });
    }

    /**
     * Open subtext in the Table editor's cell DOM (different selectors than outliner.js).
     * OutlinerCell.openSubtext is hard-coded to `.outliner-node[data-id="..."]` so we
     * implement the equivalent locally for `.otable-row[data-node-id="..."]`.
     */
    function openSubtextForCell(nodeId) {
        var cell = getOutlinerCellEl(nodeId);
        if (!cell) { return; }
        var subtextEl = cell.querySelector('.outliner-subtext');
        if (!subtextEl) { return; }
        var node = model.getNode(nodeId);
        if (!node) { return; }
        subtextEl.contentEditable = 'true';
        subtextEl.classList.add('is-editing');
        subtextEl.classList.add('has-content');
        subtextEl.textContent = node.subtext || '';
        subtextEl.focus();
        try {
            var range = document.createRange();
            var sel = window.getSelection();
            range.selectNodeContents(subtextEl);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (_) { /* ignore selection errors */ }
    }

    function attachSubtextHandlers(subtextEl, textEl, node) {
        var nodeId = node.id;

        subtextEl.addEventListener('focus', function () {
            subtextEl.classList.add('is-editing');
            subtextEl.classList.add('has-content');
            subtextEl.textContent = node.subtext || '';
        });

        subtextEl.addEventListener('blur', function () {
            var raw = OutlinerCell.getSubtextPlainText
                ? OutlinerCell.getSubtextPlainText(subtextEl)
                : (subtextEl.textContent || '');
            model.updateSubtext(nodeId, raw);
            subtextEl.classList.remove('is-editing');
            if (raw) {
                subtextEl.classList.add('has-content');
                subtextEl.textContent = OutlinerCell.getSubtextPreview
                    ? OutlinerCell.getSubtextPreview(raw)
                    : raw.split('\n')[0];
            } else {
                subtextEl.classList.remove('has-content');
                subtextEl.textContent = '';
            }
            scheduleSyncToHost();
        });

        subtextEl.addEventListener('input', function () {
            var raw = OutlinerCell.getSubtextPlainText
                ? OutlinerCell.getSubtextPlainText(subtextEl)
                : (subtextEl.textContent || '');
            model.updateSubtext(nodeId, raw);
            saveSnapshotDebounced();
            scheduleSyncToHost();
        });

        subtextEl.addEventListener('keydown', function (e) {
            OutlinerCell.handleSubtextKeydown({
                event: e,
                nodeId: nodeId,
                subtextEl: subtextEl,
                model: model,
                host: _cellHost()
            });
        });
    }

    function attachCellDropHandlers(cell, node) {
        cell.addEventListener('dragover', function (e) {
            // file drop only (image and other files attach to node)
            if (e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });
        cell.addEventListener('drop', function (e) {
            if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            var files = e.dataTransfer.files;
            // Convert files to a serializable shape and forward to host.attachFile
            var fileInfos = [];
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                fileInfos.push({
                    name: f.name,
                    type: f.type || '',
                    size: f.size || 0,
                    path: f.path || '' // not all environments have path
                });
            }
            if (host && typeof host.attachFile === 'function') {
                host.attachFile({ nodeId: node.id, files: fileInfos });
            }
        });
    }

    /**
     * Text cell — TASK-B3 本実装。
     *
     * cell DOM 構造:
     *   <div class="otable-cell otable-cell-text">
     *     <div class="otable-text-content" contenteditable>...</div>
     *   </div>
     *
     * 値は `node.columnValues[col.id]` (string)。
     * - blur 時に `OutlinerCell.renderInlineText` で render (太字 / 斜体 / 取消 / link / tag)
     * - focus 時に `OutlinerCell.renderEditingText` で raw text 表示 (markdown syntax 見える)
     * - cmd+B/I/E/Shift+S は applyInlineFormat に **mock model** を inject して、
     *   `model.getNode` を `{text: columnValue}` 風に返し、`model.updateText` で
     *   columnValues[colId] を書き換える redirect adapter を渡す
     * - URL paste は `convertUrlsToMarkdownLinks` で auto convert
     */
    function renderTextCell(cell, node, col) {
        cell.innerHTML = '';
        var nodeId = node.id;
        var colId = col.id;
        var rawValue = '';
        if (node.columnValues && typeof node.columnValues === 'object') {
            var v = node.columnValues[colId];
            if (typeof v === 'string') { rawValue = v; }
        }
        var textEl = document.createElement('div');
        textEl.className = 'otable-text-content';
        textEl.contentEditable = 'true';
        textEl.spellcheck = false;
        textEl.dataset.colId = colId;
        textEl.dataset.nodeId = nodeId;
        textEl.innerHTML = OutlinerCell.renderInlineText(rawValue);

        attachTextCellHandlers(textEl, nodeId, colId);
        cell.appendChild(textEl);
    }

    function getTextCellValue(nodeId, colId) {
        var node = model.getNode(nodeId);
        if (!node) { return ''; }
        if (!node.columnValues || typeof node.columnValues !== 'object') { return ''; }
        var v = node.columnValues[colId];
        return (typeof v === 'string') ? v : '';
    }

    function setTextCellValue(nodeId, colId, value) {
        var node = model.getNode(nodeId);
        if (!node) { return; }
        if (!node.columnValues || typeof node.columnValues !== 'object') {
            node.columnValues = {};
        }
        node.columnValues[colId] = value;
    }

    /**
     * Mock model adapter for text cells: forwards getNode→{text:value} and
     * updateText→writes columnValues[colId] back. Allows reuse of
     * OutlinerCell.applyInlineFormat (which assumes node-text editing).
     */
    function _textCellModelAdapter(nodeId, colId) {
        return {
            getNode: function (id) {
                if (id !== nodeId) { return null; }
                return { id: id, text: getTextCellValue(nodeId, colId) };
            },
            updateText: function (id, text) {
                if (id !== nodeId) { return; }
                setTextCellValue(nodeId, colId, text);
            }
        };
    }

    function attachTextCellHandlers(textEl, nodeId, colId) {
        var isComposing = false;

        textEl.addEventListener('focus', function () {
            focusedNodeId = nodeId;
            var sourceText = getTextCellValue(nodeId, colId);
            var renderedOff = OutlinerCell.getCursorOffset
                ? OutlinerCell.getCursorOffset(textEl) : 0;
            textEl.innerHTML = OutlinerCell.renderEditingText(sourceText);
            if (renderedOff > 0 && OutlinerCell.renderedOffsetToSource && OutlinerCell.setCursorAtOffset) {
                var sourceOff = OutlinerCell.renderedOffsetToSource(sourceText, renderedOff);
                OutlinerCell.setCursorAtOffset(textEl, sourceOff);
            }
        });

        textEl.addEventListener('blur', function () {
            var raw = OutlinerCell.getPlainText(textEl);
            // URL auto-conversion (paste 等で素 URL が入った場合のセーフティネット)
            if (OutlinerCell.convertUrlsToMarkdownLinks) {
                raw = OutlinerCell.convertUrlsToMarkdownLinks(raw);
            }
            setTextCellValue(nodeId, colId, raw);
            textEl.innerHTML = OutlinerCell.renderInlineText(raw);
            saveSnapshot();
            scheduleSyncToHost();
        });

        textEl.addEventListener('compositionstart', function () { isComposing = true; });
        textEl.addEventListener('compositionend', function () {
            isComposing = false;
            var plain = OutlinerCell.getPlainText(textEl);
            setTextCellValue(nodeId, colId, plain);
            var off = OutlinerCell.getCursorOffset(textEl);
            textEl.innerHTML = OutlinerCell.renderEditingText(plain);
            OutlinerCell.setCursorAtOffset(textEl, off);
            scheduleSyncToHost();
        });

        textEl.addEventListener('input', function () {
            var plain = OutlinerCell.getPlainText(textEl);
            setTextCellValue(nodeId, colId, plain);
            if (!isComposing) {
                var off = OutlinerCell.getCursorOffset(textEl);
                textEl.innerHTML = OutlinerCell.renderEditingText(plain);
                OutlinerCell.setCursorAtOffset(textEl, off);
            }
            saveSnapshotDebounced();
            scheduleSyncToHost();
        });

        textEl.addEventListener('paste', function (e) {
            // URL paste: convert to [url](url) on paste (TC-703)
            if (e.clipboardData) {
                var t = e.clipboardData.getData('text/plain') || '';
                var trimmed = t.trim();
                if (/^https?:\/\//i.test(trimmed) && OutlinerCell.convertUrlsToMarkdownLinks) {
                    e.preventDefault();
                    var converted = OutlinerCell.convertUrlsToMarkdownLinks(trimmed);
                    var sel = window.getSelection();
                    if (sel && sel.rangeCount > 0) {
                        sel.getRangeAt(0).deleteContents();
                        document.execCommand('insertText', false, converted);
                    } else {
                        document.execCommand('insertText', false, converted);
                    }
                    var raw = OutlinerCell.getPlainText(textEl);
                    setTextCellValue(nodeId, colId, raw);
                    var off = OutlinerCell.getCursorOffset(textEl);
                    textEl.innerHTML = OutlinerCell.renderEditingText(raw);
                    OutlinerCell.setCursorAtOffset(textEl, off);
                    saveSnapshotDebounced();
                    scheduleSyncToHost();
                    return;
                }
            }
        });

        textEl.addEventListener('keydown', function (e) {
            if (e.isComposing || e.keyCode === 229) { return; }
            var modKey = (e.metaKey || e.ctrlKey);

            // cmd+z / shift+z (undo / redo) — re-use Table's undo stack
            if (modKey && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                var pending = OutlinerCell.getPlainText(textEl);
                setTextCellValue(nodeId, colId, pending);
                saveSnapshot();
                if (e.shiftKey) { redo(); } else { undo(); }
                return;
            }

            if (modKey && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
                e.preventDefault();
                saveSnapshot();
                OutlinerCell.applyInlineFormat({
                    nodeId: nodeId, textEl: textEl, marker: '**',
                    model: _textCellModelAdapter(nodeId, colId), host: _cellHost()
                });
                return;
            }
            if (modKey && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
                e.preventDefault();
                saveSnapshot();
                OutlinerCell.applyInlineFormat({
                    nodeId: nodeId, textEl: textEl, marker: '*',
                    model: _textCellModelAdapter(nodeId, colId), host: _cellHost()
                });
                return;
            }
            if (modKey && !e.shiftKey && (e.key === 'e' || e.key === 'E')) {
                e.preventDefault();
                saveSnapshot();
                OutlinerCell.applyInlineFormat({
                    nodeId: nodeId, textEl: textEl, marker: '`',
                    model: _textCellModelAdapter(nodeId, colId), host: _cellHost()
                });
                return;
            }
            if (modKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                saveSnapshot();
                OutlinerCell.applyInlineFormat({
                    nodeId: nodeId, textEl: textEl, marker: '~~',
                    model: _textCellModelAdapter(nodeId, colId), host: _cellHost()
                });
                return;
            }
        });
    }

    /** Multiselect cell skeleton (TASK-C1 で本実装) */
    function renderMultiselectCellSkeleton(cell, node, col) {
        cell.textContent = '';
    }

    /**
     * Render entry. If rows already exist, use TASK-B4 row recycling.
     * Otherwise full build.
     *
     * opts.preserveFocus: if true, skip clobbering the currently focused
     *   outliner-text or otable-text-content (cursor preservation).
     */
    function renderTable(opts) {
        if (!rootEl) { return; }
        var body = ensureBodyEl();
        if (!body) { return; }
        renderColumnHeaders(body);
        var existingRows = body.querySelector('.otable-rows');
        if (existingRows && existingRows.children.length > 0) {
            syncRowsToVisibleIds(body, opts);
        } else {
            renderRows(body);
        }
    }

    // --- collapse / expand ---

    function toggleCollapse(nodeId) {
        var node = model.getNode(nodeId);
        if (!node || !node.children || node.children.length === 0) { return; }
        node.collapsed = !node.collapsed;
        renderTable();
        scheduleSyncToHost();
    }

    // --- key handling (cell -> tree-wide actions) ---

    function handleNodeKeydown(e, nodeId, textEl) {
        if (e.isComposing || e.keyCode === 229) { return; }

        var node = model.getNode(nodeId);
        if (!node) { return; }

        var offset = OutlinerCell.getCursorOffset(textEl);
        var textLen = (textEl.textContent || '').length;
        var isAtStart = (offset === 0);

        var modKey = (e.metaKey || e.ctrlKey);

        // cmd+z / cmd+shift+z (undo / redo)
        if (modKey && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            // commit any pending input first
            var pending = OutlinerCell.getPlainText(textEl);
            model.updateText(nodeId, pending);
            // ensure baseline is captured
            saveSnapshot();
            if (e.shiftKey) {
                redo();
            } else {
                undo();
            }
            return;
        }

        // cmd+B / cmd+I / cmd+E / cmd+Shift+S
        if (modKey && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
            e.preventDefault();
            saveSnapshot();
            OutlinerCell.applyInlineFormat({
                nodeId: nodeId, textEl: textEl, marker: '**',
                model: model, host: _cellHost()
            });
            return;
        }
        if (modKey && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
            e.preventDefault();
            saveSnapshot();
            OutlinerCell.applyInlineFormat({
                nodeId: nodeId, textEl: textEl, marker: '*',
                model: model, host: _cellHost()
            });
            return;
        }
        if (modKey && !e.shiftKey && (e.key === 'e' || e.key === 'E')) {
            e.preventDefault();
            saveSnapshot();
            OutlinerCell.applyInlineFormat({
                nodeId: nodeId, textEl: textEl, marker: '`',
                model: model, host: _cellHost()
            });
            return;
        }
        if (modKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            saveSnapshot();
            OutlinerCell.applyInlineFormat({
                nodeId: nodeId, textEl: textEl, marker: '~~',
                model: model, host: _cellHost()
            });
            return;
        }

        // cmd+Shift+C — copy page path
        if (modKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
            if (node.isPage && node.pageId) {
                e.preventDefault();
                if (host && typeof host.copyPagePaths === 'function') {
                    host.copyPagePaths([node.pageId]);
                } else if (host && typeof host.copyPagePath === 'function') {
                    host.copyPagePath(node.pageId);
                }
                return;
            }
        }

        // cmd+x / cmd+c / cmd+v
        if (modKey && !e.shiftKey && (e.key === 'x' || e.key === 'X')) {
            handleCmdCut(e, nodeId, textEl);
            return;
        }
        if (modKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
            handleCmdCopy(e, nodeId, textEl);
            return;
        }
        if (modKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
            handleCmdPaste(e, nodeId, textEl);
            return;
        }

        switch (e.key) {
            case 'Enter':
                if (modKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (node.isPage && node.pageId) {
                        if (host && typeof host.openMdPage === 'function') {
                            host.openMdPage({ nodeId: nodeId, pageId: node.pageId });
                        }
                    } else if (node.filePath) {
                        if (host && typeof host.openAttachedFile === 'function') {
                            host.openAttachedFile(nodeId);
                        }
                    }
                    return;
                }
                e.preventDefault();
                saveSnapshot();
                if (e.shiftKey) {
                    openSubtextForCell(nodeId);
                } else if (e.altKey) {
                    handleAltEnter(node, textEl, offset);
                } else {
                    handleEnter(node, textEl, offset);
                }
                break;

            case 'Backspace': {
                var sel = window.getSelection();
                var hasSelection = sel && !sel.isCollapsed;
                if (hasSelection) {
                    saveSnapshot();
                    break;
                }
                if (isAtStart) {
                    e.preventDefault();
                    saveSnapshot();
                    handleBackspaceAtStart(node, textEl);
                }
                break;
            }

            case 'Tab':
                e.preventDefault();
                saveSnapshot();
                if (e.shiftKey) {
                    handleShiftTab(node, textEl);
                } else {
                    handleTab(node, textEl);
                }
                break;

            case 'ArrowUp':
                if (modKey && e.shiftKey) {
                    e.preventDefault();
                    saveSnapshot();
                    if (model.moveUp(nodeId)) {
                        renderTable();
                        focusOutlinerCell(nodeId);
                        scheduleSyncToHost();
                    }
                } else if (!e.shiftKey) {
                    var prev = model.getPreviousVisibleId(nodeId);
                    if (prev) {
                        e.preventDefault();
                        focusOutlinerCell(prev);
                    }
                }
                break;

            case 'ArrowDown':
                if (modKey && e.shiftKey) {
                    e.preventDefault();
                    saveSnapshot();
                    if (model.moveDown(nodeId)) {
                        renderTable();
                        focusOutlinerCell(nodeId);
                        scheduleSyncToHost();
                    }
                } else if (!e.shiftKey) {
                    var next = model.getNextVisibleId(nodeId);
                    if (next) {
                        e.preventDefault();
                        focusOutlinerCell(next);
                    }
                }
                break;
        }
    }

    function handleEnter(node, textEl, offset) {
        var text = node.text || '';
        var beforeText = text.slice(0, offset);
        var afterText = text.slice(offset);

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
            model.updateText(node.id, beforeText);
            newNode = model.addNode(node.parentId, node.id, afterText);
            // 展開された子は新兄弟へ移す
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

        renderTable();
        focusOutlinerCellAtStart(newNode.id);
        scheduleSyncToHost();
    }

    function handleAltEnter(node, textEl, offset) {
        var text = node.text || '';
        var beforeText = text.slice(0, offset);
        var afterText = text.slice(offset);
        model.updateText(node.id, beforeText);
        var newNode = model.addNodeAtStart(node.id, afterText);
        if (node.collapsed) { node.collapsed = false; }
        renderTable();
        focusOutlinerCellAtStart(newNode.id);
        scheduleSyncToHost();
    }

    function handleBackspaceAtStart(node, textEl) {
        var prevId = model.getPreviousVisibleId(node.id);
        if (!prevId) {
            if ((node.text || '').length === 0 && model.rootIds.length > 1) {
                var nextId = model.getNextVisibleId(node.id);
                model.removeNode(node.id);
                renderTable();
                if (nextId) { focusOutlinerCellAtStart(nextId); }
                scheduleSyncToHost();
            }
            return;
        }
        var prevNode = model.getNode(prevId);
        if (!prevNode) { return; }

        if ((node.text || '').length === 0 && (!node.children || node.children.length === 0)) {
            // 空 + 子なし: 単純削除
            model.removeNode(node.id);
            renderTable();
            focusOutlinerCell(prevId);
            scheduleSyncToHost();
        } else if ((node.text || '').length === 0 && node.children && node.children.length > 0) {
            // 空 + 子あり: 子を親レベルに昇格
            var emptyParentId = node.parentId;
            var parentSiblings = emptyParentId ? model.getNode(emptyParentId).children : model.rootIds;
            var emptyIndex = parentSiblings.indexOf(node.id);
            var promotedIds = node.children.slice();
            node.children = [];
            parentSiblings.splice(emptyIndex, 1);
            delete model.nodes[node.id];
            for (var ci = 0; ci < promotedIds.length; ci++) {
                var promotedNode = model.nodes[promotedIds[ci]];
                if (promotedNode) {
                    promotedNode.parentId = emptyParentId;
                    parentSiblings.splice(emptyIndex + ci, 0, promotedIds[ci]);
                }
            }
            renderTable();
            focusOutlinerCell(prevId);
            scheduleSyncToHost();
        } else {
            // テキスト合流
            var prevText = prevNode.text || '';
            var curText = node.text || '';
            var cursorPos = prevText.length;
            model.updateText(prevId, prevText + curText);
            if (node.children && node.children.length > 0) {
                for (var i = 0; i < node.children.length; i++) {
                    var childId = node.children[i];
                    model.nodes[childId].parentId = prevId;
                    prevNode.children.push(childId);
                }
            }
            model.removeNode(node.id);
            renderTable();
            var newTextEl = getOutlinerTextEl(prevId);
            if (newTextEl) {
                newTextEl.focus();
                if (OutlinerCell.setCursorAtOffset) {
                    OutlinerCell.setCursorAtOffset(newTextEl, cursorPos);
                }
            }
            scheduleSyncToHost();
        }
    }

    function handleTab(node, textEl) {
        if (model.indentNode(node.id)) {
            var off = OutlinerCell.getCursorOffset(textEl);
            renderTable();
            var newTextEl = getOutlinerTextEl(node.id);
            if (newTextEl) {
                newTextEl.focus();
                if (OutlinerCell.setCursorAtOffset) {
                    OutlinerCell.setCursorAtOffset(newTextEl, off);
                }
            }
            scheduleSyncToHost();
        }
    }

    function handleShiftTab(node, textEl) {
        if (model.outdentNode(node.id)) {
            var off = OutlinerCell.getCursorOffset(textEl);
            renderTable();
            var newTextEl = getOutlinerTextEl(node.id);
            if (newTextEl) {
                newTextEl.focus();
                if (OutlinerCell.setCursorAtOffset) {
                    OutlinerCell.setCursorAtOffset(newTextEl, off);
                }
            }
            scheduleSyncToHost();
        }
    }

    // --- clipboard (cmd+x / cmd+c / cmd+v) ---
    // 単一ノードのみサポート (multi-select は tree wide selection 機能が無いため、
    // current focused node のみ対象)。drawio.svg multi-extension suffix は host 側
    // copy logic (host.attachFile / host.copyImagesCross) に委ねる (本 sprint では
    // 実 fs を使う TC-610-A/611-A/612-A は手動 US で検証する設計)。

    var _internalClipboard = null; // { isCut, nodes: [{id, text, level, isPage, pageId, images, filePath, subtext, columnValues}] }

    function _serializeNodeSubtree(nodeId, baseLevel) {
        // 単一ノード+子孫を flatten して clipboard 形式に変換
        var arr = [];
        function visit(id, level) {
            var n = model.getNode(id);
            if (!n) { return; }
            arr.push({
                id: n.id,
                text: n.text || '',
                level: level,
                isPage: !!n.isPage,
                pageId: n.pageId || null,
                images: (n.images || []).slice(),
                filePath: n.filePath || null,
                subtext: n.subtext || '',
                tags: (n.tags || []).slice(),
                checked: (typeof n.checked !== 'undefined') ? n.checked : null,
                columnValues: n.columnValues ? Object.assign({}, n.columnValues) : undefined
            });
            if (n.children && n.children.length > 0 && !n.collapsed) {
                for (var i = 0; i < n.children.length; i++) {
                    visit(n.children[i], level + 1);
                }
            }
        }
        visit(nodeId, baseLevel);
        return arr;
    }

    function handleCmdCopy(e, nodeId, textEl) {
        // text selection コピー → ブラウザのデフォルト挙動を許可
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed && textEl.contains(sel.anchorNode)) {
            return; // browser default copies text
        }
        e.preventDefault();
        var node = model.getNode(nodeId);
        if (!node) { return; }
        var nodes = _serializeNodeSubtree(nodeId, 0);
        var plainText = nodes.map(function (nd) {
            var indent = '';
            for (var i = 0; i < nd.level; i++) { indent += '  '; }
            return indent + '- ' + nd.text;
        }).join('\n');
        _internalClipboard = { isCut: false, nodes: nodes, plainText: plainText };
        if (host && typeof host.saveOutlinerClipboard === 'function') {
            host.saveOutlinerClipboard({ isCut: false, nodes: nodes, plainText: plainText });
        }
    }

    function handleCmdCut(e, nodeId, textEl) {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed && textEl.contains(sel.anchorNode)) {
            return; // browser default cuts text
        }
        e.preventDefault();
        var node = model.getNode(nodeId);
        if (!node) { return; }
        var nodes = _serializeNodeSubtree(nodeId, 0);
        var plainText = nodes.map(function (nd) {
            var indent = '';
            for (var i = 0; i < nd.level; i++) { indent += '  '; }
            return indent + '- ' + nd.text;
        }).join('\n');
        _internalClipboard = { isCut: true, nodes: nodes, plainText: plainText };
        if (host && typeof host.saveOutlinerClipboard === 'function') {
            host.saveOutlinerClipboard({ isCut: true, nodes: nodes, plainText: plainText });
        }
        // delete the source row
        saveSnapshot();
        var nextId = model.getNextVisibleId(nodeId) || model.getPreviousVisibleId(nodeId);
        model.removeNode(nodeId);
        renderTable();
        if (nextId) { focusOutlinerCell(nextId); }
        scheduleSyncToHost();
    }

    function handleCmdPaste(e, nodeId, textEl) {
        // If there is internal clipboard from the same session, paste node-wise.
        // Otherwise, allow browser default text paste.
        if (!_internalClipboard || !_internalClipboard.nodes || _internalClipboard.nodes.length === 0) {
            return;
        }
        e.preventDefault();
        saveSnapshot();
        var clip = _internalClipboard;
        // Insert as siblings after current node (level offset = current node's level)
        var anchorNode = model.getNode(nodeId);
        if (!anchorNode) { return; }
        var levelStack = []; // [{level, parentId, lastInsertedId}]
        var anchorParentId = anchorNode.parentId;
        var afterId = nodeId;
        var lastInsertedId = nodeId;
        levelStack[0] = { level: 0, parentId: anchorParentId, lastInsertedId: nodeId };
        var insertedIds = [];

        for (var i = 0; i < clip.nodes.length; i++) {
            var clipNode = clip.nodes[i];
            // find parent for this level
            var lvl = clipNode.level;
            // truncate levelStack
            while (levelStack.length > lvl + 1) { levelStack.pop(); }
            var parentInfo = levelStack[lvl] || levelStack[levelStack.length - 1];
            var parentForInsert = parentInfo.parentId;
            var afterForInsert = parentInfo.lastInsertedId;

            var newNd;
            if (lvl === 0) {
                newNd = model.addNode(parentForInsert, afterForInsert, clipNode.text || '');
            } else {
                // child of last inserted at lvl-1
                var pInfo = levelStack[lvl - 1];
                newNd = model.addNodeAtStart(pInfo.lastInsertedId, clipNode.text || '');
            }
            if (clipNode.isPage && clipNode.pageId) {
                newNd.isPage = true;
                newNd.pageId = clipNode.pageId;
            }
            if (clipNode.filePath) {
                newNd.filePath = clipNode.filePath;
            }
            if (clipNode.images && clipNode.images.length > 0) {
                newNd.images = clipNode.images.slice();
            }
            if (clipNode.subtext) { newNd.subtext = clipNode.subtext; }
            if (clipNode.checked !== null && typeof clipNode.checked !== 'undefined') { newNd.checked = clipNode.checked; }
            if (clipNode.columnValues) { newNd.columnValues = Object.assign({}, clipNode.columnValues); }

            // update levelStack at this level
            levelStack[lvl] = {
                level: lvl,
                parentId: (lvl === 0) ? parentForInsert : levelStack[lvl - 1].lastInsertedId,
                lastInsertedId: newNd.id
            };
            insertedIds.push(newNd.id);
            if (lvl === 0) { lastInsertedId = newNd.id; }
        }

        // notify host (cross-file paste needs host file copy logic)
        if (host && typeof host.handleClipboardPaste === 'function') {
            host.handleClipboardPaste({
                targetNodeId: nodeId,
                insertedIds: insertedIds,
                isCut: clip.isCut,
                nodes: clip.nodes
            });
        }

        renderTable();
        if (insertedIds.length > 0) {
            focusOutlinerCell(insertedIds[insertedIds.length - 1]);
        }
        scheduleSyncToHost();
    }

    function handleNodePaste(e, nodeId, textEl) {
        // image paste?
        if (e.clipboardData && e.clipboardData.items) {
            var items = e.clipboardData.items;
            var imageItem = null;
            for (var i = 0; i < items.length; i++) {
                if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
                    imageItem = items[i];
                    break;
                }
            }
            if (imageItem) {
                e.preventDefault();
                if (host && typeof host.imagePaste === 'function') {
                    var f = imageItem.getAsFile ? imageItem.getAsFile() : null;
                    host.imagePaste({
                        nodeId: nodeId,
                        type: imageItem.type,
                        name: f ? f.name : ('paste.' + imageItem.type.split('/')[1])
                    });
                }
                return;
            }
        }
        // default text paste — let browser handle, then run input handler
    }

    // --- internal state container (test 用に exported) ---
    var OutlinerTableState = {
        _hadOriginalColumns: false,
        _autoOutlinerInjected: false
    };

    // --- public API ---
    return {
        init: init,
        applyExternalUpdate: applyExternalUpdate,
        syncToHostImmediate: syncToHostImmediate,
        scheduleSyncToHost: scheduleSyncToHost,
        serialize: serialize,
        renderTable: renderTable,
        // exported for tests / future tasks
        _ensureColumnsValid: function () { return ensureColumnsValid(); },
        _captureRawDataExtras: captureRawDataExtras,
        _generateColumnId: generateColumnId,
        _generateOptionId: generateOptionId,
        _getColumns: function () { return columns.slice(); },
        _getRawDataExtras: function () { return Object.assign({}, rawDataExtras); },
        _getModel: function () { return model; },
        _getState: function () { return OutlinerTableState; },
        _setColumnsForTest: function (cols) { columns = cols.slice(); },
        _focusOutlinerCell: focusOutlinerCell,
        _undo: undo,
        _redo: redo,
        _saveSnapshot: saveSnapshot,
        _getInternalClipboard: function () { return _internalClipboard; },
        _setInternalClipboard: function (cb) { _internalClipboard = cb; },
        // TASK-B3 — text cell helpers
        _getTextCellValue: getTextCellValue,
        _setTextCellValue: setTextCellValue,
        _textCellModelAdapter: _textCellModelAdapter,
        // TASK-B4 — row recycling
        _syncRowsToVisibleIds: function () {
            if (!rootEl) { return null; }
            var body = rootEl.querySelector('.otable-body');
            if (!body) { return null; }
            return syncRowsToVisibleIds(body);
        },
        _buildRow: buildRow,
        // TASK-B5 — column management
        addColumn: addColumn,
        removeColumn: removeColumn,
        reorderColumns: reorderColumns,
        _openAddColumnModal: openAddColumnModal,
        _openColumnHeaderMenu: openColumnHeaderMenu,
        _openConfirmRemoveColumnModal: openConfirmRemoveColumnModal
    };
}));
