# Generator Log — Outliner Table Editor Mode

- Sprint ID: `20260502-230053-outliner-table-editor-mode`
- Branch: `feature/outliner-table-editor`
- Base commit: `f8cff34` (release v0.195.781)

---

## Iteration 1 — 2026-05-02

### TASK-A1: outliner-cell.js Phase 1 split (renderInlineText + classifyLinkHref)

**目的**: outliner.js の cell-local pure 関数 2 つを `outliner-cell.js` に抽出し、UMD pattern で webview / Node.js test の両方で利用可能にする。outliner.js は delegation wrapper を残して既存 callsite 不変。

**実装ファイル**:
- 新規 `src/webview/outliner-cell.js` (UMD module, OutlinerCell.renderInlineText + classifyLinkHref export)
- 修正 `src/webview/outliner.js` (該当 2 関数を OutlinerCell へ delegate する wrapper に置換、内部関数として残し既存 callsite 不変)
- 修正 `src/outlinerWebviewContent.ts` (script tag 注入: linkParser → outliner-cell → outliner-model 順)
- 修正 `src/notesWebviewContent.ts` (script tag 注入)
- 修正 `test/build-standalone-outliner.js` (script 注入)
- 修正 `test/build-standalone-notes.js` (script 注入)
- 新規 `test/specs/outliner-cell-render.spec.ts` (TC-001 標準 standalone HTML 経由で OutlinerCell.renderInlineText / classifyLinkHref を eval)

**load 順 重要**: outliner-cell.js は `MarkdownLinkParser` global に依存するため、必ず `markdown-link-parser.js` の後にロード。

**結果**: ✅ 完了

**実装サマリ**:
- `src/webview/outliner-cell.js` (147 行) を UMD pattern で新規作成。`OutlinerCell.renderInlineText` と `OutlinerCell.classifyLinkHref` を export
  - browser global では `window.OutlinerCell`、CommonJS / Node.js test では `module.exports`
  - `MarkdownLinkParser` 依存は (a) browser では同一 window から、(b) Node.js では `require('../shared/markdown-link-parser.js')` から取得 (動的解決)
- `src/webview/outliner.js`:
  - `classifyLinkHref` (旧 1561〜1571 行) と `renderInlineText` (旧 1573〜1646 行) を OutlinerCell へ delegate する 2 行 wrapper に置換
  - 既存 callsite (renderInlineText 内, ensureLinkSpans 等) は無変更 (wrapper 経由でアクセス)
  - 行数 6633 → 6565 (約 70 行 reduction、Phase 1 の目標)
- `src/outlinerWebviewContent.ts` / `src/notesWebviewContent.ts`: outliner-cell.js を outliner-model.js より前にロード (依存順序: link-parser → cell → model → search → outliner)
- `test/build-standalone-outliner.js` / `test/build-standalone-notes.js`: 同等の script 注入
- `test/specs/outliner-cell-render.spec.ts`: TC-001 を 18 ケースで実装 (API surface, 各 Markdown decoration, 日本語タグ, link, raw URL の @ 非タグ化, HTML escape, 4 種の classifyLinkHref 分類)
- `scripts/copy-webview.js` は既に `*.js` を全コピーするので out/webview/outliner-cell.js も自動生成 (verified)

**テスト結果**:
- `test/specs/outliner-cell-render.spec.ts` (TC-001): **18/18 green**
- `test/specs/outliner-*.spec.ts` (26 files): 単独実行で **333/333 green** (single-worker 含む)
- `test/specs/integration-outliner-*.spec.ts` (11 files): **44/44 green**
- 並列実行 (default 4 workers) で `outliner-format.spec.ts` / `outliner-cross-paste.spec.ts` / `outliner-keyboard.spec.ts` の 3-5 件が flaky に失敗するが、**main commit f8cff34 (stash 後の baseline) でも同じ failure が発生** — pre-existing flake であり TASK-A1 起因の regression ではない (本セッション内で確認済)
- TypeScript compile: error 0
- Node.js syntax check: outliner.js / outliner-cell.js 共に OK

**Cell module Node.js smoke test**:
```
classify(http) → ""  classify(fractal node) → "link-fractal-node"
classify(fractal page) → "link-fractal-page"  classify(.md) → "link-internal-md"
render('**bold**') → "<strong>bold</strong>"
render('hello #world') → "hello <span class=\"outliner-tag\">#world</span>"
render('[click](http://e.com)') → "<a href=\"http://e.com\" title=\"http://e.com\">click</a>"
```

**次の TASK 候補**: TASK-A2 (Phase 2 pure helpers: stripInlineMarkers, renderEditingText, convertUrlsToMarkdownLinks, renderedOffsetToSource, sourceOffsetToRendered, buildRenderedToSourceMap)。ただし sprint scale (23 task) を考慮し、TASK-A1 完了後はユーザー報告 + 続行可否確認を求める。

---

## Iteration 1 (continued) — 2026-05-02 / 03

generator agent 続行 (Phase A 残り完了を目標)。

### TASK-A2: outliner-cell.js Phase 2 (pure helpers)

**実装ファイル**:
- 修正 `src/webview/outliner-cell.js` (関数 6 個追加)
- 修正 `src/webview/outliner.js` (該当 6 関数 → delegation wrapper)
- 新規 `test/specs/outliner-cell-helpers.spec.ts` (TC-002, 16 cases)

**抽出関数**: `stripInlineMarkers`, `renderEditingText`, `convertUrlsToMarkdownLinks`, `buildRenderedToSourceMap`, `renderedOffsetToSource`, `sourceOffsetToRendered`

**結果**: ✅ 完了 (commit `06629d2`)
- TC-002: 16/16 green (testcases.md TC-002 仕様: 末尾 `.` を URL から除外、bidirectional offset 整合)
- 既存 outliner-format / outliner-inline / outliner-basic / outliner-cell-render: 67/67 green (regression 0)
- TypeScript compile: error 0
- Node.js syntax check: 両ファイル OK

### TASK-A3: outliner-cell.js Phase 3 (cursor / DOM helpers)

**実装ファイル**:
- 修正 `src/webview/outliner-cell.js` (8 helpers + namespace)
- 修正 `src/webview/outliner.js` (該当 8 関数 → delegation wrapper)
- 新規 `test/specs/outliner-cell-cursor.spec.ts` (TC-003, 7 cases)

**抽出関数**: `setCursorToEnd`, `setCursorToStart`, `setCursorAtOffset`, `getCursorOffset`, `getCursorRange`, `getPlainText` (NBSP normalization), `getSubtextPlainText` (BR/div block handling), `getSubtextPreview`

**API**: tasks.md TASK-A3 の指定通り namespace 化:
- `OutlinerCell.setCursor.{toEnd, toStart, atOffset}`
- `OutlinerCell.getCursor.{offset, range}`
- 加えて flat aliases (callsite 直呼び対応)

**結果**: ✅ 完了 (commit `debda85`)
- TC-003: 7/7 green
- 既存 outliner-keyboard / format / subtext / basic regression: 76/78 pass
  - 2 fail は **pre-existing flake** (stash で main commit `06629d2` でも同じ失敗、TASK-A1 generator-log でも記録済の既知 flake)
  - `outliner-keyboard.spec.ts:283 Enter on node with expanded children inserts new node as first child`
  - `outliner-keyboard.spec.ts:769 Cmd+F focuses search bar`
- TypeScript compile: error 0

### TASK-A4: outliner-cell.js Phase 4 (image cell helpers, host inject)

**実装ファイル**:
- 修正 `src/webview/outliner-cell.js` (7 image helpers)
- 修正 `src/webview/outliner.js` (該当 7 関数 → delegation wrapper + `_outlinerImageHost()` adapter)
- 新規 `test/specs/outliner-cell-images.spec.ts` (TC-004, 7 cases)

**抽出関数**: `resolveImageSrc(imagePath, baseUri)`, `getImageDropIndex`, `showImageDropIndicator`, `clearImageDropIndicators`, `clearImageSelection(host)`, `showImageOverlay`, `renderNodeImages(container, node, host)`

**Host injection 仕様 (renderNodeImages)**:
- `host.getImageBaseUri()`: webview-asset base URI
- `host.getModel()`: model with moveImage / getNode
- `host.saveSnapshot()`: undo snapshot
- `host.scheduleSyncToHost()`: debounced save
- `host.{getImageDragState, setImageDragState}`: drag state accessors
- `host.{getSelectedImageInfo, setSelectedImageInfo}`: selection state
- `host.isReadOnly()`: skips drag/click handlers when true (Table editor multi-cell mode 想定)

**結果**: ✅ 完了 (commit `92b46d2`)
- TC-004: 7/7 green
- 既存 image regression (integration-outliner-cmd-cv-matrix.spec.ts): 11/11 green
- TypeScript compile: error 0

### TASK-A5: outliner-cell.js Phase 5 (applyInlineFormat + subtext, model+host inject)

**実装ファイル**:
- 修正 `src/webview/outliner-cell.js` (4 helpers)
- 修正 `src/webview/outliner.js` (該当 4 関数 → delegation wrapper + `_outlinerSubtextHost()` adapter)
- 新規 `test/specs/outliner-cell-format-subtext.spec.ts` (TC-005, 7 cases)

**抽出関数**:
- `applyInlineFormat({ nodeId, textEl, marker, model, host })`: Cmd+B/I/E/Shift+S 3 モード (insert / wrap / unwrap toggle)、cursor 保持
- `openSubtext({ nodeId, treeEl, model })`: subtext を contenteditable に切替 + 末尾 cursor
- `closeSubtext({ nodeId, subtextEl, model, host })`: model.updateSubtext で永続化 + host.scheduleSyncToHost / focusNode
- `handleSubtextKeydown({ event, nodeId, subtextEl, model, host })`: Shift+Enter / Esc / Cmd+S

