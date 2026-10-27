---
name: fractal
description: Fractal（VS Code 拡張のノートアプリ。Notes フォルダ・Outliner の .out・outline.note・page md・画像 / 添付）を読む・探す・書くときの手順と規約。ユーザーが Fractal / フラクタル / ノート / アウトライナー / .out / outline.note / note の md・ページ・添付に触れたら使う。構造を変える操作は fractal MCP の tool で行い、md の本文だけは直接編集してよい。
---

# Fractal を操作する

Fractal のデータはファイル（JSON の台帳 + md + 画像・添付）だが、ファイルをまたいだ決まりごとが多い（outline.note の登録・.out の親子と id・page md と node の 1:1・`images/` `files/` の置き場所・📎 の印・H1 とタイトルの同期）。**構造を変える操作は必ず fractal MCP の tool で行う。** tool は拡張機能と同じコードを通るので、画面で操作したのと同じ結果になる。

データモデルの詳細は `fractal_structure` tool か [references/structure.md](references/structure.md)。最初に一度読む。

## 何で操作するか

| やりたいこと | 使うもの |
|---|---|
| Notes フォルダ・note を見つける | `fractal_list_folders` → `fractal_list_notes` |
| タイトルや名前から対象を特定する | `fractal_resolve`（完全一致が既定） |
| 中身を読む（.out のノード木・md の本文・H1・subpage・contentHash） | `fractal_get` |
| 探す（本文・タグ・チェック状態・添付の中身） | `fractal_search` |
| 全体を 1 本の md で読む（要約・質問への回答用） | `fractal_summary` |
| ノードを足す・page を取り込む・新しい .out / md・subpage | `fractal_add` |
| ノードの本文・チェック・削除・移動・ページ化 / 解除・md との変換・別の .out / note への移動 | `fractal_modify` |
| 画像・ファイルを添付する（node / md） | `fractal_attach` |
| ツリー（outline.note）の改名・削除・並べ替え・フォルダ・複製・別 note への移動 | `fractal_tree` |
| 整合性を確かめる（読むだけ） | `fractal_doctor` |
| **md の本文を書き換える** | **自分の Read / Edit で直接**（下の「md の本文」） |

## 基本の手順

1. **特定する**: `fractal_resolve {query, kind}` で対象（note / item / node / page / 見出し）を引く。`AMBIGUOUS` なら candidates をユーザーに見せて選んでもらう（推測で選ばない）。
2. **読む**: `fractal_get` で中身と `contentHash` を得る。
3. **書く**: 書き込み系 tool に `expectedHash: <contentHash>` を付ける。`CONFLICT` が返ったら誰か（ユーザーの画面など）が先に変えている — `fractal_get` で読み直してからやり直す。
4. **次へ**: 返り値の JSON（`nodeId` / `pageId` / `absPath` / `changed[].contentHash`）を次の操作に使う。id を自分で作らない。検索で取り直さない。
5. **削除・移動・ページ解除・ツリー操作**は、先に `dryRun: true` で何が変わるか（`changed` / `trashed`）を確かめ、必要ならユーザーに確認する。削除は OS のゴミ箱へ移る（戻せる）。

## md の本文

md の本文は普通の Markdown なので、自分の Read / Edit で直接書き換えてよい。VS Code で開いて入力中でも、Fractal は外部の変更を取り込んで合成する。ただし次は tool で行う:

- **H1 を変える**: md item なら `fractal_tree` の `rename`、page md なら `fractal_modify` の `set-text`（page ノード）。ツリーのタイトルや page ノードの本文と同期させるため。tree にも page にも属さない md（subpage など）の H1 は直接でよい。
- **画像・ファイル・subpage を足す**: `fractal_attach`（`targetMd`。`heading` / `mdPosition` で位置）/ subpage は `fractal_add` に `targetMd` を付ける。添付は `[📎 名前](files/..)`、画像は `images/` に置く決まりがあり、手で書くと画面の Cleanup に孤児と判定されて消える。
- **既存の画像・添付・subpage のリンクを消す・書き換える**: リンクだけ消すと実体が孤児になる。消すときは消したあと `fractal_doctor` で確かめ、孤児の扱いはユーザーと相談する。

## してはいけないこと

- `.out` と `outline.note` を直接書く（JSON の台帳。id・親子・登録・page の持ち主関係が壊れる）
- id（node / page / item）を自分で作る
- 本文やタイトルの部分一致で勝手に対象を決める（`match: prefix | contains` を使うのは、ユーザーが曖昧な言い方を許したときだけ）
- `images/` `files/` にファイルを直接置く・消す
- Notes フォルダの外に書く（tool は拒否する）

## よくある依頼の流れ

- 「〇〇の md の『結論』の下に追記」: `fractal_resolve {query:"〇〇", kind:"item"}` → `fractal_get {path}` → Edit で「## 結論」の下に追記
- 「このノードをページにして画像を添付」: `fractal_resolve {query, kind:"node"}`（`outPath` と `nodeId` が返る）→ `fractal_get {path:outPath}` → `fractal_modify {note:outPath, target:nodeId, op:"make-page", expectedHash}` → 返り値の `pageMdPath` に `fractal_attach {targetMd:pageMdPath, images:[...]}`
- 「議事録を別の note に移動」: `fractal_resolve` で item（`itemId` と `noteDir`）と移動先の note を特定 → `fractal_tree {noteDir, item:itemId, op:"move-to-note", toNoteDir, dryRun:true}` → 確認 → `dryRun` を外して実行
- 「タスクを全部チェック済みに」: `fractal_search {checked:"false"}` → 各ノードに `fractal_modify {note:<.out の path>, target:<nodeId>, op:"check", expectedHash}`（同じ .out への連続書き込みは、前の返り値の `changed[].contentHash` を次の expectedHash に）
- 「ノートの整合性を見て」: `fractal_doctor` → findings をユーザーに説明（直すのは相談してから）

## エラーの code

| code | 意味 | 次にすること |
|---|---|---|
| `CONFLICT` | 読んだ後に誰かが変えた | `fractal_get` で読み直してやり直す |
| `AMBIGUOUS` | 2 件以上に一致 | candidates から選ぶ / ユーザーに聞く |
| `NOT_FOUND` | 一致なし | message を見る・名前を確かめる（`match` は勝手に緩めない） |
| `OUTSIDE_NOTES` | Notes フォルダの外 | 対象を見直す |
| `INVALID` | 引数・操作が不正（例: page ノードへの添付の append） | message に従って直す |
| `TRASH_UNAVAILABLE` | ゴミ箱が使えず削除できない | ユーザーに伝える |
