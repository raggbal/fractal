---
name: fractal-edit
description: Fractal の .out / outline.note への全書き込み操作。ノード追加、MDページ取り込み（単一・一括）、画像ノード、ファイル添付ノード、既存ノードへの画像・ファイル後付け、新規 .out 作成 + outline.note 登録
---

# fractal-edit — Fractal への全書き込み操作

> **🔴 先に読むこと**: Fractal のデータ構造（`.out` / `outline.note` / `pages/` / `pageDir` / ノードの 4 種類 / 画像パスの相対基準 / Notes フォルダの場所）を把握していない場合、最初に **`fractal-structure` スキルを呼んでください**（`Skill` ツールで `fractal-structure` を invoke）。誤った pageDir 解決、壊れた画像参照、ノード種別の相互排他違反、`outline.note` 未更新を防ぎます。

Fractal への書き込みは用途別に 2 スクリプトに分かれる:

| 目的 | スクリプト | フラグ例 |
|------|-----------|---------|
| プレーンノード追加 | `fractal-md.mjs` | `--text` のみ |
| MD ページノード追加（単一） | `fractal-md.mjs` | `--md file.md` |
| MD ページノード追加（一括） | `fractal-md.mjs` | `--md "*.md"` または `--md a.md b.md c.md` |
| 新規 `.out` 作成 + `outline.note` 登録 | `fractal-md.mjs` | `--create-outliner "Title" --notes-dir /path` |
| 画像ノード追加 | `fractal-attach.mjs` | `--image <path>` |
| ファイル添付ノード追加 | `fractal-attach.mjs` | `--file <path>` |
| 既存ノードに画像 append | `fractal-attach.mjs` | `--image ... --target ... --append` |
| 既存ノードに filePath 上書き | `fractal-attach.mjs` | `--file ... --target ... --append` |

ノード種別の詳細（Plain / Page / Image / File attachment の相互排他）は `fractal-structure` §5 を参照。

---

## 1. nodes / MD pages / 新規 outline — `fractal-md.mjs`

### 共通引数

| 引数 | 必須 | 説明 |
|------|------|------|
| `--note <path>` | ✅（`--create-outliner` 時は不要） | `.out` ファイル（拡張子省略可） |
| `--md <path>` | ◯ | 登録する `.md` ファイル（単一 or glob or 複数パス） |
| `--text <str>` | ◯ | ノードのテキスト。`--md` と併用時は H1 の代わり |
| `--parent <id\|text>` | | 差し込み位置の基準ノード（未指定ならルート） |
| `--position child\|after` | | `child`（デフォルト: 子の先頭）／ `after`（基準ノードの直後の兄弟） |
| `--group-name <str>` | | 一括登録時の代表（親）ノード名。デフォルト: `--text` or `"Imported"` |
| `--create-outliner <title>` | | 新規 `.out` を作って `outline.note` に登録 |
| `--notes-dir <path>` | | `--create-outliner` の配置先 Notes フォルダ |

**必須**: `--md` または `--text` のどちらか（`--create-outliner` モードを除く）。

### 使用例

```bash
# プレーンノード追加
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs \
  --note path/to/note.out --text "新しいノード" --parent "親ノード"

# 基準ノードの兄弟として直後に挿入
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs \
  --note path/to/note.out --text "兄弟" --parent "基準" --position after

# MD ページノード（単一）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs \
  --note path/to/note.out --md file.md --parent "親ノード"

# MD ページノード（一括、グループ名指定）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs \
  --note path/to/note.out --md "docs/*.md" --group-name "リサーチ結果"

# 新規 outliner 作成 + outline.note 登録
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs \
  --create-outliner "My New Outline" --notes-dir /Users/you/Desktop/notes
```

### MD 処理内容

- **Markdown 正規化**: セル内改行テーブル平坦化（`src/shared/markdown-import.ts` `normalizeMultiLineTableCells` と同等）
- **画像処理**: `![alt](path)` を検出し、ローカル画像は `pages/images/` にコピー＆リネーム → **pageDir からの相対パス**に書き換え（URL 画像はそのまま）。balanced paren 対応（Notion エクスポートなど URL に `(` を含む場合に対応）
- **ページ保存**: `pages/<uuid>.md`
- `.out` ファイルに `pageDir` フィールドがあれば優先、なければ `./pages`

### 差し込み位置