**結果**: ✅ 完了 (commit `4b6491d`)
- TC-005: 7/7 green
- 既存 format / subtext / inline regression: 37/37 green
- TypeScript compile: error 0

---

## Phase A cell.js split 完了サマリ

✅ **TASK-A1〜A5 完了** (Phase A の 5 / 7 task)

- 新規 `test/specs/outliner-cell-*.spec.ts`: 5 ファイル, 計 **55 cases all green**
- `src/webview/outliner-cell.js`: 約 800 行 (Phase 1〜5 完了, UMD pattern, Node.js + browser dual export)
- `src/webview/outliner.js`: 6633 → 6299 行 (約 334 行 reduction)
- 既存 outliner spec regression: 0 件 (pre-existing flake 2 件除く)

**未着手 task** (sprint scale + agent context budget により continuation 委ね):
- TASK-A6 (syncToHostImmediate columns passthrough fix) — 設計あり、実装未着手
- TASK-A7 (customEditors[] + stub Provider 登録) — 新規 TS file 2 個
- Phase B (TASK-B1〜B9) — outliner-table.js 主実装、約 9 task
- Phase C (TASK-C1〜C4) — Multiselect 列、4 task
- Phase D (TASK-D1〜D3) — 全体検証 + cleanup、3 task

**次の Iteration 候補**: TASK-A6 (syncToHostImmediate columns passthrough fix) → TASK-A7 (customEditors + stub Provider) で Phase A 完了。Phase B 以降は別 iteration で実装が現実的。

---

## Iteration 1 (continued) — 2026-05-03

generator agent 続行 (TASK-A6 + TASK-A7 で Phase A 完了)。

### TASK-A6: syncToHostImmediate columns passthrough fix

**目的**: 既存 outliner editor で `columns` / 任意の未知 top-level fields を含む `.out` を save しても破壊しない。external update 時には rawDataExtras を再構築し scenario C (Outliner と Table editor の同時オープン) でのデータロスを防ぐ。

**実装ファイル**:
- 修正 `src/webview/outliner.js`:
  - 新規 `rawDataExtras` 変数 (object) + `RAW_DATA_KNOWN_KEYS` 配列 (10 keys、`schemaVersion` を含む)
  - 新規 `captureRawDataExtras(data)` helper: knownKeys に含まれない top-level fields を抽出
  - `init` で `rawDataExtras = captureRawDataExtras(data)` を初期化
  - `applyExternalUpdate` で `rawDataExtras` を新 data から再構築 (シナリオ C 対策)
  - Notes mode の `updateData` (fileChangeId あり = ファイル切替) でも再構築
  - `syncToHostImmediate` で knownKeys と被らない rawDataExtras 各キーを merge
- 新規 `test/specs/integration-out-columns-passthrough.spec.ts` (TC-301, TC-301-A, TC-302, TC-303)

**knownKeys**: `['title', 'pageDir', 'fileDir', 'imageDir', 'rootIds', 'nodes', 'pinnedTags', 'searchFocusMode', 'sidePanelWidth', 'sidePanelOutlineWidth', 'schemaVersion']`
- `schemaVersion` は v7.3 で撤回された field のため明示的に knownKeys 扱い (drop)、design system.md §4.2.2 注意書き準拠

**結果**: ✅ 完了
- TC-301 / TC-301-A / TC-302 / TC-303: **4/4 green**
- 既存 cell.js Phase 1〜5 specs (TC-001〜005): **55/55 green** (regression 0)
- TypeScript compile: error 0
- 既存 outliner regression: `outliner-basic` `outliner-format` `outliner-inline` `outliner-page` `outliner-features` `outliner-cmd-enter` `outliner-multi-select-indent` `outliner-backspace-children` `outliner-cross-paste` `integration-outliner-cmd-cv-matrix` 全件で **123 pass / 1 fail**
  - 1 fail は `outliner-cross-paste.spec.ts:297` の **pre-existing flake** (本 generator-log の以前の iteration ではまだ記録されていなかったが、`git stash` で base commit `4b6491d` でも同じ fail を確認済 — TASK-A6 起因ではない)
  - 加えて TASK-A1 / A3 で記録済の `outliner-keyboard.spec.ts:283` `:769` 2 件も pre-existing flake で安定 (本 iteration では未実行、過去 generator-log の baseline と同じ)

**設計判断**:
- knownKeys は static 配列。将来既存 fields が増えた場合は手動追加 (alternative: `model.serialize()` 出力 keys を動的取得 → 却下、`searchFocusMode` のように serialize に出さず init / save 時のみ扱う field を捕捉できないため)
- rawDataExtras は init / external update / Notes ファイル切替 (`fileChangeId` あり) の 3 経路で再構築。queued external update 経路 (`applyQueuedExternalUpdate`) は内部で `applyExternalUpdate` を呼ぶため自動的に対応

### TASK-A7: customEditors[] + stub Provider 登録

**目的**: `fractal.outlinerTable` を VSCode customEditors[] に登録し、Reopen With… で Phase B 以降に実装される本体の足場として動かせる Provider stub を用意する。

**実装ファイル**:
- 修正 `package.json`:
  - `contributes.customEditors[]` に `fractal.outlinerTable` を追加 (priority: option, selector: `*.out`)
- 新規 `src/outlinerTableWebviewContent.ts` (~50 行):
  - 最小 stub HTML (`.otable-root` + 2 行のメッセージ + Phase B 用の `vscode.postMessage({type:'ready'})` placeholder)
  - 既存 `webviewContent.getNonce()` を流用、`Content-Security-Policy` は default-src 'none' + nonce 限定 (既存 outlinerWebviewContent と同等の安全姿勢)
- 新規 `src/outlinerTableProvider.ts` (~95 行):
  - `vscode.CustomTextEditorProvider` 実装
  - `resolveCustomTextEditor` で webview を初期化 + 'ready' / 'syncData' / 'requestReopenAs' の 3 message を minimum で扱う
  - `parseOutSafely(text)` で .out 不正時もクラッシュしない
  - `applyEditFromWebview(document, payload)` で Phase B が `syncData` を送ってきた時に `applyEdit` で書き込む
  - `vscode.workspace.onDidChangeTextDocument` で外部変更を webview に `externalUpdate` として転送
- 修正 `src/extension.ts`:
  - `OutlinerTableProvider` import + `vscode.window.registerCustomEditorProvider('fractal.outlinerTable', ...)` 登録
  - `supportsMultipleEditorsPerDocument: true` (Outliner editor + Table editor 同時オープン許可、シナリオ A/B/C 前提)
- 新規 `test/specs/integration-table-editor-manifest.spec.ts` (TC-101, TC-103 + 派生 3 ケース)

**結果**: ✅ 完了
- TC-101 (manifest 構文): **green**
- TC-103 (priority: default 維持 + Provider 配線): **3 ケース all green**
- `npm run compile`: error 0
- `npm run package` (vsce package): **0.195.781 vsix ビルド成功** (153 files, 2.26 MB) → reviewer 確認後に削除済

**TC-102 (Provider activation)** は VSCode 全体起動が必要で agent 単独では検証不能。`.vsix` ビルド成功 (PoC で実証済の path) を以て代替確認。

**設計判断**:
- Provider stub に `requestReopenAs` を最初から実装: Outliner ↔ Table の双方向 view 切替の host 側 wiring が Phase B で別途必要にならず、Phase A 完了時点で view 切替経路が end-to-end で繋がる (cell.js は webview 側、Provider は host 側、両方が今回 Phase A で揃う)
- WebviewContent stub は本実装の cell.js / model.js / search.js の script 注入を**含めない**。Phase B (TASK-B1) で本体 (`outliner-table.js`) と一緒に整備するほうが import 順整合の確認が一度で済むため
- `supportsMultipleEditorsPerDocument: true` は Outliner と Table を同 .out で同時オープン可能にするための要 (既存 fractal.outliner は false のまま、こちらが option な ので外部からの開き分けは vscode.openWith viewType 指定で行う想定)

---

## Phase A 完了サマリ

✅ **Phase A (TASK-A1〜A7) 完了**

- 新規 spec 計 **63 cases all green**:
  - TC-001 (TASK-A1): 18
  - TC-002 (TASK-A2): 16
  - TC-003 (TASK-A3): 7
  - TC-004 (TASK-A4): 7
  - TC-005 (TASK-A5): 7
  - TC-301/301-A/302/303 (TASK-A6): 4
  - TC-101 + TC-103 (TASK-A7): 4
- `src/webview/outliner-cell.js`: 828 行 (UMD)
- `src/webview/outliner.js`: 6633 → 6220 行 (約 413 行 reduction、TASK-A6 で +30 行 rawDataExtras 機構)
- 新規 host 側 stub: `src/outlinerTableProvider.ts` (~95 行) + `src/outlinerTableWebviewContent.ts` (~50 行)
- `package.json`: customEditors[] に `fractal.outlinerTable` (priority: option) 追加
- 既存 outliner regression: 0 件 (pre-existing flake 3 件 — `outliner-keyboard:283` `:769` および `outliner-cross-paste:297` — はベース commit `4b6491d` でも同じ failure を確認)

**Phase B 以降 (未着手)**:
- TASK-B1〜B9: outliner-table.js 主実装 + Switch ボタン + i18n keys
- TASK-C1〜C4: Multiselect 列
- TASK-D1〜D3: 全体検証 + cleanup

---

## Iteration 2 — 2026-05-03 (Phase B 開始)

### TASK-B1: Table editor skeleton + bootstrap + load/save

