#!/usr/bin/env bash
# citation-drift 検査（lessons/citation-drift.md の機械化）
#
# 設計・要件・ADR 本文の「引用」が実体と一致しているかを決定論で照合する。
#   検査1: ADR / ADRL の id 参照が .harness/adr/ に実在するか（存在しない番号の引用 = fabricated-cite / drift）
#   検査2: `<file>:<line>` 形式の引用行番号が、その file の現在行数を超えていないか（削除・縮小による drift）
#
# 使い方: scripts/check-citation-drift.sh [--repo <repoRoot>] [--json] [--selftest]
# exit 0=OK / 1=NG / 2=検査不成立（.harness が無い等）
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    --selftest)
      T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
      mkdir -p "$T/.harness/adr" "$T/.harness/design/system" "$T/src"
      printf 'x\n' > "$T/.harness/adr/ADRL-0001-a.md"
      printf 'l1\nl2\nl3\n' > "$T/src/thing.js"
      # test 1 (RED): 実在しない ADR + 行数超過の引用
      printf -- '- 根拠: ADRL-0999\n- 位置: src/thing.js:99\n' > "$T/.harness/design/system/s.md"
      out1="$(bash "$SELF" --repo "$T" 2>&1)"; rc1=$?
      # test 2 (GREEN): 実在 ADR + 範囲内の引用 + fence 内の例示は無視
      printf -- '- 根拠: ADRL-0001\n- 位置: src/thing.js:2\n```\nADRL-0999 / src/thing.js:99\n```\n' > "$T/.harness/design/system/s.md"
      out2="$(bash "$SELF" --repo "$T" 2>&1)"; rc2=$?
      fail=0
      case "$rc1:$out1" in
        1:*未実在ADR参照*ADRL-0999*) ;; *) echo "selftest 1 FAIL (rc=$rc1): $out1"; fail=1 ;;
      esac
      case "$out1" in *引用行超過*thing.js:99*) ;; *) echo "selftest 1 FAIL(行超過を検出せず): $out1"; fail=1 ;; esac
      case "$rc2" in 0) ;; *) echo "selftest 2 FAIL (rc=$rc2): $out2"; fail=1 ;; esac
      [ "$fail" = 0 ] && echo "selftest OK: RED 2 種を検出 / GREEN で 0（fence 内の例示は無視）"
      exit "$fail" ;;
    *) echo "usage: check-citation-drift.sh [--repo <dir>] [--json] [--selftest]" >&2; exit 2 ;;
  esac
done
[ -d "$REPO/.harness" ] || { echo "検査不成立: $REPO/.harness が無い" >&2; exit 2; }
REPO="$REPO" JSON="$JSON" python3 - <<'PY'
import json, os, re, sys, glob
repo = os.environ["REPO"]; as_json = os.environ["JSON"] == "1"
H = os.path.join(repo, ".harness")

docs = []
SKIP = re.compile(r"^(ADR-FORMAT|README|.*TEMPLATE.*)\.md$", re.I)   # 書式テンプレは例示 id を含むので除外
for pat in ("requirement/*.md", "design/*.md", "design/*/*.md", "context/*.md", "adr/*.md"):
    docs += [p for p in sorted(glob.glob(os.path.join(H, pat))) if not SKIP.match(os.path.basename(p))]
if not docs:
    sys.stderr.write("検査不成立: 照合対象の .harness ドキュメントが 0 件\n"); sys.exit(2)

# --- 既知 ADR 番号
known = set()
for p in glob.glob(os.path.join(H, "adr", "*.md")):
    m = re.match(r"(ADRL?-\d{4})", os.path.basename(p))
    if m: known.add(m.group(1))
if not known:
    sys.stderr.write("検査不成立: .harness/adr/ に ADR ファイルが無い\n"); sys.exit(2)

# --- ソース候補（basename -> パス群）
src_by_base = {}
for root, dirs, files in os.walk(repo):
    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "out", "dist", ".harness", "media", "vendor")]
    for f in files:
        if f.endswith((".ts", ".js", ".css", ".html", ".json")):
            src_by_base.setdefault(f, []).append(os.path.relpath(os.path.join(root, f), repo))

lines_cache = {}
def nlines(rel):
    if rel not in lines_cache:
        try:
            with open(os.path.join(repo, rel), "rb") as fh: lines_cache[rel] = fh.read().count(b"\n") + 1
        except OSError: lines_cache[rel] = None
    return lines_cache[rel]

adr_ng, line_ng, ambiguous = [], [], []
CITE = re.compile(r"(?<![\w/.-])((?:[\w.-]+/)*[\w.-]+\.(?:ts|js|css|html)):(\d+)")
for d in docs:
    rel_doc = os.path.relpath(d, repo)
    fence = False
    for i, line in enumerate(open(d, encoding="utf8", errors="replace"), 1):
        if line.lstrip().startswith("```"): fence = not fence; continue
        if fence or line.lstrip().startswith("|--"): continue   # fence 内は例示なので照合しない
        for aid in set(re.findall(r"ADRL?-\d{4}", line)):
            if aid not in known: adr_ng.append((rel_doc, i, aid))
        for path, num in CITE.findall(line):
            num = int(num)
            cand = [path] if os.path.exists(os.path.join(repo, path)) else src_by_base.get(os.path.basename(path), [])
            if len(cand) == 0: continue                       # 外部・生成物・過去の名前 → 不明として無視
            if len(cand) > 1: ambiguous.append((rel_doc, i, path, num)); continue
            n = nlines(cand[0])
            if n is not None and num > n: line_ng.append((rel_doc, i, cand[0], num, n))

if as_json:
    print(json.dumps({"adr_unknown": adr_ng, "line_out_of_range": line_ng, "ambiguous": ambiguous,
                      "docs": len(docs), "adr_known": len(known)}, ensure_ascii=False))
else:
    for doc, i, aid in adr_ng: print(f"NG(未実在ADR参照) {doc}:{i} → {aid}（.harness/adr/ に無い）")
    for doc, i, f, num, n in line_ng: print(f"NG(引用行超過) {doc}:{i} → {f}:{num}（現在 {n} 行）")
    for doc, i, f, num in ambiguous[:10]: print(f"INFO(basename 曖昧) {doc}:{i} → {f}:{num}")
    if not adr_ng and not line_ng:
        print(f"OK: citation-drift なし — doc {len(docs)} 件 / ADR {len(known)} 件 / 曖昧 {len(ambiguous)} 件")
sys.exit(1 if (adr_ng or line_ng) else 0)
PY
