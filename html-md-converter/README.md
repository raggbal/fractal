# html-md-converter

HTML → Markdown 変換ライブラリ。**turndown + turndown-plugin-gfm + Fractal 由来の独自 rule + 前処理 / 後処理**を 1 ファイルにバンドル。

> このパッケージは **fractal リポジトリ内の sub-package** として管理されている (`fractal/html-md-converter/`)。
> consumer は以下 3 箇所:
> - `fractal/src/webview/` (VS Code extension の paste handler)
> - `fractal/chrome-extension/lib/` (Chrome 拡張)
> - `fractal/claude_skills/web-crawler-md/scripts/` (crawl.py から Playwright 経由で注入)

## 使い方 (browser / Playwright eval)

```html
<script src="html-md-converter.js"></script>
<script>
    const md = HtmlMdConverter.htmlToMarkdown('<h1>Hello</h1>');
    console.log(md);  // "# Hello"
</script>
```

Playwright (Python) からも:

```python
await page.add_script_tag(path="html-md-converter.js")
md = await page.evaluate("(html) => HtmlMdConverter.htmlToMarkdown(html)", html)
```

## 機能

| 機能 | 概要 |
|---|---|
| GFM table 化 | `<th>` 不在 table に空 `<thead>` を自動注入 (markdown table 必須仕様を満たす) |
| `tableCellEscapePipe` | cell 内 `\|` を escape、cell 内改行を `<br>` に |
| `cleanupSpans` | 空 span / Apple-converted-space を除去 |
| `styledBold` / `styledItalic` / `styledStrikethrough` | CSS `font-weight: bold` 等を `**...**` 等に変換 (Google Docs 等) |
| `fencedCodeWithLang` | `<pre><code class="language-xxx">` から言語抽出、Medium 等の `<pre><br>` 形式にも対応 |
| `normalizeLink` | multi-line link text を 1 行化、`[![](src)](href)` 簡略化、Wikipedia 引用 `[40]` 形式対応 |
| `inlineSvg` | `<svg>` を `data:image/svg+xml;base64,...` の markdown image に変換 (Fractal 既存の data-url-image-extractor で `.svg` ファイル化される) |
| `compactListItem` | Turndown default の loose list を tight list に変換 |
| post-process unescape | `\-`, `\#`, `\>`, `\.` 等を unescape (markdown editor paste 向け) |

## ビルド

```bash
cd fractal/html-md-converter
npm install   # 初回のみ (jsdom devDependency)
npm run build # → dist/html-md-converter.js
```

依存なし (Node の `fs` だけ)。

## テスト

```bash
npm test       # → test/fixtures/*.html を変換して .expected.md と比較
```

## 各 consumer への配布

ビルド後、以下のスクリプトで `dist/html-md-converter.js` を 3 consumer にまとめて配布する。

```bash
npm run build
./scripts/update-consumers.sh
```

配布先:
- `fractal/src/webview/html-md-converter.js`
- `fractal/chrome-extension/lib/html-md-converter.js`
- `fractal/claude_skills/web-crawler-md/scripts/html-md-converter.js`

いずれも **自リポジトリ内の相対 cp** だけを行う (GitHub fetch は廃止)。

consumer 側:

- `src/webview/editor.js` の paste handler は `HtmlMdConverter.htmlToMarkdown(html)` を呼ぶ
- `chrome-extension/lib/` に取り込んだ場合、既存の `turndown.js` / `turndown-plugin-gfm.js` / `fractal-md.js` は bundle に同梱されるため削除可
- `claude_skills/web-crawler-md/scripts/crawl.py` は `page.add_script_tag(path=...)` で注入

## ライセンス

MIT
