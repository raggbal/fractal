---
name: aws-doc-maker
description: AWS サービスの公式ドキュメント（`.collected/web/<service>/` 配下の Markdown 群）を、12 軸に沿って理解しやすい md ファイル群に再構成する。生成した md はそのまま配置するか、Outliner に差し込む（fractal-edit 直接 / register-fractal.mjs --mode tree いずれか）
---

# aws-doc-maker — AWS ドキュメント整理スキル

AWS 公式ドキュメントをダウンロード済み (`.collected/web/<service>/` や類似ディレクトリ配下) の前提で、サービスを **12 軸** に整理した md ファイル群を生成する。

整理後の出力先は 2 種類:

1. **ローカル md 群のみ**: `<workdir>/<service-slug>/` 配下に 12 個前後の md を生成
2. **fractal 連携**: 上記 md を生成した上で、Outliner に差し込む。次の 2 経路のどちらかを使う:
   - **`/collect` 互換 — `--to-fractal-*` で `register-fractal.mjs --mode tree` を呼ぶ** ★推奨★。
     `日付 > <サービス名> > 00-index > (01..12 軸の各ページ)` という階層を自動生成する。
   - **fractal-edit を直接呼ぶレガシー経路** — `outliner:` / `applink:` 指定で `fractal-md.mjs` を一括モードで実行 (互換性のため残す)。

---

## Scripts

- [scripts/build-tree-json.mjs](scripts/build-tree-json.mjs) — Helper to scan a generated `<output_dir>` and emit a tree JSON for register-fractal.mjs (--mode tree)
- [scripts/register-fractal.mjs](scripts/register-fractal.mjs) — Register the 12-axis MD tree into a Fractal outliner under `date > title > 00-index > (01..12)`

## 1. 12 軸（固定順）

md ファイル名は `NN-<slug>.md` 形式。番号は以下の固定順を推奨。

| # | 軸 | ファイル名 | 何を書くか |
|---|----|----|----|
| 01 | 目的-手段 | `01-purpose.md` | このサービスは何か。何のために存在するか。どんな手段を提供しているか |
| 02 | 機能軸 | `02-features.md` | 提供される主要機能の列挙と概要。機能マトリクス |
| 03 | 分類-比較 | `03-patterns.md` | 利用パターン・提供形態の分類。他 AWS サービス／他社サービスとの比較軸 |
| 04 | 要素-構造 | `04-architecture.md` | 構成要素、コンポーネント、それらの関係図。用語の依存関係 |
| 05 | ユースケース | `05-usecases.md` | 業務シナリオ別の適用例。誰がいつどう使うか |
| 06 | マニュアル | `06-setup-howto.md` | 初期セットアップ手順、日常操作の step-by-step |
| 07 | 認証認可 | `07-authz.md` | **プリンシパル (人/サービス) → アクション → ターゲット (リソース) → 制御方法** の表で網羅。誰が・どこに・何を・どう制御するか |
| 08 | セキュリティ&ガバナンス | `08-security.md` | 暗号化、PII、監査、コンプライアンス、データ保護、リージョン制約 |
| 09 | 監視・可観測 | `09-observability.md` | CloudWatch Metrics/Logs、イベント、ダッシュボード、アラーム、X-Ray |
| 10 | 運用 | `10-operations.md` | スケーリング、障害対応、バックアップ/復元、クォータ・制限、メンテナンス |
| 11 | 統合・連携 | `11-integrations.md` | 他 AWS サービス (Lambda / S3 / EventBridge / 他) との接続パターン、SDK、API |
| 12 | コスト | `12-cost.md` | 料金モデル、課金対象、無料枠、コスト最適化のポイント、試算例 |

**ルール**:
- 軸を減らすのは可だが、ユーザーが明示指示しない限り上記 12 本を全て作る
- 追加軸が必要なサービスは `13-<slug>.md` として番号を延長
- 1 ファイル 400-800 行を目安に分割。長すぎる軸は `07-authz/` ディレクトリに index.md + 子ファイルで分割してよい

---

## 2. 各軸の書き方指針

### 01-purpose.md（目的-手段）
- 冒頭 2-3 行で「このサービスは何か」を書く
- 「何のために存在するか」のユーザー課題を箇条書き
- 「そのために提供する手段」を箇条書き (機能の一段抽象レベル)
- 公式の位置づけ文（AWS 公式の one-liner）を引用

### 02-features.md（機能軸）
- 主要機能を MECE に列挙 (最低 5 個)
- 各機能は「名称 / 1 行説明 / 主な利用場面」の 3 要素
- 表形式推奨

