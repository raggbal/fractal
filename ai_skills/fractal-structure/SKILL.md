---
name: fractal-structure
description: Fractal の Notes / Outliner / Page / Image / File 構造とデータモデル、Notes フォルダの場所の見つけ方を説明するリファレンス
---

# fractal-structure — Fractal のデータ構造リファレンス

Fractal は VSCode 拡張 (`imaken.fractal`) と Electron 単体アプリ (`fractal-desktop`) の両方で動く。どちらも同じ **Notes フォルダ** を扱う。Claude Code が Fractal のノートを追加編集／検索する際、このファイルを読めば「どこに何があるか」が分かる。

関連スキル:
- `fractal-search` — 検索（全文 + `--tag` / `--checked` フィルタ）
- `fractal-edit` — 書き込み全般: ノード／画像／ファイル追加、変更（text 書換・チェック・削除・移動 = fractal-modify）、新規 `.out` / 独立 md 作成
- `fractal-doctor` — note 整合性チェック（read-only。未移行検出・参照切れ・孤児）
- `fractal-summary` — Outliner・md の全内容を 1 本の md にまとめる（read-only。AI 入力・要約用）

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
  "notesPanelCollapsed:/Users/you/Desktop/notes": false
}
```

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
- **subpage リンク**: `[[label]](x.md)` 形式（通常リンクと区別される Fractal 独自記法）。相対 url は `dirname(現md)` 基準で解決。**label に `]` は使えない**（パーサが最初の `]` で label を切る）— 生成時は `]`/`[` を全角 `］`/`［` に置換する（clipper / fractal-md `--target-md` は自動でやる）
- subpage は独立 md からも page md からも張れる（`fractal-summary --md` はこれを再帰的に辿る）
- テーブルはセル内改行を `<br>` で平坦化する独自正規化あり（`src/shared/markdown-import.ts` `normalizeMultiLineTableCells`）
- `fractal-md` スクリプトの MD 取り込みも同等処理を行う

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
- **`.out` を VSCode/Electron で開いた状態で外部から書き換えない**: 競合する（Claude Code が書く前に閉じてもらう）

---

## 10. Claude Code がファイル操作する時のチェックリスト

1. 対象 Notes フォルダを確定（§1 の順で解決、曖昧ならユーザーに確認）
2. **書き込みは JSON 手編集より skill スクリプトを優先**（`fractal-edit` の fractal-md / fractal-attach / fractal-modify が相互排他・ID 採番・パス規約を守ってくれる）。手編集が必要なのはスクリプトが対応しない操作だけ
3. 未移行の可能性がある note は先に `fractal-doctor --note-dir` でプリフライト（layout WARN が出たら本体の移行ゲートでフラット化してもらう）
4. 書き込む前に、そのファイルがエディタで開かれていないかユーザーに確認（推奨）
5. 手編集する場合: ID は既存と衝突しないように（Node ID は `n` + 時刻 + ランダム、Page ID は `crypto.randomUUID()`）、optional フィールド（noteTitle / favorites / history 等）を消さない、書き込み後は JSON 再 parse で検証
6. 親ノードを text 指定で探すときは完全一致 → 部分一致の順

---

## 参照ソース

- `src/shared/notes-file-manager.ts` — `.out` / `outline.note` I/O、検索
- `src/shared/markdown-import.ts` — MD 取り込み、画像処理、テーブル正規化
- `src/shared/file-import.ts` — ファイル添付コピー
- `src/shared/drop-import.ts` — D&D 経路の統合
- `src/notesFolderProvider.ts` — VSCode フォルダ登録 UI（globalState 永続化）
- `electron/src/settings-manager.ts` — Electron 設定 (electron-store)
- `package.json` (`contributes.configuration`) — VSCode 設定キー定義
