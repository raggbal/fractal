---
name: arxiv-md
description: Download a paper from an arXiv URL (abs / pdf / ID) and convert it to Markdown via the doc-md skill. Handles arXiv-specific URL normalization, prepends YAML front matter + header block with title / authors / abstract / links.
argument-hint: <arxiv_url_or_id> [-o output_dir] [--keep-pdf] [--no-title] [--no-abstract] [--no-front-matter] [--to-fractal-*]
---

# arxiv-md

arXiv の論文 URL（`https://arxiv.org/abs/2401.08822v1` のような abs / pdf / ID 形式）を受けて、
PDF をダウンロード → `doc-md` スキルで Markdown に変換し、arXiv API から取得した
メタデータ（title / authors / abstract / categories / published / updated）を
YAML front matter + 可読ヘッダとして先頭に埋め込む。

## Scripts

- [scripts/fetch_arxiv.py](scripts/fetch_arxiv.py) — メインスクリプト。URL 解析 / PDF 取得 / `doc-md/scripts/convert.py` 呼び出し / タイトル付きファイル名へのリネーム / front matter + ヘッダ挿入を担当
- [scripts/register-fractal.mjs](scripts/register-fractal.mjs) — Optional: register the converted MD into a Fractal outliner under `date > title > md`

## Prerequisites

本スキルは `doc-md` スキルに依存する。**先に doc-md の依存をインストール**しておくこと。

```bash
pip install -r <SKILL_DIR>/../doc-md/scripts/requirements.txt
```

`<SKILL_DIR>` はこのスキルのベースディレクトリ。user-level インストールなら `~/.claude/skills/arxiv-md/` に相当する。
このスキル自身は Python 標準ライブラリのみで動作する（Docling の依存は doc-md 側に集約）。

## Basic Usage

```bash
# abs URL から
python <SKILL_DIR>/scripts/fetch_arxiv.py https://arxiv.org/abs/2401.08822v1

# pdf URL から
python <SKILL_DIR>/scripts/fetch_arxiv.py https://arxiv.org/pdf/2401.08822v1.pdf

# arXiv ID を直接
python <SKILL_DIR>/scripts/fetch_arxiv.py 2401.08822

# 出力先指定 + PDF も残す
python <SKILL_DIR>/scripts/fetch_arxiv.py 2401.08822 -o ./papers --keep-pdf

# front matter と abstract 埋め込みを無効化（素の Markdown が欲しい時）
python <SKILL_DIR>/scripts/fetch_arxiv.py 2401.08822 --no-front-matter --no-abstract
```

## Options

| Option | Description |
|---|---|
| `-o`, `--output-dir` | 出力ディレクトリ (既定: カレント) |
| `--keep-pdf` | ダウンロードした PDF も出力先に残す（既定: 一時ディレクトリで破棄） |
| `--no-title` | arXiv API からメタデータ取得をスキップし、ファイル名を `<arxiv_id>.md` のみにする（front matter も最小化） |
| `--no-abstract` | 冒頭に Abstract 本文の埋め込みをしない（既定は埋め込む） |
| `--no-front-matter` | YAML front matter を付与しない（既定は付与する） |
| `--to-fractal-out` | Direct path to a target `.out` file (Fractal outliner) |
| `--to-fractal-notes` | Notes folder path (used with `--to-fractal-outline`) |
| `--to-fractal-outline` | Outline title; auto-creates if not found in the Notes folder |
| `--to-fractal-title` | Title node text under the date node (default: paper title) |
| `--to-fractal-date` | Override date node text (default: today, `YYYY-MM-DD`) |

## Accepted Input Formats

以下はすべて同じ論文を指すものとして扱う。

- `https://arxiv.org/abs/2401.08822`
- `https://arxiv.org/abs/2401.08822v1`
- `https://arxiv.org/pdf/2401.08822v1.pdf`
- `http://arxiv.org/abs/2401.08822v1`
- `2401.08822` / `2401.08822v1`
- 旧 ID 形式: `hep-th/9901001`

## Execution Steps

ユーザーから arXiv URL / ID が渡されたら次の手順で実行する。

1. **事前チェック**: 対象プロジェクト直下 `.claude/skills/doc-md/` が存在するかを確認。存在しなければ user-level (`~/.claude/skills/doc-md/`) を使う。どちらも無ければ「doc-md スキルを先にインストールしてください」と返してここで停止する。
2. **変換実行**:
   ```bash
   python <SKILL_DIR>/scripts/fetch_arxiv.py <source> [-o <output_dir>] [--keep-pdf]
   ```
3. 出力された `.md` を軽く確認し、ファイル名・保存先・arXiv ID・タイトル・著者を報告する。
4. PDF 変換は Docling がページごとに数秒〜数十秒かかることを伝える（長いログが出ても待つ）。
5. **If `--to-fractal-out` OR (`--to-fractal-notes` + `--to-fractal-outline`) was given:** Run `register-fractal.mjs` to add the converted MD to a Fractal outliner (see "Register to Fractal" section below).
   - **NOTE:** This skill does NOT consult the `FRACTAL_DEFAULT_OUT` environment variable on its own. The caller (typically `/collect`) is responsible for resolving env defaults and passing an explicit `--to-fractal-out <path>` (or notes/outline pair).

