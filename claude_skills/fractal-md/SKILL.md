---
name: fractal-md
description: Fractal の .out ノートにノード（ページノード含む）を登録するスキル（単一・一括対応）
---

# fractal-md — Fractal ノートにノード／ページを登録

## 概要

指定した `.out` ファイル（Fractal のアウトライナーノート）に、ノードを登録する。

- **ノードのみ**: テキストだけのノードを追加（`--text` のみ指定）
- **ページノード**: MD ファイル付きのノードを追加（`--md` 指定）
- **一括登録**: 複数の MD ファイルをまとめて登録（代表ノード＋子ノード構成）

MD ファイルを指定した場合、Fractal 本体の import md と同じ処理（Markdown 正規化、画像コピー＆パス書き換え）を行う。

---

## 引数

| 引数 | 必須 | 説明 |
|------|------|------|
| ノート名 (`--note`) | ✅ | `.out` ファイルのパス（拡張子省略可） |
| MD ファイル (`--md`) | ❌ | 登録する `.md` ファイル（単一パスまたは glob / 複数パス） |
| テキスト (`--text`) | ❌ | ノードのテキスト。`--md` と併用時は H1 の代わりに使用 |
| 差し込み位置 (`--parent`) | ❌ | 基準ノードID or ノードのテキスト。デフォルト: ルート |
| 挿入方法 (`--position`) | ❌ | `child`（デフォルト）: 基準ノードの子として挿入。`after`: 基準ノードの直後の兄弟として挿入 |
| 代表ノード名 (`--group-name`) | ❌ | 一括登録時の親ノードのテキスト。デフォルト: `--text` の値 or `"Imported"` |

**必須条件**: `--md` または `--text` のどちらか一方は必要。

---

## 使用例

```bash
# ノードだけ追加（MDなし）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs --note path/to/note.out --text "新しいノード" --parent "親ノード"

# ノードだけ追加（兄弟として基準ノードの直後に挿入）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs --note path/to/note.out --text "新しいノード" --parent "基準ノード" --position after

# MD付きページノード（親の子として）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs --note path/to/note.out --md file.md --parent "親ノード"

# MD付きページノード（兄弟として指定ノードの直後に挿入）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs --note path/to/note.out --md file.md --parent "基準ノード" --position after

# テキスト指定 + MD付き（H1 の代わりに指定テキストをノード名にする）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs --note path/to/note.out --md file.md --text "カスタム名"

# 一括登録（グループ名指定）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs --note path/to/note.out --md "docs/*.md" --group-name "リサーチ結果"

# 一括登録（複数ファイル明示）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-md.mjs --note path/to/note.out --md file1.md file2.md file3.md --parent "親ノード"
```

---

## 処理フロー

### 共通処理

#### 1. .out ファイルを読み込む

- `.out` 拡張子がなければ自動付与
- ファイルが存在しない場合はエラー

#### 2. pages ディレクトリを特定する

`.out` ファイルの JSON 内に `pageDir` フィールドがあればそれを使用。なければ `.out` ファイルと同じディレクトリの `./pages` をデフォルトとする。

#### 3. ノードテキストの決定

| `--text` | `--md` | ノードテキスト |
|-----------|--------|----------------|
| 指定あり | あり/なし | `--text` の値 |
| 未指定 | あり | MD の H1 → なければファイル名 |
| 未指定 | なし | 空文字 |

#### 4. ノードID を生成する

```javascript
// フォーマット: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
```

#### 5. MD ファイル処理（`--md` 指定時のみ）

1. **Markdown 正規化**: テーブルのセル内改行正規化（本体 `markdown-import.ts` と同等処理）
2. **画像処理**: `![alt](path)` を検出し、画像を `pages/images/` にコピー、相対パスに書き換え
3. **ページID 生成**: `crypto.randomUUID()`
4. **ページファイル保存**: `pages/{pageId}.md` に変換後コンテンツを保存

#### 6. ノードオブジェクトを作成する

```json
{
  "id": "生成したノードID",
  "parentId": "挿入位置に応じた値",
  "children": [],
  "text": "決定したテキスト",
  "tags": [],
  "isPage": true/false,
  "pageId": "UUID or null",
  "collapsed": false,
  "checked": null,
  "subtext": ""
}
```

#### 7. 差し込み位置

| `--position` | `--parent` | 動作 |
|--------------|------------|------|
| `child`（デフォルト） | 未指定 | ルートの先頭に挿入 |
| `child` | 指定あり | そのノードの children 先頭に挿入 |
| `after` | 未指定 | ルートの末尾に挿入 |
| `after` | 指定あり | そのノードのすぐ下の兄弟として挿入 |

---

### 単一登録モード

**条件**: MD ファイルが0または1つ

1. テキスト決定（`--text` > H1 > ファイル名 > 空文字）
2. `--md` があれば MD 処理（正規化・画像・ページファイル作成）
3. ノードオブジェクト作成（`--md` あれば `isPage: true`）
4. `--position` に応じて配置

---

### 一括登録モード

**条件**: MD ファイルが2つ以上

1. **代表ノード**を作成（`isPage: false`）
   - テキスト: `--group-name` > `--text` > `"Imported"`
   - `--position` に応じて配置
2. 各 MD ファイルについて:
   - MD 処理（正規化・画像・ページファイル作成）
   - ノードオブジェクト作成（`isPage: true`, 代表ノードの子として末尾追加）

---

## 差し込み位置の解決（`--parent`）

| 値 | 動作 |
|----|------|
| 未指定 | ルートに挿入 |
| ノードID（`n` で始まる） | そのノードを基準に挿入 |
| テキスト文字列 | `nodes` を走査して完全一致 or 部分一致するノードを探す |

---

## 注意事項

- `.out` ファイルは VSCode/Electron で開いていない状態で操作すること（ファイル競合防止）
- `pages/images/` ディレクトリが存在しない場合は自動作成する
- 画像処理は本体の import md と同じ: ローカル画像をコピー＆リネーム、URL 画像はそのまま
- 既存のノードやページIDと衝突しないことは UUID で保証される
