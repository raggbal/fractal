# v7 手動テストシナリオ: 削除時カスケードの撤回 + 手動クリーンアップ

## 前提
- `fractal-<version>.vsix` をインストール済み
- VSCode を完全再起動済み
- テスト用の Note (outliner ファイル) を作成済み

---

## MAN-V7-1: コマンドパレットから cleanup 起動 (DOD-19)

### 手順
1. VSCode で Note editor を開く
2. Cmd+Shift+P (Ctrl+Shift+P on Windows/Linux) でコマンドパレットを開く
3. "Fractal: Clean Unused Files in Note" と入力して選択

### 期待結果
- QuickPick ダイアログが表示される
- 孤立ファイル (orphan md / orphan images) がリストアップされる
- リストが空の場合は "No unused files found." のメッセージが表示される

### NG パターン
- コマンドが見つからない
- エラーメッセージが表示される
- QuickPick が表示されない

---

## MAN-V7-2: Tools タブの 🧹 ボタンクリック (DOD-48)

### 手順
1. VSCode で Note editor を開く
2. 左側の file panel で "Tools" タブをクリック
3. "Clean Notes" セクションの "Clean Unused Files in All Notes" ボタンをクリック

### 期待結果
- QuickPick ダイアログが表示される (MAN-V7-1 と同じ)
- 全 note の孤立ファイルのリストが表示される、または "No unused files found in any registered note." メッセージ
- 複数 note がある場合は note ごとに Separator で分類表示される

### NG パターン
- Tools タブが表示されない
- Clean Notes ボタンが表示されない
- ボタンをクリックしても反応がない
- エラーが表示される

---

## MAN-V7-3: QuickPick 全選択/全解除 (DOD-19)

### 手順
1. MAN-V7-1 または MAN-V7-2 で QuickPick を開く (孤立ファイルが 2 個以上存在する状態)
2. QuickPick の右上に表示されている check-all アイコン (Select All) をクリック
3. clear-all アイコン (Deselect All) をクリック

### 期待結果
- Select All クリック後: 全アイテムにチェックが入る
- Deselect All クリック後: 全アイテムのチェックが外れる

### NG パターン
- check-all / clear-all アイコンが表示されない
- クリックしても選択状態が変わらない

---

## MAN-V7-4: 個別チェック解除

### 手順
1. QuickPick で孤立ファイルが複数表示されている状態
2. 一部のアイテムのチェックを外す (スペースキーまたはクリック)

### 期待結果
- チェックを外したアイテムは削除対象から除外される
- OK ボタンをクリックすると、チェックが入ったアイテムのみが削除される

### NG パターン
- チェックボックスが機能しない
- チェックを外したアイテムも削除される

---

## MAN-V7-5: 確定 → ゴミ箱移動 (DOD-20)

### 手順
1. QuickPick で削除したいファイルにチェックを入れる
2. OK ボタンをクリックして確定
3. 通知メッセージを確認
4. Finder (macOS) / Explorer (Windows) でゴミ箱を確認

### 期待結果
- "Moved N files to trash. Freed X.X MB." の Information Message が表示される
- N はチェックを入れたファイル数
- X.X MB は削除したファイルの合計サイズ
- ゴミ箱にファイルが移動されている (完全削除ではない)

### NG パターン
- ファイルが完全削除される (ゴミ箱に入らない)
- 通知メッセージが表示されない
- 件数や容量が不正確

---

## MAN-V7-6: OS ゴミ箱確認 (NFR-1)

### 目的
削除したファイルが即時削除ではなく OS ゴミ箱に移動されていることを確認

### 手順
1. MAN-V7-5 の続き (cleanup でファイルをゴミ箱移動した直後)
2. Finder (macOS) / Explorer (Windows) のサイドバーから「ゴミ箱」を開く
3. 削除したファイル名 (例: `orphan1.md`, `foo.png`) が入っているか確認
4. 右クリック → "元に戻す" (macOS) / "復元" (Windows) でファイルが元の場所に戻ることを確認

### 期待結果
- ゴミ箱に削除したファイル名が存在する
- 「元に戻す」で元のパスにファイルが復元される
- Fractal を再起動すると復元したファイルが認識される (ただしオーファンなので画面には直接表示されない)

