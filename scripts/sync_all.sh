#!/usr/bin/env bash
set -euo pipefail
DATE=$(date +%F)
OUT_ROOT=${1:-data}
SUBFILE=${2:-configs/subreddits.txt}
SINCE_DAYS=${SINCE_DAYS:-365}
MAX_POSTS=${MAX_POSTS:-0}
PAGE_LIMIT=${PAGE_LIMIT:-100}
while IFS= read -r sub; do
  [ -z "$sub" ] && continue
  OUTDIR="$OUT_ROOT/$DATE/r_${sub}"
  mkdir -p "$OUTDIR"
  go run ./cmd/sync -sub "$sub" -out "$OUTDIR/new_since.jsonl" -since-days "$SINCE_DAYS" -max "$MAX_POSTS" -limit "$PAGE_LIMIT"
done < "$SUBFILE"