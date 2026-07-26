---
name: collect
description: "Collect external materials (websites, YouTube, arXiv papers, PDF/Office) into .collected/ as Markdown. ALWAYS reads FRACTAL_DEFAULT_OUT env FIRST (before any sub-skill) and asks user to pick when multiple candidates exist."
argument-hint: <URL or file path> [--summarize] [--limit N] [--scope PATTERN]
---

# /collect — 素材収集

## 🛑 PRE-FLIGHT CHECK (絶対遵守 / 最初のターンで必ず実行)

サブ skill を呼ぶ・コードを書く・ファイルを変換する**より前に**、必ず以下を順に実行する。
これは「ワークフロー」ではなく**事前チェック**である。スキップは禁止。

```
1. --no-fractal が引数にあるか確認 → あれば fractal_target = SKIP
2. --to-fractal-out または (--to-fractal-notes + --to-fractal-outline) があるか確認 → あれば fractal_target = それ
3. 上記いずれもない場合 → 必ず env を確認する:
       node ~/.claude/skills/collect/scripts/list-default-outs.mjs
   結果:
     - []                → fractal_target = SKIP
     - 1 件             → fractal_target = その --to-fractal-out
     - 2 件以上         → AskUserQuestion でユーザーに選ばせる
                            (label=title, description=path)
                            → 選んだ path を fractal_target に
```

**この PRE-FLIGHT を済ませるまでは Skill(...) も Bash も発行してはならない。**
**MD 変換済み (cache hit) のケースでも同じ。Fractal 登録だけ行う場合も先に env を確認すること。**

これに失敗するとサブ skill 側は env を読まない設計のため、Fractal 登録が静かに skip される（実害: ユーザーがサイレントに登録忘れ）。過去に複数回失敗実績あり。

---

## このスキルの機能

外部素材（Webサイト、YouTube動画、arXiv 論文、PDF/Office文書）を Markdown に変換し、`.collected/` に保存する。
保存した素材は `/researcher` の explorer が自動的に検索対象にする。

## ルーティングロジック

| 入力の特徴 | 委譲先 | 判定 |
|-----------|--------|------|
| `youtube.com` or `youtu.be` URL | `/youtube-md` | URL パターン |
| `arxiv.org` / `export.arxiv.org` の URL、または `arxiv:XXXX.XXXXX` / 裸の arXiv ID (`2506.23083`) | `/arxiv-md` | URL / ID パターン |
| `.pptx` | `/pptx-pages-md` | 拡張子 |
| `.pdf`, `.docx`, `.xlsx`, `.png` 等（`.pptx` 以外のドキュメント） | `/doc-md` | 拡張子 |
| URL 末尾が `/llms.txt` または `/llms-full.txt` | `/web-crawler-md` (llms.txt モード) | URL パターン |
| その他の `http://` or `https://` URL | `/web-crawler-md` | URL パターン |

**ルーティングの優先順位**: 上から順に評価（arXiv URL は `https://arxiv.org/abs/...` で `.pdf` 拡張子を含まないが、`https://arxiv.org/pdf/2506.23083.pdf` のように `.pdf` で終わる URL でも arxiv-md に委譲すること — arxiv-md は front matter でメタデータを付与するため doc-md より適切）。

**`.pptx` は `/pptx-pages-md` に固定委譲**: doc-md (Docling) は装飾シェイプ・アイコン・SmartArt を生のテキストとしてダンプするため可読性が著しく落ちる。pptx-pages-md は各スライドを PNG レンダリング + テキスト + presenter notes の組で出力するため、視覚レイアウトを保ったまま検索可能な MD になる。`.pptx` で doc-md を使いたい場合はユーザーが明示的に `/doc-md` を直接呼ぶこと。

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

> **❗最重要 (順序固定)**: サブ skill を呼ぶ前に**必ず先に**「Step 1 = Fractal 取込み先の決定」を行う。
> 変換 → 後から outliner を聞く流れは禁止。env が複数パスでユーザー選択が必要なケースでも、
> 必ず**変換開始前**に AskUserQuestion を出して `--to-fractal-out <path>` を確定させること。

### Step 1: Fractal 取込み先を最初に決定する（**必須・スキップ禁止**）

サブ skill を呼ぶより**先に**、以下の順序で取込み先を決定する。

