## Side panel editor へのメッセージ追加
- **発生日**: 2026-04-11
- **原因**: editor.js の main instance handler にだけ追加し、outliner.js の setupHostMessages に転送ケースを追加しなかった
- **教訓**: 新メッセージは 3 箇所に追加: (1) host bridge (2) host handler (3) outliner.js setupHostMessages に転送ケース。insertImageHtml パターン (outliner.js:4750) を必ず参照。
- **根拠**: v5 sprint で 3 回のビルド失敗
