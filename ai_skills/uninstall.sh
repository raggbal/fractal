#!/usr/bin/env bash
# uninstall.sh — install.sh で配置した symlink を全 IDE から削除
#
# install.sh --uninstall の薄い wrapper。
# 引数 (--dry-run / --only ide1,ide2) はそのまま install.sh に転送する。
#
# 使い方:
#   ./uninstall.sh                  # 全 IDE から削除
#   ./uninstall.sh --dry-run        # 何が削除されるか表示するだけ
#   ./uninstall.sh --only claude    # 対象 IDE 絞り込み

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/install.sh" --uninstall "$@"
