# Fractal のデータ構造リファレンス（fractal MCP の fractal_structure）

Fractal は VSCode 拡張 (`imaken.fractal`) と Electron 単体アプリ (`fractal-desktop`) の両方で動く。どちらも同じ **Notes フォルダ** を扱う。AI が Fractal のノートを追加編集／検索する際、これを読めば「どこに何があるか」が分かる。

関連 tools（fractal MCP。返り値はどれも JSON。`fractal_structure` / `fractal_summary` だけ Markdown）:
- 探す・読む: `fractal_list_folders`（Notes フォルダ）/ `fractal_list_notes`（note とツリーの項目）/ `fractal_resolve`（タイトル → 絶対パス・id・contentHash）/ `fractal_get`（.out のノード木・md の本文と H1・見出し・subpage・ツリー）/ `fractal_search`（全文 + tags / checked）/ `fractal_summary`（全内容を 1 本の md に）
- 書く: `fractal_add`（ノード・page・新しい .out / md・subpage）/ `fractal_modify`（ノードの変更・ページ化 / 解除 / md との変換・別の .out / note への移動）/ `fractal_attach`（画像・添付）/ `fractal_tree`（ツリーの rename / delete / move / create-folder / duplicate / move-to-note）
- 検査: `fractal_doctor`（読むだけ。参照切れ・孤児（UI の Cleanup と同じ判定）・ツリーの整合）
- **md の本文は直接編集してよい**（自分の Read / Edit で。Fractal の画面は入力中の外部変更を合成して取り込む）。ただし:
  - (a) **H1（タイトル）は tool で変える**: ツリーの md item は `fractal_tree` の rename、page md は page ノードの `fractal_modify` set-text（ツリー / ノードのタイトルと H1 を一緒に変える）。tree にも page にも属さない md（subpage 等）の H1 は同期先が無いので直接編集でよい
  - (b) **画像・添付・subpage は tool で足す**: `fractal_attach`（`![](images/..)` / `[📎 名前](files/..)`）・`fractal_add` の targetMd（`[[タイトル]](xxx.md)`）。実体を images/ files/ へコピーし、Cleanup が参照として数える書式で書く（手で `[名前](files/..)` と書くと孤児と判定されて消される）
  - (c) **`.out` / `outline.note` は直接書かない**（ノード・ツリーの操作は必ず tool）

### MCP で書くときの決まり（spec 20261027-1700-mcp-full-ops）

1. **対象を特定してから書く**: `fractal_resolve` か `fractal_get` で絶対パス・id と `contentHash` を得る。ノード・項目・見出しは本文 / タイトルでも指定できるが、既定は**完全一致**（`match: "prefix" | "contains"` で緩める）。2 件以上に一致したら書かずに `AMBIGUOUS`（`candidates` に id・本文・パンくず）を返すので、id で指定し直すかユーザーに選んでもらう。0 件は `NOT_FOUND`（`suggestions` 付き）
2. **楽観ロック**: 書き込み系に `expectedHash`（読んだときの contentHash）を付ける。今の内容と違えば何も書かずに `CONFLICT`（`currentHash` 付き）→ 読み直してやり直す。付けないと書けるが返り値に `lock: "none"` と出る
3. **返り値で次へ**: `nodeId` / `pageId` / `itemId` / `absPath` と、変えたファイルの `changed: [{ absPath, contentHash }]`・作ったファイルの `created`・ゴミ箱へ移した `trashed` が返る。続けて書くときは `changed` の contentHash を次の expectedHash に使える
4. **位置**: `position` は画面と同じ。`child`（既定）= 基準ノードの子の**末尾**（基準が無ければルートの末尾）/ `first` = 子の先頭 / `after` / `before` = 兄弟。md の中は `heading`（見出しのテキストか `親 > 子` のパス）と `mdPosition: end | start`
5. **削除はゴミ箱へ**: `delete` / `unpage` / 別の note への移動は、その操作で**新たに**どこからも参照されなくなった page md・画像・添付・subpage を OS のゴミ箱へ移す（前からあった孤児には触らない。完全削除はしない。ゴミ箱が使えない環境では `TRASH_UNAVAILABLE` で拒否）。`dryRun: true` なら何も書かずに、Notes フォルダの写しで同じ処理をした結果（changed / created / trashed）だけを返す
6. **書き込みは Notes フォルダ（outline.note のあるフォルダ）の中だけ**: 外を指すパス・`..`・`.out` の imageDir が外、などは `OUTSIDE_NOTES`。書き込みは tmp に書いてから rename（途中で落ちても元のファイルは壊れない）、途中で失敗したらその操作でコピーしたファイルを片付ける
7. 中身の処理は拡張機能と同じ関数（src/shared の正典と webview の OutlinerModel）を通るので、tags（#tag）・taskMode の checkbox・page md の H1 同期・📎 添付リンクの書式・ファイル名の安全化は画面と同じになる

