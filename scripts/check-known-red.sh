#!/usr/bin/env bash
# known-red baseline gate — pre-existing red と新規 fail を決定論で切り分ける
#
# reviewer / generator が毎回やっていた「fail 103 件は基準線と一致するか」の
# 手動 diff 検証・stash 切り分けを 1 コマンドに置き換える。
#
# 使い方:
#   1) 既存の playwright JSON を照合:
#        scripts/check-known-red.sh /tmp/results.json
#   2) suite を自分で回して照合 (build 済み前提):
#        scripts/check-known-red.sh --run
#   3) 基準線を更新 (burn-down で green 化した後):
#        scripts/check-known-red.sh --update /tmp/results.json
#
# 出力:
#   NEW FAILS   — 基準線に無い fail (= この sprint 起因。修正必須)
#   FIXED       — 基準線に有るが今回 pass (= burn-down 成果。--update で基準線から除去)
# exit 0 = new fail なし / exit 1 = new fail あり / exit 2 = 実行エラー

set -uo pipefail
cd "$(dirname "$0")/.."

BASELINE="test/known-red-baseline.json"
UPDATE=0
RUN=0
JSON=""

for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    --run)    RUN=1 ;;
    *)        JSON="$arg" ;;
  esac
done

if [ "$RUN" = "1" ]; then
  JSON=$(mktemp /tmp/pw-results-XXXX.json)
  npx playwright test --reporter=json > "$JSON" 2>/dev/null
fi

if [ -z "$JSON" ] || [ ! -s "$JSON" ]; then
  echo "usage: $0 [--update] [--run] <playwright-json>" >&2
  exit 2
fi

python3 - "$JSON" "$BASELINE" "$UPDATE" <<'EOF'
import json, sys

json_path, baseline_path, update = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
d = json.load(open(json_path))

# --- collection 成功 gate (TC-SDK-40 主番人) ---------------------------------
# esbuild 移行のビルド回帰で TS 由来 out/shared/*.js が消えると、それを module-scope
# で require する spec が collection 段階で throw し、Playwright が全収集を中断する
# （Total: 0 tests in 0 files）。この JSON は top-level errors[] に収集エラーを載せ、
# suites は空（= current fail 集合も空）になるため、素朴に diff すると
# `NEW FAILS 0` / `FIXED N`(=baseline 全件) の false-green を出してしまう。
# → 収集エラー(errors[]) 非空 or 収集テスト総数が閾値未満なら COLLECTION FAILED で exit 2。
COLLECTION_MIN = 2500  # 診断ラン実数 collected 2558+ の下限
errors = d.get('errors', []) or []
collected_total = 0
def count_collected(suites):
    global collected_total
    for s in suites:
        for spec in s.get('specs', []):
            collected_total += len(spec.get('tests', []))
        count_collected(s.get('suites', []))
count_collected(d.get('suites', []))

if not update and (len(errors) > 0 or collected_total < COLLECTION_MIN):
    print(f"COLLECTION FAILED — errors: {len(errors)}, collected tests: {collected_total} (min {COLLECTION_MIN})")
    print("  Playwright が全 spec を収集できていない可能性（module-scope require throw 等の collection abort）。")
    print("  NEW FAILS / FIXED は算出しない（false-green を防ぐ）。npm run compile で out/shared の emit を確認せよ。")
    for e in errors[:5]:
        msg = e.get('message') or e.get('value') or str(e)
        print(f"    error: {str(msg).splitlines()[0][:200]}")
    sys.exit(2)

current = set()
def walk(suites):
    for s in suites:
        for spec in s.get('specs', []):
            for t in spec.get('tests', []):
                if t.get('status') == 'unexpected':
                    current.add((s.get('file') or '', spec.get('title') or ''))
        walk(s.get('suites', []))
walk(d.get('suites', []))

try:
    b = json.load(open(baseline_path))
    baseline = set((t['file'], t['title']) for t in b['tests'])
except FileNotFoundError:
    baseline = set()

new_fails = sorted(current - baseline)
fixed = sorted(baseline - current)

if update:
    out = [{"file": f, "title": t} for f, t in sorted(current)]
    json.dump({"note": "pre-existing red baseline. Regenerate with scripts/check-known-red.sh --update <json>",
               "count": len(out), "tests": out},
              open(baseline_path, 'w'), indent=1, ensure_ascii=False)
    print(f"baseline updated: {len(out)} entries ({len(fixed)} removed, {len(new_fails)} added)")
    sys.exit(0)

print(f"current fails: {len(current)} / baseline: {len(baseline)}")
if fixed:
    print(f"\nFIXED ({len(fixed)}) — 基準線から除去してよい (--update):")
    for f, t in fixed: print(f"  {f} :: {t}")
if new_fails:
    print(f"\nNEW FAILS ({len(new_fails)}) — この変更起因。修正が必要:")
    for f, t in new_fails: print(f"  {f} :: {t}")
    sys.exit(1)
print("\nNEW FAILS: 0 — 基準線と一致（この変更起因の fail なし）")
sys.exit(0)
EOF