1. **`--no-fractal` フラグ**が指定されていれば → Fractal 登録スキップ（env 無視）。Step 2 へ。
2. ユーザーが **`--to-fractal-out` / (`--to-fractal-notes` + `--to-fractal-outline`)** を明示指定 → そのまま採用。env は確認しない。Step 2 へ。
3. **必ず `FRACTAL_DEFAULT_OUT` env を確認する**。これは省略不可。次のヘルパーで読む:
   ```bash
   node <SKILL_DIR>/scripts/list-default-outs.mjs
   # → JSON で [{path, title, exists}, ...] (env 未設定なら [])
   ```
   - 結果が**空配列**（未設定 or 空）→ Fractal 登録スキップ。Step 2 へ。
   - **1 件のみ** → その path を `--to-fractal-out <path>` として確定。Step 2 へ。
   - **2 件以上** → **AskUserQuestion でユーザーに選ばせる**（ラベル= title、description= path）。選択後の path を `--to-fractal-out <path>` として確定。Step 2 へ。

**MD 変換が既に完了している（cache hit）ケースでも同じ**: Fractal 登録だけ行うとしても Step 1 を必ず実行する。

### Step 2: 入力を分類
各入力を URL パターンまたは拡張子で分類する（ルーティング表を参照）。

### Step 3: 収集スキルを呼び出し
分類に応じて Skill ツールで該当スキルを呼び出す:
- Skill(web-crawler-md) — Webサイト
- Skill(youtube-md) — YouTube
- Skill(arxiv-md) — arXiv 論文
- Skill(pptx-pages-md) — `.pptx`（スライド PNG + テキスト + notes）
- Skill(doc-md) — その他ドキュメント（`.pdf` / `.docx` / `.xlsx` / 画像 等）

**複数入力の場合は並列で実行する。**

**Step 1 で確定した Fractal フラグを必ず forward する**: `--to-fractal-out` / `--to-fractal-notes` /
`--to-fractal-outline` / `--to-fractal-title` / `--to-fractal-date` をサブ skill にそのまま渡す。
サブ skill 側の `register-fractal.mjs` は env を読まないため、`collect` がここで forward しないと
Fractal 登録は実行されない。

**Web サイト向けオプションは forward する**: `/collect` の引数に `--limit` / `--scope` /
`--concurrency` / `--no-llms-txt` が含まれる場合、Web URL 入力に対しては web-crawler-md
起動時にそのままパススルーする。他の入力種別 (YouTube / arXiv / ドキュメント) では無視。

### Step 4: 出力先
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
├── docs/                     ← doc-md
│   ├── api-spec.md
│   └── SUMMARY.md
└── pptx/                      ← pptx-pages-md
    └── deck/
        ├── deck.md
        └── images/slide-NN.png
```

### Step 5: Fractal 連携の詳細仕様

Step 1 で確定済みのフラグを使ってサブ skill が `scripts/register-fractal.mjs` を実行し outliner に登録する。
このセクションは仕様の詳細・参考情報のみ。実行順序は Step 1 を参照。

> **アーキテクチャ**: `FRACTAL_DEFAULT_OUT` env の解釈・複数パス時のユーザー選択は
> **この `collect` skill だけ**が担う。配下のサブ skill (`web-crawler-md` / `youtube-md` /
> `arxiv-md` / `doc-md` / `pptx-pages-md` / `aws-doc-maker`) の `register-fractal.mjs` は env を読まず、
> 受け取った `--fractal-out` あるいは `--fractal-notes + --fractal-outline` だけで動く。
> よって `collect` は env を解決した結果を必ず**明示的な CLI フラグ**としてサブ skill に forward する。

#### FRACTAL_DEFAULT_OUT の書式

```bash
# 単一パス（最もシンプル）
export FRACTAL_DEFAULT_OUT="/Users/me/Desktop/inbox/abc.out"

# 複数パス（カンマ区切り、~ 展開可）
export FRACTAL_DEFAULT_OUT="~/Desktop/inbox/a.out,~/Desktop/notes/b.out"
```

env を見るのは `collect` skill のみ。`collect` は次のヘルパースクリプトで env を読み取る:

```bash
node <SKILL_DIR>/scripts/list-default-outs.mjs
# → JSON で [{path, title, exists}, ...] が返る (env 未設定なら [])
```

このスクリプトは読み取り専用、副作用なし。

#### 単一 / 複数パスのフロー

- env が**未設定** または **空配列** → env 由来の取込みなし。`--to-fractal-*` が無ければ Fractal 登録スキップ
- env が**1 件だけ** → そのまま `--to-fractal-out <path>` として forward
- env が**2 件以上** → 以下を実行:
  1. `node <SKILL_DIR>/scripts/list-default-outs.mjs` を実行 → JSON で候補一覧を取得
  2. `AskUserQuestion` で各候補を表示（title をラベル、path を description に）
  3. 選ばれた path を `--to-fractal-out <path>` としてサブ skill に渡す

#### 並列実行時の注意

複数入力を並列で処理する場合:
- **同じ `.out` に複数素材を登録するケース**: 同時書き込みは競合するので逐次実行する（並列収集後、登録だけは順番に）
- **異なる `.out` に分けるケース**: 通常通り並列で OK

### Step 6: 結果報告
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