エラーは `isError: true` + `{ ok: false, error: { code, message, ... } }`。code: `CONFLICT` / `AMBIGUOUS` / `NOT_FOUND` / `OUTSIDE_NOTES` / `INVALID` / `TRASH_UNAVAILABLE` / `FAILED`。

---

## 1. 登録済み Notes フォルダの見つけ方

Fractal はユーザーが登録した複数の **Notes フォルダ** を扱う。Claude Code が「どのフォルダを対象に操作すべきか分からない」場合は以下の順で解決する。

### 1a. Electron 単体アプリ（最優先）

- **パス**: `~/Library/Application Support/fractal-desktop/config.json`
- **キー**: `notesFolders` (string[]), `lastSelectedNoteFolder` (string)
- 読み方:

```bash
cat "$HOME/Library/Application Support/fractal-desktop/config.json"
# jq が使えるなら:
jq -r '.notesFolders[]' "$HOME/Library/Application Support/fractal-desktop/config.json"
```

### 1b. VSCode 系拡張（globalState）

VSCode 互換の各 IDE（Code / Code - Insiders / Cursor / Kiro / VSCodium / Antigravity）はすべて同じ仕組みで `state.vscdb` (SQLite) の `ItemTable` に `imaken.fractal` キーで JSON を保存する。

| エディタ | state.vscdb パス |
|---------|-----------------|
| VSCode 安定版 | `~/Library/Application Support/Code/User/globalStorage/state.vscdb` |
| VSCode Insiders | `~/Library/Application Support/Code - Insiders/User/globalStorage/state.vscdb` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Kiro | `~/Library/Application Support/Kiro/User/globalStorage/state.vscdb` |
| VSCodium | `~/Library/Application Support/VSCodium/User/globalStorage/state.vscdb` |
| Antigravity | `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` |

Linux: `~/.config/<EditorName>/...`、Windows: `%APPDATA%/<EditorName>/...`

```bash
# notesFolders の配列を取り出す
sqlite3 "$HOME/Library/Application Support/Code/User/globalStorage/state.vscdb" \
  "SELECT value FROM ItemTable WHERE key='imaken.fractal';" \
  | jq -r '.notesFolders[]'
```

JSON の中身（例）:

```json
{
  "notesFolders": ["/Users/you/Desktop/notes", "/Users/you/Desktop/tasks"],
  "notesLastFile:/Users/you/Desktop/notes": "/Users/you/Desktop/notes/xxx.out",
  "notesPanelCollapsed:/Users/you/Desktop/notes": false,
  "notesRegistries": ["/Users/you/.fractal/default.fractal", "/Users/you/Documents/work.fractal"],
  "activeNotesRegistry": "/Users/you/.fractal/default.fractal"
}
```

Note の一覧の正は **Notes 一覧ファイル**（`<name>.fractal`。初回は `~/.fractal/default.fractal` が自動で作られる）。`notesRegistries` に登録した一覧ファイルのパス、`activeNotesRegistry` にサイドパネルの Notes Lists で選んでいるものが入る。`notesFolders` はアクティブの一覧の notes の写し。一覧ファイルの中身（JSON）:

```json
{ "version": 1, "notes": ["/Users/you/Desktop/notes", "/Users/you/Desktop/tasks"] }
```

`fractal_list_folders` は全 IDE の `notesFolders` と、登録された全一覧ファイルの `notes` を合わせて返す（source は `vscode:<IDE>:<一覧ファイル名>`）。

### 1c. ユーザーに聞く

上記で見つからないか曖昧なら、**推測せずユーザーに対象フォルダを聞く**。