### `/collect` から呼ばれた場合の挙動

`/collect` から委譲された場合は `-o .collected/arxiv` を付けて呼び出すこと。

```bash
python <SKILL_DIR>/scripts/fetch_arxiv.py <source> -o .collected/arxiv
```

`/collect` から `--to-fractal-*` 系オプションも渡された場合は、変換完了後に「Register to Fractal」セクションの手順で `register-fractal.mjs` を実行する。

## Output

既定では出力先ディレクトリに次が生成される。

- `<arxiv_id>-<slug>.md` — 変換後の Markdown（タイトル取得に成功した場合）
- `<arxiv_id>.md` — タイトル取得に失敗 / `--no-title` 指定時
- `<same-stem>.pdf` — `--keep-pdf` 指定時のみ

MD の冒頭には次の構造が自動挿入される（既定動作）。

```markdown
---
arxiv_id: "2401.08822"
abs_url: "https://arxiv.org/abs/2401.08822"
pdf_url: "https://arxiv.org/pdf/2401.08822.pdf"
title: "<論文タイトル>"
authors:
  - "Author 1"
  - "Author 2"
categories: ["cs.AI", "cs.LG"]
published: "2024-01-16T00:00:00Z"
updated: "2024-01-20T00:00:00Z"
---

# <論文タイトル>

- arXiv ID: `2401.08822`
- Authors: Author 1, Author 2
- Abstract: https://arxiv.org/abs/2401.08822
- PDF: https://arxiv.org/pdf/2401.08822.pdf

## Abstract

<arXiv API から取得した abstract 本文>

---

<doc-md が生成した Markdown 本文>
```

`--no-front-matter` を指定すれば YAML ブロックを、`--no-abstract` を指定すれば `## Abstract` セクションを、それぞれ省略できる。

## Register to Fractal

When any `--to-fractal-*` option is given, after the paper MD is generated run:

```bash
node <SKILL_DIR>/scripts/register-fractal.mjs --mode single \
  --md <converted .md path> \
  --fractal-title "<title-node-text>" \
  [--fractal-out <path.out> | --fractal-notes <folder> --fractal-outline <title>] \
  [--fractal-date YYYY-MM-DD]
```

The script creates this structure in the target outliner:

```
<outline-root>
└── YYYY-MM-DD            ← reused if a root-level node with this exact text exists
    └── <fractal-title>   ← always newly created (default: paper title)
        └── arXiv MD      ← page node containing the paper
```

### Outline targeting

Pick exactly one (otherwise the script errors):

- `--fractal-out <path.out>` — write to an existing outliner directly
- `--fractal-notes <folder> --fractal-outline <title>` — look up `outline.note` for a file item with the given `title`; auto-creates the outline if none matches

This script does NOT read `FRACTAL_DEFAULT_OUT`. The caller (`/collect` or the user) must resolve any env-driven default and pass `--fractal-out` explicitly.

### Title node default

If `--to-fractal-title` is not provided, derive it from the paper title (the H1 of the converted MD, equal to the arXiv `title` metadata) or fall back to the arXiv ID.

### Notes

- Auto-resolves `fractal-edit/scripts/fractal-md.mjs` via the sibling skill location or `~/.claude/skills/fractal-edit/scripts/fractal-md.mjs`. Override with `--fractal-md-script <path>`.

## Design Notes

- **doc-md の convert.py を subprocess で呼ぶ**: 責務分離のためロジックを再実装しない。解決順は `DOC_MD_CONVERT` env → 兄弟 `../../doc-md/scripts/convert.py` → `~/.claude/skills/doc-md/scripts/convert.py`。
- **メタデータは arXiv Atom API** (`http://export.arxiv.org/api/query?id_list=...`) から取得。失敗しても処理は継続し、ファイル名は arXiv ID のみ、front matter も最小化される。
- **PDF は User-Agent ヘッダ付きで取得**: arXiv は UA なしアクセスに制限をかける場合があるため明示。
- **PDF は既定で一時ディレクトリに置き、MD 生成後に破棄**する。残したい場合は `--keep-pdf`。
- **ファイル名の slug 化**: タイトルから記号を除去しスペースを `-` に、80 文字で打ち切り。
- **旧スタイル ID 対応**: `hep-th/9901001` のようなスラッシュ入り ID は一時 PDF 名で `_` に置換してから保存し、arXiv 側の URL は元のまま使う。
- **front matter + abstract 埋め込み**: LLM / 検索エンジンが論文の主要情報（タイトル・著者・abstract）を本文を読まずに取り出せるよう、冒頭に構造化データを置く。

## Notes

- 依存ライブラリは `doc-md` 側のもののみ（Docling 等）。このスキル自体は標準ライブラリだけで動く。
- arXiv のレート制限に引っかかった場合はしばらく待って再試行する。
- 数式・多段組・図表の再現品質は Docling の性能に依存する。表現が崩れた場合は元 PDF と突き合わせて確認すること。
