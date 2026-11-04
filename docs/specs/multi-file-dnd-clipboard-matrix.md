# 複数ファイルの D&D・cut / copy / paste 対応表

HEAD `bf96db4` 時点のコードを読んで作った表。動かしての確認はしていない（「未実測」と書いた所は Chromium / VS Code の実行時の挙動に依る）。

## 記号と読み方

- 各セルは `単 / 複` の 2 つ。単 = 1 ファイル、複 = 複数選択（md なら複数リンクを含む範囲選択、outliner なら複数 node 選択、ツリー・linkedfd なら複数行選択）。
- `○` 対応 / `△` 一部（制限あり） / `×` 未対応 / `－` 対象外（同時に画面に出ない・面が無い。理由は脚注）。
- 「移動」「複製」は実体（ファイル・page md）の扱い。linkedfd の境界をまたぐときは、host が `crossesLinkedfd` / `crossesLinkedfdBoundary`（`src/shared/linkedfd-boundary.ts`）で判定して常に複製にする（spec 20261027-1556-linkedfd-copy-only）。

## 画面に同時に出る面（D&D が届く組み合わせ）

| 事実 | 根拠 |
|---|---|
| Notes の main pane は md・outliner・linkedfd view のどれか 1 つだけを出す | `src/shared/notes-md-dispatcher.js:53-60`、`src/shared/folder-view-dispatcher.js:74-146` |
| sidepanel は md（と file viewer）だけ。**sidepanel outliner という面は無い** | `src/shared/sidePanelManager.ts:381-400`、`src/webview/outliner.js:9594` |
| linkedfd view から開いた md は sidepanel に出る。linkedfd view と並ぶのは sidepanel md とツリーだけ | `folderViewOpen → openMdInSidePanel` |
| ツリーは常に出ている | — |

よって D&D が実際に届くのは: note md ⇄ sidepanel md、sidepanel md → note outliner、note outliner → sidepanel md、sidepanel md（linkedfd から開いた）⇄ linkedfd view、全ての面 ⇄ ツリー。

脚注（`－` の理由）:
- **P1**: main pane が排他なので同時に出ない（D&D 不可。clipboard なら可）。
- **P2**: sidepanel outliner という面が無い。
- **P3**: linkedfd view は 1 つしか出せない。

---

## 1. 出所 = note md（main pane の md）

| 行き先 | D&D | cmd+c → v | cmd+x → v |
|---|---|---|---|
| 同じ md | 単○ 複△ — DOM 上でアンカーを動かす（移動）。複は掴んだ 1 件だけ動く。選択範囲のドラッグは Fractal の MIME が無く、drop 側が `preventDefault` するので何も起きない | 単○ 複○ — 範囲中の 📎・subpage・画像を全部複製（`pasteWithAssetCopy`） | 単○ 複○ — 同じ note なので md 文字列のまま差し込む（移動） |
| sidepanel md | 単○ 複△ — 同じ note = リンク移動、他 note = 実体を複製して元リンク除去、linkedfd 境界 = 複製（元を残す）。複は掴んだ 1 件 | 単○ 複○ — 複製 | 単○ 複○ — 同じ note = 移動、他 note / linkedfd = 複製（元実体は orphan） |
| note outliner | 単－ 複－（P1） | 単○ 複○ — 行ごとに node 化。1 行が 1 リンクだけなら添付 / page node、文と混ざった行は text node | 単○ 複○ — 同じ note = 参照のまま（移動）、他 note = 複製 |
| sidepanel outliner | －（P2） | －（P2） | －（P2） |
| linkedfd view | 単－ 複－（P1） | 単× 複× — `onDocumentPaste` は md の clipboard を見ない | 単× 複× — 同上。cut でリンクだけ消える |
| ツリー: root / 余白 | 単○ 複△ — subpage = ツリーに登録してリンク除去、📎 = files/ の実体を登録してリンク除去 | 単× 複× — ツリーに paste の処理が無い | 単× 複× — 同上（cut でリンクだけ消える） |
| ツリー: folder 行 | 単△ 複△ — フォルダの中ではなく**兄弟**に入る（中央帯の分岐が無い） | 単× 複× | 単× 複× |
| ツリー: md 行（中央帯） | 単○ 複△ — 対象 md の末尾にリンク行を追記して元リンク除去 | 単× 複× | 単× 複× |
| ツリー: .out 行（中央帯） | 単○ 複△ — root 先頭に page / file node、元リンク除去 | 単× 複× | 単× 複× |
| ツリー: linkedfd 行 | 単○ 複△ — 常に複製（元リンク・実体を残す） | 単× 複× | 単× 複× |
| ツリー: 普通の file 行 | 単○ 複△ — その前後に兄弟として登録 | 単× 複× | 単× 複× |
| OS の Finder / デスクトップ | 単× 複× — DownloadURL・uri-list を積まない。代わりは右クリックの「Export folder」 | 単× 複× — clipboard は文字だけ | 単× 複× |
| 他の VS Code エディタ | 単× 複× — 標準のアンカー文字だけ（未実測）。standalone の Fractal md の host には `attachMdFileLinkToMd` が無い | 単△ 複△ — テキストエディタには相対リンクの md 文字列。standalone の Fractal md / outliner は複製する | 単△ 複△ — 同上（standalone で同じ dir なら移動） |