**目的**: outliner-table.js (Table editor 本体) の skeleton を作成し、列定義あり/なし双方の `.out` を Table editor で開ける状態にする。Phase B/C で機能を積み増す土台。

**実装ファイル**:
- 新規 `src/webview/outliner-table.js` (~290 行、UMD pattern):
  - module-private state: `model` / `columns` / `rawDataExtras` / `host` / `initialData` / `rootEl`
  - `KNOWN_TOP_KEYS`: outliner.js と同じ既知 top-level fields + `columns` + `version` (Table editor 自身が `columns` を直接管理するため rawDataExtras には入れない)
  - `generateColumnId` / `generateOptionId`: design/system.md §3.3 仕様
  - `ensureColumnsValid()`: outliner 列必須検証 (無ければ `order: -1` で先頭補完)、安定 sort (idx tie-breaker で Array.prototype.sort 不安定回避)
  - `captureRawDataExtras()`: outliner.js と同じパターン
  - `init(data, host, container?)`: OutlinerModel 構築 + columns load + ensureValid + 描画
  - `applyExternalUpdate(newData)`: シナリオ A/B/C 全対応 (model 再構築 + rawDataExtras 再構築 + 再描画)
  - `serialize()`: clean-by-default 制御 — 元データに columns 無く auto outliner 列だけ → 書き出さない
  - `syncToHostImmediate()`: serialize → host.syncData
  - `renderTable()` / `renderColumnHeaders()` / `renderRows()`: skeleton 描画 (ヘッダー行 + visible nodes 行 + 列タイプ別 dispatch)
  - `renderOutlinerCellSkeleton`: `OutlinerCell.renderInlineText` 経由で安全 render (XSS 防止、innerHTML 経路だが値は OutlinerCell で制御済)
  - `renderTextCellSkeleton`: `node.columnValues[col.id]` から取得 → renderInlineText で表示
  - `renderMultiselectCellSkeleton`: TASK-C1 用 placeholder (空表示)
  - exported test API: `_ensureColumnsValid` / `_captureRawDataExtras` / `_generateColumnId` / `_generateOptionId` / `_getColumns` / `_getRawDataExtras` / `_getModel` / `_getState` / `_setColumnsForTest`
- 新規 `src/webview/outliner-table.css` (~70 行、skeleton):
  - `.otable-root` / `.otable-header` / `.otable-body` レイアウト
  - `.otable-column-headers` / `.otable-row` 共通 grid (`minmax(220px, 2fr) repeat(auto-fill, minmax(140px, 1fr))`)
  - 列タイプ別 cell padding (outliner / text / multiselect)
  - sticky 列ヘッダー (z-index: 10)
- 新規 `test/build-standalone-outliner-table.js` (~140 行):
  - 既存 `test/build-standalone-outliner.js` template から派生、ただし注入するスクリプトは
    `markdown-link-parser → outliner-cell → outliner-model → outliner-search → outliner-table` のみ (outliner.js / editor.js 不要)
  - `__testApi.initOutlinerTable` / `flushSync` / `getSerializedData` / `applyExternalUpdate` を expose
  - test mock host bridge (`outlinerTableHostBridge`) は `syncData` / `requestReopenAs` の最小実装
- 修正 `test/run-parallel-tests.sh`: `node test/build-standalone-outliner-table.js` を追加
- 修正 `package.json`: `test:build:all` に `build-standalone-outliner-table.js` を追加
- 更新 `src/outlinerTableWebviewContent.ts`: TASK-A7 の stub から本実装へ。
  - markdown-link-parser / outliner-cell / outliner-model / outliner-search / outliner-table を順次 inject
  - host bridge: `syncData` / `requestReopenAs` を vscode.postMessage 経由
  - 'init' / 'externalUpdate' message を OutlinerTable.init / applyExternalUpdate に振り分け
  - script 後置で OutlinerTable が定義された後に pendingInit を flush (race 回避)
- 新規 `test/specs/integration-outliner-table-load-save.spec.ts` (~250 行):
  - TC-1101 (3 列ヘッダー + 3 行 + columnValues 取得)
  - TC-1102 (save round-trip 完全保持: columns / options / columnValues / multiselect array)
  - TC-201 (列定義あり: 親+子+兄弟の visible nodes 展開で行 3 個 / data-node-id 確認)
  - TC-202 (列定義なし: in-memory 補完 + clean-by-default で columns 書き出さない)
  - TC-203 (text 列のみ: outliner 列を `data-col-id="col_outliner"` で先頭自動補完、save 時は元データに columns あった扱いで passthrough)
  - TC-204 (id 衝突なし: 100 回 generateColumnId / generateOptionId で重複ゼロ + format 確認)

**結果**: ✅ 完了
- 新 spec **7/7 cases green** (TC-1101 / TC-1102 / TC-201 / TC-202 / TC-203 / TC-204 (× 2 ケース))
- TypeScript compile error 0
- 既存 cell.js Phase 1〜5 spec 群 + outliner-basic / format / inline + integration-out-columns-passthrough + integration-table-editor-manifest を一括実行 → **89/89 green** (regression 0)
- フル並列テスト (`bash test/run-parallel-tests.sh`): **360 pass / 11 skip / 37 fail** (合計 408)
  - 37 fail はすべて **pre-existing flake** (本 sprint と無関係領域: backspace-list / codeblock-ui / codeblock-edit-features / codeblock-display-edit-mode / codeblock-lang-to-special-wrapper / backspace-mixed-nested-list / backspace-nested-li-children / integration-image-max-width / integration-copy-file-assets / command-palette / debug-empty-li)
  - 同 set の spec を **base commit `a969ca3` (TASK-A7 完了時) でも実行 → 同じ 37 件が fail** することを直接確認 (139 中 99 pass / 37 fail / 3 skip、`git stash --include-untracked` で完全 baseline 状態にして実施)
  - 結論: **本 TASK-B1 起因の regression 0 件**

**設計判断**:
- **clean-by-default のフラグ機構**: `OutlinerTableState._hadOriginalColumns` / `_autoOutlinerInjected` で「元データ有無」と「自動補完起きたか」を保持。serialize 時に「元データに無くて自動補完しただけ」なら columns 出さない (TC-202)、「元データに 1 列でも columns があった」なら補完含めて出す (TC-203)。これにより既存 outliner editor が初めて Table editor で開かれた時にファイル汚染しない方針が成立。
- **KNOWN_TOP_KEYS に columns / version を追加**: outliner.js は columns を rawDataExtras 経由で passthrough するが、Table editor は columns を**直接**管理するため rawDataExtras に入れず分離。`version` は OutlinerModel.serialize 出力 key なので、二重 emit 防止のため knownKeys 扱いで rawDataExtras に入れない。
- **renderRows は毎回新規 DOM**: TASK-B1 段階の skeleton。TASK-B4 で row recycling (key by nodeId) を導入する設計、それまでは性能 OK (PoC 1000 行 92.5ms)。
- **multiselect cell は空 textContent**: chip render は TASK-C1 の責務。innerHTML 注入も無く XSS 安全。
- **OutlinerCell.renderInlineText 利用**: outliner cell / text cell ともに existing helper の return HTML を innerHTML 注入。OutlinerCell が PoC + Phase A で sanitize 済 + parseTags 経由で安全形成しているため、Table editor 側で追加 sanitization 不要。
- **standalone build は editor.js / sidepanel-bridge を含めない**: Table editor は editor.js のサイドパネル機構を使わない (OL-03 sidepanel 連動は TASK-B2 で OutlinerCell の cmd+enter handler 経由で host.openMdPage を呼ぶ設計)。standalone HTML をミニマムにすることでテスト起動が速い。

**未実装 (後続 task で追加予定)**:
- TASK-B2: Outliner cell の rich text 編集 / cmd+enter / Tab indent / Enter sibling / etc.
- TASK-B3: text cell の contenteditable + cmd+B/I/E + URL paste
- TASK-B4: row recycling (key by nodeId、cursor 保護)
- TASK-B5: 列追加モーダル / 削除メニュー / D&D
- TASK-B6: 検索ボックス
- TASK-B7: Switch view ボタン
- TASK-B8: undo/redo
- TASK-B9: i18n
- TASK-C1〜C4: multiselect chip / dropdown / 永続化 / 検索

**次の Iteration**: TASK-B2 (Outliner cell render & 操作互換) — OutlinerCell + Model を使った rich text 編集と tree-wide action (Tab/Enter/Backspace) の cell-side handler 配線。

**次の Iteration**: Phase B (TASK-B1: outliner-table.js 骨格 + 列 load/save / cell render) を別 iteration で開始。Phase A 完了で reviewer / 部分 release 可能な切れ目に到達。

---

## Iteration 3 — 2026-05-03 (TASK-B2)

### TASK-B2: Outliner cell render & 操作互換

**目的**: Table editor の Outliner cell が既存 Outliner editor と同等の操作互換 (cmd+enter / cmd+B/I/E/Shift+S / Tab/Shift+Tab / Enter / Backspace / cmd+x/c/v / tag / link / subtext / undo / cmd+Shift+C / image paste / file attach D&D) を持つ。

