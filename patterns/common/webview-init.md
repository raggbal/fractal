## Webview state の注入経路
- **発生日**: 2026-04-11
- **原因**: updateData メッセージのみに state を追加し、Outliner.init(data, outFileKey) 経路を見落とした
- **教訓**: webview に新 state を追加するときは (1) Outliner.init 引数 (2) updateData msg (3) outlinerWebviewContent.ts / notesWebviewContent.ts の HTML 埋め込み の 3 箇所を確認
- **根拠**: v3 で currentOutFileKey が null のまま paste 判定が壊れた