## 2. 出所 = sidepanel md

表 1 と同じ処理を通る（drop と paste の handler は 1 つで、`findTargetEditor` が出所と行き先を分ける）。違う所だけ書く。

| 行き先 | D&D | cmd+c → v | cmd+x → v |
|---|---|---|---|
| 同じ md | 単○ 複△（表 1 と同じ） | 単○ 複○ | 単○ 複○ |
| note md | 単○ 複△ — 同じ note = 移動、他 note = 実体複製 + 元リンク除去、linkedfd の md = 複製 | 単○ 複○ | 単○ 複○（他 note は orphan が残る） |
| note outliner | 単○ 複△ — drop 位置に page / file node。同じ note = 移動、linkedfd = 複製。複は掴んだ 1 件 | 単○ 複○ | 単○ 複○ |
| sidepanel outliner | －（P2） | －（P2） | －（P2） |
| linkedfd view | 単○ 複△ — 同じ linkedfd の md = 移動（リンク除去 + 元はゴミ箱）、それ以外 = 複製 | 単× 複× | 単× 複× |
| ツリー: root / 余白 | 単△ 複△ — **他 note の md の 📎 は実体を複製せず、名前だけ登録して元リンクを消す（バグ。`treeFileRegisterFromMdLink` に別 note の分岐が無い）**。subpage は正しく複製 | 単× 複× | 単× 複× |
| ツリー: folder 行 | 単△ 複△（兄弟に入る。他 note の 📎 は上と同じバグ） | 単× 複× | 単× 複× |
| ツリー: md / .out / linkedfd / file 行 | 単○ 複△（表 1 と同じ。md / .out 行は `resolveMdFileLinkEntityForNote` が他 note を複製する） | 単× 複× | 単× 複× |
| OS / 他の VS Code エディタ | 表 1 と同じ | 表 1 と同じ | 表 1 と同じ |

## 3. 出所 = note outliner

「複」は node の複数選択（`selectedNodeIds`）。D&D は bullet（node と子孫）・page アイコン・file アイコンの 3 か所から出る。複数選択中はどこを掴んでも `x-fractal-out-node-assets` に `items[]`（添付のある node 全部）が載り、bullet なら `x-fractal-out-node-subtree` に `nodeIds`（選択の根）も載る。