### 03-patterns.md（分類-比較）
- 利用パターン (例: セルフホスト vs マネージド、同期 vs 非同期)
- 他 AWS サービスとの比較表 (隣接サービスとの住み分け)
- いつこのサービスを選ぶ / 選ばないか

### 04-architecture.md（要素-構造）
- 主要コンポーネント一覧と 1 行説明
- 関係図 (mermaid または ASCII) 推奨
- データフロー / リクエストフロー
- 用語集 (重要用語 10-20 件)

### 05-usecases.md（ユースケース）
- 業務シナリオ最低 3 つ (例: コールセンター立ち上げ、外部 CRM 統合)
- 各シナリオで「誰が・何を・なぜ・どの機能で」
- アンチユースケース (向かないケース) も 1-2 件

### 06-setup-howto.md（マニュアル）
- 前提条件 (アカウント・リージョン・IAM・依存サービス)
- 初期セットアップ: step 番号付きで
- 代表的な日常操作: 3-5 パターンを step 番号付きで
- トラブル時のチェックリスト簡易版

### 07-authz.md（認証認可）★最重要★
**必ず「プリンシパル × アクション × ターゲット × 制御方法」の表を用意する**:

| プリンシパル (誰が) | アクション (何を) | ターゲット (どこに) | 制御方法 (どう) |
|---|---|---|---|
| エージェント (連絡窓口利用者) | 電話応答 | 特定のキュー | セキュリティプロファイル + ルーティングプロファイル |
| 管理者 | インスタンス設定変更 | Connect インスタンス | IAM policy + Connect 管理権限 |
| Lambda 関数 | Contact record 取得 | 特定インスタンスの record | IAM role + Resource ARN |

- プリンシパルの分類（人間ユーザー / IAM user / IAM role / AWS service / federated identity）
- サービス独自のユーザー概念（例: Connect の Agent / Manager）の説明
- 認証方法 (SAML / SSO / IAM Identity Center / サービス独自)
- 認可方法 (IAM policy / リソースポリシー / サービス独自の ACL)
- 委任・クロスアカウント

### 08-security.md（セキュリティ&ガバナンス）
- 暗号化 (転送中 / 保存時 / 鍵管理 KMS 連携)
- PII / 機密データの取り扱い
- 監査ログ (CloudTrail / サービス独自ログ)
- コンプライアンス認証 (HIPAA / PCI-DSS / SOC / GDPR / FedRAMP 等)
- データ主権・リージョン制約
- VPC エンドポイント / PrivateLink

### 09-observability.md（監視・可観測）
- CloudWatch Metrics 一覧 (主要メトリクス 5-10 個)
- CloudWatch Logs のフォーマット
- サービス固有のダッシュボード / イベント
- 推奨アラーム設定
- X-Ray / 分散トレース対応有無

### 10-operations.md（運用）
- クォータ・リミット一覧（上限値・ソフト/ハード）
- スケーリング特性 (自動スケール / 手動 / 制限)
- 障害モードと復旧 (リージョン障害 / AZ 障害 / データロスト対応)
- バックアップ・リストア
- バージョニング・アップデート方針
- メンテナンスウィンドウ

### 11-integrations.md（統合・連携）
- 主要な連携先 AWS サービス (Lambda, EventBridge, S3, DynamoDB, CloudWatch 等) と統合方法
- SDK (言語別)、CLI、API (REST / GraphQL / WebSocket)
- SaaS/外部サービス連携 (Salesforce, Slack 等あれば)
- イベント駆動統合 (EventBridge のイベントパターン例)

### 12-cost.md（コスト）
- 課金ディメンション (秒・分・リクエスト数・ストレージ GB 等)
- 料金プラン (従量課金 / リザーブド / Savings Plans)
- 無料枠 (Free Tier)
- 隠れたコスト (データ転送・CloudWatch Logs・関連サービス)
- コスト最適化 Tips
- ベース/成長/ピーク 3 シナリオの試算例 (可能なら)

---

## 3. 処理フロー

### ユーザーから受け取る入力
- `source_dir`: AWS ドキュメントの Markdown が入ったディレクトリ (`.collected/web/<service>/`)
- `service_slug`: 出力 md 群の接頭辞 (例: `aws-connect`)
- `output_dir`: md 群を置く先 (デフォルト: `./aws-doc-md/<service-slug>/`)
- `fractal_target` (任意):
  - `outliner:<path>.out` → その outliner の末尾に追加
  - `applink:fractal://note/<ws>/<outlineId>/<nodeId>` → そのノードの子として追加

### ステップ

1. **source_dir を調査**
   - `ls` / `Glob` でファイル一覧取得、カテゴリや章立てを把握
   - 代表的な index / TOC ファイルを `Read`
   - ファイル名と中身から、各 md ファイルが 12 軸のどれに相当するかマッピング（1 つの元ファイルが複数軸に寄与するのは普通）

