# Fractal モダン化デザイン言語（modern-2026）

- 状態: **採用**（2026-11-07。左パネルは案 A5「ほんのり紫」）— branch `design-modern` で作り、main に入れた。試した 11 案と、元の状態・ほかの案への戻し方は §13
- 作成: 2026-11-07
- 依頼: 「frctal のデザインをもう少し現代風にしたい。デザインだけじゃなく、色なども」— 参考は Figma の Web 版（今風で、作業に便利）と Amazon Quick の desktop アプリ（サイドバーとヘッダー）。**note の内容の領域は白っぽく**（Figma の canvas が灰色なのは Web 画面を貼るため）
- 参考画像: `/tmp/fractal-design/ref-figma-1.png`, `ref-figma-2.jpg`, `ref-quick.jpg`
- 現状の撮影: `/tmp/fractal-design/before/*.png`（17 場面 × light / dark）。棚卸し: `/tmp/fractal-design/inventory/`
- 計算: コントラスト比はすべて WCAG 2.x の相対輝度で計算した（式は付録 A。半透明の塗りは下の面に合成してから計算）

---

## 0. 要約

1. **本文の面は白**（light `#FFFFFF`）。サイドバー・タブ strip などの chrome は一段沈んだ**ほんのり紫の薄い灰**（`#F5F4FB`。案 A5 — §13。最初の案 A はニュートラルの `#F7F7F8`）。今の「全部 `#FAFAF7` の暖色オフホワイト」をやめる。dark は VS Code Dark Modern と同じ並び（サイドバー `#18181B` < 本文 `#1F1F22` < 浮く面 `#2A2A2E`）にし、今の紺（`#1E1F28`）と outliner だけ VS Code Dark+（`#1e1e1e`）の継ぎ目をなくす
2. **アクセントは 1 色**: 青 `#0A68E6`（Figma 系の青を AA に合わせて濃くしたもの。白文字 5.08:1）。色の値は **tokens.css の 1 ブロック（accent ramp）だけ**に書き、差し替えはそこだけで済む。Quick 風の紫（`#7A46E7`）の差し替え用ブロックも検証済みで付ける
3. **状態は面の塗りで示す**: hover は無彩色の薄い塗り、開いている項目（現在地）は無彩色の濃い塗り、複数選択とキーボードの focus 行は青の淡い塗り。角は 6px で丸める。1px の縦バーや線での表現はやめる
4. **浮くもの**（menu・popover・dialog）は白 + 1px の細枠 + 影。menu は **light**（Figma の黒い menu は採らない — §9 D4）
5. **コンパクトのまま**（2026-05 の「B案」= 0.9 倍の方針を守る）: UI の文字は 13px 基準（12 / 11 が副）、行は 26–28px、ヘッダーは今の **36px の行と ≡・< > の大きさ・位置をそのまま**使う
6. **数字で守る**: 意味のある文字はすべての面で 4.5:1 以上、指標（focus ring・drop 線・checkbox）は 3:1 以上（§4 に全数）。今は accent 上の白文字が 1.79:1、link が 3.27:1、blockquote が不可視、table の chip が 1.07–2.55:1
7. **既存の決定は壊さない**: ADRL-0115（outliner の node 選択は amber、`::selection` は青、`--fr-color-selection-bg` は黄色にしない、`--fr-bg-selection` は未定義のまま）、行の hover を出さない、編集中の文字に focus の強調を出さない、table に罫線を引かない、linkedfd の 📄/📎、白い lightbox（§8）
8. ほとんどは **token の値の変更 + 旧 alias の付け替え**で済む。部品ごとの CSS は「白くなると消えるもの」と「VS Code の色が漏れているもの」を中心に直す（§10）

---

## 1. 原則

| # | 原則 | 具体的に |
|---|---|---|
| P1 | **本文が主役。本文の面は白く、chrome は一段沈める** | 本文（md・outliner・table・mindmap・file viewer の中身・linkedfd の一覧）= `bg-app`（白）。サイドバー・Outline（md の目次）・タブ strip = `bg-panel` / `bg-chrome`（薄い灰）。境目は 1px の線 1 本 |
| P2 | **色は 1 色だけ、1 か所で決める** | 強調はすべて `--fr-color-primary` 系。部品は ramp の値を直接書かず、意味の token（primary / primary-soft / primary-strong / focus-ring / selection-bg）だけを使う |
| P3 | **状態は面の塗りで示す** | hover = 無彩色の薄い塗り、現在地 = 無彩色の濃い塗り、選択 = accent の淡い塗り、focus（キーボード）= ring。行の塗りは角 6px |
| P4 | **線は 1 本まで。浮くものは影で浮かせる** | 二重線を作らない（ヘッダーの塊の下に 1 本だけ）。menu・popover・dialog は 1px の細枠 + 影 |
| P5 | **作業の道具として密に** | 13px の UI、26–28px の行、36px のヘッダー。余白は 4px 刻み。飾りのための余白は足さない（B案の 0.9 倍の密度を保つ） |
| P6 | **読めることを数字で約束する** | 文字 4.5:1、指標 3:1。半透明は合成してから測る。値を変えたら付録 A の計算か §10.5 の G2 テストで確かめる |
| P7 | **VS Code のテーマに追従しない** | `docs/specs/frontend.md` の原則を実装でも守る。`var(--vscode-*)` を先に読む約 50 か所を Fractal の token に置き換える |
| P8 | **決まったことを壊さない** | §8 の一覧。形（36px・ボタンの箱・indent）は変えず、色・角・影・文字の太さだけを変える |

---

## 2. 面の構成（surface model）

```
┌ sidebar（bg-panel）─────┐┌ notes タブ strip（bg-chrome。タブが 2 つ以上のとき）──────────────────────┐
│ ≡ note 名   < >   36px  ││ [ 選択タブ = bg-app で本文とつながる ] [ 非選択タブ = 透明 ]                │
│ 検索                    │├──────────────────────────────────────────────────────────────┬────────────┤
│ タブ（Notes / Sync …）  ││ 本文（bg-app = 白）                                            │ sidepanel  │
│ ─ divider ─             ││  1 行目 36px（タイトル / md の toolbar）                       │ （bg-app   │
│ お気に入り              ││  2 行目 36px（検索 / outliner の操作）                         │  + 細枠    │
│ ─ divider ─             ││  ─ divider ─                                                   │  + 影）    │
│ + 新規の行              ││  outliner / md / table / mindmap / file viewer / linkedfd       │            │
│ note tree               ││  （md の Outline 目次を開くと、その列だけ bg-panel）            │            │
│ ─ divider ─             ││                                                                 │            │
│ Recent                  ││                                                                 │            │
└─────────────────────────┘└──────────────────────────────────────────────────────────────┴────────────┘
  menu / popover / dialog / 浮く toolbar = bg-elevated（白 + border + 影）— どの面の上にも浮く
  dialog の下 = overlay（scrim）。toast = bg-inverse（light でも暗い小片）
  PDF / docx / pptx の紙面の後ろ = bg-canvas（白い紙面が見えるだけの薄い灰）
```

| 面 | token | light | dark | 使う所 |
|---|---|---|---|---|
| 本文（content） | `--fr-color-bg-app` | `#FFFFFF` | `#1F1F22` | md・outliner・table・mindmap の canvas・linkedfd・file viewer の toolbar と本体・sidepanel・note 面のヘッダー行（36px）・選択タブ |
| サイドバー（sidebar） | `--fr-color-bg-panel` | `#F5F4FB` | `#18181B` | note tree の panel 全体（ヘッダー・検索・お気に入り・Recent）・md の Outline（`--sidebar-bg`）・sidepanel の目次 |
| アプリの chrome | `--fr-color-bg-chrome`（新） | `#F5F4FB` | `#18181B` | notes タブ strip。既定は sidebar と同じ値（Quick と同じく、chrome とサイドバーを 1 つの灰で囲み、本文だけ白く抜く）。将来分けられるよう token は別にする |
| 浮く面（elevated） | `--fr-color-bg-elevated` | `#FFFFFF` | `#2A2A2E` | menu・popover・dialog・浮く toolbar・mindmap の node と minimap・tag の候補 |
| 紙面の後ろ（canvas） | `--fr-color-bg-canvas`（新） | `#F2F2F4` | `#18181B` | PDF・docx・pptx の紙面の後ろだけ。白い紙面の縁が見える最小の灰（白に対して 1.12:1）。画像・text・html の viewer は `bg-app` |
| 反転（inverse） | `--fr-color-bg-inverse`（新） | `#18181B` | `#3A3A40` | toast（将来の tooltip） |
| 覆い（overlay） | `--fr-color-overlay`（新） | `rgba(17,17,20,.32)` | `rgba(0,0,0,.56)` | dialog の下の scrim |
| 強い覆い | `--fr-color-overlay-strong`（新） | `rgba(0,0,0,.70)` | `rgba(0,0,0,.70)` | lightbox / 全画面表示（白い台座は変えない — §8） |

面の段差（WCAG の対象外。見え方の目安）: sidebar / 本文 = 1.09:1（light。案 A の `#F7F7F8` では 1.07:1）・1.08:1（dark）。これだけだと弱いので、境目には必ず 1px の `divider`（本文に対して 1.23:1 / 1.22:1）を引く。dark の浮く面は本文に対して 1.15:1 なので、細枠（1.41:1）+ 影で浮かせる。

---

## 3. 色の token（light / dark の全表）

### 3.1 accent ramp — 色を差し替える唯一の場所

tokens.css の `@layer fr-tokens` の中、テーマのブロックより前に置く（テーマに依らない 1 ブロック）。**部品からは参照しない**（参照してよいのは §3.2 以降の意味の token と、tokens.css の中のテーマのブロックだけ）。

```css
/* ── Accent ramp: ブランド色の差し替え点（ここだけ書き換える。値は §4 の検証を通したもの）── */
:root {
    --fr-accent-100: #E3EEFF;   /* light: primary-soft / selection-bg */
    --fr-accent-200: #C9DEFF;   /* light: primary-soft-hover */
    --fr-accent-300: #9EC4FF;   /* dark : primary-strong-hover（soft-hover の上の文字） */
    --fr-accent-400: #6EA6FE;   /* dark : primary-strong / focus-ring */
    --fr-accent-600: #0A68E6;   /* 両方: primary（塗り・指標）/ light: focus-ring */
    --fr-accent-700: #0256C3;   /* 両方: primary-hover / light: primary-strong（文字） */
    --fr-accent-800: #06469E;   /* 両方: primary-active */
    --fr-accent-soft-dark:       #263651;  /* dark: primary-soft / selection-bg（= 500 #3D87F8 を 22% で #1F1F22 に重ねた値） */
    --fr-accent-soft-hover-dark: #29426B;  /* dark: primary-soft-hover（= 500 を 34%。soft との段差 1.21:1 — §12.5 R2。26% の #273A5A は 1.06:1 で見えなかった） */
    --fr-accent-rgb:       10, 104, 230;   /* = 600。light の ::selection / focus の halo */
    --fr-accent-light-rgb: 110, 166, 254;  /* = 400。dark の ::selection / focus の halo */
}
```

- 青は OKLCH の色相 259°（Figma の `#0D99FF` は 249°）で、明るさを AA に届くところ（L = 0.547）まで下げた。ramp は OKLCH で明るさを等間隔に取って作った（50–950 の全段は付録 B）
- **紫に差し替える場合**（Quick 寄り）: `100 #EDEAFF / 200 #DCD6FF / 300 #C3B7FE / 400 #A992FF / 600 #7A46E7 / 700 #6638C4 / 800 #522E9E / soft-dark #383051 / soft-hover-dark #46396B / rgb 122, 70, 231 / light-rgb 169, 146, 255`。§4.5 で同じ検査を通している。ただし紫にすると note tree・linkedfd・mindmap の複数選択も紫になる（2026-09-04 の裁定 R16 rev2 は「青」と言っている）ので、差し替える前にユーザーに確かめる（§11 Q3）
- **値は必ず 16 進か rgba の直書き**にする。`color-mix()` や `light-dark()` で作らない（§9 D5: 計算後の色が `color(srgb …)` などで返り、rgb() を前提にした test が壊れる。同梱の pdf.js にも `#` / `rgb(` / `rgba(` しか読まない色の変換がある。`light-dark()` は VS Code ^1.85 の Chromium 114 で動かない）

### 3.2 塗り（fill）— どの面の上でも使える半透明

| token（新） | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-fill-subtle` | 入力欄・検索欄の地、table の見出し行、kbd | `rgba(24,24,27,.04)` | `rgba(255,255,255,.045)` |
| `--fr-color-fill-hover` | hover（行・ボタン・menu の項目） | `rgba(24,24,27,.055)` | `rgba(255,255,255,.06)` |
| `--fr-color-fill-active` | 押下中・**開いている項目（現在地）**・無彩色の切り替えボタンの ON | `rgba(24,24,27,.085)` | `rgba(255,255,255,.095)` |

合成後の値（参考）: light — 本文の上の field `#F6F6F6`、sidebar の上の field `#EEEEEF`、sidebar の上の hover `#EBEBEC`、sidebar の上の active `#E4E4E5`、menu の上の hover `#F2F2F2`。dark — 本文の上の field `#29292C`、sidebar の上の hover `#262629`、active `#2E2E31`、menu の上の hover `#37373B`。

塗りを半透明にするのは、同じ hover の値をサイドバー（灰）・本文（白）・menu（白 / dark では明るい灰）のどこに置いても段差が同じに見えるようにするため。**白の上に白を置いて消える**今の問題（`--outliner-hover-bg` = elevated = 白、menu の hover = `bg-app` 等）はこれで解く。

### 3.3 線

| token | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-divider` | 面の境目・ヘッダーの塊の下・区切り（section の間）— **本文・sidebar の上**で使う | `#E7E7EA` | `#2E2E33` |
| `--fr-color-border` | 部品の縁（menu・dialog・table のセル・mindmap の node・浮く toolbar）と、**浮く面の中の区切り線**（menu の区切り・浮く toolbar の群の区切り・popover の見出しの下） | `#E2E2E6` | `#38383E` |
| `--fr-color-border-strong`（新） | hover した縁・blockquote の左線・入力欄を縁で示すとき | `#D1D1D6` | `#4A4A50` |
| `--fr-color-connector`（新） | mindmap の枝などの「構造を表す線」（3:1 以上） | `#8E8E96` | `#707079` |

浮く面の中に divider を引かない: dark の浮く面 `#2A2A2E` の上の divider `#2E2E33` は 1.06:1 で見えない（light の divider / 白は 1.23:1）。浮く面の中は border（`#38383E` / `#2A2A2E` = 1.23:1、light は 1.29:1）で引く（§12.5 R1。G2c・G2d が値と使い方を確かめる）。

### 3.4 文字

| token | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-text-primary` | 本文・項目名・見出し | `#18181B` | `#EDEDEF` |
| `--fr-color-text-secondary` | ラベル・section の見出し・icon・subtext・説明 | `#52525B` | `#B4B4BC` |
| `--fr-color-text-tertiary` | placeholder・件数・日時・shortcut・補足 | `#64646C` | `#9A9AA2` |
| `--fr-color-text-muted` | **無効状態と飾りだけ**（意味のある文字に使わない。4.5:1 に届かない） | `#A1A1AA` | `#5F5F67` |
| `--fr-color-text-inverse`（新） | toast の文字 | `#FAFAFA` | `#FAFAFA` |

- `text-primary` は今と同じく `#RRGGBB` の 6 桁で書く（TC-FV-74 が 16 進を切り出して比べている）
- dark の `text-tertiary` は、hover した menu の行（4.24:1）と選択行（4.35:1）では 4.5:1 に届かない。**その 2 つの状態では secondary に切り替える**（§7.6・§7.1。menu の shortcut、選択行の補足）

### 3.5 アクセント（意味の token）

| token | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-primary` | 主ボタンの塗り、drop 線、resize バー、checkbox の `accent-color`、選択タブ・ON の指標 | `var(--fr-accent-600)` | `var(--fr-accent-600)` |
| `--fr-color-primary-hover`（新） | 主ボタンの hover | `var(--fr-accent-700)` | `var(--fr-accent-700)` |
| `--fr-color-primary-active`（新） | 主ボタンの押下 | `var(--fr-accent-800)` | `var(--fr-accent-800)` |
| `--fr-color-primary-strong` | **accent の文字と icon**（link・tag・検索結果の file 見出し・ON の icon・menu の check） | `var(--fr-accent-700)` | `var(--fr-accent-400)` |
| `--fr-color-primary-soft` | tag の地・ON のボタンの地・選択の地 | `var(--fr-accent-100)` | `var(--fr-accent-soft-dark)` |
| `--fr-color-primary-soft-hover`（新） | tag の hover、focus 行・選択した mindmap の node の上の tag の pill（soft との段差 1.17:1 / 1.21:1） | `var(--fr-accent-200)` | `var(--fr-accent-soft-hover-dark)` |
| `--fr-color-primary-strong-hover`（新） | primary-soft-hover の上の accent の文字（tag の hover など）。dark は一段明るくする（`#6EA6FE` のままだと 4.10:1） | `var(--fr-accent-700)` | `var(--fr-accent-300)` |
| `--fr-color-primary-fg` | primary の塗りの上の文字 | `#FFFFFF` | `#FFFFFF` |
| `--fr-color-accent`（廃止予定の alias） | 旧・第 2 の accent（紫）。今は 3 か所（folder link の icon、mindmap の関係線）| `var(--fr-color-primary)` | 同左 |
| `--fr-color-accent-soft`（廃止予定の alias） | | `var(--fr-color-primary-soft)` | 同左 |

dark でも primary を 600 のままにするのは、白文字を 4.5:1 以上に保つため（500 にすると 3.49:1）。そのかわり dark の浮く面の上では 600 の指標が 2.82:1 になるので、**浮く面の上の指標・icon は `primary-strong` か `focus-ring` を使う**（menu の check、dialog の中の入力欄の focus の縁）。

### 3.6 選択と focus

| token | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-selection-bg` | note tree・linkedfd の複数選択とキーボードの focus 行、outliner の focus 行、mindmap の選択、drag-over | `var(--fr-color-primary-soft)`（`#E3EEFF`） | `var(--fr-color-primary-soft)`（`#263651`） |
| `--fr-color-selection-bar`（廃止予定の alias） | 旧・現在地の 1px バー（使わなくなる） | `var(--fr-color-primary)` | 同左 |
| `--fr-color-text-selection`（新） | `::selection`（文字の範囲選択）と command palette の選択の highlight | `rgba(var(--fr-accent-rgb), .20)` | `rgba(var(--fr-accent-light-rgb), .32)` |
| `--fr-color-focus-ring`（新） | キーボードの focus ring、入力欄の focus の縁 | `var(--fr-accent-600)` | `var(--fr-accent-400)` |
| `--fr-color-focus-halo`（新） | 入力欄の focus の外側の淡い輪 | `rgba(var(--fr-accent-rgb), .22)` | `rgba(var(--fr-accent-light-rgb), .30)` |
| `--outliner-selection-bg`（outliner.css・**値は変えない**） | outliner の node 選択（amber。ADRL-0115） | `rgba(255,193,7,.30)` | `rgba(255,202,40,.22)` |
| `--outliner-selection-text-bg`（outliner.css） | outliner の `::selection`（青のまま） | `var(--fr-color-text-selection)` | 同左（dark の 2 ブロックにも同じ行） |