| 行き先 | D&D | cmd+c → v | cmd+x → v |
|---|---|---|---|
| 同じ .out（並べ替え） | 単○ 複○ — bullet だけ。node ごと移動。アイコンを掴むと何も起きない | 単○ 複○ — 構造ごと貼る。page / file / 画像は複製 | 単△ 複○ — 複は移動。**単は `filePath` を消さないので file node は元に 📎 が残る（実質複製）** |
| 他の .out（別タブ） | 単－ 複－（P1。ツリーの .out 行経由なら可） | 単○ 複○ — 複製 | 単△ 複○ — 実体を物理的に移動。単は同上 |
| note md | 単－ 複－（P1） | 単○ 複○ — md のリストにし、page md・file・画像を複製 | 単△ 複△ — 貼る側が cut を見ず**複製する**。cut で元 node は消えているので、元の page md / file が orphan になる |
| sidepanel md | 単○ 複△ — page アイコン = subpage リンク（移動、node は残して page を外す）、file アイコン = 📎（移動、葉 node は消える）、linkedfd の md = 複製。**複は掴んだ 1 件だけ**（md 側が `out-node-assets` を読まない）。bullet を落とすと何も起きない | 単○ 複○ — 複製 | 単△ 複△ — note md と同じ（複製 + orphan） |
| sidepanel outliner | －（P2） | －（P2） | －（P2） |
| linkedfd view | 単－ 複－（P1。受け口のコードはある） | 単△ 複○ — 選択モードのときだけ `nodeIds` が載り書き出される（複製）。カーソルを置いただけの単一 copy は `nodeIds` が無く何も起きない | 単× 複× — cut は `nodeIds` を載せない。元は cut で消えている |
| ツリー: root / 余白 | 単○ 複○ — 移動。添付のある node を表示順に登録、文字だけの node は残る | 単× 複× | 単× 複× |
| ツリー: folder 行 | 単△ 複△ — page アイコンだけ中央帯でフォルダの中、file アイコンと bullet は**兄弟**。子の隙間には file アイコンを落とせない | 単× 複× | 単× 複× |
| ツリー: md 行（中央帯） | 単○ 複○ — md の末尾に 1 行ずつリンクを追記（移動） | 単× 複× | 単× 複× |
| ツリー: .out 行（中央帯） | 単○ 複○ — node の部分木を相手の root 先頭へ移動。アイコンを掴んだときは添付のある node だけ動く（bullet と動く集合が違う） | 単× 複× | 単× 複× |
| ツリー: linkedfd 行 | 単○ 複○ — 書き出し（複製）。元の .out は変えない | 単× 複× | 単× 複× |
| ツリー: 普通の file 行 | 単○ 複○ — 前後に兄弟として登録（移動） | 単× 複× | 単× 複× |
| OS の Finder | 単× 複× | 単× 複× | 単× 複× |
| 他の VS Code エディタ | 単× 複× | 単△ 複△ — node の文字だけ（タブ字下げ） | 単△ 複△ — 同上 |

## 4. 出所 = sidepanel outliner

面が無い（P2）。全セル `－`。

## 5. 出所 = linkedfd view

複数選択の payload は `{v:1, folderLinkId, items:[{relPath,isDir}]}`（フォルダも入る）。clipboard は cmd+c だけで、cmd+x は仕様で無い（linkedfd-copy-only.spec.ts AC-1 が固定）。

