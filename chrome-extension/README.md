# Fractal Web Clipper (Chrome Extension)

ブラウザで開いている Web ページを **Fractal Outliner (`.out`) の先頭ノード**、または **Notes の Markdown の subpage** として 1 クリックで保存する Chrome 拡張。

- **Outliner に保存**: ノードの text = ページタイトル、`isPage: true` + 新 `pageId` 発行、`<notesFolder>/<pageId>.md`（フラットレイアウト = note 直下）にページ本文を保存
- **Markdown に保存**: `<uuid>.md` を対象 md と同じ場所に新規作成し、対象 md の**末尾に subpage リンク `[[タイトル]](<uuid>.md)` を追記**
- 本文は **Mozilla Readability で記事抽出** + **Fractal の HTML→MD 変換ロジックそのまま** (Turndown + 独自 rule: table cell pipe escape / span cleanup / style-based bold/italic/strike / fenced code with lang / normalized link / compact list / post-process)

VSCode と直接通信しません — ブラウザの **File System Access API** で `.out` を直接読み書きします。VSCode 起動不要、native host 不要、HTTP server 不要。

---

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

1. Chrome (or Edge) で `chrome://extensions` を開く
2. 右上「**デベロッパーモード**」を ON
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
4. このフォルダ (`fractal/chrome-extension/`) を選択

icon が出たら成功。

---

## 初回 setup

1. ツールバーの拡張アイコンを右クリック → **オプション**
2. **「📁 Add Notes Folder…」** で Fractal の Notes フォルダを選択
   - これが Fractal で管理している複数 `.out` + `outline.note` を入れたフォルダ
   - 一度許可すれば毎回聞かれません (Chrome が handle を永続化)
3. 必要に応じて複数 folder を追加可能 (例: `~/Desktop/notes-work` + `~/Desktop/notes-personal`)

---

## 使い方

1. 保存したい Web ページを開く
2. ツールバーの拡張 icon を click (or `Alt+Shift+F`)
3. ポップアップで:
   - **Notes フォルダ** dropdown で対象フォルダを選択 (前回選択を default 復元)
   - **Outliner** dropdown で対象 outliner を選択 (`outline.note` から読み込み、folder 階層インデント)
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
├── manifest.json              # Chrome 拡張 manifest v3 (v0.2.0)
├── background.js              # service worker (no-op、将来用)
├── popup.html / popup.js      # ツールバーポップアップ (folder + outliner 選択 + clip 実行)
├── options.html / options.js  # 設定 UI (Notes フォルダ複数登録)
├── icons/icon128.png          # ツールバーアイコン (Fractal アイコン流用)
├── lib/
│   ├── idb.js                 # IndexedDB helper (FileSystemHandle 永続化)
│   ├── folder-registry.js     # 複数 folder + outline.note 読み取り (v0.2.0)
│   ├── turndown.js            # bundled (vendor 由来)
│   ├── turndown-plugin-gfm.js
│   ├── Readability.js         # Mozilla Readability (記事抽出)
│   ├── fractal-md.js          # Fractal の HTML→MD 変換ロジック
│   └── clipper-core.js        # node 追加 + page MD 組立 (DOM 非依存)
└── README.md                  # このファイル
```

---

## 技術選定の補足

- **File System Access API** (`showDirectoryPicker`): Chrome / Edge / Opera で利用可能。Firefox / Safari は未対応 → 本拡張は Chromium 系のみ動作。
- **handle 永続化**: `FileSystemDirectoryHandle` は IndexedDB に直接 `put` 可能。 chrome.storage.local では serialize 不可なので IDB を使う。複数 folder は配列として 1 entry に保存。
- **outline.note 読み取り**: Fractal Notes mode と同じ `NoteStructure` JSON を parse、`type: 'file'` アイテムを folder 階層付きで列挙。outline.note が無い folder は disk 上の `*.out` を flat に列挙する fallback。
- **manifest v3 service worker** は最小限。すべてのロジックは popup ページで実行 (file handle が popup 文脈で扱える必要があるため)。

---

## Storage (IDB) schema

| key | value | 用途 |
| --- | --- | --- |
| `notesFolders` | `Array<{ id, name, handle: FileSystemDirectoryHandle }>` | 登録済み folder 一覧 |
| `lastSelection` | `{ folderId, outId }` | 直前選択 (popup の default 復元) |

旧 schema (`notesFolderHandle` / `notesFolderName` / `targetOutPath`) は v0.2.0 起動時に自動 migration → 削除。

---

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| Options で「許可が得られませんでした」 | Add Notes Folder ボタンを押し直し、ダイアログで「許可」を選ぶ |
| popup で「未登録」 | Options を開いて Notes フォルダを 1 つ以上 登録する |
| Outliner dropdown が空 | 対象 folder の `outline.note` が無いか壊れている。Fractal で folder を一度開いて自動生成、または folder 内に `*.out` があるかチェック |
| `(.out が見つかりません)` 表示 | folder の root 直下に `.out` ファイルがない (Notes mode の convention 違反)。Fractal で folder を開いて構造を確認 |
| 「要再許可」表示 | Chrome 再起動などで FileSystemHandle の権限が失効。Options で「再許可」 button を click |
| node が追加されたが VSCode で見えない | VSCode 側で `.out` を一度閉じて開き直すか、editor を refresh |

---

## ライセンス

このフォルダ全体は本リポジトリ親プロジェクト (Fractal) の MIT ライセンスに従います。

bundled 依存:
- Turndown (MIT) — https://github.com/mixmark-io/turndown
- Turndown GFM plugin (MIT) — 同上
- Mozilla Readability (Apache 2.0) — https://github.com/mozilla/readability
