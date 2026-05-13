---
name: collect
description: "Collect external materials (websites, YouTube, arXiv papers, PDF/Office) into .collected/ as Markdown. Auto-routes to web-crawler-md, youtube-md, arxiv-md, or doc-md based on input type."
argument-hint: <URL or file path> [--summarize] [--limit N] [--scope PATTERN]
---

# /collect — 素材収集

## このスキルの機能

外部素材（Webサイト、YouTube動画、arXiv 論文、PDF/Office文書）を Markdown に変換し、`.collected/` に保存する。
保存した素材は `/researcher` の explorer が自動的に検索対象にする。

## ルーティングロジック

| 入力の特徴 | 委譲先 | 判定 |
|-----------|--------|------|
| `youtube.com` or `youtu.be` URL | `/youtube-md` | URL パターン |
| `arxiv.org` / `export.arxiv.org` の URL、または `arxiv:XXXX.XXXXX` / 裸の arXiv ID (`2506.23083`) | `/arxiv-md` | URL / ID パターン |
| `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.png` 等 | `/doc-md` | 拡張子 |
| URL 末尾が `/llms.txt` または `/llms-full.txt` | `/web-crawler-md` (llms.txt モード) | URL パターン |
| その他の `http://` or `https://` URL | `/web-crawler-md` | URL パターン |

**ルーティングの優先順位**: 上から順に評価（arXiv URL は `https://arxiv.org/abs/...` で `.pdf` 拡張子を含まないが、`https://arxiv.org/pdf/2506.23083.pdf` のように `.pdf` で終わる URL でも arxiv-md に委譲すること — arxiv-md は front matter でメタデータを付与するため doc-md より適切）。

**llms.txt 自動検出**: 通常の Web URL が渡された場合でも、web-crawler-md は内部で対象サイトの `/<dir>/llms.txt` / `/llms.txt` を probe し、見つかれば llms.txt モードに自動切替する（BFS クロールより圧倒的に高速・正確）。ユーザーが直接 `…/llms.txt` を渡した場合は probe をスキップしてそのまま llms.txt モードへ。

## 使い方

```bash
# Webサイトを収集
/collect https://docs.stripe.com/api

# YouTube 動画の文字起こし
/collect https://www.youtube.com/watch?v=xxx --summarize

# arXiv 論文を取得
/collect https://arxiv.org/abs/2506.23083
/collect 2506.23083                       # 裸の ID も可

# PDF を変換
/collect ./docs/api-spec.pdf

# 1 ページだけ（動作確認・サンプリング用途）
/collect https://docs.stripe.com/api --limit 1

# 数ページだけクロール
/collect https://docs.stripe.com/api --limit 10

# スコープ (glob) を絞って小さくクロール
/collect https://docs.stripe.com/api --scope "https://docs.stripe.com/api/charges/*"

# 複数を一度に（並列実行）
/collect https://docs.stripe.com/api https://www.youtube.com/watch?v=xxx ./spec.pdf

# Fractal outliner に登録 (Notes フォルダ + outline タイトル指定 / outline は自動作成)
/collect https://docs.stripe.com/api \
  --to-fractal-notes ~/Desktop/notes --to-fractal-outline "Research"

# Fractal outliner に登録 (.out 直接指定)
/collect ./spec.pdf \
  --to-fractal-out ~/Desktop/notes/mn5tqf9ft4nd.out \
  --to-fractal-title "API Spec v2"
```

## ワークフロー

### Step 1: 入力を分類
各入力を URL パターンまたは拡張子で分類する。

### Step 2: 収集スキルを呼び出し
分類に応じて Skill ツールで該当スキルを呼び出す:
- Skill(web-crawler-md) — Webサイト
- Skill(youtube-md) — YouTube
- Skill(arxiv-md) — arXiv 論文
- Skill(doc-md) — ドキュメント

**複数入力の場合は並列で実行する。**

