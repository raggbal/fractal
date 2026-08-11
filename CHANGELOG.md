# Changelog

All notable changes to the "Fractal" extension extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.28] - 2026-08-12

### Added
- **Headerless tables** (FR-TBL-01/02/03, ADRL-0052): a new "Header" toggle on the table toolbar hides the header row (turn it back ON to restore it — or, for tables pasted without a header, to promote the first row into a header). Pasted HTML tables that have no heading row now come in headerless instead of growing an empty header band. The markdown stays GFM-compatible: a `<!-- fractal-headerless-table -->` marker plus the preserved header row, so other editors still render a valid table.
- **Blocks inside list continuation lines** (FR-LC-05..08): quote blocks and code blocks can now be created *inside* a list item's continuation lines (Shift+Enter lines) via `> ` / ``` \`\`\` \`\`\` autoformat, the `Cmd+/` palette, the toolbar, and `Ctrl+Shift+Q/K` — and they round-trip through markdown as nested li content. A full editing contract ships with it: arrow keys enter/leave the block reliably (including past adjacent images), Enter adds a list row after the item, Backspace follows the line model (empty block → shell removed, line start → merge with previous line), and list structure is never dissolved into the parent.

### Fixed
- **Excel range-paste no longer inserts a screenshot** into the last cell (FR-TBL-04): the Kiro paste path now applies the same "rich HTML wins over image" guard as the standard path. Copy-as-picture and screenshots still paste as images.
- **Empty code block Enter/Backspace symmetry** (FR-CB-01): pressing Enter N times in an empty code block no longer accumulates irreversible newlines — Backspace removes them one at a time, and a truly empty block escapes to a paragraph. Saved markdown no longer gains newlines on each round-trip.
- **Empty quote blocks can be deleted with Backspace** (FR-QB-01): a completely empty blockquote now escapes to a paragraph, same as code blocks. Quotes containing only an image or checkbox are protected (content ownership rule).
- **Ctrl+T table insertion** called an undefined function and silently failed; it now inserts the same table as the toolbar (FR-TBL-05).
- **Cmd+Z cursor stability in lists with in-li blocks** (re-opens ⑩..⑭): a long series of undo bugs was fixed at the root — undo snapshots are now captured as same-instant {markdown, cursor} pairs at beforeinput, always serialize the live DOM (no stale-variable snapshots), exclude UI decoration text from cursor offsets, restore into pre/blockquote interiors via block-index + inner-offset, skip the render-invisible `<br>` before a block symmetrically on save/restore, and no longer misparse a mid-typing bare `>` as an empty quote. Undo after editing around in-li blocks keeps the caret in the same list row and enters code blocks correctly.
- **Kiro: Cmd long-press shortcut HUD** was verified working after the `isKiroEnv()` seam refactor (FR-KH-01); the earlier report traced to an outdated installed build.

## [1.1.27] - 2026-08-10

### Added
- **Drag & drop into the side-panel markdown editor — full matrix** (FR-TF-19, sprint 20260809-031217 reopened): outliner 📎 file nodes, outliner page nodes, and markdown 📎/subpage links can now be dropped onto any open markdown editor (main pane and side panel alike). Previously the editor only accepted tree items; drops from the outliner or another markdown pane were silently ignored. Dropping a link onto its own source document is a no-op.
- **Markdown links → outliner drops** (FR-TF-20): a 📎 file link or subpage link dragged from a markdown editor onto an outliner lands at the indicator position as a file-attachment node / page node, and the link is removed from the source document.

### Changed
- **Cross-note drag & drop now follows the cut-paste contract** (FR-TF-18, ADRL-0051): dropping a file or markdown item onto an editor showing a *different* note copies the physical file into the destination note (`files/` or note root), removes the source ledger entry (tree item / node / link), and **keeps the source file on disk** as an orphan — recoverable, and collected later by Clean Notes in the source note. Cross-note links never point across note folders (a silent data-loss path that Clean Notes could not protect). The existing "tree md → other note's side panel" drop, which used to keep the tree item, now removes it for consistency.

### Fixed
- **Tree file → side-panel markdown drop did nothing** — the bridge method was defined in only one of the two per-webview host-bridge blocks, so the side panel over an outliner page hit a silent no-op guard. Both blocks are now kept symmetric and guarded by a block-level wiring test.
- **`# C#`-style titles were truncated** in the new subpage-link paths (inline H1 regex replaced with the CommonMark-compliant `extractFirstH1`).

## [1.1.26] - 2026-08-10

### Added
- **VS Code Explorer → Note tree drag & drop** (FR-TF-17, sprint 20260809-031217 reopened): files dragged from the VS Code Explorer (hold Shift — a VS Code platform requirement for webview drops) are now accepted by the Note file tree. `.md` files register as markdown items, any other extension registers as a file item in the shared `files/` folder. Drop position (before/after item, into folder, list tail) matches the Finder path. The Explorer path reads files host-side, so the 50MB buffered-path cap does not apply.

### Changed
- **Hover highlight is suppressed while any drag is in progress** (FR-TF-16): during external file drags, internal tree reordering, and cross-editor drags, tree items / folder headers no longer light up with the hover color — only the dedicated drop indicators (drop line, import zone highlight) are shown, so it is always clear where the item will land. Hover behavior returns to normal the moment the drag ends (drop, leave, or cancel).

### Fixed
- **Markdown editor drop cursor jumped to the editor edge** — dragging over empty space in the editor (e.g. beside a 📎 attachment line) drew a full-height bar at the editor's left/right edge, far from the pointer. The cursor now follows the mouse position in empty areas.
- **Outliner drop outline disappeared on the focused row** — the dashed "droppable" border around the outliner was painted under the focused row's water-blue background, so the left edge looked broken. The border is now drawn as an overlay above all rows.

## [1.1.25] - 2026-08-10

### Added
- **Note file tree now manages arbitrary files (third item kind alongside .out / .md)** — sprint 20260809-031217-notetree-file-dnd:
  - Drag & drop any file from Finder / VS Code Explorer into the tree; the file is stored in the shared `files/` folder (original name preserved, unique-suffix on collision, 50MB/file cap with explicit error). Clicking a file item opens it in the OS default app.
  - Full drag & drop matrix (ownership-transfer semantics — the physical file never moves, only the owning ledger changes): tree file → tree .out item (attaches as top file node) / tree file → tree md item (appends `[📎 name](files/...)` link) / tree file ⇄ open Outliner Editor (drop-position aware, both directions) / tree file ⇄ open Markdown Editor incl. sidepanel (both directions).
  - Context menu parity: Open / Reveal in Finder / Rename (title only) / Favorite / Copy Path / Set Color / Move Other Note / New Outline here / New Markdown here / New Subfolder / Delete.
  - Explore filter matches file items by title/filename with a [file] badge.
- **Drop-position indicator for tree → outliner drags** — dragging a tree md/file item over outliner nodes now shows the same before/after/child indicator as node reordering, and the drop honors it (md previously always inserted at top; that path stays as fallback).

### Fixed
- **Clean Notes / startup integrity for tree files**: tree-registered files are counted as live (never garbage-collected), and items whose physical file disappeared (e.g. S3 split-brain) self-heal on startup.
- **Drop at the very first row landed at the bottom** — 'before' insertion at the first sibling was mis-resolved to a tail append in all three drop-result paths (file / md / import).
- **📎 file links inside markdown could not actually be dragged** — anchors inside contenteditable need `contenteditable=false` + `user-select:none` for the browser to start an element drag; now applied on render and on insert, so links are draggable after reload too.
- External file drops onto the tree no longer silently skip non-md files (superseded FR-T01 behavior from v1.1.19).

## [1.1.24] - 2026-08-09

### Added
- **Cross-note copy/paste now duplicates linked files in all four directions** — selecting markdown containing image / 📎 file / subpage links and pasting into another note now copies the actual files into the destination note (previously only the sidepanel md path worked; main-pane md → md and md → outliner silently pasted broken links):
  - **md → md (main pane)**: images, attachments, and subpage `.md` files (recursively, including their own images) are duplicated into the destination note and links are rewritten
  - **md → outliner**: whole-line image / 📎 / subpage links become proper attachment, image, and page nodes (clickable, backed by duplicated files); mixed text lines keep working links; plain external text pastes unchanged
  - Cut (`Cmd+X`) follows the existing cross-note semantics: same note = move, different note = duplicate (source file kept as orphan for cleanup)
- **Side panel header overflow menu** — when the panel is too narrow, buttons that no longer fit collapse into a "…" menu (rightmost first, VS Code toolbar style) instead of hiding behind a barely-visible horizontal scrollbar. Widening the panel restores them; works with the translation view

### Fixed
- **File names containing spaces were silently skipped during paste duplication** (e.g. `My Document.docx`) — asset extraction now uses the canonical markdown link parser instead of a whitespace-breaking regex, in both md → md and md → outliner paths

## [1.1.23] - 2026-08-07

### Fixed
- **External edits (Claude Code, kiro, other AI CLIs) not appearing in the editor** — fixed across all three markdown surfaces:
  - Standalone md tabs now use the hybrid file watcher (FSW change+create events plus 1s polling), so atomic-rename saves (how Claude Code writes files) and files outside the workspace are detected
  - Side panel and Notes md no longer silently drop change events that arrive during Fractal's own auto-save; the event is held and reconciled right after the save completes. This also fixes the lost-update where the next auto-save could overwrite the AI's edit
  - Leaving the editor (blur / tab switch) no longer discards a queued external update when your own edits are already synced
- **Side panel outline (TOC) not updating on external edits** — the table of contents now follows external content changes; in Notes, an externally-changed H1 also updates the tree title

## [1.1.22] - 2026-08-06

### Added
- **Shift+Enter inserts a line break inside the node text** (Outliner and Table view) — matching what Mindmap already allowed, so all three views now agree. Line breaks live in the `.out` file losslessly and are view-only: markdown conversions (node copy as markdown, llms.txt, plain-text clipboard) flatten them to spaces, while internal node copy/paste keeps them

### Changed
- **Subtext (note) open/close moved to `Shift+Cmd+Enter`** (was `Shift+Enter`), now a single toggle key. Inside the subtext, Shift+Enter is a plain line break
- Page-node title sync now uses the **first line only** in both directions (node → H1 and H1 → node, continuation lines preserved) — this also fixes a latent bug where a Mindmap-added line break could corrupt the page H1

## [1.1.21] - 2026-08-06

### Fixed
- **Cmd+F / Cmd+H not working in the Notes markdown editor** (main pane) — the outliner's global search-shortcut fallback was intercepting the keys even when focus was in the markdown pane, opening an invisible outliner search instead. The fallback now defers to the markdown editor's own in-document search (standalone and side-panel editors were unaffected)

## [1.1.20] - 2026-08-06

### Added
- **Markdown list continuation lines (CommonMark)** — indented non-list lines inside a list now join the previous list item as an in-item line break instead of breaking the list (fixes Quip-exported lists collapsing on paste)
- **Shift+Enter in lists creates a continuation line** — a line break within the same list item (replaces the old "new item" behavior, which duplicated Enter). Mid-text Shift+Enter wraps in place with no blank line
- Continuation lines serialize back to markdown as marker-width indented lines, so round-trips are lossless

### Fixed
- Copying list items with continuation lines lost the line breaks (bare `<br>` now serializes as a newline, including across bold spans)
- **Multi-line selection copy now always produces list markdown**, regardless of how much of the first line is selected (previously a partial first-line selection could turn the first item into a paragraph or drop the list entirely). Single-line partial selections still copy as plain text

## [1.1.19] - 2026-08-06

### Added
- **External .md drag & drop onto the Notes file tree** — dropped files are copied under a new id and registered (H1 becomes the title); non-md files are silently skipped
- **Depth-cycled ordered-list markers** — nested numbered lists render as 1,2,3 → a,b,c → ⅰ,ⅱ,ⅲ (cycling, 9 levels), in the editor and PDF export; the .md file keeps plain `1. 2. 3.`

### Changed
- **Ordered-list numbering semantics unified** (ADRL-0042, supersedes ADRL-0023): a typed number only matters at the head of a run; adjacent numbered lists always join with automatic renumbering; splits preserve the visible numbers. Wired across every path — typing, toolbar/shortcut conversion, backspace (empty & non-empty), Tab/Shift+Tab, Enter escape, range delete/cut
- Empty numbered-list items now demote to a bullet on the first backspace (same two-step as non-empty)

### Fixed
- Numbered list resetting to 1 when converting a middle item via toolbar / Ctrl+Shift+U
- Typed start numbers being ignored on bullet lines (`2. ` at a bullet head now works, at any nesting level)
- Mixed bullet/numbered list pastes nesting incorrectly when indented with 4+ spaces (nesting is now judged by stored indentation, not stack depth)
- Cursor jumping to the wrong line after deleting an empty bullet between numbered lists

## [1.1.18] - 2026-08-05

### Added
- **Copy in-App Link everywhere** — file-tree right-click (out/md), Outliner header Menu, and md editor toolbar (right of Copy Path, Notes md only)
- **New in-app link forms** — `fractal://note/{folder}/{outFileId}` (outliner) and `fractal://note/{folder}/md/{mdFileId}` (note md), backward compatible (ADRL-0039)
- **Shortcut HUD** — long-press cmd (800ms) shows a keyboard-shortcut overlay with a mode title and per-view lists (Markdown / Outliner / Mindmap / Database), resolved dynamically (sidepanel md → Markdown list)
- **md D&D as subpage** — dropping an external .md into any md editor registers it as a subpage (`[[title]](file.md)`, unique name next to the current md) instead of a files/ attachment
- **Note-tree ⇄ editor md D&D** — tree md → Outliner (page node), tree md → md editor / sidepanel md (subpage link), subpage anchor → tree; same-note moves never copy/rename (ownership moves), cross-note drops duplicate
- **Code block wrap toggle** — new ↩ button in the code block header (display-only, carries into the fullscreen popup)

### Changed
- Display name renamed to **Fractal Note** (identifiers, setting keys, and the `fractal://` scheme unchanged)
- File-tree "+" button now reads "+out"; in-app-link icon replaced with a horizontal link glyph (uniform button width)
- Outliner page-md → tree drag now starts from the 📄 page icon (bullet is reorder/subtree-move only)

### Fixed
- Path traversal in the new md link resolution (clamped to the note folder, ADRL-0040)
- First click on a tree item being ignored right after drag & drop
- Pasted .md paths (Copy Path) now show the link icon immediately

## [1.1.17] - 2026-08-04

### Added
- **outliner: tag サジェストのキーボード選択** — Search box で ↓ を押すとサジェストに入り、← → で選択（端で停止）、Enter で検索ボックスに反映して即検索。↑ / Esc で選択を抜ける。outliner / table / mindmap の全 view で利用可
- **outliner: タスクモードの適用範囲を選択可能に** — ON 時にポップアップで「トップレベルのみ / 全てのノード」を選択（前回の選択がデフォルト・Enter 一発確定・Esc でキャンセル）。選択は .out に記録され、OFF 時はその範囲だけ解除（トップのみ選択なら手動で子に付けたチェックボックスは残る）。ON 中に追加した新規ノードにも選択範囲に従ってチェックボックスが付く。既存の .out は「トップレベルのみ」扱いで従来と同一動作

### Fixed
- **outliner: 未編集ノードの #tag がサジェスト・検索に出ないバグ** — タグはノードを編集した時にしか抽出されず、外部ツール由来・旧ファイル・外部編集されたノードのタグが検索ボックスのサジェストにも #tag 検索にも出なかった → ファイルを開くたびに全ノードのタグを本文から再計算するように（開いた瞬間に自己修復）

## [1.1.16] - 2026-08-03

### Changed
- **S3 sync / 翻訳が AWS CLI 不要に** — aws CLI の子プロセス呼び出しを AWS SDK（JavaScript v3）内蔵に完全移植。CLI のインストール・PATH 設定なしで、設定に認証キーを入れるだけで S3 sync と Amazon Translate が動く。newer-wins 同期・`--delete` 不使用などの動作は従来と同一。注意: HTTP(S) プロキシ経由の接続は現在非対応（既知制約）
- **翻訳ボタンをツールバー右側（PDF ボタンの左）に移設** — `fractal.showTranslateButtons` が ON なら、note markdown / standalone markdown の両方で、toolbar が simple モードでも翻訳ボタンが見えるように（従来は full モードのツールバー内のみで、simple では隠れていた）。押すと従来どおりの翻訳結果画面が開く

### Fixed
- **sidepanel の翻訳がメイン画面も翻訳画面にしてしまうバグ** — note md + sidepanel md を開いて sidepanel で翻訳すると、メインの note md まで翻訳画面に切り替わっていた → 翻訳結果は要求した側（sidepanel / メイン）にだけ届くように。逆方向（メインで翻訳 → sidepanel が汚染される潜在バグ）も同時に修正
- **sidepanel 翻訳結果画面の不要ボタンを非表示** — read-only の翻訳結果画面から app link / Open in new tab ボタンを除去（閉じる・戻る・開き直しで復元）
- **sidepanel の app link ボタンの見た目** — ブラウザ既定の枠線が角丸枠として見えていたのを他ボタンと同じフラットな見た目に統一。ヘッダボタンの間隔ズレ（margin と gap の二重加算）も解消

### Internal
- 拡張本体を esbuild で単一バンドル化（SDK 同梱のため。webview/共有 JS の配布は従来どおり）。テストハーネスの collection 失敗を検出する gate を追加

## [1.1.15] - 2026-08-02

### Added
- **md editor: PDF エクスポート** — 開いている md を CSS を適用したデザインで PDF に変換（`Fractal: Export to PDF` コマンド + toolbar / sidepanel header の PDF ボタン〔Export bundle の左〕）。standalone md / Notes md タブ / sidepanel md（Notes・Single Outliner）すべて対応。エディタ表示と同じレンダリング結果（mermaid・数式・文字色・チェックボックス込み）がそのまま PDF になる。生成はローカルの Chrome/Edge を利用（拡張への依存追加なし・外部通信なし）
- **md editor: PDF のデフォルト改ページ** — h1 と h2 の前で改ページ。ただし最初の h1 の前と、各 h1 直後の最初の h2 の前には入れない（章扉が自然に組まれる）。印刷向けクリーンスタイル（A4・白背景）を同梱
- **md editor: PDF 用 CSS のユーザー設定** — `fractal.pdfStyles`（CSS ファイルパスの配列・後勝ち）+ `fractal.pdfIncludeDefaultStyles`（false で完全差し替え）。改ページの全廃・h3 追加などデザインと改ページ規則を CSS だけでカスタマイズ可能。`fractal.pdfBrowserPath` でブラウザ実行ファイルの明示指定も可

### Fixed
- **outliner / note ファイルツリー: D&D 挿入線が左右移動に反応しないことがある問題** — 挿入先の階層をマウスの水平位置で選ぶ操作が、上下に少し動かさないと効かないことが多かった → 判定帯を行の下端 25% から 40% に拡大し、純粋な左右移動でスムーズに線の長さ（挿入先の階層）が変わるように（outliner の node 境界・note 左サイドのファイルツリーのフォルダ境界の両方）

## [1.1.14] - 2026-08-02

### Added
- **outliner: 複数 node 選択の Export bundle** — 複数 node を選択して Export bundle すると、選択した全 node（+ 子孫）が 1 つの md にリストとして出力され、全 node 分の添付（画像・ファイル・page md）も bundle に含まれる。親子を跨ぐ選択も copy/cut と同じ扱い（重複なし）
- **outliner: D&D 挿入インジケータの indent 対応** — node 並べ替え・外部ファイル drop の挿入線が「落ちる先の階層の bullet 位置」から描かれ、どの親の子になるかが見た目で分かる。マウスの水平位置で挿入先の階層を調整可能（ファイルツリーと同じ操作感）。子にしたいときは node 本体に重ねる（青点線囲み）
- **md editor: .drawio ファイルの D&D 受理** — 素の .drawio を「drawio Desktop で変換して」ダイアログで弾かず、他の任意拡張子と同じ添付リンクとして取り込む（outliner と対称）。`.drawio.svg/.png` の画像表示 + drawio 連携は従来どおり

### Fixed
- **outliner: shift なし D&D で水色枠が残留するバグ** — drop が VS Code に横取りされる終わり方でも drop highlight・挿入インジケータが必ず解除されるように（drag 終了の安全網 + 解除条件の是正）
- **outliner: shift+D&D でファイル添付 node が作られないことがあるバグ** — node のテキスト部分への drop が吸収される問題（capture 先取りで解消）+ 環境により drop が認識されない問題（判定フォールバック）
- **md editor: 数字リスト格下げ後の行頭 backspace が段落化するバグ** — 上にリスト行がある場合は上のリスト末尾にテキストが結合されるように（v1.1.13 の 2 段階 backspace の後続修正）
- **md editor: 添付ファイル名の防御を Notes 内 md にも適用** — ファイル名 sanitize を共有関数に移設（連続ドットを含む正当なファイル名の破壊も修正）

## [1.1.13] - 2026-07-30

### Added
- **md editor: opt+enter でカーソル以降を子ノードに折り返し** — リスト項目の途中にカーソルを置いて opt+enter すると、カーソル以降のテキスト（リンク・太字・画像も構造ごと）が新しい子リスト項目に移る。行末なら従来どおり空の子を作る
- **md editor: 数字リスト行頭の backspace が 2 段階に** — 1 回目で通常バレットに格下げ（タスクリストのチェックボックス剥がしと同じ抜け方）、2 回目で従来どおり上の行に結合。格下げしても残りの数字リストの表示番号は変わらない

### Fixed
- **md editor: リスト型変換で以降の数字が 1 に振り直される既往バグ** — 数字リストの途中の行を `- ` などで型変換すると、以降の項目の表示番号が 1 起点に化けていた → 分割後のリストに開始番号を引き継ぐように（backspace 格下げと共通経路の修正）

## [1.1.12] - 2026-07-30

### Added
- **md editor: 数字リストの開始番号を保持（CommonMark 準拠）** — 段落を挟んで分断された数字リストの 2 個目を「3. c」と書けば 3, 4, … と続けられるように（従来は常に 1 に振り直し）。「4. + space」のオートフォーマットも 4 起点のリストを作る。先頭項目の番号がリストの開始番号（`<ol start>`）を決め、2 個目以降の飛び番は連番に正規化。1 始まりのリストは従来と完全に同一動作
- **md editor: 開始番号の異なる隣接リストは無言統合しない** — 明示的な開始番号を持つリストは番号が連続する場合のみ統合され、打った番号・保持した番号が黙って消えない（段落→リスト変換の Ctrl+Shift+O 経路含む）

## [1.1.11] - 2026-07-28

### Fixed
- **outliner: note 間の node コピーで 2 個目以降の添付（page md / 画像 / ファイル）が複製されないバグ** — 内部クリップボード store の one-shot 消費が最初の複製処理後に store を消し、以降の複製が silent no-op になっていた（cut では構造的に必ず発生）→ 消費を廃止し全 node の添付が確実に複製されるように
- **outliner: cmd+c が cut として扱われる誤判定の防御** — クリップボード書き込みの async 失敗で古い cut メタが OS クリップボードに残留し、次の copy 操作を cut と誤判定していた → 失敗時フォールバック + host 側で copy/cut を突き合わせて矯正（誤判定時は新 pageId を発行し、2 つの node が同じ page md を共有する事故を防止）

## [1.1.10] - 2026-07-28