- `--fr-color-selection-bg` は黄色にしない・`--fr-bg-selection` は定義しない（TC-OSM-34）。amber は outliner.css の 3 ブロックに rgba の直書きで残す（TC-OSM-33 は rgba の直書き 3 行・light と dark で別の alpha を求める。TC-OSM-35 は alpha < 0.4）
- `var(--fr-color-text-selection)` を参照しても、計算後の値は `rgba(10, 104, 230, .20)` の形で返るので、TC-OSM-31（`::selection` の token が B > R）の読み取りは通る

### 3.7 状態色（status）

| token | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-success` | 成功の icon・指標 | `#16A34A` | `#22C55E` |
| `--fr-color-success-text`（新） | 成功の文字（S3 の「OK」など） | `#11733A` | `#4ADE80` |
| `--fr-color-success-soft` | 成功の地 | `#DCFCE7` | `#1F3A2C` |
| `--fr-color-warning` | 注意の icon・縁（md → .out の drop の 2px の縁） | `#D97706` | `#F59E0B` |
| `--fr-color-warning-text`（新） | 注意の文字 | `#A14907`（案 A では `#A64B07`。A5 の開いている行の上でも 4.5:1 にするため濃くした — §13） | `#FBBF24` |
| `--fr-color-warning-soft` | 注意の地（md → .out の drop の地） | `#FEF3C7` | `#41331E` |
| `--fr-color-danger` | 危険の文字と icon（menu の Delete など）。light では塗りにも使える | `#C21D1D`（案 A では `#C81E1E`。同上） | `#F87171` |
| `--fr-color-danger-solid`（新） | 危険ボタンの塗り（白文字） | `#C81E1E` | `#DC2626` |
| `--fr-color-danger-soft` | 危険の地（Delete の hover） | `#FEE2E2` | `#402527` |
| `--fr-color-info` | 情報の文字 | `var(--fr-color-primary-strong)` | 同左 |
| `--fr-color-info-soft` | 情報の地 | `var(--fr-color-primary-soft)` | 同左 |

dark の soft は半透明（success `rgba(34,197,94,.16)` など）を本文 `#1F1F22` に重ねて**不透明の 16 進にした値**。行の地（選択・amber）に重なっても文字の比が変わらないようにするため。

### 3.8 検索と強調

| token | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-search-hit`（参照だけあって未定義だったものを定義） | 検索の一致 | `rgba(255,255,0,.40)` | `rgba(255,230,0,.25)` |
| `--fr-color-search-current`（同上） | 今いる一致 | `rgba(255,165,0,.60)` | `rgba(255,140,0,.45)` |
| `--outliner-match-bg`（変えない） | outliner の絞り込みで一致した行 | `rgba(255,200,0,.20)` | 同左 |
| `--fr-color-jump-flash`（新） | 検索の結果から飛んだ先の 2 秒の flash（md の段落・outliner の行・note tree の行の 60% 以降） | `rgba(255,200,0,.25)` | `rgba(255,200,0,.25)` |
| `--fr-color-jump-flash-strong`（新） | 同じ flash の強い方（md の一致した語・note tree の行の出だし） | `rgba(255,200,0,.55)` | `rgba(255,200,0,.40)` |

- light は今の値のまま（styles.css・outliner.css・editor.js・mindmap.css・各 viewer に散っている 6 組を token に集める）。dark だけ alpha を下げた（今の値では明るい文字が 3.94:1 / 3.68:1 になる）
- 検索の強調は amber の選択より強い（dark: 一致 `#57511A` > amber `#504523`）。ADRL-0115 の「重なったら検索が勝つ」を保つ
- 検索の結果から飛んだ先の 2 秒の flash は、md・outliner・note tree の 3 か所で同じ amber の token にする（§12.5 R10）。outliner と md の段落は今の値（`rgba(255,200,0,.25)`）のまま、md の一致した語も今の `.55`。note tree の行は今の金色（`rgba(255,215,64,.85)` から消える）を同じ amber の強い方 → 薄い方 → 透明にそろえる（dark の `.85` は明るい文字が 1.61:1 で読めなかった。dark の強い方は `.40` = 4.98:1）

### 3.9 本文（md）の色

| token | 役割 | light | dark |
|---|---|---|---|
| `--fr-color-code-bg`（新）→ 旧 `--code-bg` | inline code の地 | `#F4F4F5` | `#2C2C31` |
| `--fr-color-code-block-bg`（新。styles.css の pre が直接参照） | code block（pre）の地 | `#F7F7F8` | `#26262A` |
| `--blockquote-color`（付け替え） | 引用の文字（**今は白 = 見えない**） | `var(--fr-color-text-secondary)` | 同左 |
| `--blockquote-border`（付け替え） | 引用の左線 | `var(--fr-color-border-strong)` | 同左 |
| （md の table の見出し行の地） | 今は `--code-bg`。白い本文の上の薄い地に替える | `var(--fr-color-fill-subtle)` | 同左 |
| link | `--link-color` | `var(--fr-color-primary-strong)` | 同左 |

hljs の配色（GitHub light / dark）は本文の色なので変えない。code block の地は `#F2F1EA` → `#F7F7F8`（light）・`#25262E` → `#26262A`（dark）。**inline code と code block は両方のテーマで同じ向きに段を付ける**: light はどちらも本文より一段沈む（`#F4F4F5` / `#F7F7F8`）、dark はどちらも一段浮く（`#2C2C31` / `#26262A` — GitHub dark も code block `#161B22` > 本文 `#0D1117`）。dark の hljs の色は `#26262A` の上で 4.90–9.81:1（G2 が styles.css の値を読んで確かめる。§12.5 R13）。

### 3.10 scrollbar

| token | light | dark |
|---|---|---|
| `--fr-color-scrollbar-thumb` | `rgba(24,24,27,.18)` | `rgba(255,255,255,.18)` |
| `--fr-color-scrollbar-thumb-hover` | `rgba(24,24,27,.32)` | `rgba(255,255,255,.30)` |

### 3.11 chip（table の multiselect）の 8 色

今の 8 色は dark 用の明るい文字しか持たず、light では 1.07–2.55:1 で読めない（`#docs` の黄色はほぼ見えない）。light / dark で別の組にし、**地は不透明**にする（選択行の amber や focus 行の青に重なっても比が変わらない）。

| token（新） | light 地 | light 文字 | light 比 | dark 地 | dark 文字 | dark 比 |
|---|---|---|---:|---|---|---:|
| `--fr-chip-red-bg / -fg` | `#FEE2E2` | `#B91C1C` | 5.30 | `#492629` | `#FCA5A5` | 6.95 |
| `--fr-chip-orange-bg / -fg` | `#FFEDD5` | `#B93C0B` | 4.93 | `#4B3020` | `#FDBA74` | 7.14 |
| `--fr-chip-yellow-bg / -fg` | `#FEF3C7` | `#8A5A00` | 5.32 | `#483D1D` | `#FDE047` | 8.12 |
| `--fr-chip-green-bg / -fg` | `#DCFCE7` | `#137A3A` | 4.94 | `#203D2D` | `#86EFAC` | 8.46 |
| `--fr-chip-blue-bg / -fg` | `#E3EEFF` | `#0256C3` | 5.75 | `#263651` | `#9EC4FF` | 6.82 |
| `--fr-chip-purple-bg / -fg` | `#F3E8FF` | `#7E22CE` | 5.92 | `#3D2B51` | `#D8B4FE` | 7.14 |
| `--fr-chip-pink-bg / -fg` | `#FCE7F3` | `#BE185D` | 5.14 | `#48273A` | `#F9A8D4` | 7.12 |
| `--fr-chip-zinc-bg / -fg` | `#F1F1F3` | `#52525B` | 6.85 | `#39393D` | `#D4D4D8` | 7.78 |

- class 名（`.outliner-chip-color-red` 等）と色の名前は変えない（outliner.js:4355, 4481 が使う）。outliner.css:1919-1926 の 8 行を token の参照に替える
- chip の色は accent ramp と独立（accent を紫にしても chip の blue は青のまま）
- note の 20 色（`notes-color-palette.js`。ユーザーが選ぶ中身の色）と inline の文字色は**変えない**（test が値を固定している中身の色）

### 3.12 旧 alias の付け替え（tokens.css の 3 ブロックの中）

旧名はそのまま残し、**指す先**を替える。値が変わるだけで、参照している側の CSS は触らなくてよい。

| 旧 alias | 今の指す先 | 新しい指す先 | 理由 |
|---|---|---|---|
| `--bg-color` | `bg-app` | `bg-app`（そのまま。値が白になる） | — |
| `--toolbar-bg` | `bg-panel` | **`bg-app`** | note 面のヘッダー行は本文の面に置く（§7.3） |
| `--sidebar-bg` / `--sidebar-border` | `bg-panel` / `divider` | そのまま | md の Outline は sidebar の面（folder-view.spec.ts:887 の test は `#sidebar` の地 = `--sidebar-bg`・角 0・影なしを見るだけ） |
| `--code-bg` | `#F2F1EA` / `#25262E`（直書き） | `var(--fr-color-code-bg)` | 暖色の直書きをやめる |
| `--blockquote-color` | `bg-elevated` | **`text-secondary`** | 不具合の修正（文字が白で見えない） |
| `--blockquote-border` | `border` | `border-strong` | |
| `--selection-bg` | `primary-soft` | そのまま（青の選択） | ただし hover に使っている約 20 か所は `fill-hover` に移す（§10.2） |
| `--outliner-hover` / `--outliner-hover-bg` | `bg-elevated` | **`fill-hover`** | 白の上の白で消えていた |
| `--outliner-text-focus-bg` | `bg-elevated` | `transparent` | 使われていない。編集中の文字に地を付けない（ユーザー裁定） |
| `--outliner-search-bg` | `bg-elevated` | **`fill-subtle`** | 入力欄の地。**ただし outliner の右クリック menu（outliner.css:905）が地に使っているので、そこは `bg-elevated` に替える** |
| `--outliner-search-border` | `border` | `transparent` | 入力欄は縁でなく地で示す（focus で縁が出る） |
| `--outliner-code-bg` | `bg-elevated` | `var(--fr-color-code-bg)` | 白い本文の上で消えていた |
| `--outliner-tag-hover-bg` | `primary-soft` | `primary-soft-hover` | hover と地が同じ色だった |
| `--outliner-tag-hover-color`（新） | — | `primary-strong-hover` | primary-soft-hover の上の tag の文字（dark は一段明るい） |
| `--outliner-subtext` / `--outliner-subtext-color` | `text-tertiary` | `text-secondary` | subtext は .68em と小さいので濃くする（focus 行の上でも 4.5:1） |
| `--outliner-page-icon-color` | `primary` | `text-secondary` | icon は無彩色（P2） |
| `--outliner-accent-fg` | `primary-fg` | そのまま | ただし **accent の色として使っている 6 か所**（outliner.css:348, 1487, 1488, 1498, 1502 / mindmap.css:425 — 選択した画像の縁が白になっている不具合）は `--fr-color-primary` に替える |
| `--outliner-border` / `--outliner-active` / `--outliner-focus-bg` / `--outliner-tag-color` / `--outliner-tag-bg` / `--outliner-checkbox-accent` | | そのまま（値が新しくなる） | |
| `--outliner-scrollbar-thumb(-hover)` | 直書き | `var(--fr-color-scrollbar-thumb(-hover))` | 値を 1 か所にする |

outliner.css の dark の 2 ブロック（:1108-1137 と :1138-1169。layer の外なので tokens を上書きしている）は、**`--outliner-selection-bg` / `--outliner-selection-text-bg` / `--outliner-match-bg` の 3 行だけを残して他を消す**。VS Code Dark+ の値（`#1e1e1e` `#3c3c3c` `#569cd6` …）がここで勝っていて、dark の outliner だけ色が違う継ぎ目の原因になっている。

### 3.13 足す・名前を変える・やめる token の一覧

- **足す**: `--fr-accent-{100,200,300,400,600,700,800}`, `--fr-accent-soft-dark`, `--fr-accent-soft-hover-dark`, `--fr-accent-rgb`, `--fr-accent-light-rgb` / `--fr-color-bg-chrome`, `--fr-color-bg-canvas`, `--fr-color-bg-inverse`, `--fr-color-overlay`, `--fr-color-overlay-strong` / `--fr-color-fill-{subtle,hover,active}` / `--fr-color-border-strong`, `--fr-color-connector` / `--fr-color-text-inverse` / `--fr-color-primary-{hover,active,soft-hover,strong-hover}` / `--fr-color-text-selection`, `--fr-color-focus-ring`, `--fr-color-focus-halo` / `--fr-color-{success,warning}-text`, `--fr-color-danger-solid` / `--fr-color-search-{hit,current}`（参照はあるが未定義だった）/ `--fr-color-jump-flash(-strong)` / `--fr-color-code-bg`, `--fr-color-code-block-bg` / `--fr-chip-*-{bg,fg}`（16 個）/ `--fr-shadow-4`, `--fr-radius-xl`, `--fr-space-12`, `--fr-space-16`, `--fr-text-2xs`, `--fr-duration-*`, `--fr-ease-*`（§5）
- **値だけ変える**: 既存の `--fr-color-*` すべて、`--fr-shadow-1..3`（テーマのブロックの中へ移す）、`--fr-shadow-focus`、`--fr-text-*`（12px 基準 → 13px 基準。使っているのは死んでいる fr-components.css だけなので安全）、`--fr-font-sans`, `--fr-font-mono`
- **名前を変えない**: すべて。改名はしない（参照が 400 か所以上ある）
- **やめる（alias にして残す）**: `--fr-color-accent`, `--fr-color-accent-soft`, `--fr-color-selection-bar`
- **定義しない**: `--fr-bg-selection`（ADRL-0115・TC-OSM-34）。mindmap.css などで使っている**存在しない名前**（`--fr-bg-app`, `--fr-bg-panel`, `--fr-text`, `--fr-border`, `--hover-bg`, `--text-muted`, `--accent-color`, `--fr-shadow-sm`, `--fr-color-warning-bg`, `--fv-bg` …）は alias を作らず、**参照している側を本物の token に直す**（2 つ目の命名体系を作らない — §10.3 の対応表）

### 3.14 token の書き方の決まり

1. **3 つのブロックを必ずそろえる**: `:root, [data-fr-theme=light], [data-fr-theme=auto]`（light）/ `[data-fr-theme=dark]` / `@media (prefers-color-scheme: dark) { [data-fr-theme=auto] }`。dark と auto-dark は**同じ key と同じ値**。§10.5 の G1 テストで機械的に確かめる（今は人が 3 回書き写している）
2. **影もテーマのブロックに入れる**（dark は影の濃さが違う）
3. **`color-scheme` を書く**: light ブロックに `color-scheme: light;`、dark と auto-dark に `color-scheme: dark;`。native の checkbox・select・scrollbar・日付入力が dark で白いまま残る問題を直す
4. **`accent-color` を書く**: fr-base で `:root { accent-color: var(--fr-color-primary); }`。md の task の checkbox（今は accent-color が無い）と outliner の checkbox が同じ色になる
5. 値は 16 進か rgba / rgb の直書き（§3.1）。部品の CSS に色の直書きを足さない（足すなら token を足す）

---

## 4. コントラストの検証（WCAG 2.2 AA）

### 4.1 方法と基準

- 比は WCAG の相対輝度の式（付録 A）。半透明の塗りは、下の面に重ねた不透明の色にしてから測る
- 基準: **意味のある文字 4.5:1**（UI の文字はほぼ 11–13px なので「大きい文字」の 3:1 は使わない）。**指標と部品の縁 3:1**（1.4.11 — focus ring、drop 線、resize バー、checkbox、mindmap の枝）。`text-muted` は無効状態と飾り専用なので対象外（WCAG も無効状態を除外している）
- 面の段差（sidebar と本文、hover の塗り、区切り線）は見え方の目安で、WCAG の対象外。値は §2・§3.2 に書いた
- 下の表で **太字**は 4.5:1 に届かない組。その組は使わない決まりで逃がしている（表の下に書く）

### 4.2 文字 × 面（light）

| 文字 token | 本文 | sidebar | 浮く面 | field/本文 | field/sidebar | hover/sidebar | hover/浮く面 | active/sidebar | 選択 | inline code | code block |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| text-primary `#18181B` | 17.72 | 16.21 | 17.72 | 16.39 | 14.96 | 14.56 | 15.83 | 13.64 | 15.14 | 16.12 | 16.55 |
| text-secondary `#52525B` | 7.73 | 7.07 | 7.73 | 7.15 | 6.53 | 6.35 | 6.90 | 5.95 | 6.60 | 7.03 | 7.22 |
| text-tertiary `#64646C` | 5.86 | 5.37 | 5.86 | 5.43 | 4.95 | 4.82 | 5.24 | 4.51 | 5.01 | 5.33 | 5.48 |
| primary-strong `#0256C3` | 6.73 | 6.16 | 6.73 | 6.22 | 5.68 | 5.53 | 6.01 | 5.18 | 5.75 | 6.12 | 6.28 |
| danger `#C21D1D` | 6.02 | 5.51 | 6.02 | 5.57 | 5.08 | 4.95 | 5.38 | 4.64 | 5.14 | 5.48 | 5.62 |
| success-text `#11733A` | 5.94 | 5.43 | 5.94 | 5.49 | 5.01 | 4.88 | 5.30 | 4.57 | 5.07 | 5.40 | 5.55 |
| warning-text `#A14907` | 6.05 | 5.54 | 6.05 | 5.60 | 5.11 | 4.97 | 5.40 | 4.66 | 5.17 | 5.50 | 5.65 |
| （参考）text-muted `#A1A1AA` | 2.56 | 2.35 | 2.56 | 2.37 | 2.16 | 2.11 | 2.29 | 1.97 | 2.19 | 2.33 | 2.39 |

light はすべての組で 4.5:1 以上（採用した A5 の左パネル `#F5F4FB` と、濃くした danger `#C21D1D`・warning-text `#A14907` で測った値。いちばん低いのは active/sidebar の tertiary 4.51。案 A のときの値は tag `design/A` のこの文書）。

### 4.3 文字 × 面（dark）

