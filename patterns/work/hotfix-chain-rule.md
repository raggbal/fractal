## hotfix が2回連鎖したら sprint fix に切り替える
- **発生日**: 2026-04-13
- **原因**: move の unlink 削除 → page paste のファイルリンク漏れ発見 → ファイル命名ロジックミス発見 → pasteWithAssetCopyResult スコープ問題 と hotfix が連鎖。個別 hotfix では全体像を見失い、修正が場当たり的になった
- **教訓**: hotfix が2回連鎖したら、立ち止まって以下を判断する:
  1. 「まだ見えていない関連バグがないか？」を全体調査（/investigate）
  2. 影響範囲が3ファイル以上なら /sprint fix に切り替え
  3. 個別 hotfix を続けない — 場当たり修正の連鎖はバグを増やす
- **根拠**: v9 sprint — 3回の hotfix 後に結局 /sprint fix を実行。最初から /sprint fix にしていればバグ3件を防げた可能性