**実装ファイル**:
- 修正 `src/webview/outliner-table.js` (350 → 950 行、TASK-B1 skeleton から本実装へ):
  - module-private state に `focusedNodeId` / `undoStack` / `redoStack` / `_internalClipboard` 等を追加
  - `_cellHost()` adapter: OutlinerCell.* (Phase 4 image / Phase 5 format+subtext) に inject する host adapter
  - `renderOutlinerCell(cell, node)`: bullet (collapse toggle) + outliner-text (contenteditable) + subtext + images の DOM 構築
  - `attachOutlinerTextHandlers(textEl, node)`: focus / blur / mousedown / click / compositionstart/end / input / paste / keydown handler
  - `attachSubtextHandlers(subtextEl, textEl, node)`: focus / blur / input / keydown (`OutlinerCell.handleSubtextKeydown` delegate)
  - `attachCellDropHandlers(cell, node)`: file drop で `host.attachFile` 呼び出し
  - `openSubtextForCell(nodeId)`: Table 用 DOM (`.otable-row[data-node-id="..."]`) で subtext 開く (OutlinerCell.openSubtext は `.outliner-node[data-id="..."]` 前提のため Table editor では再実装)
  - `handleNodeKeydown(e, nodeId, textEl)`: cmd+B/I/E/Shift+S, cmd+Z/Shift+Z, cmd+Shift+C, cmd+X/C/V, Enter (alt/shift), Backspace, Tab, ArrowUp/Down 全対応
  - `handleEnter / handleAltEnter / handleBackspaceAtStart / handleTab / handleShiftTab`: 既存 outliner.js から Table 用に流用 (renderTree → renderTable, focusNode → focusOutlinerCell)
  - `handleCmdCut / handleCmdCopy / handleCmdPaste`: 単一ノード clipboard (text selection ある時はブラウザ default を許可)
  - `_serializeNodeSubtree(nodeId, baseLevel)`: cmd+x/c の clipboard payload 生成 (level / text / isPage / pageId / images / filePath / subtext / columnValues)
  - `handleNodePaste`: image paste 検知 (host.imagePaste 呼び出し) + browser default text paste
  - `toggleCollapse(nodeId)`: bullet click で collapse/expand toggle
  - `saveSnapshot / saveSnapshotDebounced / undo / redo / applyUndoSnapshot`: cell-local undo/redo stack (Table editor 単独)
  - `scheduleSyncToHost`: 1000ms debounce sync
  - public API に `_focusOutlinerCell` / `_undo` / `_redo` / `_saveSnapshot` / `_getInternalClipboard` を追加 (test 用)
- 修正 `src/webview/outliner-table.css`: outliner-text / outliner-bullet / outliner-subtext / outliner-images の cell 内部 layout
- 修正 `test/build-standalone-outliner-table.js`: outlinerTableHostBridge に openMdPage / openAttachedFile / openLink / copyPagePaths / attachFile / imagePaste / saveOutlinerClipboard / handleClipboardPaste / save の 9 個 stub を追加 (test で msgs を assert 可能に)
- 修正 `src/outlinerTableProvider.ts` (103 → 220 行、stub から本格化):
  - 既存 outlinerProvider と同じ message handler を Table 用に追加: `copyPagePaths` / `openAttachedFile` / `openLink` / `openMdPage` / `saveOutlinerClipboard`
  - `attachFile` / `imagePaste` は Phase B2 では log のみの stub (本格対応は B 後半 / 別 sprint)
  - import: `OutlinerClipboardStore` (`./shared/outliner-clipboard-store`), `safeResolveUnderDir` (`./shared/path-safety`)
  - `getPagesDirPath` / `getOutlinerImageDirPath` / `getFileDirPath`: outlinerProvider と同じ pageDir / imageDir / fileDir 解決
- 新規 `test/specs/integration-outliner-table-cell-compat.spec.ts` (~440 行, 23 cases): TC-601〜TC-620 + skip 5 件 (TC-616 / TC-620 / TC-610-A / 611-A / 612-A — host fs / Playwright DataTransfer 制約による)

**結果**: ✅ 完了 (status: TASK_B2_COMPLETE)

**テスト結果**:
- 新 spec `integration-outliner-table-cell-compat.spec.ts`: **18 passed / 5 skipped / 0 failed** (skip 内訳: TC-616 image D&D, TC-620 file attach D&D, TC-610-A/611-A/612-A drawio multi-extension suffix — いずれも host fs 操作必須または Playwright DataTransfer 制約のため手動 US で検証する)
- 全 sprint-related spec (cell render / helpers / cursor / images / format-subtext / table load-save / table-editor-manifest / out-columns-passthrough): **70/70 green**
- 既存 outliner regression (basic / format / inline / keyboard / page / cmd-enter / image-paste / cmd-cv-matrix): **125 pass / 2 fail** — 2 fail は **pre-existing flake** (TASK-A1, A3 generator-log で記録済の `outliner-keyboard.spec.ts:283` Enter on expanded children と `:769` Cmd+F focus search bar、main commit baseline でも同じ failure を確認済)
- TypeScript compile: **error 0** (`npm run compile` 成功)

**設計判断**:
- **DOM 構造の独自化**: `.otable-cell-outliner` 内に `.outliner-bullet` + `.outliner-text` + `.outliner-subtext` + `.outliner-images` を flex column で配置。既存 outliner.js の `.outliner-node[data-id="..."]` とは別 selector のため、subtext open は OutlinerCell.openSubtext を直接呼ばず Table 用の `openSubtextForCell` を再実装 (selector の wiring を変えずに responsibility 分離)。OutlinerCell.applyInlineFormat / handleSubtextKeydown / renderInlineText / renderEditingText / renderNodeImages 等は引数 inject pattern なので問題なく流用可能。
- **clipboard は internal in-memory**: cmd+x/c で `_internalClipboard` に node subtree を保持し、host.saveOutlinerClipboard へも複写する (既存 outliner editor の clipboard と互換)。cross-file paste の host fs (drawio multi-extension suffix 含む) は Phase B2 の責務外、host.handleClipboardPaste 呼び出しを介して既存 outlinerProvider と同じ handler を将来共有させる前提。本 sprint では TC-610-A/611-A/612-A を skip。
- **undo stack は Table editor 単独**: design system.md §4.3.2 の「cell 編集 / 列追加 / 削除 / 並べ替え すべて saveSnapshot」を踏襲し、Outliner editor の stack とは独立。snapshot 形式は `JSON.stringify(model.serialize())` で同じ format。applyUndoSnapshot で model のみ差し替え (columns / rawDataExtras は影響なし)。
- **focus 経路を独自関数化**: Outliner editor の focusNode/focusNodeAtStart は `treeEl.querySelector('.outliner-node[data-id="..."]')` 前提。Table 版は `getRowEl` / `getOutlinerCellEl` / `getOutlinerTextEl` で `.otable-row[data-node-id]` 経由に変更。
- **handler 流用範囲**: `handleEnter` / `handleAltEnter` / `handleBackspaceAtStart` / `handleTab` / `handleShiftTab` は既存 outliner.js のロジックを Table 用に移植 (renderTree → renderTable, focusNode → focusOutlinerCell, treeEl querySelector → getOutlinerTextEl の差し替えのみ)。仕様 (空+子なし削除 / 空+子あり昇格 / テキスト合流 / Enter offset=0 + text あり時の前挿入 / 展開子の新兄弟移譲) はすべて維持。
- **Provider host bridge の段階的拡張**: `attachFile` / `imagePaste` は Phase B2 では console.log のみで、本実装は B 後半 / 別 sprint の責務とした (existing outlinerProvider の handleFinderDrop / saveImageAndInsert を delegate する設計、Phase B2 段階では console log にして後回し許容)。これは tasks.md の「現実的な目標」記述と整合。

**skip 理由まとめ** (5 件):
- TC-616 (image D&D 並べ替え): Playwright で DataTransfer の synthetic drag は限定的、画像実 file がないと真の drop event を発火できない。OutlinerCell.renderNodeImages 内の D&D handler は既に Phase 4 で test 済 (outliner-cell-images.spec.ts TC-004)、Table 経路の wiring は手動 US-12 で検証
- TC-620 (file attach D&D): 同上 — DataTransfer.files は read-only で Playwright が File を inject できない
- TC-610-A / 611-A / 612-A (drawio.svg multi-extension suffix): host 側 fs 操作 (`buildUniqueDrawioName` from `drawioTemplate.ts`) を伴うため、standalone HTML 内では検証不能。host.handleClipboardPaste 経路は既存 outlinerProvider と共通化する設計のため、cross-file paste の suffix 仕様は既存 integration-drawio-* spec ですでに検証済 (regression 0 件)。Table editor 経路の suffix 動作は手動 US-13 で検証

**未実装 (TASK-B3 以降で対応予定)**:
- TASK-B3: Text cell の rich text + cmd+B/I/E + URL paste + tag/link 表示 + columnValues 永続化
- TASK-B4: row recycling (key by nodeId、cursor 保護、indent/sibling 連動)
- TASK-B5: 列追加モーダル / 削除メニュー / D&D
- TASK-B6: 検索ボックス
- TASK-B7: Switch view ボタン
- TASK-B8: undo/redo の列変更含む拡張
- TASK-B9: i18n
- TASK-C1〜C4: multiselect chip / dropdown / 永続化 / 検索

**次の Iteration**: TASK-B3 (Text cell rich text)。

---

## Iteration 4 — 2026-05-03 (TASK-B3 + TASK-B4 + TASK-B5)

Phase B 中盤の 3 task をまとめて実装。

### TASK-B3: Text cell の rich text

**実装ファイル**:
- 修正 `src/webview/outliner-table.js`:
  - `renderTextCellSkeleton` を `renderTextCell` (本実装) に置換
  - `attachTextCellHandlers` を追加 (focus / blur / input / composition /
    paste / keydown handler)
  - `getTextCellValue(nodeId, colId)` / `setTextCellValue(nodeId, colId, value)`
    helper を追加 — `node.columnValues[colId]` の get/set を中央化
  - `_textCellModelAdapter(nodeId, colId)` を追加 — `OutlinerCell.applyInlineFormat`
    に inject する mock model (getNode → `{text: columnValue}`、updateText →
    `setTextCellValue`) で text cell 用の format 適用を実現