| 文字 token | 本文 | sidebar | 浮く面 | field/本文 | field/sidebar | hover/sidebar | hover/浮く面 | active/sidebar | 選択 | inline code | code block |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| text-primary `#EDEDEF` | 14.06 | 15.15 | 12.23 | 12.41 | 13.57 | 12.91 | 10.14 | 11.58 | 10.39 | 11.88 | 15.15 |
| text-secondary `#B4B4BC` | 7.98 | 8.60 | 6.94 | 7.04 | 7.70 | 7.33 | 5.75 | 6.57 | 5.90 | 6.74 | 8.60 |
| text-tertiary `#9A9AA2` | 5.89 | 6.34 | 5.12 | 5.19 | 5.68 | 5.40 | **4.24** | 4.85 | **4.35** | 4.97 | 6.34 |
| primary-strong `#6EA6FE` | 6.69 | 7.21 | 5.82 | 5.90 | 6.46 | 6.14 | 4.82 | 5.51 | 4.94 | 5.65 | 7.21 |
| danger `#F87171` | 5.94 | 6.40 | 5.17 | 5.24 | 5.74 | 5.46 | **4.28** | 4.89 | **4.39** | 5.02 | 6.40 |
| success-text `#4ADE80` | 9.43 | 10.17 | 8.20 | 8.32 | 9.11 | 8.66 | 6.80 | 7.77 | 6.97 | 7.97 | 10.17 |
| warning-text `#FBBF24` | 9.85 | 10.61 | 8.56 | 8.69 | 9.50 | 9.04 | 7.10 | 8.11 | 7.28 | 8.32 | 10.61 |
| （参考）text-muted `#5F5F67` | 2.60 | 2.80 | 2.26 | 2.29 | 2.51 | 2.39 | 1.87 | 2.14 | 1.92 | 2.20 | 2.80 |

（code block の列は §12.5 R13 で地を `#26262A` にした後の値。text-primary 12.89 / secondary 7.32 / tertiary 5.40 / primary-strong 6.14 / danger 5.45 / success-text 8.65 / warning-text 9.03 — どれも 4.5:1 以上）

届かない 4 組の逃がし方（どちらも部品の決まりで「その組を作らない」）:
- **tertiary × hover した menu 行 / 選択行**: hover した menu 行の shortcut、選択行の件数・補足は **secondary に切り替える**（5.75 / 5.90）。§7.6・§7.1
- **danger × hover した menu 行 / 選択行**: 危険な項目の hover は `fill-hover` でなく `danger-soft`（5.02）。選択行の中に危険色の文字は置かない

### 4.4 組み合わせ（ボタン・tag・強調・指標）

| 組み合わせ | light 前景 / 背景 | light 比 | dark 前景 / 背景 | dark 比 | 基準 |
|---|---|---:|---|---:|---:|
| 主ボタンの文字（primary-fg / primary） | `#FFFFFF` / `#0A68E6` | 5.08 | `#FFFFFF` / `#0A68E6` | 5.08 | 4.5 |
| 同 hover（primary-hover） | `#FFFFFF` / `#0256C3` | 6.73 | `#FFFFFF` / `#0256C3` | 6.73 | 4.5 |
| 同 押下（primary-active） | `#FFFFFF` / `#06469E` | 8.83 | `#FFFFFF` / `#06469E` | 8.83 | 4.5 |
| 危険ボタン（白 / danger-solid） | `#FFFFFF` / `#C81E1E` | 5.74 | `#FFFFFF` / `#DC2626` | 4.83 | 4.5 |
| toast（text-inverse / bg-inverse） | `#FAFAFA` / `#18181B` | 16.97 | `#FAFAFA` / `#3A3A40` | 10.82 | 4.5 |
| tag（primary-strong / primary-soft） | `#0256C3` / `#E3EEFF` | 5.75 | `#6EA6FE` / `#263651` | 4.94 | 4.5 |
| tag の hover・focus 行の上の tag（primary-strong-hover / primary-soft-hover） | `#0256C3` / `#C9DEFF` | 4.93 | `#9EC4FF` / `#29426B` | 5.65 | 4.5 |
| （段差・目安）tag の pill / focus 行（primary-soft-hover / primary-soft） | `#C9DEFF` / `#E3EEFF` | 1.17 | `#29426B` / `#263651` | 1.21 | 1.15 |
| 危険な項目の hover の shortcut（secondary / danger-soft） | `#52525B` / `#FEE2E2` | 6.33 | `#B4B4BC` / `#402527` | 6.74 | 4.5 |
| 本文 / jump-flash・jump-flash-strong | `#18181B` / `#FFF1BF`・`#FFE173` | 15.68・13.73 | `#EDEDEF` / `#57491A`・`#796314` | 7.57・4.98 | 4.5 |
| table の chip の ×（chip の文字 × 不透明度 .8 / chip の地） | 8 色 | 3.43–4.23 | 8 色 | 5.00–6.04 | 3.0 |
| success-text / success-soft | `#11733A` / `#DCFCE7` | 5.41 | `#4ADE80` / `#1F3A2C` | 7.09 | 4.5 |
| warning-text / warning-soft | `#A14907` / `#FEF3C7` | 5.43 | `#FBBF24` / `#41331E` | 7.33 | 4.5 |
| danger / danger-soft（危険項目の hover） | `#C21D1D` / `#FEE2E2` | 4.93 | `#F87171` / `#402527` | 5.02 | 4.5 |
| 本文 / `::selection` | `#18181B` / `#CEE1FA` | 13.31 | `#EDEDEF` / `#384A68` | 7.65 | 4.5 |
| 本文 / search-hit | `#18181B` / `#FFFF99` | 16.89 | `#EDEDEF` / `#57511A` | 6.92 | 4.5 |
| 本文 / search-current | `#18181B` / `#FFC966` | 11.64 | `#EDEDEF` / `#845013` | 5.72 | 4.5 |
| 本文 / outliner の amber 選択 | `#18181B` / `#FFECB5` | 15.12 | `#EDEDEF` / `#504523` | 8.10 | 4.5 |
| subtext（secondary）/ amber 選択 | `#52525B` / `#FFECB5` | 6.60 | `#B4B4BC` / `#504523` | 4.60 | 4.5 |
| subtext（secondary）/ focus 行（selection-bg） | `#52525B` / `#E3EEFF` | 6.60 | `#B4B4BC` / `#263651` | 5.90 | 4.5 |
| menu の shortcut（hover 行では secondary） | `#52525B` / `#F2F2F2` | 6.90 | `#B4B4BC` / `#37373B` | 5.75 | 4.5 |
| primary（drop 線・resize バー・checkbox）/ 本文 | `#0A68E6` / `#FFFFFF` | 5.08 | `#0A68E6` / `#1F1F22` | 3.24 | 3.0 |
| primary / sidebar | `#0A68E6` / `#F5F4FB` | 4.65 | `#0A68E6` / `#18181B` | 3.49 | 3.0 |
| focus-ring / 本文 | `#0A68E6` / `#FFFFFF` | 5.08 | `#6EA6FE` / `#1F1F22` | 6.69 | 3.0 |
| focus-ring / sidebar | `#0A68E6` / `#F5F4FB` | 4.65 | `#6EA6FE` / `#18181B` | 7.21 | 3.0 |
| focus-ring / 浮く面 | `#0A68E6` / `#FFFFFF` | 5.08 | `#6EA6FE` / `#2A2A2E` | 5.82 | 3.0 |
| connector（mindmap の枝）/ 本文 | `#8E8E96` / `#FFFFFF` | 3.25 | `#707079` / `#1F1F22` | 3.35 | 3.0 |

chip の 8 色は §3.11（light 4.93–6.85、dark 6.82–8.46）。

### 4.5 紫に差し替えたときの accent の組

| 組み合わせ | light | dark | 基準 |
|---|---:|---:|---:|
| 主ボタンの文字 / hover / 押下 | 5.44 / 7.17 / 9.36 | 5.44 / 7.17 / 9.36 | 4.5 |
| tag / tag の hover | 6.08 / 5.16 | 4.82 / 5.60（hover は 300 `#C3B7FE` / `#46396B`） | 4.5 |
| 本文 / `::selection` | 13.25 | 7.71 | 4.5 |
| subtext / focus 行 | 6.56 | 5.96 | 4.5 |
| primary / 本文・sidebar | 5.44 / 4.98 | 3.02 / 3.25 | 3.0 |
| focus-ring / 本文・sidebar・浮く面 | 5.44 / 4.98 / 5.44 | 6.45 / 6.95 / 5.61 | 3.0 |

紫でも全部通る（無彩色・状態色・chip は ramp と独立なので §4.2–4.4 の値のまま）。

### 4.6 今の配色との比較（同じ方法で測った値）

| 組み合わせ | 今 | 新 |
|---|---:|---:|
| accent の塗りの上の白文字（mindmap のタイトル、ftp の実行ボタン等）| 1.79 | 5.08 |
| link・tag の文字（`#3994BC`）/ 地 `#FAFAF7` | 3.27 | 6.73 |
| tag の文字 / tag の地 | 2.86 | 5.75 |
| tertiary（placeholder・subtext）/ 地 | 2.51 | 5.86 |
| focus ring（`#DEEDF5`）/ 地 | 約 1.1 | 5.08 |
| blockquote の文字 | 1.0（見えない） | 7.73 |
| chip（light） | 1.07–2.55 | 4.93–6.85 |

---

## 5. 形・余白・文字・icon・動き

### 5.1 影と高さ（elevation）

影はテーマのブロックに入れる（dark は濃い）。浮く面は**影 + 1px の `border`** をいつも組みにする（dark では影がほとんど見えないため、縁で浮かせる）。今ある約 41 種類の直書きの影は、この 4 段のどれかに寄せる。

| 段 | token | light | dark | 使う所 |
|---|---|---|---|---|
| 0 | なし | — | — | 面（本文・sidebar・ヘッダー）。面は影で分けず線で分ける |
| 1 | `--fr-shadow-1` | `0 1px 2px rgba(17,17,20,.06)` | `0 1px 2px rgba(0,0,0,.30)` | mindmap の node、PDF などの紙面、input 内の小さな部品 |
| 2 | `--fr-shadow-2` | `0 1px 3px rgba(17,17,20,.06), 0 6px 16px rgba(17,17,20,.10)` | `0 1px 3px rgba(0,0,0,.30), 0 6px 16px rgba(0,0,0,.40)` | menu・dropdown・popover・tag の候補・日付の picker・minimap |
| 3 | `--fr-shadow-3` | `0 2px 6px rgba(17,17,20,.06), 0 12px 32px rgba(17,17,20,.14)` | `0 2px 6px rgba(0,0,0,.30), 0 12px 32px rgba(0,0,0,.50)` | 浮く toolbar・sidepanel・toast・command palette |
| 4 | `--fr-shadow-4`（新） | `0 4px 12px rgba(17,17,20,.08), 0 24px 64px rgba(17,17,20,.22)` | `0 4px 12px rgba(0,0,0,.35), 0 24px 64px rgba(0,0,0,.60)` | dialog・shortcut の HUD |
| focus | `--fr-shadow-focus` | `0 0 0 3px var(--fr-color-focus-halo)` | 同左 | 入力欄の focus（縁を `focus-ring` にした上に重ねる） |

ボタンの focus は影でなく `outline: 2px solid var(--fr-color-focus-ring); outline-offset: 1px;`（:focus-visible のときだけ）。

### 5.2 角の丸み

| token | 値 | 使う所 |
|---|---|---|
| `--fr-radius-xs` | 4px | inline code、本文の中の tag、kbd、code block の見出しのボタン、checkbox 周り |
| `--fr-radius-sm` | 6px | ボタン・icon ボタン・入力欄・tree の行・menu の項目・タブの pill・画像の thumbnail |
| `--fr-radius-md` | 8px | code block・mermaid / 数式の枠・mindmap の node・カード |
| `--fr-radius-lg` | 10px | menu・dropdown・popover・浮く toolbar・toast・tag の候補・日付の picker |
| `--fr-radius-xl`（新） | 14px | dialog・command palette・action panel・shortcut の HUD |
| `--fr-radius-full` | 9999px | chip・pinned tag・件数の badge・scrollbar の thumb |

- **入れ子は同心円にする**: 外の角 = 中の角 + 内側の余白（menu: 10 = 6 + 4）
- 例外: outliner の検索欄と linkedfd の検索欄は 5px のまま（TC-FLV-57 が 5px を固定。6px との差は見えない。そろえるなら test と同時に）
- table のセル・画面の端に付く面（sidepanel・タブ strip）は角を付けない

### 5.3 余白

`--fr-space-*` はそのまま（0, 2, 4, 6, 8, 10, 12, 16, 20）に `--fr-space-12: 24px` / `--fr-space-16: 32px` を足す。

- 並べ方は 4px 刻み。2px は icon の位置合わせだけ
- 行の塗りは panel の端から 6px 内側（角の丸みが panel の縁に触れない — Quick と Figma の選択行の形）。**寄せるのは塗りだけ**: 左右 6px の透明な縁 + `background-clip: padding-box`、外の角は 横 12px / 縦 6px（縁の内側の角が 6px になる）。margin で寄せると端の 6px が行でなくなり、押しても何も起きない・linkedfd では drop が root へ・右クリックが空き領域の menu になる（§12.5 R17）。状態の塗りは `background-color` で書く（`background` の一括指定は clip を戻す）。note tree の行（`.file-panel-item`）は前から外側 4px の margin だったので今回は変えない
- section の間は 8px、dialog の内側は 20px、popover / menu の内側は 4px、menu の項目は左右 10px
- 余白を増やして「今風」に見せない（P5）。増やすのは、今 9–10px の小さな文字の周りだけ

### 5.4 文字

**書体**（system UI を先に。和文は OS の UI 書体）:

```css
--fr-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN",
                "Yu Gothic UI", Meiryo, "Noto Sans JP", "Noto Sans", system-ui, sans-serif;
--fr-font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Cascadia Mono", "Liberation Mono", monospace;
```

- 今は sans の stack が 3 つある（styles.css の `--font-family`、outliner.css:63、tokens の `--fr-font-sans`）。**全部 `--fr-font-sans` にする**（styles.css の `--font-family: var(--fr-font-sans)`、`--font-mono: var(--fr-font-mono)`、outliner の container も同じ）。viewer の toolbar の `--vscode-font-family` も Fractal の token にする（P7）
- **text viewer の中身（.txt / .log など）の書体と大きさだけは、利用者の editor の設定に従う**: `var(--vscode-editor-font-family, var(--fr-font-mono))` / `var(--vscode-editor-font-size, 13px)`（Electron は theme.ts が入れる）。色ではない利用者の設定（大きい editor.fontSize を使う人の文字が小さくならない・拡大の基準もこの大きさ）なので P7 の対象外。G3 も書体・大きさの変数は数えない（§12.5 R16）
- `system-ui` は最後に置く（Windows で locale により和文が中国語の字形になる問題を避ける。GitHub の stack と同じ考え方）
- Inter は使わない。3 つの webview が Google Fonts から読んでいるが、どの font-family も名指ししていない。オフラインで使う note アプリが外のサーバーから書体を取りに行く理由が無いので、**読み込みと CSP の `fonts.googleapis.com` / `fonts.gstatic.com` を外す**のを別の小さな変更として勧める（§10.1 Phase 3）

**UI の大きさ**（chrome。本文の大きさの設定とは独立。部品は px を直書きせず token を使い、基準は `--fr-text-base` 1 か所で変えられるようにする）:

| token | 大きさ / 行の高さ | 太さ | 使う所 |
|---|---|---|---|
| `--fr-text-2xs`（新） | 10px / 12px | 600 | 件数の badge（outliner の子の数）だけ |
| `--fr-text-xs` | 11px / 14px | 500–600 | section の見出しの補足、chip、shortcut、日時、code block の見出し、+out などの小ボタン |
| `--fr-text-sm` | 12px / 16px | 400–600 | 入力欄・検索欄、table の列見出し、section の見出し、タブ、breadcrumb、Recent の行、sidepanel の目次 |
| `--fr-text-base` | **13px** / 18px | 400 / 500 | note tree の行、menu の項目、ボタン、dialog の本文、パネルの title（600）、viewer・linkedfd・sidepanel のヘッダーの名前 |
| `--fr-text-md` | 14px / 20px | 600 | dialog の title |
| `--fr-text-lg` | 16px / 22px | 600 | 空の状態の見出し |
| `--fr-text-xl` / `--fr-text-2xl` | 20px / 24px | 700 | （予約） |

- 9px 以下の文字をなくす（今は 7px の code block の見出し、8px の子の数、9–10px の見出しがある）
- 太さは 400 / 500 / 600 / 700 だけ。大文字化（`text-transform: uppercase`）と字間の広げは使わない（FAVORITES → 「お気に入り / Favorites」のまま。和文 UI で大文字化は効かず、英文だけ 2018 年頃の見た目になる）
- 日付・件数・table の数字は `font-variant-numeric: tabular-nums`

**本文の大きさ**（`fractal.fontSize` = `--font-size` / `--outliner-font-size` に比例。em で書く）:

| 面 | 大きさ | 行の高さ | 備考 |
|---|---|---|---|
| md の段落 | `--font-size`（既定 12px → **13px を提案**、§11 Q1） | 1.44 → **1.6 を提案**（§11 Q6） | 和文の本文は 1.6 以上が読みやすい |
| md H1 / H2 / H3 | 1.75em / 1.4em / 1.17em | 1.25 / 1.3 / 1.35 | 700 / 600 / 600。**下線をやめる**（§11 Q4）。上の余白 1.2em / 1.5em / 1.3em、下 .5em / .45em / .4em |
| md H4 / H5 / H6 | 1em / .92em / .85em | 1.4 | 600。H5 は secondary、H6 は tertiary |
| md の code | inline .86em / block .86em | block 1.55 | `--fr-font-mono` |
| outliner の行 | `--outliner-font-size` | 1.35（変えない） | |
| outliner のタイトル | 1.4em | 1.17 | 700（今 1.35em / 600） |
| outliner の subtext / tag | .68em / .81em | | subtext は secondary、tag は 500 |
| table のセル / 列見出し | `--outliner-font-size` / 12px | | 列見出しは 600 secondary |
| mindmap の node / root | 13px / 15px | 1.4 | **変えない**（mindmap-render.js と mindmap-interactions.js が 13px・行 1.4・左右の余白 20px・縁 1.5px を前提に幅を計算している） |

### 5.5 icon

- **Lucide の outline を使い続ける**。SVG の文字列は変えない（TC-FV-61 が 3 ファイルで同一を求める）。線の太さは CSS で `stroke-width: 1.75`（14–16px）・`2`（12px 以下）にする — CSS は SVG の属性より強いので markup を触らずに細くできる（Figma の細い線に近づく）
- **大きさ**: 14px が標準（toolbar・tree の行・menu・入力欄・sidepanel・viewer）。16px は浮く toolbar・dialog の閉じる・空の状態。12px は chevron・chip や tag の中。押せる範囲は 24 × 24 以上（ヘッダーは今の 26 × 25 のまま）。ヘッダーの ≡（☰ の文字 15px）と < >（14px）は固定（TC-HHN-06・outline-ui）
- **色**: `currentColor`。休み = `text-secondary` 相当、hover = `text-primary`、ON = `primary-strong`、無効 = 不透明度 .3。色を test が固定している所（viewer のボタン = `text-primary`、TC-FV-74）は「色 `text-primary` × 不透明度 .62」で同じ見え方にする（白の上で約 4.9:1、sidebar の上で約 4.8:1、dark の本文の上で約 6.2:1）
- 塗りの icon は状態を示すときだけ（お気に入りの星、check）
- emoji の icon は決まっている所だけ残す（linkedfd の 📄/📎 — ユーザー裁定と test、tree と検索結果の file の glyph 📕📗、outliner の page の 📄）。新しく emoji を icon に使わない
- 文字の glyph のボタンは固定されたもの（☰、Outline の ×）だけ残し、他（viewer の ✕、submenu の ▶）は Lucide の x / chevron-right（12px、tertiary）にする

