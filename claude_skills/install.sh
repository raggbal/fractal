#!/usr/bin/env bash
# install.sh — Fractal claude_skills を各 AI IDE の user-level skill 領域に配置
#
# 配置方式は IDE ごとに自動選択:
#   - symlink: claude / cursor / antigravity  (source 直リンク・更新即反映)
#   - copy:    kiro                            (Kiro が symlink 経由のスキルを認識しないため)
#
# 対応 IDE (それぞれ user dir があれば install):
#   - Claude Code:  ~/.claude/skills/         (symlink)
#   - Cursor:       ~/.cursor/skills/         (symlink)
#   - Kiro:         ~/.kiro/skills/           (copy — 上書き)
#   - Antigravity:  ~/.antigravity/skills/    (symlink)
#
# 使い方:
#   ./install.sh                  # 検出した全 IDE に配置 (kiro は毎回 copy 上書き)
#   ./install.sh --dry-run        # 何をするか表示するだけ
#   ./install.sh --uninstall      # 配置済みスキルを削除
#   ./install.sh --force          # symlink 用: 既存の非 symlink を上書き (copy 方式は常に上書き)
#   ./install.sh --only claude,kiro  # 対象 IDE を絞る (カンマ区切り)
#
# bash 3.2 (macOS 標準) 互換 — 連想配列を使わない

set -eu

# ─── 設定 ─────────────────────────────────────────────
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS="fractal-structure fractal-search fractal-edit collect web-crawler-md youtube-md doc-md pptx-pages-md arxiv-md aws-doc-maker"
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
ide_dir() {
    case "$1" in
        claude)      echo "$HOME/.claude/skills" ;;
        cursor)      echo "$HOME/.cursor/skills" ;;
        kiro)        echo "$HOME/.kiro/skills" ;;
        antigravity) echo "$HOME/.antigravity/skills" ;;
        *) return 1 ;;
    esac
}
ide_method() {
    # symlink | copy
    case "$1" in
        kiro) echo "copy" ;;
        *)    echo "symlink" ;;
    esac
}

# ─── 引数 ─────────────────────────────────────────────
DRY_RUN=0
UNINSTALL=0
FORCE=0
ONLY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)   DRY_RUN=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --force)     FORCE=1; shift ;;
        --only)      ONLY="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,15p' "$0"
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

# ─── 共通操作 ───────────────────────────────────────
do_install_one() {
    ide=$1; skill=$2
    src="$SOURCE_DIR/$skill"
    dest_dir=$(ide_dir "$ide")
    dest="$dest_dir/$skill"
    method=$(ide_method "$ide")

    if [ ! -d "$src" ]; then
        err "source skill missing: $src"
        return 1
    fi

    if [ "$method" = "copy" ]; then
        if [ "$DRY_RUN" -eq 1 ]; then
            echo "  [dry-run] mkdir -p $dest_dir"
            echo "  [dry-run] rm -rf $dest && cp -R $src $dest  (copy mode: always overwrite)"
            return 0
        fi

        mkdir -p "$dest_dir"
        if [ -e "$dest" ] || [ -L "$dest" ]; then
            rm -rf "$dest"
        fi
        cp -R "$src" "$dest"
        ok "  $skill → $dest (copy)"
        return 0
    fi

    # method = symlink
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  [dry-run] mkdir -p $dest_dir"
        echo "  [dry-run] ln -sfn $src $dest"
        return 0
    fi

    mkdir -p "$dest_dir"

    if [ -L "$dest" ]; then
        current=$(readlink "$dest")
        if [ "$current" = "$src" ]; then
            dim "  $skill → 既に最新 symlink"
            return 0
        fi
        rm "$dest"
    elif [ -e "$dest" ]; then
        if [ "$FORCE" -eq 1 ]; then
            warn "  $skill → 既存 (非 symlink) を削除して上書き ($dest)"
            rm -rf "$dest"
        else
            err "  $skill → 既存 (非 symlink) があり --force なしのためスキップ ($dest)"
            return 1
        fi
    fi

    ln -s "$src" "$dest"
    ok "  $skill → $dest"
}

do_uninstall_one() {
    ide=$1; skill=$2
    dest="$(ide_dir "$ide")/$skill"
    method=$(ide_method "$ide")

    if [ "$DRY_RUN" -eq 1 ]; then
        if [ "$method" = "copy" ]; then
            echo "  [dry-run] rm -rf $dest (copy mode: 中身に関わらず削除)"
        else
            echo "  [dry-run] rm $dest (if symlink to $SOURCE_DIR/$skill)"
        fi
        return 0
    fi

    if [ "$method" = "copy" ]; then
        if [ -L "$dest" ]; then
            rm "$dest"
            ok "  $skill ← 削除 ($dest, symlink)"
        elif [ -d "$dest" ]; then
            rm -rf "$dest"
            ok "  $skill ← 削除 ($dest, copy)"
        elif [ -e "$dest" ]; then
            warn "  $skill ← 想定外 (file) なのでスキップ ($dest)"
        else
            dim "  $skill ← 未 install"
        fi
        return 0
    fi

    # method = symlink
    if [ -L "$dest" ]; then
        current=$(readlink "$dest")
        if [ "$current" = "$SOURCE_DIR/$skill" ]; then
            rm "$dest"
            ok "  $skill ← 削除 ($dest)"
        else
            warn "  $skill ← symlink だが別 source を指しているのでスキップ ($dest → $current)"
        fi
    elif [ -e "$dest" ]; then
        warn "  $skill ← 非 symlink が存在するのでスキップ ($dest)"
    else
        dim "  $skill ← 未 install"
    fi
}

# ─── メイン ────────────────────────────────────────
echo ""
echo "Fractal claude_skills installer"
echo "  source: $SOURCE_DIR"
echo "  skills: $SKILLS"
_mode=$([ "$UNINSTALL" -eq 1 ] && echo uninstall || echo install)
_suffix=$([ "$DRY_RUN" -eq 1 ] && echo ' (dry-run)' || true)
echo "  mode:   ${_mode}${_suffix}"
echo ""

did_any=0
for ide in $TARGETS; do
    parent=$(ide_parent "$ide")
    dest_dir=$(ide_dir "$ide")

    if [ ! -d "$parent" ]; then
        dim "─ $ide: parent dir ($parent) が無いのでスキップ"
        continue
    fi

    echo "─ $ide  →  $dest_dir  [$(ide_method "$ide")]"
    for skill in $SKILLS; do
        if [ "$UNINSTALL" -eq 1 ]; then
            do_uninstall_one "$ide" "$skill" || true
        else
            do_install_one "$ide" "$skill" || true
        fi
    done
    did_any=1
done

if [ "$did_any" -eq 0 ]; then
    warn "対象 IDE が 1 つも見つかりませんでした"
    exit 1
fi

echo ""
ok "完了"