2. **12 軸の md を順次生成**
   - 各軸ごとに関連する元 md を `Read` (必要なら `Grep`)
   - 当該軸の観点で情報を抽出・再構成して `Write`
   - 出典を可能な限り書く（元ファイル名を参照で）

3. **目次ファイル `00-index.md` を生成**
   - 12 軸ファイルへのリンクと、それぞれの 1 行サマリを含む

4. **fractal 連携 (指定がある場合)**
   - 下記セクション 4 に従って fractal-edit を呼ぶ

---

## 4. fractal 連携仕様

### 4-0. `--to-fractal-*` 経路（推奨 / `/collect` から委譲時もこちら）

ユーザー / 上位 skill が以下のいずれかを指定したとき、tree モードで Outliner に登録する:

- `--to-fractal-out <path.out>` — 既存 `.out` を直接書き込む
- `--to-fractal-notes <folder> --to-fractal-outline <title>` — Notes フォルダ内の outline を探索（無ければ自動作成）

**NOTE:** この skill は `FRACTAL_DEFAULT_OUT` 環境変数を**自分では読まない**。env からの fallback は呼び出し元 (`/collect` 等) の責務であり、ここまで届く時点では `--to-fractal-out`（あるいは notes/outline pair）が必ず明示指定されている前提。

#### 手順

1. **md 群を生成** (セクション 3 の通常フロー)
2. **tree JSON を生成**:
   ```bash
   node <SKILL_DIR>/scripts/build-tree-json.mjs <output_dir> \
     --title "<service official name>" \
     -o <output_dir>/.fractal-tree.json
   ```
   - `<output_dir>` 直下の `00-index.md` をルート、`NN-<slug>.md` を子として並べたツリーを出力する
   - サブ軸ディレクトリ (`07-authz/index.md` + `07-authz/<topic>.md`) があれば 1 階層深い子として展開される
   - `--title` 省略時は `00-index.md` の H1 を採用、それも無ければディレクトリ名を採用
3. **register-fractal.mjs --mode tree を呼ぶ**:
   ```bash
   node <SKILL_DIR>/scripts/register-fractal.mjs --mode tree \
     --tree-json <output_dir>/.fractal-tree.json \
     --md-base <output_dir> \
     --fractal-title "<service official name>" \
     [--fractal-out <path.out> | --fractal-notes <folder> --fractal-outline <title>] \
     [--fractal-date YYYY-MM-DD]
   ```

#### 出力構造

```
<outline-root>
└── YYYY-MM-DD             ← reused if a root-level node with this exact text exists
    └── <service title>    ← always newly created
        └── 00-index.md page node      ← service root
            ├── 01-purpose.md page node
            ├── 02-features.md page node
            ├── ...
            └── 12-cost.md page node
```

`07-authz/` のような下位ディレクトリがある場合は `07-authz/index.md` がページノードとなり、その配下に `07-authz/<topic>.md` 群が子として並ぶ。

#### Outline targeting

`register-fractal.mjs` の `--fractal-out` か `--fractal-notes + --fractal-outline` の**いずれか一方**を必ず渡す（両方なし or 両方ありはエラー）。この script は `FRACTAL_DEFAULT_OUT` を読まない。

#### Notes

- `--fractal-title` 省略時は 00-index.md の H1（あるいは tree JSON のルート `title`）を使う
- `register-fractal.mjs` は `fractal-edit/scripts/fractal-md.mjs` を sibling skill 位置 or `~/.claude/skills/fractal-edit/scripts/fractal-md.mjs` で自動解決する。`--fractal-md-script <path>` で上書き可能
- `.fractal-tree.json` は中間ファイル。コミット対象から除外して良い（`.gitignore` 推奨）

---

### 4a. outliner モード（outliner 指定 — レガシー）

> 互換性のため残す既存経路。`/collect` 由来の呼び出しでは 4-0 を使うこと。

ユーザー指定: `outliner:/path/to/xxx.out` あるいは `outliner:<out-filename>`（pace ワークスペースなら basename のみも可）

処理:
1. `.out` ファイルの絶対パスを解決
   - 絶対パスならそのまま
   - 相対 / basename のみなら `fractal-search --list-folders --json` で登録済みフォルダを取得して検索