**Web サイト向けオプションは forward する**: `/collect` の引数に `--limit` / `--scope` /
`--concurrency` / `--no-llms-txt` が含まれる場合、Web URL 入力に対しては web-crawler-md
起動時にそのままパススルーする。他の入力種別 (YouTube / arXiv / ドキュメント) では無視。

### Step 3: 出力先
すべて `.collected/` に保存:

```
.collected/
├── web/
│   └── docs-stripe-com/     ← web-crawler-md
│       ├── *.md
│       ├── map.json
│       └── SUMMARY.md
├── youtube/                  ← youtube-md
│   ├── transcript_VIDEO_ID.md
│   └── SUMMARY.md
├── arxiv/                    ← arxiv-md
│   ├── 2506.23083.md
│   └── SUMMARY.md
└── docs/                     ← doc-md
    ├── api-spec.md
    └── SUMMARY.md
```

### Step 4: Fractal 連携

Fractal に取り込むかどうかは以下の優先順位で決定する:

1. **`--no-fractal` フラグ**が指定されていれば → Fractal 登録スキップ（env が set されていても無視）
2. ユーザーが **`--to-fractal-out` / `--to-fractal-notes` / `--to-fractal-outline`** のいずれかを明示指定 → そのまま使う（最優先）
3. **`FRACTAL_DEFAULT_OUT` 環境変数**が set されている場合 → 自動で取込み:
   - 単一パス（カンマなし）→ そのまま使う（register-fractal.mjs が env から拾う）
   - カンマ区切りで複数パス → **AskUserQuestion でユーザーに選ばせる**（手順は下記）
4. いずれも無い → Fractal 登録しない（収集だけして終了）

ユーザーが `--to-fractal-*` を明示指定した場合 or 上記の条件で取込みが必要と判明した場合、Step 2 でサブ skill を呼び出すときにこれらのオプションを forward する:

- `--to-fractal-out` / `--to-fractal-notes` / `--to-fractal-outline` / `--to-fractal-title` / `--to-fractal-date`

各サブ skill 側の SKILL.md にあるとおり、変換完了後に `scripts/register-fractal.mjs` を実行して outliner に登録する。

#### FRACTAL_DEFAULT_OUT の解釈

```bash
# 単一パス（最もシンプル）
export FRACTAL_DEFAULT_OUT="/Users/me/Desktop/inbox/abc.out"

# 複数パス（カンマ区切り、~ 展開可）
export FRACTAL_DEFAULT_OUT="~/Desktop/inbox/a.out,~/Desktop/notes/b.out"
```

複数パスの場合、サブ skill 呼び出し前に Claude が以下を実行:

1. `node <SKILL_DIR>/scripts/register-fractal.mjs --list-default-outs` を実行 — JSON で `[{path, title, exists}, ...]` が返る
2. その中身を `AskUserQuestion` でユーザーに見せる（title を選択肢のラベル、path を description に表示）
3. 選ばれた path を `--to-fractal-out <path>` としてサブ skill に渡す（env を上書き）

`--list-default-outs` は読み取り専用、副作用なし。

#### 並列実行時の注意

複数入力を並列で処理する場合:
- **同じ `.out` に複数素材を登録するケース**: 同時書き込みは競合するので逐次実行する（並列収集後、登録だけは順番に）
- **異なる `.out` に分けるケース**: 通常通り並列で OK

### Step 5: 結果報告
保存先パス、ページ数/ファイル数を報告し、以下を案内:
- 「`/researcher` で内容を分析できます」
- 「`.collected/` のファイルは explorer が自動検索対象にします」
- Fractal 登録時は登録先 outliner と `日付 > タイトル` パスを報告

## オプション

