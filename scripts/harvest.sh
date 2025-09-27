#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:-data/raw}
SUBS=${2:-configs/subreddits.txt}
DAYS=${DAYS:-7}

: "${REDDIT_CLIENT_ID:?REDDIT_CLIENT_ID not set}"
: "${REDDIT_CLIENT_SECRET:?REDDIT_CLIENT_SECRET not set}"
: "${REDDIT_USER_AGENT:?REDDIT_USER_AGENT not set}"

if [[ ! -f "$SUBS" ]]; then
  echo "[harvest] subs file not found: $SUBS" >&2
  exit 1
fi

readarray -t arr < <(sed -e 's/\r$//' "$SUBS" | sed '/^\s*#/d;/^\s*$/d')
TOTAL=${#arr[@]}
if [[ $TOTAL -eq 0 ]]; then
  echo "[harvest] no subreddits in $SUBS" >&2
  exit 1
fi

errs=0
idx=0
for s in "${arr[@]}"; do
  idx=$((idx+1))
  echo "[harvest] ($idx/$TOTAL) sub=$s days=$DAYS start"
  if ! DAYS="$DAYS" go run ./cmd/harvest -sub "$s" -days "$DAYS" -root "$ROOT"; then
    echo "[harvest] ($idx/$TOTAL) sub=$s failed" >&2
    errs=$((errs+1))
    continue
  fi
  echo "[harvest] ($idx/$TOTAL) sub=$s done"
done

if [[ $errs -gt 0 ]]; then
  echo "[harvest] completed with $errs errors" >&2
else
  echo "[harvest] all done subs=$TOTAL"
fi
