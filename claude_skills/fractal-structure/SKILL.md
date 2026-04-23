---
name: fractal-structure
description: Fractal の Notes / Outliner / Page / Image / File 構造とデータモデル、Notes フォルダの場所の見つけ方を説明するリファレンス
---

# fractal-structure — Fractal のデータ構造リファレンス

Fractal は VSCode 拡張 (`imaken.fractal`) と Electron 単体アプリ (`fractal-desktop`) の両方で動く。どちらも同じ **Notes フォルダ** を扱う。Claude Code が Fractal のノートを追加編集／検索する際、このファイルを読めば「どこに何があるか」が分かる。

関連スキル:
- `fractal-search` — 検索
- `fractal-edit` — ノード／画像／ファイル追加（MD 追加は `fractal-md`）
- `fractal-md` — アウトライナーにノード／ページノード登録、新規 `.out` 作成

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

### 1b. VSCode / Cursor 拡張（globalState）

`state.vscdb` (SQLite) の `ItemTable` に `imaken.fractal` キーで JSON 保存されている。

| エディタ | state.vscdb パス |
|---------|-----------------|
| VSCode 安定版 | `~/Library/Application Support/Code/User/globalStorage/state.vscdb` |
| VSCode Insiders | `~/Library/Application Support/Code - Insiders/User/globalStorage/state.vscdb` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Kiro | `~/Library/Application Support/Kiro/User/globalStorage/state.vscdb`（存在すれば） |

Linux: `~/.config/Code/...`、Windows: `%APPDATA%/Code/...`

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

## 2. Notes フォルダの中身

```
<notes-folder>/                     ← ユーザーが登録したフォルダ
├── outline.note                    ← フォルダ／ファイルのツリー構造 (JSON)
├── <fileId>.out                    ← Outliner ファイル (JSON)
├── <fileId>.out                    ← 別の Outliner
├── dailynotes.out                  ← 日次ノート（自動生成される特殊 .out）
├── <fileId>/                       ← Outliner 専用 pageDir（outline JSON の pageDir で指定）
│   └── <pageId>.md
├── pages/                          ← デフォルト共有 pageDir（pageDir 未指定の .out が使う）
│   ├── <pageId>.md
│   └── images/                     ← MD 内画像の保存先
│       └── image_<ts>_<rand>.png
├── images/                         ← Outliner ノードの画像（`fractal.outlinerImageDefaultDir` = ./images）
│   └── image_<ts>_<rand>.png
├── files/                          ← Outliner ノードのファイル添付（`fractal.outlinerFileDir` = ./files）
│   └── <original-filename>.pdf
└── <anything>.md                   ← ルート直下の独立 .md（検索対象に含まれる）
```

### 旧 `.note` → `outline.note` 移行

古いプロジェクトでは `<folder-name>.note` だったが、現在は `outline.note` に統一。`NotesFileManager` が起動時に自動マイグレーションする（読み書きは常に `outline.note`）。

---

## 3. `outline.note` の構造 (フォルダ／ファイルのツリー)