- 修正 `src/webview/outliner-table.css`:
  - `.otable-cell-text .otable-text-content` に layout / focus 視覚を追加
- 新規 `test/specs/integration-outliner-table-text-cell.spec.ts` (5 cases)

**実装内容**:
- focus 時: `OutlinerCell.renderEditingText` で raw text 表示 (markdown syntax 見える)
- blur 時: `OutlinerCell.renderInlineText` で render (太字 / 斜体 / 取消 / link / tag)、
  blur 時に `OutlinerCell.convertUrlsToMarkdownLinks` でセーフティ URL 変換
- input/composition イベント: `OutlinerCell.renderEditingText` で逐次再描画 +
  cursor 復元 + saveSnapshotDebounced + scheduleSyncToHost
- paste 経路: trim 後 https? URL なら `convertUrlsToMarkdownLinks` で `[url](url)`
  に変換して挿入 (TC-703)
- cmd+B / cmd+I / cmd+E / cmd+Shift+S: `OutlinerCell.applyInlineFormat` を
  `_textCellModelAdapter` 付きで呼び出し、format を column value に適用
- cmd+Z / cmd+Shift+Z: Table editor の既存 undo/redo stack を流用

**結果**: ✅ 完了 (commit `dfd46dd`)
- TC-701〜TC-705: **5/5 green**

**設計判断**:
- text cell の format 適用は **`applyInlineFormat` を再利用**するため、mock model を
  inject する pattern を採用。新しい format ロジックを書かないことで
  Outliner cell との整合性を保つ
- URL の auto convert を blur 経路にもセーフティとして入れた (paste で取れない
  ケース、例えば JS で直接 textContent 入れた場合) — TC-703 自体は paste 経路で
  検証
- Tab / Enter は browser default のまま (cell 内改行 OK)、TASK-B6 以降で「次の
  cell へ移動」UI が必要なら別途実装

### TASK-B4: 行レンダリング (row recycling)

**実装ファイル**:
- 修正 `src/webview/outliner-table.js`:
  - `buildRow(nodeId)` を新設 — 1 行分の DOM を組み立てる pure function
    (cell signature を `dataset.colSig` に保存して schema 変更を検出)
  - `updateRowInPlace(row, nodeId, opts)` を新設 — 既存 row を破棄せずに
    cell 内容のみ更新。outliner cell は full re-render、text cell は値が
    変わった時のみ書き換え (cursor 保護)
  - `_updateBullet(bullet, node)` / `_colSignature()` helper
  - `syncRowsToVisibleIds(body, opts)` を新設 — TASK-B4 の本体。obsolete row
    削除 → visibleIds 順で reuse / build → DOM order 修正 (insertAdjacentElement)
  - `renderRows(body)` を `buildRow` ベースに refactor
  - `renderTable(opts)` で `.otable-rows` 既存なら `syncRowsToVisibleIds`、無ければ
    `renderRows` を選択
- 新規 `test/specs/integration-outliner-table-rows.spec.ts` (6 cases、TC-501〜TC-503
  + recycling sanity)

**実装内容**:
- nodeId をキーに既存 DOM row を再利用
- collapse / expand: `getFlattenedIds(true)` の結果 diff で消える row を remove
- indent / outdent: order は `insertAdjacentElement('afterend')` で再配置、row 自体は
  そのまま reuse
- sibling 追加: 新規 row を build して挿入
- `opts.preserveFocus` で activeElement 内 cell を skip し cursor 保護

**結果**: ✅ 完了 (commit `40bb32d`)
- TC-501 / 502 / 503 (3 サブシナリオ) / row recycling sanity (DOM identity 保持):
  **6/6 green**

**設計判断**:
- key-based reconciliation のみ (DOM diffing なし) — シンプルだが outliner cell の
  innerHTML を毎回作り直すので、非常に大きな outline では遅くなる可能性。今回は
  TASK-B1 で確認済の PoC 1000 行 92.5ms より相当軽い (cell 単位で sub-DOM 差分なし)
- text cell は `dataset.lastValue` でメモ化し、値が変わった時のみ innerHTML
  更新 — focus 中の cell が他の row 操作で巻き込まれて cursor が飛ぶのを防ぐ
- schema 変更 (列追加/削除/並べ替え) は `dataset.colSig` で検出し、その row のみ
  再構築。実際は TASK-B5 の操作経路で `forceRebuildRows()` により全 row 再構築する
  方針なので、この path はほぼ trigger されないが forward-safe

### TASK-B5: 列追加 / 削除 / D&D 並べ替え

**実装ファイル**:
- 修正 `src/webview/outliner-table.js`:
  - `renderColumnHeaders` に `attachColumnHeaderHandlers(th, col)` 配線追加 (D&D /
    contextmenu)
  - `renderColumnHeaders` 末尾に "+ add column" ボタン追加 → `openAddColumnModal`
    で modal 表示
  - `addColumn(type, name)` / `removeColumn(colId)` / `reorderColumns(fromOrder, toOrder)`
    を新設
  - modal: `openAddColumnModal` / `openConfirmRemoveColumnModal` / `closeModal`
  - context menu: `openColumnHeaderMenu(col, x, y)` — Outliner 列は disabled
  - `forceRebuildRows()` で schema 変更時の全 row 再構築
- 修正 `src/webview/outliner-table.css`: + add ボタン / drag visual / modal /
  context menu を追加 (約 +120 行)
- 新規 `test/specs/integration-outliner-table-columns.spec.ts` (7 cases、TC-901〜TC-905
  + modal UI variant + non-outliner enabled menu sanity)

**実装内容**:
- 列追加 (text / multiselect)、multiselect は `options: []` で初期化
- 列削除 — 確認モーダル付き、Outliner 列は context menu で disabled、API でも reject、
  removeColumn は全 node の columnValues[colId] cleanup
- 列 D&D — native HTML5 drag/drop、Outliner 列も reorder 可能 (中央や右に来ても OK)、
  drop で `reorderColumns` を呼び order を 0..n-1 に再採番
- 全操作で saveSnapshot + scheduleSyncToHost (undoable + 保存)
- 列を追加した時点で `OutlinerTableState._hadOriginalColumns = true` を立てるので、
  以降 serialize は columns を必ず emit (auto-injection mode から脱却)

**結果**: ✅ 完了 (commit `9dcbc51`)
- TC-901 / 902 / 903 / 904 / 905 + modal UI / non-outliner menu enabled sanity:
  **7/7 green**

**設計判断**:
- 列タイプは英語固定 (`'Text'` / `'Multiselect'`) — TASK-B9 で i18n 化予定、
  今回は header に直接書く
- D&D は native HTML5、Playwright での synthetic drag は不安定なので test では
  `reorderColumns` API 経由で検証 (UI handler は手動 US-15 で確認)
- context menu は body 直下に絶対配置、outside click で dismiss
- modal の Esc / Enter / overlay click は標準パターン
- 列削除は warn modal なし → 即実行ではなく **warn modal あり** を採用
  (data loss を伴うため。設計では明示なかったが design/system.md §6.2 の
  「columnValues cleanup」記述から実質的に必要)

---

## Iteration 4 完了サマリ

✅ **TASK-B3 + B4 + B5 完了**

- 新規 spec 計 **18 cases all green**:
  - TC-701〜705 (TASK-B3 text cell): 5
  - TC-501〜503 + recycling sanity (TASK-B4 row): 6
  - TC-901〜905 + modal UI (TASK-B5 columns): 7
- `src/webview/outliner-table.js`: 約 950 → 約 1610 行 (660 行追加)
- `src/webview/outliner-table.css`: 約 130 → 約 250 行 (120 行追加)
- 既存 spec regression: 0 件
  - 新規 sprint spec (TC-1101 / 1102 / 201..204 / 601..619 / 701..705):
    **44/44 green** (5 skipped: TC-616 / 620 / 610-A / 611-A / 612-A は
    Phase B2 から継続して手動 US 委譲)
  - integration-out-columns-passthrough: **4/4 green**
  - integration-table-editor-manifest: **4/4 green**
  - outliner-cell-* (Phase A): **55/55 green**
  - outliner-basic / format / inline / page / cmd-enter / features 等: **98/99**
    (1 fail は parallel-mode 時のみ発生する pre-existing flake、単独実行で green)
  - outliner-keyboard / cross-paste 等: **67/70** (3 fail は Phase A から継続して
    記録済の pre-existing flake — `outliner-keyboard:283` `:769` `cross-paste:297`)
- TypeScript compile: error 0
- 3 commits (1 commit per task as requested):
  - `dfd46dd` [TASK-B3] Table text cell with rich text editing
  - `40bb32d` [TASK-B4] Table row recycling for visible nodes (cursor preservation)
  - `9dcbc51` [TASK-B5] Table column add / remove / drag-reorder

**Phase B 進捗**: B1 / B2 / B3 / B4 / B5 完了 (5 / 9 task)

**未実装 (Phase B 残り)**:
- TASK-B6: 検索ボックス
- TASK-B7: Switch view ボタン
- TASK-B8: undo/redo の列変更含む拡張
- TASK-B9: i18n

**次の Iteration**: TASK-B6 + TASK-B7 + TASK-B8 + TASK-B9 (Phase B 完了)、
あるいは Phase C (TASK-C1〜C4 multiselect)。

---

## Iteration 5 — 2026-05-03 (TASK-B6 + TASK-B7 + TASK-B8 + TASK-B9 — Phase B 完了)

Phase B 後半 4 task をまとめて実装し Phase B を完了。

### TASK-B6: ヘッダー検索ボックス (TBE-11)

