# v4 手動テストシナリオ: Markdown link/image の () サポート

## 前提
- `fractal-0.195.635.vsix` をインストール済み
- VSCode を完全再起動済み

---

## テスト 1: DOD-16 — Editor で () 入り画像表示

### 手順
1. `test/manual/test-paren-links.md` を Fractal Editor で開く
2. 以下の画像が**すべて 1 つの画像として描画される**ことを確認

### 期待結果
| # | Markdown | 表示 |
| --- | --- | --- |
| 1 | `![photo v2](images/photo_(v2).png)` | 画像 1 枚表示 ✓ |
| 2 | `![nested data](images/data_((nested)).png)` | 画像 1 枚表示 ✓ |
| 3 | `![東京](images/東京（tokyo）.png)` | 画像 1 枚表示 ✓ |
| 4 | `![normal](images/normal.png)` | 画像 1 枚表示 ✓ (退行チェック) |
| 5 | `![screenshot](images/screenshot_(copy).png)` | 画像 1 枚表示 ✓ |

### NG パターン (旧バージョンの症状)
- 画像が壊れたアイコンになる
- `(v2).png)` 部分がテキストとして表示される
- alt テキスト `photo v2` しか見えない

---

## テスト 2: DOD-17 — Editor で () 入りリンク表示

### 手順
1. 同じ `test-paren-links.md` の § 6, 7, 8 を確認

### 期待結果
| # | Markdown | 表示 |
| --- | --- | --- |
| 6 | `[Foo (disambiguation)](https://en.wikipedia.org/wiki/Foo_(disambiguation))` | クリック可能なリンク 1 個 ✓ |
| 7 | `[Complex](https://example.com/path/((a)(b))/end)` | クリック可能なリンク 1 個 ✓ |
| 8 | `[Google](https://www.google.com)` | クリック可能なリンク 1 個 ✓ (退行チェック) |

### NG パターン
- リンクテキストの後に `)` や URL の一部がテキストとして表示される
- リンクがクリックしても途中の URL にしか飛ばない

---

## テスト 3: DOD-18 — Import md files で () 入り画像取込

### 手順
1. Note を開く (または新規作成)
2. Outliner のメニュー → 「Import md files...」
3. `test/manual/test-paren-links.md` を選択
4. 取り込まれたノードのうち、ページ付きノードを開く

### 期待結果
- `photo_(v2).png` / `data_((nested)).png` / `東京（tokyo）.png` の画像参照が正しくページに取り込まれている
- ページを Editor で開くと画像が表示される
- 取り込まれた画像ファイルが対象の pages/images/ フォルダにコピーされている (rename されて新 filename)

### NG パターン
- 画像参照が途中で切れる (`(v2)` の `)` で切れて `![photo v2](images/photo_` になる)
- 画像ファイルがコピーされない

---

## テスト 4: DOD-19 — Paste で () 入り画像の実体コピー

### 手順
1. Note A の Outliner で、ページ付きノード (page) を作成
2. そのページの .md を開き、`![test](images/photo_(v2).png)` を記述して保存
3. ノードを選択 → Cmd+C
4. 同じ outliner 内で Cmd+V

### 期待結果
- 新しいノードが作られ、新しい pageId の .md が作られる
- 新 .md 内の画像参照が **新 filename** に書き換わっている (例: `copy-<newPageId>-photo_(v2).png`)
- images/ フォルダに新 filename の画像ファイルが**実体コピー**されている
- Editor で新ページを開くと画像が表示される

### NG パターン
- 新 .md の画像参照が元のまま (filename 変わっていない)
- 画像ファイルが物理コピーされていない
- Editor で画像が表示されない

---

## テスト 5: DOD-20 — Outliner に生 URL ペースト → リンク化

### 手順
1. Outliner で空のノードにフォーカス
2. 以下の URL をシステムクリップボードにコピー:
```
https://en.wikipedia.org/wiki/Foo_(bar)
```
1. Outliner のノードで Cmd+V

### 期待結果
- ノードのテキストが `[https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_(bar))` になる
- Outliner 上でリンクとして描画される (クリック可能)
- URL 全体 (最後の `(bar)` を含む) が 1 つのリンクになる

### NG パターン
- `(bar)` の `)` で URL が切れて `https://en.wikipedia.org/wiki/Foo_(bar` までしかリンクにならない
- 後ろに `)` がテキストとして残る

---

## テスト 6: DOD-21 — fractal-md skill で () 入り変換

### 手順
1. Claude Code で `/fractal-md` を実行
2. `test/manual/test-paren-links.md` (または同等の () 入り画像を含む .md) を対象として指定

### 期待結果
- .out ファイルにノードとして取り込まれる
- 画像参照が正しく parse され、images/ にコピーされる
- `(v2)` `((nested))` `（tokyo）` を含む画像ファイル名が壊れない

### NG パターン
- 画像の参照が途中で切れて不正なパスになる
- 変換時にエラーが出る

---

## テスト 7: 退行チェック — v3 の copy/paste 機能 (追加)

### 手順
v3 で修正した cross-outliner paste が壊れていないことを確認:
1. 同じ note / 同じ outliner で page ノード cmd+c → cmd+v → .md 複製 ✓ + 画像コピー ✓
2. 同じ note / 別 outliner で page ノード cmd+c → cmd+v → .md 複製 ✓ + 画像コピー ✓
3. 別 note の outliner で page ノード cmd+c → cmd+v → .md 複製 ✓ + 画像コピー ✓
4. 別 note の outliner で page ノード cmd+x → cmd+v → .md 移動 ✓ + 画像移動 ✓

---

## チェックリスト (結果記入用)

| テスト | DOD | 結果 | 備考 |
| --- | --- | --- | --- |
| 1. Editor 画像表示 | DOD-16 | ◯ / ✗ | <br> |
| 2. Editor リンク表示 | DOD-17 | ◯ / ✗ | <br> |
| 3. Import md files | DOD-18 | ◯ / ✗ | <br> |
| 4. Paste 画像コピー | DOD-19 | ◯ / ✗ | <br> |
| 5. URL paste リンク化 | DOD-20 | ◯ / ✗ | <br> |
| 6. fractal-md skill | DOD-21 | ◯ / ✗ | <br> |
| 7a. 退行: 同 outliner paste | — | ◯ / ✗ | <br> |
| 7b. 退行: 同 note 別 outliner paste | — | ◯ / ✗ | <br> |
| 7c. 退行: 別 note copy/paste | — | ◯ / ✗ | <br> |
| 7d. 退行: 別 note cut/paste | — | ◯ / ✗ | <br> |
