#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-data/staged}
mkdir -p "$ROOT"
if [[ ! -f "$ROOT/index.md" ]]; then
  {
    echo "# Archive Index"
    for d in "$ROOT"/r_*; do
      [[ -d "$d" ]] && echo "- [$(basename "$d")]($(basename "$d")/submissions/)"
    done
  } > "$ROOT/index.md"
fi