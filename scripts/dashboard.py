import os
import glob
import pathlib
import datetime
import time
import json
import math

STAGED = pathlib.Path(os.environ.get("STAGED_ROOT", "data/staged"))
CONTENT = pathlib.Path("content")

def get_sub_stats():
    stats = {}
    now = time.time()
    
    pattern = str(STAGED / "r_*" / "submissions" / "*" / "*.md")
    print(f"[dashboard] Scanning stats from {pattern}...")
    
    for p in glob.iglob(pattern, recursive=False):
        parts = pathlib.Path(p).parts
        sub = parts[-4]
        
        if sub not in stats:
            stats[sub] = {
                "count": 0,
                "latest_ts": 0.0,
                "timestamps": []
            }
        
        try:
            stem = pathlib.Path(p).stem
            ts_str = stem.split("_")[0]
            dt = datetime.datetime.strptime(ts_str, "%y%m%d%H%M%S").replace(tzinfo=datetime.timezone.utc)
            ts = dt.timestamp()
            
            stats[sub]["count"] += 1
            stats[sub]["timestamps"].append(ts)
            if ts > stats[sub]["latest_ts"]:
                stats[sub]["latest_ts"] = ts
        except:
            continue

    result_list = []
    one_week = 604800 

    for sub, data in stats.items():
        ts_list = data["timestamps"]
        last_ts = data["latest_ts"]
        
        points = []
        for i in range(6):
            weeks_end = 0 if i == 0 else (2 ** (i - 1))
            weeks_start = 2 ** i
            t_end = now - (weeks_end * one_week)
            t_start = now - (weeks_start * one_week)
            count = sum(1 for t in ts_list if t_start <= t < t_end)
            points.append(count)
        
        points.reverse()
        
        max_val = max(points) if points else 1
        normalized = [math.ceil((p / max_val) * 20) if max_val > 0 else 0 for p in points]
        
        trend_list = normalized 

        days_since = (now - last_ts) / 86400
        if days_since < 7: status = "active"
        elif days_since < 30: status = "quiet"
        else: status = "archived"

        last_date_str = datetime.datetime.fromtimestamp(last_ts).strftime("%Y-%m-%d")

        result_list.append({
            "name": sub,
            "path": f"{sub}/_index.md",
            "count": data["count"],
            "last_date": last_date_str,
            "status": status,
            "trend": trend_list
        })

    result_list.sort(key=lambda x: x["last_date"], reverse=True)
    return result_list

def update_home_index(subs_data):
    index_file = CONTENT / "_index.md"
    base_content = ""
    
    if index_file.exists():
        try:
            text = index_file.read_text(encoding="utf-8")
            parts = text.split("---", 2)
            if len(parts) >= 3:
                base_content = parts[2]
        except: pass
            
    if not base_content.strip():
        base_content = "\n"
    
    subs_json = json.dumps(subs_data, ensure_ascii=False)
    
    new_fm = f"""---
title: "Reddit Archive"
sort_by: "weight"
template: "index.html"
extra:
  subs: {subs_json}
---
"""
    with open(index_file, "w", encoding="utf-8") as f:
        f.write(new_fm + base_content)
    
    print(f"[dashboard] Updated Homepage for {len(subs_data)} subreddits.")

if __name__ == "__main__":
    data = get_sub_stats()
    update_home_index(data)
