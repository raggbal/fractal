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
        /* 20261016 Notion 風ヘッダー（D1）: [☰ 開閉][note 名] の 1 行。☰ を先頭に固定し、名前は残り幅で ellipsis
         * （旧: [名前 … ☰] — 長い名前が ☰ を押し出して見えなくなっていた）。
         * 区切り線は持たない — ヘッダー / 検索行 / タブ行は 1 塊で、線はタブ行の下 1 本だけ（Notion のサイドバーと同じ）。 */
        .file-panel-header {
            display: flex; align-items: center; gap: 2px;
            min-height: 36px;
            padding: 4px 8px 2px 6px;
            box-sizing: border-box;
            flex-shrink: 0;
        }
        .file-panel-title {
            flex: 1; min-width: 0;
            font-weight: 600; font-size: 12px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            padding: 3px 5px;
            border-radius: var(--fr-radius-xs, 4px);
            cursor: pointer;
        }
        /* クリックで rename できることを hover の面で示す（編集中は出さない） */
        .file-panel-title:not(.editing):hover { background: rgba(128, 128, 128, 0.12); }
        .file-panel-title.editing { text-overflow: clip; cursor: text; }
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
        /* notes file panel の ≡ (collapse) ボタン: 枠線なし、アイコン 15px、hover 水色
         *（D9: main pane の再表示ボタン 3 個と同じ ☰ / 同じ hover のまま。ヘッダーの先頭で縮ませない） */
        #filePanelCollapse.file-panel-btn {
            border: none;
            border-radius: 4px;
            background: transparent;
            padding: 4px 5px;
            font-size: 15px;
            flex-shrink: 0;
        }
        #filePanelCollapse.file-panel-btn:hover {
            background: var(--selection-bg);
            border-color: transparent;
        }
        #filePanelCollapse.file-panel-btn:focus-visible {
            box-shadow: none;
            border-color: transparent;
        }
        .file-panel-list { flex: 1; overflow-y: auto; padding: 4px 0; }
        /* FR-TKN-01 rev（ユーザー裁定 2026-09-06・手動検収）: キーボードナビのために tabindex="0" を持たせた
         * 結果、フォーカス時にブラウザ既定の focus ring（青枠）がパネル全体に出るのを止める。
         * **フォーカス位置の情報は失われない** — focus 行は選択色（water-blue）で示される（FR-TKN-06）。 */
        .file-panel-list:focus,
        .file-panel-list:focus-visible { outline: none; }

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
        /* FR-MSEL-03（sprint 20260901-075849）: 連続範囲選択のハイライト。
         * .active（= 開いている 1 件）とは別概念なので別クラスにする（両方付くこともある）。
         * hover と同系色の面塗りで「選ばれている集合」を示す。 */
        .file-panel-item.file-panel-selected,
        .file-panel-item.file-panel-selected:hover {
            /* 2026-09-04 R16 rev2（ユーザー裁定）: note tree / linkedfd の複数選択は青系 --fr-color-selection-bg
             *（黄色は「うざい」で却下。outliner の範囲選択だけ黄色 = 編集面の focus 行（青）と区別する役割差） */
            background: var(--fr-color-selection-bg, var(--outliner-active, #d8e8f8));
        }
        /* FR-TKN-06 rev（ユーザー裁定 2026-09-06・手動検収）: **仮想フォルダのヘッダ行**も ↑↓ の focus 行に
         * なるので同じ選択色を出す。旧実装は paintTreeSelection がクラスを付けていたのに、色のルールが
         * .file-panel-item. 限定で folder header に当たらず「フォルダだけ青くならない」状態だった。
         * 色は item と**同一の変数**を使う（新色を作らない）。 */
        .file-panel-folder-header.file-panel-selected,
        .file-panel-folder-header.file-panel-selected:hover {
            background: var(--fr-color-selection-bg, var(--outliner-active, #d8e8f8));
        }
        .file-panel-item:hover,
        .file-panel-item.active:hover { background: var(--fr-color-selection-bg, var(--outliner-active, #d8e8f8)); }
        .file-panel-item.active::before {
            content: ''; position: absolute; left: 0; top: 4px; bottom: 4px;
            /* 「ノート」タブ underline と同じ太さ・色 (1px / primary) */
            width: 1px; background: var(--fr-color-selection-bar, var(--fr-color-primary, currentColor));
            border-radius: 0;
        }
        .file-panel-item-icon { flex-shrink: 0; opacity: 0.5; width: 13px; height: 13px; }
        .file-panel-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        /* ── Folder ── */
        .file-panel-folder { }
        .file-panel-folder-header {
            /* folder-icon を file-item の icon と同じ開始位置に揃えるため、file-item と同一の
             * padding(11px) + gap(5px) にし、chevron は position:absolute でフローから外す。
             * これで先頭のフロー要素 = folder-icon が file-icon と同じ x に来る（FR-FA-01）。*/
            padding: 5px 11px; cursor: pointer; font-size: 12px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            border-radius: var(--fr-radius-sm, 6px); margin: 1px 4px;
            display: flex; align-items: center; gap: 5px;
            font-weight: 500;
            position: relative;
        }
        .file-panel-folder-header:hover { background: var(--fr-color-selection-bg, var(--outliner-hover, #e8e8e8)); }
        .file-panel-folder-chevron {
            /* padding-left(11px) の内側に絶対配置。folder-icon(x=11) に被らないよう幅を詰める。*/
            position: absolute; left: 0; top: 50%;
            transform: translateY(-50%);
            width: 11px; height: 13px;
            display: flex; align-items: center; justify-content: center;
            transition: transform 0.15s;
            opacity: 0.6;
        }
        .file-panel-folder.collapsed > .file-panel-folder-header > .file-panel-folder-chevron {
            transform: translateY(-50%) rotate(-90deg);
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
        /* FR-TF-16 (sprint 20260809 再オープン③): drag セッション中は hover 背景を出さない。
         * hover 色が「その item の中に drop できる」誤演出になるため、drag 中の drop 可視化は
         * 専用表示 (.file-panel-drag-over 系 / drop-line) だけに一本化する。
         * body.fr-drag-active の set/clear は notes-file-panel.js（受け側完結: dragenter/dragover で set・
         * relaxed dragleave + drop + dragend + window 安全網で clear — cross-webview/外部 drag は
         * drag 元の dragend が届かないため受け側イベントで管理する）。
         * 注: 既存 hover 規則 (:134/:158) は書き換えない（.active:hover の specificity 同点勝ちを
         * 維持するため追加規則で上書きする）。table-resizing 型の * !important 全域上書きは
         * drop 専用表示まで殺すため採らない (ADRL-C Decision 1)。 */
        /* :not(drag-over 系) — drag 中は :hover と drop 専用表示が同一要素で同時成立するため、
         * 除外しないとこのガード (specificity 0,3,1) が専用表示 (0,1,0) に勝って highlight まで消す */
        body.fr-drag-active .file-panel-item:hover:not(.file-panel-drag-over):not(.file-panel-drag-over-md-into-out),
        body.fr-drag-active .file-panel-item.active:hover:not(.file-panel-drag-over):not(.file-panel-drag-over-md-into-out),
        body.fr-drag-active .file-panel-folder-header:hover:not(.file-panel-drag-over):not(.file-panel-drag-over-md-into-out) { background: transparent; }
        .file-panel-drag-over { background: var(--fr-color-selection-bg, var(--outliner-active, #d8e8f8)); border-radius: var(--fr-radius-sm, 6px); }
        /* v0.207.77 (D&D Feature A): md → .out item のドロップ時 yellow highlight。
           既存の青系 .file-panel-drag-over (folder hover) と区別する。 */
        .file-panel-drag-over-md-into-out {
            background: var(--fr-color-warning-bg, rgba(255, 215, 64, 0.35));
            outline: 2px solid var(--fr-color-warning, #f5a623);
            outline-offset: -2px;
            border-radius: var(--fr-radius-sm, 6px);
        }
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
        /* sprint 20260723-233506: tab bar 追加で .notes-main-wrapper が [tab-bar | container] の
           2 段 flex column になった。container 側は height:100vh（outliner.css）だと tab bar 分溢れて
           下端がクリップされ、内側スクロールで tab bar が押し出されて隠れる。→ wrapper 直下の
           container を flex:1 + min-height:0 で「残り高さ」に収め、内側（.editor-wrapper /
           .outliner-scroll-content）だけがスクロールするようにする（tab bar は flex:0 0 auto で常時上端固定）。 */
        .notes-main-wrapper > .outliner-container,
        .notes-main-wrapper > .markdown-container {
            flex: 1 1 auto;
            min-height: 0;
            height: auto;   /* outliner.css の height:100vh を上書き。flex で「残り高さ」に収める */
        }
        /* md pane の内側 .container は height:100vh（styles.css:26）なので、flex で正しくサイズされた
           .markdown-container にフィットさせる（100vh のままだと tab bar 分溢れて下端クリップ）。 */
        .notes-main-wrapper > .markdown-container > .container { height: 100%; }
        /* sprint 20260723-233506: webview 内マルチタブ tab bar（tabs>=2 で Tab Manager が display:flex に）。
           tab 領域だけ左右スクロール（FR-TAB-05）。1 タブ時は display:none（初期 inline style）。 */
        .notes-tab-bar {
            display: none;
            /* tab を全高まで伸ばして下の境界線に接地させる（center だと tab と線の間に隙間が出る） */
            align-items: stretch;
            flex: 0 0 auto;
            min-height: 30px;
            /* 下境界線は border ではなく inset box-shadow で bar の内側最下行に描く（全幅・tab の無い右側も含む）。
               active tab の背景（子・bar 内側の最下行まで届く）が後から描画されてこの線を覆う＝active 下だけ線が消える。
               border-bottom（padding box の外に描画）だと子が margin で覆えず overflow でクリップされる問題を回避。 */
            box-shadow: inset 0 -1px 0 var(--border-color, rgba(128,128,128,0.25));
            background: var(--sidebar-bg, rgba(128,128,128,0.06));
        }
        .notes-tab-bar .notes-tab-bar-scroll {
            display: flex;
            align-items: stretch;
            flex: 1 1 auto;
            overflow-x: auto;
            overflow-y: hidden;
            scrollbar-width: thin;
        }
        .notes-tab-bar .notes-tab-bar-scroll::-webkit-scrollbar { height: 4px; }
        .notes-tab-bar .notes-tab {
            display: flex;
            align-items: center;
            gap: 5px;
            flex: 0 0 auto;
            min-width: 90px;
            max-width: 200px;
            padding: 4px 8px;
            font-size: 12px;
            border-right: 1px solid var(--border-color, rgba(128,128,128,0.2));
            cursor: pointer;
            opacity: 0.65;
            white-space: nowrap;
            user-select: none;
            /* sprint 20260724-063158 (FR-TP-05): 非選択タブ = 灰オーバーレイ（地色に灰を重ねて沈ませる。
               --sidebar-bg と --bg-color が同色のテーマでも確実にコントラストが出るよう rgba 灰を明示）。 */
            background: rgba(128,128,128,0.14);
        }
        .notes-tab-bar .notes-tab:hover { opacity: 0.85; }
        .notes-tab-bar .notes-tab[data-active="true"] {
            opacity: 1;
            /* sprint 20260724-063158 (FR-TP-05): 選択タブ = 明るい地色（コンテンツ地続き＝目立つ・灰を重ねない）。
               背景が bar 内側の最下行まで届き、bar の inset 下線をこの部分だけ覆う＝active 下の線が消え editor と地続き。 */
            background: var(--bg-color, #ffffff);
        }
        .notes-tab-bar .notes-tab-title {
            /* title が min-width より短くても余白を埋めて伸び、close ボタンをタブ右端へ押し出す */
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .notes-tab-bar .notes-tab-close {
            flex: 0 0 auto;
            border: none;
            background: transparent;
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            padding: 0 2px;
            opacity: 0.5;
            color: inherit;
        }
        .notes-tab-bar .notes-tab-close:hover { opacity: 1; }
        .notes-tab-bar .notes-tab-add {
            flex: 0 0 auto;
            border: none;
            background: transparent;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            padding: 0 8px;
            opacity: 0.6;
            color: inherit;
        }
        .notes-tab-bar .notes-tab-add:hover { opacity: 1; }
        /* FR-TB-03 (sprint 20260728-100501): タブ D&D 並べ替えの挿入位置インジケータ */
        .notes-tab-bar .notes-tab-drop-line {
            flex: 0 0 auto;
            width: 2px;
            align-self: stretch;
            background: var(--vscode-focusBorder, #007acc);
            pointer-events: none;
        }
        /* v0.207.88: notes md メインペインの toolbar アイコンを sidepanel md / outliner header
           の色味と揃える。standalone editor の color: var(--text-color) は #1A1B1F の真っ黒で
           outliner-search-bar/side-panel-header-btn の opacity: 0.5-0.6 軽減と乖離するため、
           notes md main pane のみ scoped に opacity を当てる (standalone editor は影響なし)。 */
        .notes-main-wrapper .markdown-container .toolbar button {
            opacity: 0.6;
        }
        .notes-main-wrapper .markdown-container .toolbar button:hover:not(:disabled) {
            opacity: 1;
        }
        .notes-main-wrapper .markdown-container .toolbar button:disabled {
            opacity: 0.3;
        }
        /* notes editor > markdown の outline header を file-panel-header と揃える
           (standalone / sidepanel md は影響なし — scoped セレクタ) */
        .notes-main-wrapper .markdown-container .sidebar .sidebar-header {
            padding: 7px 11px;
            border-bottom: 1px solid var(--fr-color-divider, var(--outliner-border, #e0e0e0));
            box-sizing: border-box;
        }
        .notes-main-wrapper .markdown-container .sidebar .sidebar-header h3 {
            font-size: 12px;
            font-weight: 600;
            white-space: nowrap;
        }
        .notes-main-wrapper .markdown-container .sidebar .sidebar-toggle {
            font-size: 15px;
            padding: 4px 5px;
            line-height: 1;
            background: transparent;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            color: var(--fr-color-text-primary, inherit);
            opacity: 0.7;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .notes-main-wrapper .markdown-container .sidebar .sidebar-toggle:hover {
            opacity: 1;
            background: var(--selection-bg);
        }
        /* notes panel toggle (≡) — outliner / markdown 共通ベース、font-size 15px */
        .notes-panel-toggle-btn,
        .toolbar button.notes-panel-toggle-btn {
            background: transparent; border: none; border-radius: 4px;
            cursor: pointer; padding: 4px 5px; line-height: 1;
            display: none; color: var(--fr-color-text-primary, inherit);
            opacity: 0.7; font-size: 15px;
            align-items: center; justify-content: center; flex-shrink: 0; margin-right: 5px;
            min-width: 0; min-height: 0;
        }
        /* outliner pane: hover で薄く色付け（既存トーン維持、塗りつぶしなし） */
        .notes-panel-toggle-btn:hover {
            opacity: 1;
            background: transparent;
        }
        /* markdown pane: hover で水色塗りつぶし (markdown toolbar の他ボタンと同じ var(--selection-bg)) */
        .toolbar button.notes-panel-toggle-btn:hover {
            opacity: 1;
            background: var(--selection-bg);
        }
        .notes-panel-toggle-btn:focus-visible {
            outline: none;
            box-shadow: none;
        }
        /* file panel 閉のとき toggle を出す。全 3 個（① outliner pane / ② md toolbar / ③ md Outline ヘッダ）を
           それぞれ個別ルールで制御（旧ブランケットルールは全マッチで ②③ 二重表示になるため分割）。 */
        /* ① outliner pane（#notesPanelToggleBtn）: file panel 閉なら Outline 開閉に関わらず常に表示（従来挙動・回帰防止） */
        .notes-file-panel.collapsed ~ .notes-main-wrapper #notesPanelToggleBtn { display: flex; }
        /* ② md toolbar 左端: Outline 閉（#sidebar.hidden）のときだけ表示 */
        .notes-file-panel.collapsed ~ .notes-main-wrapper #sidebar.hidden ~ .editor-container .notes-panel-toggle-btn--toolbar { display: flex; }
        /* ③ md Outline ヘッダ左: Outline 開（#sidebar が .hidden でない）のときだけ表示（②と排他 = 単一ボタン） */
        .notes-file-panel.collapsed ~ .notes-main-wrapper #sidebar:not(.hidden) .notes-panel-toggle-btn--outline { display: flex; }
        .file-panel-rename-input {
            width: 100%; padding: 4px 7px; font-size: 12px;
            border: 1px solid var(--fr-color-primary, var(--outliner-active, #4a9eff));
            border-radius: var(--fr-radius-sm, 6px); outline: none;
            background: var(--fr-color-bg-elevated, var(--outliner-bg, #fff));
            color: var(--fr-color-text-primary, inherit);
            box-shadow: var(--fr-shadow-focus, 0 0 0 3px rgba(79, 107, 255, 0.25));
        }
        .file-panel-item.is-folder-link .file-panel-folderlink-icon { color: var(--fr-color-accent, #4a86d9); }
        .file-panel-item.is-folder-link.is-broken { opacity: 0.55; }
        .file-panel-item.is-folder-link.is-broken .file-panel-item-title { text-decoration: line-through dotted; }
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

        /* ── Tabs（D3: 選択中だけ「アイコン + ラベル」の pill、非選択はアイコンのみの四角ボタン。左寄せで伸ばさない）── */
        .file-panel-tabs {
            display: flex; align-items: center; justify-content: flex-start; gap: 2px;
            padding: 2px 6px 6px;
            border-bottom: 1px solid var(--fr-color-divider, var(--outliner-border, #e0e0e0));
            flex-shrink: 0; min-width: 0;
        }
        .file-panel-tab {
            flex: 0 0 auto; display: flex; align-items: center; justify-content: center; gap: 5px;
            height: 26px; min-width: 26px; padding: 0 6px;
            border: none; border-radius: var(--fr-radius-sm, 6px);
            background: transparent; cursor: pointer;
            font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1;
            color: var(--fr-color-text-secondary, inherit);
            /* fr-base の色 transition は当てない（従来どおり。active の切替を即時に見せる） */
            transition: none;
        }
        /* Results タブ（D2）は検索するまで hidden 属性で隠す。display:flex が UA の [hidden] に勝つので明示 */
        .file-panel-tab[hidden] { display: none; }
        .file-panel-tab:hover {
            background: rgba(128, 128, 128, 0.07);
            color: var(--fr-color-text-primary, inherit);
        }
        /* 選択中 = 薄いグレーの pill。狭い幅（PANEL_MIN_WIDTH 140px）ではラベルだけ ellipsis で縮む */
        .file-panel-tab.active {
            flex: 0 1 auto; min-width: 0;
            padding: 0 8px 0 7px;
            background: rgba(128, 128, 128, 0.09);
            color: var(--fr-color-text-primary, inherit);
        }
        .file-panel-tab svg { flex-shrink: 0; }
        .file-panel-tab-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .file-panel-tab:not(.active) .file-panel-tab-label { display: none; }
        .file-panel-content { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
        .file-panel-content-actions {
            display: flex; gap: 4px; padding: 5px 7px;
            border-bottom: 1px solid var(--outliner-border, #e0e0e0); flex-shrink: 0;
        }
        .file-panel-content-actions .file-panel-btn { font-size: 11px; padding: 4px 7px; }
        /* v0.207.37: お気に入り section (Notes タブ直下、空なら非表示)。
         *  Notes タブのすぐ下に常時表示し、actions row + tree より上に出す。 */
        .file-panel-favorites {
            border-bottom: 1px solid var(--fr-color-divider, var(--outliner-border, #e0e0e0));
            padding: 4px 0 6px 0;
            flex-shrink: 0;
            max-height: 40vh;
            overflow-y: auto;
        }
        .file-panel-favorites-header {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 3px 11px 4px;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--fr-color-text-tertiary, #888);
            font-weight: 600;
        }
        .file-panel-favorites-header svg {
            fill: var(--fr-color-primary, currentColor);
            stroke: var(--fr-color-primary, currentColor);
        }

        /* ── Search ── */
        /* 共通の入力欄（Tools の S3 bucket 欄も使う） */
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
        /* 20261016 常設の検索行（D1/D2）: ヘッダー直下に検索 BOX（旧: Search タブの中）。
         * D13/D15: Aa/W/.* と ✕ は BOX の中の右端に置き、BOX に focus がある間だけ出す。
         * 非 focus の BOX は従来の幅（行 − 旧 Aa/W/.* 3 つ分）、focus で行いっぱいに伸びる */
        .file-panel-search-bar {
            display: flex; align-items: center; gap: 4px;
            padding: 2px 8px 4px;
            box-sizing: border-box;
            flex-shrink: 0; min-width: 0;
        }
        .file-panel-search-box {
            flex: 0 1 auto; min-width: 0; position: relative;
            width: calc(100% - 66px);
            transition: width 0.15s ease;
        }
        .file-panel-search-box:focus-within { width: 100%; }
        /* 検索欄: 枠線なし + outliner の検索 BOX と同じ面。focus で primary 枠 */
        .file-panel-search-box .file-panel-search-input {
            display: block; height: 26px; padding: 0 7px;
            border-color: transparent;
            /* outliner の検索 BOX（.outliner-search-input）と同じ面の色（ライトでは白） */
            background: var(--outliner-search-bg, var(--vscode-input-background, #fff));
            color: var(--outliner-search-fg, var(--vscode-input-foreground, inherit));
            font-family: inherit;
        }
        .file-panel-search-box .file-panel-search-input:focus {
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));
        }
        /* D13: BOX 内右端の [✕][Aa][W][.*]。focus 中だけ出し、その分だけ入力欄の右に余白を取る */
        .file-panel-search-inline {
            position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
            display: flex; align-items: center; gap: 1px;
        }
        .file-panel-search-box:not(:focus-within) .file-panel-search-inline { display: none; }
        /* 幅が伸びきってから出す（狭いパネルで伸びる途中のボタンが BOX の左へはみ出して見えないように） */
        .file-panel-search-box:focus-within .file-panel-search-inline { animation: fp-search-inline-in 0.1s ease 0.15s both; }
        @keyframes fp-search-inline-in { from { opacity: 0; } to { opacity: 1; } }
        .file-panel-search-box:focus-within .file-panel-search-input { padding-right: 62px; }
        .file-panel-search-box:focus-within .file-panel-search-input:not(:placeholder-shown) { padding-right: 79px; }
        /* D12/D14: 入力があるときだけ Aa の左に ✕（outliner の .outliner-search-clear-btn と同じ見た目）。空欄 = placeholder 表示中は隠す */
        .file-panel-search-clear-btn {
            display: flex; align-items: center; justify-content: center;
            background: none; border: none; cursor: pointer;
            padding: 2px; opacity: 0.5; line-height: 0;
            color: var(--outliner-search-fg, var(--vscode-input-foreground, inherit));
        }
        .file-panel-search-clear-btn:hover { opacity: 1; }
        .file-panel-search-input:placeholder-shown + .file-panel-search-inline .file-panel-search-clear-btn { display: none; }
        .file-panel-search-box .file-panel-search-input::placeholder {
            color: var(--fr-color-text-tertiary, var(--outliner-placeholder, #999)); opacity: 1;
        }
        .file-panel-search-options { display: flex; align-items: center; gap: 1px; flex-shrink: 0; }
        .file-panel-search-opt-btn {
            display: inline-flex; align-items: center; justify-content: center;
            min-width: 18px; height: 20px; padding: 0 3px;
            font-family: inherit; font-size: 10px; line-height: 1;
            border: 1px solid transparent;
            border-radius: var(--fr-radius-xs, 4px);
            cursor: pointer; opacity: 0.75; background: transparent;
            color: var(--fr-color-text-secondary, inherit);
        }
        .file-panel-search-opt-btn:hover { opacity: 1; background: rgba(128, 128, 128, 0.12); }
        .file-panel-search-opt-btn.active {
            border-color: var(--fr-color-primary, var(--vscode-focusBorder, #007acc)); opacity: 1;
            color: var(--fr-color-text-primary, inherit);
            background: var(--fr-color-primary-soft, transparent);
        }
        /* 上 padding は 0（sticky のリンク行の上にスクロールした結果が 4px 覗く隙間になっていた — 2026-10-23） */
        .file-panel-search-results { flex: 1; overflow-y: auto; padding: 0 0 4px; }
        .file-panel-search-section { margin-bottom: 5px; }
        /* 色は fractal の青系トークン（--vscode-textLink-foreground はテーマ次第で紫になる — 2026-10-23）。
         * 種別名（Outliner results 等）は文字を灰色 + 青の下線、ファイル名は青の文字で見分ける */
        .file-panel-search-section-title {
            padding: 6px 9px 3px; font-size: 10px; font-weight: 700;
            color: var(--fr-color-text-secondary, #6B6F76);
            border-bottom: 2px solid var(--fr-color-primary, #9CC8DC);
            text-transform: none; letter-spacing: 0.02em;
        }
        .file-panel-search-file-group { margin-bottom: 4px; }
        .file-panel-search-file-header {
            padding: 4px 11px; font-size: 10px; font-weight: 600;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            color: var(--fr-color-primary-strong, #3994BC);
        }
        .file-panel-search-file-glyph { margin-right: 4px; font-size: 11px; line-height: 1; }
        .file-panel-search-file-icon { width: 12px; height: 12px; margin-right: 4px; vertical-align: -2px; opacity: 0.8; }
        /* 結果の一番上: 種別ごとのセクションへ飛ぶリンク（スクロールしても上に残す） */
        .file-panel-search-jump {
            position: sticky; top: 0; z-index: 1;
            display: flex; flex-wrap: wrap; gap: 2px 10px; padding: 4px 9px 5px;
            font-size: 10px; background: var(--fr-color-bg-panel, var(--outliner-bg, #fafafa));
            border-bottom: 1px solid var(--vscode-panel-border, var(--outliner-border, #e0e0e0));
        }
        .file-panel-search-jump-link {
            color: var(--fr-color-primary-strong, #3994BC); cursor: pointer; text-decoration: none;
        }
        .file-panel-search-jump-link:hover { text-decoration: underline; }
        .file-panel-search-match {
            padding: 4px 11px 4px 18px; font-size: 11px; cursor: pointer;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .file-panel-search-match:hover { background: var(--fr-color-selection-bg, var(--outliner-hover, #e8e8e8)); }
        .file-panel-search-highlight { background: rgba(255, 200, 0, 0.3); font-weight: 500; }
        /* Yellow flash for explore-tree jump (search → notes tab) */
        @keyframes file-panel-explore-flash-kf {
            0%   { background: rgba(255, 215, 64, 0.85); }
            60%  { background: rgba(255, 215, 64, 0.55); }
            100% { background: rgba(255, 215, 64, 0); }
        }
        .file-panel-explore-flash {
            animation: file-panel-explore-flash-kf 2s ease-out;
            border-radius: var(--fr-radius-sm, 6px);
        }
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
                <button class="file-panel-btn" id="filePanelCollapse" title="${m('notesCollapsePanel', 'Collapse panel')} (Cmd+\\)">&#9776;</button>
                <span class="file-panel-title" id="notesTitleLabel" title="${m('notesRenameNoteTitle', 'Click to rename this note')}"></span>
            </div>
            <!-- 20261016 (D1/D2): 常設の検索行（ショートカット表記は出さない — D10）。Search タブは廃止し、検索すると Results タブが現れる -->
            <div class="file-panel-search-bar" id="notesSearchBar">
                <div class="file-panel-search-box">
                    <input type="text" class="file-panel-search-input" id="notesSearchInput" placeholder="${m('notesSearchPlaceholder', 'Search...')}" aria-label="${m('notesTabSearch', 'Search')}" />
                    <div class="file-panel-search-inline" id="notesSearchInline">
                        <button class="file-panel-search-clear-btn" id="notesSearchClear" type="button" title="Clear search" aria-label="Clear search"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        <div class="file-panel-search-options">
                            <button class="file-panel-search-opt-btn" id="notesSearchCase" type="button" title="${m('notesMatchCase', 'Match Case')}">Aa</button>
                            <button class="file-panel-search-opt-btn" id="notesSearchWord" type="button" title="${m('notesWholeWord', 'Whole Word')}">W</button>
                            <button class="file-panel-search-opt-btn" id="notesSearchRegex" type="button" title="${m('notesUseRegex', 'Use Regex')}">.*</button>
                        </div>
                    </div>
                </div>
            </div>
            <!-- D3: 選択中のタブだけラベルを出す（非選択はアイコンのみ。ラベルは title / aria-label に残す） -->
            <div class="file-panel-tabs" role="tablist">
                <button class="file-panel-tab active" data-tab="notes" title="${m('notesTabNotes', 'Notes')}" aria-label="${m('notesTabNotes', 'Notes')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 13h-2"/><path d="M10 17H8"/><path d="M16 17h-2"/></svg>
                    <span class="file-panel-tab-label">${m('notesTabNotes', 'Notes')}</span>
                </button>
                <button class="file-panel-tab" data-tab="tools" title="${m('notesTabTools', 'Tools')}" aria-label="${m('notesTabTools', 'Tools')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg>
                    <span class="file-panel-tab-label">${m('notesTabTools', 'Tools')}</span>
                </button>
                <!-- D2/D7/D11: 検索を走らせると現れる（BOX を空にすると消える）。中身は #filePanelContentSearch -->
                <button class="file-panel-tab" data-tab="results" id="filePanelTabResults" title="${m('notesTabResults', 'Results')}" aria-label="${m('notesTabResults', 'Results')}" hidden>
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    <span class="file-panel-tab-label">${m('notesTabResults', 'Results')}</span>
                </button>
            </div>
            <div class="file-panel-content" id="filePanelContentNotes">
                <!-- v0.207.37: お気に入り section (空なら非表示) — Notes タブ直下、actions より上 -->
                <div class="file-panel-favorites" id="notesFavoritesList" style="display:none"></div>
                <div class="file-panel-content-actions">
                    <button class="file-panel-btn" id="filePanelAddFolder" title="${m('notesNewFolder', 'New Folder')}"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg></button>
                    <button class="file-panel-btn" id="filePanelAdd" title="${m('notesAddOutliner', 'Add outliner (.out)')}"><span style="font-size:10px;font-weight:700;letter-spacing:-0.5px">+out</span></button>
                    <button class="file-panel-btn" id="filePanelAddMarkdown" title="${m('notesNewMarkdown', 'New Markdown')}"><span style="font-size:10px;font-weight:700;letter-spacing:-0.5px">+md</span></button>
                    <button class="file-panel-btn" id="filePanelAddFileEntity" title="${m('notesAddFile', 'Add File')}"><span style="font-size:10px;font-weight:700;letter-spacing:-0.5px">+file</span></button>
                    <button class="file-panel-btn" id="filePanelAddFolderLink" title="${m('folderLinkAdd', 'Link Folder')}"><span style="font-size:10px;font-weight:700;letter-spacing:-0.5px">+linkfd</span></button>
                    <span style="flex:1"></span>
                    <button class="file-panel-btn" id="filePanelToday" title="${m('notesToday', 'Today')}"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="16" height="16" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${m('notesToday', 'Today')}</button>
                </div>
                <!-- FR-TKN-01: キーボードナビ（↑↓ + Enter）の受け口。要素ローカル keydown を張るため tabindex を持たせる -->
                <div class="file-panel-list" id="notesFileList" tabindex="0"></div>
            </div>
            <!-- Results タブの中身（D11: id は旧 Search タブのまま維持。入力欄は上の検索行へ移した） -->
            <div class="file-panel-content" id="filePanelContentSearch" style="display:none">
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
            <div class="side-panel-history" id="sidePanelHistory">
                <div class="side-panel-history-resize-handle" id="sidePanelHistoryResizeHandle" title="Drag to resize"></div>
                <div class="side-panel-history-header">
                    <span class="side-panel-history-title">${m('recentFilesLabel', 'Recent')}</span>
                    <button class="side-panel-history-toggle" id="sidePanelHistoryToggle" title="${m('toggleRecent', 'Toggle recent files')}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>
                <div class="side-panel-history-list" id="sidePanelHistoryList"></div>
            </div>
        </aside>
        <div class="notes-resize-handle" id="notesResizeHandle"></div>`;

    return { css: css, html: html };
}

module.exports = { generateNotesFilePanelHtml };