---

## 2. Notes フォルダの中身（フラットレイアウト・sprint 20260707-124018 以降）

```
<notes-folder>/                     ← ユーザーが登録したフォルダ
├── outline.note                    ← フォルダ／ファイルのツリー構造 (JSON)
├── <basename>.out                  ← Outliner ファイル (JSON) — basename = ファイル名 (拡張子なし)
├── <pageId>.md                     ← Page MD（ノードに紐づく本文）— note 直下フラット
├── <mdId>.md                       ← Notes-md（.out を持たない独立 md item）— 同じく直下
├── images/                         ← 全 .out / 全 md 共有の画像保存先
│   └── image_<ts>_<rand>.png
├── files/                          ← 全 .out / 全 md 共有のファイル添付保存先
│   └── <original-filename>.pdf
└── dailynotes.out                  ← 日次ノート（自動生成される特殊 .out）
```

**フラット規約**（正典: `src/shared/flat-layout.ts`）:
- page md は **note フォルダ直下**（`<note>/<pageId>.md`）。per-outliner のサブフォルダは作らない。
- 画像/添付は **共有** `<note>/images/`・`<note>/files/`（全 .out・全 md で共有）。
- 移行済み .out には `pageDir: "."`, `imageDir: "./images"`, `fileDir: "./files"` のヒントが書かれる（`FLAT_OUT_HINTS`）。
- 未移行 note を fractal で開くと移行ゲートが出てフラット化を促す。

### Legacy layout（〜2026-07 移行前・後方互換で読み取りのみ）

```
<notes-folder>/
├── <basename>/                     ← 旧: Outliner 専属ディレクトリ (= pageDir)
│   ├── <pageId>.md
│   ├── images/ … files/
├── pages/                          ← さらに旧: 共有 pages dir
└── _notes_md/                      ← 旧: Notes-md 置き場（_notes_md/images 等）
```

fractal 本体の読み取りは legacy fallback を持つが、**外部ツール（clipper/ai_skills）は新フラットレイアウト前提**（hint 尊重・無ければ直下。未移行 note は本体の移行ゲートで先にフラット化すること）。

### 旧 `.note` → `outline.note` 移行

古いプロジェクトでは `<folder-name>.note` だったが、現在は `outline.note` に統一。`NotesFileManager` が起動時に自動マイグレーションする（読み書きは常に `outline.note`）。

---

## 3. `outline.note` の構造 (フォルダ／ファイルのツリー)

```json
{
  "version": 1,
  "noteTitle": "仕事ノート",
  "rootIds": ["file1-id", "md1-id", "folder1-id"],
  "items": {
    "file1-id": { "type": "file", "id": "file1-id", "title": "Daily Notes", "color": "blue" },
    "md1-id":   { "type": "file", "id": "md1-id", "title": "会議メモ", "ext": "md" },
    "folder1-id": {
      "type": "folder",
      "id": "folder1-id",
      "title": "Research",
      "childIds": ["file3-id", "file4-id"],
      "collapsed": false,
      "color": "orange"
    }
  },
  "panelWidth": 250,
  "s3BucketPath": "my-bucket/notes-backup"
}
```

- `type: "file"` の item は **2 種類**（`ext` フィールドで判別。正典: notes-file-manager.ts `NoteTreeFile`）:
  - `ext` 省略 or `"out"` → **Outliner**。`id` = 拡張子を除いた `.out` ファイル名（実体 `<note>/<id>.out`）
  - `ext: "md"` → **独立 md item**（Notes-md）。実体 `<note>/<id>.md`
- `noteTitle`（optional）= **Note 全体の表示名**。未設定ならフォルダ名で表示（本体 `resolveNoteLabel` / clipper / skills も同規約）
- `type: "folder"` は仮想フォルダ（ディスク上のディレクトリではない）
- `color` は Tailwind palette 名（`red`/`orange`/.../`zinc`）または undefined
- その他の optional フィールド（**AI が outline.note を書き換えるとき消さないこと**）: `panelWidth` / `sidePanelWidth` / `sidePanelOutlineWidth` / `s3BucketPath` / `favorites`（お気に入り id 配列）/ `history`（最近開いたファイル履歴）/ `historyPanelHeight` / `historyPanelCollapsed`
- 既存 `.out` が `outline.note` に登録されていない場合は自動でフラット構造に追加される