### Fixed
- **md editor: リスト cut（cmd+x）の空マーカー残り** — ネストリストを範囲選択して切り取ると空の •/○/▪ 殻が残っていた → 選択内の空 li を掃除（画像・チェックボックス付き bullet は保全）
- **md editor: cut→paste でネスト構造が崩れる** — cut のクリップボード変換が「先頭テキスト+子リスト」を連結した壊れた markdown を生成していた → copy と共通化し、空 li への paste で相対ネストごと正しく接ぎ木されるように
- **md editor: タスク行のテキスト全選択 cut でチェックボックスだけ残る** — 行ごと消えるように（部分選択では checkbox 維持）
- **md editor: cut 直後の cmd+z でチェックボックスが消えた状態に戻る（約50%）** — cut だけ undo スナップショットが無く、古い状態に戻っていた → cut 前の状態を確実に記録

## [1.1.9] - 2026-07-28

### Fixed
- **md editor: リスト変換で link/subpage が消えるバグ** — URL・md リンク・ファイルリンク・subpage を含む行の行頭で `- ` を打ってリスト化すると、リンクがプレーンテキストになっていた。`1. `・`- [ ]`・`# `・`> ` の入力ルール、ツールバーのリスト/見出し/引用変換、リスト項目内の型相互変換も同じ問題を修正（全 11 経路。standalone / sidepanel / note md 共通）

## [1.1.8] - 2026-07-28

### Added
- **Notes タブ: cmd+w でタブを閉じる** — 複数タブのときアクティブタブを閉じる。タブが 1 つのときは VS Code に流れて VS Code タブが閉じる
- **Notes タブ: D&D 並べ替え** — タブをドラッグして並び替え（挿入位置インジケータ付き。スクロール位置・サイドパネル状態は維持）
- **Notes タブ: 右クリックメニュー拡充** — 「Close Other Tabs」（そのタブだけ残す）「Duplicate Tab」(同じファイルを完全独立の新タブで開く)。outliner タブでもメニューが出るように

### Changed
- **タブ右クリック「Open in VS Code Tab」→「Open in Standalone」にリネーム**（機能は不変）

## [1.1.7] - 2026-07-27

### Added
- **cmd+click で新規タブ**: note ファイルツリーの md / outliner を cmd（ctrl）+click すると webview 内タブで開く（通常 click はメインペイン差替のまま）。outliner の 📄 page アイコンを cmd+click すると page md を新規タブで開く（Notes=webview 内タブ / Single Outliner=VS Code タブ）
- **Outliner node の Export bundle**: node 右クリック →「Export bundle」→ フォルダ選択（Export here）→ `<nodeId>/` フォルダに node ツリーの md リスト（`<nodeId>.md`、cmd+c→cmd+v と同じ見た目）+ page md 複製（本文画像込み）+ ファイル添付（`files/`）を出力。node 直付き画像は対象外。キャンセル時は何も作らない

## [1.1.6] - 2026-07-27

### Added
- **Outliner ノードリスト → md editor paste で添付を複製**: cmd+c した node リストを md editor（note md / sidepanel md / standalone）に cmd+v すると、page md は subpage リンク `[[title]](<id>.md)` として対象 md と同じフォルダに複製、ファイル添付は `[📎 title]` リンクとして files/ に複製、node 画像も複製。行はリンクのみ（nodetext の重複なし）

### Fixed
- **ファイルツリー D&D: md を outliner の上下（兄弟）にドロップできないバグ** — md→.out は全域が「取り込み」になっていた → 上 25%=兄 / 中央 50%=取り込み / 下 25%=弟 の 3 ゾーンに
- **ファイルツリー D&D: 線が出ているのにドロップが失敗する** — item 間の谷間で drop が不発になっていた → 線が出ていればその位置に必ず drop
- **ファイルツリー D&D: ネスト末尾の後ろに親の兄弟として置けない** — マウスの横位置（インデント）で「深い階層の後ろ ⇄ 親フォルダの後ろ」を選べるように（線が階層に追随）

## [1.1.3] - 2026-07-27

### Fixed
- **Mindmap: Group が他要素と重なる問題** — レイアウトが Group の枠余白（padding + ラベル帯）を確保するように。Group 同士・Group と非メンバーノードが重ならない（Group なしのレイアウトは不変）
- **Mindmap: title 中心ノードの幅が 80px に潰れる問題** — 実測再レイアウト（pass-2）が title のテキストを見ておらず下限幅に確定していた（長い title が縦に折り返されていた）

### Changed
- **Mindmap: Group ラベルの位置** — 右展開 Group は左上端（従来どおり）、左展開 Group は右上端（中心側）に表示

## [1.1.2] - 2026-07-27

### Added
- **Mindmap: Group の右クリックメニュー**: Rename Group…（名前の追加・変更・削除。カスタムダイアログ・undo 対応）/ Delete Group

### Fixed
- **Mindmap: Group 枠を右クリックすると「Create Group」が出るバグ**（Group 上の右クリックが空白扱いに落ちていた → Group 専用メニューを表示）

## [1.1.1] - 2026-07-27

### Added
- **Chrome 拡張 v0.4.0 — i18n 対応**: デフォルト英語 + Settings（options）で日本語切替（`chrome.storage.local`）。
  popup / options / 通知 / エラー / 生成 md メタラベル（Source/Author/Site ⇄ 元ページ/著者/サイト）の全 59 文言を辞書化（`lib/i18n.js` + `lib/i18n-messages.js`）
- **AI Skills — fractal-search 検索強化**:
  - `--outline-name`（outliner 名の AND プレフィルタ・単独で一覧モード。`--find-outline` は互換維持）
  - `--h1`（md 先頭 H1 検索。CommonMark 準拠 — `# C#` の末尾 `#` 保持・コードフェンス内無視）
  - `--list-notes` / `--list-folders` × `--note-name`（note 一覧 + 名前検索。`--json` に name/dirName）
  - 全フィルタ AND 合成（note → outliner → md(H1) → 本文/tag/checked）

### Fixed
- **AI Skills: symlink 経由の CLI 実行が無反応になるバグ**（import guard が realpath 差で不一致。
  `~/.claude/skills` 等 symlink 配置の全 fractal 系 skill に影響 — 全 6 mjs を realpathSync 対応に修正）
- fractal-md.mjs の H1 抽出がコードフェンス内の `#` を誤検出する問題（正典ミラーに置換）

## [1.1.0] - 2026-07-27

### Added
- **Mindmap で Task Mode**（FR-017 の Mindmap 拡張）:
  - ノードのチェックボックスをクリックで完了/未完了トグル（undo / 永続化対応）
  - `Cmd+Shift+X`（チェックボックス追加/トグル）/ `Cmd+Shift+Option+X`（削除）— Outliner と同一キーバインド
  - 右クリックメニューに Add Checkbox / Remove Checkbox（i18n 対応）
  - **Task Filter が Mindmap でも有効**: 完了ノードは子孫・接続線ごとマップから消える（minimap / fit / export も整合）
  - ヘッダーの Task Mode / Task Filter / Archive ボタンを Mindmap 表示中も操作可能に
  - データは Outliner と完全共有（`node.checked` / `taskMode` / `taskFilter`）— view を往復しても状態は不変

### Fixed
- Mindmap ヘッダーの task 系ボタンの click 配線を冪等化（再初期化環境での二重発火防止）

## [1.0.0] - 2026-07-26

最初のメジャーリリース 🎉 — Markdown・Outliner・Database・Mindmap を Notion のようにひとつの場所で管理する、というコアコンセプトが一通り揃ったため 1.0.0 としました。

### Added
- **設定 `fractal.showOpenInTextEditor`**（default: true）: Open in Text Editor ボタン（md toolbar / sidepanel header / outliner 右クリックメニュー）の表示を切替（Electron 化準備）。
- **drawio 画像の Open ボタンを 2 つに分離**: **Open in VS Code**（VS Code タブで開く。Draw.io Integration 拡張があればタブ内で draw.io エディタが開く）と **Open in External**（draw.io Desktop を優先起動 — mac は `open -a`、Windows は標準インストール先探索、Linux は PATH の `drawio`。無ければ OS デフォルトにフォールバック）。
- **Chrome 拡張 v0.3.0**: フラットレイアウト対応、保存先を「Note + Outliner/Markdown」で選択、**保存先プリセット**（複数登録 + ★default。popup は default 選択済みで即クリップ可、quick clip も default を使用）、**md への取込**（新規 `<uuid>.md` + 対象 md 末尾に subpage リンク追記）、Note 表示名は outline.note の noteTitle / md タイトルは本文 H1。
- **AI スキル拡張**（`claude_skills/` → `ai_skills/` にリネーム。Claude Code / Cursor / Kiro / Antigravity 対応）:
  - 新規 `fractal-doctor`（note 整合性チェック: 参照切れ・孤児・レイアウト検査。read-only）
  - 新規 `fractal-summary`（outliner / md を subpage 再帰込みで 1 本の markdown に集約）
  - `fractal-edit` に変更系 `fractal-modify.mjs`（text 書換 / check / 削除 / 移動）、`--create-md`（独立 md item 作成）、`--target-md`（md への subpage / 画像 / ファイル追加）
  - `fractal-search` に `--tag` / `--checked` / `--note-name` / `--exclude-note` フィルタ
- README を全面更新（4 モード別ショートカット表・draw.io 節・対応 OS 節）。

### Fixed
- **note を開いたとき、ツリー先頭が md だと空の outliner が表示される**バグを修正（md ペインで初期表示 + 初期タブ kind / 外部変更 watcher / テーマ変更リフレッシュ経路も対応）。
- **タブの閉じるボタン**が短いタイトルでタブ中央に来る問題を修正（右端固定）。
- **Windows パス互換**: 生ファイルドロップの `file:///C:/...` URI・`C:\` 絶対パスのリンク/画像解決を是正（macOS の挙動は不変）。

### Notes
- 動作確認は macOS のみ。Windows / Linux は実装済みだが未検証（Issues でのリクエスト歓迎）。

## [0.212.0] - 2026-07-25

### Added
- **standalone md の画像/添付保存先を指定できる**（FR-MD-01〜07）: fractal note 配下でない `.md` を単体で開いたとき、アウトラインパネル最下部の「画像保存先 / ファイル保存先」表示をクリックして保存先フォルダを選べる。保存先は md と同じフォルダの隠し JSON `.fractal.json`（`{imageDir,fileDir}`）に記録され、**そのフォルダの全 md が共有**する。**md 本文は一切変更しない**ので、Typora や GitHub など他エディタ・プレビューに設定が漏れない（ADRL-0016）。「デフォルトに戻す」で `<md と同じフォルダ>/images,files` に戻る。Notes / .out / outliner page md では従来どおり固定。
- **ノート左ファイルツリーの右クリック「Open in new tab」**: md も outliner（.out）も、左ツリーの右クリックメニューから webview 内の新しいタブで開ける。

### Changed
- **standalone md のデフォルト画像/添付保存先**: 従来は md と同じフォルダ直下だったが、`<md と同じフォルダ>/images/`・`/files/` サブフォルダに変更（Notes / outliner と揃えた）。
- **サイドパネル幅の永続化**: Notes を開き直したときにサイドパネル幅がデフォルトに戻る問題、および VS Code ウィンドウ幅を変えるとサイドパネルがエディタ領域をはみ出す問題を修正（note 単位の幅を updateData で正しく復元）。
- **サイドパネル md の「新しいタブで開く」ボタンを固定表示**（閉じるボタンと同様）。サイドパネル幅が狭くても隠れない。

### Removed
- 設定 `fractal.outlinerPageTitle` を削除（Outliner のページタイトル入力は常に表示）。
- 設定 `fractal.imageDefaultDir` / `fractal.fileDefaultDir` / `fractal.forceRelativeImagePath` / `fractal.forceRelativeFilePath` を削除（保存先は上記のとおり standalone md はサイドカー、他モードは固定に一本化）。既に settings.json にこれらのキーがある場合は無視される（挙動に影響なし）。

## [0.211.3] - 2026-07-25

### Added
- **インライン文字色**（FR-IC-01〜06）: markdown editor（header / 段落 / リスト / blockquote、**code 除外**）と outliner の node text で、選択テキストに文字色を付けられる。md は toolbar の色ボタン + cmd+/ コマンドパレット、outliner は右クリックメニューから 20 色 swatch + None を選ぶ。保存は `<span style="color:#hex">`（他 markdown エディタでも色が出て、未対応でもプレーンテキストに degrade。ADRL-0012）。色構文とサニタイズ（hex allowlist・ADRL-0013）を `src/shared/inline-color.js` に集約し md/outliner の 2 パーサで共有。outliner は md と同一エンコード（node.text 内に span 保存・編集モードは生タグ可視。ADRL-0014）。
- **リストへの複数行ペースト**（FR-PML-01）: リスト項目にカーソルがある状態で複数行テキストをペーストすると、各行が兄弟のリスト項目になる（従来はリスト全体の後ろに段落として貼られていた）。表・見出し・コード・ネストリストは従来どおり。

### Fixed
- **inline 要素の書式引きずり**（bold / italic / strike / code）: inline 要素を当てたテキストの直後にカーソルを置いて入力しても、前の書式を引きずらない。toolbar / コマンドパレットの bold・italic は execCommand の sticky typing style を apply-time でリセット、リロード後は beforeinput 境界ハンドラで要素外に出す（IME 変換中は横取りしないので日本語入力を壊さない）。
- **色の継続入力**: 色を付けたテキストの直後に打った文字は既定色になる（色を変えた範囲だけで完結）。
- **outliner の部分選択着色**: node text を部分選択して右クリック → Text Color で、選択範囲だけに色が付く（node 全体が着色されない。数値 source-offset 捕捉で picker の focus 再レンダーに影響されない）。
- **複数行ペーストの二重挿入**: Notes モードで複数行ペーストが 2 重に入る問題を修正（paste ハンドラの同一 tick coalesce）。
- **翻訳ボタンの重複**: note md / standalone md ツールバーで撤廃済みの translateLang ボタンが 2 つ並んで左が無反応だった問題を解消。

## [0.210.18] - 2026-07-24

### Added
- **Notes webview 内マルチタブ**（FR-TAB-01〜08）: Notes モードのメインペインで複数ファイル（`.out`/md）をタブで開ける。タブが 2 つ以上で `.notes-main-wrapper` 先頭に Tab Bar を表示（1 つなら非表示）。openInNewTab ボタン / 本文 `.md`・`fractal://` リンクの cmd+click / ＋ボタンの 3 契機で新タブ。切替は unload/load 方式（アクティブタブのみ実 DOM・非アクティブは軽量 Tab State）で ~20 タブでもメモリ安全。切替/閉じる前に flush（データ損失なし）。Tab Bar 横スクロール。他 note / note 外の md もタブで開ける。（ADRL-0008/0009/0010）
- **タブ右クリック「Open in VS Code Tab」**（FR-TP-06）: md タブを右クリック → 対象 md を standalone（`fractal.editor`）で開く（outliner タブは対象外）。
- **md Outline 閉じるボタンの ✗ 化 + file panel トグル移設**（FR-OU-01/02）: md Outline パネルの閉じるボタンを ☰ → ×。note md で file panel 閉 + Outline 開のとき、file panel 開トグルを Outline ヘッダ左に表示（editor 左端の ☰ は非表示・同機能ボタンが 1 箇所だけ）。
- **Recent 履歴の記録拡張**（FR-HP-08/09）: アプリ内リンク（`fractal://`）/ subpage・md リンクで開いた md、他 note / note 外の md も Recent に記録（`kind:'note-md'`・絶対パス・先頭 H1 で title 解決）。

### Changed
- **サイドパネルをタブと共存**（FR-SPC-01〜05・ADRL-0011）: サイドパネルの表示領域をタブ内領域（タブバー下端〜画面下端・ファイルパネル除く右側）に収める。開いたままタブ切替でき、タブごとにサイドパネル状態（開閉・md・スクロール）を復元。
- **overlay（シャドー背景）を全モード廃止**（FR-SPC-02/03）: サイドパネルのシャドー背景を DOM・CSS・JS から完全除去（Notes / .out single / .md single 全モード）。外側クリックで閉じない（Esc + ヘッダー ✗ で閉じる）。
- **タブ名を title/H1 に**（FR-TP-04）: タブ名を basename でなく Outliner title / md 先頭 H1 に。title/H1 変更で即時反映（tree 外 md も含め 3 保存経路すべてで反映・disk 書込を await してから解決）。
- **タブ選択/非選択の背景色を反転**（FR-TP-05）: 選択タブが明るい地色（editor と地続き・下境界線を消す）・非選択が灰。
- **Recent クリックは全メインペインで開く**（FR-HP-05）: page md も含め Recent の md は kind によらずメインペインで開く（`HistoryKind` から `page-md` を廃止し note-md・絶対パスに統一）。
- 「open new tab」の挙動を VS Code 別エディタタブ → webview 内タブに変更。

### Fixed
- **サイドパネル幅の追従**（FR-TP-01）: 左ファイルパネル開閉等で `.notes-main-wrapper` 幅が変わってもサイドパネル幅が editor 領域を超えないよう ResizeObserver で再クランプ。
- **タブ復帰時のチラつき/アニメ**（FR-TP-02/03・NFR-TAB-02）: タブ復帰のサイドパネルはスライドインアニメを再生しない。スクロール復元は単一同期タスクで完結しチラつかせない。outliner ヘッダーの検索状態（Search テキスト + Tree/Focus モード）を全モード（outliner/table/mindmap）で復元。view mode residual バグ是正。
- **タブ名の即時反映漏れ**（FR-TP-04）: open-new-tab で開いた tree 外 md（page md 等）の H1 編集が Recent/タブ名に即反映されなかった問題を修正（`notesSaveCurrentMd` が disk 書込を await してから title 再解決 + 3 保存経路の history フォールバック統一）。

## [0.210.0] - 2026-07-23

### Added
- **起動時フラットレイアウト移行ゲート**（FR-MG-01〜17）: 旧レイアウトの note フォルダ（per-`<stem>/` / `_notes_md/` / `<note>/pages/`）を開くと、本体を表示する前に移行ゲート画面を出し、共有フラットレイアウト（md=note 直下、画像/添付=共有 `images`/`files`、`.out` は pageDir="."）へ移行する。移行後は layout 状態自体がマーカーとなり再表示されない（永続フラグ不要）。移行は `loadStructure()`（ディスク書換）を呼ぶ前に検出し、gate 経路で loadStructure に到達する watcher / config-refresh も塞ぐ（開いただけでフォルダを崩さない）。
- **executePlan 前の自動バックアップ**（FR-MG-07）: 破壊的移行の前に note フォルダ全体を noteDir の外へコピー。backup 失敗時は移行を中止。backup 名は `.` 開始にしない（mac 可視）。移行完了後は backup 場所と復旧手順を通知。
- **cross-outliner 参照解決**（FR-MG-10/12）: node.pageId の md・画像・添付を「自 stem → 他 outliner stem → `_notes_md` → `<note>/pages/`」の横断で探索し、既存の連番リネーム + move + リンク書換に通す（1:1 所有維持）。
- **md リンクの subpage 判定と到達可能 md の移行**（FR-MG-13/14）: 本文プレーン md リンク `[label](x.md)` の `[[]]` 昇格を「同 outliner フォルダ内・node/note 未参照・本文リンクからのみ到達」の条件付きに。移行対象から本文 md リンクで到達可能な note 内 md を種別問わず全て flat へ移行（推移閉包）。「移行するか」と「昇格するか」は独立判定。

### Fixed
- **移行時のデータ損失を根絶**（複数の data-loss 修正）: (1) cross-outliner 参照（別 outliner フォルダの md/画像/添付）の移行漏れ、(2) 生きたページの本文 md リンクからのみ到達する md が昇格だけされ未移行で削除される問題、(3) `<note>/pages/` 旧レイアウト（pageDir 未指定 .out がページを分散）の探索・掃除漏れ、を修正。破壊的削除の前に「node/note/本文リンクで到達可能な全 md・画像・添付が flat へ移行済み」を不変条件とし、実 note 3 件（tepco2 / pace2 / aws2）で検証。到達不能な参照（真の「元々壊れ」）のみ unresolved として通知し、旧フォルダは掃除する。

## [0.209.52] - 2026-07-20

### Fixed
- **Recent 履歴パネルのタイトルが更新されない**: outliner の title / md の H1 / sidepanel の page md の H1 を変更しても Recent 一覧の表示名が古いままだった問題を修正。履歴を webview に送出する時点で各エントリの title を最新解決（note md=items.title / .out=disk data.title / page md=先頭 H1）するようにし、notesFileListChanged の全送出経路（9 経路）を単一ヘルパ getStructureForWebview に統一。sidepanel page md の編集は保存を await してから履歴を再送し、ファイル切替タイミングで最新 title が反映される。
- **drawio.svg / mermaid / math / 画像プレビューの背景が暗くて見づらい**: lightbox 拡大表示（.outliner-image-large）と mermaid/math の fullscreen（.block-fullscreen-*）で、透明背景の図形が暗いオーバーレイ越しに黒っぽく見えていた問題を修正。白背景 + 余白（padding）を付けて明瞭に表示するようにした（box-sizing:border-box で表示領域を超えない）。
- **outliner の title 変更が即時反映されない / タイトル↔H1 同期の 1テンポ遅れ・データ化け等**: タイトル↔H1 双方向同期まわりの複数の実装バグを修正（未編集 blur での H1 上書き防止、CommonMark ATX 準拠の H1 抽出で C#/F# を保持、CRLF 保持、確定時の即時 tree 反映）。

## [0.209.48] - 2026-07-19

### Added
- **タイトル ↔ H1 双方向同期**: (1) note md のファイルツリー名 ↔ md 先頭 H1、(2) outliner node の text ↔ 添付 page md の先頭 H1 を、編集確定時に双方向同期する。H1 が無ければ本文先頭に `# <title>` を挿入。冪等・byte-skip 書込・プログラム書換中フラグで無限ループを防止。
- sidepanel md → node text の同期は「outliner node 由来で開いた md」のときだけ動作（origin=構造逆引き = sidePanelFilePath の basename=pageId が現 .out node に一致。ADRL-0001）。リンク/履歴/検索から開いた md は node を書き換えない。

### Fixed
- **H1 抽出の CommonMark 準拠**: 末尾 `#` を含むタイトル（`C#` / `F#` 等）が `C` / `F` に誤って切り詰められるデータ化けを修正。閉じ `#` 列は直前に空白がある時（`# Title #`）だけ剥がす。CRLF 改行を保持。host（md-h1-utils）と webview（outliner.js）で抽出ポリシーを統一。
- **未編集 node の上書き防止**: page md を編集後、outliner で該当 node を編集せず Cmd+Enter しただけで md H1 が古い node text で上書きされる問題を修正（node text を実際に編集した時だけ H1 に同期）。
- **outliner title の即時 tree 反映**: outliner の page title を変更しても note ファイルツリーにすぐ反映されず、別ファイルを開くまで遅延していた問題を修正（確定時に即 host 送信 + pending の .out 保存を flush して tree の表示元 disk title を更新）。

## [0.209.16] - 2026-07-09

### Fixed
- **Notes の cmd+c / cmd+v ラウンドトリップで page md が作られないバグ**: Note A の node を別 Note B に貼り付け、さらに B で複製した node を A に貼り戻すと、新しい pageId は振られるのに page md ファイルが作られない（node から md が開けない）問題を修正。原因は webview の内部クリップボードが貼り付け先ごとに保持され、テキスト一致だけで最優先されて古い pageId を送っていたこと。コピー操作ごとに一意 ID（copyId nonce）を刻み、OS クリップボードと照合して最新のコピー元を選ぶようにした。あわせて、コピー元 md が存在しない場合に空ファイルを書かない防御を追加。外部アプリからのプレーンテキスト貼り付け（行分割）も従来どおり動作する。

