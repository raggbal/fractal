# Fractal Web Clipper (Chrome Extension)

ブラウザで開いている Web ページを **Fractal Outliner (`.out`) の先頭ノード**、または **Notes の Markdown の subpage** として 1 クリックで保存する Chrome 拡張。

- **Outliner に保存**: ノードの text = ページタイトル、`isPage: true` + 新 `pageId` 発行、`<notesFolder>/<pageId>.md`（フラットレイアウト = note 直下）にページ本文を保存
- **Markdown に保存**: `<uuid>.md` を対象 md と同じ場所に新規作成し、対象 md の**末尾に subpage リンク `[[タイトル]](<uuid>.md)` を追記**
- 本文は **Mozilla Readability で記事抽出** + **Fractal の HTML→MD 変換ロジックそのまま** (Turndown + 独自 rule: table cell pipe escape / span cleanup / style-based bold/italic/strike / fenced code with lang / normalized link / compact list / post-process)

VSCode と直接通信しません — ブラウザの **File System Access API** で `.out` を直接読み書きします。VSCode 起動不要、native host 不要、HTTP server 不要。

---

## v0.6.2 で何が変わったか

- **操作は黄色い枠にまとめた** — note の一覧の行には状態（✓ 保存できます / まだ有効ではありません / もう一度許可が要ります / このコンピューターにはありません）だけを出し、行ごとの「有効にする…」をなくした。フォルダを選ぶ「選ぶ…」と、許可が切れたときの「もう一度許可」は、黄色い枠にフォルダごとに 1 つ
- **言語の選択を一番上に**（タイトルの右）

## v0.6.1 で何が変わったか

- **選ぶフォルダを 1 行ずつ** — 設定画面の黄色い枠に、選ぶフォルダのパス・中の note の数・「選ぶ…」を 1 行ずつ出す。「選ぶ…」はパスをコピーしてからフォルダを選ぶ画面を開く（画面は前に開いた場所で開き、拡張からは場所を決められないため）。その画面で ⌘⇧G → ⌘V → Enter → 「選択」で移れる
- **ほかのコンピューターの note** — `.fractal` に入っている別のマシンの note（Mac での `/home/ec2-user/…` など）は「このコンピューターにはありません」と出し、数えない・選ぶフォルダにしない・popup に出さない。同じ名前のフォルダをこのコンピューターで選んでも、その note として扱わない
- 設定画面の見出しも日本語に

## v0.6.0 で何が変わったか

- **note は一覧の中で「有効にする」** — まだ保存できない note には **有効にする…** ボタンが付き、上に「どのフォルダを選べばよいか」が出る（例 `~/workspace/fractal` の note を有効にする…）。フォルダを 1 回選ぶと、その中の note すべてが **✓ 保存できます** になる。「許可したフォルダ」の一覧はなくした
- **保存先プリセットをやめて ★ に** — note の一覧の ☆ を押すと、その note が popup で先に出る。popup は note ごとに前回保存した保存先を最初から選び、quick clip（Alt+Shift+F）は最後に保存した場所に保存する。0.5 までのプリセットは ★ と前回の保存先に自動で移る

## v0.5.0 で何が変わったか

- **note は .fractal から読む** — note を 1 つずつ登録するのをやめた。設定で Fractal の `.fractal`（既定は `~/.fractal/default.fractal`）を選ぶと、そこに書かれた note が保存先になる。開くたびに読み直すので、Fractal で足した note もそのまま出る
- **フォルダを 1 回許可するだけ** — Chrome は `.fractal` に書かれたパスを自分では開けない。note が入っているフォルダ（例 `~/workspace/fractal`）を 1 回許可すると、その中の note すべてに保存できる。設定画面は、まだ保存できない note と、許可するとよいフォルダを出す
- **以前の登録はそのまま引き継ぐ** — 0.4 までに 1 つずつ登録した note は、`.fractal` にあれば許可ごと引き継ぎ、プリセット・前回の選択もそのまま使える。`.fractal` に無いものは「以前の登録」として残り、使える

## v0.4.1 で何が変わったか