---

## 4. `.out` ファイルの構造 (Outliner 本体)

```json
{
  "version": 1,
  "title": "My Outline",
  "pageDir": ".",
  "imageDir": "./images",
  "fileDir": "./files",
  "rootIds": ["nAAA", "nBBB"],
  "nodes": {
    "nAAA": {
      "id": "nAAA",
      "parentId": null,
      "children": ["nCCC"],
      "text": "親ノード",
      "tags": [],
      "isPage": false,
      "pageId": null,
      "collapsed": false,
      "checked": null,
      "subtext": "",
      "images": [],
      "filePath": null
    },
    "nCCC": {
      "id": "nCCC",
      "parentId": "nAAA",
      "children": [],
      "text": "MD ページ",
      "isPage": true,
      "pageId": "uuid-v4",
      "images": [],
      "filePath": null,
      "tags": [], "collapsed": false, "checked": null, "subtext": ""
    }
  }
}
```

### フィールド

| フィールド | 型 | 説明 |
|-----------|----|------|
| `title` | string | 表示タイトル（`outline.note` の `items[id].title` と同期） |
| `pageDir` | string \| undefined | Page MD の保存先。フラット移行済みは `"."`（= note 直下）。相対なら `.out` からの相対、絶対パスも可。**未指定は note 直下（外部ツールは新フラット前提。本体のみ legacy 読み取り fallback あり）** |
| `imageDir` | string \| undefined | ノード画像の保存先 (top-level)。フラット移行済みは `"./images"`（共有）。未指定は共有 `<note>/images` |
| `fileDir` | string \| undefined | ノードファイル添付の保存先 (top-level)。フラット移行済みは `"./files"`（共有）。未指定は共有 `<note>/files` |
| `rootIds` | string[] | トップレベルノード ID 列（順序付き） |
| `nodes` | Record<string, Node> | 全ノードの辞書 |

### ノード ID 規約

- Outliner ノード: `n` + 連番＋ランダム（例: `nmn5tqf9fj3gmne`）
- Page: `crypto.randomUUID()`

---

## 5. ノードの 4 種類（mutually exclusive）

| ノード種別 | `isPage` | `pageId` | `filePath` | `images` | 実体ファイル（フラット） |
|-----------|---------|---------|-----------|----------|-------------|
| **Plain** (普通のノード) | `false` | `null` | `null` | `[]` | なし |
| **Page** (MD 本文あり) | `true` | `"<uuid>"` | `null` | `[]` | `<note>/<pageId>.md`（直下） |
| **Image** (画像だけ) | `false` | `null` | `null` | `["<rel path>"]` | `<note>/images/image_<ts>_<rand>.<ext>`（共有） |
| **File attachment** | `false` | `null` | `"<rel path>"` | `[]` | `<note>/files/<name>`（共有） |

- `outDir` = `.out` が置かれているディレクトリ（= note フォルダ）
- **相対パスの基準**:
  - `node.images[]` と `node.filePath` → `outDir` 基準（フラットでは `images/foo.png`、`files/doc.pdf`）
  - Page MD 内の `![]()` / `[]()` → **md ファイルの場所**基準（フラットでは md も直下なので同じく `images/foo.png`）
- Legacy layout では実体が `<outDir>/<basename>/...` に居る（読み取り fallback のみ・上記 §2 参照）
- `images` は配列で複数持てる（`filePath` は 1 つだけ）
- Node を「Plain → Page」等に切り替えるときは、他フィールドを明示的に `null`/`[]` にクリアする（相互排他）

---

## 6. Page MD ファイル (`<pageId>.md`) と subpage リンク

