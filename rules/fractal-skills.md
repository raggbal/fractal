# Fractal Skills — Global Rules

> Claude Code 用 Fractal スキル群の運用ルール。
>
> このファイルが `~/.claude/rules/fractal-skills.md` に配置されると（通常 `install.sh` の symlink）、Claude Code の起動時に自動でセッション context に注入される。
>
> 書き手: Fractal リポジトリ (`~/fractal/rules/fractal-skills.md`)。修正は repo 側で行い、symlink 経由で反映される。

---

## このルールがいつ発動するか

以下のいずれかに該当するユーザー依頼・ファイル参照があったら、**このルールが適用中**と見なして下記スキル群を活用する:

- `.out` ファイル（Fractal アウトライナー本体、JSON）
- `outline.note` ファイル（フォルダ／ファイルツリー構造、JSON）
- `<pageId>.md`（Fractal の page MD = UUID ファイル名の .md）
- Fractal Notes フォルダ（`~/Desktop/notes`, `~/Desktop/tasks` 等、ユーザー登録済み）
- VSCode 拡張 `imaken.fractal` の設定、Electron アプリ `fractal-desktop` の設定
- 「Fractal」「フラクタル」「fractal outliner」等の文字列による明示言及
- Fractal レポジトリ自体の開発 (`~/fractal/`)

---

## tools（fractal MCP）と呼び出し順

Fractal の操作は skill ではなく MCP サーバー **fractal** の tools で行う（`ai_skills/install.sh` が Claude Code / Kiro / Cursor に登録する）:

| tool | 用途 |
|------|------|
| **fractal_structure** | データ構造／Notes フォルダの場所の **リファレンス**。他の tool を使う前に一度読む |
| **fractal_list_folders** / **fractal_list_notes** / **fractal_search** | Notes フォルダ・note の一覧と横断全文検索（outline / node / page / loose md / 添付） |
| **fractal_add** / **fractal_modify** / **fractal_attach** | `.out` / `outline.note` への **全書き込み**（node / MD page / 画像 / ファイル / 新規 outline・md、本文書換・チェック・削除・移動） |
| **fractal_summary** / **fractal_doctor** | 全内容を 1 本の md に（要約の入力）／ note の整合性チェック（どちらも read-only） |

```
(任意のfractal依頼)
   │
   ▼
1. fractal_structure を読む ← 構造がすでに頭に入っていれば省略可
   │
   ▼
2. 目的に応じて fractal_search / fractal_add / fractal_modify 等を呼ぶ
```

---

## 絶対禁止事項

- ❌ **ID を推測で生成しない**: ノード ID / pageId は各 tool（の裏の script）が生成する（`crypto.randomUUID()` / `n` + time+random）。手書きしない
- ❌ **`.out` を Fractal で開いた状態で外部編集しない**: 競合して壊れる。事前にユーザーへ確認（「Fractal を閉じてから実行していい？」）
- ❌ **マスター `outline.note` を壊す**: 新規 `.out` を追加したら必ず `outline.note` の `rootIds` / `items` にも登録する（`fractal_add` の createOutliner は自動でやる）
- ❌ **相対パスの基準を混同する**: ノードの `images[]` と `filePath` は `.out` ディレクトリ基準、Page MD 内の `![](…)` は `pageDir` 基準 — 間違えると画像が表示されない
- ❌ **ノード種別の相互排他を壊す**: 1 ノードに `isPage:true` と `filePath` を同時に入れない。`fractal_structure` §5 参照

---

## Notes フォルダの場所の決定

ユーザーが対象フォルダを明示していない場合の解決順:

1. **Electron アプリ**: `~/Library/Application Support/fractal-desktop/config.json` の `notesFolders[]`
2. **VSCode / Cursor / Kiro**: `~/Library/Application Support/{Code,Cursor,Kiro}/User/globalStorage/state.vscdb` の `imaken.fractal` キー → `notesFolders[]`
3. 見つからなければ **ユーザーに聞く**（推測で始めない）

`fractal_list_folders` で登録済みフォルダを一覧できる。

---

## テキスト参照で親ノードを探す時

`parent` / `target` にノードのテキストを渡した時:

1. まず **完全一致**を探す
2. なければ**部分一致（includes）**を使う
3. どちらも見つからなければエラー停止（勝手に root にフォールバックしない）

曖昧な場合は **ユーザーに nodeId を聞く**。

---

## CLI パスのヒント

tool の実体は `ai_skills/fractal-mcp/scripts/*.mjs`（install 後は `~/.fractal/fractal-mcp/scripts/` からも辿れる）。MCP が使えない環境では `node <script> --help` を見て直接実行してよい。

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| 画像が Fractal 上で表示されない | 相対パス基準を間違えた（`.out` 基準 vs `pageDir` 基準） | `fractal_structure` §5 / §9 を再読 |
| 新規 `.out` がフォルダパネルに出ない | `outline.note` 未更新 | `fractal_add` の createOutliner で作り直す（`outline.note` を自動更新） |
| 検索で page がヒットしない | `pageDir` 共有時に他 outline の page を弾いている（仕様） | 対象 outline の node に `pageId` リンクがあるか確認 |
| `--parent` で対象が見つからない | text 完全一致 → 部分一致の順で探すが、両方失敗 | nodeId で指定 or ユーザーに正確なテキストを聞く |

---

## このルールのメンテ

- 追加・修正は repo 側（`~/fractal/rules/fractal-skills.md`）を編集
- symlink 経由で `~/.claude/rules/` に反映される（install.sh が貼る）
- install.sh の `--mode copy` 指定時は、rules 修正後に再 install が必要
