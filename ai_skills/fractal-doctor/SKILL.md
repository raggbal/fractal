---
name: fractal-doctor
description: Fractal note の整合性チェック（read-only）。未移行レイアウト検出、壊れた参照（画像/添付/page md）、孤児アセット、outline.note 不整合、1:1 所有違反を検査してレポートする
---

# fractal-doctor — note 整合性チェック（read-only）

> **🔴 先に読むこと**: Fractal のデータ構造を把握していない場合、最初に **`fractal-structure` スキル**を呼んでください。

Fractal の note フォルダを検査して問題をレポートする。**一切書き込まない**（自動修復はしない — 修復は結果を見てユーザーと相談の上、fractal-edit / 本体 UI / 手動で行う）。

## 使い方

```bash
# 人間可読レポート
node ${CLAUDE_SKILL_DIR}/scripts/fractal-doctor.mjs --note-dir /path/to/note

# 機械可読（JSON）
node ${CLAUDE_SKILL_DIR}/scripts/fractal-doctor.mjs --note-dir /path/to/note --json
```

登録済み note フォルダの見つけ方は `fractal-structure` §1（Electron config / VSCode state.vscdb）。

## 検査項目

| check | level | 内容 |
|-------|-------|------|
| `layout` | WARN/INFO | .out にフラットヒント（`pageDir:"."`）が無く legacy dir（`<stem>/`・`pages/`・`_notes_md/`）が実在 = **未移行**。外部ツール（clipper / ai_skills）は新フラット前提なので、本体の移行ゲートで先にフラット化する |
| `refs` | ERROR/WARN | node.images / node.filePath / node.pageId の実体不在（ERROR）。page md・独立 md 本文内のローカル相対リンク切れ（WARN） |
| `orphans` | INFO | どの node / md 本文からも参照されない `images/`・`files/` のファイル、outline.note にも .out にも紐づかない note 直下 md |
| `structure` | ERROR/WARN | outline.note items の .out/.md 実体不在（ERROR）、未登録 .out（WARN）、folder childIds の宙ぶらりん参照（ERROR） |
| `ownership` | WARN | 同一アセットを複数 node が参照（1:1 所有原則の違反 — move/delete で片方が壊れる） |

## 終了コード

| code | 意味 |
|------|------|
| 0 | クリーン |
| 1 | WARN のみ |
| 2 | ERROR あり（or 引数エラー） |

## 想定ワークフロー

1. **書き込み前プリフライト**: fractal-edit / clipper で書く前に doctor を回し、`layout` WARN（未移行）が出たら本体でフラット移行してから書く
2. **定期健診**: `--json` で findings を取り、ERROR（参照切れ）から順にユーザーへ報告
3. **削除後の孤児確認**: fractal-modify の `--delete` は物理ファイルを消さないので、doctor の `orphans` で残骸を確認 → 消すかはユーザー判断

## 注意

- read-only 保証: このスクリプトは fs の書込・削除・mkdir API を持たない
- 検査は 1 note フォルダ単位（複数 note は folder ごとに実行）
- 大量ページの note では page md 本文の読み取りに時間がかかる（キャッシュなし・都度精査）
