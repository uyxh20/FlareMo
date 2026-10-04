#!/bin/sh
# FlareMo harness adapter entry point: install.sh = flaremo init.
# Usage: git clone <repo> && ./harness/install.sh [--dry-run] [--harness zcode,codex,antigravity]
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "flaremo: node is required (any recent LTS). Install Node.js first." >&2
  exit 1
fi

exec node "$(dirname "$0")/../bin/flaremo" init "$@"
