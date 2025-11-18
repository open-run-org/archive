import argparse
import json
import os
import pathlib
import sys
import hashlib
import datetime

def ts_fmt(unix_ts):
    try:
        v = int(float(unix_ts))
    except Exception:
        return ""
    if v <= 0:
        return ""
    return datetime.datetime.fromtimestamp(v, datetime.timezone.utc).strftime("%y%m%d%H%M%S")

def norm_sub(s):
    s = (s or "").strip()
    s = s.lstrip("r/").lstrip("R/").lstrip("r_").lstrip("R_")
    return s.lower()

def has_hash_file(dir_path, h):
    if not os.path.isdir(dir_path):
        return False
    for name in os.listdir(dir_path):
        if not name.endswith(".jsonl"):
            continue
        if "_" + h in name:
            return True
    return False

def hash_post(obj):
    data = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8", "ignore")
    return hashlib.sha256(data).hexdigest()

def hash_comments(rows):
    buf = []
    for r in rows:
        buf.append(json.dumps(r, sort_keys=True, separators=(",", ":")))
    data = "\n".join(buf).encode("utf-8", "ignore")
    return hashlib.sha256(data).hexdigest()

def import_posts(path, root, post_index):
    p = pathlib.Path(path)
    with p.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            sub = norm_sub(obj.get("subreddit") or obj.get("subreddit_name_prefixed") or "")
            if not sub:
                continue
            pid = obj.get("id")
            created = obj.get("created_utc")
            if pid is None or created is None:
                continue
            try:
                created_int = int(float(created))
            except Exception:
                continue
            if created_int <= 0:
                continue
            post_index[(sub, pid)] = created_int
            created_key = ts_fmt(created_int)
            if not created_key:
                continue
            created_id = created_key + "_" + pid
            subdir = pathlib.Path(root) / ("r_" + sub) / "submissions" / created_id
            subdir.mkdir(parents=True, exist_ok=True)
            retrieved = obj.get("retrieved_on") or obj.get("retrieved_utc")
            if retrieved is None:
                retrieved = datetime.datetime.now(datetime.timezone.utc).timestamp()
            capture_ts = ts_fmt(retrieved)
            if not capture_ts:
                capture_ts = ts_fmt(created_int)
            h = hash_post(obj)
            if has_hash_file(subdir, h):
                continue
            out_path = subdir / (capture_ts + "_" + h + ".jsonl")
            try:
                with out_path.open("x", encoding="utf-8") as w:
                    if s.endswith("\n"):
                        w.write(s)
                    else:
                        w.write(s + "\n")
            except FileExistsError:
                continue

def import_comments(path, root, post_index):
    p = pathlib.Path(path)
    groups = {}
    with p.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            sub = norm_sub(obj.get("subreddit") or "")
            if not sub:
                continue
            link_id = obj.get("link_id")
            if not isinstance(link_id, str):
                continue
            if not link_id.startswith("t3_"):
                continue
            pid = link_id.split("_", 1)[1]
            key = (sub, pid)
            groups.setdefault(key, []).append(obj)
    now_ts = datetime.datetime.now(datetime.timezone.utc).timestamp()
    for (sub, pid), rows in groups.items():
        created_int = post_index.get((sub, pid))
        if created_int is None:
            print(f"[import_arctic] skip comments sub={sub} post={pid} no_post_created", file=sys.stderr)
            continue
        created_key = ts_fmt(created_int)
        if not created_key:
            continue
        created_id = created_key + "_" + pid
        subdir = pathlib.Path(root) / ("r_" + sub) / "comments" / created_id
        subdir.mkdir(parents=True, exist_ok=True)
        cap_ts = None
        for r in rows:
            v = r.get("retrieved_utc")
            if v is None:
                v = r.get("retrieved_on")
            if v is None:
                continue
            try:
                t = int(float(v))
            except Exception:
                continue
            if cap_ts is None or t > cap_ts:
                cap_ts = t
        if cap_ts is None:
            cap_ts = int(now_ts)
        capture_ts = ts_fmt(cap_ts)
        if not capture_ts:
            capture_ts = ts_fmt(created_int)
        h = hash_comments(rows)
        if has_hash_file(subdir, h):
            continue
        out_path = subdir / (capture_ts + "_" + h + ".jsonl")
        try:
            with out_path.open("x", encoding="utf-8") as w:
                for r in rows:
                    w.write(json.dumps(r, ensure_ascii=False) + "\n")
        except FileExistsError:
            continue

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="data/raw")
    ap.add_argument("paths", nargs="+")
    args = ap.parse_args()
    root = args.root
    post_index = {}
    for p in args.paths:
        name = os.path.basename(p)
        if "_posts" in name:
            import_posts(p, root, post_index)
    for p in args.paths:
        name = os.path.basename(p)
        if "_comments" in name:
            import_comments(p, root, post_index)

if __name__ == "__main__":
    main()