2. `fractal-edit` の `fractal-md.mjs` を一括モードで呼ぶ:
   ```bash
   node ~/.claude/skills/fractal-edit/scripts/fractal-md.mjs \
     --note /abs/path/to/xxx.out \
     --md "output_dir/00-index.md" "output_dir/01-purpose.md" ... "output_dir/12-cost.md" \
     --group-name "<サービス正式名>" \
     --position after
   ```
   - `--md` には 12 軸 + index の計 13 ファイルを順番に渡す
   - `--group-name` にサービス名を指定 (例 "Amazon Connect")
   - `--position after` でアウトライナー末尾に追加

### 4b. applink モード（App-Link 指定 — レガシー）

> 互換性のため残す既存経路。`/collect` 由来の呼び出しでは 4-0 を使うこと。


ユーザー指定: `applink:fractal://note/<workspace>/<outlineId>/<nodeId>`

パース規則:
- `<workspace>` = fractal Notes フォルダ名 (basename)。`fractal-search --list-folders --json` で basename 一致して絶対パス解決
- `<outlineId>` = `.out` ファイル名 (拡張子なし)
- `<nodeId>` = `.out` 内の node ID（`nxxxxx` 形式）

処理:
1. workspace basename → 絶対パス解決: `fractal-search --list-folders --json` の出力で `folders[].path` の basename が一致するもの
2. `.out` パス: `<workspace-path>/<outlineId>.out`
3. `fractal-edit` を呼ぶ:
   ```bash
   node ~/.claude/skills/fractal-edit/scripts/fractal-md.mjs \
     --note <workspace-path>/<outlineId>.out \
     --md "output_dir/00-index.md" "output_dir/01-purpose.md" ... \
     --group-name "<サービス正式名>" \
     --parent <nodeId> \
     --position child
   ```
   - `--parent <nodeId>` で指定ノードを親にする
   - `--position child` でその子として追加

### エラー処理
- workspace が見つからない → ユーザーに確認（勝手に別 workspace を使わない）
- `.out` が見つからない → ユーザーに確認
- node ID が `.out` 内に存在しない → `fractal-edit` 側でエラー停止するので、ユーザーに報告

---

## 5. 呼び出し例

### 例 A: Connect の md のみ生成

```
/aws-doc-maker
source_dir: .collected/web/aws-connect-adminguide/
service_slug: aws-connect
output_dir: ./aws-doc-md/aws-connect/
```

→ `./aws-doc-md/aws-connect/{00-index,01-purpose,...,12-cost}.md` 生成

### 例 B: Connect を outliner 末尾に追加

```
/aws-doc-maker
source_dir: .collected/web/aws-connect-adminguide/
service_slug: aws-connect
fractal_target: outliner:mny7xqfb8bew.out
```

→ md 生成 → 指定 `.out` の末尾にグループ名「Amazon Connect」で追加

### 例 C: Connect を App-Link 指定ノードの子として追加

```
/aws-doc-maker
source_dir: .collected/web/aws-connect-adminguide/
service_slug: aws-connect
fractal_target: applink:fractal://note/pace/mny7xqfb8bew/nmny8wc94bzm7hi
```

→ md 生成 → `pace` workspace の `mny7xqfb8bew.out` 内 `nmny8wc94bzm7hi` ノードの子として追加

---

## 6. 品質チェック（生成後）

生成後、以下を自己検証する:
- [ ] 12 軸（最低限「目的-手段 / 機能 / 分類-比較 / 要素-構造 / ユースケース / マニュアル / 認証認可 / セキュリティ&ガバナンス / 監視・可観測 / 運用 / 統合・連携 / コスト」）が揃っているか
- [ ] 07-authz.md にプリンシパル×アクション×ターゲット×制御方法の表があるか
- [ ] 各 md に出典（元ファイルの参照）があるか
- [ ] 内部リンクが壊れていないか
- [ ] 00-index.md から全 md に飛べるか

fractal へ登録した場合は、登録後に `fractal-search --query "<service-slug>" --folder <workspace-path>` で登録成功を確認する。

---

## 7. 注意事項

- 元ドキュメントが 1000 ファイル以上あるなど巨大な場合、並列で `Read` せず、`Grep` + `Glob` で絞り込みながら進める
- 英語ドキュメントを日本語 md にする場合、軸のタイトルは日本語、用語は原語併記 (`セキュリティプロファイル (Security Profile)`)
- 「AWS 公式の位置づけ文」を引用する場合、引用元のファイル名と URL (元ドキュメントから引ける場合) を添える
- 生成 md は「AWS 公式ドキュメントの要約」であり、書き手（Claude Code）の推測は `> 備考:` として明示

---

## 8. 関連スキル

- `fractal-structure` — fractal のデータモデル（最初に読む）
- `fractal-search` — Notes フォルダ / `.out` の検索
- `fractal-edit` — ノード追加・MD 取り込み（このスキルから呼び出す）
