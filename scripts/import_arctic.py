import argparse
import datetime
import hashlib
import http.client
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://arctic-shift.photon-reddit.com/api"


def ts_fmt(unix_ts):
    try:
        v = int(float(unix_ts))
    except Exception:
        return ""
    if v <= 0:
        return ""
    return datetime.datetime.fromtimestamp(v, datetime.UTC).strftime("%y%m%d%H%M%S")


def norm_sub(s):
    s = (s or "").strip()
    for p in ("/r/", "r/", "R/", "r_", "R_"):
        if s.startswith(p):
            return s[len(p) :]
    return s


def captured(d):
    return d.is_dir() and any(d.glob("*.jsonl"))


def retrieved(obj):
    meta = obj.get("_meta") if isinstance(obj.get("_meta"), dict) else {}
    for v in (meta.get("retrieved_2nd_on"), obj.get("retrieved_on"), obj.get("retrieved_utc")):
        try:
            t = int(float(v))
        except Exception:
            continue
        if t > 0:
            return t
    return None


def hash_post(obj):
    data = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8", "ignore")
    return hashlib.sha256(data).hexdigest()


def hash_comments(rows):
    buf = []
    for r in rows:
        buf.append(json.dumps(r, sort_keys=True, separators=(",", ":")))
    data = "\n".join(buf).encode("utf-8", "ignore")
    return hashlib.sha256(data).hexdigest()


def dump(obj):
    s = json.dumps(obj, ensure_ascii=False)
    try:
        s.encode("utf-8")
        return s
    except UnicodeEncodeError:
        return json.dumps(obj)


def write_capture(d, lines, cap_ts, h):
    d.mkdir(parents=True, exist_ok=True)
    out = d / (ts_fmt(cap_ts) + "_" + h + ".jsonl")
    if out.exists():
        return
    tmp = out.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as w:
        for ln in lines:
            w.write(ln + "\n")
    os.replace(tmp, out)


def now():
    return int(time.time())


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
            pid = obj.get("id")
            created_key = ts_fmt(obj.get("created_utc"))
            if not sub or pid is None or not created_key:
                continue
            post_index[(sub, pid)] = created_key
            subdir = pathlib.Path(root) / ("r_" + sub) / "submissions" / (created_key + "_" + pid)
            if not captured(subdir):
                write_capture(subdir, [s], retrieved(obj) or now(), hash_post(obj))


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
            link_id = obj.get("link_id")
            if not sub or not isinstance(link_id, str) or not link_id.startswith("t3_"):
                continue
            groups.setdefault((sub, link_id[3:]), []).append(obj)
    for (sub, pid), rows in groups.items():
        created_key = post_index.get((sub, pid))
        if created_key is None:
            print(f"[import_arctic] skip comments sub={sub} post={pid} no_post_created", file=sys.stderr)
            continue
        subdir = pathlib.Path(root) / ("r_" + sub) / "comments" / (created_key + "_" + pid)
        if not captured(subdir):
            cap_ts = max((retrieved(r) or 0 for r in rows), default=0) or now()
            write_capture(subdir, [dump(r) for r in rows], cap_ts, hash_comments(rows))


def api(path, **params):
    url = f"{API}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "open-run-archive"})
    for attempt in range(4):
        time.sleep(0.3)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
            if d.get("error"):
                raise RuntimeError(f"{url}: {d['error']}")
            return d.get("data") or []
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code < 500 and e.code != 429:
                raise
            if attempt == 3:
                raise
            time.sleep(2**attempt * 5)


def search_posts(sub, after):
    seen, out = set(), []
    while True:
        page = api("posts/search", subreddit=sub, after=after, sort="asc", limit=100)
        fresh = [p for p in page if p.get("id") and p["id"] not in seen]
        for p in fresh:
            seen.add(p["id"])
            out.append(p)
        if len(page) < 100 or not fresh:
            return out
        after = int(float(page[-1]["created_utc"])) - 1


def comment_rows(pid):
    out = []

    def walk(children):
        for c in children or []:
            if not isinstance(c, dict) or c.get("kind") != "t1":
                continue
            d = dict(c.get("data") or {})
            rep = d.pop("replies", None)
            out.append(d)
            if isinstance(rep, dict):
                walk((rep.get("data") or {}).get("children"))

    walk(api("comments/tree", link_id="t3_" + pid, limit=9999))
    out.sort(key=lambda r: (r.get("parent_id") or "", r.get("created_utc") or 0, r.get("id") or ""))
    return out