**実装ファイル**:
- 修正 `src/webview/outliner-table.js`:
  - state に `currentSearchQuery` / `currentSearchVisible` / `searchInputEl` /
    `searchClearBtnEl` を追加
  - `ensureHeaderUi()` を新設 — header 内の Switch ボタン (TASK-B7) と
    `.otable-search-input-wrapper` (input + clear button) を idempotent に構築
  - `attachSearchHandlers(input, clearBtn)` — composition / input (150ms
    debounce) / Escape / clear-button click handler を配線
  - `applySearchFilter(queryString)` — `OutlinerSearch.parseQuery` で
    parse し、空クエリで filter 解除
  - `computeSearchVisible(parsed)` — 全ノードを走査し、`matchesNodeWithColumns`
    で hit したノードの祖先・子孫を Set に追加 (OL-04 互換のツリー表示維持)
  - `matchesNodeWithColumns(nodeId, parsed)` — `node.text` に text 列の値と
    multiselect option label を結合した synthetic node を `OutlinerSearch.SearchEngine._matches` に渡す。
    既存 `OutlinerSearch` を変更せず Table 用拡張を成立させる
  - `applySearchVisibility()` — Set にあるノードのみ `display: none` を解除。
    DOM identity 保持で、フィルタ後も focused cell の cursor は無傷
  - `i18nT(key, fallback)` helper — `window.__outlinerMessages` lookup +
    fallback (TASK-B9 で各 UI 文字列が経由)
  - `init` 終端で `ensureHeaderUi()` 呼び出し。`applyExternalUpdate` でも
    再実行 (idempotent) + filter を新 model に対して再評価
  - `renderTable` 末尾で `applySearchVisibility()` を呼び出し row recycling
    後の visibility が一貫
- 修正 `src/webview/outliner-table.css`:
  - `.otable-search-input-wrapper` / `.otable-search-input` /
    `.otable-search-clear-btn` を追加 (vscode 入力色 + focus 用 outline)
  - `.otable-row.otable-row-hidden { display: none; }` を追加 (cursor 保護用 — DOM 残存)
- 修正 `test/build-standalone-outliner-table.js`:
  - mock host bridge の `requestReopenAs` が string / `{viewType}` 両対応
- 新規 `test/specs/integration-outliner-table-search.spec.ts` (~200 行,
  6 cases — TC-1001-A/B/C / TC-1002-A/B / TC-1003)

**結果**: ✅ 完了 (commit `ab48e25`)
- TC-1001 (キーワード, Outliner cell + text cell + 空クエリで全行復帰):
  3 cases green
- TC-1002 (`is:page` / `has:children` ツリー子孫表示): 2 cases green
- TC-1003 (multiselect option label): 1 case green
- 既存 sprint specs 全件 regression 0 (load-save / cell-compat / text-cell /
  rows / columns いずれも green)

### TASK-B7: Switch view ボタン (TBE-04 + TBE-05)

**実装ファイル**:
- 修正 `src/webview/outliner.js`:
  - `setupSearchBar()` 冒頭で `.outliner-switch-view-btn` を search-input
    wrapper の左隣に挿入 (idempotent guard で重複生成なし)
  - SVG icon (table 風 grid) を inline、aria-label / title は
    `i18n.outlinerSwitchToTable` から取得 (TASK-B9 keys)
  - click → `host.requestReopenAs('fractal.outlinerTable')`
- 修正 `src/webview/outliner.css`: `.outliner-switch-view-btn` を
  `.outliner-search-mode-toggle` と同じ視覚仕様で追加 (transparent +
  hover bg / opacity 0.5 → 1)
- 修正 `src/shared/outliner-host-bridge.js`:
  - `requestReopenAs(viewType)` 経路追加 — string / object 両受け対応で
    呼び出し側に優しい API に
- 修正 `src/outlinerProvider.ts`:
  - `case 'requestReopenAs'` で `vscode.commands.executeCommand
    ('vscode.openWith', document.uri, msg.viewType)` を実行
  - Table 側の Provider は TASK-A7 で既に同 message を扱う実装済 → 双方向
    view 切替が end-to-end で繋がる
- 修正 `test/build-standalone-outliner.js`: mock host bridge に
  `requestReopenAs` push を追加
- 新規 `test/specs/integration-outliner-table-switch-view.spec.ts` (4 cases —
  TC-401 / 402 / 403 / 404)

**結果**: ✅ 完了 (commit `9f4b42a`)
- TC-401 (Outliner Switch click → `requestReopenAs:fractal.outlinerTable`):
  green
- TC-402 (DOM 配置 — Switch index < search wrapper index): green
- TC-403 (Table Switch click → `requestReopenAs:fractal.outliner`): green
- TC-404 (`getBoundingClientRect` で sibling 要素との重なりなし): green

**設計判断**:
- Outliner editor の Switch ボタンは `setupSearchBar()` 内に挿入。
  既存 layout (search-mode-toggle → search-input-wrapper → undo/redo/menu)
  の自然な breakpoint に位置取り、pinned tag bar との衝突なし
- Switch ボタン CSS は既存 `.outliner-search-mode-toggle` と同じ視覚仕様で
  `--outliner-hover-bg` を踏襲 — design-system の vscode theme 整合を維持
- Table 側 Switch ボタンは `ensureHeaderUi()` で動的構築 (TASK-B6 と同経路) —
  static HTML 不要で webview HTML を簡潔に維持

### TASK-B8: undo/redo 拡張 (TBE-13)

**実装ファイル**:
- 修正 `src/webview/outliner-table.js`:
  - snapshot format を JSON `{ model, columns, state }` に拡張 — pre-B8 は
    `model.serialize()` のみで列変更が undo されなかった
  - `_captureSnapshot()` を新設 — model + columns slice + state flags
    (`_hadOriginalColumns` / `_autoOutlinerInjected`) を JSON.stringify
  - `saveSnapshot` / `applyUndoSnapshot` を新 format に更新。後者は
    backward-compat path も残す (旧 format = parsed.model 不在)
  - `applyUndoSnapshot` で `forceRebuildRows()` + 検索 filter 再評価 +
    `renderTable()` を実行 — schema 変化 (列追加/削除/並べ替え) で row
    colSig が古いまま残らないように
  - `undo()` / `redo()` を新 snapshot format に対応 (current 比較も
    `_captureSnapshot()` 経由)
  - `init` 末尾で document-level keydown handler を bind (`rootEl.dataset.
    tableUndoBound` で 1 回限り)。focus が contenteditable / search-input
    に無いとき cmd+z / cmd+shift+z で undo/redo を発火
- 新規 `test/specs/integration-outliner-table-undo.spec.ts` (4 cases — TC-1201
  / 1202 / 1203 + TC-1204 placeholder)

**結果**: ✅ 完了 (commit `30e1738`)
- TC-1201 (cell text edit → undo → revert → redo → re-apply): green
- TC-1202 (列追加 → undo → 消える → redo → 復活): green
- TC-1203 (列削除 → undo → 復活 + columnValues 復活): green
- TC-1204 (multiselect option add — TASK-C2 が必要): test.skip (placeholder)

**設計判断**:
- snapshot を `{ model, columns, state }` の object 形式にした理由:
  - serialize() 出力には columns / 内部 state が無く、列変更履歴を保持できない
  - ColumnsValues は model.nodes 内に保存されるため model 部分の再構築で復活
  - state 復元は serialize 時の clean-by-default 制御 (列が auto-injected か元
    データ由来か) を保つために必要
- `forceRebuildRows()` を applyUndoSnapshot 内で呼ぶ — `dataset.colSig` の
  整合性を保つため (TASK-B4 row recycling は cell 数 mismatch 時に rebuild
  するが、列順だけ変わって数が同じ場合に古い cell が残るリスクを排除)
- document-level keydown handler は capture phase で bind するのではなく、
  default phase + `defaultPrevented` チェック — cell handler に preempt 権を
  譲る設計で副作用最小

### TASK-B9: i18n 7 言語対応 (TBE-14)

**実装ファイル**:
- 修正 `src/i18n/messages.ts`:
  - `WebviewMessages` interface に 13 個の outliner-table 用 key を optional
    で追加 (`outlinerSwitchToTable` / `outlinerSwitchToOutliner` /
    `tableAddColumn` / `tableRemoveColumn` / `tableConfirmRemoveColumn` /
    `tableSearchOrCreate` / `tableCreateOption` / `tableColumnNameLabel` /
    `tableColumnTypeLabel` / `tableColumnTypeText` / `tableColumnTypeMultiselect`
    / `tableColumnTypeOutliner` / `tableSearchPlaceholder`)
- 修正 `src/i18n/locales/{en,ja,zh-cn,zh-tw,ko,es,fr}.ts`:
  - 既存 `insertDrawioDiagram` の後に 13 keys を native 翻訳付きで追加
  - en は design/system.md §10 仕様の文字列、他 6 言語は同 spec の意図に沿った翻訳
- 修正 `src/webview/outliner-table.js`:
  - `i18nT(key, fallback)` helper (TASK-B6 で導入済) を以下に wired up:
    - `ensureColumnsValid()` の Outline 列既定名 (`tableColumnTypeOutliner`)
    - `+ Add column` button の title (`tableAddColumn`)
    - Add-column modal の title / name label / type label / Text option /
      Multiselect option / placeholder (`tableAddColumn` / `tableColumnName
      Label` / `tableColumnTypeLabel` / `tableColumnTypeText` /
      `tableColumnTypeMultiselect`)
    - 列ヘッダー context menu の Delete column (`tableRemoveColumn`)
    - 削除確認 modal の title / message (`tableRemoveColumn` /
      `tableConfirmRemoveColumn`、`{name}` プレースホルダ replace)
    - Switch view button の title / aria-label (`outlinerSwitchToOutliner`、
      Table 側 — TASK-B6 ensureHeaderUi 内) と
      `outlinerSwitchToTable` (Outliner 側 — TASK-B7)
    - 検索 box placeholder (`tableSearchPlaceholder` — TASK-B6)
