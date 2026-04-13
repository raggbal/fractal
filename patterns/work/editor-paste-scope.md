## editor.js paste handler からコードを切り出す際のスコープチェック
- **発生日**: 2026-04-13
- **原因**: paste handler（800行）から `_insertPastedMarkdown` を切り出した際、クロージャで暗黙参照していた変数（`internalMd`, `text`, `e.clipboardData`）が未定義エラーになった
- **教訓**: editor.js の paste handler からコードを切り出す前に、以下を必ず実施する:
  1. 切り出す範囲内で参照している**外部スコープの変数**を grep で全てリストアップ
  2. 各変数を引数で渡すか、関数内で再取得するか決定
  3. `e.clipboardData.getData()` は paste イベント内でしか呼べない — 事前に値を変数に取り出してから関数に渡す
  4. コンパイル後、**実機で** paste 操作をテスト（Playwright テストだけでは不十分）
- **根拠**: v9.1 sprint — `internalMd is not defined` エラー、`markdownToHtml is not defined` エラー
