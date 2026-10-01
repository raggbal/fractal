/**
 * notes-folder-view.js — フォルダビュー本体（folder link のリンク先実フォルダのツリー表示）
 *
 * sprint 20260817-053313-notetree-local-folder-view / FR-FLV-11〜16（outliner.js / editor.js 非流用 —
 * NFR-FLV-07 実装分離。視覚は tokens.css 変数 + Outliner 風のインデントツリー）。
 *
 * - lazy per-expand: 初期表示はルート 1 階層のみ。展開時にその階層を bridge.folderViewList 要求（NFR-FLV-02）
 * - Search: 名前部分一致（host 走査・cap + truncated）。マッチ + 祖先のみの pruned tree 表示
 * - 契機リフレッシュ（ADRL-0074）: 表示時 / 展開時 / CRUD・D&D 直後（host が list 再送）/ Refresh ボタン
 * - webview は相対パス（relPath）のみ扱う（絶対パス不出 — ADRL-0071 / INV-4）
 *
 * マウントは folder-view-dispatcher.js（window.__folderView.open/destroy 契約）。
 */
(function () {
    'use strict';

    var container = null;
    var treeEl = null;
    var searchInput = null;
    var currentLinkId = null;
    var currentTitle = '';
    var childrenByRel = {};   // relPath('' = root) → entries[]（host 応答キャッシュ。リフレッシュで上書き）
    var hiddenToggleBtn = null; // FR-FLV-31 トグルボタン（listResult.showHidden で active 復元）
    var expanded = {};        // relPath → true
    var selectedRel = null;          // focus（キーボードの現在位置）。既存の全消費サイトはこの意味で使う
    // FR-MSEL-01/05（sprint 20260901-075849 / ADRL-0108）: 連続範囲選択。
    // selection = 選択集合 / anchorRel = 範囲の起点。selectedRel は focus として温存する
    // （既存 20 箇所の消費サイトはすべて「focus の 1 件」の意味なので破壊せずに済む）。
    var selection = [];              // relPath の配列（描画順に正規化して持つ）
    var anchorRel = null;
    var visibleRows = [];     // keyboard ナビ用の描画順 relPath 配列
    var searchQuery = '';
    var searchHits = null;    // 検索モード中の hits（null = 通常表示）
    var searchTruncated = false;
    var searchTimer = null;

    // ── D&D（TASK-09 / dnd-wiring.md） ──
    // 新 MIME 1 本（W1 送信 = W2/W4 送信と同一 dragstart）。payload に絶対パス不含（INV-4）
    var FV_ENTRY_MIME = 'application/x-fractal-folderview-entry';
    // W3 受信（tree md/file item — 既存 MIME 流用）/ W6 受信（md アンカー既存 2 MIME）
    var TREE_MD_MIME = 'application/x-fractal-tree-md';
    var TREE_FILE_MIME = 'application/x-fractal-tree-file';
    var MD_FILELINK_MIME = 'application/x-fractal-md-filelink';
    var MD_SUBPAGE_MIME = 'application/x-fractal-md-subpage';
    // one-shot drag state（set = dragstart / clear = drop 消費・dragend・window 安全網 — ADRL-0031 型）
    var fvDragSrc = null; // { relPath, isDir } | null

    // FR-FLV-26（再オープン①）: 開閉状態の debounce 保存
    var stateSaveTimer = null;
    // FR-FLV-28（再オープン①）: インライン rename の one-shot state（開始 = startRename / 終了 = 確定・Escape・blur）
    var renaming = null; // { relPath, inputEl, done, pendingRender } | null


    function i18n() { return window.__outlinerMessages || {}; }
    function bridge() { return window.notesHostBridge || window.outlinerHostBridge || {}; }

    function parentRelOf(rel) {
        return rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')) : '';
    }
    function baseNameOf(rel) {
        return rel.indexOf('/') >= 0 ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    }
    function depthOf(rel) {
        return rel === '' ? -1 : rel.split('/').length - 1;
    }

    function ensureStyle() {
        if (document.getElementById('folder-view-style')) { return; }
        var style = document.createElement('style');
        style.id = 'folder-view-style';
        // NFR-FLV-08（再オープン①）: 視覚は Outliner / md 面の既存トークンのみ（色・サイズの直書き禁止）。
        // 統一先の実測 = research-source.md 再調査 6（--outliner-bg / --fr-color-selection-bg /
        // --outliner-search-bg / bullet 三角 5px/4px / ツールバーボタン 4px 5px opacity .5）
        style.textContent = [
            '#folderViewContainer { overflow: hidden; background: var(--outliner-bg); color: var(--outliner-fg); }',
            '.fv-header { display:flex; align-items:center; gap:8px; padding:8px 12px;',
            '  border-bottom:1px solid var(--fr-color-border); flex:0 0 auto; }',
            '.fv-title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
            // Search box = .outliner-search-input と同一メトリクス・同一トークン
            // 幅 = outliner-search-input-wrapper と同一（225px 固定・focus で flex:1 に拡張・0.2s ease）
            '.fv-search { flex:0 0 auto; width:225px; min-width:60px; font-size:12px; padding:5px 9px;',
            '  border:1px solid transparent; border-radius:5px; transition: width 0.2s ease;',
            '  background: var(--outliner-search-bg); color: var(--outliner-fg); }',
            '.fv-search:focus { outline:none; border-color: var(--vscode-focusBorder); flex:1 1 auto; width:auto; }',
            // ボタン = outliner ツールバーボタンと同一
            '.fv-refresh { background:transparent; border:none; border-radius:4px; cursor:pointer;',
            '  color: var(--outliner-fg); padding:4px 5px; opacity:0.5; }',
            '.fv-refresh:hover { opacity:1; background: var(--outliner-hover-bg); }',
            '.fv-hidden-toggle { background:transparent; border:none; border-radius:4px; cursor:pointer; opacity:0.55; }',
            '.fv-hidden-toggle:hover { opacity:1; background: var(--outliner-hover-bg); }',
            '.fv-hidden-toggle.active { opacity:1; color: var(--vscode-textLink-foreground); }',
            '.fv-file-icon { cursor:pointer; }',
            '.fv-tree { flex:1 1 auto; overflow:auto; padding:6px 0; outline:none; }',
            '.fv-row { display:flex; align-items:center; gap:4px; padding:2px 8px; cursor:default;',
            '  line-height:20px; white-space:nowrap; }',
            // hover は背景色を変えない（= folder view 背景と同じ）— ユーザー裁定 2026-08-18
            //（白 = --outliner-hover-bg も水色 = selection トークンも却下。選択行のみ色が付く）
            '.fv-row:hover { background: var(--outliner-bg); }',
            // 2026-09-04 R16 rev2（ユーザー裁定）: linkedfd / note tree の複数選択は **青系 --fr-color-selection-bg**
            //（outliner の黄色系に一度揃えたが「ツリーで黄色はうざい」→ 青へ戻す。outliner は編集面で focus 行が青のため
            // 範囲選択は黄色のまま = 面の役割差として受容）。色の直書き fallback は NFR-FLV-08 = TC-FLV-57 ⑤ で禁止
            '.fv-row.fv-selected { background: var(--fr-color-selection-bg); }',
            // 開閉 = outliner bullet と同一（折りたたみ = CSS 三角 5px/4px・展開 = 5px dot。テキスト矢印廃止）
            // click 領域を拡大（18px + 行全高）し三角/dot を中心配置（クリック点ズレの再修正 2026-08-18）
            '.fv-chevron { width:18px; flex:0 0 18px; align-self:stretch; display:flex; align-items:center; justify-content:center; cursor:pointer; }',
            '.fv-chevron .fv-tri { width:0; height:0; border-top:4px solid transparent; border-bottom:4px solid transparent;',
            '  border-left:5px solid var(--outliner-fg); opacity:0.6; }',
            '.fv-chevron .fv-dot { width:5px; height:5px; border-radius:50%; background: var(--outliner-fg); opacity:0.5; }',
            '.fv-name { overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:4px; }',
            '.fv-file-icon { flex:0 0 auto; font-size:12px; line-height:1; }',
            '.fv-row.fv-dir > .fv-name { font-weight:500; }',
            '.fv-rename-input { font: inherit; color: var(--outliner-fg); background: var(--outliner-search-bg);',
            '  border:1px solid var(--vscode-focusBorder); border-radius:3px; padding:0 2px; min-width:80px; }',
            '.fv-note { padding:4px 12px; font-size:12px; opacity:0.65; }',
            '.fv-menu { position:fixed; z-index:1000; min-width:180px; padding:4px 0;',
            '  background: var(--fr-color-bg-elevated); border:1px solid var(--fr-color-border);',
            '  border-radius:6px; box-shadow: var(--fr-shadow-sm, none); }',
            '.fv-menu-item { padding:5px 14px; font-size:12.5px; cursor:pointer; }',
            '.fv-menu-item:hover { background: var(--outliner-hover-bg); }',
            '.fv-menu-item.danger { color: var(--fr-color-danger); }',
            // FR-SND-02 rev2: サブメニュー起点（▶ は ::after で描く）/ disabled 表示（click は通知のため生かす）
            '.fv-menu-item-submenu::after { content:"\\25B6"; float:right; margin-left:12px; opacity:0.6; font-size:10px; }',
            '.fv-menu-item.disabled { opacity:0.5; }',
            // D&D 視覚 2 系統（TASK-09 — highlight + root 強調。トークンのみ）
            '.fv-row.fv-drop-into { background: var(--fr-color-selection-bg); }',
            '.fv-tree.fv-drop-root { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    // ── open / destroy（dispatcher 契約） ──

    function open(folderLinkId, title, mount) {
        container = mount;
        currentLinkId = folderLinkId;
        currentTitle = title || 'Folder';
        childrenByRel = {};
        expanded = {};
        selectedRel = null;
        selection = [];
        anchorRel = null;
        visibleRows = [];
        searchQuery = '';
        searchHits = null;
        searchTruncated = false;
        ensureStyle();
        buildSkeleton();
        requestList('');
    }

    function destroy() {
        closeMenu();
        if (renaming) { renaming.done = true; renaming = null; }
        if (stateSaveTimer) { clearTimeout(stateSaveTimer); stateSaveTimer = null; }
        container = null;
        treeEl = null;
        searchInput = null;
        currentLinkId = null;
        childrenByRel = {};
        expanded = {};
        selectedRel = null;
        selection = [];
        anchorRel = null;
        visibleRows = [];
        searchHits = null;
    }

    function buildSkeleton() {
        container.textContent = '';
        var header = document.createElement('div');
        header.className = 'fv-header';
        var titleEl = document.createElement('span');
        titleEl.className = 'fv-title';
        titleEl.textContent = currentTitle;
        searchInput = document.createElement('input');
        searchInput.className = 'fv-search';
        searchInput.type = 'text';
        searchInput.placeholder = i18n().folderViewSearchPlaceholder || 'Filter by name...';
        searchInput.addEventListener('input', function () {
            if (searchTimer) { clearTimeout(searchTimer); }
            searchTimer = setTimeout(function () {
                var q = searchInput ? searchInput.value.trim() : '';
                searchQuery = q;
                if (!q) {
                    searchHits = null;
                    renderTree();
                    return;
                }
                if (bridge().folderViewSearch) { bridge().folderViewSearch(currentLinkId, q); }
            }, 250);
        });
        var refreshBtn = document.createElement('button');
        refreshBtn.className = 'fv-refresh';
        refreshBtn.title = i18n().folderViewRefresh || 'Refresh';
        // outliner ツールバーの他ボタンと同じ 13x13 lucide SVG（テキスト glyph は小さすぎた — 再修正 2026-08-18）
        refreshBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
        refreshBtn.addEventListener('click', function () { refresh(); });
        // FR-FLV-31: 隠しファイル表示トグル（状態は host sidecar が真実 — listResult.showHidden で復元）
        hiddenToggleBtn = document.createElement('button');
        hiddenToggleBtn.className = 'fv-hidden-toggle';
        hiddenToggleBtn.title = i18n().notesShowHiddenFiles || 'Show hidden files';
        hiddenToggleBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
        hiddenToggleBtn.addEventListener('click', function () {
            if (!bridge().folderViewToggleHidden) { return; }
            bridge().folderViewToggleHidden(currentLinkId);
            // TC-FLV-73（ユーザー報告）: filter が変わる = 全キャッシュを破棄して全面 reload（ON/OFF 両方向）。
            // host の toggle 応答は root のみなので、展開中 dir はここで再要求し、閉じ dir は
            // キャッシュ破棄で「次の展開時に新 filter で再要求」させる。postMessage は直列なので
            // toggle（sidecar 保存）→ 以下の list 要求の順で処理され、応答は全て新 filter になる
            childrenByRel = {};
            Object.keys(expanded).forEach(function (rel) {
                if (expanded[rel]) { requestList(rel); }
            });
            if (searchQuery && bridge().folderViewSearch) { bridge().folderViewSearch(currentLinkId, searchQuery); }
        });
        header.appendChild(titleEl);
        header.appendChild(searchInput);
        header.appendChild(refreshBtn);
        header.appendChild(hiddenToggleBtn);

        treeEl = document.createElement('div');
        treeEl.className = 'fv-tree';
        treeEl.tabIndex = 0;
        treeEl.addEventListener('keydown', onKeyDown);
        treeEl.addEventListener('contextmenu', function (e) {
            // 空白部 right-click = New 2 項目のみ
            if (e.target === treeEl) {
                e.preventDefault();
                showMenu(e, null);
            }
        });
        // D&D 受信端（W1/W3/W6 — 行・余白とも treeEl の 1 listener で受ける）
        treeEl.addEventListener('dragover', onTreeDragOver);
        treeEl.addEventListener('drop', onTreeDrop);
        treeEl.addEventListener('dragleave', function (e) {
            // treeEl の外へ出たときだけ掃除（行間の移動では明滅させない）
            var rt = e.relatedTarget;
            if (!rt || !treeEl.contains(rt)) { clearDropVisuals(); }
        });

        container.appendChild(header);
        container.appendChild(treeEl);
    }

    // ── host 通信 ──

    function requestList(relPath) {
        if (bridge().folderViewList) { bridge().folderViewList(currentLinkId, relPath); }
    }

    /** FR-FLV-13: Refresh ボタン — ルート + 展開済み階層を再取得（展開・選択・検索は保持） */
    function refresh() {
        requestList('');
        Object.keys(expanded).forEach(function (rel) {
            if (expanded[rel]) { requestList(rel); }
        });
        if (searchQuery && bridge().folderViewSearch) {
            bridge().folderViewSearch(currentLinkId, searchQuery);
        }
    }

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || !container || !currentLinkId || msg.folderLinkId !== currentLinkId) { return; }
        // FR-FVT-01 / DOM-TransferDoneSignal: host は移動・複製要求を処理し終えたら結末によらず 1 回これを送る。
        // 一覧再送（下の folderViewListResult）は no-op・失敗・件数ゲート拒否では来ないため、解除契機をこちらに持つ。
        if (msg.type === 'folderViewTransferDone') {
            fvEndTransfer();
            return;
        }
        if (msg.type === 'folderViewListResult') {
            fvEndTransfer();   // INV-11: 転送完了（host の一覧再送）でもフラグを解除する（二重解除は冪等）
            if (msg.error) {
                var errRel = msg.relPath || '';
                if (errRel === '') {
                    // root エラー = 全体表示（従来 — folderRoot 自体の問題）
                    renderNote(msg.error === 'broken'
                        ? (i18n().folderLinkBroken || 'Linked folder not found. Re-link it first.')
                        : (i18n().folderViewOpenFailed || 'Cannot read the folder.'));
                    return;
                }
                // FR-FLV-30（再オープン①）: 子 dir のエラーはツリー全体を壊さない — 該当ノードを畳んで
                // 局所掃除（開閉状態からも除去 = 次回 stateSave に反映）+ 親階層を再リスト
                delete expanded[errRel];
                delete childrenByRel[errRel];
                Object.keys(expanded).forEach(function (k) {
                    if (k === errRel || k.indexOf(errRel + '/') === 0) { delete expanded[k]; }
                });
                scheduleStateSave();
                requestList(parentRelOf(errRel));
                if (!searchHits) { renderTree(); }
                return;
            }
            childrenByRel[msg.relPath || ''] = msg.entries || [];
            // FR-FLV-31: host sidecar の showHidden をボタン表示に反映
            if (hiddenToggleBtn && typeof msg.showHidden === 'boolean') {
                hiddenToggleBtn.classList.toggle('active', msg.showHidden);
            }
            // FR-FLV-26: root 応答の savedExpanded を取り込み lazy 展開（現状 fs 優先は host 側でフィルタ済み）
            if ((msg.relPath || '') === '' && Array.isArray(msg.savedExpanded)) {
                msg.savedExpanded.forEach(function (rel) {
                    if (typeof rel === 'string' && rel !== '') {
                        expanded[rel] = true;
                        if (!childrenByRel[rel]) { requestList(rel); }
                    }
                });
            }
            if (renaming) { renaming.pendingRender = true; return; } // FR-FLV-28: rename 中は再描画を defer
            if (!searchHits) { renderTree(); }
        } else if (msg.type === 'folderViewSearchResult') {
            if (msg.query !== searchQuery) { return; } // stale 応答
            searchHits = msg.hits || [];
            searchTruncated = !!msg.truncated;
            renderTree();
        }
    });

    // ── 描画 ──

    function renderNote(text) {
        if (!treeEl) { return; }
        treeEl.textContent = '';
        var note = document.createElement('div');
        note.className = 'fv-note';
        note.textContent = text;
        treeEl.appendChild(note);
    }

    function makeRow(entry, depth) {
        var row = document.createElement('div');
        row.className = 'fv-row ' + (entry.isDir ? 'fv-dir' : 'fv-file')
            + (selection.indexOf(entry.relPath) >= 0 ? ' fv-selected' : '');
        row.dataset.rel = entry.relPath;
        row.dataset.isdir = entry.isDir ? '1' : '0';
        row.style.paddingLeft = (8 + depth * 16) + 'px';
        row.draggable = true;

        var chevron = document.createElement('span');
        chevron.className = 'fv-chevron';
        if (entry.isDir) {
            // NFR-FLV-08: outliner bullet と同一の開閉表現（展開 = 5px dot / 折りたたみ = CSS 三角）
            var mark = document.createElement('span');
            mark.className = expanded[entry.relPath] ? 'fv-dot' : 'fv-tri';
            chevron.appendChild(mark);
        }
        var name = document.createElement('span');
        name.className = 'fv-name';
        if (!entry.isDir) {
            // ユーザー指定（2026-08-18）: md = 📄 / それ以外 = 📎
            // + 2026-08-23: office/pdf/html は拡張子別 glyph（写像は MarkdownLinkParser.fileIconGlyph が単一真実）
            var iconSpan = document.createElement('span');
            iconSpan.className = 'fv-file-icon';
            iconSpan.textContent = /\.md$/i.test(entry.name) ? '📄'
                : ((typeof MarkdownLinkParser !== 'undefined' && MarkdownLinkParser.fileIconGlyph)
                    ? MarkdownLinkParser.fileIconGlyph(entry.name) : '📎');
            name.appendChild(iconSpan);
        }
        name.appendChild(document.createTextNode(entry.name));
        row.appendChild(chevron);
        row.appendChild(name);

        row.addEventListener('click', function (e) {
            // FR-MSEL-01 rev2（2026-09-04 ユーザー裁定・ADRL-0111）: cmd/ctrl+click = 単品トグル（不連続選択）。
            // chevron / アイコンの副作用は付けない（選択操作だけ）。
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
                e.preventDefault();
                toggleRow(entry.relPath);
                return;
            }
            // FR-MSEL-01: shift+click = anchor..target の連続範囲。
            if (e.shiftKey) { selectRange(entry.relPath); } else { selectRow(entry.relPath); }
            // chevron click は展開トグルも行う（行 click 自体は選択のみ — FR-FLV-14）。
            // e.target === chevron だと子要素（.fv-tri/.fv-dot）を踏んだとき外れる — closest 判定に修正（2026-08-18）
            var onChevron = e.target && e.target.closest && e.target.closest('.fv-chevron');
            if (entry.isDir && onChevron) { toggleDir(entry.relPath); }
            // FR-FLV-32: ファイル行の 📄/📎 アイコン click = open（dblclick と同一経路。chevron と同型の closest 判定）
            var onIcon = e.target && e.target.closest && e.target.closest('.fv-file-icon');
            if (!entry.isDir && onIcon && bridge().folderViewOpen) {
                bridge().folderViewOpen(currentLinkId, entry.relPath);
            }
        });
        row.addEventListener('dblclick', function () {
            if (entry.isDir) {
                toggleDir(entry.relPath);
            } else if (bridge().folderViewOpen) {
                bridge().folderViewOpen(currentLinkId, entry.relPath);
            }
        });
        row.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            // FR-MSEL-01: 選択内の右クリックは選択を維持（outliner precedent と同型）。
            // 選択外ならその行のみに切り替える。
            if (selection.indexOf(entry.relPath) < 0) { selectRow(entry.relPath); }
            else { selectedRel = entry.relPath; }
            showMenu(e, entry);
        });
        // W1/W2/W4 送信端（dragstart 1 本 — MIME payload に絶対パス不含 = INV-4）。
        // エントリ行は contenteditable 外の独立 DOM なので draggable=true で足りる（dnd-wiring §1）
        row.addEventListener('dragstart', function (e) {
            if (!e.dataTransfer) { return; }
            // FR-MSEL-02/05 (§4-1/§4-2): **複数選択中に選択内の行を drag したときだけ**選択全体を運ぶ。
            //
            // ⚠️ 単一 drag（選択外の行 / 選択が 1 件）は **従来の payload をそのまま積む**。
            // フォルダ行も含めて不変にするのは、**fv 内のフォルダ移動が既存機能**だから
            // （ADRL-0102 / `onTreeDrop` の `fv.isDir` no-op ガードが受けている。本 sprint のスコープ外）。
            // FR-MSEL-05 の「フォルダは D&D 対象外」は **複数選択 payload** の話で、
            // note ツリーへ落ちたときの拒否は受け手（`dispatchFolderViewEntryDrop`）が担う。
            var inSelection = selection.indexOf(entry.relPath) >= 0;
            var multi = inSelection && selection.length > 1;
            var files = multi ? selectedFilesForDnd() : [];
            // dirCount は「選択に含まれるフォルダ数」。**除外件数ではない**（フォルダは payload に載る）。
            // 集計通知の内訳（フォルダ N 個）に使えるよう算出だけ残す。
            var dirCount = multi ? selectedDirCount() : 0;
            void dirCount;

            // FR-FDP-01（TASK-03）: フォルダも payload に載るので「フォルダだけ = 運ぶものが無い」は成立しない。
            // 旧実装はここで `preventDefault()` + 通知して **drag 自体を始めさせなかった**（US-001 の症状）。
            // 選択が空（= 何も選ばれていない）ときだけ従来どおり不発にする。
            if (multi && files.length === 0) {
                e.preventDefault();
                return;
            }
            try {
                var payload = multi
                    ? {
                        v: 1,
                        folderLinkId: currentLinkId,
                        items: files.map(function (rel) {
                            // FR-FDP-01: `isDir` は**実値**（旧実装は false のリテラル固定で、
                            // 面を越える A-2 / A-3 では payload が唯一の情報源なので致命的だった）
                            var ent = findEntry(rel);
                            return { folderLinkId: currentLinkId, relPath: rel, isDir: !!(ent && ent.isDir) };
                        }),
                        // 受け手が扱えない種別の除外件数。**フォルダはもう除外しないので 0**
                        // （key は後方互換のため残す。ここに dir 件数を入れると受け手が
                        //  偽の「N 件除外」通知を出す = TASK-14 で実測して修正）
                        excludedDirs: 0,
                    }
                    // 単一 = 従来形式（既存の受け手 TC を 1 本も壊さない = §4-1 後方互換）
                    : { folderLinkId: currentLinkId, relPath: entry.relPath, isDir: !!entry.isDir };
                e.dataTransfer.setData(FV_ENTRY_MIME, JSON.stringify(payload));
                e.dataTransfer.setData('text/plain', multi ? files.join('\n') : entry.relPath);
                // 🔴 NFR-NDA-02: これが無いと drop が silent 不発火になる
                e.dataTransfer.effectAllowed = 'copyMove';
            } catch (err) { /* ignore */ }
            // one-shot: 下記 clear 群と対。複数のときは代表 1 件 + 全件を持つ
            fvDragSrc = { relPath: entry.relPath, isDir: !!entry.isDir, relPaths: multi ? files : [entry.relPath] };
        });
        row.addEventListener('dragend', function () {
            fvDragSrc = null;
            clearDropVisuals();
        });
        return row;
    }

    // ── D&D 受信端（W1 ビュー内 / W3 tree item / W6 md アンカー）+ 視覚 2 系統 ──

    function clearDropVisuals() {
        if (!treeEl) { return; }
        // highlight（フォルダ行）と root 強調の 2 系統とも掃除（片肺禁止 — generator_failures 2026-08-02）
        Array.prototype.forEach.call(treeEl.querySelectorAll('.fv-row.fv-drop-into'), function (el) {
            el.classList.remove('fv-drop-into');
        });
        treeEl.classList.remove('fv-drop-root');
    }

    /** dragover で types から受理可否を判定（getData は drop まで読めない — research-external §5） */
    function isAcceptableDrag(e) {
        if (!e || !e.dataTransfer) { return false; }
        var types = Array.prototype.slice.call(e.dataTransfer.types || []);
        // 受理 3 群 + それ以外の内部 MIME（outliner node 系等）は drop で不受理通知するため
        // x-fractal- prefix でまとめて受ける（黙って弾くと「反応しない」に見える — 不受理の明示裁定）
        for (var i = 0; i < types.length; i++) {
            if (String(types[i]).indexOf('application/x-fractal-') === 0) { return true; }
        }
        // tree 内部 drag（.out/folder item は text/plain しか積まない）— one-shot グローバル
        //（notes-file-panel.js dragstart/dragend が set/clear。fr-drag-active はパネル外 dragleave で
        // 消えるため使えない — 実測 2026-08-17）
        if (window.__notesTreeDragKind) { return true; }
        // 外部 files / uri-list もスコープ外の明示通知対象
        if (types.indexOf('Files') !== -1 || types.indexOf('application/vnd.code.uri-list') !== -1) { return true; }
        return false;
    }

    /**
     * FR-DCP-04 (§1-4): dragover のカーソル（dropEffect）を **意味論と一致**させる。
     *
     * `dragover` では payload の**中身は読めない**（HTML5 protected mode）が `types` は読めるので、
     * MIME 種別だけで決まる。ADRL-0106 で note ツリー ⇄ fv の 2 方向が複製になったため、
     * `'move'` 固定のままだとカーソルが嘘をつく（元が消えるように見える）。
     *
     * | payload | dropEffect |
     * |---|---|
     * | `x-fractal-tree-file` / `x-fractal-tree-md`（note ツリー発 = 複製方向） | `'copy'` |
     * | `x-fractal-md-filelink` / `x-fractal-md-subpage`（md 発 = 移動方向） | `'move'` |
     * | `x-fractal-folderview-entry`（fv 内 = 移動） | `'move'` |
     * | 外部 `Files` | `'copy'` |
     */
    function resolveDropEffect(e) {
        if (!e || !e.dataTransfer) { return 'move'; }
        var types = Array.prototype.slice.call(e.dataTransfer.types || []);
        var has = function (t) { return types.indexOf(t) !== -1; };
        // note ツリー発 = 複製（FR-DCP-02）
        if (has('application/x-fractal-tree-md') || has('application/x-fractal-tree-file')) { return 'copy'; }
        // md 発 = 移動（FR-DCP-03 不変）
        if (has('application/x-fractal-md-filelink') || has('application/x-fractal-md-subpage')) { return 'move'; }
        // fv 内 = 移動（ADRL-0102 不変）
        if (has('application/x-fractal-folderview-entry')) { return 'move'; }
        // 外部 = 複製（元のファイルシステムからは消えない）
        if (has('Files') || has('application/vnd.code.uri-list')) { return 'copy'; }
        // note ツリーの .out / folder item は text/plain しか積まない（MIME で判別できない）→
        // one-shot グローバルで note ツリー発と分かるので複製扱い
        if (window.__notesTreeDragKind) { return 'copy'; }
        return 'move';
    }

    /**
     * drop / paste 先ディレクトリの**規則**（座標非依存）: dir 行 = その中 / file 行 = その親 / 余白 = ルート。
     *
     * FR-CBD-04/07（sprint 20260906-095357）で clipboard（G / H）と共有するため、
     * 座標依存部分（`e` から行を引く）と規則部分を分けた。この 1 行が
     * **ユーザー依頼原文（「フォルダで cmd+v したらその中。ファイルで cmd+v されたら同じ階層」）と完全一致**する。
     */
    function resolveDstFromRel(rel, isDir) {
        if (!rel) { return ''; }                 // 余白 / 選択なし = ルート
        return isDir ? rel : parentRelOf(rel);
    }

    /** drop 先ディレクトリ解決（座標 → 行 → 規則）。規則は `resolveDstFromRel` が単一真実。 */
    function resolveDropDst(e) {
        var row = e.target && e.target.closest ? e.target.closest('.fv-row') : null;
        if (!row) { return { dst: '', row: null }; }
        return { dst: resolveDstFromRel(row.dataset.rel, row.dataset.isdir === '1'), row: row };
    }

    function onTreeDragOver(e) {
        if (!isAcceptableDrag(e)) { return; }
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = resolveDropEffect(e); }
        clearDropVisuals();
        var r = resolveDropDst(e);
        if (r.row && r.row.dataset.isdir === '1') {
            r.row.classList.add('fv-drop-into');
        } else if (r.dst) {
            var parentRow = treeEl.querySelector('.fv-row[data-rel="' + r.dst.replace(/"/g, '\\"') + '"]');
            if (parentRow) { parentRow.classList.add('fv-drop-into'); } else { treeEl.classList.add('fv-drop-root'); }
        } else {
            treeEl.classList.add('fv-drop-root');
        }
    }

    function notifyDropUnsupported() {
        if (typeof bridge().notifyError === 'function') {
            bridge().notifyError(i18n().folderViewMoveInUnsupported || 'Only markdown and file items can be moved here.');
        }
    }

    function readJson(e, mime) {
        try {
            var raw = e.dataTransfer.getData(mime);
            return raw ? JSON.parse(raw) : null;
        } catch (err) { return null; }
    }

    function onTreeDrop(e) {
        if (!e.dataTransfer) { return; }
        e.preventDefault();
        e.stopPropagation();
        var r = resolveDropDst(e);
        var dst = r.dst;
        clearDropVisuals();
        var src = fvDragSrc;
        fvDragSrc = null; // one-shot 消費（2 連続 drag で stale を引き継がない）
        var b = bridge();
        // W1: ビュー内移動（同一 view の FV MIME）— FR-FMV-01/02/03
        //
        // 🔴 修正前は `fv.relPath !== undefined` の**単数 payload 前提**で、複数選択 payload
        //    （`{v:1, items:[…]}` は top-level relPath を持たない）を素通りさせて下の
        //    `notifyDropUnsupported()` に落としていた（TASK-02 probe の実測 = folderViewMove 0 回 + 通知 1 回）。
        //    全件は one-shot の `fvDragSrc.relPaths` にも入っていたが `void src;` で捨てられていた。
        var fv = readJson(e, FV_ENTRY_MIME);
        if (fv && (fv.relPath !== undefined || Array.isArray(fv.items))) {
            if (fv.folderLinkId !== currentLinkId) { notifyDropUnsupported(); return; }
            // 複数 = items[]（正規化は共有ヘルパに委ねる。手書きしない）/ 単一 = 従来形式
            var moveIds = Array.isArray(fv.items)
                ? window.__batchPayload.extractBatchItems(fv).map(function (it) { return it.relPath; })
                : [fv.relPath];
            // FR-FMV-02 / INV-4: **全件検証 → 1 件でも不正なら drop 全体を拒否**（0 件処理）。
            // 呼び出し元はここだけ（NFR-REL-1。dispatchFvMove の内部にも H 経路にも置かない）。
            var pf = fvMovePreflight(moveIds, dst);
            if (!pf.ok) {
                // `same_parent` は純粋な no-op（既存の単数経路は**無通知 return**）。
                // fs が壊れる self / descendant だけ理由を 1 回通知する（トーストを増やさない）。
                if (pf.reason !== 'same_parent' && typeof b.notifyError === 'function') {
                    b.notifyError(i18n().folderViewMoveIntoSelf || 'Cannot move a folder into itself.');
                }
                return;
            }
            dispatchFvMove(moveIds, dst, 'move');
            return;
        }
        // W3: tree md / file item（既存 MIME）→ #13 folderViewMoveIn
        // FR-MSEL-04 (§4-1): `{v:1, items:[…]}`（複数）と `{id}`（単一・旧）の両方を読む。
        // 複数は **既存の単一 drop の意味論を N 回適用**（1 件ずつ独立に host へ渡す）。
        var treeMd = readJson(e, TREE_MD_MIME);
        var treeFile = readJson(e, TREE_FILE_MIME);
        var mdIds = window.__batchPayload.extractBatchIds(treeMd);
        var fileIds = window.__batchPayload.extractBatchIds(treeFile);
        // §4-2 rev2（TASK-45）: md + file の混在は seq 順に結合して **folderViewMoveInBatch を 1 回**
        //（既存 batch は per-item に srcKind を持つので新 bridge 不要。件数ゲートが合計で 1 回効く）
        if (mdIds.length > 0 && fileIds.length > 0) {
            var mixed = window.__batchPayload.mergeTreeItemsBySeq(
                window.__batchPayload.extractBatchItems(treeMd), window.__batchPayload.extractBatchItems(treeFile));
            if (typeof b.folderViewMoveInBatch === 'function') {
                b.folderViewMoveInBatch(currentLinkId, dst, mixed.map(function (it) { return { srcKind: it.kind, srcItemId: it.id }; }));
            }
            return;
        }
        if (mdIds.length > 0) { dispatchTreeItemsIn(b, dst, 'md', mdIds); return; }
        if (fileIds.length > 0) { dispatchTreeItemsIn(b, dst, 'file', fileIds); return; }
        // W6: md アンカー既存 2 MIME → #16 folderViewMoveFromMd
        var mfl = readJson(e, MD_FILELINK_MIME);
        if (mfl && mfl.href) {
            if (typeof b.folderViewMoveFromMd === 'function') {
                b.folderViewMoveFromMd(currentLinkId, dst, mfl.href, mfl.sourceMdPath || '', false);
            }
            return;
        }
        var msp = readJson(e, MD_SUBPAGE_MIME);
        if (msp && msp.href) {
            if (typeof b.folderViewMoveFromMd === 'function') {
                b.folderViewMoveFromMd(currentLinkId, dst, msp.href, msp.sourceMdPath || '', true);
            }
            return;
        }
        // 2026-09-05 R25: outliner node（subtree / page / file アイコン / 添付 payload・複数可）→ この dir へ「linkedfd に送る」
        var onSub = readJson(e, 'application/x-fractal-out-node-subtree');
        var onPage = readJson(e, 'application/x-fractal-out-node-page');
        var onFile = readJson(e, 'application/x-fractal-out-node-file');
        var onAssets = readJson(e, 'application/x-fractal-out-node-assets');
        var onRef = onSub || onPage || onFile;
        if (onRef && onRef.outFileKey && onRef.nodeId) {
            var mvP = { outFileKey: onRef.outFileKey, nodeId: onRef.nodeId };
            var idsP = (onSub && Array.isArray(onSub.nodeIds)) ? onSub.nodeIds
                : (onAssets && Array.isArray(onAssets.items) ? onAssets.items.map(function (it) { return it.nodeId; }) : null);
            if (idsP && idsP.length > 1) { mvP.nodeIds = idsP; }
            if (typeof b.sendOutNodesToFolderLinkFromDrop === 'function') { b.sendOutNodesToFolderLinkFromDrop(mvP, currentLinkId, dst); }
            return;
        }
        // それ以外（.out item / folder item / 外部 files / uri-list）= 不受理通知
        //（受理 MIME は 4 群 — dnd-wiring §1 の明示裁定 + 2026-09-05 R25）
        // FR-FMV-01: W1 は payload の items[] を直接読むので one-shot の `src` は使わない
        //（複数選択の全件を `src.relPaths` から拾う旧案は payload を単一真実にする方針で採らない）。
        void src;
        notifyDropUnsupported();
    }

    // window 安全網: webview 外 drop / ESC キャンセル等、treeEl に drop が来ない終わり方でも
    // one-shot state と視覚 2 系統を必ず掃除（ADRL-0031 型 — notes-file-panel.js:2327 と同型）
    window.addEventListener('drop', function () { fvDragSrc = null; clearDropVisuals(); }, true);
    window.addEventListener('dragend', function () { fvDragSrc = null; clearDropVisuals(); }, true);

    function renderTree() {
        if (!treeEl) { return; }
        treeEl.textContent = '';
        visibleRows = [];
        if (searchHits) { renderSearchTree(); return; }
        appendChildrenOf('', 0);
        if ((childrenByRel[''] || []).length === 0 && childrenByRel['']) {
            renderEmptyNote();
        }
    }

    function renderEmptyNote() {
        var note = document.createElement('div');
        note.className = 'fv-note';
        note.textContent = i18n().folderViewEmpty || '(empty folder)';
        treeEl.appendChild(note);
    }

    function appendChildrenOf(rel, depth) {
        var entries = childrenByRel[rel];
        if (!entries) {
            if (rel !== '') { requestList(rel); } // 展開済みだが未取得（lazy）
            return;
        }
        entries.forEach(function (entry) {
            treeEl.appendChild(makeRow(entry, depth));
            visibleRows.push(entry.relPath);
            if (entry.isDir && expanded[entry.relPath]) {
                appendChildrenOf(entry.relPath, depth + 1);
            }
        });
    }

    /** FR-FLV-12: 検索結果 = マッチ + 祖先のみの pruned tree（祖先は relPath から導出・自動展開表示） */
    function renderSearchTree() {
        var rows = [];   // {relPath, name, isDir, depth}
        var added = {};
        (searchHits || []).forEach(function (hit) {
            // 祖先 dir を relPath セグメントから導出
            var parts = hit.relPath.split('/');
            var acc = '';
            for (var i = 0; i < parts.length - 1; i++) {
                acc = acc ? acc + '/' + parts[i] : parts[i];
                if (!added[acc]) {
                    added[acc] = true;
                    rows.push({ relPath: acc, name: parts[i], isDir: true, depth: i, isAncestor: true });
                }
            }
            if (!added[hit.relPath]) {
                added[hit.relPath] = true;
                rows.push({ relPath: hit.relPath, name: hit.name, isDir: !!hit.isDir, depth: parts.length - 1 });
            }
        });
        rows.forEach(function (r) {
            var row = makeRow({ relPath: r.relPath, name: r.name, isDir: r.isDir }, r.depth);
            if (r.isAncestor) { row.classList.add('fv-ancestor'); }
            treeEl.appendChild(row);
            visibleRows.push(r.relPath);
        });
        if (searchTruncated) {
            var note = document.createElement('div');
            note.className = 'fv-note fv-truncated';
            note.textContent = i18n().folderViewTruncated || 'Too many results — refine your query.';
            treeEl.appendChild(note);
        }
        if (rows.length === 0 && !searchTruncated) {
            var empty = document.createElement('div');
            empty.className = 'fv-note';
            empty.textContent = i18n().folderViewNoMatch || 'No matches.';
            treeEl.appendChild(empty);
        }
    }

    // ── インライン rename（FR-FLV-28 — notes-file-panel.js startRenameFile :413 同型） ──

    function endRename(applyPendingRender) {
        var r = renaming;
        renaming = null;
        if (r && r.inputEl && r.inputEl.parentElement) {
            // 原状復元（確定時は host の list 再送が正 — 楽観 DOM 書き換えはしない）
            var nameEl = r.inputEl.parentElement;
            r.inputEl.remove();
            if (r.savedNodes) { r.savedNodes.forEach(function (n) { nameEl.appendChild(n); }); }
        }
        if (r && applyPendingRender && r.pendingRender) {
            if (!searchHits) { renderTree(); }
        }
        if (treeEl && typeof treeEl.focus === 'function') {
            try { treeEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
    }

    function startRename(rel) {
        if (renaming) { return; }
        var row = treeEl ? treeEl.querySelector('.fv-row[data-rel="' + String(rel).replace(/"/g, '\\"') + '"]') : null;
        var nameEl = row ? row.querySelector('.fv-name') : null;
        if (!row || !nameEl) { return; }
        var oldName = baseNameOf(rel);
        var input = document.createElement('input');
        input.className = 'fv-rename-input';
        input.type = 'text';
        input.value = oldName;
        // 名前部分だけを input に置換（アイコン等の既存 child は退避して Escape で戻す）
        var saved = Array.prototype.slice.call(nameEl.childNodes);
        saved.forEach(function (n) { n.remove(); });
        nameEl.appendChild(input);
        renaming = { relPath: rel, inputEl: input, done: false, pendingRender: false, savedNodes: saved };
        var confirm = function () {
            if (!renaming || renaming.done) { return; }
            renaming.done = true; // done フラグ（blur/Enter 二重発火防止 — precedent 同型）
            var newName = String(input.value || '').trim();
            var r = renaming;
            if (newName && newName !== oldName && typeof bridge().folderViewRename === 'function') {
                bridge().folderViewRename(currentLinkId, rel, newName); // 成否は host（同名衝突等はエラー通知 + list 再送なし）
            }
            endRename(true);
            void r;
        };
        var cancel = function () {
            if (!renaming || renaming.done) { return; }
            renaming.done = true;
            endRename(true);
        };
        input.addEventListener('keydown', function (e) {
            // IME 二重ガード（!isComposing && keyCode!==229 — rename-ime precedent の字面）
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                e.stopPropagation();
                confirm();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
            } else {
                e.stopPropagation(); // tree の keydown（ナビ）に漏らさない
            }
        });
        input.addEventListener('blur', function () { confirm(); });
        input.focus();
        input.select();
    }

    /** 選択のハイライトを集合から塗り直す。 */
    function paintSelection() {
        if (!treeEl) { return; }
        Array.prototype.forEach.call(treeEl.querySelectorAll('.fv-row'), function (el) {
            el.classList.toggle('fv-selected', selection.indexOf(el.dataset.rel) >= 0);
        });
    }

    /**
     * Hard MUST（NFR-MSEL-01）: 範囲確定のたびにテキスト範囲を捨てる。
     * 残すと clipboard / D&D をブラウザ標準に奪われる（過去の Bug 5 fix の再発防止）。
     */
    function dropTextSelection() {
        try {
            var sel = window.getSelection();
            if (sel && sel.rangeCount > 0) { sel.removeAllRanges(); }
        } catch (e) { /* 一部環境で throw する — 選択動作は継続させる */ }
    }

    /** 単一選択（修飾なし click / 矢印移動）。anchor も focus もこの行へ。 */
    function selectRow(rel) {
        selectedRel = rel;
        anchorRel = rel;
        selection = rel ? [rel] : [];
        dropTextSelection();
        paintSelection();
    }

    /**
     * anchorRel..rel の連続範囲を選択する（FR-MSEL-01）。
     * 順序の単一真実は既存 `visibleRows`（描画順 relPath 配列）— 新規の順序計算は書かない。
     * anchor を跨いだ場合は反対側へ伸びる（伸長と収縮の両方が自然に成立する）。
     */
    function selectRange(rel) {
        if (!anchorRel) { selectRow(rel); return; }
        var a = visibleRows.indexOf(anchorRel);
        var b = visibleRows.indexOf(rel);
        if (a < 0 || b < 0) { selectRow(rel); return; }
        var lo = Math.min(a, b);
        var hi = Math.max(a, b);
        selection = visibleRows.slice(lo, hi + 1);
        selectedRel = rel;                     // focus は移るが anchor は動かさない
        dropTextSelection();
        paintSelection();
    }

    /**
     * cmd/ctrl+click の単品トグル（FR-MSEL-01 rev2 / ADRL-0111）。
     * 集合は `visibleRows` 順に正規化して持つ（D&D payload の順序 = 描画順を崩さない）。anchor / focus はこの行へ。
     */
    function toggleRow(rel) {
        if (!rel) { return; }
        var at = selection.indexOf(rel);
        if (at >= 0) { selection.splice(at, 1); } else { selection.push(rel); }
        selection = visibleRows.filter(function (r) { return selection.indexOf(r) >= 0; });
        anchorRel = rel;
        selectedRel = rel;
        dropTextSelection();
        paintSelection();
    }

    /** 選択をクリアする（Esc）。 */
    function clearSelection() {
        selection = [];
        anchorRel = null;
        selectedRel = null;
        paintSelection();
    }

    /** D&D payload に載せる選択（FR-MSEL-05: フォルダは集合に入るが payload からは除く）。 */
    function selectedFilesForDnd() {
        // FR-FDP-01 / ADRL-0122（TASK-03）: **フォルダを除外しない**。
        // 旧実装は dir を落としていた。理由として「HTML DataTransfer にディレクトリを載せられない」が
        // 記録されていたが、それは **OS からファイルを投入する channel 限定の制約**で、
        // `setData(customMime, JSON)` に識別子を載せる本経路には掛からない（本番の単一フォルダ drag が反例）。
        // 運ぶのは実体ではなく識別子で、実体の複製・移動は host の Node fs が担う。
        var out = [];
        for (var i = 0; i < selection.length; i++) {
            var e = findEntry(selection[i]);
            if (e) { out.push(selection[i]); }
        }
        return out;
    }

    /**
     * 移動のプリフライト（FR-FMV-02 / DOM-FvMovePreflight / INV-4）。
     *
     * **全件を検証して 1 件でも不正なら drop 全体を拒否**する（0 件処理）。
     * per-item 除外にしないのは **fs 操作が部分適用を巻き戻せない**ため（generator_failures 2026-09-05）。
     * 既存 2 面で方針が不揃い（FR-OMV-02.3 = 全体拒否 / FR-TMV の `moveItems` = per-id 除外）なので、
     * fs を触る本 context は安全側（全体拒否）に倒す。
     *
     * 🔴 **呼び出し元は W1（D&D の drop ハンドラ）だけ**（NFR-REL-1）。
     *    `dispatchFvMove` の内部には置かず、clipboard の H 経路（`mode:'copy'`）からも呼ばない。
     *    H の最基本シナリオ（同じ階層への複製 = TC-CBD-40）は「既に同じ親」が**正常系**であり、
     *    ここで全体拒否すると H が原理的に動かなくなる。
     *
     * @returns {{ ok: boolean, reason?: string }}
     */
    function fvMovePreflight(ids, dstDirRel) {
        var dst = dstDirRel || '';
        for (var i = 0; i < ids.length; i++) {
            var rel = ids[i];
            var e = findEntry(rel);
            // ① 移動先 = 自分自身
            if (rel === dst) { return { ok: false, reason: 'self' }; }
            // ② フォルダを自分の子孫へ
            if (e && e.isDir && (dst === rel || dst.indexOf(rel + '/') === 0)) { return { ok: false, reason: 'descendant' }; }
            // ③ 既に同じ親（fs 移動の意味が無い = no-op）
            if (parentRelOf(rel) === dst) { return { ok: false, reason: 'same_parent' }; }
        }
        return { ok: true };
    }

    /**
     * F/G/H の clipboard payload を `text/html` の先頭タグに埋める属性名（DOM-ClipPayload）。
     * OS clipboard に custom MIME は載せられないため、outliner 正典
     * （`data-outliner-clipboard`）と同型の「HTML の data 属性に encodeURIComponent(JSON)」方式にする。
     */
    var FV_CLIP_ATTR = 'data-fractal-fv-clip';

    function escapeHtmlText(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * linkedfd の選択を clipboard に書く（FR-CBD-01 / DOM-FvClipCopy）。
     *
     * 🔴 **keydown 駆動が必須**（HM-4）: linkedfd は `dropTextSelection()` でテキスト選択を毎回捨てるため
     *    selection が常に collapsed で、**`copy` イベントがブラウザから発火しない**
     *    （in-repo 前例: `editor.js` の table select モードの逐語コメント）。
     * 🔴 **収集対象は `selection` 全件（フォルダを含む）**: `selectedFilesForDnd()` を使わない。
     *    フォルダ除外は **HTML DataTransfer にディレクトリを載せられないという D&D 固有の制約**への救済で、
     *    clipboard に持ち込むと機能を不要に削る（host 入口 `sendFolderViewToOutliner` は dir を
     *    `walkFolderForImport` で構造ごと取り込める）。
     * 🔴 実体を載せない（識別子のみ）。host が disk から解決する。
     */
    function writeFvClipboard() {
        var rels = selection.slice();       // visibleRows 順に正規化済み（toggleRow / selectRange が保証）
        if (rels.length === 0) { return false; }
        var copyId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var meta = { v: 1, folderLinkId: currentLinkId, relPaths: rels, copyId: copyId };
        var plain = rels.join('\n');
        var html = '<div ' + FV_CLIP_ATTR + '="' + encodeURIComponent(JSON.stringify(meta)) + '">'
            + rels.map(escapeHtmlText).join('<br>') + '</div>';
        var fallback = function () { try { navigator.clipboard.writeText(plain); } catch (e2) { /* ignore */ } };
        try {
            navigator.clipboard.write([
                new ClipboardItem({
                    'text/plain': new Blob([plain], { type: 'text/plain' }),
                    'text/html': new Blob([html], { type: 'text/html' }),
                }),
            ]).catch(function (err) {
                console.warn('[Notes] fv clipboard.write failed, falling back to plain text:', err);
                fallback();
            });
        } catch (err) { fallback(); }
        return true;
    }

    /**
     * fv 内移動の dispatch 一元化（FR-FMV-03 / DOM-FvMoveDispatch）。
     * precedent: `notes-file-panel.js` の `dispatchTreeMove`（裁定 R38 で webview 6 経路を 1 点に集約した形）。
     *
     * - 1 件 = 既存の単数 `folderViewMove`（**契約不変・byte 不変**。既存 spec を red にしない）
     * - 複数 = 新 `folderViewMoveBatch` を **1 回**（NFR-FMV-01 / SEC-1: webview から N 回呼ぶと
     *   host 側の件数ゲート `checkBatchLimit` を構造的に迂回する）
     *
     * 🔴 `mode` は**必ず forward** する（リテラルを書かない = design-review SYS-1）。
     *    既定 `'move'` は引数のデフォルト値としてのみ存在し、H（clipboard 複製）が `'copy'` を渡したら
     *    最後まで `'copy'` のまま host に届くこと（リテラルを書くと copy が move に化けて source が消える）。
     * 🔴 `fvMovePreflight` は**ここでは呼ばない**（NFR-REL-1）。呼び出し元 = W1 の drop ハンドラだけ。
     */
    /**
     * INV-11 / DOM-InProgressGate（TASK-12）: **面単位の進行中フラグ**。
     * 非同期化（チャンク譲渡）により複製中に別の drop / 貼り付けが始まりうる。
     * 同一宛先への同時複製は連番採番が存在チェックのみを見るため衝突しうるので、
     * 進行中はその面の drop / 貼り付けを受け付けない（粒度は**面単位** = DOM-InProgressScope。
     * 宛先単位にしないのは、同一面で並行操作が走っているとユーザーが把握できないため）。
     */
    var fvTransferInProgress = false;
    function fvBeginTransfer() {
        if (fvTransferInProgress) { return false; }
        fvTransferInProgress = true;
        return true;
    }
    function fvEndTransfer() { fvTransferInProgress = false; }

    function dispatchFvMove(ids, dstDirRel, mode) {
        var b = bridge();
        var m = mode || 'move';
        if (!ids || ids.length === 0) { return; }
        // INV-11: 進行中は受け付けない（完了は host の folderViewTransferDone / 一覧再送で解除する = FR-FVT-01）
        if (!fvBeginTransfer()) { return; }
        // FR-FDP-09 / NFR-FDP-06（TASK-08）: **フォルダを含むなら 1 件でも batch 経路**に通す。
        // 単数 bridge を直呼びすると件数ゲート（2 段化した実件数判定）と集計通知の両方を迂回し、
        // フォルダ 1 個を落としたときに「何がどこへ動いたか」の手がかりが残らない（undo が無い面）。
        // ファイルのみ 1 件は従来どおり単数 bridge（既存 UX・既存 spec の引数完全一致 assert を守る）。
        var hasDirInIds = false;
        for (var di = 0; di < ids.length; di++) {
            var de = findEntry(ids[di]);
            if (de && de.isDir) { hasDirInIds = true; break; }
        }
        if (ids.length === 1 && hasDirInIds && typeof b.folderViewMoveBatch === 'function') {
            b.folderViewMoveBatch(currentLinkId, ids, dstDirRel, m);
            return;
        }
        if (ids.length === 1) {
            // FR-FVT-01: host に要求が届かない = 完了通知も来ないので、ここで解除してから返す
            if (typeof b.folderViewMove !== 'function') { fvEndTransfer(); return; }
            // 🔴 `mode === 'move'`（= D&D）のときは **第 4 引数を渡さない**。
            //    既存 spec（`folder-view-dnd.spec.ts` TC-FLV-39）が bridge 呼び出しの
            //    **引数配列を完全一致で assert** しているため、引数を増やすと byte 不変が崩れる（実測で検出）。
            //    `'copy'`（= H の clipboard 複製）のときだけ明示的に渡す。
            if (m === 'copy') { b.folderViewMove(currentLinkId, ids[0], dstDirRel, m); }
            else { b.folderViewMove(currentLinkId, ids[0], dstDirRel); }
            return;
        }
        if (typeof b.folderViewMoveBatch === 'function') {
            b.folderViewMoveBatch(currentLinkId, ids, dstDirRel, m);
        } else {
            fvEndTransfer();   // FR-FVT-01: 同上（bridge 不在 = 完了通知が来ない）
        }
    }

    /**
     * FR-MSEL-04 / NFR-MSEL-02 (§4-3b / TASK-29): note ツリー item を fv へ受け入れる dispatch。
     *
     * 🔴 **複数は配列 bridge を 1 回**呼ぶ。ここで N 回ループすると host 側の件数ゲート
     * （checkBatchLimit）を構造的に迂回する（reviewer iteration 1 SEC-1）。
     * 単一は従来の単一 bridge のまま（既存 TC を壊さない）。
     */
    function dispatchTreeItemsIn(b, dst, srcKind, ids) {
        if (!b || ids.length === 0) { return; }
        if (ids.length === 1) {
            if (typeof b.folderViewMoveIn === 'function') { b.folderViewMoveIn(currentLinkId, dst, srcKind, ids[0]); }
            return;
        }
        if (typeof b.folderViewMoveInBatch === 'function') {
            b.folderViewMoveInBatch(currentLinkId, dst, ids.map(function (id) {
                return { srcKind: srcKind, srcItemId: id };
            }));
        }
    }

    /**
     * FR-MSEL-05: 「フォルダのみ選択して drag」を**無反応にしない**ための通知（1 回だけ）。
     * フォルダの D&D はスコープ外（フォルダ構造の転送は右クリックの「Outliner に送る」が担う）。
     */

    function notifyFolderOnlyDrag(dirCount) {
        var b = bridge();
        if (!b || typeof b.notifyError !== 'function') { return; }
        // 複数件は専用キー（{count} プレース）— 1 件は既存キーのまま（文言の後方互換）
        if (dirCount > 1) {
            var tpl = i18n().batchDndFoldersSkipped || '{count} folders skipped (use "Send to Outliner")';
            b.notifyError(String(tpl).replace('{count}', String(dirCount)));
            return;
        }
        b.notifyError(i18n().folderViewNoFolderDrop || 'Folders cannot be dropped here.');
    }

    /** 選択に含まれるフォルダの件数（集計通知に出す）。 */
    function selectedDirCount() {
        var n = 0;
        for (var i = 0; i < selection.length; i++) {
            var e = findEntry(selection[i]);
            if (e && e.isDir) { n++; }
        }
        return n;
    }

    /** FR-FLV-26: 開閉状態の debounce 保存（Search debounce と同型の setTimeout パターン） */
    function scheduleStateSave() {
        if (stateSaveTimer) { clearTimeout(stateSaveTimer); }
        stateSaveTimer = setTimeout(function () {
            stateSaveTimer = null;
            if (!currentLinkId) { return; }
            var list = Object.keys(expanded).filter(function (k) { return !!expanded[k]; });
            if (typeof bridge().folderViewStateSave === 'function') {
                bridge().folderViewStateSave(currentLinkId, list);
            }
        }, 300);
    }

    function toggleDir(rel) {
        expanded[rel] = !expanded[rel];
        if (expanded[rel] && !childrenByRel[rel]) {
            requestList(rel); // lazy per-expand（応答で再描画）
        }
        scheduleStateSave(); // FR-FLV-26
        renderTree();
    }

    // ── キーボード（FR-FLV-11/14: ↑↓ 選択・←→ 折りたたみ/展開・cmd+enter open） ──

    function onKeyDown(e) {
        if (searchHits === null && visibleRows.length === 0) { return; }
        var idx = selectedRel ? visibleRows.indexOf(selectedRel) : -1;
        if (e.key === 'Escape' && !renaming) {
            // FR-MSEL-01: Esc で選択クリア
            if (selection.length > 0) { e.preventDefault(); clearSelection(); }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            var next = visibleRows[Math.min(idx + 1, visibleRows.length - 1)] || visibleRows[0];
            if (e.shiftKey) { selectRange(next); } else { selectRow(next); }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            var prev = visibleRows[Math.max(idx - 1, 0)] || visibleRows[0];
            if (e.shiftKey) { selectRange(prev); } else { selectRow(prev); }
        } else if (e.key === 'ArrowRight') {
            if (!selectedRel) { return; }
            e.preventDefault();
            var row = findEntry(selectedRel);
            if (row && row.isDir && !expanded[selectedRel]) { toggleDir(selectedRel); }
        } else if (e.key === 'ArrowLeft') {
            if (!selectedRel) { return; }
            e.preventDefault();
            if (expanded[selectedRel]) {
                toggleDir(selectedRel);
            } else {
                var parent = parentRelOf(selectedRel);
                if (parent !== selectedRel && visibleRows.indexOf(parent) >= 0) { selectRow(parent); }
            }
        } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
                   && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
            // FR-CBD-01 / DOM-FvClipCopy: 選択全件を clipboard へ。
            // `e.metaKey || e.ctrlKey` の**両受け**（Linux/CI Chromium は copy/cut/paste を Control に束ねる）。
            // rename 入力中は素通し = input のテキスト copy として動く（guard の 1 段目）。
            if (renaming) { return; }
            if (selection.length === 0) { return; }   // 何もしない（clipboard を上書きしない）
            e.preventDefault();
            writeFvClipboard();
        } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            // FR-FLV-28: Enter 単独 = インライン rename（IME 変換確定の Enter は除外 — precedent ガード）
            if (!selectedRel || e.isComposing || e.keyCode === 229 || renaming) { return; }
            e.preventDefault();
            startRename(selectedRel);
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            if (!selectedRel) { return; }
            e.preventDefault();
            var entry = findEntry(selectedRel);
            if (!entry) { return; }
            if (entry.isDir) {
                toggleDir(selectedRel);
            } else if (bridge().folderViewOpen) {
                bridge().folderViewOpen(currentLinkId, selectedRel);
                // 2026-08-18 バグ修正: sidepanel が auto-focus を奪うと連続 cmd+enter / ↑↓ が
                // sidepanel エディタに吸われる — キーボード起点の open ではツリーへフォーカスを戻す
                //（outliner の「開いても切り替え続けられる」挙動に合わせる）
                setTimeout(function () {
                    var d = window.__folderViewDispatcher;
                    if (d && typeof d.isFolderViewShown === 'function' && d.isFolderViewShown() && treeEl) {
                        try { treeEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
                    }
                }, 400);
            }
        }
    }

    function findEntry(rel) {
        if (searchHits) {
            for (var i = 0; i < searchHits.length; i++) {
                if (searchHits[i].relPath === rel) { return searchHits[i]; }
            }
            // 祖先 dir（hits に無い）は dir 扱い
            return { relPath: rel, name: baseNameOf(rel), isDir: true };
        }
        var entries = childrenByRel[parentRelOf(rel)] || [];
        for (var j = 0; j < entries.length; j++) {
            if (entries[j].relPath === rel) { return entries[j]; }
        }
        return null;
    }

    // ── context menu（FR-FLV-15: エントリ = 6 項目のみ / 空白 = New 2 項目） ──

    var menuEl = null;
    function closeMenu() {
        closeSendToOutlinerSubmenu();
        if (menuEl && menuEl.parentElement) { menuEl.parentElement.removeChild(menuEl); }
        menuEl = null;
    }

    // ── FR-SND-02 rev2: 「Outliner に送る」の送り先サブメニュー ──
    var sendToOutlinerSubmenuEl = null;
    function closeSendToOutlinerSubmenu() {
        if (sendToOutlinerSubmenuEl && sendToOutlinerSubmenuEl.parentElement) {
            sendToOutlinerSubmenuEl.parentElement.removeChild(sendToOutlinerSubmenuEl);
        }
        sendToOutlinerSubmenuEl = null;
    }

    /** ツリー内の `.out` 一覧（同一 document の notesFilePanel から読む — bridge 往復を作らない）。 */
    function listOutFiles() {
        var nfp = window.notesFilePanel;
        if (!nfp || typeof nfp.getOutFiles !== 'function') { return []; }
        return nfp.getOutFiles() || [];
    }

    /** 送る対象 relPath 群（選択内の右クリック = 選択集合 / 選択外 = その行のみ — ADRL-0029）。 */
    function sendTargetsFor(entry) {
        return (selection.indexOf(entry.relPath) >= 0 && selection.length > 0) ? selection.slice() : [entry.relPath];
    }

    /**
     * 「Outliner に送る ▶」項目。`.out` が 0 件なら**見た目は disabled だが click で通知**する
     *（無反応だと「壊れている」に見える — outliner.js の addSendToLinkedfdItem と同じ方針）。
     * 既存 addMenuItem は click で closeMenu() してしまうのでサブメニュー起点は自前で作る。
     */
    function addSendToOutlinerItem(m, entry) {
        var label = m.sendToOutlinerMenu || 'Send to Outliner';
        var outs = listOutFiles();
        var item = document.createElement('div');
        item.className = 'fv-menu-item fv-menu-item-submenu';
        item.textContent = label;   // ▶ は CSS ::after（textContent を汚さない = 既存 TC-FLV-37 のラベル照合を保つ）
        if (outs.length === 0) {
            item.classList.add('disabled');
            item.addEventListener('click', function () {
                closeMenu();
                var b = bridge();
                if (b && typeof b.notifyError === 'function') {
                    b.notifyError(m.sendToOutlinerNoOutlines || 'No outline (.out) in this note. Create one first.');
                }
            });
            menuEl.appendChild(item);
            return;
        }
        item.addEventListener('click', function (ev) {
            ev.stopPropagation();   // 親 menu の one-shot close（document click）を発火させない
            openSendToOutlinerSubmenu(item, sendTargetsFor(entry), outs);
        });
        menuEl.appendChild(item);
    }

    /**
     * 送り先サブメニュー。🔴 親 menu の子孫にせず `position:fixed` で body 直下（親の overflow でクリップされない
     * — outliner.js openSendToLinkedfdSubmenu と同じ絶対条項）。配置は共有ヘルパ __menuPlacement.place に委譲。
     */
    function openSendToOutlinerSubmenu(anchorEl, targets, outs) {
        closeSendToOutlinerSubmenu();
        var sub = document.createElement('div');
        sub.className = 'fv-menu fv-submenu';
        sub.style.position = 'fixed';
        for (var i = 0; i < outs.length; i++) {
            (function (o) {
                var it = document.createElement('div');
                it.className = 'fv-menu-item';
                it.dataset.outId = o.id;
                it.textContent = o.name || o.id;
                it.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    closeMenu();
                    var b = bridge();
                    if (b && typeof b.sendFolderViewToOutliner === 'function') {
                        b.sendFolderViewToOutliner(currentLinkId, targets, o.id);
                    }
                });
                sub.appendChild(it);
            })(outs[i]);
        }
        document.body.appendChild(sub);
        sendToOutlinerSubmenuEl = sub;
        var r = anchorEl.getBoundingClientRect();
        window.__menuPlacement.place(sub, { x: r.right, y: r.top });
        setTimeout(function () { document.addEventListener('click', closeMenu, { once: true }); }, 0);
    }

    function addMenuItem(label, handler, danger) {
        var item = document.createElement('div');
        item.className = 'fv-menu-item' + (danger ? ' danger' : '');
        item.textContent = label;
        item.addEventListener('click', function () {
            closeMenu();
            handler();
        });
        menuEl.appendChild(item);
    }

    function showMenu(e, entry) {
        closeMenu();
        menuEl = document.createElement('div');
        menuEl.className = 'fv-menu';
        menuEl.style.left = e.clientX + 'px';
        menuEl.style.top = e.clientY + 'px';
        var m = i18n();
        // New 系の作成先: フォルダ選択中はその中・ファイル選択中は同階層・空白はルート
        var targetDir = !entry ? '' : (entry.isDir ? entry.relPath : parentRelOf(entry.relPath));
        addMenuItem(m.folderViewNewMarkdown || 'New Markdown', function () {
            if (bridge().folderViewCreate) { bridge().folderViewCreate(currentLinkId, targetDir, 'md'); }
        });
        addMenuItem(m.folderViewNewFolder || 'New Folder', function () {
            if (bridge().folderViewCreate) { bridge().folderViewCreate(currentLinkId, targetDir, 'folder'); }
        });
        if (entry) {
            addMenuItem(m.notesRename || 'Rename', function () {
                startRename(entry.relPath); // FR-FLV-28: menu もインライン方式（ポップアップ廃止）
            });
            addMenuItem(m.notesRevealInFinder || 'Reveal in Finder', function () {
                if (bridge().folderViewRevealEntry) { bridge().folderViewRevealEntry(currentLinkId, entry.relPath); }
            });
            addMenuItem(m.copyPath || 'Copy Path', function () {
                if (bridge().folderViewCopyEntryPath) { bridge().folderViewCopyEntryPath(currentLinkId, entry.relPath); }
            });
            if (!entry.isDir) {
                // FR-ACC-04: md/file エントリのみ（dir は非対応 — ADRL-ACC-3）。i18n は既存キー再利用
                addMenuItem(m.notesDuplicateItem || 'Duplicate', function () {
                    if (bridge().folderViewDuplicate) { bridge().folderViewDuplicate(currentLinkId, entry.relPath); }
                });
            }
            // FR-SND-01/02 (§6-1 / sprint 20260901-075849): 選択（複数可）を Outliner root 先頭へ送る。
            // 対象は **選択内の右クリック = 選択集合 / 選択外 = その行のみ**（ADRL-0029「選択集合優先」）。
            // フォルダも対象（フォルダ構造を node で再現 = Import folder と同一経路）。
            // FR-SND-02 rev2（2026-09-04 手動テスト (2)）: 送り先 `.out` は**サブメニューで選ぶ**
            //（「linkedfd に送る」の folder link サブメニューと対称。開いている .out に依存しない）。
            addSendToOutlinerItem(m, entry);
            addMenuItem(m.notesDelete || 'Delete', function () {
                if (bridge().folderViewDelete) { bridge().folderViewDelete(currentLinkId, entry.relPath); }
            }, true);
        }
        document.body.appendChild(menuEl);
        // FR-MFIT-01/02/03: viewport 収め（flip → clamp → max-height）を共有ヘルパへ委譲。
        // typeof ガードは登録漏れ時に silent no-op になるため使わず、未登録は即座に分かる形にする。
        window.__menuPlacement.place(menuEl, { x: e.clientX, y: e.clientY });
        setTimeout(function () { document.addEventListener('click', closeMenu, { once: true }); }, 0);
    }

    /**
     * linkedfd の cmd+v 受け口（FR-CBD-04/07 / DOM-FvClipPaste / **ADRL-0118 = 案 B**）。
     *
     * 🔴 **treeEl への paste listener は採用不可**（HM-5）: Chromium は clipboard event の target を
     *    selection 起点で決め `document.activeElement` を見ないため、collapsed / 空 selection では
     *    **document.body** に落ちる（treeEl は body の子孫なので永久に来ない）。
     * 🔴 **OS clipboard を単一の真実にする**（案 A = window 変数受け渡しを却下した根拠）:
     *    案 A だと「linkedfd で cmd+c → outliner で cmd+c → linkedfd で cmd+v」で
     *    **古い fv payload が貼られる**（clipboard の真実が 2 つに分裂）。TC-CBD-62 がその番人。
     * 🔴 getData() は **await の前に同期で読み切る**（HM-6）。navigator.clipboard.readText() は使わない。
     */
    function onDocumentPaste(e) {
        // ── guard 4 段（HM-B-11）。1 つでも欠けると既存の paste を奪う ──
        if (renaming) { return; }                                    // ① rename 入力中
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { return; }  // ②
        var disp = window.__folderViewDispatcher;
        // ③ active 面。
        // 🔴 TASK-26 (DESIGN-3): ADRL-0118 は guard③ を
        //    「`isFolderViewShown()` **かつ** `treeEl.contains(document.activeElement)`」と書いているが、
        //    ここは前者だけにしている。理由 = **pane 排他**: `folder-view-dispatcher.js` の
        //    `showFolderView()` は fv を出すとき outliner / markdown コンテナを `display:none` にするため、
        //    `isFolderViewShown() === true` の間 outliner は DOM 上非表示で focus を保持できない
        //    （後者を足しても真偽が一致する）。
        //    ⚠️ この無害性は **pane 排他が保たれる限り**の話。将来 2-pane 表示（outliner + linkedfd 同時可視）が
        //    入ると outliner にフォーカスしたまま `isFolderViewShown()===true` になり、
        //    古い fv/outliner clipboard payload が outliner 内の通常 paste で誤爆しうる
        //    （ADRL-0118 が案 A の却下理由に挙げた stale payload 誤爆と同種）。その時は後者を足す。
        if (!disp || typeof disp.isFolderViewShown !== 'function' || !disp.isFolderViewShown()) { return; }
        if (e.defaultPrevented) { return; }                          // ④
        if (!e.clipboardData) { return; }

        var html = '';
        try { html = e.clipboardData.getData('text/html') || ''; } catch (err) { return; }
        if (!html) { return; }

        // 🔴 selectedRel が null（選択 0 件 = 余白相当）のとき findEntry を呼ばない
        //    （parentRelOf(null) が例外になり、handler ごと落ちて **無反応**になる。実測で検出）
        var selEntry = selectedRel ? findEntry(selectedRel) : null;
        var dst = resolveDstFromRel(selectedRel, !!(selEntry && selEntry.isDir));
        var b = bridge();

        // ── G: outliner → linkedfd（data-outliner-clipboard の nodeIds）──
        var om = html.match(/data-outliner-clipboard="([^"]*)"/);
        if (om) {
            var ometa = null;
            try { ometa = JSON.parse(decodeURIComponent(om[1])); } catch (err) { ometa = null; }
            if (ometa && Array.isArray(ometa.nodeIds) && ometa.nodeIds.length > 0 && ometa.sourceOutFileKey) {
                e.preventDefault();
                var mv = { outFileKey: ometa.sourceOutFileKey, nodeId: ometa.nodeIds[0] };
                if (ometa.nodeIds.length > 1) { mv.nodeIds = ometa.nodeIds; }
                // HM-8: 既存 host 入口（D&D / 「linkedfd に送る」と共有）。clipboard 専用 handler は作らない
                if (typeof b.sendOutNodesToFolderLinkFromDrop === 'function') {
                    b.sendOutNodesToFolderLinkFromDrop(mv, currentLinkId, dst);
                }
                return;
            }
        }

        // ── H: linkedfd 内 c→v（data-fractal-fv-clip の relPaths）= **複製** ──
        var fm = html.match(new RegExp(FV_CLIP_ATTR + '="([^"]*)"'));
        if (fm) {
            var fmeta = null;
            try { fmeta = JSON.parse(decodeURIComponent(fm[1])); } catch (err) { fmeta = null; }
            if (fmeta && fmeta.folderLinkId === currentLinkId && Array.isArray(fmeta.relPaths)) {
                // FR-FDP-06 / ADRL-0124（TASK-11）: **フォルダも複製する**。
                // ADRL-0120 の受容事項「フォルダの再帰複製経路が既存に無い」は
                // 新エンジン（`folder-copy-engine.ts`）ができたので解除された。
                // 旧実装は dir を filter して `files.length === 0` で無通知 return しており、
                // host 側に足された拒否通知は**到達不能な dead branch** だった
                // （= フォルダ 1 件の Cmd+V が完全に無反応 = ユーザー観測の派生 1 件）。
                var files = [];
                for (var i = 0; i < fmeta.relPaths.length; i++) {
                    var en = findEntry(fmeta.relPaths[i]);
                    if (en) { files.push(fmeta.relPaths[i]); }
                }
                if (files.length === 0) { return; }   // 貼る対象が 1 つも無い（= clipboard が空）
                e.preventDefault();
                // FR-CBD-07 rev3 / ADRL-0133（その場複製）: focus 行が clipboard のコピー元に含まれる
                // （= Cmd+C 直後に選択を変えていない）なら、宛先は focus 行の**親**（コピー元と同じ階層）。
                // フォルダ行の「その中」にすると自分自身の中への複製になり host の自己子孫ガードに当たる。
                // それ以外のフォルダ行は従来どおり「その中」（resolveDstFromRel 本体は D&D / G と共有なので触らない）。
                var hDst = dst;
                if (selectedRel && fmeta.relPaths.indexOf(selectedRel) >= 0) { hDst = parentRelOf(selectedRel); }
                // 🔴 fvMovePreflight は**通さない**（NFR-REL-1）。H は「同じ階層への複製」が正常系で、
                //    D&D 用の全体拒否ガード（既に同じ親 → reject）を掛けると原理的に動かなくなる。
                dispatchFvMove(files, hDst, 'copy');
                return;
            }
        }
        // fractal の payload が無ければ **何もしない**（preventDefault もしない = 既存の挙動を奪わない）。
        // これだけで ADRL-0118 が却下した案 A の誤動作（他アプリ / outliner でコピーした後に
        // 古い fv payload が貼られる）が構造的に消える。
    }

    // HM-B-12: **プロセス内で 1 回だけ登録**する。destroy() は document / window レベルの listener を
    // 剥がさないため、open ごとに張ると累積して「cmd+v で N 枚貼られる」既発バグを再演する。
    // precedent: folder-view-dispatcher.js の window keydown（IIFE 内 module レベルで 1 回登録し、
    // ハンドラ内で isFolderViewShown() を動的に引く形）。
    if (!window.__fvClipboardBound) {
        window.__fvClipboardBound = true;
        document.addEventListener('paste', onDocumentPaste);
    }

    // `fvMovePreflight` は D&D の判断ロジックそのもの（純関数）。
    // precedent: `outliner.js` が `Outliner.selectionExportRoots()` を公開して
    // `outliner-multiselect-internal-move.spec.ts` が直接検証しているのと同型。
    //
    // 🔴 TASK-24 (DET-5 / QUAL-5): **`fvMoveIds` は削除した**。
    // 移動対象の解決規則（掴んだ行が選択に含まれるか / フォルダ除外 / 描画順）は
    // dragstart handler が payload を組む時点で既に適用されており（`:402-405` の
    // `inSelection` / `multi` / `selectedFilesForDnd()` / `selectedDirCount()`）、
    // drop 側（W1）はその payload を `extractBatchItems` で読むだけ。
    // `fvMoveIds` はこの規則の**二重実装**で、しかも**本番からは一度も呼ばれていなかった**
    // （spec が公開 API 経由で直叩きするだけの dead seam = ハーネス限定登録）。
    // dragstart が DataTransfer を組む以上この規則は dragstart 側に置くしかないので、
    // 配線し直すのではなく削除して payload を単一真実にした。
    // 解決規則の番人は TC-FMV-04/04b/04c（payload 観測）と TC-MSEL-05/05c/07。
    window.__folderView = {
        open: open, destroy: destroy,
        fvMovePreflight: fvMovePreflight, dispatchFvMove: dispatchFvMove,
        resolveDstFromRel: resolveDstFromRel,
    };
})();
