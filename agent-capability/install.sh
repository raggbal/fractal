#!/usr/bin/env bash
# install.sh — Fractal の AI 向け機能（MCP サーバー + 使い方の skill）を各 AI IDE に入れる
#
# 依存を入れて（npm ci）bundle を作り（agent-capability/mcp/build.mjs — ADR-0012）、IDE ごとに:
#   - Claude Code: plugin（agent-capability/plugin = MCP + skill）を marketplace（agent-capability）から入れる。
#                  旧来の user scope の登録（claude mcp add fractal）は plugin を入れたあと外す（二重登録で plugin が隠れる）
#   - Codex:       同じ plugin を同じ marketplace から入れる（plugin/plugin.json・mcp.json = Agent Plugins 形式。
#                  Codex は .mcp.json の ${CLAUDE_PLUGIN_ROOT} を展開しないので、Agent Plugins の ${PLUGIN_ROOT} の方を読ませる）
#   - Kiro:        同じ plugin フォルダを Power として入れる（kiro-cli powers install。Kiro は Agent Plugins の plugin.json・mcp.json・skills/ を読む）。
#                  Power は写しなので、MCP を直したら install.sh を流し直す。以前の登録（~/.kiro/settings/mcp.json の fractal と
#                  ~/.kiro/skills/fractal の copy）は残ると tool と skill が二重になるので、毎回外す
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
CAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$CAP_DIR/mcp"
REPO_DIR="$(cd "$CAP_DIR/.." && pwd)"
MCP_SERVER="$MCP_DIR/dist/server.mjs"
PLUGIN_DIR="$CAP_DIR/plugin"
PLUGIN_ID="fractal@fractal-local"
# 以前は skill として配置していたもの（install / uninstall のたびに片付ける）
LEGACY_SKILLS="fractal-structure fractal-search fractal-edit fractal-doctor fractal-summary fractal-mcp collect doc-md pptx-pages-md aws-doc-maker arxiv-md youtube-md web-crawler-md"
# 以前 register-fractal.mjs 用に張っていた symlink
LEGACY_LINK="$HOME/.fractal/fractal-mcp"
IDE_LIST="claude codex kiro antigravity"