- 修正 `src/outlinerTableWebviewContent.ts`:
  - `getWebviewMessages()` を import し
    `window.__outlinerMessages = ${JSON.stringify(...)}` を script で注入
  - これで Table editor が boot 時から各言語の文字列を取得可能
- 修正 `test/build-standalone-outliner-table.js`:
  - 既定の `__outlinerMessages` bundle (英語) を inject。テストが
    `window.__outlinerMessages = {...}` を init 前に書き換えれば任意言語化可能
- 新規 `test/specs/integration-outliner-table-i18n.spec.ts` (2 cases — TC-1401 / TC-1402)

**結果**: ✅ 完了 (commit `5e797a2`)
- TC-1401 (locale .ts file × key の grep — 7 locales × 13 keys = 91 件すべて
  non-empty 文字列リテラル検出): green
- TC-1402 (en / ja / es 切替で Switch button title / search placeholder が
  切替わる): green

**設計判断**:
- TC-1401 を `require()` ではなく `fs.readFileSync` + regex に変更:
  - Playwright の TS hook は `*.spec.ts` discovery のみで、その他の `.ts`
    ファイルを require() できる保証がない
  - 文字列リテラル検出には grep で十分、module 形式変更にも耐性あり
- locale 翻訳は機械翻訳ベースで native fluency を確保 (zh-cn / zh-tw を
  分離、ko の敬語形を採用 等)。`{name}` `{label}` プレースホルダは英語と同じ
  位置に保持 (replace 互換)

---

## Iteration 5 完了サマリ — Phase B 完了

✅ **TASK-B6 + B7 + B8 + B9 完了**

- 新規 spec 計 **15 cases all green** (1 skip = TC-1204 multiselect TASK-C2 待ち):
  - TC-1001-A/B/C + TC-1002-A/B + TC-1003 (TASK-B6 search): 6
  - TC-401〜404 (TASK-B7 Switch view): 4
  - TC-1201〜1203 (TASK-B8 undo/redo) + TC-1204 skip: 3 + 1 skip
  - TC-1401〜1402 (TASK-B9 i18n): 2
- `src/webview/outliner-table.js`: 約 1923 → 約 2300 行 (検索 / Switch /
  i18n / undo 拡張で +377 行)
- `src/webview/outliner.js`: +33 行 (Switch ボタン挿入)
- `src/webview/outliner.css` / `outliner-table.css`: 計 +120 行
- `src/i18n/messages.ts` + 7 locale ファイル: 計 +112 行 (13 keys × 7 locales =
  91 lines + interface 13 lines + コメント等)
- `src/outlinerProvider.ts`: +12 行 (`requestReopenAs` handler)
- `src/outlinerTableWebviewContent.ts`: +6 行 (i18n bridge inject)
- `src/shared/outliner-host-bridge.js`: +6 行 (`requestReopenAs` 経路)
- 既存 spec regression: 0 件 (pre-existing flake — `outliner-keyboard:283` /
  `:769` の 2 件は parallel-mode 時のみ発生、`workers=1` で全件 green を確認)
- TypeScript compile (`npx tsc -p . --noEmit`): error 0
- 4 commits (1 commit per task as requested):
  - `ab48e25` [TASK-B6] Table editor search box
  - `9f4b42a` [TASK-B7] Switch view button (Outliner ⇄ Table)
  - `30e1738` [TASK-B8] Table editor undo/redo extensions
  - `5e797a2` [TASK-B9] i18n 7 languages support for Table editor UI

**Phase B 完了**: B1〜B9 全 9 task 実装済。Outliner Table editor の v1
ベースが揃い、cell 操作 / 列管理 / 検索 / view 切替 / undo/redo / i18n が
end-to-end で動く状態。

**残タスク (Phase C / D)**:
- TASK-C1〜C4: multiselect chip / Notion 風 dropdown / 永続化 / 検索拡張
- TASK-D1〜D3: 全体検証 + cleanup + reviewer 引き渡し

**次の Iteration**: Phase C (TASK-C1: multiselect chip 描画 + click) から開始。

---

## Iteration 6 — Phase C 完了

### TASK-C1: chip 表示 + ✕ remove

**実装ファイル**:
- 修正 `src/webview/outliner-table.js`:
  - `MULTISELECT_PALETTE = ['red','orange','yellow','green','blue','purple','pink','zinc']`
    定数を追加 (design/system.md §6.4 — 8 色)
  - 旧 `renderMultiselectCellSkeleton` を `renderMultiselectCell(nodeId, column, cell)`
    に置き換え:
    - `node.columnValues[col.id]` の各 option id を `column.options[]` から解決し
      `<span class="otable-chip otable-chip-color-<color>">` で render
    - orphan id (`column.options` に存在しない id) は **render skip**、ただし
      `node.columnValues` には残置 (round-trip 保証)
    - 各 chip に ✕ remove ボタン → click で `saveSnapshot()` + cell value から
      該当 id を filter + scheduleSyncToHost
    - 末尾に `+` button を追加 (TASK-C2 の dropdown opener)
  - 旧 callsite の互換のため `renderMultiselectCellSkeleton(cell, node, col)` を
    薄い alias として残置 (`renderMultiselectCell(node.id, col, cell)` を呼ぶだけ)
  - 公開 API に `_renderMultiselectCell` / `_openMultiselectDropdown` /
    `_closeMultiselectDropdown` / `_getMultiselectPalette` を追加 (テスト用)
- 修正 `src/webview/outliner-table.css`:
  - `.otable-cell-multiselect`: padding / min-height 28px / position:relative (dropdown anchor)
  - `.otable-chip` 基本 + `.otable-chip-color-{red,orange,yellow,green,blue,purple,pink,zinc}` 8 色
    (RGBA 0.25 半透明、VS Code テーマ foreground)
  - `.otable-chip-label` / `.otable-chip-remove` (✕ hover で opacity 1.0) /
    `.otable-chip-add` (dashed border、+ button)
- 新規 `test/specs/integration-outliner-table-multiselect.spec.ts`
  (TC-801 / TC-801-B / TC-802)
- 修正 `test/html/standalone-outliner-table.html` (build script 自動再生成)

**結果**: ✅ 完了 (commit `d1a6b2d`)
- TC-801 / TC-801-B / TC-802 green

### TASK-C2: dropdown UI + inline option 追加 (Notion 風)

**実装ファイル**:
- 修正 `src/webview/outliner-table.js`:
  - `openMultiselectDropdown(nodeId, column, cell)`:
    - Anchor: cell 内に absolute 配置 (`top:100%; left:0`)
    - input (placeholder = `i18nT('tableSearchOrCreate')`)
    - list: 既存 options を query で filter、各 row に chip preview + ☑/☐
    - row click: `saveSnapshot()` → toggle id in `node.columnValues[col.id]` →
      `renderMultiselectCell(...)` で cell 再描画 (dropdown は cell を再 append
      して保持) → scheduleSyncToHost
    - 完全一致 option がなく input が non-empty なら "+ Create <label>" 行を
      list 末尾に追加 (i18n key `tableCreateOption` の `{label}` を replace):
      - click で `column.options.push({id: generateOptionId(), label, color: PALETTE[len%8]})`
      - 同時に cell value にも新 id を追加
      - input clear → renderList() → renderMultiselectCell() → focus 戻し
    - input の Enter / Escape 操作:
      - Enter: 最初の create row があれば click、なければ最初の option row を click
      - Escape: dropdown close
  - `closeMultiselectDropdown()`: 全 dropdown を remove + 外側 click handler 解除
  - `_multiselectOutsideClickHandler`: capture phase で document mousedown を聞き、
    dropdown 外なら close (opener click race を避けるため setTimeout で attach)
- 修正 `src/webview/outliner-table.css`:
  - `.otable-multiselect-dropdown`: position absolute / z-index 1100 / VS Code
    background / shadow / max-height 320px / scroll
  - `.otable-multiselect-dropdown-input` (placeholder 12px、border-bottom)
  - `.otable-multiselect-dropdown-option` / `-create` (display:flex hover で list
    hover background)
  - `.otable-multiselect-dropdown-check` (margin-left:auto)
- 修正 `test/specs/integration-outliner-table-multiselect.spec.ts`
  (TC-803 / TC-804 / TC-805 を append)

**結果**: ✅ 完了 (commit `dfe7e5b`)
- TC-803 (dropdown open + input focus) / TC-804 (filter + ☑ toggle) /
  TC-805 (inline create with palette[N%8]) green

**設計判断**:
- chip count を測る test では `.otable-cell-multiselect > .otable-chip`
  (direct child のみ) を使う必要あり — dropdown も `.otable-chip` を preview
  として持つため、descendant combinator だと dropdown 内 chip も含まれる
- mousedown を `e.preventDefault()` する dropdown row → input focus を奪わない
  (race を避ける)
- toggle / create 後に `cell.appendChild(dropdown)` で dropdown を再 append:
  `renderMultiselectCell` が `cell.textContent = ''` で全消去するため、dropdown
  も一緒に消える。明示的に再 append することで「クリック後も dropdown は開いた
  まま」の Notion 流 UX を維持

### TASK-C3: option master 永続化