```json
{
  "version": 1,
  "rootIds": ["file1-id", "folder1-id", "file2-id"],
  "items": {
    "file1-id": { "type": "file", "id": "file1-id", "title": "Daily Notes", "color": "blue" },
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

- `type: "file"` の `id` は **拡張子を除いた `.out` ファイル名**（例: `mn5tqf9ft4nd`）
- `type: "folder"` は仮想フォルダ（ディスク上のディレクトリではない）
- `color` は Tailwind palette 名（`red`/`orange`/.../`zinc`）または undefined
- 既存 `.out` が `outline.note` に登録されていない場合は自動でフラット構造に追加される

---

## 4. `.out` ファイルの構造 (Outliner 本体)

```json
{
  "version": 1,
  "title": "My Outline",
  "pageDir": "./mn5tqf9ft4nd",
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
| `pageDir` | string \| undefined | Page MD の保存先。相対なら `.out` からの相対、絶対パスも可。未指定なら `./pages` |
| `rootIds` | string[] | トップレベルノード ID 列（順序付き） |
| `nodes` | Record<string, Node> | 全ノードの辞書 |

### ノード ID 規約

- Outliner ノード: `n` + 連番＋ランダム（例: `nmn5tqf9fj3gmne`）
- Page: `crypto.randomUUID()`

---

## 5. ノードの 4 種類（mutually exclusive）

| ノード種別 | `isPage` | `pageId` | `filePath` | `images` | 実体ファイル |
|-----------|---------|---------|-----------|----------|-------------|
| **Plain** (普通のノード) | `false` | `null` | `null` | `[]` | なし |
| **Page** (MD 本文あり) | `true` | `"<uuid>"` | `null` | `[]` | `<pageDir>/<pageId>.md` |
| **Image** (画像だけ) | `false` | `null` | `null` | `["<rel path>"]` | `<outDir>/<outlinerImageDefaultDir>/image_...` |
| **File attachment** | `false` | `null` | `"<rel path>"` | `[]` | `<outDir>/<outlinerFileDir>/<name>` |

- `outDir` = `.out` が置かれているディレクトリ
- **相対パスの基準は `.out` ディレクトリ**（Page MD 内の画像だけは `pageDir` が基準 — MD ファイル自体が `pageDir` にあるため）
- `images` は配列で複数持てる（`filePath` は 1 つだけ）
- Node を「Plain → Page」等に切り替えるときは、他フィールドを明示的に `null`/`[]` にクリアする（相互排他）

---

## 6. Page MD ファイル (`<pageId>.md`)

- ページノードが参照する本文 Markdown
- 先頭 `# タイトル` があれば H1 がノード表示テキストのフォールバックになる（ただしノード `text` があれば優先）
- 画像参照 `![alt](path)` のパスは **pageDir からの相対パス**
- テーブルはセル内改行を `<br>` で平坦化する独自正規化あり（`src/shared/markdown-import.ts` `normalizeMultiLineTableCells`）
- `fractal-md` スキプトの MD 取り込みも同等処理を行う

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
| `fractal.theme` | `things` | テーマ |
| `fractal.outlinerPageDir` | `./pages` | Page MD ディレクトリ (相対 or 絶対) |
| `fractal.outlinerImageDefaultDir` | `./images` | ノード画像ディレクトリ |
| `fractal.outlinerFileDir` | `./files` | ノードファイル添付ディレクトリ |
| `fractal.imageDefaultDir` | `""` | MD 編集時の画像保存先（空なら MD と同ディレクトリ） |
| `fractal.language` | `default` | UI 言語 |

**優先順位**: `.out` ファイル内の `pageDir` > VSCode 設定 `fractal.outlinerPageDir` > デフォルト `./pages`

Electron 側は `~/Library/Application Support/fractal-desktop/config.json` の対応キー。

---

## 9. よくあるパス解決の落とし穴

- **pageDir は複数 outline で共有されうる**: ディレクトリ内の `.md` を全列挙すると他 outline の page まで拾うので、必ず `<nodes>.*.pageId` → `<pageDir>/<pageId>.md` で引く
- **画像の相対パス基準**: ノード画像は `.out` ディレクトリ基準、Page MD 内画像は `pageDir` 基準 — 混同注意
- **ファイル名ユニーク化**: 画像は `image_<Date.now()>_<rand>.<ext>`、ファイル添付は元ファイル名 + 衝突時 `-1`/`-2` サフィックス
- **`.out` を VSCode/Electron で開いた状態で外部から書き換えない**: 競合する（Claude Code が書く前に閉じてもらう）

---

## 10. Claude Code がファイル操作する時のチェックリスト

1. 対象 Notes フォルダを確定（§1 の順で解決、曖昧ならユーザーに確認）
2. `outline.note` と各 `.out` の `pageDir` を把握
3. 書き込む前に、そのファイルがエディタで開かれていないかユーザーに確認（推奨）
4. ID は既存と衝突しないように（Node ID は `n` + 時刻進める、Page ID は `crypto.randomUUID()`）
5. 書き込み後は JSON として再 parse できるか検証
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