| 行き先 | D&D | cmd+c → v | cmd+x → v |
|---|---|---|---|
| 同じ linkedfd view | 単○ 複○ — 移動（同じ linkedfd の中なので境界をまたがない） | 単○ 複○ — 複製（フォルダも） | 単× 複×（仕様: cut 無し） |
| 別の linkedfd | 単× 複×（P3。ツリーの linkedfd 行は下の行） | 単× 複× — 別の folderLinkId は無音で無視 | 単× 複×（仕様） |
| note md | 単－ 複－（P1） | 単× 複× — 相対パスの文字が入るだけ | 単× 複×（仕様） |
| sidepanel md | 単○ 複× — 単は複製（同じ linkedfd の md なら移動）。**複は無音で何もしない**: payload に最上位の `relPath` が無く、`editor.js:20958` の条件を通らずに `return` する。掴んだ 1 件も行かない | 単× 複× — 相対パスの文字だけ | 単× 複×（仕様） |
| note outliner | 単－ 複－（P1。受け口のコードは複に対応） | 単○ 複○ — 選択モード外の node 編集中なら、node の直後に兄弟として複製（フォルダは node の木） | 単× 複×（仕様） |
| sidepanel outliner | －（P2） | －（P2） | －（P2） |
| ツリー: root / 余白 | 単○ 複○ — note へ複製して登録（フォルダも再帰で） | 単× 複× — ツリーに paste が無い。**ツリーにフォーカスがあっても linkedfd view が出ていれば、その paste を linkedfd 側が拾う（誤配送）** | 単× 複×（仕様） |
| ツリー: folder 行 | 単○ 複○ — 中央帯 = フォルダ内の末尾、上下 = 兄弟（複製） | 単× 複× | 単× 複× |
| ツリー: md 行（中央帯） | 単○ 複○ — 対象 md に追記（複製）。フォルダは除外して 1 回通知。**host の件数ゲートが無い** | 単× 複× | 単× 複× |
| ツリー: .out 行 | 単○ 複○ — root 先頭へ取り込む（複製、フォルダは node の木） | 単× 複× | 単× 複× |
| ツリー: linkedfd 行 | 単△ 複△ — その linkedfd には入らず、**note ツリーの兄弟として複製される** | 単× 複× | 単× 複× |
| ツリー: 普通の file 行 | 単○ 複○ — 前後に兄弟として複製 | 単× 複× | 単× 複× |
| OS の Finder | 単× 複× | 単× 複× — 文字だけ | 単× 複× |
| 他の VS Code エディタ | 単× 複× — 相対パスの文字だけ | 単△ 複△ — 相対パスの文字だけ | 単× 複× |

## 6. 出所 = note のファイルツリー

複数選択の payload は種類ごとに `x-fractal-tree-md` / `x-fractal-tree-file` = `{v:1, items:[{id,filePath?,seq}]}`、受け手は `mergeTreeItemsBySeq` で選択順に戻す。.out 行は D&D の payload から外され drop 後に 1 回通知、folder link・仮想フォルダは**通知なしで外れる**（`batch-payload.js` に folderItems の引数はあるが、`tree-folder` の MIME を出す所は無い）。単一の .out / folder 行は text/plain しか載らない（ツリー内の並べ替えと linkedfd view の不受理通知だけ）。ツリーには copy / cut / paste の処理が一切無い（右クリックの Copy Path・Copy In-App Link・Duplicate だけ、どれも 1 件）。

| 行き先 | D&D | cmd+c → v | cmd+x → v |
|---|---|---|---|
| ツリーの中（並べ替え・フォルダへ） | 単○ 複○ — 移動。全種類 | 単× 複× | 単× 複× |
| note md | 単○ 複○ — md = subpage リンク、file = 📎、ツリーから外す（移動）。linkedfd の md = 複製 | 単× 複× | 単× 複× |
| sidepanel md | 単○ 複○ — 同じ note = 移動、他 note = 実体複製、linkedfd = ツリー項目を残す | 単× 複× | 単× 複× |
| note outliner | 単○ 複○ — drop 位置に page / file node（移動） | 単× 複× | 単× 複× |
| sidepanel outliner | －（P2） | －（P2） | －（P2） |
| linkedfd view | 単○ 複○ — 常に複製 | 単× 複× | 単× 複× |
| ツリー: md 行（中央帯） | 単○ 複○ — 追記（移動）。フォルダは kind_unsupported | 単× 複× | 単× 複× |
| ツリー: .out 行（中央帯） | 単○ 複○ — root 先頭へ（移動） | 単× 複× | 単× 複× |
| ツリー: linkedfd 行（中央帯） | 単○ 複○ — 複製。ツリーのフォルダは複製できず失敗に数える | 単× 複× | 単× 複× |
| OS の Finder | 単× 複× | 単× 複×（Copy Path は 1 件の文字だけ） | 単× 複× |
| 他の VS Code エディタ | 単× 複× — 項目 id の文字だけ | 単× 複× | 単× 複× |

---

## 数え方の集計（`－` を除く、1 セル = 単か複の 1 つ）

