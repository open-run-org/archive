#!/usr/bin/env bash
set -euo pipefail

IN_ROOT=${1:-data/raw}
OUT_ROOT=${2:-data/staged}

mapfile -t files < <(find "$IN_ROOT" -type f -name '*.jsonl' | sort)
TOTAL=${#files[@]}
if [[ $TOTAL -eq 0 ]]; then
  echo "[md] no input jsonl under $IN_ROOT"
  exit 0
fi

i=0
for f in "${files[@]}"; do
  i=$((i+1))
  line=$(head -n1 "$f")
  if [[ -z "$line" ]]; then
    printf "\r[%d/%d] skip empty %s\n" "$i" "$TOTAL" "$f"
    continue
  fi

  sub=$(jq -r '.subreddit // empty' <<<"$line")
  id=$(jq -r '.id // empty' <<<"$line")
  name=$(jq -r '.name // empty' <<<"$line")
  title=$(jq -r '.title // ""' <<<"$line")
  author=$(jq -r '.author // ""' <<<"$line")
  created=$(jq -r '.created_utc | floor' <<<"$line")
  permalink=$(jq -r '.permalink // ""' <<<"$line")
  url=$(jq -r '.url // ""' <<<"$line")
  ups=$(jq -r '.ups // 0' <<<"$line")
  upvote_ratio=$(jq -r '.upvote_ratio // empty' <<<"$line")
  num_comments=$(jq -r '.num_comments // 0' <<<"$line")
  domain=$(jq -r '.domain // ""' <<<"$line")
  link_flair_text=$(jq -r '.link_flair_text // ""' <<<"$line")
  link_flair_css_class=$(jq -r '.link_flair_css_class // ""' <<<"$line")
  over_18=$(jq -r '.over_18 // false' <<<"$line")
  is_self=$(jq -r '.is_self // false' <<<"$line")
  sub_pref=$(jq -r '.subreddit_name_prefixed // ""' <<<"$line")

  ts_created=$(date -u -d "@$created" +%y%m%d%H%M%S)
  yyyy=$(date -u -d "@$created" +%Y)
  mm=$(date -u -d "@$created" +%m)
  dd=$(date -u -d "@$created" +%d)

  html=$(jq -r '.selftext_html // ""' <<<"$line")
  if [[ -n "$html" && "$html" != "null" ]]; then
    body=$(printf "%s" "$html" | pandoc -f html -t gfm)
  else
    body=$(jq -r '.selftext // ""' <<<"$line")
  fi

  out_dir="$OUT_ROOT/r_${sub}/${yyyy}/${mm}/${dd}"
  mkdir -p "$out_dir"
  out_file="${out_dir}/${ts_created}_${id}.md"

  safe_title=${title//$'\r'/}
  safe_title=${safe_title//$'\n'/ }
  safe_title=${safe_title//\"/\\\"}

  {
    echo "---"
    echo "title: \"$safe_title\""
    echo "subreddit: \"$sub_pref\""
    echo "id: \"$id\""
    echo "name: \"$name\""
    echo "author: \"$author\""
    echo "created_utc: $created"
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
    [[ -n "$body" ]] && printf "%s\n\n" "$body"
    echo "```json"
    printf "%s\n" "$line"
    echo "```"
  } > "$out_file"

  printf "\r[%d/%d] %s -> %s" "$i" "$TOTAL" "$f" "$out_file"
done
echo
echo "[md] done files=$TOTAL -> $OUT_ROOT"
