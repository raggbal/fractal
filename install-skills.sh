#!/usr/bin/env bash
#
# install-skills.sh — Fractal Claude Skills インストーラ
#
# デフォルト: user-global install (~/.claude/skills/fractal-*, ~/.claude/rules/fractal-skills.md)
# symlink で設置（repo 側の修正が即反映）
#
# Usage:
#   ./install-skills.sh                       # user-global, symlink, rules 有
#   ./install-skills.sh --project PATH        # project-local install
#   ./install-skills.sh --mode copy           # symlink ではなく copy
#   ./install-skills.sh --no-rules            # rules 配置をスキップ
#   ./install-skills.sh --dry-run             # 何をするかだけ表示
#   ./install-skills.sh -h | --help
#

set -euo pipefail

# ─── defaults ───
TARGET_MODE="user"          # user | project
PROJECT_DIR=""
LINK_MODE="link"            # link | copy
INSTALL_RULES="yes"
DRY_RUN="no"

SKILLS=(fractal-structure fractal-search fractal-edit)
# Legacy skill names that were merged into fractal-edit (cleanup only — never installed)
LEGACY_SKILLS=(fractal-md)
RULE_FILE="fractal-skills.md"

# ─── arg parse ───
usage() {
    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)
            TARGET_MODE="project"
            PROJECT_DIR="${2:?--project requires a path}"
            shift 2
            ;;
        --mode)
            LINK_MODE="${2:?--mode requires link|copy}"
            case "$LINK_MODE" in link|copy) ;; *) echo "Error: --mode must be link or copy" >&2; exit 1 ;; esac
            shift 2
            ;;
        --no-rules)
            INSTALL_RULES="no"
            shift
            ;;
        --dry-run)
            DRY_RUN="yes"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Error: unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# ─── paths ───
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_SKILLS_DIR="$REPO_DIR/claude_skills"
SRC_RULES_FILE="$REPO_DIR/rules/$RULE_FILE"

if [[ "$TARGET_MODE" == "user" ]]; then
    DEST_SKILLS_DIR="$HOME/.claude/skills"
    DEST_RULES_DIR="$HOME/.claude/rules"
else
    # project-local
    if [[ -z "$PROJECT_DIR" ]]; then
        echo "Error: --project requires a path" >&2
        exit 1
    fi
    if [[ ! -d "$PROJECT_DIR" ]]; then
        echo "Error: project directory not found: $PROJECT_DIR" >&2
        exit 1
    fi
    DEST_SKILLS_DIR="$(cd "$PROJECT_DIR" && pwd)/.claude/skills"
    DEST_RULES_DIR="$(cd "$PROJECT_DIR" && pwd)/.claude/rules"
fi

# ─── preflight ───
for skill in "${SKILLS[@]}"; do
    if [[ ! -d "$SRC_SKILLS_DIR/$skill" ]]; then
        echo "Error: source skill not found: $SRC_SKILLS_DIR/$skill" >&2
        exit 1
    fi
done

if [[ "$INSTALL_RULES" == "yes" && ! -f "$SRC_RULES_FILE" ]]; then
    echo "Error: rules file not found: $SRC_RULES_FILE" >&2
    exit 1
fi

# ─── helpers ───
run() {
    if [[ "$DRY_RUN" == "yes" ]]; then
        echo "  [dry-run] $*"
    else
        eval "$@"
    fi
}

is_our_symlink() {
    # 対象 path が symlink かつ、repo 内を指しているなら true
    local p="$1"
    [[ -L "$p" ]] || return 1
    local resolved
    resolved="$(readlink "$p")" || return 1
    case "$resolved" in
        "$REPO_DIR"/*) return 0 ;;
        *) return 1 ;;
    esac
}

install_skill() {
    local skill="$1"
    local src="$SRC_SKILLS_DIR/$skill"
    local dest="$DEST_SKILLS_DIR/$skill"

    if [[ -e "$dest" || -L "$dest" ]]; then
        if is_our_symlink "$dest"; then
            echo "  ~ $skill (already linked to this repo, refreshing)"
            run "rm -f \"$dest\""
        else
            echo "  ⚠  $skill: destination exists and is not our symlink — skipping"
            echo "     ($dest)"
            echo "     Remove manually if you want to reinstall."
            return 0
        fi
    fi

    if [[ "$LINK_MODE" == "link" ]]; then
        run "ln -s \"$src\" \"$dest\""
        echo "  + $skill  (symlink → $src)"
    else
        run "cp -R \"$src\" \"$dest\""
        echo "  + $skill  (copied)"
    fi
}

install_rules() {
    local src="$SRC_RULES_FILE"
    local dest="$DEST_RULES_DIR/$RULE_FILE"

    if [[ -e "$dest" || -L "$dest" ]]; then
        if is_our_symlink "$dest"; then
            echo "  ~ rules/$RULE_FILE (already linked to this repo, refreshing)"
            run "rm -f \"$dest\""
        else
            echo "  ⚠  rules/$RULE_FILE: destination exists and is not our symlink — skipping"
            echo "     ($dest)"
            return 0
        fi
    fi

    if [[ "$LINK_MODE" == "link" ]]; then
        run "ln -s \"$src\" \"$dest\""
        echo "  + rules/$RULE_FILE  (symlink → $src)"
    else
        run "cp \"$src\" \"$dest\""
        echo "  + rules/$RULE_FILE  (copied)"
    fi
}

# ─── execute ───
echo "=== Fractal Claude Skills Install ==="
echo "  target   : $TARGET_MODE  ($DEST_SKILLS_DIR)"
echo "  mode     : $LINK_MODE"
echo "  rules    : $INSTALL_RULES  ($DEST_RULES_DIR/$RULE_FILE)"
echo "  dry-run  : $DRY_RUN"
echo ""

run "mkdir -p \"$DEST_SKILLS_DIR\""
if [[ "$INSTALL_RULES" == "yes" ]]; then
    run "mkdir -p \"$DEST_RULES_DIR\""
fi

echo "Installing skills:"
for skill in "${SKILLS[@]}"; do
    install_skill "$skill"
done

# Cleanup legacy skills (e.g. fractal-md was merged into fractal-edit)
for legacy in "${LEGACY_SKILLS[@]}"; do
    dest="$DEST_SKILLS_DIR/$legacy"
    if [[ -L "$dest" ]] && is_our_symlink "$dest"; then
        run "rm -f \"$dest\""
        echo "  - $legacy (legacy, removed our old symlink)"
    elif [[ -e "$dest" ]]; then
        echo "  ⚠  $legacy (legacy): $dest exists and is not our symlink — leaving alone"
    fi
done

if [[ "$INSTALL_RULES" == "yes" ]]; then
    echo ""
    echo "Installing rules:"
    install_rules
fi

echo ""
if [[ "$DRY_RUN" == "yes" ]]; then
    echo "✅ Dry-run complete. Re-run without --dry-run to apply."
else
    echo "✅ Installed. Start a new Claude Code session to pick up the changes."
    if [[ "$LINK_MODE" == "link" ]]; then
        echo "   (symlink mode — edits in $REPO_DIR are reflected immediately)"
    fi
fi