| オプション | 説明 |
|-----------|------|
| `--summarize` | 各収集後に SUMMARY.md を生成 |
| `--limit <N>` | **Web サイト専用**: クロールする最大ページ数 (BFS モード)。`--limit 1` で開始 URL 1 ページだけ。web-crawler-md (BFS) に forward される。llms.txt / youtube / arxiv / doc では無視 |
| `--scope <pattern>` | **Web サイト専用**: クロール対象の URL glob パターン (複数指定可)。web-crawler-md (BFS) に forward される |
| `--concurrency <N>` | **Web サイト専用**: BFS の並列数 (既定 10)。web-crawler-md (BFS) に forward される |
| `--no-llms-txt` | **Web サイト専用**: llms.txt の自動 probe を無効化し BFS を強制 |
| `--to-fractal-out <path>` | Fractal outliner (.out) への直接パス指定（env より優先） |
| `--to-fractal-notes <folder>` | Fractal Notes フォルダパス（`--to-fractal-outline` と併用） |
| `--to-fractal-outline <title>` | outline.note 内の outline タイトル。存在しない場合は自動作成 |
| `--to-fractal-title <text>` | 日付ノード配下に作るタイトルノードのテキスト（省略時はコンテンツから派生） |
| `--to-fractal-date <YYYY-MM-DD>` | 日付ノードのテキストを上書き（省略時は今日） |
| `--no-fractal` | `FRACTAL_DEFAULT_OUT` env を無視して今回だけ Fractal 登録を skip |

### Web サイト向けオプションの forward

`--limit` / `--scope` / `--concurrency` / `--no-llms-txt` は、入力が Web URL で
かつ web-crawler-md が BFS モードで動く場合にそのまま `crawl.py` に渡す:

```bash
# /collect 内部で:
python3 <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir> \
    [--limit N] [--scope PATTERN] [--concurrency N] [--no-llms-txt]
```

注意:
- 入力が `/llms.txt` / `/llms-full.txt` のときは llms.txt モードなので `--limit` 等は無視する（llms.txt 側に該当オプションなし）
- 入力が YouTube / arXiv / ドキュメントのときも `--limit` 等は無視する（単一素材のため）
- 複数の Web URL を同時に渡した場合は、指定されたオプションを全 URL に適用する

### 環境変数

| 変数 | 説明 |
|---|---|
| `FRACTAL_DEFAULT_OUT` | 既定の `.out` パス。`--to-fractal-*` が無いときの自動取込み先。カンマ区切りで複数パス指定可（その場合は実行時にユーザーへ選択を問う） |

### Fractal 連携の構造

`--to-fractal-*` が指定された場合、各サブ skill が以下の構造で対象 outliner に登録する:

```
<outline-root>
└── YYYY-MM-DD            ← 既に root 直下に同テキストノードがあれば再利用
    └── <title>           ← 毎回新規作成
        └── md page node                ← youtube-md / doc-md は単一
            or sitemap tree of nodes    ← web-crawler-md はツリー
```

Outline 指定の 2 モード:
- **直接指定**: `--to-fractal-out <path.out>` — 既存 `.out` を直接書き込む
- **Notes フォルダ + outline タイトル**: `--to-fractal-notes <folder> --to-fractal-outline <title>` — `outline.note` を見て該当タイトルの file アイテムを探索。無ければ `fractal-md.mjs --create-outliner` で自動作成

各サブ skill は `scripts/register-fractal.mjs` を持ち、`fractal-edit` の `fractal-md.mjs` をシェルアウトして実装する。

**注意**: 対象 `.out` を Fractal アプリ / 拡張で開いた状態だと書き込みが競合する。書き込み前に閉じてもらう。

## /researcher との連携

collect で保存した md ファイルは、プロジェクト内のファイルとして存在するため、
`/researcher` → explorer が Glob/Grep で自動的に検索できる。特別な連携設定は不要。

```bash
/collect https://docs.stripe.com/api          # まず収集
/researcher Stripe の Webhook 認証方式は？     # 収集済み md から回答
```

## いつ使うか
- 外部ドキュメントを分析前に手元に保存したい時
- /requirement や /design の参考資料を集めたい時
- 大量の外部情報をまとめて取得したい時
