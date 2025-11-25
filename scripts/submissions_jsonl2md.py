import os
import sys
import glob
import pathlib
import datetime
import json
import subprocess
import re
import argparse

def get_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("in_root")
    parser.add_argument("out_root")
    parser.add_argument("--days", type=int, default=64)
    return parser.parse_args()

def fmt_iso(ts):
    try:
        return datetime.datetime.fromtimestamp(int(float(ts)), datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return "1970-01-01 00:00:00 UTC"

def clean_html(html_content):
    if not html_content:
        return ""
    
    s = re.sub(r'', '', html_content)
    s = re.sub(r'', '', s)
    s = re.sub(r'^\s*<div class="md">\s*', '', s)
    s = re.sub(r'\s*</div>\s*$', '', s)
    return s

def html_to_md(html_content):
    cleaned = clean_html(html_content)
    if not cleaned:
        return ""
    
    try:
        p = subprocess.Popen(
            ['pandoc', '-f', 'html', '-t', 'gfm'], 
            stdin=subprocess.PIPE, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            encoding='utf-8'
        )
        out, err = p.communicate(input=cleaned)
        return out
    except Exception:
        return ""

def main():
    args = get_args()
    in_root = pathlib.Path(args.in_root)
    out_root = pathlib.Path(args.out_root)
    
    cutoff_dt = datetime.datetime.now() - datetime.timedelta(days=args.days)
    cutoff_str = cutoff_dt.strftime("%y%m%d%H%M%S")
    
    pattern = str(in_root / "r_*" / "submissions" / "*" / "*.jsonl")
    files = sorted(glob.glob(pattern))
    total = len(files)
    
    processed = 0
    skipped = 0
    
    print(f"[md] Scanning {total} files...")
    
    for i, f_str in enumerate(files):
        f = pathlib.Path(f_str)
        
        created_id = f.parent.name
        ts_part = created_id.split("_")[0]
        
        if ts_part < cutoff_str:
            continue
            
        sub_dir = f.parents[2].name
        cap_hash = f.stem
        parts = cap_hash.split("_", 1)
        if len(parts) < 2: 
            continue
        capture_ts = parts[0]
        content_hash = parts[1]
        
        rel_path = f"{sub_dir}/submissions/{created_id}/{capture_ts}_{content_hash}.md"
        out_file = out_root / rel_path
        
        if out_file.exists():
            skipped += 1
            if skipped % 100 == 0:
                 sys.stdout.write(f"\r[md] Skipped {skipped} existing files...")
                 sys.stdout.flush()
            continue

        try:
            with open(f, "r", encoding="utf-8") as fr:
                line = fr.readline()
                if not line:
                    continue
                data = json.loads(line)
        except Exception:
            continue
            
        out_file.parent.mkdir(parents=True, exist_ok=True)
        
        meta = {}
        meta["title"] = data.get("title", "")
        meta["subreddit"] = data.get("subreddit_name_prefixed", "")
        meta["id"] = data.get("id", "")
        meta["name"] = data.get("name", "")
        meta["author"] = data.get("author", "")
        
        created_utc = data.get("created_utc", 0)
        meta["created_utc"] = int(created_utc) if created_utc else 0
        
        ts_created = datetime.datetime.fromtimestamp(meta["created_utc"], datetime.timezone.utc).strftime("%y%m%d%H%M%S")
        meta["created_key"] = ts_created
        meta["capture_ts"] = capture_ts
        meta["content_sha256"] = content_hash
        
        permalink = data.get("permalink", "")
        meta["permalink"] = f"https://reddit.com{permalink}"
        meta["url"] = data.get("url", "")
        meta["domain"] = data.get("domain", "")
        meta["ups"] = data.get("ups", 0)
        meta["upvote_ratio"] = data.get("upvote_ratio", "")
        meta["num_comments"] = data.get("num_comments", 0)
        meta["link_flair_text"] = data.get("link_flair_text", "")
        meta["link_flair_css_class"] = data.get("link_flair_css_class", "")
        meta["over_18"] = str(data.get("over_18", False)).lower()
        meta["is_self"] = str(data.get("is_self", False)).lower()

        body = ""
        html = data.get("selftext_html")
        if html:
            body = html_to_md(html)
        else:
            body = data.get("selftext", "")

        with open(out_file, "w", encoding="utf-8") as fw:
            fw.write("---\n")
            for k, v in meta.items():
                val_json = json.dumps(v, ensure_ascii=False)
                fw.write(f"{k}: {val_json}\n")
            fw.write("---\n\n")
            if body:
                fw.write(body)
                fw.write("\n")
        
        processed += 1
        if processed % 10 == 0:
            sys.stdout.write(f"\r[md] Processed {processed} new files (Total scan: {i}/{total})")
            sys.stdout.flush()

    print(f"\n[md] Done. Processed: {processed}, Skipped: {skipped}")

if __name__ == "__main__":
    main()