### 5.6 動き

| token（新） | 値 | 使う所 |
|---|---|---|
| `--fr-duration-fast` | 80ms | hover の色 |
| `--fr-duration-base` | 140ms | menu・popover が出るとき（不透明度 0 → 1 と 2px の移動）、chevron の回転 |
| `--fr-duration-slow` | 200ms | sidepanel の出入り |
| `--fr-ease-standard` / `--fr-ease-exit` | `cubic-bezier(.2,0,0,1)` / `cubic-bezier(.4,0,1,1)` | |

閉じるときは即時。選択の切り替えに動きを付けない。`prefers-reduced-motion: reduce` では全部 0。fr-base のテーマ切り替えの transition（.15s）は 80ms にする（キーボードで tree を動かすと選択の色が遅れて見えるため）。

---

## 6. 状態の表し方（state model）

| 状態 | note tree | outliner（outline） | outliner（table） | linkedfd | mindmap | menu | toolbar のボタン |
|---|---|---|---|---|---|---|---|
| hover | `fill-hover` | **出さない**（ユーザー裁定「強調しない」） | 出さない | **出さない**（ユーザー裁定 2026-08-18） | 縁を `border-strong` | `fill-hover` | `fill-hover` |
| 現在地（開いている項目） | `fill-active` + 500（**1px の縦バーをやめる**） | — | — | — | — | — | — |
| キーボードの focus | `selection-bg`（行。ring は出さない — FR-TKN-01/06） | focus 行 = `selection-bg`、角 6px | focus 行のセル = `selection-bg` | `selection-bg` | 縁 `primary` + `focus-halo` 3px | `fill-hover` と同じ | `focus-ring`（:focus-visible） |
| 複数選択 | `selection-bg`（青） | **amber**（ADRL-0115） | amber | `selection-bg` | `selection-bg` + 縁 2px `primary` | — | — |
| drag の受け | `selection-bg` + 内側 1px `primary` | drop 線 2px `primary` | 同左 | `selection-bg` | — | — | — |
| 文字の範囲選択 | — | `::selection` = 青（`text-selection`） | 同左 | — | — | — | — |
| ON（切り替え） | — | — | — | — | — | check icon（`primary-strong`） | `primary-soft` + icon `primary-strong` |
| 無効 | 不透明度 .4 | — | — | — | — | 文字 `text-muted`、hover なし | 不透明度 .3 |

- **hover と現在地と選択は別の見え方**にする。今は note tree の hover と複数選択が同じ `#DEEDF5` で、2026-09-01 の裁定 R16 の不満（「青は hover / `.active` と重なる」）が残っている。hover と現在地は無彩色、選択だけ青
- 編集中の文字（outliner の text、md の本文）には focus の ring も地も付けない（ユーザー裁定。fr-base の決まりのまま）
- 連続した選択行は 1 つの塊に見せる: 隣り合う選択行の間の角を 0 にする（`.is-selected:has(+ .is-selected)` の下の角、`.is-selected + .is-selected` の上の角。outliner も tree も DOM が平ら（flat）なので兄弟の選択子で書ける。`:has()` は Chromium 105 以降）

---

## 7. 部品の決まり

### 7.1 サイドバーと note tree の行

| 部位 | 決まり |
|---|---|
| panel | 地 `bg-panel`、右の縁 1px `divider`。幅は変えない（既定 198px・最小 140px） |
| 一覧 | 上下の余白 4px / 8px |
| 行（file・folder の見出し） | 高さ 26px（`min-height`）、余白 4px 8px 4px **11px**（左 11px は chevron の場所。folder の icon と file の icon の位置合わせ FR-FA-01 を保つ）、外側 1px **6px**（今 4px）、角 6px、icon と文字の間 6px、文字 13px / 400 `text-primary`、行の間隔は 28px |
| folder の見出し | 文字の太さを 500 → **400**（file と同じ。現在地の 500 と紛れないように）。chevron は 12px の Lucide、`text-tertiary`、回転 140ms |
| icon | 14px、`text-secondary` 相当。.out の icon（document + bullets — 2026-08-24 のユーザー裁定）・note の 20 色はそのまま |
| 子の字下げ | 25px のまま（notes-color-palette の test が固定） |
| 状態 | §6。hover `fill-hover` / 現在地 `fill-active` + 500 / 選択とキーボードの focus `selection-bg` / 現在地かつ選択 = `selection-bg` + 500 / drag の受け `selection-bg` + `box-shadow: inset 0 0 0 1px var(--fr-color-primary)` / md → .out の drop `warning-soft` + 2px `warning` の outline（offset -2px）/ drop 線 2px `primary`、角 1px、左右 6px 内側 / drag 中は hover を出さない（FR-TF-16 のまま） |
| folder link | icon の色 `--fr-color-accent`（紫）→ `primary-strong`。切れた link は不透明度 .55 + 点線の取り消し線（今のまま） |
| 空の表示 | 12px `text-tertiary`、中央 |
| ヘッダー（36px） | ☰（26 × 25）+ note 名 13px / 600（hover で `fill-hover`、角 6px）+ < >（26 × 25）。形は変えない。☰ と < > の hover は `selection-bg`（青）→ `fill-hover` |
| 検索欄 | 高さ 26px、角 6px（TC-08b）、地 `fill-subtle`、縁は透明 1px、文字 12px、placeholder `text-tertiary`。focus で地 `bg-app` + 縁 `focus-ring` + `--fr-shadow-focus`。Aa / W / .* は 20 × 20、角 4px、11px / 500 `text-tertiary`、ON で `primary-soft` + `primary-strong`（focus 中だけ出す — 今のまま） |
| タブ（Notes / Sync / Results …） | 高さ 26px の pill、角 6px。非選択は icon だけ（`text-secondary`）、hover `fill-hover`、選択は `fill-active` + 文字 12px / 500 `text-primary`（D3 の形のまま）。タブの行の下に 1 本だけ `divider` |
| お気に入り | 見出しの行 28px:「お気に入り / Favorites」12px / 600 `text-secondary`（大文字化しない）+ 星 12px（塗り `primary`）。下に `divider` |
| 新規の行（+out / +md / +file / +linkfd / Today） | **枠線をやめる**（今いちばん古く見える所）。高さ 24px、余白 0 6px、角 6px、11px / 500 `text-secondary`、hover `fill-hover` + `text-primary`、:focus-visible で ring。行は `flex-wrap: wrap`（248px で Today が切れる問題をなくす）。下に `divider` |
| Recent | 地を `--bg-color`（本文の色）→ **`bg-panel`**。見出しの行 28px、12px / 600 `text-secondary` + chevron、**見出しの文字と行の icon の左端は 17px**（お気に入りの見出し・tree の行の icon と同じ 1 本の線。行は 6px の透明な縁 + 左の余白 11px）。行 24px、12px `text-secondary` + icon 14px、hover `fill-hover`、今いる項目は `fill-active` + `text-primary` 500（今の青 + 600 をやめる）、無い項目は不透明度 .5。上に `divider` |
| Tools（S3 など） | 入力欄・ボタンは §7.4・§7.5。section の見出し 12px / 600 `text-secondary`。結果の文字は `success-text` / `danger`。`file-panel-tools-section` の直後 3 行に border を書かない（unit-cleanup-logic の test） |
| 右クリック menu | §7.6 |

### 7.2 section の見出し（共通）

- 行 28px、余白 0 12px（sidebar の中は左 17px で、tree の行・お気に入り・Recent の icon の左端とそろえる — §12.5 R6）
- 文字 12px / 600 `text-secondary`（sidebar・一覧）、dialog や sidepanel の中は 13px / 600 `text-primary`
- 件数は 11px `text-tertiary`。操作の icon（14px、icon ボタン 24 × 24）は右に寄せ、いつも出しておく（Figma の「ページ 🔍 +」と同じ）
- 大文字化・字間の広げはしない。見出しの下に線を引かない（区切りは section の間の `divider` 1 本）

### 7.3 ヘッダーと toolbar（note 面の 36px の行）

| 部位 | 決まり |
|---|---|
| 行 | 高さ 36px、≡ と < > の位置・大きさ・間隔は `--notes-hdr-*`（notes-body-html.js:476-484）のまま（TC-HHN-06・TC-OHL-05）。地は**本文の面**（`bg-app`）: outliner の 1・2 行目、md の toolbar（`--toolbar-bg`）、viewer の toolbar、linkedfd のヘッダー、sidepanel のヘッダー。md の Outline のヘッダーだけ `bg-panel`（Outline の列の面） |
| 区切り | ヘッダーの塊の下に 1px `divider` を 1 本（md は toolbar の下の線、outliner は tree の上の線 — 今の位置のまま）。outliner の 1・2 行目それぞれの下の線は透明のまま |
| タイトル | outliner の 1 行目は 1.4em / 700 `text-primary`（placeholder は `text-tertiary` / 400）。viewer の title は 13px / 500 `text-secondary`（ellipsis）。linkedfd のヘッダーの名前は 13px / 600 |
| ボタン | §7.4 の icon ボタン。md の toolbar は 26 × 25 以上・icon 14px・群の区切り 1px × 16px の `divider`。hover は `selection-bg`（青）→ **`fill-hover`**。Outline 開・source mode 等の ON は `primary-soft` + `primary-strong` |
| 横にはみ出す toolbar | 左右のスクロールボタンは 24px、影の代わりに `bg-app` からの gradient で端を薄くする |
| outliner の操作（戻る・進む・view・task・filter・archive・⋮、undo / redo） | icon 14px（今 13px）、角 6px、不透明度 .5 → 標準の .62。table / mindmap の view・filter・task の ON は `primary-soft` + `primary-strong` |

### 7.4 ボタン

| 種類 | 決まり |
|---|---|
| icon ボタン | 箱は 26 × 25（ヘッダー）/ 28 × 28（浮く toolbar・dialog）/ 24 × 24（密な所）、角 6px、icon 14px（浮く toolbar は 16px）。**ヘッダーの 26 × 25 と並びの間隔 28px（間 2px）は md の toolbar・outliner の 1・2 行目・file viewer・sidepanel・linkedfd のヘッダーで同じ**（§12.5 R12。sidepanel と viewer のヘッダーは 5 + 25 + 5 + 線 1 = 36px）。休み = 色 `text-primary` × 不透明度 .62（または `text-secondary`）、hover = 不透明度 1 + `fill-hover`、押下 = `fill-active`、ON = `primary-soft` + `primary-strong`（不透明度 1）、無効 = .3 で hover なし、:focus-visible = ring |
| 主（primary） | 地 `primary`、文字 `primary-fg` 13px / 500、高さ 28px（密な所 24px）、余白 0 12px、角 6px。hover `primary-hover`、押下 `primary-active`。1 つの dialog・panel に 1 個まで |
| 副（secondary） | 地 `bg-elevated`、縁 1px `border-strong`、文字 `text-primary`。hover で地に `fill-hover` を重ねる。dark は地 `fill-subtle` + 縁 `border` |
| 控えめ（ghost） | 地なし、文字 `text-secondary`、hover `fill-hover` + `text-primary`。toolbar の文字付きボタン・新規の行 |
| 危険 | 確認の dialog の実行は地 `danger-solid` + 白。一覧の中の削除は ghost の文字 `danger` + hover `danger-soft` |
| 並び | dialog の下の右に、左から 副 → 主（macOS と同じ。主が右端） |

今ある「accent の上の白文字」（mindmap のタイトル、ftp の実行、翻訳の保存、add column の作成）はすべて主ボタンの決まりにそろえる（今は accent `#9CC8DC` の上の白で 1.79:1）。

### 7.5 入力欄と検索欄

| 部位 | 決まり |
|---|---|
| 形 | 高さ 26px（chrome の行の中）/ 28px（dialog・form）、角 6px（outliner と linkedfd の検索欄は 5px — §5.2）、余白 0 8px、文字 12px（chrome。linkedfd の検索は 12px を test が固定）/ 13px（dialog） |
| 休み | 地 `fill-subtle`、縁は透明 1px（形を変えないため 1px は残す）、placeholder `text-tertiary`。縁で囲まない（Figma の検索欄と同じ） |
| hover | 地に `fill-hover`（ほんの少し濃く） |
| focus | 地 `bg-app`（浮く面の中なら `bg-elevated`）、縁 `focus-ring`、`--fr-shadow-focus`。outliner の検索欄の focus の縁（今は VS Code の `focusBorder`）もこれ |
| 誤り | 縁 `danger`、halo は `danger-soft` |
| 無効 | 不透明度 .5 |
| select（native） | 同じ地と縁。`color-scheme`（§3.14）で dark の矢印と一覧が暗くなる。mindmap の layout の select も同じ |
| checkbox | native のまま、`accent-color: var(--fr-color-primary)`、13px |
| 検索欄の中の icon | 先頭の虫めがね 14px `text-tertiary`（任意）、消去の × は 12px の icon ボタン |

`--outliner-search-bg` を入力欄の地（`fill-subtle`）にするので、outliner の検索欄と linkedfd の検索欄の「地 = `--outliner-search-bg`」（TC-FLV-57）はそのまま成り立つ。sidebar の検索欄も今と同じく outliner の検索欄と同じ面の色になる。

### 7.6 menu（右クリック・⋮・dropdown）— **light にする**

**決定**: menu は `bg-elevated`（light は白・dark は `#2A2A2E`）の light な menu にする。Figma の黒い menu は採らない。

理由:
1. Figma は canvas が灰色で、そこに貼った Web 画面の上でも menu が目立つよう黒にしている。Fractal は本文が白なので、白い menu + 細枠 + 段 2 の影で十分に浮く
2. outliner の右クリックは書いている最中に何度も開く。白い本文の上で毎回黒い板が出ると目がちらつく
3. Fractal は VS Code と Electron の中で動き、両方の native menu は light テーマで白（electron の theme.ts も `menu-background: #ffffff`）。Fractal の menu だけ黒いと別のアプリに見える
4. 2026-10 のユーザーの決定「overflow の … menu と viewer の chrome は Fractal の（light）テーマに従う」と、それを固定する TC-FAR-04（light で輝度 > 200）に合う
5. 黒い menu を足すと、反転した hover・危険・無効・区切り・shortcut の色の組がもう 1 組要る。token と不具合の数が増える

却下した案: (a) どちらのテーマでも黒い menu（Figma と同じ）— 上の 1–5。(b) テーマと逆の色の menu（light では黒、dark では明るい灰）— 理由 3–5 に加え、dark で明るい板が出ると目に刺さる。

| 部位 | 決まり |
|---|---|
| 板 | 地 `bg-elevated`、縁 1px `border`、角 10px（`--fr-radius-lg`）、内側 4px、影 `--fr-shadow-2`、最小幅 180px、z は `--fr-z-popup` |
| 項目 | 高さ 26px、余白 0 10px、角 6px（10 − 4 の同心円）、文字 13px `text-primary`、icon（あれば）14px `text-secondary`、icon と文字の間 8px |
| hover・キーボードで選んだ項目 | `fill-hover`（**accent の塗り + 白文字はやめる** — 今の md の右クリック menu は VS Code 風に link の色で塗っている） |
| shortcut | 右寄せ、12px `text-tertiary`、地を付けない（今の outliner の menu は dark 用の地 `rgba(255,255,255,.08)` が付いている）。hover した行では `text-secondary`（§4.3） |
| 区切り | 1px **`border`**（浮く面の中の線 — divider は dark の浮く面の上で 1.06:1 で見えない。§3.3）、上下 4px、左右 6px 内側 |
| 見出し（群の名前） | 11px / 600 `text-tertiary`、余白 6px 10px 2px |
| submenu | 右端に chevron-right 12px `text-tertiary`（今の ▶ をやめる）。開いている親の項目は `fill-active` |
| check の付く項目 | 左に 14px の check（`primary-strong`） |
| 危険 | 文字 `danger`、hover は `danger-soft`。対象は削除と取り外し: note tree の Delete・Remove Link、linkedfd の Delete、table の列の Remove column、outliner の Delete Node・Delete Page・Remove File、mindmap の Delete Group（§12.5 R7） |
| 無効 | 文字 `text-muted`、hover なし、cursor default |

**8 つある menu の実装を、すべてこの見た目にそろえる**: note tree の `.file-panel-context-menu`（notes-body-html.js:552-567）、sidepanel の overflow menu、outliner の右クリック `.outliner-context-menu`（outliner.css:903-952 — 地を `--outliner-search-bg` から `bg-elevated` に）、outliner の ⋮ `.outliner-menu-dropdown`（outliner.css:312-337。hover は `--vscode-list-hoverBackground` をやめる）、table の列 menu（outliner.css:2004-2028）、md の `.editor-context-menu`（editor.js:1048-1090 の inline の cssText を CSS の class に移す。styles.css:564 の余分な `}` を消すとこの規則が効くようになる）、mindmap の menu（mindmap.css:382-421）、linkedfd の `.fv-menu`（notes-folder-view.js:115-122。影を存在しない `--fr-shadow-sm` から `--fr-shadow-2` に、12.5px を 13px に）、drawio の layer menu（viewer-drawio/index.mjs:34-39）。

### 7.7 popover・浮く toolbar・command palette

| 部品 | 決まり |
|---|---|
| popover 共通（翻訳の popup、添付の panel、言語の選択、inline の色、tag の候補、日付の picker、multiselect の一覧） | 地 `bg-elevated`、縁 1px `border`、角 10px、影 `--fr-shadow-2`、内側 4–8px。中の項目は menu の項目と同じ（26px・角 6px・hover `fill-hover`）。keyboard で選んでいる候補も `fill-hover`（tag の候補の roving は 2px の内側の outline `focus-ring` も可） |
| 浮く toolbar（md の table の toolbar、画像の toolbar、mindmap の toolbar） | Figma の下の toolbar の形: 地 `bg-elevated`、縁 1px `border`、角 10px、影 `--fr-shadow-3`、内側 4px、ボタン 28 × 28・角 6px・icon 16px、群の区切り 1px × 16px の `border`（§3.3）。ON は `primary-soft` + `primary-strong`（Figma のように青で塗りつぶすのは主ボタンだけ）。mindmap の native の select と +/−/Fit の白い枠付きボタン（今は素の HTML）もこの中に入れる |
| command palette・action panel | 地 `bg-elevated`、角 14px、影 `--fr-shadow-3`、入力欄 32px（地なし、下に `divider`）、項目 28px、選んでいる項目は `fill-active`（青をやめる）、群の名前 11px / 600 `text-tertiary`（今の 9px の大文字をやめる）。本文の中の該当箇所の highlight（`::highlight(command-palette-selection)`）は `text-selection` |
| md / outliner の検索・置換の箱 | 浮く toolbar と同じ板（右上の固定のまま）。入力欄は §7.5、一致の数は 11px `text-tertiary` |

