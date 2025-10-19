#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-data/raw}
SUBS=${2:-configs/subreddits.txt}
DAYS=${DAYS:-7}
MIN_COMMENTS=${MIN_COMMENTS:-1}
FORCE=${FORCE:-}
: "${REDDIT_CLIENT_ID:?REDDIT_CLIENT_ID not set}"
: "${REDDIT_CLIENT_SECRET:?REDDIT_CLIENT_SECRET not set}"
: "${REDDIT_USER_AGENT:?REDDIT_USER_AGENT not set}"
if [[ ! -f "$SUBS" ]]; then
  echo "[comments] subs file not found: $SUBS" >&2
  exit 1
fi
readarray -t arr < <(sed -e 's/\r$//' "$SUBS" | sed '/^\s*#/d;/^\s*$/d' | tr '[:upper:]' '[:lower:]')
idx=0; errs=0; total=${#arr[@]}
for s in "${arr[@]}"; do
  idx=$((idx+1))
  echo "[comments] ($idx/$total) sub=$s days=$DAYS start"
  if ! DAYS="$DAYS" go run ./cmd/comments -sub "$s" -days "${DAYS}" -root "$ROOT" -min-comments "${MIN_COMMENTS}" ${FORCE:+-force}; then
    echo "[comments] ($idx/$total) sub=$s failed" >&2
    errs=$((errs+1))
    continue
  fi
  echo "[comments] ($idx/$total) sub=$s done"
done
if [[ $errs -gt 0 ]]; then
  echo "[comments] completed with $errs errors" >&2
else
  echo "[comments] all done subs=$total"
fi
