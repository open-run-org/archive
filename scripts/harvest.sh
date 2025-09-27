#!/usr/bin/env bash
set -euo pipefail
DATE=$(date +%F)
OUT_ROOT=${1:-data}
SUBFILE=${2:-configs/subreddits.txt}
while IFS= read -r sub; do
  [ -z "$sub" ] && continue
  OUTDIR="$OUT_ROOT/$DATE/r_${sub}"
  mkdir -p "$OUTDIR"
  go run ./cmd/harvester -sub "$sub" -out "$OUTDIR/top_day.jsonl"
done < "$SUBFILE"