### 7.8 dialog・toast・tooltip

| 部品 | 決まり |
|---|---|
| dialog の下 | `--fr-color-overlay`（今は .3 / .4 / .45 / .5 / .55 / .6 / .7 と 7 種類ある） |
| dialog の板 | 地 `bg-elevated`、縁 1px `border`、角 14px、影 `--fr-shadow-4`、内側 20px、幅 420–480px（小さな確認は 360px） |
| 中身 | title 14px / 600 `text-primary`、本文 13px / 1.5 `text-secondary`、入力欄 28px、下のボタンは右寄せ（§7.4）、閉じる × は右上の 28 × 28 の icon ボタン |
| 対象 | md の export / rename link / add page link（editor.js:1219-1360 の inline の cssText — 色を `--bg-color` から `bg-elevated` に、主ボタンを link の色から `primary` に）、S3 の確認（notes-file-panel.js:4190-4225 — `#c44` を `danger-solid` に）、pinned tags（outliner.css:1236-1351）、add column と task の範囲（outliner.css:2031-2082、styles.css:2340-2360 — 主ボタンを `--outliner-tag-color` の塗りから `primary` に。内側 20px・title 14px / 600・入力欄 28px / 13px・ボタン 28px / 13px / 500 で他の dialog とそろえる — §12.5 R11。列名の変更・mindmap の group 名の dialog も同じ class）、shortcut の HUD（styles.css:2363-2433 — 角 14px・段 4、title の下線は存在しない `--accent-color` をやめて線なし、kbd は `fill-subtle` + 1px `border` + 角 4px + mono 11px） |
| toast（md の外部変更の通知） | 地 `bg-inverse`、文字 `text-inverse` 12px、角 10px、影 `--fr-shadow-3`、内側 8px 12px。左の 3px の link 色の線はやめる。位置（右上）と動きは今のまま。z は `--fr-z-toast` |
| tooltip | 今は native の `title` 属性だけ。今回は作らない。作るときは: 地 `bg-inverse`、文字 `text-inverse` 11px、角 6px、内側 4px 8px、500ms 待ってから出す |
| lightbox / 全画面 | 白い台座と 14px の余白は変えない（lightbox-white-bg の test）。下は `overlay-strong`。上の操作は浮く toolbar の形 |
| S3 の同期中の覆い（outliner.css:122-172） | `overlay` + 中央の spinner は `primary` |

### 7.9 タブ（notes タブ strip）

| 部位 | 決まり |
|---|---|
| strip | 地 `bg-chrome`、高さは今のまま（min 30px。JS が実の高さを `--notes-tab-bar-height` に書く）、下の線は今の inset の box-shadow のまま（色 `divider`） |
| 非選択タブ | 地は透明（今の灰の重ね `rgba(128,128,128,.14)` と不透明度 .65 をやめる）、文字 12px / 400 `text-secondary`、hover `fill-hover` + `text-primary` |
| 選択タブ | 地 `bg-app`（本文とつながり、下の線を覆う — FR-TP-05 のまま）、文字 12px / 500 `text-primary`、上の角 8px、左右に 1px `divider`（strip と区切る）。**先頭のタブの左には引かない**（sidebar の右の線と接して 2px になる — P4。§12.5 R4）。TC-TP-05（選択と非選択の地が違う）は「`bg-app` と透明」で成り立つ |
| 区切り | 非選択タブの間の縦線をやめる |
| 閉じる × | 16 × 16 の icon ボタン（角 4px）。選択タブと hover したタブだけに出す。**キーボードで × に来たとき（:focus-visible）は必ず出す**（不透明度 0 のままだと ring も描かれない — §12.5 R14） |
| + | 24 × 24 の icon ボタン |
| 並べ替えの挿入線 | 2px `primary`（今は VS Code の `focusBorder`） |
| 幅 | 90–200px のまま |

### 7.10 chip・tag・badge

| 部品 | 決まり |
|---|---|
| 本文の中の tag（`#tag` `@name`） | 地 `primary-soft`、文字 `primary-strong` 500、角 4px、余白 0 4px、.81em。hover は地 `primary-soft-hover` + 文字 `primary-strong-hover`。**focus 行・選択した mindmap の node（地が同じ `primary-soft`）の上でも同じ組**（今は地と同じ色で pill が消える。段差は 1.17:1 / 1.21:1 — §12.5 R2） |
| table の multiselect の chip | §3.11 の 8 色、角 full、11px / 500、余白 1px 8px。× は 12px（行の高さ 1 — chip の高さは変えない）、不透明度 **.8** → hover 1（押せる部品なので chip の地に対して 3:1 以上。.6 だと light で 2.42–2.85 — §12.5 R3） |
| tag の候補（outliner の検索欄の下） | 本文の tag と同じ形。keyboard で選んでいる候補は 2px の `focus-ring` |
| pinned tag の pill | 角 full、11px / 500。休み `fill-subtle` + `text-secondary`、hover `fill-hover`、ON は `primary-soft` + `primary-strong`（今は VS Code の `focusBorder` の塗り + 白） |
| 件数の badge（outliner の子の数など） | 10px / 600、最小幅 16px、角 full、地 `fill-active`、文字 `text-secondary`（今の 8px をやめる） |

### 7.11 table（database view）

| 部位 | 決まり |
|---|---|
| 罫線 | **本体には引かない**（ユーザー裁定のまま） |
| 列の見出し | sticky（72px の位置のまま）、地 `bg-app`、文字 12px / 600 `text-secondary`、下 1px `divider`、見出しのセルの間の縦線 1px `divider`（今のまま）、hover `fill-hover`、resize の握りは hover で 2px `primary` |
| セル | 余白 4px 7px のまま、文字は本文の大きさ、日付と数字は `tabular-nums` |
| 行の hover | 出さない（outliner と同じ） |
| focus 行 | 全セル `selection-bg`（角なし） |
| 選択（選択モード） | amber（ADRL-0115）。chip は不透明なので amber の上でも §3.11 の比のまま |
| セルの選択の枠 | `inset 0 0 0 2px var(--fr-color-primary)`（今は VS Code の `focusBorder`）。test は box-shadow があることだけを見る |
| multiselect の一覧・列 menu・add column | §7.7 / §7.6 / §7.8。一覧の地を `--outliner-bg` から `bg-elevated` に（dark で本文と同じ色になって浮かない） |

### 7.12 mindmap

| 部位 | 決まり |
|---|---|
| canvas | `bg-app`（**dark で白いままの不具合を直す** — mindmap.css の存在しない token を本物に替える。対応表は §10.3） |
| node | 地 `bg-elevated`、縁 1.5px `border`、角 8px、影 `--fr-shadow-1`、文字 13px `text-primary`、余白 6px 10px。**大きさに関わる値（13px・行 1.4・余白・縁 1.5px）は変えない**（JS の PAD_H = 20 / BORDER_W = 18 / ICON_GAP = 6 と、node が 1 行なら高さ 40px 以下・文字 28px 以下の test） |
| node の hover | 縁 `border-strong` |
| focus | 縁 `primary` + `0 0 0 3px var(--fr-color-focus-halo)` |
| 選択（複数も） | 地 `selection-bg` + `0 0 0 2px var(--fr-color-primary)`（青のまま — R16 rev2。test は影か outline があることを見る） |
| root（タイトル） | 地 `primary`、文字 `primary-fg` 15px / 600（今は `#9CC8DC` の上の白で 1.79:1） |
| 枝 | 2px `connector`（今 `#b0b0b0`） |
| group | 1.5px の点線 `primary`、地は付けない |
| 関係線 | 1.5px の点線 `text-tertiary` + 矢印（今は紫の `--fr-color-accent`。group と形で区別する） |
| 検索 | `search-hit` / `search-current` |
| minimap | 地 `bg-elevated`、縁 1px `border`、角 8px、影 `--fr-shadow-2`、node の点は `primary` を不透明度 .45 で（飾りの縮図なので 3:1 は求めない）、見えている範囲の枠は 1.5px `primary` |
| toolbar | §7.7 の浮く toolbar |
| 画像の thumbnail の選択 | 2px `primary` の outline（今は `--outliner-accent-fg` = 白で見えない） |

### 7.13 md の本文の部品

| 部品 | 決まり |
|---|---|
| 段落・幅 | 文字 `text-primary`、幅 774px と余白 90px 54px は今のまま、行の高さ §5.4 |
| 見出し | §5.4。H1・H2 の下線をやめ（§11 Q4）、大きさ・太さ・上の余白で区切る |
| link | `primary-strong`、下線なし、hover で下線（1px・offset 2px）。link の種類の icon（SVG の data URI の `#6c6c6c` / `#a0a0a0`。3 テーマ分）はそのまま |
| inline code | 地 `code-bg`、文字 `text-primary`、角 4px、余白 .1em .35em、.86em mono |
| code block | 地 `code-block-bg`、縁 1px `divider`、角 8px、余白 28px 16px 14px（上は見出しの帯の分）。hljs の配色はそのまま |
| code block の見出し（言語・Copy・展開・折り返し） | **7px → 11px**。帯をやめ、block の右上 4px 内側に ghost の小ボタン（高さ 22px・角 4px・`text-tertiary`、hover `fill-hover` + `text-secondary`）を置く。言語の名前はいつも出して**右上の角に置き**（flex の `order` で右端へ。DOM の順のままだと隠れているボタンの箱の分だけ角から浮く — §12.5 R8）、ボタンは block の hover と :focus-within のときにその左に出す。折り返しの ON は `primary-soft` + `primary-strong`。対象は styles.css:845（見出しのボタン 7px）・:1000（展開 8px）。drawio の Open ボタン（:874、7px）も同じ形にする。drawio の 4 つのボタンは画像の右上から左へ並べ、**画像の幅に入らない分は次の行へ折り返す**（11px にして並びが約 400px になり、狭い図では画像の左端を越えて tree や Outline の上に出ていた — §12.5 R19） |
| 引用 | 左 3px `border-strong`、左の余白 14px、文字 `text-secondary`（**今は見えない**）、地なし |
| table | セルの縁 1px `border`、見出しの行 地 `fill-subtle` + 600、余白 7px 11px のまま。セルの focus は内側 2px `focus-ring`。列の resize の線は `primary`。table の選択モードの見出し「H」の ON と選択の枠・範囲（styles.css:2440-2457 — 今は VS Code の色）は `primary-soft` / 2px `primary` / `selection-bg` |
| 区切り線（hr） | 1px `divider`（今 2px）、上下 1.5em |
| list | 記号（`::marker`）を `text-tertiary`。task の checkbox は `accent-color: primary` |
| mermaid・数式の枠 | 地 `bg-app`、縁 1px `divider`、角 8px。誤りの表示は `danger-soft` + `danger`（今は GitHub の赤の直書き 3 組）。mermaid の theme は `data-fr-theme` から決める（auto + OS の dark で 'default' になる今の問題も直す）。**PDF の清書では、画面を 'dark' で描いた図を light の theme（'default'）で描き直す**（PDF は白い紙。source の先頭の init directive でその 1 回だけ theme を変える・6 秒で打ち切って画面の図のまま — §12.5 R15） |
| 画像 | 変えない（中身） |
| 外部変更の黄色い flash、drag 中の cursor の色 `#0969da`（editor.js） | `search-current` / `primary` |
| 空の editor の placeholder | `text-tertiary`（今は不透明度 .4） |

### 7.14 sidepanel・file viewer・linkedfd・検索結果

**sidepanel（右の peek）**
- 地 `bg-app`、左に 1px `divider`、影 `--fr-shadow-3`、出入り 200ms（位置と幅は今のまま）
- ヘッダー: 内側 5px 12px・高さ 36px（ボタン 26 × 25・間 2px — §7.4）、file 名 13px / 600 `text-primary`（今は不透明度 .8）、ボタンは icon ボタン（存在しない `--hover-bg` をやめて `fill-hover`）、閉じる × は 28 × 28 の icon ボタン、「…」の overflow menu は §7.6（TC-FAR-04/05 = 地 `bg-elevated`・文字 `text-primary` のまま）
- 中の目次: 地 `bg-panel`（`--sidebar-bg`）。**Outline の見出しは note 面の md の Outline の見出しと同じ形**（高さ 36px = 横のヘッダーと同じで下の線が 1 本につながる・左 10px・12px / 600 `text-secondary`・下に `divider` — §12.5 R5）。項目 24px・12px `text-secondary`・角 6px・左右 6px 内側（塗りだけ — §5.3）、hover `fill-hover`、今いる見出しは `fill-active` + `text-primary` 500（今の青 + 600 をやめる）
- resize の握り: hover で 2px `primary`

**file viewer（note 面 / sidepanel / standalone の 3 面）**
- `--fv-*` の付け替え（file-viewer.js:128-137）: `--fv-bg-bar` = `bg-app`（今 `bg-panel`）、`--fv-bg-body` = `bg-app`、`--fv-border` = `divider`、`--fv-text` = `text-primary`（TC-FV-74 のまま）、`--fv-text-muted` = `text-secondary`、`--fv-btn-bg` = `fill-subtle`（検索欄の地。TC-VFB-08 は「検索欄の地 = `--fv-btn-bg`」を見るだけ）、`--fv-btn-hover` = `fill-hover`
- PDF・docx・pptx の紙面の後ろ（`.viewer-pdf-container` など）は `bg-canvas`、紙面に `--fr-shadow-1` + 1px の `divider` の縁（pdf.js の紙面は 9px の透明な border を持つので、影は `.canvasWrapper` 側に付ける — 実装時に確認）
- toolbar のボタンは icon ボタン（休みの不透明度 .6 → .62、存在しない `--hover-bg` → `fill-hover`）。検索欄 §7.5。一致の強調は `search-hit` / `search-current`（viewer ごとに写した黄色を 1 組に）
- 画像の viewer の市松模様、html の iframe の白、xlsx / docx / pptx の中の色は**中身の再現なので変えない**
- viewer-dispatcher.js:29 の container の地（`--vscode-editor-background`）→ `bg-app`。text viewer の書体と行番号の色（`--vscode-editor-*`）→ `--fr-font-mono` / `text-tertiary`
- standalone の viewer のタブ（fileViewerContent.ts）は tokens.css も `data-fr-theme` も読んでいないので VS Code の色で描かれている。tokens.css を読み、`data-fr-theme` を書くようにする（§10.1 Phase 3）。開いたまま `fractal.theme` を変えたら、fileViewerProvider.ts が新しい値を message で送り、`data-fr-theme` だけを差し替える（HTML を作り直さない — 拡大率・位置はそのまま。§12.5 R20）

**linkedfd（フォルダビュー）**
- 地 `--outliner-bg`（= `bg-app`。TC-FLV-57）、ヘッダー 36px（§7.3）、検索欄は 225px・12px・角 5px・地 `--outliner-search-bg`（TC-FLV-57 のまま）
- 行: 高さ 24px（今のまま）、選択と drop の受け = `selection-bg`、角 6px、左右 6px 内側。**hover は出さない**（ユーザー裁定 2026-08-18）
- 三角と点（5px の CSS の三角）・📄/📎 の icon はそのまま（ユーザー裁定と test）
- focus・rename・root への drop の枠（今は VS Code の `focusBorder`）→ `focus-ring` / `primary`。隠しファイルの切り替えの ON（今は VS Code の link の色）→ `primary-strong`
- notes-folder-view.js には色の直書き（`#…` と `rgba(`）を書かない — 注釈の中も（folder-view.spec.ts:835-840）。すべて token で書く

**検索結果（note の panel の Results タブ）**
- 件数 11px `text-tertiary`、飛び先の link（Notes (1) / Outliner (5) …）11px `primary-strong`。結果の後ろの種別・位置（[md] / [folder] / [subtext] / [p.5]）も 11px `text-tertiary`（不透明度で薄めない — §12.5 R9）
- 種別の見出し（Notes Explore / Outliner / Markdown / Files）: 12px / 600 `text-secondary` + 下に 2px の `divider` の線（test は「2px solid の下線」と「file の見出しと違う色」を求める）
- file の見出し: 12px / 600 `primary-strong`（今の `#3994BC` → `#0256C3`。test の値は更新が要る — §10.5。「VS Code の link の色を使わず Fractal の青」という 2026-10-23 の意図は保つ）
- 一致の行: 12px `text-primary`、一致は `search-hit`、hover `fill-hover`（今の青をやめる）、塗りは端から 6px 内側（塗りだけ — §5.3）。名前一致の file の glyph（📗 など）はそのまま
- explore で飛んだ先の 2 秒の黄色い flash は md・outliner と同じ `jump-flash` の token（§3.8）

### 7.15 scrollbar と focus

- scrollbar: 標準の `scrollbar-width: thin; scrollbar-color: var(--fr-color-scrollbar-thumb) transparent;`（Chromium 121 以降はこちらが効く）と、古い Chromium（VS Code 1.85 の 114）向けの `::-webkit-scrollbar`（幅 10px、thumb は 2px の透明な縁で中を 6px に見せる、角 full、hover で濃く）を両方残す。tab strip などの 4px の scrollbar はそのまま
- focus ring: `:focus-visible` のボタン・入力欄・select に必ず出す（§5.1）。例外は決まっている所だけ — note tree の一覧（focus 行の選択色で示す。FR-TKN-01）、編集中の文字（outliner の text、md の本文）。☰ と < > などで `focus-visible { box-shadow: none }` にしている所は、mouse では出ない（`:focus-visible` なので）ので ring を出すように直す

---

## 8. 変えないもの（守る決定）

