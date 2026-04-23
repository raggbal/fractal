---
name: fractal-search
description: Fractal の Notes フォルダ／Outline 一覧・横断検索スキル。登録済み Notes フォルダの自動検出（VSCode/Cursor/Kiro/Electron）、outline 一覧、outline タイトル絞込（--find-outline）、outline ノード／page MD／ルート MD の全文検索に対応
---

# fractal-search — Fractal 全文検索

> **🔴 先に読むこと**: Fractal のデータ構造（`.out` / `outline.note` / `pages/` / `pageDir` / ノードの 4 種類 / Notes フォルダの場所）を把握していない場合、最初に **`fractal-structure` スキルを呼んでください**（`Skill` ツールで `fractal-structure` を invoke）。誤った検索スコープ・誤った pageDir 解決を防ぎます。

1 つ以上の Notes フォルダを横断して、キーワードにマッチする情報を探す。検索の粒度は:

1. **Outline**（`.out` ファイル単位） — タイトルだけで「どの outline に情報が集まっているか」を提示
2. **Node**（`.out` 内ノード単位） — `text` / `subtext` がヒットしたノード
3. **Page**（`<pageId>.md`） — ノードに紐づく MD 本文
4. **Loose MD**（Notes フォルダ直下の `.md`） — outline 非管理の独立 MD

構造そのものを知りたい場合は `fractal-structure` スキルを参照。

---

## 使い方

### 基本

```bash
# 単一フォルダを検索
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --query "S3 sync" --folder /Users/you/Desktop/notes

# 登録済みフォルダを自動検出（Electron + VSCode の両方から）して全部検索
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --query "S3 sync" --auto

# 自動検出された Notes フォルダ一覧（検索せず、複数エディタに登録されてる場合は sources を集約）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --list-folders

# 登録済みフォルダ内の全 .out（outline）を dedupe 済みで一覧（outline.note のフォルダ階層付き）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --list-notes

# outline タイトル or outline.note フォルダ階層に一致する outline だけ素早く探す（中身スキャンしない）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --find-outline AWS
```

### オプション一覧

| オプション | 説明 |
|-----------|------|
| `--query <str>` | 検索語（`--list-folders` 以外で必須） |
| `--folder <path>` | 検索対象 Notes フォルダ（複数指定可、先頭に複数並べるか `--folder <p1> --folder <p2>`） |
| `--auto` | Electron `config.json` と VSCode/Cursor/Kiro/VSCodium `state.vscdb` から登録済み Notes フォルダを自動検出 |
| `--list-folders` | 検索はせず、自動検出された Notes フォルダ一覧を出力（複数エディタに登録されている場合は sources を集約して表示） |
| `--list-notes` | 検索はせず、登録済みフォルダ内の **全 `.out` (outline) を dedupe 済みで一覧**。各 outline の `outline.note` 内フォルダ階層、node/page 数、mtime 付き（cache 利用） |
| `--find-outline <keyword>` | **中身は見ず** outline タイトル or `outline.note` フォルダ階層に一致する outline だけ返す。`--regex` / `--case-sensitive` 併用可。Claude Code が「まずどの outline か絞る」一段目として使える（cache 利用） |
| `--regex` | `--query` を正規表現として解釈（デフォルト: リテラル） |
| `--case-sensitive` | 大小文字区別（デフォルト: 区別しない） |
| `--whole-word` | 単語境界マッチ |
| `--max-per-file <n>` | 1 ファイルあたりの表示ヒット数（デフォルト 5、0 で無制限） |
| `--max-results <n>` | 全体結果件数の上限（デフォルト 100） |
| `--scope outline,node,page,md` | 検索スコープをカンマ区切りで絞る（デフォルトは全部） |
| `--json` | JSON 形式で出力（機械処理用。`folderChain`、キャッシュ統計含む） |
| `--summary` | ファイル単位の件数サマリだけ出力（ヒット内容は省略） |
| `--no-cache` | mtime キャッシュを使わず毎回フル scan |
| `--clear-cache` | キャッシュを全削除して終了（検索はしない） |
| `--cache-dir <path>` | キャッシュの保存先を上書き（デフォルト: `~/.cache/fractal-search/`） |

