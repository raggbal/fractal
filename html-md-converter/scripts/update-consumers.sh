#!/usr/bin/env bash
# dist/html-md-converter.js を fractal 内の全 consumer に配布する。
#
# consumer:
#   - src/webview/html-md-converter.js                            (VS Code extension paste handler)
#   - chrome-extension/lib/html-md-converter.js                   (Chrome 拡張)
#   - ai_skills/web-crawler-md/scripts/html-md-converter.js   (web-crawler-md skill)
#
# 使い方:
#   npm run build && ./scripts/update-consumers.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
FRACTAL_ROOT="$(cd "$PKG_ROOT/.." && pwd)"

SRC="$PKG_ROOT/dist/html-md-converter.js"

if [ ! -f "$SRC" ]; then
    echo "✗ dist/html-md-converter.js が無い。先に 'npm run build' を実行してください" >&2
    exit 1
fi

TARGETS=(
    "src/webview/html-md-converter.js"
    "chrome-extension/lib/html-md-converter.js"
    "ai_skills/web-crawler-md/scripts/html-md-converter.js"
)

SIZE=$(wc -c <"$SRC" | tr -d ' ')
VER=$(grep -o 'html-md-converter v[0-9.]*' "$SRC" | head -1 || echo "unknown")
echo "Source: $SRC ($SIZE bytes, $VER)"
echo ""

for rel in "${TARGETS[@]}"; do
    target="$FRACTAL_ROOT/$rel"
    if [ ! -d "$(dirname "$target")" ]; then
        echo "⚠ skip: $(dirname "$target") が存在しない" >&2
        continue
    fi
    cp "$SRC" "$target"
    echo "✓ $rel"
done

echo ""
echo "Next: rebuild fractal ('npm run compile') / chrome 拡張 reload / web-crawler-md skill 再起動"