| 決定 | 出典 | この設計での扱い |
|---|---|---|
| outliner の node 選択は amber、`::selection` は青、`--fr-color-selection-bg` は黄色にしない、`--fr-bg-selection` は定義しない、tree・linkedfd・mindmap の複数選択は青 | ADRL-0115（accepted）、R16 rev2、TC-OSM-30〜37・TC-OSC-01 | amber の 3 定義（outliner.css、rgba の直書き、light と dark で別の alpha、< 0.4）を残す。`selection-bg` は青の淡い塗り。mindmap.css の `var(--fr-bg-selection, …)` 4 か所は `var(--fr-color-selection-bg)` に替え、`--fr-bg-selection` は未定義のまま |
| outliner の行に hover を出さない。編集中の文字に focus の ring・地を出さない | ユーザー裁定（「強調しない」）、fr-base.css:38-40 | そのまま |
| table に罫線を引かない | ユーザー裁定 | 列の見出しの線だけ |
| linkedfd の行に hover を出さない、📄/📎、5px の三角、検索欄 225px・12px・角 5px、地 = `--outliner-bg`、色の直書きを書かない | ユーザー裁定 2026-08-18、TC-FLV-57、folder-view.spec.ts:768-840 | そのまま（色は token で） |
| note 面のヘッダーは 36px、≡ と < > の位置・大きさ・間隔を 5 つの画面で同じに | 2026-11-06 のユーザー依頼、TC-HHN-06、TC-OHL-05 | `--notes-hdr-*` を触らない。変えるのは地・hover の色・icon の線の太さだけ |
| ☰（`&#9776;`）と Outline の閉じる `&times;` | outline-ui.spec | そのまま |
| tree のキーボードの focus は選択色で示し、ring を出さない | FR-TKN-01 / 06（ユーザー裁定 2026-09-06） | そのまま |
| 検索結果の見出しは VS Code の link の色でなく Fractal の青 | ユーザー 2026-10-23 | 意図は守る。値は新しい `primary-strong` に変わる（test の更新が要る — §10.5） |
| overflow の … menu と viewer の chrome は VS Code が暗くても Fractal のテーマに従う | ユーザーの決定、TC-FAR-04/05、TC-VFB-08 | そのまま（menu を light にした理由の 1 つ） |
| lightbox / 全画面は白い台座 + 14px | lightbox-white-bg.spec | そのまま |
| .out の icon = document + bullets | ユーザー 2026-08-24 | そのまま |
| Notion 風の panel のヘッダー（☰ が先頭）、選択タブだけ icon + ラベルの pill、線はタブの行の下 1 本 | 2026-10-16 の spec の D1 / D3（notes-body-html.js の注釈） | 形はそのまま、色だけ |
| 選択タブは本文とつながり、下の線が消える | FR-TP-05 | そのまま |
| 子の字下げ 25px、note の 20 色、inline の文字色、viewer の中身の色 | notes-color-palette.spec ほか（中身の色の test） | 触らない |
| folder の icon と file の icon の x をそろえる（左 11px） | FR-FA-01 | そのまま |
| mindmap の node の大きさの値 | mindmap-render.js / mindmap-interactions.js、iteration15 / 30 の test | 色・角・影だけ変える |
| SVG の icon の文字列は 3 ファイルで同一 | TC-FV-61 | 線の太さは CSS で変える |
| 密度（B案: 2026-05 に全体を 0.9 倍） | commit c4426e0 | 行・余白は今の密度。文字だけ 9–10px を 11–13px に上げる |
| Electron の側（electron/）は別の作業が触っている | — | 刷新のときは変更しなかった。**2026-11-08 に Electron にも入れた**（§14。Electron が自分で描く所も tokens.css を読む） |

frasco の設計のルール（§1 の区分 A–L）に当たる判断はこの変更に無い（配色・形は区分 J の「FE フレームワーク・レンダリング戦略」ではない）。accepted ADR（ADRL-0115）には反しない。よって ADR は作らず、判断は次の §9 に残す。

---

## 9. 決定の記録（採用した案・却下した案・理由）

| # | 論点 | 採用 | 却下した案と理由 |
|---|---|---|---|
| D1 | アクセントの色 | 青 `#0A68E6`（OKLCH 259°。白文字 5.08:1、白の上の文字 `#0256C3` 6.73:1） | Figma の `#0D99FF`: 白文字 2.99:1 で AA に届かない。Tailwind の `#2563EB`: 通るが OKLCH 263° で紫寄り、Figma から遠い。今の teal（`#9CC8DC` / `#3994BC`）: 白文字 1.79:1・link 3.27:1。淡い pastel は今風に見えない。Quick の紫を既定に: 差し替えのブロックとして用意するが、tree の複数選択も紫になり R16 rev2 の「青」と食い違うので既定にしない |
| D2 | 面の分け方 | 本文 = 白、chrome（sidebar・タブ strip・md の Outline）= ほんのり紫の `#F5F4FB`（案 A5。2026-11-07 にユーザーが 11 案を見比べて選んだ — §13）、境目に 1px の線 | 案 A（ニュートラルの `#F7F7F8`）・A2〜A4（より白・青み・暖かみ）、B1〜B6（左パネルを白にして本文に色）: 見比べて A5 を選んだ（B1・B2 は「本文領域がグレーすぎる」）。どれも §13 の手順で戻せる。全部同じ面（今）: 本文を白にすると白い部品（hover・検索欄・inline code・menu の hover）が全部消え、構造も見えない。Figma のように本文を灰色に: ユーザーが「白っぽいほうが好ましい」と明言。暖色のベージュ: 参考の 2 つがどちらもニュートラルで、古く見える |
| D3 | dark の面の並び | sidebar `#18181B` < 本文 `#1F1F22` < 浮く面 `#2A2A2E`（VS Code Dark Modern と同じ向き） | 今の紺（`#1E1F28`）: outliner だけ VS Code Dark+ の `#1e1e1e` で継ぎ目が出る、紺は古く見える。Figma の dark（panel が canvas より明るい）: light の「本文がいちばん明るい紙」と逆になる。真っ黒: 目に強い |
| D4 | menu | light（§7.6） | 黒い menu（Figma）: §7.6 の理由 1–5 |
| D5 | token の書き方 | 16 進・rgba の直書き。色の差し替えは accent ramp の 1 ブロック | `color-mix()` で派生: 計算後の値が `color(srgb …)` や `oklab(…)` で返り、rgb() を前提にした test（TC-OSM 系ほか）が壊れる。同梱の pdf.js にも `#` / `rgb(` / `rgba(` しか読まない色の変換（pdfjs-lib の `Oe()`）がある。`light-dark()`: Chromium 123 から。VS Code ^1.85 は Chromium 114 で動かない。relative color: 122 から |
| D6 | 書体 | system UI の stack に和文の UI 書体を足す | Inter（Google Fonts）: オフラインで使う note アプリが外のサーバーに頼ることになり、和文は結局別の書体に落ちて混植になる。今もどこも名指ししていない |
| D7 | tree の状態 | hover = 無彩色、現在地 = 無彩色の濃い塗り（1px の縦バーをやめる）、選択 = 青 | 現在地を青で塗る（Quick・Figma の選択行）: Fractal では「開いている 1 件」と「複数選択」と「キーボードの focus 行」が別の概念で、全部青だと区別が付かない（R16 の不満）。Figma も「今のページ」は灰、「選んだ layer」は青。1px のバーのまま: 参考の 2 つ（Figma の layer の行、Quick の Recents の行）はどちらも角の丸い淡い塗りで、縦線を使っていない。今のバーは 1.72:1 で見えにくい |
| D8 | UI の文字の大きさ | 13px 基準（`--fr-text-base` 1 か所で変えられる）。本文の既定 12 → 13 を提案（§11 Q1） | 全部 12px のまま: 9–10px の見出しが残り、参考より小さい。14px: B案（14 → 12）を戻すことになる |
| D9 | 入力欄 | 地で示し、休みは縁なし。focus で縁 + halo | 白い欄 + 縁: 白い本文の上では縁が必須になり線が増える（P4） |
| D10 | chip | テーマごとに不透明な地と文字の組 | 半透明の地（今）: 選択行の amber や focus 行の青と混ざって比が変わる |
| D11 | 変え方 | 各ファイルの規則をその場で直す（新しい上書き用の CSS ファイルを作らない） | 後から読む `modern.css` で上書き: layer の外の CSS-in-JS（notes panel）と実行時の `<style>`（viewer・linkedfd 等）がもっと後に入って勝つ。standalone の harness の build にも足す必要がある |
| D12 | fr-components.css | 使わない（今回は触らない。削除は別の片付けで） | 部品の層として復活: `@layer fr-components` の規則は layer の外の規則に負けるので、効かせるには全部を書き直すことになる。今は 0 か所からしか使われていない |

---

## 10. 実装の地図

### 10.1 順番（各段で撮影して比べ、戻せる形で進める）

| 段 | 中身 | これだけで変わること |
|---|---|---|
| Phase 1: token と不具合 | tokens.css（accent ramp・3 ブロック・尺度・旧 alias の付け替え・`color-scheme`）、fr-base.css（`::selection` = `text-selection`、ボタンの focus ring、scrollbar、`accent-color`、body の書体、transition 80ms）、outliner.css の dark の 2 ブロックの整理（§3.12）と chip（§3.11）と `--outliner-accent-fg` の誤用 6 か所、mindmap.css の存在しない名前（§10.3）、styles.css:564 の余分な `}`・`--font-family` / `--font-mono`・7px / 8px の文字 | 本文が白・chrome が灰・青の accent・dark の継ぎ目が消える・blockquote / chip / 画像の選択枠 / mindmap の dark / menu の hover の不具合が直る。見た目の 7 割ほど |
| Phase 2: 部品 | §7 の決まりを各ファイルに入れる（§10.2） | 丸い選択行、枠のないボタン、light な menu の統一、浮く toolbar、タブ、table、mindmap の node、md の部品 |
| Phase 3: 漏れと周辺 | VS Code の色の置き換え（§10.4）、standalone の viewer に tokens.css、Inter と CSP の外部 font の削除、docs の更新（`docs/specs/frontend.md` §Design system、`docs/fractal/design.md` §20.1 の「pastel teal-blue」「unified surfaces」「`--fr-bg-app` / `--fr-bg-panel`」の記述を新しい面の構成と本物の token 名に） | VS Code のテーマが Fractal の画面に混ざらなくなる |

### 10.2 ファイルごとの変更

| ファイル | 変えること |
|---|---|
| `src/webview/tokens.css` | §3 のすべて。影を `:root` の尺度のブロックからテーマのブロックへ移す。`--fr-text-*` を 13px 基準に。`--fr-font-*` |
| `src/webview/fr-base.css` | §7.15・§5.6。`::selection { background: var(--fr-color-text-selection) }`、`button/input/select:focus-visible`（input は縁 + `--fr-shadow-focus`、button は outline）、`:root { accent-color }` |
| `src/shared/notes-body-html.js` | §7.1（tree の行と状態、現在地の `::before` の 1px バーを消す、ヘッダーの ☰ / < > の hover、検索欄、タブ、お気に入り、新規の行の枠をやめる、Recent の現在地）、§7.6（`.file-panel-context-menu` の hover を `bg-app` から `fill-hover` に）、§7.9（タブ strip）、§7.14（検索結果）。hover に使っている `--selection-bg`（:148, 164, 438, 458, 521）→ `fill-hover`、Recent の現在地（:171）→ `fill-active`。:278 の `--fr-color-warning-bg` → `warning-soft` |
| `src/webview/styles.css` | §7.3（md の toolbar の hover・ON・区切り）、§7.13（見出し・link・code・code block の見出し・引用・table・hr・list・mermaid / 数式）、§7.6（`.editor-context-menu` を CSS だけで）、§7.7（翻訳・添付・言語・command palette・action panel・inline の色・table の toolbar）、§7.8（shortcut の HUD・lightbox・toast）、§7.14（sidepanel と目次・Recent の地 :2093）。`--hover-bg`（7 か所）→ `fill-hover`、`--text-muted`（5 か所）→ `text-tertiary`、`--accent-color`（:2392）→ `primary`。hover に使っている `--selection-bg` を `fill-hover` に（:74, 211, 257, 320, 538, 863, 888, 993, 1030, 1235, 1484, 1935）、ON・選択に使っている所は token を明示（:868 と :2075 → `primary-soft`、:1579 / 1639 / 1675 / 1938 → `fill-active`、:1521 と :2159 → `text-selection`、:449 は `selection-bg` のまま） |
| `src/webview/editor.js` | 右クリック menu（:1048-1090）と dialog（:1219-1360）の inline の cssText の色を `bg-elevated` / `border` / 主ボタン = `primary` にし、hover を `fill-hover` に（できれば class に移して CSS で書く）。flash の黄色（:20318, 20395, 20406）→ `search-current`、drag の `#0969da`（:20753）→ `primary` |
| `src/webview/outliner.css` | §3.12 の dark ブロックの整理、§3.11 の chip、§7.3（1・2 行目のボタンと検索欄）、§6（focus 行の角 6px、連続する選択の角）、§7.10（tag・pinned tag・badge :601 の 8px）、inline code（:800）、画像の選択（:1487-1502）、`.outliner-context-menu`（:903-952。地 `bg-elevated`、shortcut の地をやめる）、⋮ menu（:312-337）、日付の picker（:1374-1435）、検索・置換の箱（:1542-1620。ボタンの hover :1592 の `--selection-bg` → `fill-hover`）、table（:1622-2082。セルの選択枠 :1859、multiselect の一覧 :1930、列 menu :2005、add column :2032） |
| `src/webview/outliner.js` | :2285, :5920 の VS Code の色 → token。:5175 の page の 📄 は残す |
| `src/webview/mindmap.css` | §10.3 の対応表、§7.12、§7.7（toolbar）、menu（:382-421） |
| `src/webview/file-viewer.js` | §7.14 の `--fv-*`、toolbar と検索欄、`--hover-bg` / `--fv-bg`（存在しない名前）、`--vscode-font-family` |
| `src/shared/viewer-dispatcher.js`, `src/webview/viewer-side-panel.js`, `src/webview/viewer-text/index.mjs`, `src/webview/viewer-image/index.mjs`, `src/webview/viewer-drawio/index.mjs` | 地・縁・書体・menu。docx / pptx / xlsx の中身の色は触らない |
| `src/shared/notes-folder-view.js` | §7.14 の linkedfd（色の直書き禁止を守る）。`.fv-menu` の影 |
| `src/shared/folder-view-dispatcher.js`, `src/shared/notes-folder-sidepanel-badge.js` | 地を token に |
| `src/shared/notes-file-panel.js` | :4190-4225 の S3 の確認 dialog（§7.8） |
| `src/fileViewerContent.ts` | tokens.css を読み、`<html data-fr-theme>` を書く（Phase 3） |
| `src/notesWebviewContent.ts`, `src/outlinerWebviewContent.ts`, `src/webviewContent.ts` | Inter の `<link>` 2 本と CSP の外部 font を外す（Phase 3・任意） |
| 触らない | `electron/`（刷新のときは別の作業。2026-11-08 に §14 で入れた）、`src/sync-conflict-dialog.ts` と `src/notesMigrationGate.ts`（VS Code の UI として描く別の webview）、`fr-components.css`、`node_modules` / `vendor` / `.harness` / `test/html/viewer-fixtures`（main への symlink） |

### 10.3 存在しない token 名の付け替え（alias は作らない）

| 今の参照 | 置き換え先 | 主な場所 |
|---|---|---|
| `--fr-bg-app` | `--fr-color-bg-app` | mindmap.css（canvas） |
| `--fr-bg-panel` | `--fr-color-bg-elevated` | mindmap.css（node・toolbar・minimap） |
| `--fr-text` / `--fr-text-muted` | `--fr-color-text-primary` / `--fr-color-text-tertiary` | mindmap.css |
| `--fr-border` / `--fr-border-strong` | `--fr-color-border` / `--fr-color-border-strong` | mindmap.css |
| `--fr-bg-selection` | `--fr-color-selection-bg`（**`--fr-bg-selection` は定義しない**） | mindmap.css:116, 229, 370, 402 |
| `--fr-shadow-focus-ring` | `--fr-shadow-focus` | mindmap.css |
| `--fr-bg-search-hit` / `--fr-bg-search-current` | `--fr-color-search-hit` / `--fr-color-search-current` | mindmap.css |
| `--hover-bg` | `--fr-color-fill-hover` | styles.css、file-viewer.js |
| `--text-muted` | `--fr-color-text-tertiary` | styles.css:79-80, 1945-1946, 2118 |
| `--accent-color` | `--fr-color-primary` | styles.css:2392 |
| `--fr-shadow-sm` | `--fr-shadow-2` | notes-folder-view.js:117 |
| `--fr-color-warning-bg` | `--fr-color-warning-soft` | notes-body-html.js:278 |
| `--fv-bg` | `--fr-color-bg-app` | file-viewer.js |

### 10.4 VS Code の色の置き換え（chrome の約 50 か所）

| `var(--vscode-…)` | Fractal の token |
|---|---|
| `focusBorder` | focus の印なら `--fr-color-focus-ring`、drop 線・挿入線・選択の枠・ON の塗りなら `--fr-color-primary` |
| `list-hoverBackground` | `--fr-color-fill-hover` |
| `list-activeSelectionBackground` | `--fr-color-selection-bg` |
| `textLink-foreground` | `--fr-color-primary-strong` |
| `input-background` / `input-foreground` / `input-border` / `input-placeholderForeground` | `--fr-color-fill-subtle` / `--fr-color-text-primary` / `transparent` / `--fr-color-text-tertiary` |
| `panel-border` | `--fr-color-divider` |
| `editor-background` / `editor-foreground` / `foreground` | `--fr-color-bg-app` / `--fr-color-text-primary` |
| `descriptionForeground` | `--fr-color-text-secondary` |
| `editorWidget-background`, `menu-background` / `menu-foreground` / `menu-border` | `--fr-color-bg-elevated` / `--fr-color-text-primary` / `--fr-color-border` |
| `button-background` / `button-foreground` / `button-secondaryBackground` | `--fr-color-primary` / `--fr-color-primary-fg` / `--fr-color-fill-subtle` |
| `errorForeground` | `--fr-color-danger` |
| `editor-selectionForeground`（outliner の選択行の文字） | `inherit` |
| `font-family` / `editor-font-family` | `--fr-font-sans` / `--fr-font-mono` |
| `editorLineNumber-foreground` | `--fr-color-text-tertiary` |

対象の一覧は棚卸しの「VS Code theme leaking」の行（styles.css:569-598, 2440-2457、outliner.css:142, 236, 336, 522, 960, 978, 1227-1232, 1288-1292, 1350, 1363, 1432, 1859, 1896、notes-body-html.js:394, 737、notes-folder-view.js:84, 91, 113, 126、file-viewer.js:143, 192、outliner.js:2285, 5920、viewer-text/index.mjs:19-25、viewer-dispatcher.js:29、fileViewerContent.ts:78）。除外は sync-conflict-dialog.ts と notesMigrationGate.ts だけ。

### 10.5 test

**値を更新する test**（意図は変えず、値だけ新しい配色に）

| test | 今の期待 | 新しい期待 | 理由 |
|---|---|---|---|
| `test/specs/notes-search-results-jump.spec.ts:87, 100` | file の見出し = `rgb(57, 148, 188)` | `rgb(2, 86, 195)`。できれば固定値をやめ、`--fr-color-primary-strong` を probe の要素で解決した値と比べる（次に色を変えても test を触らずに済む）。「VS Code の link の色 `#b180d7` にならない」「種別の見出しは別の色 + 2px の下線」はそのまま | 2026-10-23 の意図（Fractal の青）は保ち、青の値が変わる |
| `test/specs/integration-minimal-foundation.spec.ts` TC-05a / 05b / 06 / 09 | `#F5F4EE` / `#181820` / tab の下線 `#4F6BFF`（どれも前の PoC の値で、今すでに known-red） | TC-05a = `255, 255, 255`、TC-05b / 06 = `31, 31, 34`。TC-09 は「選択タブの下線」という形がもう無い（2026-10-16 の D3 で pill になった）ので削除するか、pill の地 = `fill-active` を見る形に直す | 古い値の固定。直すと known-red が 4 つ減る |

