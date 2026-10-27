#!/usr/bin/env bash
# install.sh — fractal MCP サーバー（mcp/server.mjs を bundle した mcp/dist/server.mjs）を作って各 AI IDE に登録する
#
# 依存を入れて（npm ci）bundle を作り（npm run build:mcp — ADR-0012）、各 IDE の MCP 設定に repo の mcp/dist/server.mjs を登録する:
#   - Claude Code: claude mcp add -s user fractal（claude CLI があるとき）
#   - Kiro:        ~/.kiro/settings/mcp.json
#   - Cursor:      ~/.cursor/mcp.json
#   - Antigravity: 自動登録しない（表示するコマンドを手で設定）
#
# 以前 ai_skills/install.sh が配置していた skill（今は無い）と ~/.fractal/fractal-mcp の symlink は毎回片付ける。
#
# 使い方:
#   ./install.sh                  # 検出した全 IDE に登録
#   ./install.sh --dry-run        # 何をするか表示するだけ
#   ./install.sh --uninstall      # 登録を解除
#   ./install.sh --only claude,kiro  # 対象 IDE を絞る (カンマ区切り)
#
# bash 3.2 (macOS 標準) 互換 — 連想配列を使わない

set -eu

# ─── 設定 ─────────────────────────────────────────────
MCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$MCP_DIR/.." && pwd)"
MCP_SERVER="$MCP_DIR/dist/server.mjs"
# 以前は skill として配置していたもの（install / uninstall のたびに片付ける）
LEGACY_SKILLS="fractal-structure fractal-search fractal-edit fractal-doctor fractal-summary fractal-mcp collect doc-md pptx-pages-md aws-doc-maker arxiv-md youtube-md web-crawler-md"
# 以前 register-fractal.mjs 用に張っていた symlink
LEGACY_LINK="$HOME/.fractal/fractal-mcp"
IDE_LIST="claude cursor kiro antigravity"

ide_parent() {
    case "$1" in
        claude)      echo "$HOME/.claude" ;;
        cursor)      echo "$HOME/.cursor" ;;
        kiro)        echo "$HOME/.kiro" ;;
        antigravity) echo "$HOME/.antigravity" ;;
        *) return 1 ;;
    esac
}

# ─── 引数 ─────────────────────────────────────────────
DRY_RUN=0
UNINSTALL=0
ONLY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)   DRY_RUN=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --only)      ONLY="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# ─── 色 / ログ ──────────────────────────────────────
if [ -t 1 ]; then
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
    C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RST=""
fi
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RST" "$*"; }
warn() { printf '%s⚠%s %s\n' "$C_WARN" "$C_RST" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_RST" "$*" >&2; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RST"; }

# ─── 対象 IDE 絞り込み ──────────────────────────────
if [ -n "$ONLY" ]; then
    TARGETS=$(echo "$ONLY" | tr ',' ' ')
    for ide in $TARGETS; do
        if ! ide_parent "$ide" >/dev/null 2>&1; then
            err "Unknown IDE: $ide  (有効: $IDE_LIST)"
            exit 1
        fi
    done
else
    TARGETS="$IDE_LIST"
fi

