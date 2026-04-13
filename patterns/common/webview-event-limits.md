## VSCode webview で使えないブラウザ API
- **発生日**: 2026-04-13
- **原因**: `new ClipboardEvent('paste', { clipboardData: new DataTransfer() })` + `dispatchEvent` で paste handler をプログラム的にトリガーしようとしたが、VSCode webview では synthetic ClipboardEvent が正しく動作しない
- **教訓**: 以下の API は VSCode webview で動作しないか制限がある:
  - `new ClipboardEvent()` + `dispatchEvent` — paste イベントがトリガーされない
  - `document.execCommand('paste')` — セキュリティ制限で動作しない場合がある
  - 代替策: 共通関数を切り出して直接呼び出す（イベント経由にしない）
- **根拠**: v9 sprint — pasteWithAssetCopyResult の挿入処理で synthetic event アプローチが失敗