- ページノードが参照する本文 Markdown
- **タイトル ↔ H1 は双方向同期**（v0.212 世代）: 先頭 H1 を書き換えるとツリー側の title に反映され、逆も同期される。H1 抽出は CommonMark 準拠（`# C#` の末尾 `#` はタイトルの一部・閉じ `#` は空白前置時のみ。正典 `src/shared/md-h1-utils.ts`）
- 画像参照 `![alt](path)` のパスは **md ファイルの場所からの相対パス**（フラットでは `images/foo.png`）
- **subpage リンク**: `[[label]](x.md)` 形式（通常リンクと区別される Fractal 独自記法）。相対 url は `dirname(現md)` 基準で解決。**label に `]` は使えない**（パーサが最初の `]` で label を切る）— 生成時は `]`/`[` を全角 `］`/`［` に置換する（clipper / `fractal_add` の targetMd は自動でやる）
- **添付リンク**: `[📎 名前](files/名前)`（📎 で始まるリンクだけを Fractal は添付として扱う。UI の Cleanup も 📎 リンクだけを添付の参照として数えるので、📎 の無い `[名前](files/..)` で書くと添付が孤児と判定されて消される）。画像は `![](images/..)`。`fractal_attach` の targetMd はこの書式で書く
- md のファイル名・添付名に `[` `]` `?` `#` や対応の取れない括弧があるとリンクが壊れる（`fractal_attach` は `_` に置き換える）。subpage の md 名に空白があると UI の Cleanup が孤児と誤判定するので、空白の無い名前にする（`fractal_doctor` が WARN で知らせる）
- subpage は独立 md からも page md からも張れる（`fractal_summary` の md はこれを再帰的に辿る）
- テーブルはセル内改行を `<br>` で平坦化する独自正規化あり（`src/shared/markdown-import.ts` `normalizeMultiLineTableCells`）
- `fractal_add` の md 取り込みも同じ処理（正典 `importMdFilesCore`）を行う。md の画像・📎 添付・subpage と、ローカルファイルへのプレーンリンク（📎 にしてから）を Notes フォルダへ複製して書き換える（md と同じフォルダより外を指す参照は複製しない）

---

## 7. 検索の範囲（`NotesFileManager.searchFilesStreaming` と同じ方針）

検索は 1 つの Notes フォルダ内で 3 層にわたる:

1. **`.out` のノード**: `text` と `subtext[:500]`
2. **ルート直下 `.md`**: 本文
3. **Page `.md`**: ただし「その `.out` の `nodes` を走査し、`pageId` を持つノードに対応する `<pageId>.md` だけ」を検索（ディレクトリ全列挙ではない）→ **未リンクページや他 outline 所有ページを混ぜないため**

MD 本文の検索前に、DOM レンダ後テキストと一致させるため以下正規化:
- `![](...)` を丸ごと削除
- `[text](url)` を `text` のみに短縮
- 各行 200 文字まで

---

## 8. VSCode 拡張の設定項目（`fractal.*`）

`package.json` の `contributes.configuration`（抜粋）:

| 設定キー | デフォルト | 説明 |
|---------|-----------|------|
| `fractal.theme` | `auto` | テーマ (`light`/`dark`/`auto`) |
| `fractal.language` | `default` | UI 言語 |
| `fractal.showOpenInTextEditor` | `true` | Open in Text Editor ボタンの表示 |

**画像/添付の保存先はグローバル設定では制御されない**（v0.212.0 で `fractal.imageDefaultDir` / `fileDefaultDir` / `forceRelative*` 撤廃）。保存先はフラット規約で固定（`<note>/images`・`<note>/files`）。fractal note 外の standalone md のみ、md 同フォルダの `.fractal.json` サイドカー（`{imageDir, fileDir}`）で上書き可（ADRL-0016）。`.out` 内 `pageDir` / `imageDir` / `fileDir` フィールドの per-file 上書きも引き続き有効。

Electron 側は `~/Library/Application Support/fractal-desktop/config.json` の対応キー。

---

## 9. よくあるパス解決の落とし穴

- **pageDir はフラットで note 直下共有**: 全 .out の page md が同じ `<note>/` 直下に並ぶ。ディレクトリ内 `.md` 全列挙ではなく、必ず `<nodes>.*.pageId` → `<pagesDir>/<pageId>.md` で引く（他 outline のページや Notes-md を混ぜない）
- **画像・ファイルの相対パス基準**:
  - `node.images[]` / `node.filePath` → `.out` ディレクトリ基準 (フラットでは `images/foo.png`)
  - Page MD 内 `![]()` / `[]()` → md ファイルの場所基準 (フラットでは同じく `images/foo.png`)
  - 混同すると画像表示されない/リンク切れになる（legacy note では基準 dir が異なるので注意）
