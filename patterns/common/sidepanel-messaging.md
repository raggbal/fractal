## Side panel editor へのメッセージ追加（5箇所ルール）
- **発生日**: 2026-04-11（v5）、2026-04-12（v8 で再発・拡張）
- **原因**: editor.js の main instance handler にだけ追加し、他の箇所を漏らした
- **教訓**: 新メッセージは **5 箇所** に追加が必要:
  1. **host bridge** (outliner-host-bridge.js / notes-host-bridge.js) — postMessage 送信メソッド
  2. **host handler** (outlinerProvider.ts / notes-message-handler.ts) — case ハンドラ
  3. **outliner.js setupHostMessages** — Host→Webview メッセージの side panel 転送ケース
  4. **SidePanelHostBridge クラス** (editor.js 先頭) — side panel 用メソッド定義。shared methods を継承しないため、明示的に定義が必要
  5. **Provider の message handler** (outlinerProvider.ts) — Webview→Host メッセージの処理。editorProvider.ts にあっても outlinerProvider.ts に漏れやすい
- **注意**: standalone MD (editorProvider.ts)、standalone outliner (outlinerProvider.ts)、notes mode (notes-message-handler.ts + notesEditorProvider.ts) の3つのProviderすべてにハンドラが必要
- **根拠**: v5 sprint で 3 回のビルド失敗。v8 sprint で insertFileLink 転送漏れ、sidePanelSetFileDir 転送漏れ、saveFileAndInsert outlinerProvider 未実装、SidePanelHostBridge メソッド未定義