**値が変わっても通るはずの test**（Phase ごとに必ず流す）: TC-OSM-30〜37・TC-OSC-01（amber と青の分離）/ TC-FAR-04・05（menu の地 = `bg-elevated`、light の輝度 > 200・dark < 80 — dark の `#2A2A2E` は約 42）/ TC-FV-73・74（viewer のボタンの色 = `text-primary` の 6 桁の 16 進）/ TC-FLV-57 と folder-view.spec.ts:768-900（linkedfd と `#sidebar`）/ TC-VFB-08 / lightbox-white-bg / TC-HHN-06・TC-OHL-05（36px と ≡・< > の位置）/ notes-panel-notion-header（140px で何もはみ出さない — 新規の行を wrap にしたので確認）/ outline-ui / notes-color-palette / unit-cleanup-logic / TC-FV-61 / TC-MX-10（drop の点線に青の画素 — `#0A68E6` は b > 150・b − r > 60・g < 180 を満たす。紫 `#7A46E7` も満たす）/ notetree-keynav・notetree-file-panel / TC-TP-05 / TC-08a・08b（角 6px）/ mindmap の iteration15・24・30、copy-paste、style-group-export / outliner-image-paste-dup / outliner-table-select-mode

**足す test**（機械で守る。どれも、わざと壊したときに落ちることを 1 度確かめてから入れる）

| # | 守ること | 方法 | 壊して確かめる方法 |
|---|---|---|---|
| G1 | dark と auto-dark のブロックが同じ key と値、light が同じ key を持つ | `test/unit/` で tokens.css を読み、3 ブロックを key → value の表にして比べる | auto-dark の 1 値だけ変える → 落ちる |
| G2 | §4 の組がすべて基準以上 | 同じく tokens.css の 16 進・rgba を読み、付録 A の式で比を出す（組の一覧は §4.2–4.4 をそのまま配列にする） | `--fr-color-text-tertiary` を `#9BA0A8`（今の値）に戻す → 落ちる |
| G3 | chrome のファイルに `var(--vscode-` が無い（例外の 2 ファイルを除く） | src を grep | 1 か所足す → 落ちる |
| G4 | 参照している `--fr-*` がすべて tokens.css で定義されている（`--fr-bg-selection` は逆に定義されていないこと） | src の `var(--fr-…` を集めて tokens.css の定義と突き合わせる | mindmap.css に `var(--fr-text)` を戻す → 落ちる |
| G5 | tokens.css に `color-mix(` / `light-dark(` が無い | grep | 1 つ書く → 落ちる |

### 10.6 確かめ方

1. `npm run test:build:all`（新しい worktree では pdf_viewer.css が入らないことがあるので 2 回）。`test/html/standalone-viewer.html` の差分が nonce だけなら `git checkout` で戻す
2. `npx tsc -p ./ --noEmit`
3. Playwright は自分の設定 `test/pw-wt.config.ts`（testDir = この worktree の test、port 3100、`reuseExistingServer: false`）を作り、`npx playwright test -c test/pw-wt.config.ts --reporter=json > /tmp/fractal-design/pw.json` → `scripts/check-known-red.sh /tmp/fractal-design/pw.json` で**新しく落ちたものだけ**を見る。終わったら設定を消す（commit しない）
4. 撮影: `node /tmp/fractal-design/capture.cjs after`（12px）と `node /tmp/fractal-design/capture.cjs after --font-size 13 --out /tmp/fractal-design/after-13`（§11 Q1 の比較用）。`/tmp/fractal-design/compare.html` で before と並べる。17 場面 × light / dark
5. 目で見る所: dark で outliner と notes の panel の色が同じか / blockquote が読めるか / table の chip（light）/ mindmap の dark / menu の hover が見えるか / tree の hover・現在地・複数選択の 3 つが見分けられるか / 新規の行が 248px で切れないか / PDF の紙面の縁が見えるか
6. VS Code（light / dark / auto で OS を切り替える）。Electron は §14.3

### 10.7 危ないところ

- **menu と dialog の実装が散っている**（menu 8 つ、editor.js の inline の cssText の dialog 3 つ、notes-file-panel.js の S3 の確認）。§7.6・§7.8 の一覧で漏れを数える
- **cascade の順番**: tokens / fr-base 以外は layer の外。notes の panel の CSS-in-JS は mindmap.css より後、viewer・linkedfd などの `<style>` は実行時にさらに後に入る。上書きでなく、その場で直す（D11）
- **`color-scheme` を入れると** iframe（html viewer・drawio）や pdf.js の既定の色が変わりうる。html viewer の iframe は `#fff` を明示しているので大丈夫なはずだが、drawio と pdf.js は Phase 1 の後に撮影で確かめる
- **harness の違い**: `standalone-editor.html` は独自の GitHub 風の配色で本物の md と違う → md は `standalone-notes.html` + `__testApi.mdDispatcher.loadMarkdown` で見る。`standalone-notes.html` は mindmap.css を含まない → mindmap は `standalone-outliner.html` で見る。harness の文字は 14px、本物の既定は 12px
- **Windows の和文**: `Yu Gothic UI` は細く見えやすい。Windows で見られるなら Phase 2 の後に確かめる
- 大きさの変化（文字 13px・行 26px・menu の項目 26px）で、長い menu（outliner の右クリック、約 22 項目）が低い窓で下にはみ出すことがある。今の位置合わせ（画面内に収める処理）が効くか確かめる

---

## 11. ユーザーに確かめること

| # | 問い | 既定（この文書の案） | 断られたとき |
|---|---|---|---|
| Q1 | 本文の文字の既定（`fractal.fontSize`）を 12px → **13px** にしてよいか。2026-05 の B案で 14 → 12 に下げた経緯がある（14 × 0.9 = 12.6 を切り下げた）。UI を 13px にすると、既定のままでは tree の文字が本文より大きくなる | 13px（package.json の default と、それを読む 4 つの .ts の既定値） | 12px のまま。その場合は `--fr-text-base` を 12px にする（1 行）。menu・dialog だけ 13px に残してもよい |
| Q2 | link・tag・検索結果の見出しの青を、以前ユーザーが選んだ `#3994BC` から `#0256C3` に変えてよいか（`#3994BC` は白の上で 3.27:1 で AA に届かない） | 変える | teal の色相のまま AA に届く濃さ（例 `#0F6E99` 付近）の ramp を作って差し替える |
| Q3 | accent は青（Figma 寄り）か紫（Quick 寄り）か。紫にすると tree・linkedfd・mindmap の複数選択も紫になる（R16 rev2 は「青」） | 青 | §3.1 の紫のブロックに差し替える（§4.5 で検証済み） |
| Q4 | md の H1・H2 の下線をやめてよいか | やめる | 下線を 1px の `divider` で残す |
| Q5 | note tree の「開いている項目」の印を、1px の縦線から灰色の丸い塗りに変えてよいか | 変える | 縦線を 2px の `primary`・角丸で残し、塗りは付けない |
| Q6 | md の行の高さを 1.44 → 1.6 にしてよいか（B案で詰めた値） | 1.6 | 1.5 |

---

## 付録 A. コントラストの計算式

```python
def lin(c):                       # sRGB 0–255 → 線形
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def luminance(rgb):               # 相対輝度
    r, g, b = (lin(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def contrast(a, b):               # WCAG のコントラスト比
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)

def over(rgba, base):             # 半透明を下の面に重ねる（測る前に必ず合成する）
    *rgb, alpha = rgba
    return tuple(round(c * alpha + bc * (1 - alpha)) for c, bc in zip(rgb, base))
```

この文書の数字は、この式で §3 の値から計算した（作業中のスクリプトは `/tmp/fractal-design/calc/`。G2 の test を入れるときは、この式を TS に移す）。

## 付録 B. accent ramp の全段（OKLCH で作った値）

| 段 | 青（既定・色相 259°） | 紫（差し替え・色相 292°） | OKLCH の L |
|---|---|---|---|
| 50 | `#F1F6FF` | `#F6F4FF` | 0.972 |
| 100 | `#E3EEFF` | `#EDEAFF` | 0.946 |
| 200 | `#C9DEFF` | `#DCD6FF` | 0.895 |
| 300 | `#9EC4FF` | `#C3B7FE` | 0.814 |
| 400 | `#6EA6FE` | `#A992FF` | 0.725 |
| 500 | `#3D87F8` | `#916BF9` | 0.635 |
| 600 | `#0A68E6` | `#7A46E7` | 0.547 |
| 700 | `#0256C3` | `#6638C4` | 0.481 |
| 800 | `#06469E` | `#522E9E` | 0.416 |
| 900 | `#083474` | `#3C2375` | 0.339 |
| 950 | `#09254F` | `#291A4F` | 0.271 |

使うのは 100 / 200 / 400 / 600 / 700 / 800 と、dark 用の合成 2 つ（青 `#263651` / `#273A5A`、紫 `#383051` / `#3D335A`）だけ。他の段は差し替えの色を作るときの目安。

## 付録 C. 今の値 → 新しい値（主な token）

| token | light 今 → 新 | dark 今 → 新 |
|---|---|---|
| `--fr-color-primary` | `#9CC8DC` → `#0A68E6` | `#7DC4DF` → `#0A68E6` |
| `--fr-color-primary-soft` | `#DEEDF5` → `#E3EEFF` | `#1F3A4A` → `#263651` |
| `--fr-color-primary-strong` | `#3994BC` → `#0256C3` | `#7DC4DF` → `#6EA6FE` |
| `--fr-color-accent` / `-soft` | `#6B5BE0` / `#E8E5FA` → primary / primary-soft の alias | `#8B7DEB` / `#2F2A4A` → 同左 |
| `--fr-color-bg-app` | `#FAFAF7` → `#FFFFFF` | `#1E1F28` → `#1F1F22` |
| `--fr-color-bg-panel` | `#FAFAF7` → `#F5F4FB`（案 A5。案 A は `#F7F7F8`） | `#1E1F28` → `#18181B` |
| `--fr-color-bg-elevated` | `#FFFFFF` → `#FFFFFF` | `#2A2B36` → `#2A2A2E` |
| `--fr-color-border` | `#E6E5DD` → `#E2E2E6` | `#34353F` → `#38383E` |
| `--fr-color-divider` | `#EDECE5` → `#E7E7EA` | `#2D2E37` → `#2E2E33` |
| `--fr-color-text-primary` | `#1A1B1F` → `#18181B` | `#E8E9EB` → `#EDEDEF` |
| `--fr-color-text-secondary` | `#6B6F76` → `#52525B` | `#B5B8BF` → `#B4B4BC` |
| `--fr-color-text-tertiary` | `#9BA0A8` → `#64646C` | `#80848C` → `#9A9AA2` |
| `--fr-color-text-muted` | `#B5BAC1` → `#A1A1AA` | `#5C6068` → `#5F5F67` |
| `--fr-color-success` / `-soft` | `#46A663` / `#DCEFE3` → `#16A34A` / `#DCFCE7` | `#6BCD83` / `#1F3A28` → `#22C55E` / `#1F3A2C` |
| `--fr-color-warning` / `-soft` | `#E9A03A` / `#FBEFD8` → `#D97706` / `#FEF3C7` | `#F0B859` / `#4A3A1F` → `#F59E0B` / `#41331E` |
| `--fr-color-danger` / `-soft` | `#D94A4A` / `#FBE3E3` → `#C21D1D` / `#FEE2E2`（danger-solid は `#C81E1E`） | `#F26B6B` / `#4A1F1F` → `#F87171` / `#402527` |
| `--fr-color-info` / `-soft` | `#3F8CC9` / `#DCEDF8` → primary-strong / primary-soft | `#5FAFE3` / `#1F344A` → 同左 |
| `--code-bg` | `#F2F1EA` → `#F4F4F5` | `#25262E` → `#2C2C31` |
| `--blockquote-color` | `bg-elevated`（白）→ `text-secondary` | `bg-elevated` → `text-secondary` |
| `--fr-color-scrollbar-thumb` / `-hover` | `rgba(0,0,0,.15/.25)` → `rgba(24,24,27,.18/.32)` | `rgba(255,255,255,.15/.25)` → `rgba(255,255,255,.18/.30)` |
| `--fr-shadow-focus` | `0 0 0 3px primary-soft`（約 1.1:1）→ `0 0 0 3px focus-halo` + 縁 `focus-ring` | 同左 |

---

## 12. 実装の記録（2026-11-07・branch `design-modern`）

§10.1 の Phase 1〜3 を 1 回で入れた（Inter / CSP の外部 font の削除だけは入れていない — 下の「入れていないもの」）。値は §3 のとおり。§11 の問いは「既定（この文書の案）」で入れ、Q1 だけは `fractal.fontSize` の既定（12）を変えていない。

### 12.1 文書と違う所（理由つき）

| # | 文書 | 実装 | 理由 |
|---|---|---|---|
| I1 | md の H1 / H2 / H3 の上の余白 1.2em / 1.5em / 1.3em（§5.4） | 0.6em / 0.75em / 0.7em | この editor は md の空行を空の段落として描く。見出しの前にはふつう 1 行の空行があるので、文書の値だと空行と足し算で間が開きすぎた（撮影で確認） |
| I2 | 件数の badge は地 `fill-active` の pill・最小幅 16px（§7.10） | 地なしの 10px / 600 `text-secondary` の数字 | outliner の子の数は bullet（幅 22px）の右上に重なる位置にあり、16px の pill は三角に被る |
| I3 | S3 の同期中の覆いは `overlay`（§7.8） | `overlay-strong`（翻訳中の覆いも同じ） | 白い文字と spinner を載せるので、`.32` の覆いでは白い本文の上で文字が読めない |
| I4 | outliner の scope 検索の tag は `primary` の塗り（§3.12 の誤用 6 か所） | `primary-soft` + `primary-strong` | 本文の tag と同じ見た目にそろえた（どちらも 4.5:1 以上） |
| I5 | md の table の浮く toolbar はボタン 28 × 28・icon 16px（§7.7） | 26 × 26・icon 14px | ボタンと区切りが 15 個以上並ぶので、28px だと狭い本文で横にはみ出しやすい。板（地・縁・角 10px・影 3）は文書どおり |
| I6 | outliner の右クリックの submenu は chevron-right（§7.6） | ▶ のまま（12px `text-tertiary`） | ▶ は outliner.js が shortcut の欄の文字として入れている（JS を触らないと変えられない）。linkedfd の menu は CSS の mask で Lucide の chevron にした |
| I7 | タブの閉じる × は「選択タブと hover したタブだけに出す」 | 非選択・非 hover のタブでは不透明度 0（押せる場所は残す）。キーボードで × に来たときは不透明度 1（§12.5 R14） | DOM を変えずに出し分けるため |

### 12.2 文書に無いが足したもの

- 部品の CSS で token を参照する所のうち、token を読まないテストのハーネス（about:blank に CSS だけ載せる型）でも形が崩れない所に fallback を付けた: notes-folder-view.js の寸法（角・文字）、outliner の drop 線と drop の点線、検索結果の種別の見出しの線と file 名の色
- `textarea.source-editor`（md の source mode）と outliner のタイトル欄は、fr-base の `input/textarea:focus-visible` の halo を打ち消した（編集中の文字に ring を出さない決まり）
- mermaid の theme を `data-fr-theme` から決める（auto は OS の配色。§7.13 の「実装時に確認」）
- mindmap の node の中の link を `primary-strong` に（UA の既定のリンク色だった）
- outliner の絞り込みで一致した行（`is-search-match`）も角 6px

### 12.3 入れていないもの（次の判断待ち）

- Inter の `<link>` と CSP の `fonts.googleapis.com` / `fonts.gstatic.com` の削除（§5.4・§10.1 Phase 3。外部通信と CSP の変更なので別の小さな変更として）
- `fractal.fontSize` の既定 12 → 13（§11 Q1）。撮影は 12px（`/tmp/fractal-design/after`）と 13px（`/tmp/fractal-design/after-13`）の両方
- tooltip（§7.8 — 今回は作らない）
- known-red の基準線（`test/known-red-baseline.json`）: 刷新で green になった 5 件（§12.4 の integration-minimal-foundation）は main に入れるときに基準線から外した（また落ちたら gate が止める）。ほかに green だった 3 件（mindmap-iteration24 の TC-M13 × 2・skills-search-filters の TC-SS-09）は刷新と関係ないので触っていない

### 12.4 test

- 足した: `test/unit/design-tokens-modern.spec.ts` の G1〜G5（+ G2b = 逃がしの組を作らない決まりが CSS にあること）。どれも、わざと壊して落ちることを 1 度確かめた（G1 = auto-dark の値を 1 つ変える / G2 = text-tertiary を `#9BA0A8` に戻す / G2b = linkedfd の危険な項目の hover を fill-hover に / G3 = drop 線を `var(--vscode-focusBorder…)` に戻す / G4 = mindmap の node の色を `var(--fr-text…)` に戻す / G5 = fill-hover を `color-mix()` に）
- 値を更新した（見た目の値の固定で、振る舞いではない）:
  - `notes-search-results-jump.spec.ts`: file 名の色 `rgb(57, 148, 188)` の固定をやめ、`--fr-color-primary-strong` を probe で解決した値と比べる（ハーネスに本番と同じく tokens.css を先に読ませた。以前は tokens を読まず CSS の fallback の色を見ていた）。「VS Code の link の色にならない」「種別名は別の色 + 2px の線」はそのまま
  - `integration-minimal-foundation.spec.ts`: TC-05a / 05b / 06 を新しい本文の色（`255, 255, 255` / `31, 31, 34`）に、TC-09 を「選択タブ = `fill-active` の pill（角 6px）・非選択は塗らない」に（下線はもう無い）。5 件とも known-red から green に（TC-08a も、☰ を角 6px にしたので green）
  - `mindmap-iteration9.spec.ts` TC-W1: 「上限 280px に届かない改行なしの一文」の例文を 18 字 → 15 字に。和文の UI 書体（Hiragino Sans 等）を明示したので和文が 1 字 = 1em になり、旧 18 字（`-apple-system` の fallback で 1 字 ≒ 12px だった）は上限に届くようになった。振る舞い（上限までは横に伸び、超えたら折り返す）は変えていない

### 12.5 レビューの指摘の直し（2026-11-07）

画面と code のレビューで出た 20 件。どれも確かめてから直した（R8 と R15 は一部 — 理由つき）。数字は付録 A の式。

