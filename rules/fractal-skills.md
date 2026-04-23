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

## スキル一覧と呼び出し順

インストール済みの 3 スキル（`Skill` ツールから呼ぶ）:

| スキル名 | 用途 | いつ呼ぶか |
|---------|------|-----------|
| **fractal-structure** | データ構造／Notes フォルダ場所の **リファレンス**（SKILL.md のみ、スクリプトなし） | **他のスキルを呼ぶ前に必ず先読み**。`.out` / `outline.note` / ノードの 4 種類 / `pageDir` 解決 / 画像・ファイル相対パス基準を把握するため |
| **fractal-search** | Notes フォルダ横断全文検索（outline / node / page / loose md） | 「Fractal で〜を検索して」「どの outline に〜がまとまってる？」 |
| **fractal-edit** | `.out` / `outline.note` への **全書き込み**操作（node / MD page / 画像 / ファイル / 新規 outline） | 「ノード追加」「MD を page として取り込み」「画像／PDF を貼って」「新しい outliner 作って」 |

fractal-edit の内部スクリプト（`${CLAUDE_SKILL_DIR}/scripts/` 配下）:
- `fractal-md.mjs` — ノード／MD ページ／新規 `.out` 作成
- `fractal-attach.mjs` — 画像ノード／ファイル添付／既存ノードへの後付け

### 呼び出し順の原則

```
(任意のfractal依頼)
   │
   ▼
1. fractal-structure を先に読む (Skill ツール) ← 構造がすでに頭に入っていれば省略可
   │
   ▼
2. 目的に応じて fractal-search or fractal-edit を呼ぶ
   │
   ▼
3. 実際の操作 (スクリプト実行 or Read/Edit)
```

---

## 絶対禁止事項

- ❌ **ID を推測で生成しない**: ノード ID / pageId は各スキプトが生成する（`crypto.randomUUID()` / `n` + time+random）。手書きしない
- ❌ **`.out` を Fractal で開いた状態で外部編集しない**: 競合して壊れる。事前にユーザーへ確認（「Fractal を閉じてから実行していい？」）
- ❌ **マスター `outline.note` を壊す**: 新規 `.out` を追加したら必ず `outline.note` の `rootIds` / `items` にも登録する（fractal-md の `--create-outliner` は自動でやる）
- ❌ **相対パスの基準を混同する**: ノードの `images[]` と `filePath` は `.out` ディレクトリ基準、Page MD 内の `![](…)` は `pageDir` 基準 — 間違えると画像が表示されない
- ❌ **ノード種別の相互排他を壊す**: 1 ノードに `isPage:true` と `filePath` を同時に入れない。`fractal-structure` §5 参照

---

## Notes フォルダの場所の決定

ユーザーが対象フォルダを明示していない場合の解決順:

1. **Electron アプリ**: `~/Library/Application Support/fractal-desktop/config.json` の `notesFolders[]`
2. **VSCode / Cursor / Kiro**: `~/Library/Application Support/{Code,Cursor,Kiro}/User/globalStorage/state.vscdb` の `imaken.fractal` キー → `notesFolders[]`
3. 見つからなければ **ユーザーに聞く**（推測で始めない）

`fractal-search --list-folders` で登録済みフォルダを一覧できる。

---

## テキスト参照で親ノードを探す時

`--parent "ノードテキスト"` / `--target "ノードテキスト"` 指定時:

1. まず **完全一致**を探す
2. なければ**部分一致（includes）**を使う
3. どちらも見つからなければエラー停止（勝手に root にフォールバックしない）

曖昧な場合は **ユーザーに nodeId を聞く**。

---

## CLI パスのヒント

スキルスクリプトの実体:

```
~/.claude/skills/fractal-structure/SKILL.md           # ドキュメントのみ（スクリプトなし）
~/.claude/skills/fractal-search/scripts/fractal-search.mjs
~/.claude/skills/fractal-edit/scripts/fractal-md.mjs      # node / MD page / 新規 outline
~/.claude/skills/fractal-edit/scripts/fractal-attach.mjs  # 画像 / ファイル添付
```

プロジェクトローカル install の場合は `<project>/.claude/skills/...` 配下。

Skill ツール経由で呼ぶ場合はスキル名 (`fractal-search` / `fractal-edit` 等) を指定すれば、SKILL.md がコンテキストにロードされ、正しい `node ... *.mjs ...` コマンドが分かる。

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| 画像が Fractal 上で表示されない | 相対パス基準を間違えた（`.out` 基準 vs `pageDir` 基準） | `fractal-structure` §5 / §9 を再読 |
| 新規 `.out` がフォルダパネルに出ない | `outline.note` 未更新 | `fractal-md --create-outliner` で作り直す（`outline.note` を自動更新） |
| 検索で page がヒットしない | `pageDir` 共有時に他 outline の page を弾いている（仕様） | 対象 outline の node に `pageId` リンクがあるか確認 |
| `--parent` で対象が見つからない | text 完全一致 → 部分一致の順で探すが、両方失敗 | nodeId で指定 or ユーザーに正確なテキストを聞く |

---

## このルールのメンテ

- 追加・修正は repo 側（`~/fractal/rules/fractal-skills.md`）を編集
- symlink 経由で `~/.claude/rules/` に反映される（install.sh が貼る）
- install.sh の `--mode copy` 指定時は、rules 修正後に再 install が必要