def fetch_sub(root, sub, after):
    posts = search_posts(sub, after)
    new_posts = new_threads = failed = 0
    for p in posts:
        created_key = ts_fmt(p.get("created_utc"))
        if not created_key:
            continue
        created_id = created_key + "_" + p["id"]
        pdir = pathlib.Path(root) / ("r_" + sub) / "submissions" / created_id
        if not captured(pdir):
            write_capture(pdir, [dump(p)], retrieved(p) or now(), hash_post(p))
            new_posts += 1
        cdir = pathlib.Path(root) / ("r_" + sub) / "comments" / created_id
        if captured(cdir) or not int(p.get("num_comments") or 0):
            continue
        try:
            rows = comment_rows(p["id"])
        except Exception as e:
            print(f"[arctic] {sub} {p['id']} comments failed: {e}", file=sys.stderr)
            failed += 1
            continue
        if rows:
            cap_ts = max((retrieved(r) or 0 for r in rows), default=0) or now()
            write_capture(cdir, [dump(r) for r in rows], cap_ts, hash_comments(rows))
            new_threads += 1
    print(
        f"[arctic] {sub} posts={len(posts)} new_posts={new_posts} new_threads={new_threads} failed={failed}",
        file=sys.stderr,
    )
    return failed


SNAPSHOT_DAYS = (16, 32, 64, 128, 256)

PLACEHOLDERS = ("", "[removed]", "[deleted]", "[ Removed by Reddit ]")


def known_ids(d):
    ids = set()
    for f in d.glob("*.jsonl"):
        with f.open(encoding="utf-8", errors="ignore") as fh:
            for ln in fh:
                try:
                    stack = [json.loads(ln)]
                except ValueError:
                    continue
                while stack:
                    x = stack.pop()
                    if isinstance(x, dict):
                        if "body" in x and (x.get("body") or "").strip() not in PLACEHOLDERS:
                            ids.add(x.get("id"))
                        stack.extend(v for v in x.values() if isinstance(v, (dict, list)))
                    elif isinstance(x, list):
                        stack.extend(x)
    return ids


def snapshot_sub(root, sub):
    t = now()
    windows = [(ts_fmt(t - (d + 2) * 86400), ts_fmt(t - d * 86400)) for d in SNAPSHOT_DAYS]
    base = pathlib.Path(root) / ("r_" + sub)
    due = sorted(
        p.name for p in (base / "submissions").glob("*_*") if any(lo <= p.name < hi for lo, hi in windows)
    )
    wrote = failed = 0
    for created_id in due:
        try:
            rows = comment_rows(created_id.split("_", 1)[1])
        except Exception as e:
            print(f"[arctic] {sub} {created_id} snapshot failed: {e}", file=sys.stderr)
            failed += 1
            continue
        cdir = base / "comments" / created_id
        known = known_ids(cdir)
        if not any(
            r.get("id") not in known and (r.get("body") or "").strip() not in PLACEHOLDERS for r in rows
        ):
            continue
        cap_ts = max((retrieved(r) or 0 for r in rows), default=0) or now()
        write_capture(cdir, [dump(r) for r in rows], cap_ts, hash_comments(rows))
        wrote += 1
    print(f"[arctic] {sub} snapshots due={len(due)} wrote={wrote} failed={failed}", file=sys.stderr)
    return failed


def fetch(root, subs_file, after):
    subs = [s.strip() for s in pathlib.Path(subs_file).read_text(encoding="utf-8").splitlines()]
    failed = 0
    for sub in (s for s in subs if s and not s.startswith("#")):
        for step, args in ((fetch_sub, (root, sub, after)), (snapshot_sub, (root, sub))):
            try:
                failed += step(*args)
            except Exception as e:
                print(f"[arctic] {sub} failed: {e}", file=sys.stderr)
                failed += 1
    return failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="data/raw")
    ap.add_argument("--fetch", metavar="SUBS_FILE")
    ap.add_argument("--days", type=int, default=16)
    ap.add_argument("--since")
    ap.add_argument("paths", nargs="*")
    args = ap.parse_args()
    if args.fetch:
        after = args.since or str(now() - args.days * 86400)
        sys.exit(1 if fetch(args.root, args.fetch, after) else 0)
    post_index = {}
    for p in args.paths:
        if "_posts" in os.path.basename(p):
            import_posts(p, args.root, post_index)
    for p in args.paths:
        if "_comments" in os.path.basename(p):
            import_comments(p, args.root, post_index)


if __name__ == "__main__":
    main()