### NG パターン
- ゴミ箱に入っていない (完全削除されている)
- ゴミ箱から復元できない

---

## MAN-V7-7: 結果レポート (件数+容量) (DOD-20)

### 手順
1. クリーンアップを実行
2. 通知メッセージの内容を確認

### 期待結果
- "Moved N files to trash. Freed X.X MB." のメッセージ
- N と X.X が実際の削除ファイル数とサイズと一致する

### NG パターン
- メッセージが表示されない
- 件数やサイズが 0 と表示される (実際は削除されている)
- 数値が不正確

---

## MAN-V7-8: プログレス UI (DOD-32)

### 目的
大量ファイル時にプログレスバーが表示されることを確認

### 手順 (件数はユーザーが手動調整可)
1. 任意のテスト用 note フォルダを準備
2. ターミナルから `.md` ファイルを 10 件以上作成:
   ```bash
   cd /path/to/note
   for i in {1..10}; do echo "# Orphan $i" > orphan$i.md; done
   ```
3. Fractal で `Fractal: Clean Unused Files in Note` コマンド実行
4. 右下に Notification でプログレス表示されることを確認

### 期待結果
- vscode.window.withProgress の Notification が表示される
- "Scanning <note-name> (1/N)" のメッセージが更新される
- キャンセルボタンをクリックすると処理が中断される

### NG パターン
- プログレス UI が表示されない
- UI がフリーズする
- 応答がない

---

## MAN-V7-9: キャンセルボタン (DOD-32)

### 手順
1. MAN-V7-8 でプログレス UI が表示されている状態
2. キャンセルボタンをクリック

### 期待結果
- クリーンアップ処理が中断される
- QuickPick が表示されない
- ファイルが削除されない

### NG パターン
- キャンセルボタンが機能しない
- キャンセルしてもバックグラウンドで処理が続行される

---

## MAN-V7-10: スコープ制限 (workspace 外に触れない)

### 手順
1. Note のフォルダ構造を確認
2. Note のフォルダ外 (例: ホームディレクトリ) にテストファイルを配置
3. クリーンアップコマンドを実行

### 期待結果
- Note フォルダ外のファイルはリストに表示されない
- Note フォルダ外のファイルが削除されない

### NG パターン
- Note フォルダ外のファイルが削除候補に表示される
- Note フォルダ外のファイルが削除される

---

## MAN-V7-11: Remove Page → Undo で .md が完全復元される (DOD-25, DOD-12)

### 手順
1. Outliner でノードを作成
2. ノードを page 化 (右クリック → "Create Page")
3. Page editor で "TEST_CONTENT" を入力して保存
4. 右クリック → "Remove Page"
5. Cmd+Z (Ctrl+Z on Windows/Linux) で Undo

### 期待結果
- page アイコンが復活する
- page を開くと "TEST_CONTENT" が表示される
- .md ファイルが物理的に存在する (Finder/Explorer で確認可能)

### NG パターン
- page アイコンが復活しない
- page を開いても空または "TEST_CONTENT" が消えている
- .md ファイルが存在しない (v6 までのバグ)

---

## MAN-V7-12: Remove Page → Undo → Redo で整合性が崩れない (DOD-25, DOD-13)

### 手順
1. MAN-V7-11 の続き (Undo で page アイコンが復活した状態)
2. Cmd+Shift+Z (Ctrl+Shift+Z on Windows/Linux) で Redo
3. 再度 Cmd+Z で Undo

### 期待結果
- Redo 後: page アイコンが消える
- .md ファイルは依然として存在する (Finder/Explorer で確認)
- 再 Undo 後: page アイコンが再度復活し、内容も復元される

### NG パターン
- Redo/Undo を繰り返すと整合性が崩れる
- page アイコンと .md ファイルの存在が不一致になる
- 内容が失われる

---

## 備考

- DOD-2 (Notes で outliner 削除) は notes-file-manager.ts の integration テストで検証済み
- DOD-4 (cmd+c → cmd+v 画像複製) は integration-copy-image-assets.spec.ts で検証済み
- これらの手動テストは、E2E 環境 (standalone HTML) では実装困難な操作を実機で確認するためのものです
