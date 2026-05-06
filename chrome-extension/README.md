# Fractal Web Clipper (Chrome Extension)

ブラウザで開いている Web ページを **Fractal Outliner (`.out`) の先頭ノード** として 1 クリックで保存する Chrome 拡張。

- ノードの text = Web ページタイトル
- ノードは `isPage: true` + 新 `pageId` 発行
- `<notesFolder>/<...>/<pageDir>/<pageId>.md` にページ本文 (Markdown) を保存
- 本文は **Mozilla Readability で記事抽出** + **Fractal の HTML→MD 変換ロジックそのまま** (Turndown + 独自 rule: table cell pipe escape / span cleanup / style-based bold/italic/strike / fenced code with lang / normalized link / compact list / post-process)

VSCode と直接通信しません — ブラウザの **File System Access API** で `.out` を直接読み書きします。VSCode 起動不要、native host 不要、HTTP server 不要。

---

## インストール (開発者モード)

1. Chrome (or Edge) で `chrome://extensions` を開く
2. 右上「**デベロッパーモード**」を ON
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
4. このフォルダ (`fractal/chrome-extension/`) を選択

icon が出たら成功。

---

## 初回 setup

1. ツールバーの拡張アイコン (本) を右クリック → **オプション**
2. **「Pick Notes Folder…」** で対象 Notes フォルダを選択
   - これが Fractal で管理している複数 `.out` を入れたフォルダ
   - 一度許可すれば毎回聞かれない (Chrome が handle を永続化)
3. フォルダ内 `.out` 一覧から **clip 先**を 1 つクリック

---

## 使い方

1. 保存したい Web ページを開く
2. ツールバーの 本アイコンをクリック
3. ポップアップで対象 .out が表示されたら **「Clip this page」**
4. 数秒で完了。VSCode で対象 `.out` を再読み込みすれば先頭にノードが追加されている

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
| pageDir | `.out` の `pageDir` field を尊重 (default `./pages`) |
| 既存ノード | 一切触らない |
| 既存 page MD | 一切触らない |

`.out` は parse → 先頭に node 追加 → JSON.stringify(2) で書き戻すので、フォーマット (インデント) も Fractal と同じ 2-space。

---

## ファイル構成

```
chrome-extension/
├── manifest.json          # Chrome 拡張 manifest v3
├── background.js          # service worker (no-op、将来用)
├── popup.html / popup.js  # ツールバーポップアップ (clip 実行)
├── options.html / options.js # 設定 UI (Notes フォルダ + .out 選択)
├── icons/icon128.png       # ツールバーアイコン (Fractal アイコン流用)
├── lib/
│   ├── idb.js              # IndexedDB helper (FileSystemHandle 永続化)
│   ├── turndown.js         # bundled (vendor 由来)
│   ├── turndown-plugin-gfm.js
│   ├── Readability.js      # Mozilla Readability (記事抽出)
│   ├── fractal-md.js       # Fractal の HTML→MD 変換ロジック
│   └── clipper-core.js     # node 追加 + page MD 組立 (DOM 非依存)
└── README.md               # このファイル
```

---

## 技術選定の補足

- **File System Access API** (`showDirectoryPicker`): Chrome / Edge / Opera で利用可能。Firefox / Safari は未対応 → 本拡張は Chromium 系のみ動作。
- **handle 永続化**: `FileSystemDirectoryHandle` は IndexedDB に直接 `put` 可能。 chrome.storage.local では serialize 不可なので IDB を使う。
- **manifest v3 service worker** は最小限。すべてのロジックは popup ページで実行 (file handle が popup 文脈で扱える必要があるため)。

---

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| Options で「許可が得られませんでした」 | Pick Folder ボタンを押し直し、ダイアログで「許可」を選ぶ |
| popup で「未設定」 | Options を開いて Notes フォルダと .out を設定 |
| `.out` が見つからない | サブフォルダは検索しているが、`pages` / `images` / `files` / `node_modules` / 隠しフォルダはスキップ。直接配置するか、それ以外のディレクトリ構成にする |
| Readability が記事を抽出できない | full body を turndown にかける fallback が動く (品質劣化あり) |
| node が追加されたが VSCode で見えない | VSCode 側で `.out` を一度閉じて開き直すか、editor を refresh |

---

## ライセンス

このフォルダ全体は本リポジトリ親プロジェクト (Fractal) の MIT ライセンスに従います。

bundled 依存:
- Turndown (MIT) — https://github.com/mixmark-io/turndown
- Turndown GFM plugin (MIT) — 同上
- Mozilla Readability (Apache 2.0) — https://github.com/mozilla/readability
