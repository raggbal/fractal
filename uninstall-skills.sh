#!/usr/bin/env bash
#
# uninstall-skills.sh — Fractal Claude Skills アンインストーラ
#
# install-skills.sh で設置したものだけを削除する（安全のため他人が置いた同名ファイルは触らない）。
#
# Usage:
#   ./uninstall-skills.sh                       # user-global から削除
#   ./uninstall-skills.sh --project PATH        # project-local から削除
#   ./uninstall-skills.sh --force               # copy モードで置かれたものも削除（中身未検証）
#   ./uninstall-skills.sh --dry-run             # 何を削除するかだけ表示
#   ./uninstall-skills.sh -h | --help
#

set -euo pipefail

TARGET_MODE="user"
PROJECT_DIR=""
FORCE="no"
DRY_RUN="no"

SKILLS=(fractal-structure fractal-search fractal-edit)
# Legacy skill names (previous install may have left these)
LEGACY_SKILLS=(fractal-md)
RULE_FILE="fractal-skills.md"

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
        --force)
            FORCE="yes"
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

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$TARGET_MODE" == "user" ]]; then
    DEST_SKILLS_DIR="$HOME/.claude/skills"
    DEST_RULES_DIR="$HOME/.claude/rules"
else
    if [[ -z "$PROJECT_DIR" ]]; then
        echo "Error: --project requires a path" >&2
        exit 1
    fi
    DEST_SKILLS_DIR="$(cd "$PROJECT_DIR" && pwd)/.claude/skills"
    DEST_RULES_DIR="$(cd "$PROJECT_DIR" && pwd)/.claude/rules"
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
    local p="$1"
    [[ -L "$p" ]] || return 1
    local resolved
    resolved="$(readlink "$p")" || return 1
    case "$resolved" in
        "$REPO_DIR"/*) return 0 ;;
        *) return 1 ;;
    esac
}

remove_skill() {
    local skill="$1"
    local dest="$DEST_SKILLS_DIR/$skill"

    if [[ ! -e "$dest" && ! -L "$dest" ]]; then
        echo "  . $skill (not installed)"
        return 0
    fi

    if is_our_symlink "$dest"; then
        run "rm -f \"$dest\""
        echo "  - $skill (symlink removed)"
        return 0
    fi

    if [[ "$FORCE" == "yes" ]]; then
        run "rm -rf \"$dest\""
        echo "  - $skill (force-removed — was copy or foreign symlink)"
    else
        echo "  ⚠  $skill: destination is not our symlink — leaving alone"
        echo "     ($dest)"
        echo "     Use --force to remove anyway."
    fi
}

remove_rules() {
    local dest="$DEST_RULES_DIR/$RULE_FILE"

    if [[ ! -e "$dest" && ! -L "$dest" ]]; then
        echo "  . rules/$RULE_FILE (not installed)"
        return 0
    fi

    if is_our_symlink "$dest"; then
        run "rm -f \"$dest\""
        echo "  - rules/$RULE_FILE (symlink removed)"
        return 0
    fi

    if [[ "$FORCE" == "yes" ]]; then
        run "rm -f \"$dest\""
        echo "  - rules/$RULE_FILE (force-removed)"
    else
        echo "  ⚠  rules/$RULE_FILE: not our symlink — leaving alone"
        echo "     ($dest)"
        echo "     Use --force to remove anyway."
    fi
}

# ─── execute ───
echo "=== Fractal Claude Skills Uninstall ==="
echo "  target   : $TARGET_MODE  ($DEST_SKILLS_DIR)"
echo "  force    : $FORCE"
echo "  dry-run  : $DRY_RUN"
echo ""

echo "Removing skills:"
for skill in "${SKILLS[@]}"; do
    remove_skill "$skill"
done

for legacy in "${LEGACY_SKILLS[@]}"; do
    remove_skill "$legacy"
done

echo ""
echo "Removing rules:"
remove_rules

echo ""
if [[ "$DRY_RUN" == "yes" ]]; then
    echo "✅ Dry-run complete. Re-run without --dry-run to apply."
else
    echo "✅ Uninstalled."
fi