`--auto` と `--folder` は併用可能（両方のフォルダを対象にする）。

### 出力（テキスト・デフォルト）

Outline タイトルには `outline.note` のフォルダ階層がパンくずで付く（ルート直下なら省略）:

```
📁 /Users/you/Desktop/notes
  📓 Research > Backend > My Outline  [mn5tqf9ft4nd.out]
     • node "S3 sync を有効化"  (nmn6vndkyqoxa7o)
       subtext: ...AWS S3 sync 設定は...
     📄 page for "Setup guide"  (pageId: a1b2... / node: nmn6vngyvsfvd8q)
       L12: S3 sync configuration...
       L27: ...to enable S3 sync, open...
  📑 README.md
     L3: Fractal supports S3 sync out of the box.
```

### 出力（`--json`）

```json
{
  "query": "S3 sync",
  "folders": ["/Users/you/Desktop/notes"],
  "results": [
    {
      "folder": "/Users/you/Desktop/notes",
      "kind": "outline-node",
      "outlineId": "mn5tqf9ft4nd",
      "outlineTitle": "My Outline",
      "outlineFile": "/Users/you/Desktop/notes/mn5tqf9ft4nd.out",
      "nodeId": "nmn6vndkyqoxa7o",
      "nodeText": "S3 sync を有効化",
      "matches": [
        { "field": "text", "line": "S3 sync を有効化", "start": 0, "end": 7 }
      ]
    },
    {
      "kind": "page",
      "outlineId": "mn5tqf9ft4nd",
      "pageId": "a1b2c3d4-...",
      "pagePath": "/Users/you/Desktop/notes/pages/a1b2c3d4-....md",
      "parentNodeId": "nmn6vngyvsfvd8q",
      "parentNodeText": "Setup guide",
      "matches": [ { "field": "content", "lineNumber": 12, "line": "...", "start": 0, "end": 8 } ]
    },
    {
      "kind": "md",
      "mdPath": "/Users/you/Desktop/notes/README.md",
      "matches": [ { "field": "content", "lineNumber": 3, "line": "...", "start": 19, "end": 26 } ]
    }
  ],
  "truncated": false
}
```

---

## 検索の方針

`NotesFileManager.searchFilesStreaming` の挙動を踏襲:

1. フォルダ内の `*.out` を列挙
2. 各 `.out` の `nodes.*.text` / `nodes.*.subtext[:500]` を検索
3. フォルダ直下の `*.md` を検索
4. 各 `.out` の `nodes` から `pageId` を持つものだけを抽出 → `<pageDir>/<pageId>.md` を検索（ディレクトリ全列挙しない）

MD 検索時は、DOM レンダ後テキストと一致させるため以下で正規化してから regex をかける:
- `![](...)` を丸ごと削除
- `[text](url)` を `text` のみに短縮
- 各行 200 文字まで

`pageDir` 解決は `.out` 内 `pageDir` フィールド > なければ `./pages`。

---

## 典型的な使い方（Claude Code 向け）

**推奨 2 段ロケット**:

```bash
# 1 段目: outline タイトル／階層に一致する outline だけ絞る（中身スキャンしない）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --find-outline "AWS"
#   → 📁 /Users/.../aws
#        📓 AWSの支援  [mnnt9rz80ogx.out]  nodes:106
#        📓 Well-Arch / AWS全体  [mnnt9sergtt2.out]  nodes:1104

# 2 段目: 絞った outline 内だけを本格検索（--folder で対象を限定）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --query "VPC peering" --folder /Users/you/Desktop/aws --scope node,page
```

**別パターン: 内容検索から始める**:

```bash
# まず outline タイトル単位でヒット数サマリ（どこに情報が集中しているか）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --query "ingest pipeline" --auto --summary

# 中身を見たい outline に絞って詳細
node ${CLAUDE_SKILL_DIR}/scripts/fractal-search.mjs --query "ingest pipeline" --folder /Users/you/Desktop/notes --scope page,node
```

`--json` を通せばパイプラインに流せるので、「ヒットした page の MD ファイルを順番に `Read` する」といった Claude Code 操作もしやすい。

