# 撮影（README・ホームページの画像）

README の画像（VS Code）とホームページの画像（デスクトップアプリ）を、いつも同じ note・同じ手順・同じ大きさで撮り直すための道具です。UI を変えたら撮り直してください。

| コマンド | アプリ | 書き出す画像 |
|---|---|---|
| `npm run shots:readme` | VS Code（`/Applications/Visual Studio Code.app`） | `assets/images/` の 12 枚（README.md・README.ja.md） |
| `npm run shots:site` | デスクトップアプリ（リポジトリの `electron/`） | `site/images/` の 8 枚（ホームページ） |
| `npm run shots` | 両方 | |

撮ったら `git status assets/images site/images` で変わった画像を確かめ、目で見てから commit します。

## 場面

README（`readme.shots.ts`）。WIN = ウィンドウ全体（3200 x 1720）、CROP = webview だけ（2364 x 1524）。

| 場面 | 大きさ | 画像（`assets/images/`） | README の画像 |
|---|---|---|---|
| `overview` | WIN | `vscode-overview.png` | Fractal Note in VS Code |
| `notes-database` | WIN | `1785087018130.png`（英）・`1785086976945.png`（日） | Notes in VS Code: a note in Database mode |
| `markdown-subpage-side` | CROP | `1785072634683.png` | Markdown editor with a subpage open in the side panel |
| `outliner-page-side` | CROP | `1785071780563.png` | Outliner with the note tree and a page in the side panel |
| `markdown-drawio` | CROP | `1785071877602.png` | Markdown with a draw.io diagram, a Gantt chart and a table |
| `markdown-mermaid` | CROP | `1785072859352.png` | Markdown with a Mermaid sequence diagram and a checklist |
| `markdown-subpages` | CROP | `copy-1786518687773-1786518644715.png`（英）・`1786518644715.png`（日） | A markdown page and its subpage |
| `outliner-mode` | CROP | `1785071590698.png` | Outliner mode |
| `database-mode` | CROP | `1785071543294.png` | Database mode with a page in the side panel |
| `mindmap-mode` | CROP | `1785071464193.png` | Mindmap mode |

ホームページ（`site.shots.ts`）。

| 場面 | 画像（`site/images/`） | 撮り方 |
|---|---|---|
| `hero-light`・`hero-dark` | `desktop-light.png`・`desktop-dark.png` | 空の note 4 つ・アウトラインを打ち込む。1280 x 760 で撮り 1600 x 950 に |
| `markdown` | `shot-markdown.png` | 1440 x 840 で撮り、2000 x 1167・256 色に（以下同じ） |
| `markdown-subpage` | `shot-markdown-subpage.png` | マークダウン + サイドパネルのサブページ |
| `outliner-sidepanel` | `shot-outliner-sidepanel.png` | Outliner + サイドパネルのページ |
| `database-sidepanel` | `shot-database-sidepanel.png` | Database + サイドパネルのページ |
| `mindmap-sidepanel` | `shot-mindmap-sidepanel.png` | Mindmap + サイドパネルのページ |
| `outliner-html` | `shot-outliner-html.png` | Outliner + サイドパネルの HTML ファイル |

## 前提

- macOS の Retina の画面（2 倍で撮ります。1 倍の画面だと画像が小さくなり、警告が出ます）
- ウィンドウが画面に入ること（14 インチの MacBook Pro なら Dock を出したままで入ります）。入らないと macOS が高さを縮めるので、撮らずに止まります（`SHOTS_ALLOW_SMALL=1` でその大きさのまま撮る）
- `npm ci`（リポジトリ）と `cd electron && npm ci`
- VS Code が `/Applications` にある（ほかの場所なら `VSCODE_APP=<.app のパス>`）
- python3 と Pillow（`python3 -m pip install Pillow`）
- 撮っている間（README は vsix の作成を入れて約 5 分、ホームページは約 2 分）は、場面ごとにウィンドウが開いて閉じます。マウス・キーボードに触らないでください（画面が変わります）。撮り直すのは変わった場面だけにする（`-g`）と早く終わります

## 使い方