# ─── 旧 skill の片付け ──────────────────────────────
# symlink は repo 内（旧 ai_skills/ を含む）を指すものだけ消す。Kiro は copy 配置だったので、
# 旧 skill の script（register-fractal.mjs / collect の list-default-outs.mjs）を持つ dir だけ消す
do_legacy_cleanup() {
    ide=$1; skill=$2
    dest="$(ide_parent "$ide")/skills/$skill"
    if [ -L "$dest" ]; then
        case "$(readlink "$dest")" in
            "$REPO_DIR"/*) ;;
            *) return 0 ;;
        esac
        [ "$DRY_RUN" -eq 1 ] && { echo "  [dry-run] rm $dest (旧 skill)"; return 0; }
        rm "$dest" && ok "  $skill ← 旧 skill を削除 ($dest)"
    elif [ "$ide" = "kiro" ] && [ -d "$dest" ]; then
        case "$skill" in
            fractal-*) ;;
            *) [ -f "$dest/scripts/register-fractal.mjs" ] || [ -f "$dest/scripts/list-default-outs.mjs" ] || return 0 ;;
        esac
        [ "$DRY_RUN" -eq 1 ] && { echo "  [dry-run] rm -rf $dest (旧 skill の copy)"; return 0; }
        rm -rf "$dest" && ok "  $skill ← 旧 skill を削除 ($dest)"
    fi
}

# ─── 依存の導入 ─────────────────────────────────────
prepare_mcp() {
    if [ -L "$LEGACY_LINK" ]; then
        if [ "$DRY_RUN" -eq 1 ]; then
            echo "  [dry-run] rm $LEGACY_LINK"
        else
            rm "$LEGACY_LINK" && ok "$LEGACY_LINK を削除（旧 skill 用）"
            rmdir "$(dirname "$LEGACY_LINK")" 2>/dev/null || true
        fi
    fi
    [ "$UNINSTALL" -eq 1 ] && return 0
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  [dry-run] (cd $MCP_DIR && npm ci) && (cd $REPO_DIR && npx tsc -p tsconfig.shared-emit.json && node mcp/build.mjs)"
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        err "npm が無いので fractal-mcp の依存を入れられません"
        return 1
    fi
    (cd "$MCP_DIR" && npm ci --no-fund --no-audit --loglevel=error) || { err "fractal-mcp: npm ci に失敗"; return 1; }
    # bundle（mcp/dist/server.mjs）は生成物。build は out/shared（shared emit）と repo の esbuild を使う
    (cd "$REPO_DIR" && npx tsc -p tsconfig.shared-emit.json && node mcp/build.mjs) || { err "fractal-mcp: bundle の build に失敗（repo で npm install 済みか確認）"; return 1; }
    [ -f "$MCP_SERVER" ] || { err "fractal-mcp: $MCP_SERVER がありません"; return 1; }
    ok "fractal-mcp → 依存を導入 ($MCP_DIR)"
}

# fractal-mcp の登録 / 解除（server は repo の mcp/dist/server.mjs を起動）
do_mcp_one() {
    ide=$1
    server="$MCP_SERVER"
    # mise 等の版つきパスは node の更新で消えるので、shim があればそちらを登録する
    node_bin=$(command -v node || true)
    case "$node_bin" in */mise/installs/*) [ -x "$HOME/.local/share/mise/shims/node" ] && node_bin="$HOME/.local/share/mise/shims/node" ;; esac
    if [ -z "$node_bin" ]; then
        warn "  MCP: node が見つからないので登録をスキップ"
        return 0
    fi
    case "$ide" in
        claude)
            if ! command -v claude >/dev/null 2>&1; then
                warn "  MCP: claude CLI が無いので手で登録: claude mcp add -s user fractal -- $node_bin $server"
                return 0
            fi
            if [ "$DRY_RUN" -eq 1 ]; then
                echo "  [dry-run] claude mcp $([ "$UNINSTALL" -eq 1 ] && echo "remove -s user fractal" || echo "add -s user fractal -- $node_bin $server")"
                return 0
            fi
            claude mcp remove -s user fractal >/dev/null 2>&1 || true
            [ "$UNINSTALL" -eq 1 ] && { ok "  MCP: fractal ← 解除"; return 0; }
            claude mcp add -s user fractal -- "$node_bin" "$server" >/dev/null
            ok "  MCP: fractal → claude (user scope)"
            ;;
        kiro|cursor)
            cfg="$(ide_parent "$ide")/mcp.json"
            [ "$ide" = "kiro" ] && cfg="$HOME/.kiro/settings/mcp.json"
            if [ "$DRY_RUN" -eq 1 ]; then
                echo "  [dry-run] $cfg の mcpServers.fractal を$([ "$UNINSTALL" -eq 1 ] && echo 削除 || echo "設定 ($server)")"
                return 0
            fi
            if [ "$UNINSTALL" -eq 1 ]; then
                "$node_bin" "$MCP_DIR/register.mjs" "$cfg" --remove && ok "  MCP: fractal ← 解除 ($cfg)"
            else
                "$node_bin" "$MCP_DIR/register.mjs" "$cfg" "$server" --node "$node_bin" && ok "  MCP: fractal → $cfg"
            fi
            ;;
        *)
            [ "$UNINSTALL" -eq 1 ] || dim "  MCP: $ide は自動登録しない。設定するなら command=$node_bin args=[$server]"
            ;;
    esac
}

# ─── メイン ────────────────────────────────────────
echo ""
echo "Fractal MCP installer"
echo "  server: $MCP_SERVER"
_mode=$([ "$UNINSTALL" -eq 1 ] && echo uninstall || echo install)
_suffix=$([ "$DRY_RUN" -eq 1 ] && echo ' (dry-run)' || true)
echo "  mode:   ${_mode}${_suffix}"
echo ""

prepare_mcp || exit 1
echo ""

did_any=0
for ide in $TARGETS; do
    parent=$(ide_parent "$ide")
    if [ ! -d "$parent" ]; then
        dim "─ $ide: parent dir ($parent) が無いのでスキップ"
        continue
    fi
    echo "─ $ide"
    for legacy in $LEGACY_SKILLS; do
        do_legacy_cleanup "$ide" "$legacy" || true
    done
    do_mcp_one "$ide" || true
    did_any=1
done

if [ "$did_any" -eq 0 ]; then
    warn "対象 IDE が 1 つも見つかりませんでした"
    exit 1
fi

echo ""
ok "完了"