ide_parent() {
    case "$1" in
        claude)      echo "$HOME/.claude" ;;
        kiro)        echo "$HOME/.kiro" ;;
        codex)       echo "${CODEX_HOME:-$HOME/.codex}" ;;
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
            sed -n '2,20p' "$0"
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
        echo "  [dry-run] (cd $MCP_DIR && npm ci) && (cd $REPO_DIR && npx tsc -p tsconfig.shared-emit.json && node agent-capability/mcp/build.mjs)"
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        err "npm が無いので fractal-mcp の依存を入れられません"
        return 1
    fi
    (cd "$MCP_DIR" && npm ci --no-fund --no-audit --loglevel=error) || { err "fractal-mcp: npm ci に失敗"; return 1; }
    # bundle（mcp/dist/server.mjs）は生成物。build は out/shared（shared emit）と repo の esbuild を使う
    (cd "$REPO_DIR" && npx tsc -p tsconfig.shared-emit.json && node agent-capability/mcp/build.mjs) || { err "fractal-mcp: bundle の build に失敗（repo で npm install 済みか確認）"; return 1; }
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
            # Claude Code は plugin（MCP + skill）で入れる。marketplace は agent-capability（.claude-plugin/marketplace.json）
            if ! command -v claude >/dev/null 2>&1; then
                warn "  claude CLI が無いので Claude Code の中で: /plugin marketplace add $CAP_DIR → /plugin install $PLUGIN_ID"
                return 0
            fi
            if [ "$DRY_RUN" -eq 1 ]; then
                if [ "$UNINSTALL" -eq 1 ]; then
                    echo "  [dry-run] claude plugin uninstall $PLUGIN_ID; claude plugin marketplace remove fractal-local; claude mcp remove -s user fractal"
                else
                    echo "  [dry-run] claude plugin marketplace add $CAP_DIR; claude plugin install $PLUGIN_ID; claude mcp remove -s user fractal"
                fi
                return 0
            fi
            if [ "$UNINSTALL" -eq 1 ]; then
                claude plugin uninstall "$PLUGIN_ID" >/dev/null 2>&1 && ok "  plugin: $PLUGIN_ID ← 解除" || true
                claude plugin marketplace remove fractal-local >/dev/null 2>&1 || true
                claude mcp remove -s user fractal >/dev/null 2>&1 || true
                return 0
            fi
            claude plugin marketplace add "$CAP_DIR" >/dev/null 2>&1 || claude plugin marketplace update fractal-local >/dev/null 2>&1 || true
            if claude plugin install "$PLUGIN_ID" >/dev/null 2>&1 || claude plugin list 2>/dev/null | grep -q "fractal@fractal-local"; then
                ok "  plugin: $PLUGIN_ID → Claude Code（新しいセッションか /reload-plugins で有効）"
                # 旧来の user scope の登録が残っていると plugin の server が隠れる（同じ endpoint は user が勝つ）
                claude mcp remove -s user fractal >/dev/null 2>&1 && ok "  旧来の user scope の fractal 登録を外した" || true
            else
                err "  plugin のインストールに失敗。Claude Code の中で /plugin marketplace add $CAP_DIR → /plugin install $PLUGIN_ID"
            fi
            ;;
        codex)
            # Codex は Claude Code と同じ plugin・marketplace（Codex は .claude-plugin/marketplace.json も読む）
            if [ "$DRY_RUN" -eq 1 ]; then
                if [ "$UNINSTALL" -eq 1 ]; then
                    echo "  [dry-run] codex plugin remove $PLUGIN_ID; codex plugin marketplace remove fractal-local"
                else
                    echo "  [dry-run] codex plugin marketplace add $CAP_DIR; codex plugin add $PLUGIN_ID"
                fi
                return 0
            fi
            if ! command -v codex >/dev/null 2>&1; then
                [ "$UNINSTALL" -eq 1 ] || warn "  codex CLI が無いので: codex plugin marketplace add $CAP_DIR → codex plugin add $PLUGIN_ID"
                return 0
            fi
            if [ "$UNINSTALL" -eq 1 ]; then
                codex plugin remove "$PLUGIN_ID" >/dev/null 2>&1 && ok "  plugin: $PLUGIN_ID ← 解除 (Codex)" || true
                codex plugin marketplace remove fractal-local >/dev/null 2>&1 || true
                return 0
            fi
            codex plugin marketplace add "$CAP_DIR" >/dev/null 2>&1 || true
            # local の marketplace は add を流し直すと中身（cache の写し）が新しくなる
            if codex plugin add "$PLUGIN_ID" >/dev/null 2>&1; then
                ok "  plugin: $PLUGIN_ID → Codex（新しいセッションで有効）"
            else
                err "  Codex への plugin のインストールに失敗。codex plugin marketplace add $CAP_DIR → codex plugin add $PLUGIN_ID"
            fi
            ;;
        kiro)
            # Kiro は Power（plugin フォルダ）。IDE 1.4.26 以降は CLI で入れた Power も IDE の Installed に出る
            if [ "$DRY_RUN" -eq 1 ]; then
                [ "$UNINSTALL" -eq 1 ] && echo "  [dry-run] kiro-cli powers uninstall fractal" || echo "  [dry-run] kiro-cli powers install $PLUGIN_DIR"
                return 0
            fi
            if ! command -v kiro-cli >/dev/null 2>&1; then
                [ "$UNINSTALL" -eq 1 ] || warn "  kiro-cli が無いので Kiro の Powers パネルで: Add Custom Power → Import power from a folder → $PLUGIN_DIR"
                return 0
            fi
            if [ "$UNINSTALL" -eq 1 ]; then
                kiro-cli powers uninstall fractal >/dev/null 2>&1 && ok "  Power: fractal ← 解除 (Kiro)" || true
                return 0
            fi
            # 同じパスでもう一度 install すると中身を置き換える（Updated power）
            if kiro-cli powers install "$PLUGIN_DIR" >/dev/null 2>&1; then
                ok "  Power: fractal → Kiro（新しい会話で有効）"
            else
                err "  Kiro への Power のインストールに失敗。Kiro の Powers パネルで Add Custom Power → Import power from a folder → $PLUGIN_DIR"
            fi
            ;;
        *)
            [ "$UNINSTALL" -eq 1 ] || dim "  MCP: $ide は自動登録しない。設定するなら command=$node_bin args=[$server]"
            ;;
    esac
}

# 以前の Kiro の登録（~/.kiro/settings/mcp.json の fractal と ~/.kiro/skills/fractal の copy）を外す。Power と二重になるので
# install でも uninstall でも流す。skill は置いてあるものが自分の skill（frontmatter が name: fractal）のときだけ消す
do_kiro_legacy() {
    [ "$1" = "kiro" ] || return 0
    cfg="$HOME/.kiro/settings/mcp.json"
    dest="$HOME/.kiro/skills/fractal"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  [dry-run] $cfg の mcpServers.fractal と ${dest}（以前の登録）を外す"
        return 0
    fi
    if [ -f "$cfg" ] && command -v node >/dev/null 2>&1; then
        [ "$(node "$MCP_DIR/unregister-legacy.mjs" "$cfg")" = "removed" ] && ok "  以前の MCP 登録を外した ($cfg)"
    fi
    if [ -e "$dest" ]; then
        if grep -q '^name: fractal$' "$dest/SKILL.md" 2>/dev/null; then
            rm -rf "$dest" && ok "  以前の skill の copy を外した ($dest)"
        else
            warn "  skill: $dest は Fractal の skill ではないので触らない"
        fi
    fi
}

# ─── メイン ────────────────────────────────────────
echo ""
echo "Fractal agent-capability installer (MCP + skill)"
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
    do_kiro_legacy "$ide" || true
    did_any=1
done

if [ "$did_any" -eq 0 ]; then
    warn "対象 IDE が 1 つも見つかりませんでした"
    exit 1
fi

echo ""
ok "完了"
