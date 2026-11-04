# agent-capability — AI エージェントから Fractal を使うためのもの

Claude Code / Codex / Kiro の AI エージェントが、Fractal の Notes（outline.note・Outliner の `.out`・page md・画像 / 添付）を探して、読んで、画面と同じ規則で書けるようにするための一式。3 つとも同じ `plugin/` を plugin（Kiro は Power）として入れる。

- **操作は MCP**: 構造を変える操作（ノード・ツリー・ページ化・添付・移動・改名と H1 の同期）は MCP の tool で行う。tool は VS Code 拡張機能と同じコード（`src/shared` の正典）を通るので、画面で操作したのと同じ結果になる（ADR-0012）
- **知識は skill**: 使い方（手順・規約・してはいけないこと）は skill で教える。md の本文はエージェントが直接編集してよい（拡張機能が入力中の外部変更を合成する）

## 配置（どこがソースで、どこが入る物か）

```
agent-capability/
├── README.md                 # このファイル
├── install.sh                # 入口（install / --update / --uninstall）
├── scripts/
│   └── unregister-legacy.mjs # Kiro の古い登録（~/.kiro/settings/mcp.json の fractal）を外す（install.sh だけが使う）
├── .claude-plugin/
│   └── marketplace.json      # marketplace（名前 fractal-local）。plugin/ を指すだけ。Claude Code と Codex が読む
├── plugin/                   # 【入る物】入れるときに丸ごと写される（Claude Code はその場で読む）
│   ├── plugin.json           #   Kiro・Codex 用の manifest（Agent Plugins 1.0.0）
│   ├── mcp.json              #   Kiro・Codex 用の MCP（node ${PLUGIN_ROOT}/server/server.mjs）
│   ├── .claude-plugin/plugin.json  # Claude Code 用の manifest。MCP もここの mcpServers に書く（${CLAUDE_PLUGIN_ROOT}）
│   ├── skills/fractal/{SKILL.md, references/structure.md}  # 使い方の skill。structure.md はデータモデルの説明の原本
│   └── server/               #   【生成物】（gitignore）server-src の build が直接書く bundle と pdfjs の vendor
└── server-src/               # 【作る物】plugin/server の元。写されない
    ├── package.json          #   SDK・zod の依存。node_modules はここ
    ├── build.mjs             #   esbuild で 1 ファイルにして ../plugin/server/ へ直接出す（中間の dist/ は無い）
    ├── tsconfig.json         #   src/*.ts の型チェック（emit しない）
    ├── src/                  #   server.mjs（ソースの入口。直接は起動できない）と tool の実体（*.ts）
    ├── cli/                  #   bundle に入る子プロセス用 CLI（fractal-search / fractal-summary / ooxml-extract）
    └── vendor/pdfjs-bundle.cjs  # PDF の中身検索（commit する生成物。npm run build:pdfjs-vendor）
```

- **ソース**は `server-src/` と、リポ直下の **`src/shared`**（拡張機能と共通の正典。tool は画面と同じ関数を呼ぶ — ADR-0012）。build はリポの `tsc`（`tsconfig.shared-emit.json`）と esbuild を使う。
- **入る物**は `plugin/` だけ。手で書く manifest・MCP の設定・skill と、build の生成物の `plugin/server/`。ソース・`node_modules`・build の道具を `plugin/` に入れないのは、写した先では build できず、26MB の `node_modules` が毎回写るだけで更新は楽にならないから。
- **MCP の設定が 2 つある理由**: Claude Code は `.claude-plugin/plugin.json` の `mcpServers`（`${CLAUDE_PLUGIN_ROOT}`）を読み、Kiro・Codex は Agent Plugins の `mcp.json`（`${PLUGIN_ROOT}`）を読む。Codex は `${CLAUDE_PLUGIN_ROOT}` を展開しない（0.166.0 で確認）。Claude Code 用の `.mcp.json` は置かない（manifest に直接書いた `mcpServers` が効く — 2.1.296 で確認）。2 つの manifest の name・version・description と、2 つの MCP 設定が起動する server は `test/specs/agent-plugin-manifest.spec.ts` がそろっているか検査する。
- **structure.md** は `fractal_structure` の tool も返すので、server の入口（`server-src/src/server.mjs`）が skill の参照 md を直接 import し、bundle に埋め込む。写しは作らない（原本は 1 か所）。

## 入れ方・更新

前提: repo で `npm install` 済み（build に esbuild / TypeScript を使う）。

```bash
agent-capability/install.sh              # 入れる: build → 検出した IDE 全部に plugin / Power を入れる
agent-capability/install.sh --update     # 更新: MCP・skill を直したらこれだけ。build → Claude の plugin 更新 → Codex の plugin・Kiro の Power を入れ直す
agent-capability/install.sh --dry-run    # 何をするかだけ表示
agent-capability/install.sh --uninstall  # 外す
agent-capability/install.sh --only claude,kiro  # IDE を絞る（claude,codex,kiro,antigravity）
```