| # | 指摘 | 直したこと | 守る test |
|---|---|---|---|
| R1 | dark の浮く面の中の区切り線が見えない（divider `#2E2E33` / `#2A2A2E` = 1.06:1） | 浮く面の中の線は border（1.23:1）で引く: outliner と md の右クリックの区切り・table の列 menu の区切り・md の table の浮く toolbar の区切り・command palette の入力欄の下・添付の panel の見出しの下・action panel の確定の上（§3.3・§7.6） | G2c・G2d |
| R2 | focus 行・選択した mindmap の node の上で tag の pill が消える（dark の hover 1.06:1、mindmap は地と同じ色） | dark の soft-hover を `#29426B`（soft との段差 1.21:1）にし、その上の文字を `primary-strong-hover`（dark `#9EC4FF` 5.65:1）に。選択した mindmap の node の上の tag も同じ組（§3.5・§7.10） | G2・G2c・TC-DMR-07 |
| R3 | table の chip の × が light で 2.42–2.85:1・10px | 12px・不透明度 .8（light 3.43–4.23、dark 5.00–6.04）。行の高さ 1 で chip の高さは変えない | G2（outliner.css の値を読む） |
| R4 | 先頭の選択タブの左の線と sidebar の右の線で 2px | 先頭のタブの左は引かない（§7.9） | TC-DMR-02 |
| R5 | sidepanel の Outline の見出しが note 面のものと違う（色・高さ・線） | 同じ形にした（36px・左 10px・12px / 600 secondary・下に divider）。横の sidepanel のヘッダーも 36px（R12）なので下の線が 1 本につながる（§7.14） | 撮影 |
| R6 | sidebar の section の見出しの左端がお気に入り（17px）と Recent（11px）でずれる | Recent の見出しと行の icon を 17px に（§7.1・§7.2） | 撮影 |
| R7 | 危険な項目の見た目が menu によって違う | outliner の Delete Node・Delete Page・Remove File と mindmap の Delete Group に danger（§7.6） | G2b・TC-DMR-08 |
| R8 | code block の言語の名前が角から約 78px 浮く・隠れたボタンが押せる | 言語の名前を flex の `order` で右端（角）へ。**隠れたボタンは不透明度 0 のまま**（visibility や pointer-events では隠さない）: 隠れているのは pointer が block の外にあるときだけで、block に入れば見える（keyboard は :focus-within で見える）ので押せても見えない所には無い。visibility / pointer-events で隠すと、block に hover せずに Copy・言語を押す既存の test（約 10 件）が Playwright の「見える・押せる」の確認で止まる | TC-DMR-05 |
| R9 | 検索結果の [md] / [p.5] などが 3.35:1 | 11px `text-tertiary`（sidebar の上 5.48:1）の class に（§7.14） | 撮影 |
| R10 | 飛んだ先の flash の黄色が md・outliner・tree で 3 種類 | `--fr-color-jump-flash(-strong)` の 1 組に（§3.8）。md と outliner は前の値に戻り、tree の行は同じ amber に。dark の強い方は .40（.85 の金色は明るい文字が 1.61:1 だった） | G2 |
| R11 | add column・task の範囲の dialog だけ余白・文字・ボタンが小さい | 内側 20px・title 14px・入力欄 28px / 13px・ボタン 28px / 13px / 500（§7.8） | 撮影 |
| R12 | ヘッダーの icon ボタンの箱が 26 × 25 / 24 × 22 / 22 × 22 の 3 種類 | outliner・file viewer・sidepanel・linkedfd のヘッダーも 26 × 25・間隔 28px。viewer と sidepanel のヘッダーは 36px。sidepanel のヘッダーは間を 4px → 2px にした（Outline を開いた 380px の sidepanel でも file 名の最小幅が残る — TC-SPM-01） | TC-SPM-01・TC-HN-* |
| R13 | dark で inline code は本文より明るく、code block は暗い（向きが逆） | dark の code block を `#26262A`（本文より一段明るい）に。hljs の dark の色は 4.90–9.81:1（§3.9） | G2（styles.css の hljs の値を読む） |
| R14 | タブの × に keyboard で来ても見えない（不透明度 0 で ring も消える） | :focus-visible で不透明度 1（§7.9） | TC-DMR-01 |
| R15 | auto + OS の dark で mermaid が dark の theme になり、PDF に黒い図が載る | 画面の修正（dark の面で dark の図）は残し、PDF の清書で画面を 'dark' で描いた図だけ light の theme で描き直す（init directive でその 1 回だけ・失敗した図は画面のまま・6 秒で打ち切り — pdf-export-webview.js の relightMermaidForPrint）。明示の dark のときの PDF も同じく直る。**残したこと**: note を開いたまま OS の配色を変えたときの図の追従（theme は最初の描画で 1 回決める — 前からの動き） | TC-DMR-06・06b |
| R16 | text viewer が VS Code の editor の書体と大きさに従わなくなった | `--vscode-editor-font-family / -size` を読む形に戻した（色ではないので P7 の対象外 — §5.4）。G3 は書体と大きさの変数を数えない | G3 |
| R17 | 行の塗りを margin で 6px 寄せたので、端の 6px が押せない帯（linkedfd では drop が root へ・右クリックが空き領域の menu） | 透明な左右の縁 + background-clip で塗りだけ寄せる（§5.3）: linkedfd の行・md の Outline・sidepanel の目次・Recent・検索結果の行 | TC-DMR-03 |
| R18 | Outline の下の語数が 11px で … に切れる | 切らずに「· 」の後ろで折り返す（数字と単位は改行しない空白でつなぐ）。左右の余白を 14 → 10px（見出しの左とそろう）にして、ふつうの長さなら 1 行に入る | TC-DMR-09 |
| R19 | drawio の 4 つのボタンが画像の左端を越えて隣の面に出る | 画像の幅に入らない分は次の行へ折り返す（§7.13） | TC-DMR-04 |
| R20 | 単独の viewer のタブが開いたまま `fractal.theme` を変えても追従しない | fileViewerProvider.ts が設定の変更で値を送り、inline script が `data-fr-theme` だけを差し替える（値は light / dark / auto だけを受ける。タブを閉じたら聞くのをやめる — §7.14） | TC-VTF-01・02 |

足した test: `test/unit/design-tokens-modern.spec.ts` の G2 の組（tag の hover の文字・chip の ×・flash・危険な項目の shortcut・dark の hljs）と G2c（線と pill の段差）・G2d（浮く面の中の線は border）、G2b（outliner と mindmap の危険な項目）、G3（書体の変数は対象外）。`test/specs/design-modern-review-fixes.spec.ts`（TC-DMR-01〜09）、`test/unit/viewer-theme-follow.spec.ts`（TC-VTF-01・02）。どれも、直した所を元に戻すと落ちることを 1 度確かめた。


---

## 13. 試した案と戻し方（2026-11-07）

**採用は A5**（本文は白・左パネルはほんのり紫）。ユーザーは「元の状態やほかの案に戻すかも」と言っているので、試した案は全部、頼まれたらいつでも戻せるように残す。

### 13.1 案の一覧

A 系は本文を白にして左パネルの色を変えた案、B 系は左パネルを白にして本文に色を付けた案。どの案も部品の CSS（§7・§12）は同じで、違うのは `src/webview/tokens.css` の light のブロック（最初の `:root,`）の 7 つの token だけ。`--fr-color-bg-chrome`（タブ strip）はどの案も `--fr-color-bg-panel` と同じ値。dark と auto + OS dark はどの案も同じ。

| 案 | 見た目 | `bg-app`（本文） | `bg-panel` = `bg-chrome`（左パネル・md の Outline・タブ strip） | `bg-canvas` | `code-bg` | `code-block-bg` | `chip-zinc-bg` | git の tag | 試した vsix |
|---|---|---|---|---|---|---|---|---|---|
| 元の状態 | 刷新の前（全部 `#FAFAF7` の暖色オフホワイト・teal の accent・VS Code の色） | — | — | — | — | — | — | `design/before` | 1.3.20-rc.19 |
| A | 左パネルはニュートラルの薄い灰 | `#FFFFFF` | `#F7F7F8` | `#F2F2F4` | `#F4F4F5` | `#F7F7F8` | `#F1F1F3` | `design/A` | design.1 |
| A2 | 左パネルを A より白に | `#FFFFFF` | `#FAFAFB` | `#F2F2F4` | `#F4F4F5` | `#F7F7F8` | `#F1F1F3` | `design/A2` | design.8 |
| A3 | 左パネルに青み | `#FFFFFF` | `#F4F6FA` | `#F2F2F4` | `#F4F4F5` | `#F7F7F8` | `#F1F1F3` | `design/A3` | design.9 |
| A4 | 左パネルに暖かみ | `#FFFFFF` | `#F7F6F2` | `#F2F2F4` | `#F4F4F5` | `#F7F7F8` | `#F1F1F3` | `design/A4` | design.10 |
| **A5（採用）** | 左パネルにほんのり紫（Amazon Quick 寄り） | `#FFFFFF` | `#F5F4FB` | `#F2F2F4` | `#F4F4F5` | `#F7F7F8` | `#F1F1F3` | `design/A5` | design.11 |
| B1 | 左パネルを白・本文を薄い灰 | `#F6F6F7` | `#FFFFFF` | `#EBEBEE` | `#EBEBEE` | `#FFFFFF` | `#E8E8EB` | `design/B1` | design.2 |
| B2 | 同・本文を青みのある薄い灰 | `#F4F6F9` | `#FFFFFF` | `#E9EDF2` | `#E9EDF2` | `#FFFFFF` | `#E6EAF0` | `design/B2` | design.3 |
| B3 | 同・本文を元の地の色 | `#FAFAF7` | `#FFFFFF` | `#EFEFEC` | `#F0F0EC` | `#FFFFFF` | `#EDEDEA` | `design/B3` | design.4 |
| B4 | 同・本文をより白く | `#FAFAFA` | `#FFFFFF` | `#EFEFF1` | `#F0F0F2` | `#FFFFFF` | `#EDEDF0` | `design/B4` | design.5 |
| B5 | 同・本文をさらに白く | `#FCFCFC` | `#FFFFFF` | `#F1F1F3` | `#F2F2F3` | `#FFFFFF` | `#EFEFF1` | `design/B5` | design.6 |
| B6 | 同・本文をさらに白く（わずかに暖色） | `#FCFCFA` | `#FFFFFF` | `#F1F1EE` | `#F2F2EF` | `#FFFFFF` | `#EFEFEC` | `design/B6` | design.7 |

- 危険・注意の文字（light の `--fr-color-danger` `#C21D1D`・`--fr-color-warning-text` `#A14907`）は A5 を main に入れるときに少し濃くした。案の commit（tag）の値 `#C81E1E` / `#A64B07` のままだと、A5 の開いている行（active/sidebar）の上で 4.42 / 4.45:1 になり G2 に落ちる。濃くした 2 色なら 11 案すべてが G2 に通る（11 案の値を 1 つずつ入れて確かめた）ので、**案を替えるときもこの 2 色は戻さない**
- 経緯（ユーザーの評価）: A を作る → B1・B2 と比べて「まだ A がよい。本文領域がグレーすぎる」→ B3・B4 で「方向性はこっちがいい。本文をもう少し白く」→ B5・B6 → A のまま左パネルの色を変えた A2〜A5 → A5 を採用
- tag は手元の git にだけある（push していない。共有するなら `git push origin 'refs/tags/design/*'`）。各案の branch と worktree も残してある: `design-modern`（A。`wt-design`）・`design-modern-b`（B1〜B6。`wt-design-b`）・`design-modern-a`（A2〜A5。`wt-design-a`）
- 試した vsix（`fractal-1.3.20-design.N.vsix`）は main のフォルダに置いた git の外のファイル。中身は tag の commit そのもの（濃くする前の 2 色）。撮影は `/tmp/fractal-design/`（一時。消えたら tag から撮り直す）

### 13.2 戻し方

**ほかの案にする**（A・A2〜A4・B1〜B6）:

1. `src/webview/tokens.css` の最初の `:root,` のブロックで、13.1 の 7 つの token（`--fr-color-bg-app`・`--fr-color-bg-panel`・`--fr-color-bg-chrome`・`--fr-color-bg-canvas`・`--fr-color-code-bg`・`--fr-color-code-block-bg`・`--fr-chip-zinc-bg`）を表の値にする。左パネルの上の注記（「左パネル（panel / chrome）は A5 …」）も書き換える
2. `npm run test:build:all`（`test/html/standalone-*.html` は tokens.css を埋め込んでいるので作り直して一緒に commit する）
3. `npx playwright test test/unit/design-tokens-modern.spec.ts`（コントラスト。11 案とも通ることは確かめ済み）
4. この文書の値（§0・§2・§4.2・§4.4・§4.5・§9 D2・付録 C）と、`docs/fractal/design.md`「面」・`docs/specs/frontend.md`「Surfaces」の左パネルの色を直す
5. commit → vsix

**Electron 版**: ほかの案にするときは Electron 側（`electron/`）を直さなくてよい。Electron が自分で描く所（サイドバー・入力の小窓・通知・描く前の地の色）も tokens.css をそのまま読む（§14）ので、`.app` を作り直すだけで同じ案になる（`cd electron && npm run build:app-dir`）。**元の状態に戻すときは、Electron の commit（tag `design/electron`）も一緒に revert する** — Electron の CSS は刷新で足した token（`fill-hover`・`fill-active`・`focus-ring`・`border-strong`・`primary-hover` など）を使うので、tokens.css だけ刷新の前に戻すと hover や選択の塗りが消える

**元の状態（刷新の前）に戻す**: 刷新を main に入れた commit（tag `design/adopt`）を `git revert design/adopt` で打ち消す。触ったファイルは 37（CSS・JS・docs・test）。その後に案を替えた commit があれば先にそれも revert し、後から同じファイルを直した commit と衝突したらその所だけ直す。刷新の前の状態は tag `design/before`（`git diff design/before design/adopt` で全部の差分が見られる）。

**案を見比べる**（main を変えずに）: `git worktree add ../wt-x design/B4` → `node_modules` を main への symlink に・`vendor` を copy → `npm run test:build:all` → `test/html/standalone-*.html` を開く。vsix にするなら `npx @vscode/vsce package --no-dependencies`（worktree の中の directory の symlink は vsce の秘密情報の検査で EISDIR になるので、`.harness` などは置かない）。

---

## 14. Electron 版への反映（2026-11-08）

依頼: 「electron も新デザインを反映してください」。Electron 版の note の中（webview）は拡張機能の CSS をそのまま使うので、`.app` を作り直すだけで刷新が入る。Electron が自分で描いている所（左のサイドバー・入力の小窓・通知・note が無いときの画面・ページを描く前の地の色）を、同じ token で描くように変えた。撮影（変更前 / 後、light / dark）: `/tmp/fractal-electron-design/before/`・`after2/`（一時）。

### 14.1 決まり

| 部位 | 決まり | 出典 |
|---|---|---|
| token の読み方 | Electron のページ（サイドバー・入力の小窓）は、拡張機能の `out/webview/tokens.css` と `fr-base.css`（note の webview が読むのと同じファイル）をそのまま読み、`--fr-*` だけを使う。`--vscode-*` は読まない。値を Electron 側に写さない — tokens.css の案を替えると（§13.2）Electron も同じになる | P7・L-20261023-vscode-theme-color-leak・L-20261027-mcp-mirror-drift |
| 描く前の地の色 | window・note の view・サイドバーの view・入力の小窓がページを描く前に塗る色も、tokens.css の light / dark のブロックの `bg-app` / `bg-panel` / `bg-elevated` を起動時に読む（`electron/src/main/design-tokens.ts`）。読めない値は A5 の値 | — |
| サイドバー | note の左パネルと同じ面と行。地 `bg-panel` + 右に 1px `divider`。上の行は 36px で、真ん中の高さを隣の note の左パネルのヘッダー（≡ note 名）にそろえる（19px。たたんだ縦のバーのボタンも同じ高さ）。名前 13px / 600。section の見出しは 28px・12px / 600 `text-secondary`・大文字化しない・左 17px（行の最初の列と同じ線）・ボタンはいつも出す・開閉の chevron（12px `text-tertiary`）は右端（Recent と同じ）。section の間に `divider` 1 本。行は 26px・角 6px・panel の端から 6px 内側の塗り（透明な縁 + background-clip）・icon 14px `text-secondary`。状態: hover `fill-hover`、表示中の note `fill-active` + 500、キーボードの focus 行 `selection-bg`（ring なし）。開いている note の ● は `primary-strong`、重ねると ×（`fill-hover`）。幅を変える境目は hover で 2px の `primary` | §5.3・§6・§7.1・§7.2・FR-TKN-01/06 |
| 空の案内（viewsWelcome） | 文 13px / 1.5 `text-secondary`。ボタン 28px・角 6px で、**最初の 1 つだけ主ボタン**（`primary`）、残りは副ボタン（`bg-elevated` + 1px `border-strong`）— 主は 1 つの panel に 1 個まで。link は `primary-strong` | §7.4 |
| note が無いときの画面 | 地 `bg-app`、案内の文 13px `text-tertiary` | §5.4 |
| 入力の小窓（showInputBox / showQuickPick） | 地 `bg-elevated`、題 14px / 600、説明 13px `text-secondary`。入力欄 28px・地 `fill-subtle`・縁なし → focus で `focus-ring` + halo、誤りは `danger`。候補の行 28px・角 6px・選んでいる行は `fill-active`（青をやめる）、群の名前 11px / 600 `text-tertiary`（大文字化しない）。ボタン 28px: Cancel は副、OK は主（右端） | §7.4・§7.5・§7.7 |
| 通知（VS Code の非 modal の message。note の右下） | 浮く面の card: `bg-elevated` + 1px `border` + 角 10px + `--fr-shadow-3`。重さは左の色の線をやめて 8px の丸（info `primary-strong`・warning `warning`・error `danger`）。閉じるは 12px の Lucide の x（20 × 20・角 4px）。ボタン 24px・最初の 1 つが主。token は note のページのもの（shadow root にも custom property は継がれる） | §5.1・§5.5・§7.4 |
| 変えないもの | native の menu・title bar・message box・file の dialog（OS が描く）。note の webview に入れる `--vscode-*`（VS Code が入れる値の再現 — `theme-vars.ts`。サイドバーのためだけに足していた sideBar 系の 11 個は消した） | — |

§7.8 の toast（md の外部変更の通知: 暗い小片の `bg-inverse`）の形は、通知には使わなかった。通知は操作のボタンと詳細を持ち、VS Code の通知と同じく読んで押すための面なので、menu・dialog と同じ浮く面にした。

### 14.2 test

- `test/unit/electron-sidebar.spec.ts`: サイドバーの CSS が読む `--fr-*` はすべて tokens.css にある（色と影は light と dark の両方のブロック）・`--vscode-*` を読まない・ページは `data-fr-theme="auto"` で始まる・design の CSS は拡張機能の 2 つのファイルをそのまま読む・描く前の色は tokens.css の値（無い値・16 進でない値は 1 つずつ fallback）
- `test/e2e-electron-app/sidebar.spec.ts` AC-2: サイドバーの地と文字が `bg-panel` / `text-primary` の色で、6 つの token の値が note のページと同じ（light / dark）。`--vscode-sideBar-background` は無い

### 14.3 確かめ方

1. `cd electron && npm run build:e2e && cd .. && npx playwright test test/e2e-electron-app`（窓が開いて focus を取る）
2. 目で見る所（light / dark）: 開いている note が 2 つ・行の hover・● の上・キーボードの focus（↓）・通知・入力の小窓・たたんだ縦のバー・空の list（案内のボタン）。撮影は一時の spec（`FRACTAL_E2E_DEV=1` で開発版を動かし、view ごとに `capturePage` して 1 枚に並べる）で行った。commit していない