| 出所 | ○ | △ | × |
|---|---|---|---|
| note md | 19 | 13 | 36 |
| sidepanel md（表 2 の「表 1 と同じ」の行も数えた） | 17 | 13 | 24 |
| note outliner | 24 | 14 | 34 |
| sidepanel outliner | 0 | 0 | 0（全て －） |
| linkedfd view | 17 | 4 | 53 |
| note ファイルツリー | 16 | 0 | 44 |
| 合計 | 93 | 44 | 191 |

ポイント:
- **clipboard は md と outliner の間でだけ動く**（md ⇄ md、md ⇄ outliner、outliner ⇄ outliner、linkedfd → outliner、linkedfd → 同じ linkedfd、outliner → linkedfd）。ツリーは copy も paste もできず、linkedfd view は md の clipboard を受けない。
- **D&D の複数は、出所がツリー・outliner・linkedfd なら大体通る。出所が md だと必ず 1 件**（dragstart が掴んだアンカー 1 つしか積まない）。
- 届くのに複が壊れている所: linkedfd → sidepanel md（無音で何もしない）、outliner → sidepanel md（掴んだ 1 件だけ）。

## コードで確かめて直した点（3 つの調査の食い違い）

| 項目 | 確かめた結果 | 根拠 |
|---|---|---|
| outliner → sidepanel md の複（調査 2 は「未対応」） | 掴んだ 1 件は行くので、md 出所と揃えて `△` にした | `editor.js` に `out-node-assets` を読む所が無い（grep） |
| ツリーのフォルダの扱い（`folderItems`） | `batch-payload.js:62` に引数はあるが、`tree-folder` の MIME を setData する所は無い。複数ドラッグでフォルダは無音で外れる | grep `tree-folder` |
| md の 📎 → ツリー（他 note） | 確定。`crossesLinkedfd` の分岐はあるが `isCrossNoteDrop` が無い。他 note の md から来ると名前だけ登録し、元リンクも消す | `src/shared/notes-message-handler.ts:3876-3910` |
| linkedfd の複 → md | 確定（行番号は 20951-20970 に変わっている） | `src/webview/editor.js:20958`、`return` は `:20969` |
| md → ツリーの folder 行 | 確定。subpage は `targetSp.dataset.parentId`、📎 は `computeSiblingInsert`。linkedfd の payload だけ 0.25-0.60 の中央帯がある | `src/shared/notes-file-panel.js:2165-2206` |
| ツリー → main md の単一 md | 確定。`linkMdAsSubpageForNotesMdCore` に `crossesLinkedfd` が無い（batch の方にはある） | `src/notesEditorProvider.ts:3808-3856` |
| outliner の単一 cut | 確定。`isPage`・`images`・本文は消すが `filePath` は残す | `src/webview/outliner.js:6377-6412` |
| outliner の cut の `nodeIds` | 確定。`nodeIds` を渡すのは複数選択の copy（`:6320`）だけ | `outliner.js:6320/6347/6366/6392` |
| outliner → md の paste | 確定。`runOutlinerNodesPaste` に `isCut` が無い | `src/shared/paste-asset-handler.ts:1438-` |
| linkedfd → ツリーの md 行 | 確定。host が for で回すだけで件数ゲートも通知も無い | `src/notesEditorProvider.ts:2842-2848` |
| linkedfd の paste の守り | 確定。`isFolderViewShown()` だけを見る（フォーカスの持ち主を見ない） | `src/shared/notes-folder-view.js:1371` |
| TC-CN-05 の「self-drop は no-op」 | drag 開始の状態を持たない合成 drop だけの話。実際の同じ editor への drop は DOM 移動（TC-LM-04/05） | `editor.js` の自 md 分岐 |

## テストが無い所

- md の複数リンクを含む範囲のドラッグ（全行き先）
- linkedfd の複数 → md editor、linkedfd の clipboard → md
- outliner の複数 → md の drop、outliner の cut → md（移動になるか）、outliner の cut → linkedfd
- ツリーの folder 行への md リンク・複数選択の drop
- 他 note の sidepanel md の 📎 → ツリー
- ツリーへの paste（処理が無い）、ツリーにフォーカスがあるときの linkedfd の paste の誤配送
- linkedfd → ツリーの md 行の件数ゲート
- Finder・他の VS Code エディタへの全経路
