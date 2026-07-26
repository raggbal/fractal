---
name: fractal-summary
description: Fractal の Outliner（.out）または md（subpage 再帰込み）の全内容を 1 本の Markdown にまとめる（read-only）。「このアウトライン/ノートを要約して」に答えるための入力作り
---

# fractal-summary — 全内容を 1 本の md にまとめる（read-only）

> **🔴 先に読むこと**: Fractal のデータ構造を把握していない場合、最初に **`fractal-structure` スキル**を呼んでください。

「このアウトラインを要約して」「このノート全体を読んで◯◯して」という依頼のとき、AI が .out の JSON や散らばった page/subpage md を個別に読み解く代わりに、**まずこれで 1 本の md に集約してから読む**。

## 使い方

```bash
# Outliner 全体を stdout へ
node ${CLAUDE_SKILL_DIR}/scripts/fractal-summary.mjs --note /path/to/note.out

# 特定ノード配下の部分木のみ
node ${CLAUDE_SKILL_DIR}/scripts/fractal-summary.mjs --note note.out --node "リサーチ"

# md を起点に subpage を再帰的に辿って全部まとめる
node ${CLAUDE_SKILL_DIR}/scripts/fractal-summary.mjs --md /path/to/note/xxx.md

# ファイルへ
node ${CLAUDE_SKILL_DIR}/scripts/fractal-summary.mjs --md xxx.md --out /tmp/summary.md
```

## 2 つのモード

### `--note <path.out>` — Outliner モード

```markdown
# <outline title>

- 親ノード
  - [x] 終わったタスク
  - [ ] 未完タスク
  - ページノード *(→ Pages)*

## Pages

### ページノード

<page md 本文>
```

- ノード階層 = ネスト箇条書き（2sp インデント）、`checked` は `- [x]` / `- [ ]`
- page ノードの本文は `## Pages` セクションに `### <node text>` で展開
- `--node <id|text>` で部分木だけに絞れる

### `--md <path.md>` — md モード（subpage 再帰）

起点 md の本文に続けて、本文中の subpage リンク `[[label]](x.md)` を**再帰的に辿り**、全 subpage の本文を `## Subpages` セクションに展開する。

- 相対リンクは「各 md の場所」基準で解決（本体と同規約）
- 循環参照・重複リンクは 1 回だけ展開（visited 打ち切り）
- リンク先が無い subpage は `*(subpage md not found)*` と注記

## 共通仕様

- **read-only**（元データには書き込まない。`--out` のファイルのみ生成）
- 本文中の相対 `![]()` / `[]()` は**絶対パスに書き換え**（まとめ md をどこに置いても画像・添付が切れない）。URL は不変
- `--out` 省略時は stdout（そのままパイプ・リダイレクト可）

## 注意

- 新フラットレイアウト前提（page md = `<note>/<pageId>.md`）。未移行 note は fractal-doctor で検出し、本体でフラット化してから使う