| `--position` | `--parent` | 動作 |
|--------------|------------|------|
| `child`（デフォルト） | 未指定 | ルートの先頭 |
| `child` | 指定 | そのノードの children 先頭 |
| `after` | 未指定 | ルートの末尾 |
| `after` | 指定 | そのノードの直後の兄弟 |

### 単一登録 vs 一括登録

- **MD ファイル 0 or 1**: 単一登録（1 ノード作成）
- **MD ファイル 2 以上**: 一括登録（代表ノード＋各 MD が子ノード）
  - 代表ノード名: `--group-name` > `--text` > `"Imported"`
  - 子ノードは常に代表ノードの末尾に追加

---

## 2. 画像・ファイル添付 — `fractal-attach.mjs`

### 引数

| 引数 | 必須 | 説明 |
|------|------|------|
| `--note <path>` | ✅ | `.out` ファイル |
| `--image <path>` | ◯ | 追加する画像（複数指定可） |
| `--file <path>` | ◯ | 追加するファイル（複数指定可） |
| `--parent <id\|text>` | | 新規ノード挿入時の基準 |
| `--position child\|after` | | `fractal-md.mjs` と同セマンティクス |
| `--text <str>` | | 新規ノードのテキスト（デフォルト: 画像は空文字、ファイルはファイル名） |
| `--target <id\|text>` | | `--append` 時の操作対象ノード |
| `--append` | | 新規ノードを作らず対象ノードの `images[]` / `filePath` を更新 |
| `--image-dir <path>` | | 画像保存先（相対は `.out` 基準、デフォルト `./images`） |
| `--file-dir <path>` | | ファイル保存先（相対は `.out` 基準、デフォルト `./files`） |

`--image` と `--file` はどちらか一方のみ（1 コマンド 1 種別）。

### 使用例

```bash
# 画像ノード新規
node ${CLAUDE_SKILL_DIR}/scripts/fractal-attach.mjs \
  --note path/to/note.out --image diagram.png --parent "Design" --position after

# 画像 2 枚を 1 ノードに纏める
node ${CLAUDE_SKILL_DIR}/scripts/fractal-attach.mjs \
  --note path/to/note.out --image a.png --image b.png --parent "Gallery"

# ファイル添付ノード（複数 → 兄弟で並ぶ）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-attach.mjs \
  --note path/to/note.out --file report.pdf --file data.csv --parent "Archive"

# 既存ノードに画像を後付け
node ${CLAUDE_SKILL_DIR}/scripts/fractal-attach.mjs \
  --note path/to/note.out --image screenshot.png --target "対象ノード" --append

# 既存ノードにファイルを紐付け（filePath 上書き）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-attach.mjs \
  --note path/to/note.out --file report.pdf --target "ノード" --append
```

### 処理内容

- **画像コピー**: `image_<ts>_<rand>.<ext>` にリネーム（`jpeg` → `jpg` 正規化）、`imageDir` へ
- **ファイルコピー**: 元ファイル名を維持、衝突時 `-1`, `-2` サフィックス、`fileDir` へ
- **パストラバーサル防止**: `..` を含むファイル名は reject
- **相対パス**: `.out` ディレクトリからの相対で `images[]` / `filePath` に格納
- **既存ノード更新時の相互排他**: `--append --file` は対象ノードの `isPage` / `pageId` をクリア

---

## 3. 差し込み位置の解決（両スクリプト共通）

`--parent` / `--target` の値:

| 値 | 動作 |
|----|------|
| 未指定 | ルート扱い |
| ノード ID（`n...`） | そのノードを基準 |
| テキスト文字列 | `nodes` を走査して **完全一致 → 部分一致**の順 |

見つからなければエラー停止（勝手に root にフォールバックしない）。曖昧な場合はノード ID を指定するか、ユーザーに確認する。

---

## 4. 注意事項

- 対象 `.out` を Fractal（VSCode/Electron）で**開いた状態で外部編集しない**（競合して壊れる）
- ノード ID は `n` + 時刻 + ランダム、Page ID は `crypto.randomUUID()` — **手書きしない**
- `images[]` と `filePath` は**相互排他**（Page の `pageId` とも排他）— スクリプトが強制
- `.out` ファイルの `pageDir` が複数 outline で共有される場合、検索・操作時に他 outline の page を混入させない（fractal-search 仕様と同じ）
- 大量 MD 一括取り込み時、画像参照が多いと `pages/images/` に大量ファイルが生成される