- **保存先の一覧に添付と folder link が出ていた不具合を直した** — Fractal の note のツリーには今、添付ファイル（docx・pdf など）と folder link も入る。それらまで「Outliner」として一覧に出て、選んで保存すると失敗していた。今は Outliner（`.out`）と Markdown だけを出す
- 保存の書き込みを `lib/clip-writer.js` の 1 つにまとめた（popup の保存と quick clip（Alt+Shift+F）が同じものを使う）。今の Fractal が作った note に実際に保存して、Fractal がそれを読めることを `test/specs/clipper-compat.spec.ts` が確かめる

## v0.3.0 で何が変わったか

- **フラットレイアウト対応** — 本体のフラット化（page md = note 直下・画像 = 共有 `images/`）に追従。`.out` の `pageDir` ヒントを尊重し、本体と同じ判定順（note 直下に md があれば flat）で保存先を決める。未移行 note には従来位置に保存（混在を作らない）
- **Markdown への取り込み** — 保存先に outline.note の md item も選べる。取込ページは新規 `<uuid>.md` になり、選んだ md の末尾に subpage リンクが付く
- **保存先プリセット** — 「フォルダ + Outliner/Markdown」のペアを Options で複数登録し、★default を指定。popup は default が初期選択、quick clip（Alt+Shift+F）も default を使う

## v0.2.0 で何が変わったか

- **Notes フォルダを複数登録可能に** — 用途別 (work / personal 等) のフォルダを切替可
- **Popup を選択画面化** — folder + outliner を毎回選んでから Bookmark
- 直前選択した folder + outliner が次回 default 選択として復元
- `outline.note` から outliner 一覧を読み込み、folder 階層もインデント表示
- 旧 single-folder 設定 (`notesFolderHandle` / `targetOutPath`) は自動 migration

---

## インストール (開発者モード)

Chrome ウェブストアには出していないので、このリポジトリのフォルダを読み込む。

1. リポジトリを取ってくる: `git clone https://github.com/raggbal/fractal`（git が無ければ GitHub の **Code → Download ZIP** で zip を落として開く）。ビルドは要らない
2. Chrome (or Edge) で `chrome://extensions` を開く
3. 右上「**デベロッパーモード**」を ON
4. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
5. `fractal/chrome-extension/` フォルダを選択

icon が出たら成功（ツールバーのパズルのアイコンから📌で固定すると押しやすい）。初めて入れたときは設定が自動で開く。

- **更新**: `git pull`（zip なら新しい zip で置き換え）してから、`chrome://extensions` の Fractal Web Clipper の **↻（再読み込み）** を押す。設定（.fractal・有効にした note・★）はそのまま
- **削除**: `chrome://extensions` で **削除**。note には触れない

---

## 初回 setup

1. ツールバーの拡張アイコンを右クリック → **オプション**
2. **「📄 .fractal を選ぶ…」** で Fractal の `.fractal` を選ぶ
   - 既定は `~/.fractal/default.fractal`（Fractal が最初に作る。Fractal の **Fractal List** に出ている一覧）
   - `~/.fractal` は隠しフォルダ。Mac はダイアログで **⌘⇧G** を押して `~/.fractal` と入力する
3. 黄色い枠に **選ぶフォルダ**（例 `~/workspace/fractal`）が 1 行ずつ出るので、その行の **選ぶ…** を押す
   - パスがコピーされ、フォルダを選ぶ画面が開く（前に開いた場所で開く）。**⌘⇧G** → **⌘V**（貼り付け）→ Enter → **選択**
   - Chrome が「ファイルの編集を許可しますか」と聞くので許可する
   - そのフォルダの中の note すべてが **✓ 保存できます** になる（Fractal であとから足した note も、そのフォルダの中ならそのまま使える）
   - ホームフォルダそのもの・`~/Documents`・`~/Desktop`・`~/Downloads` は Chrome が選ばせない。その 1 つ下を選ぶ
   - 「このコンピューターにはありません」の note（別のマシンのパス）は対象外
4. よく使う note に ☆ を押して ★ にする（popup で先に出る）

---

## 使い方

