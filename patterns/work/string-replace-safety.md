## JS コンテンツの String.replace 注入
- **発生日**: 2026-04-11
- **原因**: standalone HTML build script で html.replace('__X__', jsContent) を使用。jsContent 内の $ が置換パターン ($&, $', $1 等) として解釈された
- **教訓**: JS/CSS コンテンツを replace で注入するときは safeReplace (function-based) を使う: `str.replace(token, function() { return value; })`
- **根拠**: v4 で Playwright テスト全滅 (30 分消費)