## [0.209.15] - 2026-07-08

### Changed
- **md 移動 / 複製経路の md-to-md リンク扱いを統一**: md（またはそれを含む Outliner ノード）を移動・複製する各経路で、md 内の別 md へのリンクの扱いがバラバラだったのを共通の再帰機構に統一した。
  - **Move Other Note（.out ページ）**: ページ md が参照する自 Note 内の md も再帰的に一緒に移動し、移動後もリンクが切れないようにした（残留参照があれば移動せずコピー、循環検出あり）。
  - **Outliner → Outliner のノード貼り付け**: 直接リンク先だけでなく多段（A→B→C）の md リンク先も再帰的に複製し、リンクを複製先に書き換えるようにした（md エディタへの貼り付けと同じ挙動に統一）。

### Fixed
- **貼り付け時のファイル名の部分文字列誤置換**: 画像名 `a.png` の改名が本文中の `banana.png` を巻き込んで壊す不具合、および同名（別フォルダ）画像が衝突して片方が失われる不具合を修正（リンク URL 全体を単位に書き換え）。

## [0.209.14] - 2026-07-07

### Added
- **Outliner 間コピーでリンク先 md も再帰複製**: md 付きノードを別 Outliner に cmd+c / cmd+v したとき、その md が参照する自 Note 内の別 md（およびその md 内の画像・添付）も再帰的に複製するようにした。外部 Note の md へのリンクは複製せず相対パスに書き換えて維持する（循環リンク検出あり）。

## [0.209.13] - 2026-07-07

### Fixed
- **standalone md の Add Page がフラット化に追従**: standalone md エディタで Add Page したとき `pages/` サブフォルダを作らず、md と同じ階層にフラットに作成するよう修正。

## [0.209.12] - 2026-07-07

### Changed
- **Notes のオンディスク構成をフラット化**: 従来 Outliner ごとに `<outId>/` フォルダを作り page md / 画像 / 添付を隔離していたのを、Note フォルダ直下の md ＋ 共有 `images/`・`files/` に統合した。既存レイアウトは後方互換で読み込め、手動マイグレーションコマンド（`Fractal: Migrate to Flat Layout`）で移行できる。

### Fixed
- **共有アセットの誤削除防止**: フラット化で画像 / 添付を Note 内で共有するようになったため、item 移動時に「他の item がまだ参照しているアセットは削除しない」データロスガードを追加。

## [0.209.11] - 2026-07-07

### Added
- **Note タイトルの編集**: Notes モードのファイルパネル見出し（従来「Outlines」固定）が編集可能な note タイトルになった。クリックして変更すると `outline.note` の `noteTitle` に保存され、Activity Bar の FRACTAL NOTES ツリーにも反映される（未設定時はフォルダ名にフォールバック＝後方互換）。
- **Reveal in Finder**: Outliner の file 添付ノード / md ページノードの右クリックメニューから、実体ファイルを OS ファイラ（Finder 等）で選択状態表示できる。
- **Move Other Note（別 Note へ移動）**: ページ / 添付を別の Note へ移動できる。移動先へ関連アセット（画像・添付・同一 Note 内から参照される md）を再帰的に複製し、ID 衝突時は上書き確認する。

### Fixed
- **Mindmap Mode のノード横幅（iteration 30–32、FR-021 の挙動修正・仕様変更なし）**: 短いテキスト（英数・ひらがな）やファイルアイコン付きノードが実機で必ず 1 文字分だけ折り返してしまう問題を修正。ノード幅の算出に border + 1 文字分の余裕（`BORDER_W=18`）を全ノードへ加算し、編集中幅と確定後幅を一致させた（上限 280px クランプは維持）。

## [0.209.7] - 2026-07-06

### Added
- **Mindmap Mode の検索**: 検索ボックスに入力すると、該当テキストを含むノードをハイライトし、最初の一致を画面中央へパンする。Enter で次の一致へ順に巡回して中央化（Outliner の絞り込みと異なり、ノードは全表示のまま「発見」する）。

### Changed
- **Mindmap Mode で形状（layout）を変更したとき、title 中央ノードを画面中心に再配置**（Cmd+Shift+L / ツールバーの layout 選択の両方）。開いた直後と同じ見え方になる。
- **Mindmap Mode でヘッダーの使わないボタンをグレーアウト（無効化）**。有効: undo / redo / ビュー切替 / S3 sync / 検索ボックス。無効: タスクモード / タスクフィルタ / アーカイブ / メニュー / 戻る・進む / 検索モード切替（Outliner に戻すと復帰）。

### Fixed
- **Mindmap Mode で file 添付ノードの Cmd+Enter が外部アプリでファイルを開くように**（Outliner と同じ挙動）。md（ページ）添付ノードの Cmd+Enter は従来どおり side panel の md エディタで開く。

### Removed
- **Mindmap Mode ツールバーの PNG / SVG / OPML / Markdown エクスポートボタンを削除**（現時点で不要のため。将来復活可能な形で内部ハンドラは残置）。

## [0.209.6] - 2026-07-06

### Fixed
- **Mindmap Mode の実機バグ修正（iteration 24–28、FR-021 の挙動修正・仕様変更なし）**
  - **ズーム時に active node を画面中心へ**: ツールバーの +/− ボタンでもトラックパッド（Ctrl/Cmd+wheel）でも、選択中ノードを画面中心に寄せながらズームする。
  - **複数選択の視認性強化**: shift+click で複数選択したとき、選択ノードがはっきりした枠（背景＋リング）で表示される（従来は選択解除に見えた）。
  - **active 太枠の一貫性**: 矢印/Enter/Tab で active が別ノードへ移ると、クリックで付いた太枠は消え、移動先のみが太枠になる（複数選択は shift 操作でのみ維持）。
  - **Group 作成で画面が動かない**: ズーム状態（scale≠1）で Create Group しても固定ノードの画面位置が保たれる。
  - **Delete 後の active 移動**: ノード削除後、active が「上の兄 → 下の弟 → 親」の順で残存ノードへ移り、連続操作が可能。
  - **Delete で画面（pan/zoom）を動かさない**: 削除時に viewport の translate/scale を保持する。
  - **ひらがなで即編集開始（IME 対応）**: 確定ノード上でひらがなを打ち始めると、英数にリセットされずそのまま編集モードに入り日本語が入力される。
  - **トラックパッドのズームを高速化**: Ctrl/Cmd+wheel の 1 操作あたりの変化量を増やした。
  - **矢印移動で編集モードに見えない**: 選択中（active）ノードはキャレットを表示せず、編集開始時のみキャレットを出す（選択と編集を視覚的に区別）。

## [0.209.2] - 2026-07-06

### Fixed
- **Mindmap Mode の実機バグ修正（iteration 22–23、FR-021 の挙動修正・仕様変更なし）**
  - **#1 toolbar/minimap 固定**: rerender・pan・スクロールをまたいで toolbar/minimap が可視枠内に固定され、消えない/上にずれない（chrome overlay 化）。
  - **#2 開いた時 title を画面中心**: mindmap を開いたとき title 中心ノードを**縦横とも**可視領域中心へ配置（従来は縦のみで、巨大マップで横方向に中心へ来なかった）。
  - **#3 shift+click で複数選択**: 素のクリックでアンカーノードを選択集合に含めるようにし、shift+click で選択が累積する（従来は単一ノードしか選べなかった）。
  - **#4 minimap click / #5 fit**: screen↔SVG 変換を viewBox origin（bounds.min − pad）込みで是正。クリック位置のノードが画面中心付近へ、fit で全ノードが可視領域に収まる（左上に固まらない）。
  - **#7 group 作成で画面不動**: グループ作成の rerender をまたいで viewport を凍結・復元し、画面がずれない。
  - **#8 type-to-edit**: 確定ノード上で印字可能文字を打つと、Space を押さずにそのまま編集モードに入り入力できる（非破壊・末尾挿入）。
  - **#9 編集中の横幅追従**: 英語/日本語とも入力テキストの実幅に対称・単調に横幅が追従する（従来は英語だけ急拡大してすぐ上限280pxに張り付いた）。
  - **#10 確定後の右空白削減**: ノード幅の padding 想定を実 CSS（水平20px）に整合させ、確定後の右側の余分な空白を解消（編集中幅==確定後幅）。

## [0.209.0] - 2026-07-06

### Added
- **Mindmap Mode (FR-021)** — Outliner の第3表示モード。View Toggle で Outliner View → Table View → Mindmap Mode を循環。同じ `.out` を SVG マインドマップとして描画・編集する（`viewMode:'mindmap'` を `.out` に永続化、後方互換）。
  - **レイアウト**: d3-hierarchy + d3-flextree で radial（左右両側）/ right / left / balanced。title を中心ノードにして rootIds を左右展開。可変ノードサイズで重なり回避。
  - **キーボード操作**: Enter=弟追加 / Shift+Enter=兄追加 / Tab=子追加（いずれも非編集）/ Space=編集開始 / 矢印=空間フォーカス移動 / Delete=削除 / undo・copy 等。マウスなしで完結。
  - **編集**: contenteditable リッチノード（アイコン/画像/タグ/チェックボックス）。改行なし長文は編集中に横幅リアルタイム拡張（上限280px、最長行フィット）。編集ノード DOM 非再生成で caret/IME 保護、blur/focusout で自動 commit（データ損失防止）。
  - **配置**: 内側エッジ合わせ（right=左端揃え / left=右端揃え）。接続線はノードのエッジに接続。
  - **スタイル/構造**: ノード塗り/枠/形状・線種/色の自由設定（サブツリー継承）、複数選択グループ化（Boundary）、関連線（Relationship）、Floating Topic（自由配置）。
  - **添付**: file/image/markdown を Outliner 同様に添付（markdown は side panel で開く）。
  - **エクスポート**: PNG / SVG / OPML / Markdown。
  - **ビューポート**: pan / zoom / fit / minimap。編集確定でフレーム不動（bounds シフト補償）、移動・追加は対象が画面外のときだけ最小パン（実ウィンドウ端から余白を確保、中央寄せしない）。
  - Single mode / Note mode の両 provider で利用可能。

### Changed
- Outliner (FR-002) を「3 view modes（Outliner View / Table View / Mindmap Mode）」に更新。

## [0.207.59] - 2026-05-13

### Changed
- **SVG 単体 paste のときは clipboard の PNG を優先的に採用**
  - ブラウザは SVG を選択コピーすると `text/html` + `image/png`（レンダリング済みラスター）を同時に clipboard に入れる。HTML が SVG (または `<div>`+`<svg>`) 単体なら PNG を採用 — class 依存 CSS の欠落で黒化するのを回避
  - テキスト / 表 / コード等を含む rich HTML のときは従来通り HTML paste を優先 (PNG 化で情報を失わないため)
  - 普通の `<img>` 画像の右クリック copy は従来通り画像として貼り付く

## [0.207.58] - 2026-05-13

### Fixed
- **paste 時の Mermaid SVG が真っ黒になる問題を修正**
  - sandbox に Mermaid default theme の fallback CSS (`<style>`) を先に注入してから `inlineSvgComputedStyles` を呼ぶよう変更
  - class 依存の fill/stroke (node の pastel purple / cluster の pale yellow / edge の gray 等) が getComputedStyle 経由で正しく解決されるようになり、self-contained SVG として保存・表示可能に
  - source page の CSS 定義が失われている clipboard HTML でも Mermaid 風の色が復元される

## [0.207.57] - 2026-05-13

### Changed
- **html-md-converter bundle を同梱 (Mermaid / インライン SVG 保持強化)**
  - paste handler (`src/webview/editor.js`) で SVG を含む HTML は一時 sandbox DOM にマウントしてから `HtmlMdConverter.inlineSvgComputedStyles` を適用
  - `<foreignObject>` に `overflow:visible` を強制付与 (標準 XML parser の既定 `hidden` による文字クリップを防止)
  - foreignObject 直下の HTML 要素に xhtml namespace を付与 (standalone `.svg` として開いたときのレンダリング互換性)
  - Rule 8 `inlineSvg` で `XMLSerializer.serializeToString` に切替 (`<br>` 等 void 要素の well-formed 化)
  - **制約**: Mermaid の class 依存色は clipboard HTML が source `<style>` を失っているため復元不可 (source page を開いた状態で動作する chrome-extension / web-crawler-md のみ完全復元)

## [0.207.56] - 2026-05-13

### Added
- **Outliner ノード右クリック → llms.txt 風に配下構成をコピー (3 種)**
  - 「llms.txt 風に配下の MD 構成をコピー」: pageId 添付ノードのみを抽出して `[text](abs/path.md)` 形式
  - 「llms.txt 風に配下のファイル構成をコピー」: `filePath` 添付ノードのみを抽出 (MD page は混入しない)
  - 「llms.txt 風に配下の MD + ファイル構成をコピー」: 両方を統合、同一ノードに両方ある場合は 2 本 bullet
  - 階層構造を H1〜H6 で表現 (深さ 7 以降は H6 で clamp)、中間ノードは見出しとして残る、添付なし leaf はスキップ
  - 絶対パスで出力 (disk に実体がないパスは bullet 出さない)
  - Standalone outliner / Notes outliner 両方で動作、7 言語対応

## [0.207.48] - 2026-05-11

### Added
- **Outliner editor: `Cmd+Shift+Opt+C` で添付ファイル絶対 path をコピー**
  - 単一 focus ノード or 複数選択ノードの `filePath` を flat 順で集めて改行区切りコピー
  - 既存 `Cmd+Shift+C` (page MD path) と alt キーで明確に区別
  - Standalone outliner / Notes outliner 両方で動作

## [0.207.47] - 2026-05-11

### Changed
- **`fractal.imageDefaultDir` / `fractal.fileDefaultDir` の default 値を変更** (`""` → `"images/"` / `"files/"`)
  - 既存 user 設定はそのまま尊重 (override 優先)
  - 新規 user: standalone MD で画像 / ファイル添付が自動的に `<docDir>/images/` `<docDir>/files/` に保存 + 相対パス挿入

## [0.207.46] - 2026-05-11

### Fixed
- **Outliner page MD (heuristic 検出含む) で画像挿入時に絶対パスになる問題を修正**
  - `setFileImageDir` / `setFileFileDir` に絶対パスを渡していたため `shouldUseAbsolutePath` が true になり MD 内パスが絶対化されていた
  - 相対パス `'images'` / `'files'` で登録するよう変更 → 解決後は `<docDir>/images` に正しく resolve、かつ MD 挿入時は相対パス

## [0.207.45] - 2026-05-11

### Added
- **Standalone MD で「outliner page MD」を heuristic 検出**
  - `.md` の親フォルダ名と同名の `.out` が grandparent に存在すれば outliner page MD と判定
  - 検出時は `images/` / `files/` を強制設定 + status bar に表示 (`is-locked` で編集不可表示)
  - status bar の path 末尾に `/` 付与 + pointer-events:none + italic で視覚的に lock 状態を明示

## [0.207.44] - 2026-05-11

### Changed
- **Resize handle の太さ + 色を 4 箇所で統一** (旧: VSCode 色 / 3-5px → 新: `--fr-color-primary` (teal) / 2px、edge 中央配置):
  - `.notes-resize-handle` (Notes 左 file panel) — 既に 2px / primary 色 (基準)
  - `.side-panel-resize-handle` (sidepanel MD 全体)
  - `.side-panel-sidebar-resize-handle` (sidepanel 内 TOC)
  - `.sidebar-resizer` (Standalone MD の左 outline sidebar)

## [0.207.43] - 2026-05-11

(superseded by v0.207.44, same content but bumped version for cache invalidation)

## [0.207.42] - 2026-05-11

### Changed
- **Outliner toolbar**: view toggle (Table / Outline) と S3 sync button の位置を入れ替え (= view toggle が左、S3 sync が右へ)

## [0.207.41] - 2026-05-11

### Fixed (Outliner S3 sync data loss bug の根本修正)
- **🚨 Android 等で `.out` を更新後、Mac で sync click 時に local 古い内容が S3 を上書きする問題を完全修正**
- 原因: `Outliner.flushSync()` が**編集の有無に関わらず毎回** webview model state を host に送り、host が byte 比較で「整形差を内容違いと誤認」して `_writeFile` を発火 → mtime が NOW に更新 → S3 newer-wins で local 採用 → 他端末の編集消失
- **修正 (案 B = content-based 検出)**:
  - `lastSentJson` を webview に追加、最後に host に送った serialize 結果を保持
  - `flushSync` で `serializeForSave() === lastSentJson` なら **何もしない** (= 編集なしの sync click で `.out` 触らず、mtime preserve)
  - `init` / `applyExternalUpdate` / `applySyncedData` / `case 'updateData'` (fileChangeId 付き) の 4 経路で baseline 更新
  - `serializeForSave()` ヘルパー抽出で送信内容と比較対象が完全一致
- **影響範囲**: outliner toolbar の sync button だけでなく、ファイル切替 / Daily Notes ナビ / 検索 / Note 全体 S3 sync (Tools tab) / クリーンアップ等、`flushOutlinerSync` 経由の全ての操作で同様の改善

### Added
- **`fractal.outlinerS3SyncMode` 設定**: outliner sync 時の競合判定モード
  - `auto` (default): mtime newer-wins で自動判定、dialog 出さない
  - `confirm`: size 違いがあれば毎回**確認 dialog** で user に選択させる (多端末同期で慎重派向け)

### Changed
- **競合 dialog の UI 改善** (`confirm` mode で表示時):
  - Upload / Download ボタンを左右並びに変更 (旧: 縦並び)
  - Upload = blue、Download = orange (色固定、推奨で色変動なし)
  - 推奨マーク = 黄色 ribbon「★ おすすめ」+ 黄色 outline + glow で強調表示

### Reverted (未 publish のうちに撤回した workaround)
- `_writeFile` の semantic equal skip — local 更新漏れ risk のため byte 比較のみに維持
- `flushSync` の `syncDebounceTimer` 検査版 — 副作用懸念のため content-based に切替
- `preFlushLocalInfo` 機構 — 案 B で根本解決したため不要

## [0.207.40] - 2026-05-10 (UNSAFE — superseded by v0.207.41)

⚠️ **注意**: v0.207.40 として一度 Marketplace publish したが、以下の問題により v0.207.41 で完全置換:
- `flushSync` の syncDebounceTimer 検査版 (副作用懸念)
- `_writeFile` の semantic equal skip (local 更新漏れ risk)

v0.207.40 を install 済の場合、Marketplace の auto update で v0.207.41 に上書きされる。手動更新も可能。

### Fixed
- **🚨🚨🚨 Outliner S3 sync の data loss bug の根本原因を特定 + 修正** — log 解析で判明した self-inflicted bug:
  1. user が sync button click
  2. `outlinerS3SyncRequest` の前処理 `flushOutlinerSync` が webview の `flushSync()` を発火 → 編集なくても `syncToHostImmediate` で host に `syncData` を送る
  3. host: `saveCurrentFile` で 1s debounce timer を set
  4. 続く `handleOutlinerS3Sync` 冒頭の `fileManager.flushSave()` が pending timer を即 fire → `_writeFile` が disk に書き込み (mtime = NOW)
  5. local mtime が S3 mtime より新しくなる
  6. `decideSyncDirection` が「local newer + size 違い」で **upload** を返し、Android の編集を上書き
- **理由**: webview model state は disk と意味的に同じでも、Android JSON formatting と Mac `JSON.stringify(..., null, 2)` の出力差 (key 順 / 空白) で `existing !== jsonString` となり、`_writeFile` が早期 return せず write していた

### 修正 (二重防御)
1. **webview 側 `flushSync()`**: 未 flush の `syncDebounceTimer` がある時のみ `syncToHostImmediate()` を発火。実編集なしの sync button click では何もしない (mtime preserve)
2. **`_writeFile` の semantic equal check**: byte 比較で fail した時、parse + deep equal で再判定。formatting 差を吸収して同一内容なら write skip

## [0.207.39] - 2026-05-10

### Diagnostic
- 一時診断 log を強化: `_writeFile` / `saveCurrentFile` / `syncData received` の caller stack trace を console に出力 (root cause 特定用)

## [0.207.38] - 2026-05-10

### Fixed
- **🚨 Outliner S3 sync で他端末更新を上書きする data loss bug の safety net** — Android 等で `.out` を更新後、Mac local mtime が編集なしに進む等の理由で「local mtime > S3 mtime + size 違い」が成立すると、silent に local 内容を S3 に upload して **他端末の更新を消失**させる事象を user 報告。`outliner-s3-sync.ts` で `.out` の sync 判定が **upload + size 違い** の組み合わせの時に**ユーザー確認 modal**を出し、「Local を S3 にアップロード / S3 を local にダウンロード」を明示選択できるよう変更
- 詳細 console log (local size + mtime / S3 size + mtime / decision) を追加して原因解析の補助に

### 既知の課題 (今後の改善候補)
- **根本対策**: ETag/MD5 ベースの content 等価判定で mtime ズレに依存しない skip 判定を導入予定
- 現状: 「local mtime > S3 mtime」になる原因の特定は未着手 (VSCode 内の意図せぬ write / 外部 backup tool 干渉の可能性)

## [0.207.37] - 2026-05-10

### Changed
- **⭐ お気に入り UI を再設計**:
  - **左 file panel**: Star toggle button (UI 切替) を**廃止**、Notes タブ直下に **常時 Favorites section** を表示
  - お気に入り 0 件時は section を完全非表示 → 旧版 (v0.207.35 以前) と同じ見た目
  - **構成**: Notes タブ → Favorites section (空なら無し) → actions toolbar (新規フォルダ/新規 outline/Today) → tree view
  - **Outliner editor の ★ button を完全削除** (Notes mode で出ていた header の ★)
  - 追加 / 解除はすべて **Notes 左 panel の右クリック menu** から (Notes タブ内 + Favorites section 内、それぞれ context-aware menu)
  - Favorites section header の ★ icon を削除、"Favorites" text label のみ
  - Favorites 系の色を `--fr-color-primary` (淡 teal `#9CC8DC`) に統一 (旧 `--fr-color-primary-strong` は強すぎる)

### 内部
- `notesWebviewContent.ts`: `.outliner-favorite-btn` HTML 削除
- `outliner.js`: `favoriteBtn` / `noteFavorites` / `currentFileId()` / `updateFavoriteButton()` / `setupFavoritesSync()` / 関連 listener 全削除
- `outliner.css`: `.outliner-favorite-btn` 関連 CSS 全削除
- `notes-host-bridge.js`: `outlinerHostBridge.toggleFavorite()` 削除 (notesHostBridge.toggleFavorite は file panel 右クリック用に残置)
- `notes-body-html.js`: actions row の Star button 削除、Favorites section container 追加 + CSS
- `notes-file-panel.js`: `viewMode` toggle 廃止、`renderFavoritesSection()` で常時 section 描画

## [0.207.36] - 2026-05-10

