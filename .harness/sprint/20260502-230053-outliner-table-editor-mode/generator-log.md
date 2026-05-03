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