1. 保存したい Web ページを開く
2. ツールバーの拡張 icon を click (or `Alt+Shift+F`)
3. ポップアップで:
   - **Note**（★ が先）と **保存先**（Outliner / Markdown）を選ぶ。最初は最後に保存した note、保存先はその note で前回保存したもの
   - まだ有効ではない note は選べない（設定で有効にする）
   - `Alt+Shift+F` は popup を開かずに、最後に保存した場所に保存する
4. **「📌 Bookmark」** ボタンを click → 保存実行
5. 数秒で完了。VSCode で対象 `.out` を再読み込みすれば先頭にノードが追加されている

---

## 生成される page MD のフォーマット

```markdown
# <ページタイトル>

元ページ: [<URL>](<URL>)

著者: <byline>  (Readability が取得できた場合のみ)

サイト: <siteName>  (同上)

<Markdown 本文>
```

---

## 動作仕様

| 項目 | 詳細 |
| --- | --- |
| ノード位置 | `rootIds` の先頭に prepend (一番上) |
| ノード id | `n + base36(timestamp) + random` (Fractal と同じスキーム) |
| pageId | `crypto.randomUUID()` |
| pageDir | `.out` の `pageDir` field を尊重（`"."` = note 直下フラット）。未指定は本体 `flat-layout.ts` と同じ順（note 直下に md があれば flat → legacy `<outlinerId>/` に md 実在なら legacy → flat）で解決（`lib/flat-layout-mirror.js`） |
| 既存ノード | 一切触らない |
| 既存 page MD | 一切触らない |

`.out` は parse → 先頭に node 追加 → JSON.stringify(2) で書き戻すので、フォーマット (インデント) も Fractal と同じ 2-space。

---

## ファイル構成

```
chrome-extension/
├── manifest.json              # Chrome 拡張 manifest v3 (v0.5.0)
├── background.js              # service worker（quick clip = Alt+Shift+F）
├── popup.html / popup.js      # ツールバーポップアップ (note + 保存先の選択 + clip 実行)
├── options.html / options.js  # 設定 UI（.fractal・note の有効化と ★・言語）
├── icons/                     # ツールバーアイコン (Fractal アイコン流用)
├── lib/
│   ├── idb.js                 # IndexedDB helper (FileSystemHandle 永続化)
│   ├── fractal-list.js        # .fractal の読み取り（本体 notes-registry.ts と同じ判定）・許可したフォルダの位置決め
│   ├── folder-registry.js     # note の一覧・有効にしたフォルダ・outline.note 読み取り・★・前回の保存先
│   ├── clip-writer.js         # 保存の書き込み（popup と quick clip が共用）
│   ├── clipper-core.js        # node 追加 + page MD 組立 (DOM 非依存)
│   ├── flat-layout-mirror.js  # 保存先の決め方（本体 flat-layout.ts のミラー）
│   ├── data-url-image-extractor.js # data: 画像を images/ に実体化
│   ├── html-md-converter.js   # Fractal の HTML→MD 変換（Turndown + GFM + 独自 rule）
│   ├── Readability.js         # Mozilla Readability (記事抽出)
│   └── i18n.js / i18n-messages.js # 表示の英語 / 日本語
└── README.md                  # このファイル
```

---

## 技術選定の補足

- **File System Access API** (`showOpenFilePicker` / `showDirectoryPicker`): Chrome / Edge / Opera で利用可能。Firefox / Safari は未対応 → 本拡張は Chromium 系のみ動作。
- **.fractal と許可したフォルダ**: ブラウザはパスを直接開けないので、`.fractal` は file handle、note はユーザーが許可したフォルダの handle からたどって開く。handle は自分の絶対パスを教えないので、許可したフォルダが `.fractal` のどのパスかは「フォルダ名が note のパスの途中にあり、その下に note（`outline.note`）が実際にある」ことで決める（`lib/fractal-list.js`。同じだけ当てはまる候補が 2 つあれば決めずに、1 つ上のフォルダを頼む）
- **handle 永続化**: `FileSystemHandle` は IndexedDB に直接 `put` 可能。 chrome.storage.local では serialize 不可なので IDB を使う。
- **outline.note 読み取り**: Fractal Notes mode と同じ `NoteStructure` JSON を parse、`type: 'file'` アイテムを folder 階層付きで列挙。outline.note が無い folder は disk 上の `*.out` を flat に列挙する fallback。
- **manifest v3 service worker** は最小限。すべてのロジックは popup ページで実行 (file handle が popup 文脈で扱える必要があるため)。