### Added
- **⭐ Outliner お気に入り機能 (Notes mode)** — Notes folder 単位で outliner を star 登録、別 view で flat list 表示
  - **左 file panel**: actions row に Star button (`#filePanelFavorites`) 追加 → click で view 切替 (tree ↔ favorites flat list)、active 時は teal で塗りつぶし
  - **Favorites view**: お気に入り outliner だけを folder 階層なしの flat list で表示 (登録順)
  - **右クリック context menu**: 通常 view では「★ Add to Favorites」/「★ Unfavorite」 toggle item、favorites view では「★ Unfavorite」のみ
  - **Outliner editor header に ★ button 追加** (Notes mode のみ): 現 outliner を 1 click で toggle、ON 時は teal で塗りつぶし。Standalone outliner では非表示
  - 状態同期: file panel 右クリック / header ★ button のどちらで toggle しても両方の UI が即時連動
- **Storage**: `outline.note` (NoteStructure) に `favorites?: string[]` field 追加。S3 sync で他端末にも引継ぎ。旧 outline.note との互換性維持 (未定義時は `[]` 扱い、旧版で書き戻されても既存 field は破壊しない)

### 内部
- `NotesFileManager`: `getFavorites()` / `toggleFavorite(fileId)` / `isFavorited(fileId)` method
- `notes-message-handler.ts`: `case 'notesToggleFavorite'` 追加 → `sendFileListWithStructure` で broadcast
- `notes-host-bridge.js`: 両 bridge (`outlinerHostBridge` + `notesHostBridge`) に `toggleFavorite(fileId)` method
- `outliner.js`: `noteFavorites` state + `notesFileListChanged` listener で `updateFavoriteButton()` 同期

## [0.207.35] - 2026-05-10

### Changed
- **🎨 Primary color を teal-blue palette に変更** (HSL 199° 軸):
  - `--fr-color-primary` (light): `#4F6BFF` → `#9CC8DC` (淡い teal、bar / underline / icon 用)
  - `--fr-color-primary-soft` (light): `#DBE2FF` → `#DEEDF5` (最薄 teal、bg tint)
  - `--fr-color-primary-strong` (light、新): `#3994BC` (濃い teal、tag / link 文字色用、user 指定)
  - dark mode は `#7DC4DF` 系に揃え
- 「ノート」タブ underline + File panel item active 縦バー: 太さ `2px` → **`1px`**
- Tag 文字色 / MD link 文字色を `--fr-color-primary-strong` (`#3994BC`) に切替 (読みやすさ確保)、それ以外 (bar / icon / cursor 行 highlight) は `--fr-color-primary` (`#9CC8DC`) のまま

### Added
- **⌨️ `Cmd+\\` で右サイドパネル toggle** — `fractal.toggleSidebar` command + keybinding として実装 (VSCode が webview keydown より先に Cmd+\\ を intercept するため、document keydown 経路は廃止):
  - **Standalone MD editor**: 主 sidebar (Outline TOC) を toggle
  - **Notes editor 主 outliner active**: **左 file panel** (notes / search / tools) を toggle
  - **Sidepanel MD active** (notes / standalone outliner 内): 内側 sidePanelSidebar (TOC) のみ toggle、外側パネルは触らない (波及防止)
- 関連 button の title (hover tooltip) に `(Cmd+\\)` を併記:
  - `Open Outline` / `Close Outline`
  - `Show file panel` / `Collapse panel` (notes mode 左 panel)
  - `Close` (sidepanel close button)

### Fixed
- v0.207.34 で notes mode の `Cmd+\\` が効かなかった (VSCode keybinding 経路に切替で解消)

## [0.207.34] - 2026-05-10

### Fixed
- **🐛 v0.207.33 で notes mode の右サイドパネル `Cmd+\\` が効かない件** — `EditorInstance.getActiveInstance()` が notes mode 内で sidepanel inner instance だけが instance のとき fallback で常に sidepanel を返すため、主 outliner active 判定に使えなかった。`document.activeElement` ベースの判定 (`sidePanelEl.contains(activeElement)`) に変更
- 同 logic を editor.js (standalone MD) 側にも適用、両 webview で挙動統一

### Added
- **🏷️ Cmd+\\ ショートカットを button title (hover tooltip) に表記**:
  - `Open Outline (Cmd+\\)` / `Close Outline (Cmd+\\)` (standalone MD + sidepanel)
  - `Close (Cmd+\\)` (sidepanel close button、notes mode の右パネル close も同じ)

## [0.207.33] - 2026-05-10

### Added
- **⌨️ 右サイドパネル toggle ショートカット `Cmd+\\` (Ctrl+\\)** — 全 4 contexts で統一動作
  - **Standalone MD editor**: `sidebar` (main TOC) を toggle
  - **Notes mode (主 outliner active)**: `sidePanelEl` (右 MD page viewer) を close (open は page link click 経由)
  - **Sidepanel MD active (notes / standalone outliner 内)**: 内側 `sidePanelSidebar` (TOC) のみ toggle、主 sidepanel は触らない (波及防止)
  - **Standalone MD editor の sidepanel inner active**: 同じく内側 TOC のみ toggle
- 実装: `EditorInstance.getActiveInstance()` で active 判定し、scope 内の panel のみ操作。`e.preventDefault() + stopPropagation()` で外側 listener へのバブル防止

## [0.207.32] - 2026-05-10

### Added
- **🎯 Cursor 行ハイライト (outliner editor)** — cursor がある行を notes 右サイドパネル hover と同じ淡 water-blue (`var(--fr-color-selection-bg)`) で全行ハイライト。table view では outline 列 + text / multiselect / date / datetime 列**すべて**が同色で同期表示
- 実装:
  - `.outliner-node.is-focused` / `.outliner-cell-text.is-focused` / `.outliner-cell-multiselect.is-focused` / `.outliner-cell-date.is-focused` の background を transparent → `var(--fr-color-selection-bg, var(--outliner-active, #d8e8f8))` に変更
  - `treeEl` に `focusin` delegated listener 追加 — non-outline cell に focus 入った時にも `setFocusedNode(node.id)` を呼んで行全体を `is-focused` 同期
- 範囲選択 (`is-selected`) は引き続き orange tint で別色識別

## [0.207.31] - 2026-05-10

### Fixed
- **🐛 v0.207.30 で導入した code block 保護が AWS Translate に placeholder 削除されて壊れた件** — `⟦XCB000⟧` の Unicode 数学括弧が AWS で削除され `XCB000` だけ残る、さらに「X」まで消えて `CB002` になるケースもあり、復元 regex が機能せず生 placeholder が表示されていた
- **新方式 (segment 分割)**: text を `[translate, preserve, translate, preserve, ...]` の segment 列に分割し、preserve segment は **AWS Translate に送らずそのまま結果に含める**。placeholder 復元のリスクなし、AWS の修正動作に左右されない確実な保護
- 保護対象は v0.207.30 と同じ: fenced code block / inline code / block math / HTML comment

## [0.207.30] - 2026-05-10