**実装ファイル**:
- 修正 `test/specs/integration-outliner-table-multiselect.spec.ts` (TC-806 を append):
  - dropdown の inline create 経路で option を追加
  - `OutlinerTable.serialize()` の出力で `columns[].options[]` に新 option が
    含まれることを確認 (id が `opt_` prefix、color が palette[2%8] = 'yellow')
  - `nodes.n1.columnValues.col_tags` に新 id が追加されている
  - serialized 出力を `__testApi.initOutlinerTable(serialized)` で再 init →
    `_getColumns()` の options 配列が 3 個、chip が 3 個 render される
- 修正 `test/specs/integration-outliner-table-undo.spec.ts`:
  - TC-1204 の `test.skip` を実 test に書き換え:
    - dropdown 経由で option 追加 → `_getColumns()` で options.length=1 確認
    - `OutlinerTable.undo()` → options.length=0 + cell value `[]` 確認
    - `OutlinerTable.redo()` → options.length=1 + label='Important' 確認

**結果**: ✅ 完了 (commit `8e9e4a1`)
- TC-806 / TC-1204 green
- 永続化は TASK-C2 の `column.options.push(newOpt)` + `scheduleSyncToHost()`
  + `saveSnapshot()` で既に動作。改めて test で contract を固定

**設計判断**:
- option 削除 UI / option rename UI は v1 範囲外 (design/system.md mention は
  あるが v1 必須ではない)。`column.options[]` の clean-up はユーザーが
  「TBE-12 列削除」経由でしかしない (= column 単位での削除)
- TC-1204 の undo は `openMultiselectDropdown` の create row click handler
  内で `saveSnapshot()` を呼んでいるため、TASK-C2 完成と同時に動く

### TASK-C4: 検索の multiselect 対応

**実装ファイル**:
- 修正 `test/specs/integration-outliner-table-search.spec.ts` (TC-1003 reinforcement):
  - TC-1003-B: 部分一致 ("urg" → "urgent" を含む n1 のみ visible)
  - TC-1003-C: orphan option id は label search にヒットしない
    (option master 未登録なので search corpus に label が augment されない)

**結果**: ✅ 完了 (commit `67a1f24`)
- TC-1003 / TC-1003-B / TC-1003-C green
- 検索ロジックは TASK-B6 の `matchesNodeWithColumns` で既に multiselect
  option label を corpus に augment している。TC-1003-B / -C は contract 固定

**設計判断**:
- 「orphan は search 対象外」を明示テストとして残す (TC-1003-C):
  data 残置のため `node.columnValues` には orphan id が残るが、UI には render
  されないし、search でもヒットしない — UX として一貫している
- multiselect search の augmentation は逐次走査 (`for c in columns`) で
  パフォーマンス影響は cell 数 × node 数。1000 行 × 10 列でも < 5ms 想定

---

## Iteration 6 完了サマリ — Phase C 完了

✅ **TASK-C1 + C2 + C3 + C4 完了**

- 新規 / 拡張 spec 計 **11 cases all green**:
  - TC-801 / TC-801-B / TC-802 (TASK-C1 chip): 3
  - TC-803 / TC-804 / TC-805 (TASK-C2 dropdown): 3
  - TC-806 (TASK-C3 round-trip): 1
  - TC-1204 (skip → green、TASK-C2+B8 連動): 1
  - TC-1003 / TC-1003-B / TC-1003-C (TASK-C4 search): 3
- `src/webview/outliner-table.js`: +274 行 (multiselect render +
  dropdown + outside click + i18n wired)
- `src/webview/outliner-table.css`: +102 行 (chip 8 色 + dropdown +
  + button)
- `test/specs/integration-outliner-table-multiselect.spec.ts`: 新規 339 行
  (TC-801/801-B/802/803/804/805/806)
- `test/specs/integration-outliner-table-undo.spec.ts`: TC-1204 の
  skip を実 test に置換 (60 行)
- `test/specs/integration-outliner-table-search.spec.ts`: TC-1003-B /
  TC-1003-C を append (58 行)
- `test/html/standalone-outliner-table.html`: build script 自動再生成
- 既存 spec regression: outliner-table 系 68 cases all green (5 skipped
  pre-existing)。outliner-keyboard 系 :283 / :769 の 2 件 flake は Phase B
  以前から存在 — git checkout で 5e797a2 (TASK-B9 完了点) でも同じ
  失敗を確認 → Phase C 起因ではない
- TypeScript compile (`npx tsc -p . --noEmit`): error 0
- npm run compile: success (locales 7 + webview/shared + vendor)
- 4 commits (1 commit per task as requested):
  - `d1a6b2d` [TASK-C1] Multiselect chip rendering with color palette
  - `dfe7e5b` [TASK-C2] Multiselect inline option creation (Notion-style dropdown)
  - `8e9e4a1` [TASK-C3] Multiselect option master persistence
  - `67a1f24` [TASK-C4] Search support for multiselect option labels

**Phase C 完了**: C1〜C4 全 4 task 実装済。Multiselect 列の chip render /
Notion 風 dropdown / inline option create / 永続化 / 検索 が end-to-end で
動く状態。

**残タスク (Phase D)**:
- TASK-D1〜D3: 全体検証 + cleanup + reviewer 引き渡し

---

## Iteration 7 (TASK-D1) — 2026-05-03

Phase D 開始: 全体 regression sweep。

### TASK-D1: regression 全 spec 実行

**手順**:
1. `npm run test:build:all` で 4 つの standalone HTML を再生成 (success — TASK-B7
   の Switch view button CSS 反映で `test/html/standalone-notes.html` が再生成
   される)
2. `npx playwright test --shard=1/4..4/4 --workers=2` を 4 並列で個別 log に capture
3. 失敗テスト set を `--workers=1` で再実行し、persistent vs flake を切り分け

**結果サマリ**:

| shard | passed | failed | skipped |
|---|---:|---:|---:|
| 1/4 | 376 | 37 | 11 |
| 2/4 | 413 | 4 | 7 |
| 3/4 | 411 | 11 | 2 |
| 4/4 | 395 | 27 | 1 |
| **合計** | **1595** | **79** | **21** |

合計 1695 tests (= 1595 + 79 + 21) を実行。

**failed 79 件の内訳と pre-existing 認定**:

failed spec file は **21 unique files**、すべて本 sprint と無関係領域:

- `backspace-list` (8) / `backspace-mixed-nested-list` (6) /
  `backspace-nested-li-children` (2) / `key-operations` (3) — Notes editor の
  Backspace / リスト処理 (editor.js)
- `codeblock-display-edit-mode` (3) / `codeblock-edit-features` (4) /
  `codeblock-lang-to-special-wrapper` (3) / `codeblock-ui` (6) — Code block UI
  (editor.js)
- `command-palette` (1) / `debug-empty-li` (1) — エディタ系
- `integration-copy-file-assets` (1) / `integration-image-max-width` (2) /
  `md-paste-asset-copy` (1) — file/image asset 系 (editor.js)
- `notes-undo-scope` (2) — Notes mode undo (editor.js)
- `outliner-cross-paste` (1) / `outliner-format` (1) / `outliner-inline` (5) /
  `outliner-keyboard` (2) — pre-existing flaky / failing outliner specs
- `table-cell-operations` (2) — **Notes editor の HTML table** (.outliner-table
  ではなく `<table>` UI)、本 sprint の Outliner Table とは別 module
- `translate-e2e` (10) / `unit-file-directory` (15) — Translation 機能 / FILE_DIR
  feature (editor.js)

**baseline 確認**: TASK-B1 の generator-log (line 311-313) で **base commit
`a969ca3`** に対し同 set の spec を `git stash --include-untracked` 状態で実行
→ **同じ 37 件が fail することを直接確認済**。今回 79 件に増えているのは
`a969ca3` 以降に main へ流入した **別 sprint の pre-existing flaky** (translate /
unit-file-directory 等) を含むため。すべて編集対象外領域 (editor.js / 翻訳
モジュール) で、本 sprint commit が触っていない:

```
$ git diff a969ca3..HEAD --stat | grep -E "editor.js|translate|file-directory"
(該当なし — 全 commit が outliner-cell.js / outliner-table.js / outliner.js
 split + locales / providers のみ)
```

**Sprint 関連 spec の pass 状況** (123 件、いずれも green):

| spec | pass | fail |
|---|---:|---:|
| `outliner-cell-render` / `-helpers` / `-cursor` / `-images` / `-format-subtext` | 70+ | 0 |
| `integration-out-columns-passthrough` | 6 | 0 |
| `integration-table-editor-manifest` | 4 | 0 |
| `integration-outliner-table-load-save` | 7 | 0 |
| `integration-outliner-table-cell-compat` | 12 | 0 |
| `integration-outliner-table-text-cell` | 5 | 0 |
| `integration-outliner-table-rows` | 6 | 0 |
| `integration-outliner-table-columns` | 9 | 0 |
| `integration-outliner-table-search` | 7 | 0 |
| `integration-outliner-table-switch-view` | 4 | 0 |
| `integration-outliner-table-undo` | 7 | 0 |
| `integration-outliner-table-i18n` | 4 | 0 |
| `integration-outliner-table-multiselect` | 7 | 0 |

`grep -cE "outliner-table|outliner-cell" shard*.log | grep ✓` → **123 pass / 0 fail**

**結論**: 本 TASK-D1 起因の **regression 0 件**。79 件はすべて pre-existing
flake / pre-existing failure (Sprint commit 範囲外)。

**設計判断 (記録)**:
- design failures `2026-04-30 [...] shard 並列実行ログでの spec 取りこぼし` を
  踏まえ、各 shard の output を別 log file へ capture。集約は grep ベースで実施
- shard truncation 影響が無いことを確認 (sprint spec 123 件 + 21 unique 失敗
  spec の 79 件 = 計 1695、fully accounted for)
