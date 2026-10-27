# agent-capability — AI エージェントから Fractal を使うためのもの

Claude Code / Kiro / Cursor などの AI エージェントが、Fractal の Notes（outline.note・Outliner の `.out`・page md・画像 / 添付）を探して、読んで、画面と同じ規則で書けるようにするための一式。

- **操作は MCP**: 構造を変える操作（ノード・ツリー・ページ化・添付・移動・改名と H1 の同期）は MCP の tool で行う。tool は VS Code 拡張機能と同じコード（`src/shared` の正典）を通るので、画面で操作したのと同じ結果になる（ADR-0012）
- **知識は skill**: 使い方（手順・規約・してはいけないこと）は skill で教える。md の本文はエージェントが直接編集してよい（拡張機能が入力中の外部変更を合成する）

## 中身

```
agent-capability/
├── README.md                     … このファイル
├── install.sh                    … 各 IDE に入れる / 外す（下の「入れ方」）
├── .claude-plugin/
│   └── marketplace.json          … Claude Code の marketplace（名前: fractal-local）
├── plugin/                       … Claude Code の plugin（名前: fractal）
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json                 … MCP サーバー（node ${CLAUDE_PLUGIN_ROOT}/server/server.mjs）
│   ├── skills/fractal/           … 使い方の skill（SKILL.md + references/structure.md）
│   └── server/                   … MCP の bundle の写し（生成物・git 管理外）
└── mcp/                          … MCP サーバーのソース
    ├── server.mjs                … ソースの入口（直接は起動できない）
    ├── src/*.ts                  … tool の実体（src/shared の正典を呼ぶ）
    ├── scripts/                  … 検索・summary（fractal-search.mjs / fractal-summary.mjs / ooxml-extract.mjs）
    ├── structure.md              … データモデルの原本（fractal_structure と skill の references はこの写し）
    ├── build.mjs                 … bundle を作る（dist/ と plugin/server/ と skill の references を更新）
    ├── register.mjs              … Kiro / Cursor の mcp.json に登録する
    ├── register-kirocrew.mjs     … Kiro Crew の agent 定義に MCP と skill を入れる
    ├── vendor/pdfjs-bundle.cjs   … PDF の中身検索（commit する生成物）
    └── dist/                     … bundle（生成物・git 管理外）
```

## MCP の tool（12 本）

| tool | 用途 |
|---|---|
| `fractal_structure` | データモデルの説明（`mcp/structure.md`） |
| `fractal_list_folders` / `fractal_list_notes` | Notes フォルダ・note・ツリーの項目の一覧 |
| `fractal_resolve` | タイトル・名前から対象を特定（完全一致が既定。曖昧なら候補を返して止まる） |
| `fractal_get` | .out のノード木・md の本文 / H1 / subpage・contentHash |
| `fractal_search` / `fractal_summary` | 横断検索 / 全内容を 1 本の md に |
| `fractal_add` / `fractal_modify` / `fractal_attach` | ノード・page・.out / md・subpage の追加、ノードの変更・ページ化 / 解除・移動、画像 / 添付 |
| `fractal_tree` | ツリーの改名・削除（ゴミ箱）・並べ替え・フォルダ・複製・別 note への移動 |
| `fractal_doctor` | 整合性チェック（読むだけ。孤児の判定は画面の Cleanup と同じ） |

書き込みは `expectedHash`（読んだときの contentHash）で競合を検出し（違えば `CONFLICT`）、tmp に書いて rename する。Notes フォルダの外には書かない。削除・移動は `dryRun` で先に確かめられる。

## 入れ方

前提: repo で `npm install` 済み（bundle の build に esbuild / TypeScript を使う）。

```bash
agent-capability/install.sh              # 検出した IDE 全部に入れる
agent-capability/install.sh --dry-run    # 何をするかだけ表示
agent-capability/install.sh --uninstall  # 外す
agent-capability/install.sh --only kiro  # IDE を絞る（claude,kiro,kirocrew,cursor,antigravity）
```

IDE ごとの入り方:

| IDE | MCP | skill |
|---|---|---|
| Claude Code | plugin `fractal@fractal-local`（`plugin/.mcp.json`） | plugin に同梱（`/fractal:fractal`、話題に応じて自動で読み込む） |
| Kiro | `~/.kiro/settings/mcp.json` に登録 | `~/.kiro/skills/fractal` に copy |
| Kiro Crew | main / worker の agent 定義（`~/.kiro/crew/mcp-gateway/agents/` と `~/.kiro/agents/` の `kirocrew.json`・`kirocrew-worker.json`）の `mcpServers` と `tools`（`@fractal`）。ほかの agent は既に fractal を持つときだけ path を直す | 同じ agent 定義の `resources` に `skill://~/.kiro/skills/fractal/SKILL.md`（custom agent は skill を自動で読まない）。実体は Kiro と共有 |
| Cursor | `~/.cursor/mcp.json` に登録 | 置かない |
| Antigravity | 自動登録しない（表示されるコマンドを手で設定） | 置かない |

Kiro Crew は書き換えたあと `kirocrew restart` で反映する。

Claude Code を手で入れるとき（install.sh を使わない場合）:

```
/plugin marketplace add <repo>/agent-capability
/plugin install fractal@fractal-local
```

- 以前の `claude mcp add -s user fractal` の登録が残っていると plugin の server が隠れるので、install.sh は plugin を入れたあとに外す（`claude mcp remove -s user fractal`）
- plugin の tool 名は `mcp__plugin_fractal_fractal__<tool>` になる（以前は `mcp__fractal__<tool>`）。permissions や hook で古い名前を使っていたら直す
- marketplace は local path なので plugin はその場（repo）から読み込まれる。MCP のコードを直したら `npm run compile`（か `node agent-capability/mcp/build.mjs`）→ Claude Code で `/reload-plugins`

## 開発

- build: `npm run compile`（中で `node agent-capability/mcp/build.mjs`）。`mcp/dist/server.mjs` と `plugin/server/` と `plugin/skills/fractal/references/structure.md` を更新する
- テスト: `test/specs/mcp-full-ops.spec.ts`（tool の振る舞い・バグの再現・画面との一致）/ `fractal-mcp.spec.ts` / `fractal-skill.spec.ts`（skill の tool 名と tools/list の一致）/ `mcp-external-edit-safety.spec.ts`（拡張機能側の外部変更の合成）
- tool を足し引きしたら skill（`plugin/skills/fractal/SKILL.md`）も直す（`fractal-skill.spec.ts` が落ちる）
- 決定の記録: `.harness/adr/ADR-0012-mcp-shares-extension-core.md`、spec `20261027-1700-mcp-full-ops` / `20261027-1900-fractal-skill-plugin`
