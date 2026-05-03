/**
 * OutlinerTable — Outliner Table Editor (Notion / Coda style table view)
 *
 * Phase B (TASK-B1) skeleton: load / save / column auto-completion / minimal row render.
 *
 * Subsequent tasks add:
 *   - TASK-B2: Outliner cell render & 操作互換 (rich text, indent, sibling, etc.)
 *   - TASK-B3: Text cell rich text
 *   - TASK-B4: Row recycling (collapse/indent 連動)
 *   - TASK-B5: Column add/remove/reorder UI
 *   - TASK-B6: Header search box
 *   - TASK-B7: Switch view button (Outliner ↔ Table)
 *   - TASK-B8: Undo / redo
 *   - TASK-B9: i18n
 *   - TASK-C*: Multiselect column (chips, dropdown)
 *
 * UMD pattern (mirrors outliner-cell.js): works as `window.OutlinerTable` in webview /
 * standalone HTML AND as `module.exports` in Node.js (for unit-level tests).
 *
 * design: design/system.md §4.3
 * testcases: TC-1101, TC-1102, TC-201, TC-202, TC-203, TC-204
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
     *
     * 注意: ここで「自動補完が起きたかどうか」を呼び出し側に通知するため、
     *      _autoOutlinerInjected フラグを返す。clean-by-default 制御に使う。
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
        // 安定 sort: a.order - b.order が等しい場合は元順序を維持 (Array.prototype.sort は不安定の可能性あり、
        // mapping を使って tie-breaker)
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
     * @param {Object} data - .out JSON (parsed)
     * @param {Object} hostBridge - postMessage 等の host bridge interface
     * @param {Element} [container] - root element (default: document.querySelector('.otable-root'))
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
        // 元データに columns があったか (clean-by-default 判定で使う)
        var hadOriginalColumns = Array.isArray(initialData.columns);
        var injected = ensureColumnsValid();
        // 「auto 補完しただけ」状態を後で識別するためフラグを保存
        OutlinerTableState._hadOriginalColumns = hadOriginalColumns;
        OutlinerTableState._autoOutlinerInjected = injected && !hadOriginalColumns;

        rawDataExtras = captureRawDataExtras(initialData);

        renderTable();
    }

    /**
     * 外部 (host file watcher) からの更新を反映。
     * シナリオ A/B/C (design/system.md §6.4) のいずれにも対応するため、
     *   - model 再構築
     *   - columns / rawDataExtras 再構築
     *   - render
     * を一括で行う。
     */
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

    /**
     * 現在の state を .out 形式 JSON にシリアライズ。
     * - model.serialize() を起点
     * - 既存 known fields (pageDir / fileDir / imageDir / pinnedTags / searchFocusMode 等) は
     *   initialData から merge (Phase B では Table editor 自身がこれらを編集しないため initialData の値を保持)
     * - columns は本 editor が直接管理。clean-by-default で
     *   元データに columns 無し AND 自動補完 outliner 列のみ → 書き出さない。
     * - rawDataExtras は最後に passthrough で merge (knownKeys と被るキーは上書きしない)
     */
    function serialize() {
        var data = model.serialize();

        // 既存 known fields の passthrough (Table editor は編集しない、initialData の値を維持)
        if (initialData.pageDir) { data.pageDir = initialData.pageDir; }
        if (initialData.fileDir) { data.fileDir = initialData.fileDir; }
        if (initialData.imageDir) { data.imageDir = initialData.imageDir; }
        if (Array.isArray(initialData.pinnedTags) && initialData.pinnedTags.length > 0) {
            data.pinnedTags = initialData.pinnedTags.slice();
        }
        if (initialData.searchFocusMode) { data.searchFocusMode = initialData.searchFocusMode; }
        if (initialData.sidePanelWidth) { data.sidePanelWidth = initialData.sidePanelWidth; }
        if (initialData.sidePanelOutlineWidth) { data.sidePanelOutlineWidth = initialData.sidePanelOutlineWidth; }

        // columns: clean-by-default
        // 元データに無く、自動補完された outliner 列のみなら書き出さない。
        // それ以外 (元データにあった OR ユーザーが明示的に列を増やした) は書き出す。
        var shouldEmitColumns = false;
        if (OutlinerTableState._hadOriginalColumns) {
            shouldEmitColumns = true;
        } else if (columns.length > 1) {
            // auto-injected outliner 列以外に列がある (Phase B5 以降の列追加)
            shouldEmitColumns = true;
        } else if (columns.length === 1 && !OutlinerTableState._autoOutlinerInjected) {
            // 元データに無い 1 列 (理論上のエッジケース)
            shouldEmitColumns = true;
        }
        if (shouldEmitColumns) {
            data.columns = columns.slice();
        }

        // rawDataExtras passthrough
        for (var rk in rawDataExtras) {
            if (Object.prototype.hasOwnProperty.call(rawDataExtras, rk) && !(rk in data)) {
                data[rk] = rawDataExtras[rk];
            }
        }
        return data;
    }

    function syncToHostImmediate() {
        if (!host || typeof host.syncData !== 'function') { return; }
        var data = serialize();
        host.syncData(JSON.stringify(data, null, 2));
    }

    // --- rendering (skeleton) ---

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
            headerRow.appendChild(th);
        }
        body.appendChild(headerRow);
        return headerRow;
    }

    function renderRows(body) {
        var existing = body.querySelector('.otable-rows');
        if (existing) { existing.parentNode.removeChild(existing); }
        var rowsContainer = document.createElement('div');
        rowsContainer.className = 'otable-rows';

        var visibleIds = model.getFlattenedIds(true);
        for (var j = 0; j < visibleIds.length; j++) {
            var nodeId = visibleIds[j];
            var node = model.getNode(nodeId);
            if (!node) { continue; }
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
                    renderOutlinerCellSkeleton(cell, node);
                } else if (col.type === 'text') {
                    renderTextCellSkeleton(cell, node, col);
                } else if (col.type === 'multiselect') {
                    renderMultiselectCellSkeleton(cell, node, col);
                }
                row.appendChild(cell);
            }
            rowsContainer.appendChild(row);
        }
        body.appendChild(rowsContainer);
        return rowsContainer;
    }

    /** Outliner cell skeleton (TASK-B2 で正式実装、ここでは text の安全 render のみ) */
    function renderOutlinerCellSkeleton(cell, node) {
        if (typeof OutlinerCell !== 'undefined' && OutlinerCell.renderInlineText) {
            // 既存 outliner-cell.js の renderInlineText (XSS 安全) を使う
            cell.innerHTML = OutlinerCell.renderInlineText(node.text || '');
        } else {
            // テスト環境フォールバック (textContent で安全)
            cell.textContent = node.text || '';
        }
    }

    /** Text cell skeleton (TASK-B3 で rich text + edit handler を追加) */
    function renderTextCellSkeleton(cell, node, col) {
        var raw = '';
        if (node.columnValues && typeof node.columnValues === 'object') {
            var v = node.columnValues[col.id];
            if (typeof v === 'string') { raw = v; }
        }
        if (typeof OutlinerCell !== 'undefined' && OutlinerCell.renderInlineText) {
            cell.innerHTML = OutlinerCell.renderInlineText(raw);
        } else {
            cell.textContent = raw;
        }
    }

    /** Multiselect cell skeleton (TASK-C1 で chip + dropdown を追加) */
    function renderMultiselectCellSkeleton(cell, node, col) {
        // Phase B1 では空表示 (chip render は TASK-C1 の責務)
        cell.textContent = '';
    }

    function renderTable() {
        if (!rootEl) { return; }
        var body = ensureBodyEl();
        if (!body) { return; }
        renderColumnHeaders(body);
        renderRows(body);
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
        _setColumnsForTest: function (cols) { columns = cols.slice(); }
    };
}));
