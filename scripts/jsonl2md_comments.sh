#!/usr/bin/env bash
set -euo pipefail
IN_ROOT=${1:-data/raw}
OUT_ROOT=${2:-data/staged}
DAYS=${GEN_RECENT:-64}
python3 scripts/comments_jsonl2md.py "$IN_ROOT" "$OUT_ROOT" --days "$DAYS"
