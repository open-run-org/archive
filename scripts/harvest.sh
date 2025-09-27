#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-data/raw}
SUBS=${2:-configs/subreddits.txt}
DAYS=${DAYS:-7}
TOTAL=0
readarray -t arr < <(sed -e 's/\r$//' "$SUBS" | grep -v '^\s*#' | sed '/^\s*$/d')
for s in "${arr[@]}"; do
  echo "[harvest] sub=$s days=$DAYS start"
  go run ./cmd/harvest -sub "$s" -days "$DAYS" -root "$ROOT"
  echo "[harvest] sub=$s done"
  TOTAL=$((TOTAL+1))
done
echo "[harvest] all done subs=$TOTAL"
