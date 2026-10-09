# draw.io 描画ライブラリ（media/drawio-viewer/）

file viewer の drawio kind（`.drawio` / `.drawio.svg` / `.drawio.png` / `.dio` 系）は、draw.io 公式の
`viewer-static.min.js` と `stencils.min.js`（jgraph/drawio・Apache-2.0）を隔離 iframe の中で実行して描画する。
npm では配布されていないため、版を固定して repo に commit している（ADRL-0136）。

| ファイル | 内容 |
|---|---|
| `viewer-static.min.js` | 描画本体（Graph / Editor / mxGraph） |
| `stencils.min.js` | アイコン（AWS など）の定義集。これが無いとアイコンが空になる |
| `manifest.json` | 版・commit・各ファイルの size と SHA-256 |
| `LICENSE-drawio.txt` | Apache-2.0 全文 + アイコンの利用条件 + 商標の注記 |

## ビルド時の照合

`npm run compile` が `scripts/verify-drawio-vendor.js` を実行し、manifest と実ファイルの size・SHA-256 が
一致しなければビルドを止める。ファイルを手で編集しない。

## 版を更新する手順

1. advisory を確認する: https://github.com/jgraph/drawio/security/advisories
   （viewer で効くのは label XSS・CSS 経由のビーコン・DoS 系。サーバ・editor 機能の advisory は対象外）
2. 更新先のタグが指す **commit hash** を確認する（タグは付け替えられることがあるので commit で固定する）
3. 取得する: `node scripts/fetch-drawio-vendor.js --commit <40 桁の hash> --version <x.y.z>`
   （サイズ上限つきで受信し、SHA-256 を計算して manifest.json を書き換える）
4. `LICENSE-drawio.txt` の Version / Commit 行を更新する（上流 README の利用条件が変わっていないかも見る）
5. `test/unit/viewer-drawio-vendor.spec.ts`（TC-DIO-07）の期待値（版・size・sha256）を更新する
6. `npm run test:parallel` で drawio の E2E（`test/specs/viewer-drawio.spec.ts`）を含めて確認する

## 注意

- 公開から日が浅い版は避ける（v32.3.0 採用時点で v32.4.1 は公開 1 日）
- 描画中の外部通信は iframe 内の meta CSP で 0 にしている（ADRL-0135）。版更新で既定 URL の変数名が
  変わると取りこぼす可能性があるので、TC-DIO-31（外部通信 0）が落ちたら前置 script の上書き対象を見直す