---

## キャッシュ（mtime ベース、既定で有効）

- 保存先: `~/.cache/fractal-search/<folder-basename>_<hash>.json`（`--cache-dir` で上書き可）
- キャッシュキー: `.out` / `.md` のファイルごとに `{mtimeMs, size}` を保持。両方一致なら前回の parse 結果を再利用
- **反映の保証**:
  - ノード text/subtext/tags 編集 → `.out` の mtime が変わる → 当該ファイルだけ再 parse ✅
  - page MD 編集 → `<pageId>.md` の mtime が変わる → その MD だけ再読 ✅
  - 新規 `.out` / `.md` 追加 → cache 未登録 → フル読み ✅
  - 削除 → 次回実行時にキャッシュから自動 prune ✅
  - `outline.note` 自体はキャッシュ対象外（毎回読む、フォルダ階層の鮮度を優先）
- **信頼できない時**: `--no-cache` で完全バイパス、`--clear-cache` で全削除
- **解像度**: `mtimeMs`（浮動ミリ秒）+ `size` の両方一致が hit 条件（APFS なら実質ナノ秒精度）
- **破損耐性**: JSON parse 失敗時は cache 無視してフル scan にフォールバック（version mismatch 時も同様）
- **cache 統計**: `--json` 出力に `cache: { enabled, outCacheHit, outCacheMiss, mdCacheHit, mdCacheMiss }` が含まれる

## Notes フォルダ／Outline 一覧の取り出し

### `--list-folders` 出力例

```
Discovered Fractal notes folders:
  /Users/you/Desktop/notes2
     sources: electron, vscode:Code
  /Users/you/Desktop/tasks
     sources: electron, vscode:Code, vscode:Kiro
  /Users/you/Desktop/claude
     sources: vscode:Code
```

- `sources` は `electron` / `vscode:<EditorName>`（Code / Cursor / Kiro / VSCodium / Code - Insiders 等）を集約
- 同じ path が複数エディタに登録されていれば 1 行にまとめる

### `--list-notes` 出力例

```
📁 /Users/you/Desktop/notes2  (3 outlines)
  📓 ee  [mn5tqf9ft4nd.out]  nodes:132, pages:49
  📓 ｄ > Daily Notes  [dailynotes.out]  nodes:46, pages:2
  📓 ｄ > こんちは  [mn4ubwkxaxu3.out]  nodes:53, pages:12

Total: 6 outline(s) across 2 folder(s).
```

- `outline.note` のフォルダ階層（仮想フォルダ）がパンくず形式で表示される
- node/page カウント、ファイル名、絶対パスは JSON で取れる（`--json`）
- ルート直下（`outline.note` に未登録）の `.out` は `(not in outline.note)` 付きで表示

### JSON 形式

`--list-folders --json`:
```json
{
  "folders": [
    { "path": "/Users/you/Desktop/tasks", "sources": [
      { "kind": "electron", "detail": "..." },
      { "kind": "vscode", "editor": "Code", "detail": "..." },
      { "kind": "vscode", "editor": "Kiro", "detail": "..." }
    ]}
  ]
}
```

`--list-notes --json`:
```json
{
  "folders": [...],
  "notes": [
    {
      "folder": "/Users/you/Desktop/notes2",
      "sources": [...],
      "outlineId": "mn5tqf9ft4nd",
      "outlineFile": "/Users/.../mn5tqf9ft4nd.out",
      "title": "ee",
      "folderChain": [],
      "pageDir": null,
      "nodeCount": 132,
      "pageCount": 49,
      "lastModifiedMs": 1713654321000.0,
      "inOutlineNote": true
    }
  ]
}
```

---

## 制限事項

- バイナリ添付（画像・PDF 等）は検索しない（パスだけ）
- タグ検索は未対応（`nodes.*.tags[]` は見ない — 必要なら後で追加）
- 大きなフォルダだと全 `.out` を JSON.parse する時間がかかる（現状 `NotesFileManager` と同じ）
- `outline.note` のフォルダ階層は反映しない（ヒットした `.out` のファイル単位でのみ集約）
