#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then echo "[md] missing jq" >&2; exit 127; fi
if ! command -v pandoc >/dev/null 2>&1; then echo "[md] missing pandoc" >&2; exit 127; fi

IN_ROOT=${1:-data/raw}
OUT_ROOT=${2:-data/staged}

mapfile -t files < <(find "$IN_ROOT" -type f -path "$IN_ROOT/r_*/submissions/*/*.jsonl" | sort)
TOTAL=${#files[@]}
if [[ $TOTAL -eq 0 ]]; then echo "[md] no input jsonl under $IN_ROOT"; exit 0; fi

i=0
for f in "${files[@]}"; do
  i=$((i+1))
  line=$(sed -n '1p' "$f")
  if [[ -z "$line" ]]; then printf "\r[%d/%d] skip empty %s\n" "$i" "$TOTAL" "$f"; continue; fi

  subdir=$(basename "$(dirname "$(dirname "$(dirname "$f")")")")
  created_id=$(basename "$(dirname "$f")")
  cap_hash=$(basename "$f"); cap_hash=${cap_hash%.jsonl}
  capture_ts=${cap_hash%%_*}; content_hash=${cap_hash#*_}

  out_dir="$OUT_ROOT/$subdir/submissions/$created_id"
  out_file="$out_dir/${capture_ts}_${content_hash}.md"
  mkdir -p "$out_dir"
  if [[ -f "$out_file" ]]; then printf "\r[%d/%d] skip exists %s -> %s" "$i" "$TOTAL" "$f" "$out_file"; continue; fi

  title=$(jq -r '.title // ""' <<<"$line")
  author=$(jq -r '.author // ""' <<<"$line")
  created=$(jq -r '.created_utc | floor' <<<"$line")
  permalink=$(jq -r '.permalink // ""' <<<"$line")
  url=$(jq -r '.url // ""' <<<"$line")
  domain=$(jq -r '.domain // ""' <<<"$line")
  ups=$(jq -r '.ups // 0' <<<"$line")
  upvote_ratio=$(jq -r '.upvote_ratio // empty' <<<"$line")
  num_comments=$(jq -r '.num_comments // 0' <<<"$line")
  link_flair_text=$(jq -r '.link_flair_text // ""' <<<"$line")
  link_flair_css_class=$(jq -r '.link_flair_css_class // ""' <<<"$line")
  over_18=$(jq -r '.over_18 // false' <<<"$line")
  is_self=$(jq -r '.is_self // false' <<<"$line")
  sub_pref=$(jq -r '.subreddit_name_prefixed // ""' <<<"$line")
  id=$(jq -r '.id // empty' <<<"$line")
  name=$(jq -r '.name // empty' <<<"$line")

  ts_created=$(date -u -d "@$created" +%y%m%d%H%M%S)

  html=$(jq -r '.selftext_html // ""' <<<"$line")
  if [[ -n "$html" && "$html" != "null" ]]; then
    body=$(
      printf "%s" "$html" \
      | sed -E ':a;N;$!ba;s/<!--[[:space:]]*SC_OFF[[:space:]]*-->//g;s/<!--[[:space:]]*SC_ON[[:space:]]*-->//g' \
      | sed -E ':a;N;$!ba;s/^[[:space:]]*<div class="md">[[:space:]]*//; s:[[:space:]]*</div>[[:space:]]*$::' \
      | pandoc -f html -t gfm
    )
  else
    body=$(jq -r '.selftext // ""' <<<"$line")
  fi

  safe_title=${title//$'\r'/}; safe_title=${safe_title//$'\n'/ }; safe_title=${safe_title//\"/\\\"}

  tmp="${out_file}.tmp"
  {
    echo "---"
    echo "title: \"$safe_title\""
    echo "subreddit: \"$sub_pref\""
    echo "id: \"$id\""
    echo "name: \"$name\""
    echo "author: \"$author\""
    echo "created_utc: $created"
    echo "created_key: \"$ts_created\""
    echo "capture_ts: \"$capture_ts\""
    echo "content_sha256: \"$content_hash\""
    echo "permalink: \"https://reddit.com${permalink}\""
    echo "url: \"$url\""
    echo "domain: \"$domain\""
    echo "ups: $ups"
    echo "upvote_ratio: ${upvote_ratio:-null}"
    echo "num_comments: $num_comments"
    echo "link_flair_text: \"$link_flair_text\""
    echo "link_flair_css_class: \"$link_flair_css_class\""
    echo "over_18: $over_18"
    echo "is_self: $is_self"
    echo "---"
    echo
    [[ -n "$body" ]] && printf "%s\n" "$body"
  } > "$tmp"
  mv -f "$tmp" "$out_file"

  printf "\r[%d/%d] %s -> %s" "$i" "$TOTAL" "$f" "$out_file"
done
echo
echo "[md] done files=$TOTAL -> $OUT_ROOT"