---

## Storage (IDB) schema

| key | value | 用途 |
| --- | --- | --- |
| `fractalList` | `{ handle: FileSystemFileHandle, name, notes: string[] }` | 選んだ `.fractal`（notes は最後に読めた一覧。読めないときに使う） |
| `accessRoots` | `Array<{ path, handle: FileSystemDirectoryHandle }>` | note を有効にするときに選んだフォルダ（path = `.fractal` の中での位置。画面には出さない） |
| `notesFolders` | `Array<{ id, name, handle: FileSystemDirectoryHandle }>` | 0.4 までの 1 つずつの登録（`.fractal` にあるものは引き継いで消える） |
| `favoriteNotes` | `string[]` | ★ の note（popup で先に出す） |
| `lastSelection` | `{ folderId, targetId, targetKind }` | 最後に保存した場所（quick clip の保存先・popup の初期選択） |
| `lastTargets` | `{ [noteId]: { targetId, targetKind } }` | note ごとに前回保存した保存先 |

note の id（`folderId` など）は note のパス（以前の登録は その id）。0.5 までの `presets` / `defaultPresetId` は ★・前回の保存先・最後に保存した場所に移してから消す。旧 schema (`notesFolderHandle` / `notesFolderName` / `targetOutPath`) は v0.2.0 起動時に自動 migration → 削除。

---

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| Options で「許可が得られませんでした」 | ボタンを押し直し、ダイアログで「許可」を選ぶ |
| popup で「note がまだありません」 | Options で `.fractal` を選ぶ |
| note が「まだ有効ではありません」 | Options の黄色い枠の「選ぶ…」を押し、開いた画面で ⌘⇧G → ⌘V → Enter → 「選択」 |
| 「選ぶ…」を押すと関係ないフォルダが開く | 選ぶ画面は前に開いた場所で開く（拡張からは場所を決められない）。パスはコピー済みなので ⌘⇧G → ⌘V → Enter で移る |
| note が「もう一度許可が要ります」 | Chrome の再起動などで許可が切れた。黄色い枠のそのフォルダの「もう一度許可」を押す（フォルダの中の note がまとめて戻る） |
| note が「このコンピューターにはありません」 | `.fractal` に別のマシン（EC2 など）の note が入っている。このコンピューターでは保存先にならない（Fractal の一覧はそのまま） |
| 「そのフォルダには .fractal の note が入っていません」 | 選んだフォルダの中に `.fractal` の note が無い。note のフォルダか、その上のフォルダを選ぶ |
| 「どのフォルダか決められません」 | 同じ名前のフォルダが `.fractal` に 2 つある。1 つ上のフォルダを選ぶ |
| popup に「新しい note を読み込むには…許可してください」 | Chrome の再起動などで `.fractal` の許可が切れた。「許可」を押す（それまでは最後に読めた一覧を使う） |
| Outliner dropdown が空 | 対象 folder の `outline.note` が無いか壊れている。Fractal で folder を一度開いて自動生成、または folder 内に `*.out` があるかチェック |
| `(.out が見つかりません)` 表示 | folder の root 直下に `.out` ファイルがない (Notes mode の convention 違反)。Fractal で folder を開いて構造を確認 |
| 以前の登録に「要再許可」表示 | Chrome 再起動などで FileSystemHandle の権限が失効。Options の以前の登録の「再許可」を押す（popup でも保存するときに聞かれる） |
| Alt+Shift+F で「保存先がまだありません」 | popup で 1 回保存する。Alt+Shift+F はその場所に保存する |
| node が追加されたが VSCode で見えない | VSCode 側で `.out` を一度閉じて開き直すか、editor を refresh |

---

## ライセンス

このフォルダ全体は本リポジトリ親プロジェクト (Fractal) の MIT ライセンスに従います。

bundled 依存:
- Turndown (MIT) — https://github.com/mixmark-io/turndown
- Turndown GFM plugin (MIT) — 同上
- Mozilla Readability (Apache 2.0) — https://github.com/mozilla/readability