### Added
- **🛡️ Markdown コードブロック保護翻訳** — Amazon Translate に送る前に Markdown のコードブロック等を placeholder (`⟦XCB000⟧` 形式、Unicode 数学括弧使用) に置換し、翻訳後に復元。コード内のキーワード ('class', 'function', '*', etc.) が誤訳される問題を防止
- 保護対象:
  1. Fenced code block (`` ``` ` 〜 `` ``` ``、言語タグ付き含む)
  2. Inline code (`` ` 〜 ` ``、1 行限定)
  3. Block math (`$$...$$`)
  4. HTML comment (`<!-- ... -->`)
- インデント 4 スペース code block / inline math (`$...$`) は誤検出回避のため対象外

## [0.207.29] - 2026-05-10

### Fixed
- **🐛🐛🐛 翻訳結果保存で node が outliner に出ない真の原因修正** — fractal の `.out` データ構造で OutlinerModel は `children: []` 配列を使う (`childIds` ではない)。v0.207.24 で導入した保存処理は誤って `childIds` という存在しない field に push していたため、新 node は `nodes` map には登録されるが**どの parent の `children` にも、`rootIds` にも入らない孤児 node** となり tree 描画から完全に欠落していた。`children` に修正、加えて OutlinerModel が要求する全 field (`parentId` / `tags` / `isPage` / `subtext` / `images` / `filePath` / `checked`) を補完。これで保存後即座に親 node の子として表示される

## [0.207.28] - 2026-05-10

### Fixed
- **🐛 翻訳結果保存で .md は作成されるが outliner に node 追加が反映されない問題** — `.out` への JSON 書き込みは成功していたが、(1) outliner.js の pending `syncData` で古い model に上書き戻り (2) webview UI も自動 reload されない、の double-bug。`fs.writeFileSync` 後に `fileManager.openFile()` で `fileChangeId` bump + `lastJsonString` 同期、さらに webview に直接 `updateData` (新 `fileChangeId` 付き) を post して即時 UI 反映。pending syncData は古い `fileChangeId` で reject される

## [0.207.27] - 2026-05-10

### Fixed
- **🐛 「翻訳結果を保存」 button 押しても何も起こらない問題の診断強化** — 保存処理 (notesEditorProvider / outlinerProvider) で失敗時に webview に `translateSaveError` を送るよう改修、成功時も `translateSaveOk` を送って button text に明示反映 (`✓ 保存しました: <title>` / `✗ <理由>`)。失敗理由 (例: `翻訳元 page (xxx) を含む outliner node が見つかりません`) が button 上に直接出るようになった
- VSCode toast に保存先ファイル相対 path を併記 (例: `翻訳結果を保存しました: タイトル（pages/p123abc.md）`)

### 保存先仕様 (再掲)
- Notes mode: 現在開いている `<outlineId>.out` 内、翻訳元 page を持つ親 node の **子 node として追加**。新 page MD は同 outliner の `pageDir` (= 既定で `<outlineId>/p<新id>.md`) に保存
- Standalone outliner: `.out` 内、翻訳元 page を持つ親 node の **子 node として追加**。新 page MD は `pageDir` に保存

## [0.207.26] - 2026-05-10

### Fixed
- **🐛 Notes mode の sidepanel header で翻訳ボタンが popup を開かず即翻訳していた件** — outliner.js の sidepanel translate 経路 (Notes mode で MD を sidepanel 開いた時) が editor.js の popup 化対応 (v0.207.24) 漏れだった。outliner.js にも同等の `openSidePanelTranslatePopup` を実装、translate button click → popup 表示 (source/target select + Execute)
- **🐛 Notes mode の sidepanel 翻訳結果画面に「翻訳結果を保存」 button が出ていなかった件** — outliner.js は editor.js とは別の翻訳結果 UI (sidepanel rebuild) を使っているので保存 button が表示されていなかった。outliner.js 側の result panel header にも `data-action="translateSave"` button 追加、click で `host.saveTranslationToOutlinerNode` 呼出 (子 node + page 追加)

## [0.207.25] - 2026-05-10

### Added
- **🆕 Amazon Translate Custom Terminology 対応** — 翻訳精度向上のための辞書 (CSV/TMX) サポート
  - 新設定 `fractal.translateTerminologyFile`: 辞書ファイルパス (絶対 / `~/...` / workspace-relative 全対応)
  - 新設定 `fractal.translateTerminologyName`: Amazon Translate 上の辞書名
  - **Notes editor の Tools タブに「Update Translate Terminology」 button** 追加 — クリックで `aws translate import-terminology` を実行 (Amazon Translate に upload)
  - **新コマンド `fractal.updateTranslateTerminology`** — Tools button と同等、command palette からも実行可能
  - 翻訳実行時、`translateTerminologyName` が設定されていれば自動的に `--terminology-names` を CLI 引数に追加 (translateContent → notes-message-handler / outlinerProvider / editorProvider 全経路で対応)
  - 起動時の自動 upload は**しない** (重い + 辞書更新は稀なので無駄)
  - ファイル拡張子で format 判定 (`.csv` → CSV、`.tmx` / `.xml` → TMX)
  - merge 戦略: `OVERWRITE` (既存名の辞書を完全置換)
  - エラーハンドリング: ファイル不在 / size > 10 MB / 拡張子不正 / AWS credentials 未設定 / AWS CLI 未インストール
  - 新 helper `resolveTerminologyPath`: `~/foo` 展開 + 絶対 / workspace-relative path 解決

## [0.207.24] - 2026-05-10

### Changed
- **🌍 翻訳 UI を 1 ボタン + popup に統合** — 旧 `translateLang` (言語表示) + `translate` (実行) の 2 ボタン構成を撤廃、`translate` 1 ボタンに統一
  - クリックで popup 表示: source 言語 select + target 言語 select + 翻訳実行 button
  - source は **Auto-detect** + 14 言語、target は 14 言語
  - popup から実行で従来 translate 経路 (translateContent) と互換
  - select で選んだ言語は VSCode 設定 `fractal.translateSourceLang` / `translateTargetLang` に永続化 (新メッセージ `saveTranslateLangs`)
  - ESC / outside click で popup close

### Added
- **🆕 翻訳結果を outliner に保存 (sidepanel only)** — 翻訳結果ビューの header に「翻訳結果を保存」 button 追加
  - クリックで:
    - 当該 MD が attached されている outliner node に **子ノードを追加**
    - 子ノードに翻訳結果 MD を新規 page として attach
    - 子ノードの text は **MD の H1 を翻訳したもの** (H1 が無ければ "Untitled (translated)")
  - Notes mode: `notesEditorProvider.saveTranslationToOutlinerNode` で実装、`fileManager.getCurrentFilePath()` 経由で .out 取得 → 親 node 検索 → 子 node + page 追加
  - Standalone outliner mode: `outlinerProvider` で同等実装、`vscode.WorkspaceEdit` で .out JSON 更新
  - 新メッセージ: `saveTranslationToOutlinerNode` (sidepanel-bridge-methods.js / vscode-host-bridge.js / SidePanelHostBridge)

## [0.207.23] - 2026-05-10

### Removed
- **VSCode 設定 `fractal.linkOpenMode` 撤廃** — standalone MD editor の MD link click は **常に新タブ** で開く (`vscode.openWith` で fractal.editor を起動)。旧 `'sidePanel'` オプションは sidepanel が peek 用途として頻度低く、設定 default ('sidePanel') と実装 default ('tab') の不整合バグもあったため撤廃

## [0.207.22] - 2026-05-10

### Added
- **🎨 Minimal pastel chrome foundation** — Fractal 全体の chrome (panel / toolbar / list / settings / popup) を minimal pastel デザインに刷新
  - 新規 `tokens.css` (247 行): design tokens 体系 (色 / 余白 / 角丸 / 影 / typography / z-index、115 個の `--fr-*` 変数)
  - 新規 `fr-base.css` (76 行): reset / scrollbar / focus-visible / selection / theme transition
  - 新規 `fr-components.css` (238 行): `.fr-button` / `.fr-input` / `.fr-list-item` / `.fr-context-menu` / `.fr-popup` / `.fr-badge`
  - CSS Layers: `@layer fr-legacy, fr-tokens, fr-base, fr-components, fr-chrome` で cascade 制御
  - Layout 不変 (47 selector × bbox = 0 px drift)、配色 / 角丸 / focus / hover のみ minimal pastel に置換
- **🆕 3 mode theme system (`light` / `dark` / `auto`)** — default は `auto` で OS prefers-color-scheme に追従
- **🆕 Multiselect popup keyboard navigation** — outliner table mode の multiselect cell popup で:
  - ↓ / ↑ で list 内アイテム順次 highlight (`.is-highlighted`)
  - Enter で選択 + popup close + cell focus 戻す
  - ESC で popup close + cell focus 戻す
- **🆕 Multiselect cell の simulated text caret** — focus 時に `::before` で 1 px × 1.2em の blink caret を表示
- **🆕 Outliner table mode の日付/日時列対応**:
  - Cmd+矢印キー navigation (text/multiselect/outline 列と同等)
  - shift+↑↓ 範囲選択で日付/日時列も `is-selected` (黄色) になる
  - 行が広がった時に上合わせ + hover bg が下部欠けない

### Changed
- **`fractal.theme` enum を 3 値に変更** (旧: `github`/`sepia`/`night`/`dark`/`minimal`/`things`/`perplexity` の 7 themes)
  - default: `things` → `auto`
  - 旧 enum 値持ちユーザーは起動時 1 回 warning + 自動 migration (`globalState.fractal.themeMigrationDone` で重複防止)
  - migration ルール: `dark`/`night` → `dark`、`things`/`github`/`sepia`/`minimal`/`perplexity` → `light`、不明値 → `auto`
- **Settings panel (Notes Tools tab) chrome 刷新** — 配色を `var(--vscode-*)` → `var(--fr-color-*)` に統一、focus / selection bar minimal 化、layout 完全不変
- **Outliner / MD editor body の bg を `#FAFAF7` (light) / `#1E1F28` (dark) で統一** — sidebar / content / toolbar 全て同一色
- **focus 時の白背景・水色枠を minimal 化** — outliner-text / cell-text / cell-multiselect / cell-date / subtext.is-editing 全部で背景・outline・box-shadow なし (general `:focus-visible` ring は button/input/textarea/select のみに limit)
- **Outliner editor の hover 反転を撤廃** — keyboard nav と協調が複雑だったため (notes file panel の hover は維持)
- **i18n に `themeMigrationNotice` key を 7 言語追加**

### Removed
- **VSCode 設定 `fractal.outlinerImageDefaultDir` 撤廃** — convention default `./<basename>/images` で解決
- **VSCode 設定 `fractal.outlinerFileDir` 撤廃** — convention default `./<basename>/files` で解決
- **VSCode 設定 `fractal.outlinerPageDir` 撤廃** — convention default `./<basename>/` で解決
- 旧 7 themes 関連の typography 微調整 (perplexity / things 専用 H1/H2/blockquote/table 等の 60+ selectors)

### Migration / Compatibility
- 既存 `.out` ファイルは構造変更なし (JSON schema 不変)
  - `data.imageDir` / `data.pageDir` / `data.fileDir` は priority 1 で読まれ続ける
  - 設定が無くても convention で自動解決
  - 旧構造 (`./images` / `./pages` / `./files` がルートに存在) は legacy fallback で継続動作
- 7 themes ユーザーは初回起動時に新 enum へ自動 migration

## [0.207.3] - 2026-05-09

### Added
- **🆕 Markdown editor: 添付ファイル一覧パネル (Attachments panel)** — クリップアイコンで popup を開き、MD body 内の画像とファイル参照を一覧表示
  - **Standalone**: toolbar 右側固定領域 (openInTextEditor の前) にボタン
  - **Sidepanel**: header の translate と openInTextEditor の間にボタン (Notes mode の sidepanel でも動作)
  - 各エントリ: タイプ別アイコン (画像 / ファイル) + ファイル名 + 相対パス + Open ボタン (外部アプリで開く) + Copy Path ボタン (絶対 fs path をクリップボードへ)
  - 抽出: `MarkdownLinkParser.extractImagePaths` (`![](path)`) + `extractMarkdownFileLinks` (`[](path.ext)` で http 以外 / .md 以外)
  - 同 path の重複は dedup
  - 外側クリック / `Escape` で close、同じボタン再クリックで toggle close

## [0.206.2] - 2026-05-09

### Documentation
- README に v0.206 で追加した task mode / task filter / archive / date column / checkbox keyboard shortcuts の説明を追記

## [0.206.1] - 2026-05-09

### Added
- **🆕 Outliner: タスクモード** — 検索バー右側のチェックボックスアイコンで ON/OFF。新規ルートノードに自動 checkbox 付与 (子ノードには付与しない)。OFF で全ルート checkbox を一括クリア。ON 時に taskFilter='active' (未完了のみ表示) に自動切替
- **🆕 Outliner: タスクフィルタ (All / Active)** — 漏斗アイコンで切替 (常時表示)。Active で `checked=true` のノードを枝ごと非表示
- **🆕 Outliner: 完了タスクの Daily Notes アーカイブ** — 箱アイコンで `dailynotes.out` の今日の日付ノード配下に移動
  - ツリー全体を walk して `checked=true` のノードを target 化。祖先が `checked=true` なら祖先の subtree として吸収
  - `#TASK` `#DONE` タグを root テキスト末尾に自動付与
  - **アセットも自動コピー**: page MD / page 内画像 / drawio / 添付ファイル / 画像
  - Notes mode 専用
- **🆕 Outliner: 列追加 dialog に `Date` / `Date & Time` 列タイプ** — クリックで native date picker。空状態は placeholder 非表示
- **🆕 Outliner: チェックボックスのキーボード操作**
  - テキスト先頭で `[ ]` / `[x]` 入力 + Space → checkbox 自動変換 (残りテキスト保持)
  - `Cmd+Shift+X`: checkbox 追加 / true ⇄ false toggle
  - `Cmd+Shift+Option+X`: checkbox 削除
  - checkbox 付きノードの先頭で Backspace: 1 回目 = checkbox 解除、2 回目 = 通常 merge

### Changed
- **🔧 Standalone outliner も自己完結構造に統一 (Notes mode と同じ命名規則)**
  - 旧: `./files` / `./images` (root 共有)
  - 新: `./<basename>/files` / `./<basename>/images` (per-outliner)
  - `fractal.newOutliner` 新規作成時に `pageDir` / `fileDir` / `imageDir` を明示書き込み
  - 互換性: 旧 `./files` / `./images` が存在し新パスが無い場合は legacy パスを継続使用 (旧ファイル参照を破壊しない)
- **🔧 Notes mode `getPagesDirPath` default を `./<basename>` に統一** (以前は `./pages` root 共有)。dailynotes 専用処理を撤去
- **🔧 MD editor ショートカット robustness** — 全 letter shortcut で `e.code` (物理 key) fallback 追加。layout / IME / shift state に依らず動作
- **🔧 Outliner 検索バー** — タスク系ボタン (task-mode / filter / archive) を右端に寄せて視覚的区切りを明確化

### Fixed
- **HTML→MD 変換: `<a><img></a>` を `![alt](src)` に簡略化** (note.com の見出し画像など)
- **HTML→MD 変換: Medium 等の `<code>` 無し code block を fenced code block として変換** (再帰 walk + 多段フォールバック)
- **HTML/Markdown ペースト時の空リストマーカー除去** — 孤立 `- ` / 末尾連続 `- ` を自動除去。中間は保持
- **Outliner: 子ノードを持つノードの先頭で Backspace → 子ノード消失バグ修正** — `model.removeNode` の再帰削除で移動済みの子も巻き込まれていた問題
- **`handlePageAssets` で drawio.svg/png を images ではなく files に振り分け** — image syntax でも file 扱い (pages/files 配下)

### Removed
- **Outliner: Created At / Updated At 自動列機能を撤去** — 検索バーの時計アイコン toggle、自動列追加、ノード変更時の `updatedAt` 自動更新、関連 i18n keys を全削除

## [0.204.1] - 2026-05-09

### Documentation
- README に v0.204.0 で追加した outliner toolbar S3 sync ボタンと bidirectional newer-wins sync の説明を追記

## [0.204.0] - 2026-05-08

### Added
- **Outliner editor toolbar S3 同期ボタン** — Notes mode で `S3 Bucket Path` (NT-09 設定) が設定済みの outliner editor に同期ボタンを追加。クリックで `<id>.out` + `<id>/` フォルダ配下を S3 と双方向同期 (note 全体ではなく開いている outliner だけが対象)
- **per-file mtime 比較による true newer-wins** — `aws s3 sync` の「size 違いで強制転送」副作用を回避するため、`aws s3api head-object` / `list-objects-v2` で per-file mtime 比較した後、`aws s3 cp` または一括 `aws s3 sync` で転送。別マシン編集が古いローカルで上書きされない
- **VSCode キャッシュ対策 6 層** — sync 中の webview lock + 編集禁止 overlay (進捗 phase 表示)、TextDocument flush + revert、webview model 完全再構築、複数 panel broadcast、persistent state クリア、mtime invalidation token

### Changed
- **NT-09 Sync (Backup) を双方向 newer-wins に統一** — 旧: `aws s3 sync local s3 --delete` で local→S3 片方向 + S3-only ファイル削除。新: 双方向 per-file mtime newer-wins、`--delete` 不使用 (片側のみのファイルは保持)
- **NT-09 Local Delete & Download 後の panel 完全再生成** — 旧: `openNotesFolder` で reveal するだけで webview 内 state が古いまま。新: panel `dispose()` → 再生成で完全 cache reset
- **NT-09 Remote Delete & Upload + Sync (Backup) に webview lock 追加** — 操作中の意図せぬ user 編集をブロック

### Fixed
- **`_writeFile` の content 一致時 skip** — webview が頻繁に syncData を送る時、内容変更なしの wasteful 書込で local mtime が NOW に更新されると別マシンで真に編集された S3 側より local が新しく見えて誤って upload してしまう問題を回避 (mtime 不変保証)
- **NT-09 sync 後の outliner sync で page 添付が消える致命バグ** — `revertAndReinitNotePanel` で `updateData` に `fileChangeId: Date.now()` を渡していたため bridge の `currentFileChangeId` が異常な値で固定 → 後続 syncData が host 側で stale 判定で破棄 → page MD 添付後の outliner sync で disk が古い content のまま webview reinit され page アイコン消失。`updateData` 送信を削除し `sync-applied` のみで model リセットに修正
- **`aws s3 sync` 大量ファイル時の極端な低速** — 旧: `--include` filter 評価で 10000 ファイル ~3 時間。新: filtered upload + unfiltered download (skip 候補は事前 mtime align で aws CLI も skip 判定) で同 10000 ファイル ~2 分

### Notes
- `--delete` を使わない方針のため、別マシンで削除されたファイルは local に残る (orphan)。clean したい時は Tools タブの **Clean Unused Files** → **Remote Delete & Upload** を順に実行

## [0.203.23] - 2026-05-07

### Changed
- **Outliner page icon を 📄 絵文字に戻す** — v0.203.17 で導入した SVG document icon が好みでなかったため、シンプルに元の絵文字に復元。`fontSize: 13px` / `opacity: 0.8` / theme-aware カラー復元。行高さ・padding 改善 (1.35em + 0.25em 上下対称) は維持

## [0.203.17] - 2026-05-07

### Fixed
- **HTML / Markdown ペースト時の空リストマーカー除去** — 外部 HTML / プレーンテキストを MD editor (standalone / sidepanel) に paste した時、以下のパターンを自動クリーンアップ:
  - **(1) 孤立した空 `- `**: 上下が空行 (or 文書境界) で `- ` だけの単独行 → 削除
  - **(2) リスト末尾の空 `- `**: 直前が list 行 + 直後が空行 / EOF の空マーカー → 削除 (複数連続でも全部削除)
  - **(3) 中間の空 `- `**: 前後が valid list item に挟まれた空マーカーは **保持** (意図的な空かもしれないため)
  - 数字リスト (`1.` `2.` `3. `) も同様に処理
  - HTML / text 両経路の合流点で line-based iterative cleanup (test: `test/specs/html-paste-empty-list-marker.spec.ts` 6 ケース)

### Changed
- **Outliner page icon を SVG + 灰色のシンプルな白紙ページに刷新** — `📄` 絵文字を SVG document icon (枠 + 折り角のみ、中の文字線なし) に置換。色は `#888` 灰色、`opacity: 0.85`、hover で 1.0
- **Outliner 行の縦中央配置を改善** — 行ハイライト (focus / select / search match) 時に text の下に余白が出る問題を修正。`.outliner-node` 系の `1.58em` height/min-height を text の `line-height: 1.35` に揃え、`padding: 0.25em 0` で対称的に行高さを保持。font-size 変更にも proportional 追従

## [0.203.8] - 2026-05-07

### Added
- **🌐 Chrome Extension (Web Clipper)** — `chrome-extension/` 配下に Chrome 拡張機能を新設。Chrome でブラウズ中の任意の Web ページを Fractal `.out` の最上位 node として直接取り込める (VSCode 起動不要、File System Access API で直接 `.out` / page MD を書き込み)
  - ツールバーアイコン or `Alt+Shift+F` で発火 → Mozilla Readability で本文抽出 → Fractal の HTML→MD パイプラインで Markdown 化 (MD editor の cmd+v paste と同一ロジック) → `pageId` 付きの新 node を `.out` 先頭に追加 + page MD を `pages/` 配下に保存
  - Options 画面で対象 Notes フォルダ + `.out` ファイルを 1 度だけ選択 (`showDirectoryPicker` + IndexedDB に handle 永続化)
  - **In-page banner** で進捗 / 完了 / エラーを必ず可視化 (OS 通知許可 OFF 環境でも見える)。chrome.notifications も併用
  - **複数タブ同時クリックを queue で直列化** — 同一 `.out` への並列書き込み競合 (10s+ 肥大) を防止。待機中は banner で「⏳ Clip 待機中 (N 件目)」表示
  - SW 起動中はアイコン disable + badge `⋯` で「準備中」を視覚化、warmup 後 enable
  - インストール: `chrome://extensions/` で「パッケージ化されていない拡張機能を読み込む」→ `chrome-extension/` フォルダを選択。詳細は `chrome-extension/README.md`

### Fixed
- **HTML → Markdown 変換: `<a><img></a>` を `[![alt](src)](href)` ではなく `![alt](src)` に簡略化** — note.com の見出し画像のように、`<a>` がテキストを持たず `<img>` だけを wrap してる場合は link wrapper を捨てて pure image embed として出力。MD editor の `Cmd+V` paste と Chrome ext の Web Clipper 両方に適用
- **HTML → Markdown 変換: Medium 等の `<code>` 無し code block を fenced code block として出力** — Medium / dev.to は `<pre><span class="hljs-*">...<br>...</pre>` (code 要素なし、改行 `<br>`) の構造で、従来は plain text として出力されていた。`hljs-*` クラスまたは `<br>` を含む `<pre>` を code 判定 + 再帰 walk で `<br>` を `\n` に変換 + textContent + 多段フォールバック (絶対に code block を消失させない設計)。MD editor / Chrome ext 両方に適用

## [0.203.0] - 2026-05-06

### Added
- **🎉 Outliner Table View — `.out` ファイルを spreadsheet 形式で開ける新ビュー**
  ツールバー右の table アイコンで **同じ webview 内** で outliner ⇄ table をトグル切替可能 (新タブを開かない)。Notion / Coda の database view 風の column-based 一覧編集体験を Fractal 上で実現。
  - **列ヘッダー + 列セル**: Outliner 列 (常に最左、固定) + 任意数の text 列 / multiselect 列を追加可能。`grid-template-columns` で列幅合計を計算し、画面幅を超える場合は `.outliner-tree` 内で横スクロール
  - **列の追加 / 削除 / 並べ替え / 列幅 D&D resize**:
    - 列ヘッダー右クリック → 「Rename column」「Insert column to the left」「Insert column to the right」「Remove column」 (Outline 列右クリックは Insert right + Rename のみ)
    - 列ヘッダー D&D で順序入替 (Outline 列は固定)
    - 列ヘッダー右端 6px の絶対配置 resize handle で個別列幅変更 (`MIN_COLUMN_WIDTH=126`, `DEFAULT_OUTLINER=288`, `DEFAULT_OTHER=180`)
  - **text 列**: contenteditable で `Cmd+B` / `Cmd+I` / `Cmd+E` / `Cmd+Shift+S` / IME / paste 対応。outline 列と CSS 完全統一 (inline code / 取消線 / strong / em / link / tag 同じ見た目)。URL paste 時に自動で `[URL](URL)` markdown 化、リンクは非編集時クリックで外部ブラウザ開く
  - **multiselect 列 (タグ master 化)**: option label を `#xxx` / `@xxx` 形式に正規化 (prefix なしは自動 `#` 付与)。8 色 palette (red/orange/yellow/green/blue/purple/pink/zinc) auto-color。chip ダブルクリック → 検索ボックスに反映、cell 内 chip ✕ で個別解除、dropdown 内 🗑 で master から削除 + 全 cell から該当 option 自動 purge
  - **行 state ハイライトの全列適用**: `is-focused` / `is-selected` / `is-search-match` を outline cell だけでなく text / multiselect cell にも attach し、行全体が同色に染まる
  - **Cmd+↑↓→← セル間移動**: table mode 内で grid-aware なナビゲーション。outline / text / multiselect のセル種別を跨いで移動可能
  - **検索拡張**: `OutlinerSearch._matches` を拡張し、text 列の値・multiselect option label・text 列内の literal `#tag` も検索対象に。tag query (`#xxx`) は `node.tags` だけでなく multiselect 選択値 + text 列 literal タグもヒット
  - **検索フォーカスモード対応**: table mode でも `searchFocusMode` で match 行を depth=0 として並べ、子ノードが match した場合は祖先パンくずを `grid-column: 1 / -1` で全列幅に表示
  - **cut/copy/paste で列値維持**: 同一 outliner 内の cut/copy/paste は `node.columnValues` を deep copy で保持。別 outliner (cross-file) は列定義 / option id が共有されないので outline 列のみ paste される
  - **永続化**: `model.columns[]` (列定義) と `node.columnValues` (各 node の値) を `.out` JSON に serialize。outliner mode で開いても破壊されない (`RAW_DATA_KNOWN_KEYS` 経由で passthrough、TBE-03 完全互換)
- **🆕 検索ボックス内のタグ候補 popup** — 検索ボックス focus 時、その outliner に含まれる全タグを **使用頻度降順** で popup 表示。クリックで検索ボックスに append + 即検索。multiselect 選択値も集計対象。blur で即座に hide
- **🆕 Outliner ヘッダー再設計**:
  - title 行 (大見出し): スクロールで消える
  - 検索バー + ナビ + 機能ボタン行 (sticky top:0 / left:0): 縦・横スクロールどちらでも固定
  - daily note 時のみ daily nav (Today / 前日 / 翌日 / カレンダー) を search bar 先頭に表示 (旧 pinned-nav-bar 廃止)
  - table mode の col-header は search bar の直下 (`top: 36px`) に sticky で固定
- **🆕 Cmd+↑/↓/→/← で table cell 間 focus 移動**

### Changed
- **flat DOM 単一化 (Phase F1.5)** — 旧 hierarchical 描画 (`.outliner-children` ネスト DOM) を全廃。全 row が `.outliner-tree` 直下に flat に並び、indent は `data-depth` + `.outliner-node-indent { width: depth * 24px }` で表現。RENDER_MODE flag 撤廃、render path / handler が単一化されてコードベース 451 行削減。outline / table 両 view が同じ flat 基盤を使う
- **UI 全体を約 90% scale** — `cmd+- 1 ステップ` 相当の見た目をデフォルトに (zoom CSS は使わず、px / em / line-height / SVG icon サイズを script で機械的に手動 scale)
  - `outliner.css`: 167 px + 24 em/ratio
  - `styles.css`: 249 px + 59 em/ratio
  - `notes-body-html.js`: 83 px
  - SVG icon (`width="N"`, `height="N"`) も全 webview で 0.9 倍化
- **`fractal.fontSize` default を 14 → 12** に変更
- **Outliner ヘッダー文字色** を `opacity: 0.65` で薄め、純黒の強さを抑制

### Fixed
- **ArrowLeft (折りたたみ) / ArrowRight (展開) 実行後にカーソルが抜けるバグ** — `toggleCollapse` が `renderTree()` を呼んで DOM を再構築していたため `textEl` が stale になり focus が失われていた。toggle 後に同 nodeId で要素を取り直し、`getCursorOffset` / `setCursorAtOffset` で位置復元
- **Enter / Opt+Enter 後に文字入力 → Cmd+Z でカーソル復帰位置の不整合** — undo snapshot の種別 (`'action'` / `'edit'` / `'initial'`) を並列 array で保持し、popped 種別に応じて `savedFocus` (操作開始位置) と `dedupFocus` (直前 edit 位置) を切替。Enter at end of parent → 文字入力 → Cmd+Z で「parent 末尾」に正しく復帰
- **renderTableMode が DOM を clear しない不具合** — 列の追加 / 削除 / rename ハンドラが直接 `renderTableMode()` を呼ぶ際 `treeEl.innerHTML = ''` を経由しないため、旧 DOM の上に新 DOM が重畳して grid が破綻していた。冒頭で確実に clear するよう修正
- **column context menu の Rename が動かない** — `mousedown` で outside-handler が menu を close してしまう競合。各 menu item の `mousedown` で `stopPropagation` して回避
- **Remove column が動かない** — `window.confirm` が VSCode webview でブロックされて常に false 扱いだった。確認ダイアログを撤廃 (saveSnapshot 済なので `Cmd+Z` で復元可)
- **table mode の col-header が theme で黒く表示される** — `--vscode-editor-background` 等は VSCode 側のテーマ依存で、Fractal の `data-theme` (github / things 等) と一致しない。`--outliner-bg` / `--outliner-fg` (Fractal 独自テーマ変数) に統一
- **table mode で行高さが固定** — `grid-auto-rows: minmax(min-content, max-content)` + `align-items: start` + 内部 flex 制約 (`width: 0` + `min-width: 0`) で text wrap / 画像 / subtext で自動伸縮
- **横スクロールで title / search bar も巻き込まれる** — title / scope-indicator / search-bar を `position: sticky; left: 0; width: 100%` で横スクロールから外す。table のみ `.outliner-tree` 内で水平スクロール
- **focus mode で root ノードしかヒットしない** — table mode 用 `renderTableFocusRows` 新設、全 node 走査で direct match を depth=0 で並べ、子孫を depth+1 以降で flat 配置
- **notes-resize-handle の hover bar が editor 側にもはみ出る** — hover bar を file panel 側のみに収めた (`left: -2px; right: 0`)
- **Outline 列ヘッダー padding** を `4px 20px` に拡張 (他列は `4px 8px` のまま)

### Removed
- **pinned-nav-bar 行 / pinned tag 機能 / pinned-settings-btn** — header redesign に伴い一旦撤去 (検索ボックス内のタグ候補 popup で代替可能)
- **`.outliner-children` ネスト DOM** — flat DOM 単一化に伴い hierarchical 描画パスを全廃

## [0.195.781] - 2026-05-02

### Fixed
- **Outliner: cmd+z / cmd+shift+z で「編集対象ノード」に正しくカーソル復帰** — `findDiffNodeIdInTarget()` の差分検知ロジックを 4 phase に再構成。Phase 1 で `text/subtext/collapsed/isPage/pageId/filePath/parentId` を最優先比較し、children 配列 diff (Phase 4) より前に評価する。これにより:
  - 子ノードの追加/削除取消時に親ノードへ飛んでしまうバグを解消（旧: `parent.children` 配列 diff にヒット → 親が返る）
  - Tab/Shift+Tab で indent / outdent した直後の cmd+z / cmd+shift+z で、moved node 自身にカーソル復帰（旧: 移動先親ノードへ飛んでしまう）
  - 削除ノードの兄弟検索ロジックを Phase 3 に分離し、前兄弟 → 後続兄弟 → 親の優先順で focus 候補を選ぶ
- **Outliner: cmd+z 1 回で複数の重複 snapshot を一括 pop** — undo() / redo() に while-loop dedup を入れ、stack に積まれた連続同一 snapshot を 1 操作で全て消費。「最初の cmd+z で何も起きず、2 回目で undo 実行」現象を解消
- **Outliner: 検索ボックスで cmd+z 押下時の native input undo 抑止** — document-level の capture-phase keydown listener を追加し、`searchInput.value` が native の input history で書き換わるのを防ぐ多層防御 (5 層)
- **Outliner: undo/redo 後のフォーカス保護** — `markActivelyEditing()` を undo/redo に呼び出し、外部ファイル変更通知 (file watcher echo) で `undoStack` がリセットされるレースを防ぐ
- **Outliner: collapse された祖先配下のノードへ undo フォーカスする時に展開** — `expandAncestorsAndFocus()` で全祖先を展開してから focus

### Added
- **Integration tests** for undo/redo cursor behavior:
  - `test/specs/integration-outliner-undo-redo-cursor.spec.ts`
  - `test/specs/integration-outliner-undo-2step-trace.spec.ts`
  - `test/specs/integration-outliner-search-undo-and-nav-shortcut.spec.ts` (拡張)

## [0.195.766] - 2026-05-01

### Fixed
- **Outliner: empty nodes (`text === ''`) no longer drop on cmd+c/cmd+x → cmd+v** — The text-line parser in `pasteNodesFromText()` had a `if (content === '') { continue; }` guard that ran regardless of whether `clipboardNodes` (internal copy/cut metadata) was provided, so intentional empty nodes from the source selection were silently dropped during paste. Worse, level normalization on the surviving entries reparented descendants in unexpected ways (e.g. `[a, empty, empty, b@lvl2, c]` → `[a, b@lvl1, c]` with `b` now incorrectly a child of `a`). Fix: when `clipboardNodes` is provided (= internal copy/cut from any clipboard channel — `internalClipboard`, OS `text/html` `data-outliner-clipboard` meta, host-side store), bypass text parsing entirely and feed `clipboardNodes` directly into the `parsed[]` array. External paste (no `clipboardNodes`) keeps the empty-line skip behavior to handle trailing newlines from Notepad/TextEdit etc.
- **Outliner: pasting on an empty node that has children no longer cascades-deletes the children** — The `currentText === ''` branch of `handleNodePaste()` unconditionally called `model.removeNode(nodeId)`, but `removeNode` is recursive (cascades to all descendants). For an empty node with a deep subtree, the entire subtree was destroyed by paste. Fix: only take the remove+replace path when `currentText === '' && !hasChildren`. Empty nodes with children now follow the same path as non-empty nodes — the node itself is left intact and the pasted content is inserted as siblings immediately after.

### Tests
- **+7 sprint test cases** across 2 new spec files in `test/specs/`:
  - `integration-outliner-paste-preserves-empty-nodes.spec.ts` (5) — middle empty in hierarchy / consecutive sibling empties / complex empty-of-empty hierarchy / sibling-level `[empty, A, empty, B, empty]` / regression: external paste still skips blanks
  - `integration-outliner-paste-empty-with-children.spec.ts` (2) — empty-with-children paste preserves subtree / regression: empty-leaf paste still replaces

## [0.195.763] - 2026-05-01

### Added
- **MD editor: `Opt+Enter` creates a child list item** — Pressing `Opt+Enter` while the cursor is in a list item now inserts a new empty `<li>` as the **first child** of a nested list (creating the nested list if absent). Standalone editor + side panel both supported. The plain `Enter` continues to create a sibling at the same indent.
- **Notes file panel: right-click → "Copy Path"** — On any `.out` file in the Notes folder panel, right-click context menu gains a "Copy Path" item that writes the absolute filesystem path (e.g., `/Users/.../notes/foo.out`) to the OS clipboard. Reuses the existing 7-language `copyPath` i18n key (en: "Copy Path" / ja: "パスをコピー" / zh-cn / zh-tw / ko / es / fr).

### Fixed
- **Side panel: `Opt+Left` / `Opt+Right` shortcut now actually navigates back/forward** — The keydown handler in `editor.js:6839` was reading `self.filePath` to determine the side panel file path, but `filePath` lives on the `host` object (`SidePanelHostBridge`), not on the `EditorInstance`. The lookup always returned `undefined`, causing the `if (spFp && ...)` guard to fail silently. Fix: use `host.filePath` directly.

### Tests
- **+6 sprint test cases** across 2 new spec files in `test/specs/`:
  - `integration-md-opt-enter-child-list.spec.ts` (4) — simple `ul` Opt+Enter / type-and-render / sibling regression / existing nested list inserts at top
  - `integration-notes-file-panel-copy-path.spec.ts` (2) — menu item present / clipboard contents

## [0.195.761] - 2026-04-30

### Fixed
- **Outliner: cmd+x / cmd+c on a parent node now includes all descendants** — Previously, only the visible (non-collapsed) flat list was iterated when serializing the selection, so children of a folded node (or children that simply weren't part of the user's visual selection) were dropped from the clipboard. The cut path then deleted the parent + cascaded children from the source via `model.removeNode`, but the clipboard payload only had the parent → paste resurrected only one row. Fix: `getSelectedText()` / `getSelectedNodesData()` / `deleteSelectedNodes()` now expand `selectedNodeIds` with `model.getDescendantIds()` before serialization, and walk `getFlattenedIds(false)` (`skipCollapsed=false`).
- **Outliner: paste preserves the folded (collapsed) state of pasted nodes** — `getSelectedNodesData()` now records `collapsed` per node, and `pasteNodesFromText()` restores it on the new node (`newNode.collapsed = true` when the clipboard entry was folded).
- **Outliner: cmd+v while a text range is selected within a node now replaces the selection** (instead of inserting before/after the selected text). Previously `handleNodePaste()` used only `getCursorOffset()` (the start of the selection) and ignored the end → result was `<pasted><selected>`. New helper `getCursorRange(textEl)` returns `{ start, end }`; the single-line/no-metadata branch now slices `curText.slice(0, start) + insertText + curText.slice(end)`.
- **Outliner: intermittent "only one line pastes" on cross-outliner copy/paste** — Same root cause as the cmd+x bug above. When the source selection contained a parent with collapsed children, the multi-line clipboard payload (`text/plain` + `text/html` `data-outliner-clipboard`) only had the parent, so cross-outliner paste reproduced only the parent. The fix to `getSelectedText()` / `getSelectedNodesData()` resolves this for all three clipboard channels (internal, OS `text/html` meta, host-side `OutlinerClipboardStore`).
- **Outliner: shift+↑ / shift+↓ during text selection now clears the residual text range** — When entering multi-row selection mode while a contenteditable text range was active, the text Selection persisted under the surface. Subsequent `cmd+c` would dispatch the browser's default "copy selected text" path instead of the outliner's multi-row copy → only the highlighted text was placed on the clipboard. Fix: `selectRange()` now calls `window.getSelection().removeAllRanges()` if a non-collapsed range is present at entry, so cmd+c reliably copies the row set.
- **Outliner: multi-line paste at a first-child empty sibling now lands at that position** — Previously, when the cursor was on an empty node that was the first child of its parent (e.g., `a > [empty, b, c]`) and the user pasted multi-line content, the empty node was removed correctly but the new nodes were appended to the **end** of the parent's children (`[b, c, e, f]` instead of the expected `[e, f, b, c]`). Root cause: `pasteNodesFromText(... afterId=null)` falls into `model.addNode`'s "append to end" path. Fix: `pasteNodesFromText()` accepts a new `insertAtStart` flag; `handleNodePaste()`'s empty-node branch sets it when `sibIdx === 0`. The first level=0 node is then created via `model.addNodeAtStart`; subsequent nodes follow via `levelToLastId[0]` so the insertion order is preserved.

### Tests
- **+12 sprint test cases** across 4 new spec files in `test/specs/`:
  - `integration-outliner-cmd-cut-copy-children.spec.ts` (4) — Bug 1 (parent + visible children) / Bug 2 (folded parent → all descendants + collapsed state) / Round-trip cut→paste / Multi-select with collapsed siblings
  - `integration-outliner-paste-replaces-selection.spec.ts` (3) — Full-selection replace / Partial-selection replace / Cursor-only (collapsed selection) keeps existing behavior
  - `integration-outliner-shift-arrow-clears-textsel.spec.ts` (2) — text selection cleared on shift+arrow / cmd+c after shift+arrow copies row set
  - `integration-outliner-paste-empty-leading-sibling.spec.ts` (3) — first-child empty paste / middle empty paste (regression) / last empty paste (regression)

## [0.195.760] - 2026-04-30

### Added
- **Pinned tag context menu** (F1) — Right-click a `#tag` / `@mention` span on an outliner node to get an **"Add to Pinned Tags"** menu item that adds the tag to the pinned-tag bar. If the tag is already pinned, the item is greyed out (no toggle-to-remove — removal stays explicit via the existing pinned-tag bar UI). 7-language i18n via `outlinerAddToPinnedTags`. Standalone outliner: persisted to `.out`. Notes mode: persisted to the per-`.out` `pinnedTags[]` (unchanged — pinned tags remain a per-outliner concept).
- **Note-level sidepanel md width persistence** (F2) — In Notes mode, the side panel MD width set by D&D resize is now stored in the note's `outline.note` file (root-level `sidePanelWidth`), so all `.out` files within the same note share one width. Standalone outliner keeps its existing per-`.out` `data.sidePanelWidth` behavior. Fallback chain: `outline.note` → `.out` → default. Backward compatible — existing `.out` `sidePanelWidth` values are still honored when no note-level value is set.
- **Side panel TOC (outline) drag-resize** (F3) — A 4px resize handle appears on the right edge of the outline sidebar inside the side panel; drag to resize. Visible only when the sidebar is open. Min 100px, max 50% of the side panel width. Persistence:
  - **Standalone outliner**: width saved to `.out` JSON as `sidePanelOutlineWidth`.
  - **Notes mode**: width saved to `outline.note` root-level `sidePanelOutlineWidth` (shared across all `.out` in the note).

### Changed
- **`NoteStructure` schema** (`outline.note`) — Added two optional root-level fields: `sidePanelWidth?: number` and `sidePanelOutlineWidth?: number`. Older `outline.note` files without these fields continue to work (the `panelWidth` field for the left file panel is unchanged).

### Tests
- 16 new sprint test cases:
  - `test/specs/integration-pinned-tag-context-menu.spec.ts` (5): right-click on `.outliner-tag` → menu shows; click adds; already-pinned → disabled; non-tag click → no item; @mention also works
  - `test/specs/integration-sidepanel-toc-resize.spec.ts` (6): handle exists; only visible when sidebar open; CSS col-resize 4px; drag changes width; standalone drag → `data.sidePanelOutlineWidth` in syncData; min 100px clamp
  - `test/unit/notes-file-manager-sidepanel-width.spec.ts` (5): save/get round-trip; persist across reload; outline.note JSON contains the fields; independence from `panelWidth`
- All 16 pass; existing `outliner-basic` / `outliner-features` / `inapp-link-contextmenu` / `integration-sidepanel-nav-flow` regress clean (49/49 pass).

## [0.195.759] - 2026-04-30

### Changed
- **`fractal.imageMaxWidth` default reduced from `600` → `400`** — New installations and users who haven't set this value explicitly will see images cap at 400px instead of 600px. Existing users with an explicit setting are unaffected. Updated in `package.json` schema, all three TS providers (`editorProvider.ts` / `notesEditorProvider.ts` / `outlinerProvider.ts`), and the CSS `var(--image-max-width, …)` fallback.

## [0.195.758] - 2026-04-30

Documentation catch-up release. Backfills features that landed in earlier builds but were never explicitly captured in CHANGELOG / README. **No code-behavior changes from `0.195.757`** other than version bump and packaging.

### Documented (backfill)
- **Drawio.svg / drawio.png inline support (MD-45 / MD-46 / MD-47 / MD-48)**
  - **D&D import**: Drag a `.drawio.svg` or `.drawio.png` from Finder / VSCode Explorer onto the MD editor → file is copied to `fractal.fileDefaultDir` (default `./files`) and `![filename](relative)` is inserted at the cursor (MD-45). All 4 drop sources (Files / items / URI list / plain-text path) are routed through the same handler. File-name collisions get a `-1`, `-2`, ... suffix preserving the multi-extension (`foo.drawio.svg` → `foo-1.drawio.svg`, **not** `foo.drawio-1.svg`).
  - **`.drawio` (XML) D&D rejection dialog**: Dropping a single-extension `.drawio` (XML) shows a custom warning modal with **"Open in drawio Desktop"** and **"Cancel"** buttons (MD-46). The OK button calls `vscode.env.openExternal` (extension mode) or `shell.openPath` (Electron mode) to open the dropped file in drawio Desktop. Cancel inserts nothing. 7 languages (en/ja/zh-cn/zh-tw/ko/es/fr) via `unsupportedDrawioXmlNotice` / `openInDrawioDesktopButton`.
  - **Cmd+/ → "Insert Drawio Diagram"** (MD-47): New Insert-group palette item. Prompts for a filename (`.drawio.svg` is auto-appended), creates a placeholder MXFILE template (1 placeholder rect) at `fileDefaultDir/<name>.drawio.svg`, and inserts `![<name>](relative)` at the cursor. i18n key `insertDrawioDiagram`.
  - **External-edit auto-refresh** (MD-48): Saving the `.drawio.svg` from drawio Desktop / hediet.vscode-drawio re-renders the inline thumbnail in all open MDs that reference it. The dedicated `DrawioWatcherRegistry` (`src/shared/drawioWatcher.ts`) parses MD body for `![](*.drawio.svg)` / `*.drawio.png`, registers per-file `vscode.workspace.createFileSystemWatcher` + `fs.watchFile` polling fallback, and broadcasts `drawioFileChanged` to webviews (debounced 200ms). Same atomic-rename hardening that was made shared via `createDrawioFileWatcher` factory in `0.195.757`.
  - **Outliner D&D routing**: `.drawio.svg` / `.drawio.png` dropped on the outliner tree creates a 📎 file-attachment node (`OL-19B` path), **not** a thumbnail node (`OL-15` path). Multi-extension classifier `classifyDroppedFile()` is shared by MD editor and outliner.
  - **Paste-asset-handler (MD-41) drawio recognition**: Pasting a node containing `![](drawio.svg)` across outliners duplicates the file via `fileDir`, **not** `imageDir`.

- **Image fullscreen lightbox: pinch-zoom + drag-to-pan**
  - Double-click any image in the standalone MD editor / side panel / outliner to open the fullscreen overlay.
  - **Pinch to zoom** on Mac touchpad (Chromium standard `wheel + ctrlKey` event), zoom range 0.2× – 16×, zoom origin follows the cursor (cursor stays anchored to the same image pixel).
  - **Drag to pan** when zoomed in (mouse drag with grabbing cursor).
  - **Double-click image** to reset zoom to 1× / origin.
  - **ESC** or **click background** to close.
  - Hint banner at bottom: `Pinch to zoom · Drag to pan · Double-click to reset · ESC to close`.

- **`fractal.imageMaxWidth` setting** (also in v0.195.757 entry below) — Caps inline image width in editor / side panel / outliner page side panel; `<img>` `style="max-width:100%"` inline attribute is overridden by a CSS rule with `!important`. Toolbar/lucide/command-palette icons are excluded.

### Notes
- The drawio inline features above were originally developed in sprint `20260427-102330-drawio-thumbnail-inline` (never released to master) and have been shipping as runtime code since builds prior to `0.195.757`. This release officially documents them.
- README "Features" section updated with dedicated entries for drawio support, side panel cmd+/ Add Page, table column-width persistence, side panel back/forward navigation, image pinch zoom, and `fractal.imageMaxWidth`.

## [0.195.757] - 2026-04-30

Sprint `20260430-151055-md-table-sidepanel-batch` (v16) — md / table / sidepanel batch fixes & enhancements.

### Added
- **`fractal.imageMaxWidth` setting (default 600px, min 100px)** — Caps image and drawio.svg width in the editor (MD-52). Previously images filled the full editor width via inline `max-width:100%`. The new CSS rule applies in standalone editor / side panel / outliner page side panel; toolbar/lucide/command-palette icons are excluded. Double-click for fullscreen view is preserved.
- **cmd+/ Add Page link-name input modal** — Selecting "Add Page" from the command palette now opens a custom overlay modal (default `untitled`) instead of inserting a fixed `untitled` link (MD-49). On OK, the new page MD is created and `<a>{linkName}</a>` is inserted at the cursor; if `linkName ≠ "untitled"`, the new MD's H1 is synced via `host.updatePageH1`. Cancel / Escape removes the marker without creating anything. `useSimpleAddPage = true` is now universal (replaces the older auto/at-path two-step action panel for standalone `.md`).
- **Right-click "Rename Link" context menu** — Available on any `<a href>` (md link / file link / URL link) (MD-50). Custom modal preloads the current text; OK updates `textContent` only (href unchanged). i18n: 7 languages (en/ja/es/fr/ko/zh-cn/zh-tw) via `contextRenameLink` / `promptRenameLink`. Context menu separator color is now theme-aware (`menuBorder` + opacity 0.5) — no more hard black line in light themes.
- **Side panel navigation history (back / forward)** — Navigate through MD links inside the side panel using **Opt+Left / Opt+Right** or the new ←/→ buttons in the side panel header (left of filename, right of "Open Outline") (SP-01). The buttons are translucent (opacity 0.5) when no history, opaque when navigable. Back/forward stacks are managed by `SidePanelManager.openFile(path, freshOpen)`; opening from outliner click clears history (fresh) while in-side-panel link clicks push to back stack.
- **Side panel outline is always shown** — Even when the MD has zero headings, the outline sidebar stays visible with an "見出しがありません" / "No headings" placeholder (SP-02). Previously the sidebar would auto-close on empty TOC. i18n via `outlineEmpty` (7 languages).
- **Side panel cmd+/ Add Page (simple flow)** — Pressing cmd+/ → Add Page inside a side panel MD now uses the marker-pin + auto-named filename + immediate link insertion flow (SP-03). pageDir resolves to outliner pageDir (when side panel is showing an outliner page) or `<sidePanelDir>/pages` otherwise. New MD is auto-named `<timestamp>.md` with initial content `# ` (relies on MD-51 for the empty-heading visibility).
- **Empty heading is visible** — Headings rendered from `# ` (trailing space only, no text) now produce `<h1><br></h1>` instead of an empty `<h1></h1>` (MD-51). This makes new pages from cmd+/ Add Page show their h1 immediately (so the user can type the title).
- **Markdown table column resize** — Drag the right edge of **any cell** (not just the header row) to resize the entire column (TBL-01). Visual feedback: hover/drag highlights the whole column with a continuous blue bar (no row gaps). Mouse tracking uses absolute positioning (`e.clientX − cell.left`) for ±3px accuracy. Width is clamped to ≥80px. New rows from Enter / Add Row work automatically (no DOM mutation observer needed — pure mouse-position detection).
- **Markdown table column width persistence** — Column widths after a resize are saved as an HTML comment `<!-- fractal-col-widths: w1,w2,w3 -->` immediately before the table in the markdown source (TBL-03). On open, the comment is parsed and applied to the next table (`<table style="table-layout:fixed; width:Wpx">` + per-cell `style="width:Npx"`). Other markdown viewers ignore the comment, so file portability is preserved.

### Changed
- **drawio Desktop external-edit auto-refresh now uses dual watchers** — `vscode.workspace.createFileSystemWatcher(RelativePattern)` + `fs.watchFile(path, {interval:1000})` polling fallback are integrated via the new `createDrawioFileWatcher` factory (MD-53). This prevents the atomic-rename saves used by drawio Desktop from being missed by the FileSystemWatcher (previously could cause 2nd/3rd of multiple drawio.svg in the same MD to fail to refresh). The factory is shared by `editorProvider.ts` (standalone) and `notesEditorProvider.ts` (Notes mode); the webview-side matcher prefers absolute path full match with basename fallback, and force-reloads via `removeAttribute → setAttribute` when the same mtime arrives twice.
- **Side panel cmd+/ → Insert Drawio routing fix** — `SidePanelHostBridge.requestCreateDrawio()` now calls `_onImageRequest()` so `sidePanelImagePending=true` is set; the resulting `insertImageHtml` response is correctly dispatched to the side panel editor (MD-54). Previously the response landed in the main editor, causing the drawio.svg to appear in the wrong place (or nowhere).
- **cmd+/ Add Page / drawio insertion is robust to selection-outside-editor** — The marker placement in `case 'addPage'` and `case 'drawio'` of `dispatchToolbarAction` now verifies `editor.contains(selection.startContainer)` before insertion; if outside, a new `<p>` is appended to the editor end with the marker (MD-54). `handlePageCreatedAtPath` / `insertImageHtml` / `insertFileLink` / `insertLinkHtml` fallback paths use the same defense: `editor.appendChild` if selection is outside the editor.
- **Markdown table cell resize handle is no longer a DOM element** — The previous approach embedded `<div class="table-col-resize-handle" contenteditable="false">` inside each cell, which trapped the contenteditable cursor and caused ArrowRight at end-of-text to land at the cell's right edge (TBL-06). The new approach uses a CSS `::after` pseudo-element on `<th>` / `<td>` for the visual blue bar, and detects mouse near the right edge (≤6px) via cell `getBoundingClientRect()`. Cells contain no extra elements; cursor navigation is identical to a normal table.
- **Markdown table empty cells serialize as empty in markdown** — A new row's empty cells (`<td><br></td>`) now serialize to `|  |` (whitespace) instead of `| <br> |` (TBL-05). Mid-cell `<br>` (e.g., `text<br>text` for a line break) is preserved.
- **Markdown table de-flatten is now line-scoped** — `normalizeMultiLineTableCells` only de-flattens lines that contain `| <br> | --- |` (the Notion-flattened header→separator signature) (TBL-04). Previously it would split legitimate empty-cell rows like `| <br> | <br> |` into orphan `|` lines, breaking the table on copy-paste round-trip.
- **Markdown table rightmost-column resize no longer shrinks other columns** — `updateColumnWidth` now manages explicit `style.width` per column in an array, applying `table.style.width = sum(array)` BEFORE updating individual cells (TBL-02).

### Fixed
- **Shift+Enter in an empty markdown table cell now inserts exactly one `<br>`** — Resolved by TBL-06 (handle removal restored correct `lastChild` semantics) (TBL-07).
- **Side panel back/forward buttons actually navigate** — `closeSidePanelImmediate(isSwitch=true)` now skips `notifySidePanelClosed` during file switch, preventing the extension from clearing history immediately after `handleOpenLink` pushed to the back stack (SP-01). Side effect: `Object.defineProperty(window, 'activeTableCell', ...)` is now `configurable: true` so panel re-init no longer throws `TypeError: Cannot redefine property`.

### Tests
- **+67 sprint test cases** across 11 new spec files in `test/specs/`:
  - `integration-image-max-width.spec.ts` (3), `integration-multi-drawio-refresh.spec.ts` (4), `integration-sidepanel-drawio-insert-routing.spec.ts` (2)
  - `integration-empty-heading-rename-link.spec.ts` (9), `integration-sidepanel-outline-always.spec.ts` (3), `integration-sidepanel-nav-flow.spec.ts` (5)
  - `integration-sidepanel-addpage-robustness.spec.ts` (5), `integration-standalone-addpage-simple.spec.ts` (5), `integration-md-cmd-x-paste-semantics.spec.ts` (11)
  - `integration-table-resize.spec.ts` (13), `integration-table-copy-paste-empty-cells.spec.ts` (7)
- All 67 pass under Playwright `testMatch: ['specs/**/*.spec.ts', 'unit/**/*.spec.ts']` (auto-included, no config change needed).
- 5 minor cleanups deferred (test files referencing the now-removed `.table-col-resize-handle` DOM): `test/specs/table-cell-operations.spec.ts:332,349,464` (test_remove), `md-paste-asset-copy.spec.ts:32` (test_update), `outliner-cross-paste.spec.ts:297` (test_update). Non-blocking; covered by new sprint specs.
- 64 pre-existing failures in unrelated specs (translate-e2e, backspace-list, outliner-format, etc.) are NOT sprint-caused; deferred to a separate sprint.

## [0.195.722] - 2026-04-26

### Added
- **New setting `fractal.showTranslateButtons` (boolean, default `false`)** — Controls visibility of translate / translateLang buttons in both the standalone editor toolbar and side panel header. Translation can still be triggered via the `fractal.translate` command (Cmd+/) regardless of this setting (UI visibility only).
- **Standalone editor toolbar gains a translate group** — When `fractal.showTranslateButtons` is on, the standalone MD editor toolbar shows translateLang + translate buttons at the leftmost position (inside `toolbar-inner`, before the inline group). The side panel header continues to host these buttons as before.

### Changed
- **Default OFF for translate buttons (behavior change)** — Existing users who had translate buttons visible in the side panel header will see them disappear by default. Set `fractal.showTranslateButtons: true` in settings to restore them. The translation feature itself is unchanged; only the UI affordance is gated.
- **Standalone toolbar translate result no longer uses the side panel** — When the translate button is invoked from the **standalone** editor toolbar, the translation result now replaces the editor view in place (with a sticky `← Back / Translation (src → tgt) / Copy` header bar) rather than opening in a side-panel slide-over. The side-panel-based flow remains for outliner page contexts (unchanged via `outliner.js showTranslationInSidePanel`). The side-panel link-open behavior for plain MD links is also unchanged.

### Fixed
- **No disk overwrite while viewing a translation** — While the inline translation view is active, the editor's `blur` / `sourceEditor.blur` / `_handleVisibilityChange` flush paths and `applyQueuedExternalChange` are gated by a `translationViewActive` flag. Pre-edit content is force-flushed to disk before swapping in the translation, so switching apps mid-translation no longer risks overwriting the file with the translated content. NT-14 cross-editor sync is preserved via post-Back `applyQueuedExternalChange()` catch-up.
- **Translation header label color** — The `Translation (en → ja)` label uses `--text-color` (matches body text) instead of `--blockquote-color` (which appeared inverted/white in some themes).

## [0.195.718] - 2026-04-25

### Added
- **Outliner: "Copy File Path" context menu for file-attachment nodes** — Right-click a file-attached node (`node.filePath`) → "Copy File Path" copies the absolute path of the attached file to the OS clipboard. Available in 7 languages (en/ja/zh-cn/zh-tw/ko/es/fr) via the new `outlinerCopyFilePath` i18n key. md page nodes continue to use the existing "Copy Page Path" menu (functionally equivalent, no duplicate entry added). Plain (no-attachment) nodes do not show this menu. Implemented as a new host message `copyAttachedFilePath` registered per the 5-place messaging rule (outliner-host-bridge.js / notes-host-bridge.js / outlinerProvider.ts / notes-message-handler.ts).
- **Outliner: Cmd+Enter on file-attachment nodes opens externally** — Pressing Cmd+Enter (Mac) / Ctrl+Enter (Win/Linux) on a file-attachment node now opens the file in the OS default app (reusing the existing `host.openAttachedFile`). md page nodes (`isPage`) keep their existing behavior (open page in side panel). Plain nodes keep their existing behavior (preventDefault only, no new action). Relies on `isPage` and `filePath` being mutually exclusive per data-model §4.2.
- **Editor blur observability (diagnostic)** — When `editor.blur` / `sourceEditor.blur` / `_handleVisibilityChange` fires while `hasUserEdited && queuedExternalContent !== null`, the editor logs `console.warn '[Fractal:blur-with-queue]', { instance, domLen, queueLen, delta }` for diagnosis. Helps identify the cross-edit race that previously caused view rollback. UI banner intermediate (v0.195.717) was removed in favor of console-only output.

### Fixed
- **View rollback hotfix (Fix A)** — When a user typing in `editor` / `sourceEditor` / on visibility hidden, if a stale cross-edit `update` was queued in `queuedExternalContent`, the previous behavior would call `applyQueuedExternalChange()` after flush, causing the DOM to roll back to stale content. The user, seeing the rolled-back view, would re-edit and overwrite the disk with the rolled-back state — silent data loss. The fix: when `hasUserEdited` triggers flush, drop the queue (`queuedExternalContent = null`) and skip `applyQueuedExternalChange()`. The user's typing becomes the truth; the cross-edit content is delivered again via the normal cross-edit round-trip on the next event. NT-14 cross-editor sync is preserved (the host-side `editorProvider.onDidChangeTextDocument` and `sidePanelManager.onDidChangeTextDocument` listeners are unchanged — only the in-webview blur handler in `editor.js` is modified).

### Known issues
- Edge cases not covered by the Fix A guard (out of scope for v0.195.718, planned for a follow-up sprint):
  - **IME composition mid-state + app switch**: switching to another app while an IME composition is active can still produce a view inconsistency through a different code path.
  - **Sub-debounce typing burst + app switch**: typing very rapidly and switching apps within the 1000ms debounce window (before `host.syncContent` has fired) can lose the unsynced characters.
- Workaround for both: pause briefly (~1 second) before switching apps, or press Cmd+S explicitly. The `[Fractal:blur-with-queue]` console log is unaffected by these edge cases (it fires regardless of whether the data was lost).

## [0.195.714] - 2026-04-19

### Changed
- Internal refactor of v12 drop-import: extract `saveImageBuffer` / `saveImageFromDataUrl` helpers (dedupe the image-save path across Finder and Explorer routes) and add `createDropImportHandler` factory (collapses four near-identical switch-case bodies in `outlinerProvider.ts` and `notesEditorProvider.ts` into one-liners). No behavior change — all 73 drop-import / file-import tests pass. The previous structure was what allowed the Notes-mode Explorer handler to be forgotten in 0.195.713; under the factory, adding a new drop path or platform no longer requires copy-pasting the dir resolution + failure handling boilerplate.

## [0.195.713] - 2026-04-19

### Added
- Outliner: drag & drop file import now works from **VSCode Explorer** too (previously only Finder / native file managers). VSCode Explorer drags carry `application/vnd.code.uri-list` type (not `Files`), and dataTransfer.files is empty — the outliner now detects both and routes them through separate code paths. Explorer drops go through the existing `importFiles` / `importMdFiles` functions directly (same path as ⋮ menu imports), so: (1) no 50MB size limit (file bytes are not shipped through the webview), (2) relative image references inside dropped `.md` files are resolved and copied correctly (since the source directory is available from the absolute file path). Non-local schemes like `vscode-remote://` are rejected with a warning. Finder drops continue to use the FileReader+bytes path unchanged.

## [0.195.712] - 2026-04-19

### Added
- Outliner: drag & drop file import — drop files from Finder / Explorer directly onto the outliner tree to create nodes, alongside the existing ⋮ menu import. Works in both standalone `.out` files and Notes mode. The drop target uses the same 25/50/25 rule as existing node reorder (top 25% = insert before, middle 50% = insert as child, bottom 25% = insert after; empty area = append to root). File type is routed by extension: `.md` → page node with H1 extracted as title (relative image references in dropped markdown are skipped — the source directory is not available from the browser File API); image (png/jpg/jpeg/gif/webp/svg/bmp) → new node with the image attached inline (same thumbnail + `images[]` persistence as Cmd+V paste); any other type → file-attachment node with `filePath` set. A single drop operation = a single undo step even when 3 files of 3 kinds are dropped together. Dropping a folder is rejected with a notification. Files over 50MB are rejected before transfer. The drop zone is the tree area only — dropping on the side panel, toolbar, header, tag bar, or resize handle does not trigger import. Visual feedback: a dashed outline appears around the tree while dragging, and the existing drop indicator line shows the precise insertion position. Existing node reorder drag-and-drop (OL-12) and the existing Import .md files / Import any files menu items continue to work unchanged — both menu and D&D paths share the same `importFilesCore` / `importMdFilesCore` internals. Path traversal is blocked at the boundary (`../`, absolute paths, and embedded `..` are rejected).

## [0.195.711] - 2026-04-18

### Added
- Notes panel: assign one of 20 fixed colors (Tailwind 500 palette: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose, slate, gray, zinc) to any folder or `.out` file icon in the Notes tab. Right-click → "Set Color" → pick a swatch (or "None" to clear). The color is persisted in `outline.note` as the `color` field and applied to the icon SVG `stroke` only — text and background are unchanged. Backward compatible: existing `outline.note` files without the `color` field continue to work. The webview→host boundary validates that the color name is in the fixed palette before persisting (rejects arbitrary strings).

### Changed
- Notes panel: `.file-panel-folder-children` `padding-left` increased from 12px to 28px so that child file/folder icons render to the right of the parent folder icon. Two-level nesting accumulates the indent correctly. Root-level item position is unchanged.

### Fixed
- Side panel markdown: pressing ESC while an image is shown in the fullscreen lightbox (open by double-clicking the image) now closes only the lightbox; the side panel itself stays open. Both `outliner.js` and `editor.js` ESC handlers now skip `closeSidePanel` when `.outliner-image-overlay` is present in the DOM, mirroring the existing skip pattern for action panel / command palette. Previously, ESC closed both the lightbox and the side panel, forcing the user to reopen the panel.

## [0.195.710] - 2026-04-15

### Added
- Outliner: full text search & replace (Cmd+F) mirroring the MD editor. Floating top-right box with search / replace inputs, N/M match counter, prev/next navigation, toggle-replace, and case-sensitive / whole-word / regex options. Searches both `text` and `subtext` across the current scope (or the whole document when no scope is active); inline formatting is preserved on replace (`**foo**` → search `foo` → replace with `bar` yields `**bar**`). Jumping to a match that lives inside a collapsed ancestor now auto-expands the ancestor chain. Replace All is a single undo step.
- Outliner: Cmd+H opens the search/replace box with the replace row already expanded (same shortcut as the MD editor).

### Changed
- Outliner: Cmd+Shift+F now focuses the existing header filter search (previously Cmd+F). Cmd+F is repurposed for the new text search & replace box.

## [0.195.708] - 2026-04-14

### Fixed
- Side panel TOC / outline: headings h3-h6 are no longer dropped. Previously the regex captured only `#{1,2}`, so `# Title` followed directly by `### Subsection` rendered just the h1. The regex is now `#{1,6}`, and non-hierarchical structures (h1→h3, h2→h5, etc.) also list every heading. The standalone editor was unaffected (it queries the DOM).

## [0.195.707] - 2026-04-14

### Fixed
- Settings: `fractal.translateSourceLang` / `fractal.translateTargetLang` are now read from VS Code settings and pushed to all webviews (MD editor, outliner, notes). Previously declared in the schema but never wired, so user-level defaults had no effect.
- Settings: code-side fallback defaults (`theme`, `fontSize`, `toolbarMode`) re-aligned with `package.json` schema (`things` / `14` / `simple`). Behavior unchanged for end-users (VS Code uses the schema default); this removes internal drift between the schema and providers.
- Types: `EditorSettings.theme` union now includes `things`, matching the schema enum.

## [0.195.706] - 2026-04-14

### Fixed
- Outliner: pasting a multi-line markdown list copied from the MD editor no longer keeps the literal `- ` / `* ` / `+ ` / `1.` bullet markers at the start of each node. Markers are stripped for external pastes only; internal outliner-to-outliner copy keeps node text unchanged.

## [0.195.705] - 2026-04-14

### Fixed
- Side panel: closing the translation-result panel (Esc, outside click, ×) then reopening now correctly restores the default header action buttons (previously the `← Back` button remained)

### Changed
- Side panel header: Expand button moved to the leftmost position of the action button group (next to Undo) so it stays visible when the panel is narrow

## [0.195.702] - 2026-04-14

### Added
- Translation (v10): AWS Translate integration via AWS CLI. Toolbar button in standalone MD + side panel header button in outliner. Translation result displayed in readonly side panel with ← Back button to restore original, loading overlay during translation. Supports 14 languages via QuickPick selection.
- Settings: `fractal.translateSourceLang` (default `en`), `fractal.translateTargetLang` (default `ja`), `fractal.transAccessKeyId`, `fractal.transSecretAccessKey`, `fractal.transRegion`

### Fixed
- Translation: language selection changes now correctly apply in side panel (previously hardcoded `ja`/`en`)
- Translation: post-process AWS output to restore MD syntax mangled by translation (missing space after `-`, `#`, `1.`, and extra space between `]`/`(`)
- Wikipedia citation paste: `[40]` now pastes as `[` + link(40) + `]` instead of `[[40]](url)` with outer brackets inside link text. `parseMarkdownLinks` detects `[[text](url)]` wrapper pattern; `turndown normalizeLink` moves bracket-wrapped link text outside the link

### Changed
- Translation language button shows only target language (e.g. `ja`) to keep header single-line; source→target shown in tooltip

## [0.195.684] - 2026-04-13

### Fixed
- MD editor: pasteWithAssetCopyResult now uses shared `_insertPastedMarkdown` function (same paste path as normal paste, including list merge and table handling)
- Kiro: Fixed double image insertion when pasting screenshots (keydown + paste event both triggered)

### Added
- Retro patterns: refactoring-timing, editor-paste-scope, webview-event-limits, hotfix-chain-rule

## [0.195.679] - 2026-04-13

### Changed
- Refactored paste-asset-handler: 6 copy/move function pairs unified into 3 functions (handlePageAssets, handleImageAssets, handleFileAsset)
- Unified message protocol: copyPageFileCross/movePageFileCross → handlePageAssetsCross, copyFileAsset/moveFileAssetCross → handleFileAssetCross (with isCut flag)
- Copy and cut operations now both copy files without deletion (cleanup manages orphans)
- Page node copy/paste now also duplicates file links ([📎] references) within .md content
- Legacy wrapper functions retained for backward compatibility

## [0.195.674] - 2026-04-13

### Added
- MD Editor: Copy/paste asset duplication — copying image/file links across different outliners/notes now duplicates physical files to destination directory
- MD Editor: Clipboard context (`text/x-any-md-context`) carries source imageDir/fileDir/mdDir for cross-outliner paste detection
- MD Editor: `sidePanelAssetContext` message provides absolute paths to side panel editors
- MD Editor: `pasteWithAssetCopy` / `pasteWithAssetCopyResult` message flow for host-side file copy + path rewrite

## [0.195.673] - 2026-04-13

### Added
- MD Editor: Image double-click opens fullscreen lightbox overlay (same as outliner)

### Changed
- MD Editor: Code block buttons (expand, language, copy) repositioned to top-right with compact styling, no text overlap

## [0.195.664] - 2026-04-13

### Added
- Outliner: File attachment — "Import any files..." menu imports files of any type as 📎 file nodes
- Outliner: File node display — 📎 icon, editable text, child nodes, Open File / Remove File context menu
- Outliner: `filePath` field in .out schema — backward compatible, mutually exclusive with `isPage`
- Outliner: `fractal.outlinerFileDir` setting — configurable file directory (default `./files`)
- Outliner: Copy/paste file nodes duplicates physical files (same pattern as page/image assets)
- Outliner: "Set file directory..." menu item for standalone outliner
- MD Editor: File drag & drop — non-image files copied to file directory, inserted as `[📎 filename](path)` link
- MD Editor: File link click opens with OS default application (via `vscode.env.openExternal`)
- MD Editor: `fractal.fileDefaultDir` and `fractal.forceRelativeFilePath` settings
- MD Editor: Side panel MD supports file D&D (standalone outliner + notes mode)
- MD Editor: Side panel word count display added
- Cleanup: Extended alive set to track `node.filePath` references and `[📎](path)` MD links
- Cleanup: Orphan file detection in files/ directories with `$(file)` icon in QuickPick

### Changed
- Non-MD local file links now open with OS default app (`vscode.env.openExternal`) instead of VS Code text editor
- Sidebar image/file directory display simplified to single line (removed source label and settings button)

### Removed
- Per-file MD footer directives: IMAGE_DIR, FORCE_RELATIVE_PATH, FILE_DIR, FORCE_RELATIVE_FILE_PATH
- Per-file settings button (⚙ gear icon) from sidebar for both image and file directory

## [0.195.646] - 2026-04-12

### Added
- Notes: "Clean Unused Files" command — scans all registered notes for orphan .md and images, shows QuickPick with select-all/deselect-all, moves to trash
- Notes: "Clean Unused Files (Current Note)" command — same but limited to the currently open note
- Notes: Tools tab replaces S3 tab — contains S3 Sync section and Clean Notes section with both cleanup buttons
- Notes: Startup migration (schemaVersion) — automatically deduplicates shared images on .out open (one-time, idempotent)
- Notes: `path-safety.ts` — path traversal protection for all file operations
- Notes: `cleanup-core.ts` — VSCode-independent cleanup logic for unit testing

### Fixed
- Notes: Remove Page (undo bug) — .md file is no longer physically deleted on "Remove Page", preserving Undo/Redo integrity. Orphan .md is cleaned up via cleanup command instead
- Notes: `notes-file-manager.deleteFile()` now uses `vscode.workspace.fs.delete({ useTrash: true })` instead of `fs.unlinkSync` / `fs.rmSync` — deleted files go to OS trash and can be restored
- Notes: Cleanup correctly resolves `node.images[]` paths relative to outDir (was incorrectly using pageDir, causing alive images to be detected as orphan)

### Changed
- Notes: S3 tab renamed to "Tools" (en) / "ツール" (ja), now contains both S3 sync and cleanup features
- Internal: New `notesCleanupCommand.ts` for 2-pass cleanup (orphan .md → orphan images via transitive closure)
- Internal: `NotesFolderProvider.getFolders()` used for all-notes cleanup mode

## [0.195.641] - 2026-04-11

### Added
- Editor: Link insertion (Cmd+/ → link) now works in Notes and Outliner side panel editors (previously only worked in standalone .md editor)

### Fixed
- Outliner: Cross-outliner page node copy/paste now works within the same note folder (was broken since 0.195.623)
- Outliner: Copy now creates independent image copies with new filenames (was sharing references)
- Outliner: Cut/paste across notes now correctly moves .md and image files
- Outliner: File identity detection uses absolute path instead of fragile relative pageDir string

### Changed
- Internal: New paste-asset-handler.ts for unified copy/move with image rename + .md body rewrite
- Internal: Identity-based outFileKey propagated through Outliner.init and updateData

## [0.195.637] - 2026-04-11

### Fixed
- Editor/Outliner: Image paths and URLs containing parentheses `()` now display correctly (e.g., `photo_(v2).png`, Wikipedia URLs)
- Outliner: Pasting a URL with `()` (e.g., `https://en.wikipedia.org/wiki/Foo_(bar)`) now creates a single complete link instead of breaking at the first `)`
- Import md files: Images with `()` in filename are now correctly imported

### Changed
- Internal: New balanced-paren Markdown link parser (`markdown-link-parser.js`) replaces all regex-based `([^)]+)` patterns across editor, outliner, import, and paste

## [0.195.634] - 2026-04-10

### Fixed
- Outliner: Cross-outliner page node copy/paste now works for all scenarios (same outliner, different outliner in same note, and different note)
- Outliner: Cross-outliner page node cut/paste now correctly moves .md and image files between folders
- Outliner: Images attached to page nodes are now physically copied with new filenames on paste (previously shared references)
- Outliner: .md body image references are rewritten to the new filenames on copy so the duplicated page is fully independent
- Outliner: File identity is now compared by absolute path, fixing a subtle mis-classification where two notes sharing the default `./pages` directory were treated as the same file

### Changed
- Internal: Consolidated `copyPageFile` / `copyPageFileCross` into a single host API
- Internal: Extracted shared paste asset helpers (`paste-asset-handler.ts`) and markdown image utility (`markdown-image-utils.ts`)

## [0.195.621] - 2026-04-08

### Fixed
- Outliner: Multi-select Tab now preserves relative hierarchy instead of cascading siblings into deeper nesting (symmetric fix to the Shift+Tab fix from 0.195.607)
- Outliner: Enter on a node with expanded children now inserts a sibling immediately below, transferring the children to the new node (was inserting as a child or below the child subtree)
- Outliner: Enter at the start of a non-empty node now inserts an empty sibling above, keeping the current node's text and children intact

## [0.195.619] - 2026-04-08

### Fixed
- Notes Search: Markdown jump now works for ALL result types — outline node jump, side-panel open, and in-page keyword scroll all work end-to-end
- Notes Search: Fixed false "未リンクページ" results that were unjumpable; results now only include pages owned by the outline's nodes
- Notes Search: Closing the side panel no longer resets the outliner cursor to the top node
- Notes Search: Keyword jump now works inside markdown links `[text](url)` (URL part is ignored)
- Notes Search: Image syntax `![alt](url)` is excluded from search to keep occurrence indices consistent
- Notes Search: Multi-hit markdown files now correctly jump to the Nth occurrence (not always the first)

### Changed
- Notes Search: Markdown jump uses keyword-based DOM TreeWalker scrolling instead of raw line numbers (works for tables, lists, and inline-formatted lines)
- Notes Search: Markdown result headers fall back to `node.text → first heading → pageId prefix` when node text is empty

## [0.195.612] - 2026-04-07

### Fixed
- Notes Search: Clicking a result now correctly scrolls the target node to the center, even for image-heavy nodes

### Changed
- Notes Search: Results are now grouped into "Outliner results" and "Markdown results" sections with themed colors
- Notes Search: Markdown results now show the parent node name (e.g. `OutlineTitle / NodeName`) instead of the page id

## [0.195.607] - 2026-04-05

### Added
- Outliner: Cross-outliner copy/paste now preserves pages(.md) and images across different outliners

### Fixed
- Outliner: Backspace on empty node with children no longer deletes children — they are promoted to parent level
- Outliner: Multi-select Shift+Tab now preserves relative hierarchy instead of flattening all nodes
- Outliner: Multi-select Tab/Shift+Tab skips operation if topmost node cannot be indented/outdented
- Outliner: Single node copy (Cmd+C without selection) now preserves page/image metadata

## [0.195.603] - 2026-04-03

### Added
- In-App Link: Copy link to specific Outliner node (right-click menu in Notes mode)
- In-App Link: Copy link to specific page/md (sidepanel header button in Notes mode)
- In-App Link: Click fractal:// links to navigate across notes, outliners, and pages
- Markdown Editor: Right-click context menu with Cut, Copy, Paste (all editors)

## [0.195.581] - 2026-04-02

### Added

- **Outliner: ページパスコピー機能** — ページノードの右クリックメニューに「Copy Page Path」を追加。`Cmd+Shift+C` ショートカットにも対応。複数ノード選択時は全ページノードのパスを改行区切りでコピー

## [0.195.580] - 2026-04-02

### Changed

- **フォントサイズのデフォルトを 16px → 14px に変更** — `fractal.fontSize` の初期値を変更。既存ユーザーは設定で任意のサイズに変更可能
- **コンテンツ領域のサイズをフォントサイズに連動** — Outliner/Notes のノード高さ・行高さ・インデント、Markdown のコードブロック・ソースエディタが `fractal.fontSize` の変更に自動追従するよう em 相対指定に移行

### Fixed

- **Outliner/Notes: フォントサイズ設定が反映されないバグを修正** — `fractal.fontSize` を変更しても Outliner/Notes エディタのフォントサイズが 16px 固定のままだった問題を修正
- **テストビルドスクリプト: CSS変数の値が不正になるバグを修正**

## [0.195.579] - 2026-04-02

### Added

- **Outliner: .mdファイル取り込み** — ⋮メニューの「Import .md files...」からMarkdownファイルを選択し、ページノードとして一括取り込み。H1テキストでノード名自動決定、画像のコピー＆パス書き換え、複数ファイル同時対応。Standalone/Notes両対応

### Fixed

- **Markdown: ペースト時の不要なエスケープ文字を除去** — リッチテキストソースからペースト時、`## 1\. サービス概要` のように不要なバックスラッシュが挿入される問題を修正

## [0.195.576] - 2026-04-02

### Added

- **Outliner: リンククリック対応** — `[text](url)` 形式のMarkdownリンクをクリックで外部ブラウザで開けるように
- **Outliner: URLペースト自動変換** — URLをペーストすると自動的に `[URL](URL)` 形式に変換（単一行・複数行対応）
- **Outliner: 複数ノード選択インデント** — 複数ノード選択状態でTab/Shift+Tabにより一括インデント/デインデント

### Fixed

- **Outliner: ペースト時の空行ノード作成を抑制** — テキストペースト時に空行が不要なノードとして作成される問題を修正
- **Outliner: 複数選択Tab後の連続操作** — Tab/Shift+Tab実行後もフォーカスと選択状態を維持し、連続操作を可能に

## [0.195.575] - 2026-04-02

### Added

- **Outliner: .mdファイルのD&D取り込み** — Finder/Explorer/VSCode ExplorerからMarkdownファイルをOutlinerツリーにドラッグ&ドロップして、ページノードとして一括取り込み。H1テキストでノード名を自動決定、画像のコピー＆パス書き換え、複数ファイル同時対応。Standalone/Notes両対応

## [0.195.574] - 2026-04-02

### Fixed

- **Markdown: ペースト時の不要なエスケープ文字を除去** — リッチテキストソース（Notion、ブラウザ等）からペーストした際、`## 1\. サービス概要` のように不要なバックスラッシュが挿入される問題を修正

## [0.195.573] - 2026-04-02

### Added

- **Markdown: セル内改行テーブルのペースト対応** — セル内に生の改行を含むMarkdownテーブルをペーストした際、自動的に改行をに変換してテーブルとして正しく表示。Notion等の平坦化テーブル（`|  |` 行区切り）にも対応

## [0.195.570] - 2026-04-01

### Fixed

- **Outliner: 画像付きノードのコピー/カット** — 画像付きノードを単一行でコピー/カットして貼り付けると画像が消失する問題を修正

## [0.195.569] - 2026-04-01

### Added

- **Outliner: ノード画像機能** — Cmd+Vでノードに画像を貼り付け、サムネイルとして表示。ドラッグ&ドロップで並べ替え、ダブルクリックで拡大表示。Delete/Backspaceで削除
- **Outliner: 画像保存先設定** — `fractal.outlinerImageDefaultDir` 設定追加。.outファイルごとの個別設定も可能。Notes modeではMDページ画像と同じフォルダに自動保存
- **Outliner: コピー/カット時の画像保持** — Cmd+C/Xでノードをコピー/カットした際、画像パスも内部クリップボードで保持

### Fixed

- **Outliner: 画像ペースト時のファイル名重複** — 2枚目以降の画像が1枚目に見える問題を修正

## [0.195.566] - 2026-04-01

### Fixed

- **Outliner: Undo/Redo根本修正** — ファイル切替後にundo/redoが効かない、テキスト入力でundoスナップショットが作られない、初期状態でundoボタンがactiveになる等の複数バグを修正
- **Notes: Sidepanel Markdown編集中のUndo分離** — sidepanel markdown編集中にCmd+Zを押してもoutliner側のundoが発火しないよう修正

### Added

- **Outliner: Scope検索インジケーター** — scope in中に検索ボックスのplaceholderが「Search in scope」に変わり、スコープ内検索であることを明示
- **Outliner: コピー時HTML形式対応** — 複数ノード選択してCmd+Cした内容をsidepanel markdownにCmd+Vすると、階層構造を保ったMarkdownリストとして貼り付け可能

## [0.195.563] - 2026-03-31

### Fixed

- **Side Panel: toolbarMode setting ignored in Outliner/Notes** — `fractal.toolbarMode: "simple"` setting was not applied when opening the side panel markdown editor from Outliner or Notes. The toolbar always showed in full mode.

## [0.195.555] - 2026-03-31

### Fixed

- **Outliner: Shift+↑/↓初回選択修正** — 初回押下で2行選択されていた問題を修正し、自行のみ選択するように変更
- **Outliner: ページノードのクリップボード操作** — 複数行選択のcmd+c/x→cmd+vでページ属性が消失する問題を修正。カットは移動扱い、コピーは新pageId発行+mdファイル複製
- **Outliner: メニュードロップダウン位置** — 検索バーのメニューボタンのフロートメニューがボタン直下ではなく画面右端に表示されるバグを修正

### Changed

- **Outliner: 選択色をオレンジ系に変更** — 行選択・テキスト範囲選択の色をオレンジ系に変更し、フォーカス行の水色と区別しやすく

## [0.195.554] - 2026-03-30

### Fixed

- **Outliner: ノード追加位置の保存バグ修正** — Enter/Option+Enterで追加したノードが、ファイル再読み込み時に親の末尾に移動する問題を修正
- **Outliner: 不要なフォールバックコード削除** — deserialize時の旧形式互換コードを削除しコードを整理

## [0.195.551] - 2026-03-30

### Added

- **複数パネル間同期** — 同じファイルを複数タブで開いて編集した場合、変更がリアルタイムに反映される（Markdown/Outliner/Notes全エディタ対応）
- **外部変更検知** — 外部プロセス（テキストエディタ、Claude等）からの変更をOutliner/Notesエディタに反映
- **編集中ガード** — 編集中の外部変更をキューし、1.5秒アイドル後にフォーカス保持で適用
- **Notes構造同期** — フォルダ作成/削除/名前変更/移動が複数パネル間で同期

## [0.195.541] - 2026-03-29

### Added

- **Perplexityテーマ: シンタックスハイライト** — コードブロックに13色のカラーパレットを追加

### Fixed

- **水平線(---)の入力** — `---` がリスト項目として処理される場合があったバグを修正

### Changed

- **HostBridge共通メソッド抽出** — 4つのブリッジファイルの重複コードを `sidepanel-bridge-methods.js` に一元化

## [0.195.539] - 2026-03-26

### Added

- **Copy Pathボタン** — ツールバー右端とサイドパネルヘッダーに、編集中ファイルのパスをクリップボードにコピーするボタンを追加

### Changed

- **サイドパネルHTML共通化** — 4箇所に重複していたサイドパネルHTMLを `generateSidePanelHtml()` に一元化

## [0.195.536] - 2026-03-26

### Fixed

- **Outliner/Notes: CSS変数の不整合修正** — 未定義だったCSS変数を全7テーマに追加し、ハードコード色をCSS変数化
- **Electron: i18n英語フォールバック追加** — ロケールファイル未検出時に英語にフォールバック

## [0.195.526] - 2026-03-25

### Added

- **Outliner: Undo/Redoボタン** — 検索バーにUndo/Redoボタンを追加、スタック状態に応じたdisabled制御

### Changed

- **Outliner: Scope-in時のカーソル位置改善** — スコープヘッダーのテキスト末尾にカーソルを配置
- **Notes: Daily Notes空ノード自動追加を削除** — スコープ空状態UIで代替
- **Outliner: Shift+Tabのスコープ境界制限** — スコープ対象ノードの子レベルを超えてデインデントしないよう制限

### Fixed

- **Outliner: ファイル切替時のデータ上書きバグを修正** — undo/redoスタックのクリア漏れによるデータ消失を防止
- **Outliner: フォーカスモード検索がスコープ外のノードを表示するバグを修正**
- **Outliner: テキスト全選択状態でのBackspace動作を修正** — 前行マージではなくテキスト削除に

## [0.195.517] - 2026-03-24

### Changed

- **Outliner: Scope Inアイコン変更** — ターゲット/照準アイコンに変更し、ノード展開との誤解を防止
- **Notes: ページタイトル設定対応** — `outlinerPageTitle`設定がtrueの場合、Notesモードでもタイトル表示

### Fixed

- **Outliner: 検索時に折り畳み親が展開されないバグを修正**
- **Outliner: IME変換中に検索が発動するバグを修正**

## [0.195.516] - 2026-03-24

### Added

- **Notes: Scope Inホバーアイコン** — アウトライナ各ノードのバレット左にホバー時表示されるScope Inアイコンを追加
- **Notes: Daily Notes空ノード自動追加** — Daily Notesで日付にScope in時、子ノードがなければ空ノードを自動追加

### Changed

- **Notes: 左パネルタブ整理** — Todayタブを廃止しアクションバーにTodayボタンを移動。Folder/Outlineボタンをアイコンのみに簡素化

### Fixed

- **Notes: 左パネル開閉ボタンが効かないバグを修正**
- **Notes: ファイル切替が時々効かないバグを修正**

## [0.195.515] - 2026-03-24

### Added

- **Notes: タブナビゲーション** — 左パネルをNotes/Search/Todayの3タブ構成に刷新
- **Notes: Daily Notesナビバー** — アウトライナ側にToday/前日/翌日/カレンダー日付ピッカーを表示（dailynotes.out表示時のみ）
- **Notes: MD検索結果ジャンプ** — フル検索で.mdファイルの結果クリック時、親アウトラインを表示しサイドパネルで該当行にスクロール

### Fixed

- **Notes: ファイル切替時にアウトライナの検索・スコープ状態が残るバグを修正**
- **Notes: フル検索が間欠的に0件になるバグを修正**

## [0.195.514] - 2026-03-24

### Added

- **Notes: フル検索** — 全.out/.mdファイルを横断検索。Match Case/Whole Word/Regex対応。結果クリックでノードにジャンプ＋ハイライト
- **Notes: Daily Notes** — Todayボタンで今日のノードを自動作成（年→月→日階層）。`< >`ボタンで前日/翌日ナビゲーション
- **Notes: 左パネル幅リサイズ** — D&Dでパネル幅を変更可能。幅はoutline.noteに保存され次回復元
- **Notes: サイドパネル幅リサイズ** — D&Dでサイドパネル幅を変更可能。Outlinerでは.outに永続化、Markdownではセッション内のみ
- **Notes: outline.noteリネーム** — 管理ファイルを`.note`から`outline.note`に変更（自動マイグレーション付き）

## [0.195.513] - 2026-03-24

### Added

- **Notes: フォルダ/ツリー管理** — 左パネルで仮想フォルダを作成し、アウトラインをフォルダで分類・管理可能に。D&Dでファイルやフォルダの並び替え・移動が可能

### Fixed

- **Notes: ファイル切替時にアウトラインデータが消失するバグを修正** — 入力中にファイルを切り替えると未保存データが失われる問題を修正

## [0.195.509] - 2026-03-23

### Fixed

- **Notes: Outlinesヘッダーと検索バーの高さを統一** — 左パネルヘッダーと検索バーの数pxの高さズレを修正

## [0.195.506] - 2026-03-23

### Added

- **Notes機能（VSCode Activity Bar）** — Activity Barからフォルダを登録し、複数の.outアウトラインをまとめて管理できる新機能。左パネルでファイル一覧表示・追加・削除・リネーム・切替が可能。Electron版と同等の体験をVSCode上で実現

### Improved

- **Notes: 空フォルダ追加時にdefaultアウトラインを自動作成** — 空のフォルダを追加しても即座に編集開始可能
- **Notes: Set page directoryメニューを非表示** — Notes modeではpageDirが自動管理されるため手動設定を無効化
- **Notes: パネル閉じ時のUIレイアウト修正** — トグルボタンと検索モードボタンが重ならないよう調整

## [0.195.504] - 2026-03-23

### Improved

- **Outliner: スコープアウト時のカーソル位置改善** — Cmd+Shift+]やTOPリンクでスコープ解除した際、直前にスコープしていたノードにカーソルが移動するようになりました