```bash
npm run shots:readme   # 今のソースから vsix を作り、撮影用の VS Code に入れて撮る
npm run shots:site     # electron/ を compile して撮る

# 場面を選ぶ（-g は場面の名前の一部）
npx playwright test -c screenshots readme -g mindmap
npx playwright test -c screenshots site -g hero

# できている vsix を使う（作るのを省く）
SHOTS_VSIX=fractal-1.4.2-rc.5.vsix npx playwright test -c screenshots readme

# リポジトリではなく別のフォルダへ書く（前の画像と見比べるとき）
SHOTS_OUT=/tmp/shots-check npx playwright test -c screenshots site
```

`npx playwright test -c screenshots site` は compile しないので、ソースを変えたら先に `cd electron && npm run compile` します。

撮ったままの画像と、失敗した場面の画面は作業フォルダ（既定 `/private/tmp/fractal-shots`、`SHOTS_WORK` で変える）の `vscode/raw/`・`site/raw/` に残ります。

## 中身

```
screenshots/
  README.md               この説明
  playwright.config.ts    撮影用の Playwright の設定（*.shots.ts だけ。npm test には入らない）
  readme.shots.ts         README の場面（VS Code）
  site.shots.ts           ホームページの場面（デスクトップアプリ）
  vscode-settings.json    撮影用の VS Code の設定（Light Modern・ミニマップなし・チャットなし など）
  lib/
    demo.ts               撮影用の note を作業フォルダへコピーする・.fractal を書く
    fractal-ui.ts         Notes の画面の操作（ツリーの項目を開く・ページをサイドパネルに開く・モードを切り替える など）
    vscode.ts             VS Code の起動・終了・撮影
    desktop.ts            デスクトップアプリの起動・撮影
    vscode_profile.py     撮影用の VS Code のプロファイルを作る（設定と Fractal の globalState）
    image.py              画像の後処理（ビューの画像をつなぐ・縮める・減色する）
  data/
    notes/projects/       note「Projects」（Team Tasks・Product Roadmap 2026・Meeting Minutes など）
    notes/webapp1/        note「WebApp1 Dev Docs」（Developer Onboarding Guide・Architecture Notes・Sprint Board など）
    launch-dashboard.html ホームページの outliner-html 用（撮るときに Team Tasks のノードに付ける）
```

## 安全のための決まり

- 本物の note・本物の `~/.fractal` は使いません。撮影はいつも `data/notes` のコピー（作業フォルダ）で行います。
- VS Code: HOME は本物のままにします（キーチェーンが HOME にあるため。HOME を変えると macOS が「キーチェーンが見つかりません」の画面を出します）。プロファイル（`--user-data-dir`）と拡張機能（`--extensions-dir`）だけを作業フォルダに作り、Fractal の Notes は globalState で作業フォルダの `.fractal` に向けます。いつもの VS Code の設定・拡張機能には触りません。
- デスクトップアプリ: HOME を一時フォルダにし（アプリが本物の `~/.fractal` を読まない）、`--use-mock-keychain` でキーチェーンに触りません。もし「キーチェーンが見つかりません」の画面が出たら「キャンセル」を押してください（「デフォルトに戻す」は押さない）。
- リリース版のアプリ（`electron/dist/mac-arm64`）は使いません（あなたのプロファイルで動いてしまいます）。

## 撮影用の note を直す

- md と .out（JSON）は直接直してかまいません。
- `outline.note` の `history`（Recent の並び）は note のフォルダからの相対パスで持ち、撮るときに絶対パスに直します。`data/notes` を Fractal で直接開かないでください（history が絶対パスで書かれます）。アプリで直したいときは作業フォルダのコピー（例: `/private/tmp/fractal-shots/vscode/Notes/projects`）を開いて直し、変わったファイルを `data/notes` へコピーし戻します（`outline.note` を戻すなら history を相対パスに戻す）。
- 中身は架空のチーム・架空のプロダクト（URL は example.com）です。本物の名前・URL・鍵を入れないでください（公開のリポジトリに入り、画像にも写ります）。

## 場面を足す・変える

- README: `readme.shots.ts` の `SCENES` に 1 件足します（大きさ WIN / CROP、書き出すファイル名、画面を作る手順）。
- ホームページ: `site.shots.ts` の `SCENES` に 1 件足します（どの note か、手順）。画像は `site/images/shot-<場面>.png` になります。`site/index.html` に `<img>` を足し、`width`・`height` を画像の大きさにします（違うと撮るときに警告が出ます）。
- UI の class が変わって手順が通らなくなったら `lib/fractal-ui.ts` を直します。