- **ファイル名ユニーク化**: 画像は `image_<Date.now()>_<rand>.<ext>`、ファイル添付は元ファイル名 + 衝突時 `-1`/`-2` サフィックス
- **`.out` / md を VSCode/Electron で開いた状態で外部から書くとき**: MCP の書き込みは `expectedHash` で「読んでから変わっていないか」を確かめる（変わっていれば CONFLICT）。開いている画面は外部の変更を取り込むが、念のため大きな変更の前はユーザーに保存してもらう

---

## 10. Claude Code がファイル操作する時のチェックリスト

1. 対象 Notes フォルダを確定（§1 の順で解決、曖昧ならユーザーに確認）。`fractal_resolve` / `fractal_list_notes` で絶対パスを得る
2. **書き込みは JSON 手編集より fractal MCP の tool を使う**（`fractal_add` / `fractal_attach` / `fractal_modify` / `fractal_tree` が相互排他・ID 採番・パス規約・タイトル同期・ゴミ箱を守ってくれる）。`.out` / `outline.note` は手編集しない。md の本文は直接編集してよい（H1・画像・添付・subpage は上の規約どおり tool で）
3. 書く前に `fractal_get` で contentHash を取り、`expectedHash` に付ける（CONFLICT なら読み直す）
4. 未移行の可能性がある note は先に `fractal_doctor` でプリフライト（layout WARN が出たら本体の移行ゲートでフラット化してもらう）
5. 削除・移動・ページ解除は `dryRun: true` で何が変わるか（trashed）を確かめてから
6. ノード・項目を本文 / タイトルで指定するときは完全一致が既定。AMBIGUOUS なら candidates の id を使うかユーザーに選んでもらう（推測で選ばない）

---

## 参照ソース

- `src/shared/notes-file-manager.ts` — `.out` / `outline.note` I/O、検索
- `src/shared/markdown-import.ts` — MD 取り込み、画像処理、テーブル正規化
- `src/shared/file-import.ts` — ファイル添付コピー
- `src/shared/drop-import.ts` — D&D 経路の統合
- `src/notesFolderProvider.ts` — VSCode フォルダ登録 UI（globalState 永続化）
- `electron/src/settings-manager.ts` — Electron 設定 (electron-store)
- `package.json` (`contributes.configuration`) — VSCode 設定キー定義

---

## tools を使うときの注意

- ノード ID・Page ID・item ID は tool が採番する（手書きしない）。返り値の id を次の操作に使う
- `parent` / `target` / `item` / `heading` は ID か本文 / タイトルで指定する（既定は完全一致）。見つからなければ NOT_FOUND、複数なら AMBIGUOUS で止まり、勝手に root や先頭にフォールバックしない
- `fractal_modify` の delete / unpage と `fractal_tree` の delete は、その操作で参照されなくなった page md・画像・添付を OS のゴミ箱へ移す（戻せる）。`dryRun: true` で先に確かめられる
- `fractal_modify` の page-to-md は画面と同じく元のノードを空のノードとして残す（要らなければ delete）。md-to-page は md item をツリーから外して page にする
- 別の note への移動（`fractal_modify` move + toOut / `fractal_tree` move-to-note）は page md・画像・添付・subpage を移動先へ複製してから、移動元で参照されなくなった実体を片付ける
- md を page として取り込むと、md 内の画像・📎 添付・ローカルファイルへのリンク・subpage は Notes フォルダへコピーされ相対パスに書き換わる（URL・anchor・存在しないファイル・md のフォルダより外の参照はそのまま）
- `fractal_doctor` は書き込まない。孤児の判定は UI の Cleanup（Clean Unused Files）と同じ。修復は結果をユーザーと相談してから
- `fractal_search` はバイナリ添付の中身を検索しない（パスだけ。docx / pptx / xlsx / pdf は抽出して検索）。`outline.note` のフォルダ階層は結果に反映しない
- サーバーの実体は `agent-capability/mcp/dist/server.mjs`（`npm run compile` / `node agent-capability/mcp/build.mjs` で作る bundle。SDK・zod・src/shared の正典を含む）。`agent-capability/mcp/server.mjs` はソースの入口で、直接は起動できない