## [0.195.502] - 2026-03-23

### Fixed

- **Outliner: ページディレクトリ設定が編集で消失するバグを修正** — outファイル個別に設定した `pageDir` が、ノード編集のたびに消えてしまう問題を修正しました

### Added

- **Outliner: メニューボタン** — 検索バー右端にメニューボタン（⋮）を追加。ページディレクトリの設定が可能です

## [0.195.500] - 2026-03-22

### Improved

- **Outliner: ページ解除でファイルをゴミ箱に移動** — ページ解除時に対応する `.md` ファイルをOSのゴミ箱に移動するようになりました。誤操作時はゴミ箱から復元できます

## [0.195.483] - 2026-03-22

### Fixed

- **Image paste/D&D paragraph separation** — Consecutive image pastes into empty paragraphs now create separate paragraphs instead of concatenating into one line

## [0.195.475] - 2026-03-22

### Changed

- **Internal: SidePanelManager shared class** — Extracted duplicated side panel logic (file watcher, save, link handling, TOC) from both editor and outliner providers into a single shared class

## [0.195.468] - 2026-03-21

### Added

- **Outliner: Breadcrumb navigation** — Shows ancestor chain above search bar when scoped; click any ancestor to re-scope, click TOP to return to full document
- **Outliner: Scope keyboard shortcuts** — Cmd+] to scope into focused node, Cmd+[ to clear scope
- **Outliner: Scope context menu** — Right-click "Scope" and "Clear Scope" options
- **Outliner: Tag click search** — Click a #tag or @tag on a non-focused node to auto-search
- **Outliner: 7 theme support** — github, sepia, night, dark, minimal, things, perplexity themes now applied to outliner
- **Outliner: i18n support** — 7 languages (en, ja, ko, es, fr, zh-cn, zh-tw) for all outliner UI strings
- **Outliner: Page directory setting** — `fractal.outlinerPageDir` setting + per-file override via mmd JSON `pageDir` field
- **Outliner: Page display constraints** — Pages opened from outliner have forced image directory and hidden addPage feature

### Fixed

- **Outliner: ESC clears scope** — ESC now only clears search, not scope
- **Outliner: Search clear resets scope** — Empty search or clearSearch no longer resets scope
- **Outliner: Scope becomes stale after node deletion** — Added safety checks on all 5 node deletion paths

## [0.195.466] - 2026-03-21

### Fixed

- **Markdown: Block pattern conversion fails with existing text** — Typing input patterns (##, [ ], -, 1., >) at the beginning of a line with existing text and pressing space now correctly converts the block

## [0.195.464] - 2026-03-21

### Fixed

- **Outliner: Cmd+B toggles VSCode sidebar** — Added stopPropagation to prevent Cmd+B/I/E/Shift+S from triggering VSCode shortcuts
- **Outliner: **`**text*`** incorrectly rendered as italic** — Fixed italic regex to not match `*` that is part of `**` bold markers
- **Outliner: Cursor jumps to end after inline formatting** — Fixed offset mismatch between rendered text and source text by separating editing mode (raw markers) and display mode (formatted)
- **Outliner: Enter splits text incorrectly with inline markers** — Same root cause as cursor jump; editing mode now uses source text offsets directly

## [0.195.463] - 2026-03-21

### Added

- **Outliner: Search mode toggle** — Toggle between Tree mode (shows ancestors to root) and Focus mode (shows matched node as top + children only)
- **Outliner: Inline formatting shortcuts** — Cmd+B (bold), Cmd+I (italic), Cmd+E (code), Cmd+Shift+S (strikethrough) for outliner text

## [0.195.449] - 2026-03-21

### Fixed

- **Outliner: Tag escape requires two spaces** — Fixed `#tag`/`@tag` requiring two Space presses to escape and insert a space (now works in one press)

## [0.195.435] - 2026-03-17

### Fixed

- Fixed code block Copy button losing line breaks when copying to clipboard

## [0.195.433] - 2026-03-16

### Fixed
- **Image in list item treated as empty** — Fixed Enter/Backspace on list items containing only images incorrectly treating them as empty (outdenting instead of creating new sibling).
- **Image paste misalignment in lists** — Fixed pasted images appearing visually offset from the bullet due to a trailing  element.
- **Image bullet disappears in lists** — Fixed list bullet (marker) disappearing for list items containing images due to `display: block` on images.

## [0.195.432] - 2026-03-15

### Fixed
- **Redo after immediate undo** — Fixed redo not working when undoing immediately after typing (before debounce timer fires).

## [0.195.420] - 2026-03-15

### Added
- **Side panel toolbar** — The side panel editor now has a full toolbar (undo/redo, formatting, block elements, insert) matching the main editor.

### Fixed
- **Undo/redo button state in side panel** — Undo/redo buttons in the side panel now correctly reflect the stack state.
- **Dead code cleanup** — Removed obsolete iframe-based side panel code (side-panel-host-bridge.js, getSidePanelHtml, generateSidePanelHtml).

## [0.195.416] - 2026-03-15

### Fixed
- **Side panel image path corruption** — Images inserted via D&D in the side panel no longer save with `vscode-resource` URI prefixes in the markdown.
- **Side panel Cmd+V paste** — Text and image paste now works correctly in the side panel editor.

## [0.195.411] - 2026-03-15

### Added
- **Electron: Welcome screen** — Opening the Electron app without a file now shows a welcome screen with Open File, Create New File, and Recent Files options.

### Fixed
- **Side panel image operations** — Image paste (Cmd+V), drag & drop, and toolbar image insert now work correctly in the side panel editor (both VSCode and Electron).
- **Side panel "Open in new tab" button** — The button now properly closes the side panel after opening the file in a new tab (both VSCode and Electron).
- **Electron: Side panel not opening** — Fixed packaged Electron app (DMG) missing `side-panel-host-bridge.js`, which prevented the side panel from loading.
- **Electron: Action Panel root directory issue** — Opening Electron without a file no longer causes Action Panel to operate on the root directory.

## [0.195.410] - 2026-03-14

### Added
- **Electron: Side Panel support** — Clicking `.md` links in the Electron desktop app now opens them in a Notion-style side panel with full WYSIWYG editing, external change detection, and in-panel navigation.
- **Electron: Action Panel support** — Cmd+N page creation with file search autocomplete now works in the Electron desktop app.
- **Electron: Smart link handling** — `.md` links open in side panel, HTTP links open in browser, anchor links scroll within document.

## [0.195.409] - 2026-03-13

### Added
- **Action Panel (Add Page)** — Cmd+N or command palette "Add Page" to quickly create and link new Markdown pages. Two modes: auto-create in pages/ folder, or specify a path with autocomplete.

### Fixed
- **Action Panel hover/keyboard conflict** — Mouse hover and keyboard arrow keys now share a single active selection instead of showing two highlights.
- **Action Panel click support** — Menu items, path input confirm, and link name confirm now work with mouse click (not just Enter).
- **Action Panel IME support** — IME composition Enter no longer prematurely confirms link name input.
- **New page h1** — New files use the link name as h1 heading (not the filename). Existing files are not modified.
- **Japanese localization** — Action panel menu items properly localized.

## [0.195.402] - 2026-03-13

### Fixed
- **Side panel overwrites external changes** — Fixed a bug where the side panel would overwrite external file modifications (e.g., from Claude Code) with stale content, even when the user hadn't edited in the side panel.

## [0.195.401] - 2026-03-13

### Fixed
- **Side panel external change detection** — Files opened in the side panel now reflect external changes in real-time, matching the main editor's behavior.

## [0.195.396] - 2026-03-06

### Added
- **Notion-style side panel** — Clicking a `.md` link opens a fully functional side panel with complete WYSIWYG editing (undo/redo, code blocks, Mermaid, Math, all keyboard shortcuts). Powered by iframe-based architecture for full editor isolation.
- **Link open mode setting** — `fractal.linkOpenMode`: `"sidePanel"` (default) for Notion-style peek, `"tab"` for new editor tab.
- **Cmd+Click always opens in new tab** — Hold Cmd (Mac) or Ctrl (Windows/Linux) while clicking a link to always open in a new tab, regardless of settings.
- **Side panel link navigation** — Links clicked inside the side panel navigate within the same panel.

## [0.195.393] - 2026-03-05

### Changed
- **Shared editor body HTML** — Sidebar, toolbar, editor, and search box HTML generation is now shared between VSCode and Electron via a single source module (`editor-body-html.js`). This ensures Electron always stays in sync with VSCode UI changes.

### Fixed
- **Electron sidebar** — Image directory settings UI (gear button, path display) now appears in the Electron sidebar, matching the VSCode version.

## [0.195.392] - 2026-03-05

### Changed
- **Toolbar fixed left/right layout** — Outline, undo, redo buttons are now fixed on the left; open-in-text-editor and source-mode buttons are fixed on the right. Only the markdown formatting buttons (inline, block, insert) scroll when the toolbar overflows.

## [0.195.388] - 2026-03-05

### Fixed
- **Perplexity/Things theme font size** — User font size setting now applies correctly to Perplexity and Things themes (previously hardcoded to 16px/15px). All element sizes (headings, code, tables, etc.) scale proportionally.

## [0.195.387] - 2026-03-04

### Added
- **Electron auto-update notification** — The desktop app now checks for new versions via GitHub Releases API (every 24 hours) and shows a notification dialog with a link to download.
- **"Check for Updates..." menu item** — Added to the Help menu for manual update checks.
- **GitHub Actions release automation** — Pushing an `electron-v*` tag automatically builds and publishes for macOS (arm64 + x64), Windows, and Linux.

### Changed
- **Unified versioning** — VSCode extension and Electron app now share the same version number.

## [0.195.386] - 2026-03-04

### Changed
- **Default theme** — Changed default theme from "GitHub" to "Things" for both VSCode and Electron.

## [0.195.385] - 2026-03-04

### Changed
- **Things theme** — Made sidebar border color subtler to better match outline background.

## [0.195.382] - 2026-03-04

### Changed
- **Outline panel design** — Refined border colors, removed header underline, increased padding for better readability.

### Fixed
- **Outline scroll stuck after click** — Clicking an outline heading no longer causes the editor to become unscrollable.

## [0.195.376] - 2026-03-04

### Added
- **Mermaid/Math toolbar & palette buttons** — Added dedicated toolbar buttons and command palette items for inserting Mermaid diagrams and Math blocks directly, without needing to type ````` ```mermaid ````` or ````` ```math `````.

## [0.195.375] - 2026-03-04

### Fixed
- **Code block language change to mermaid/math** — Selecting "mermaid" or "math" from the code block language selector now correctly creates a clickable special wrapper that enters edit mode on click.

## [0.195.374] - 2026-03-04

### Changed
- **Toolbar default mode is now **`simple` — With the Action Palette (`Cmd+/`) available, the toolbar defaults to simple mode. Set `"fractal.toolbarMode": "full"` to restore the full toolbar.
- **Open in Text Editor shortcut changed** — `Cmd+,` / `Ctrl+,` → `Cmd+Shift+.` / `Ctrl+Shift+.` to avoid conflict with VS Code's Settings shortcut. Now paired with `Cmd+.` (Source Mode toggle).
- **README redesigned** — Added Important Changes section, fixed incorrect shortcut documentation, added emoji to section headings, updated screenshots.

## [0.195.368] - 2026-03-03

### Added
- **Simple Toolbar Mode** — New `fractal.toolbarMode` setting with `"full"` (default) and `"simple"` options. Simple mode shows only undo/redo and utility buttons (open text editor, source mode toggle) with a transparent background and no dividers. Use Cmd+/ (command palette) for other operations.

## [0.195.367] - 2026-03-03

### Fixed
- **ArrowUp skips wrapped lines in long paragraphs** — Fixed floating-point comparison in cursor line detection that caused wrapped lines to be skipped when pressing ↑
- **ArrowUp from below enters paragraph at first line instead of last line** — Fixed soft-wrapped paragraph navigation to correctly place cursor at the start of the last visual line

## [0.195.359] - 2026-03-03

### Changed
- **Keyboard shortcuts**: Toggle Source Mode changed to `Cmd+.` / `Ctrl+.`, Open in Text Editor changed to `Cmd+,` / `Ctrl+,`
- **Toolbar tooltips**: Shortcut keys now shown on hover for Source Mode and Text Editor buttons

## [0.195.358] - 2026-03-02

### Fixed
- **Nested list items lost or empty bullets remain after range-selecting and pressing Backspace** — Fixed by promoting nested list children to parent list before removing empty items, preserving child content without leaving empty bullets

## [0.195.356] - 2026-03-02

### Fixed
- **Empty bullets remain after range-selecting nested list items and pressing Backspace** — Fixed empty `<li>` elements (bullets) remaining in the DOM when selecting multiple list items and pressing Backspace

## [0.195.353] - 2026-03-01

### Fixed
- **Backspace on nested list item moves child items to wrong position** — Fixed child list items (c) incorrectly appearing below sibling items (d) after merging a nested item into its parent

## [0.195.352] - 2026-03-01

### Fixed
- **Shift+Tab on top-level list item moves item to wrong position** — Fixed paragraph ending up at the bottom of the list when pressing Shift+Tab on a middle list item; the paragraph now stays in its original visual position

## [0.195.351] - 2026-03-01

### Fixed
- **Code block language lost when pasting from Shiki-based sites** — Fixed code blocks losing language tags when pasting from sites using Shiki syntax highlighting (e.g. code.claude.com)

## [0.195.350] - 2026-03-01

### Fixed
- **Broken links when pasting HTML** — Fixed multi-line markdown links produced when pasting HTML containing block elements inside `<a>` tags (e.g. from Claude Code Docs)

## [0.195.349] - 2026-03-01

### Added
- **Keyboard shortcuts** — Toggle Source Mode (`Cmd+/` / `Ctrl+/`) and Open in Text Editor (`Cmd+.` / `Ctrl+.`)

## [0.195.348] - 2026-03-01

### Fixed
- **Placeholder not clearing on paste** — Fixed placeholder text remaining visible after pasting content (CMD+V) into an empty editor

## [0.195.345] - 2026-02-27

### Fixed
- **Perplexity theme syntax highlighting** — Fixed code block keywords (function, const, etc.) being invisible due to highlight colors too similar to base text color

## [0.195.342] - 2026-02-27

### Fixed
- **Empty editor placeholder** — Fixed placeholder text ("Start typing...") not showing when opening a new or empty markdown file

## [0.195.341] - 2026-02-27

### Fixed
- **Blockquote backspace line splitting** — Fixed issue where pressing Backspace at the start of a multi-line blockquote produced a single paragraph with embedded newlines instead of separate paragraphs for each line
- **Code block backspace at start** — Fixed issue where pressing Backspace at the start of a non-empty code block could delete the element above it

## [0.195.340] - 2026-02-27

### Fixed
- **Tab indent with mixed nested lists** — Fixed issue where Tab indent changed visual line order when the previous sibling had multiple nested lists of different types (e.g., `<ul>` + `<ol>`)

## [0.195.336] - 2026-02-27

### Changed
- **Perplexity theme typography** — Optimized font sizes (p/li 16px, code/blockquote/table 14px, headings proportional from h3=18px), reduced margins/line-height for higher content density, added text underline decoration to h2

## [0.195.335] - 2026-02-27

### Added
- **Multi-line Tab/Shift+Tab in code blocks** — Select multiple lines with Shift+Arrow and press Tab/Shift+Tab to indent/dedent all selected lines at once
- **Multi-line Tab/Shift+Tab in blockquotes** — Same multi-line indent/dedent support in blockquote blocks

## [0.195.334] - 2026-02-27

### Added
- **Undo/Redo** — `Cmd+Z` / `Cmd+Shift+Z` with snapshot-based undo system (200-entry stack, toolbar buttons)
- **KaTeX Math blocks** — `\`\`\`math` code blocks render LaTeX equations via KaTeX (each line independent, 500ms debounce re-render, error display)
- **Perplexity theme** — Light theme with Perplexity brand colors
- **Multi-block Tab/Shift+Tab** — Select multiple paragraphs and indent/dedent them all at once
- **Code block Shift+Tab** — Dedent (remove up to 4 leading spaces) inside code blocks
- **List type in-place conversion** — Type a different list pattern at line start (e.g., `1. ` in a `- ` list) to convert between unordered, ordered, and task lists (6-way)
- **Cross-list Tab indent** — Tab at first item of a list indents into the last item of an adjacent list above
- **Smart URL paste** — Select text and paste a URL to create `[selected text](URL)` link
- **Code block expand button** — Open code block content in a separate VS Code editor tab with language support
- **Cmd+L source navigation** — Select text in WYSIWYG editor, press `Cmd+L` to open the source file with exact lines selected
- **External file change sync** — Block-level DOM diff preserves cursor position; toast notification for reload confirmation
- **Toolbar scroll navigation** — `<` `>` buttons for horizontal toolbar scrolling when overflowing
- **Toolbar icon buttons** — Toolbar buttons now use icons instead of text
- **Export to PDF** command

### Changed
- Sync architecture rewritten with block-level DOM diff and edit state machine (idle/user-editing/external-updating)
- Cursor restoration uses text-based block identification for better accuracy
- Arrow key navigation between elements unified via `navigateToAdjacentElement()` function
- Mermaid/Math blocks share common helper functions (`isSpecialWrapper`, `enterSpecialWrapperEditMode`, `exitSpecialWrapperDisplayMode`)

### Fixed
- Windows `\r\n` line endings now handled correctly
- Numerous arrow key navigation fixes across all element types
- Code block trailing empty line display in display mode
- Mixed nested list Backspace merge and Shift+Tab behavior
- Toolbar buttons now correctly apply formatting at cursor position (Selection save/restore)
- Browser `<div>` generation prevented (uses `<p>` separator)
- Shift+Arrow key range selection no longer blocked by navigation code

## [0.195.186] - 2026-02-17

### Fixed
- Inline code conversion order - `**text**` inside backticks now correctly renders as code instead of bold
- Inline code processing now happens before bold/italic/strikethrough to prevent unwanted formatting

## [0.195.176] - 2026-02-16

### Fixed
- Horizontal rule backspace behavior - empty paragraph after HR now deletes correctly
- Pattern conversion list merge - lists created with `- ` + Space now auto-merge with adjacent lists

## [0.195.162] - 2026-02-15

### Fixed
- Tab/Shift+Tab cursor restoration in nested lists
- List merge behavior - lists now merge at the same level instead of nesting
- Triple-click selection in list items

### Changed
- Improved backspace handling for empty list items with nested content

## [0.195.141] - 2026-02-14

### Fixed
- Backspace in nested lists now correctly moves cursor to the visually previous line
- Deep nested list cursor positioning after merge operations

## [0.195.130] - 2026-02-13

### Added
- Mermaid diagram theme support for dark/night themes
- Diagrams now respect editor theme settings

## [0.195.0] - 2026-02-01

### Added
- Initial public release
- WYSIWYG markdown editing with live preview
- Support for headers, lists, tables, code blocks, blockquotes
- Mermaid diagram rendering
- Multiple themes (github, sepia, night, dark, minimal)
- Multi-language support (en, ja, zh-cn, zh-tw, ko, es, fr)
- Image paste and drag-and-drop support
- Configurable image save directory
- Keyboard shortcuts for common formatting
- Table of contents generation
- Source mode toggle