| IDE | 入り方 | `--update` で何が起きるか |
|---|---|---|
| Claude Code | plugin `fractal@fractal-local`（ローカルのフォルダの marketplace） | build で `plugin/server` が替わる（その場で読むので）。念のため `claude plugin marketplace update` と `claude plugin update` も流す。新しいセッションか `/reload-plugins` で有効 |
| Codex | 同じ plugin（`~/.codex/plugins/cache/` に写す） | `codex plugin add fractal@fractal-local` を流し直して写し直す。新しいセッションで有効 |
| Kiro（IDE・CLI V3） | 同じ `plugin/` を Power で（`kiro-cli powers install`。`~/.kiro/powers/installed/fractal/` に写す。中の MCP は Kiro が管理し、Power と一緒に有効になる） | 同じパスで `kiro-cli powers install` を流し直すと入れ替わる（Updated power）。**次の会話から**有効 |
| Antigravity | 自動登録しない。plugin の仕組みが無いので、install.sh が手で設定する command（node の絶対パスと `plugin/server/server.mjs`）を出す | 同じ（bundle のパスは変わらない） |

- install.sh は毎回、以前の登録を片付ける: Claude Code の `claude mcp add -s user fractal`（plugin の server が隠れる）、Kiro の `~/.kiro/settings/mcp.json` の fractal と `~/.kiro/skills/fractal` の copy（Power と二重になる）、昔の skill と `~/.fractal/fractal-mcp` の symlink。`~/.kiro/settings/mcp.json` の fractal 以外は触らない。
- node の絶対パスを探す処理（mise の shim を優先）は Antigravity のためだけに残している（GUI は shell の PATH を持たず、版つきのパスは node の更新で消えるため）。plugin / Power で入る IDE は、plugin の設定の `node` をそのまま使う。

### 手で入れるとき

Claude Code を手で入れるとき（install.sh を使わない場合）:

```
/plugin marketplace add <repo>/agent-capability
/plugin install fractal@fractal-local
```

- 以前の `claude mcp add -s user fractal` の登録が残っていると plugin の server が隠れるので、install.sh は plugin を入れたあとに外す（`claude mcp remove -s user fractal`）
- plugin の tool 名は `mcp__plugin_fractal_fractal__<tool>` になる（以前は `mcp__fractal__<tool>`）。permissions や hook で古い名前を使っていたら直す
- marketplace は local path なので plugin はその場（repo）から読み込まれる。MCP のコードを直したら `install.sh --update`（か `npm run build:mcp`）→ Claude Code で `/reload-plugins`

Kiro を手で入れるとき: `kiro-cli powers install <repo>/agent-capability/plugin`、または Kiro の Powers パネルで Add Custom Power → Import power from a folder → `<repo>/agent-capability/plugin`。

- Power は `~/.kiro/powers/installed/fractal/` への写しなので、MCP のコードを直したら build のあと入れ直す（`install.sh --update`）。新しい会話で有効
- 以前の登録（`~/.kiro/settings/mcp.json` の fractal と `~/.kiro/skills/fractal` の copy）が残っていると tool と skill が二重になるので、install.sh が外す

Codex を手で入れるとき:

```
codex plugin marketplace add <repo>/agent-capability
codex plugin add fractal@fractal-local
```

- Codex は plugin を `~/.codex/plugins/cache/` に写すので、MCP のコードを直したら build のあと `codex plugin add fractal@fractal-local` を流し直す（`install.sh --update`）。新しいセッションで有効

## MCP の tool（12 本）

| tool | 用途 |
|---|---|
| `fractal_structure` | データモデルの説明（`plugin/skills/fractal/references/structure.md`） |
| `fractal_list_folders` / `fractal_list_notes` | Notes フォルダ・note・ツリーの項目の一覧 |
| `fractal_resolve` | タイトル・名前から対象を特定（完全一致が既定。曖昧なら候補を返して止まる） |
| `fractal_get` | .out のノード木・md の本文 / H1 / subpage・contentHash |
| `fractal_search` / `fractal_summary` | 横断検索 / 全内容を 1 本の md に |
| `fractal_add` / `fractal_modify` / `fractal_attach` | ノード・page・.out / md・subpage の追加、ノードの変更・ページ化 / 解除・移動、画像 / 添付 |
| `fractal_tree` | ツリーの改名・削除（ゴミ箱）・並べ替え・フォルダ・複製・別 note への移動 |
| `fractal_doctor` | 整合性チェック（読むだけ。孤児の判定は画面の Cleanup と同じ） |

書き込みは `expectedHash`（読んだときの contentHash）で競合を検出し（違えば `CONFLICT`）、tmp に書いて rename する。Notes フォルダの外には書かない。削除・移動は `dryRun` で先に確かめられる。

## 開発

- build: `npm run build:mcp`（`node agent-capability/server-src/build.mjs`。`npm run compile` も中で呼ぶ）。`plugin/server/` を作り直す（前の残りは消す）
- テスト: `test/specs/mcp-full-ops.spec.ts`（tool の振る舞い・バグの再現・画面との一致）/ `fractal-mcp.spec.ts` / `fractal-skill.spec.ts`（skill の tool 名と tools/list の一致）/ `agent-plugin-manifest.spec.ts`（2 組の manifest・MCP 設定の一致）/ `mcp-external-edit-safety.spec.ts`（拡張機能側の外部変更の合成）
- tool を足し引きしたら skill（`plugin/skills/fractal/SKILL.md`）も直す（`fractal-skill.spec.ts` が落ちる）
- 決定の記録: `.harness/adr/ADR-0012-mcp-shares-extension-core.md`、spec `20261027-1700-mcp-full-ops` / `20261027-1900-fractal-skill-plugin`
