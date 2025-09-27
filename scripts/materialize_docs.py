#!/usr/bin/env python3
import os, sys, glob, pathlib, datetime, shutil

STAGED = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/staged")
DOCS = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "docs")
RECENT_N = int(os.environ.get("GEN_RECENT", "64"))

def read_fm_body(p: pathlib.Path):
    with open(p, "r", encoding="utf-8") as f:
        first = f.readline()
        if first.strip() != "---":
            return {}, first + f.read()
        meta = {}
        for ln in f:
            s = ln.rstrip("\n")
            if s == "---":
                break
            if ":" in s:
                k, v = s.split(":", 1)
                meta[k.strip()] = v.strip().strip('"')
        body = f.read()
        return meta, body

def iter_captures():
    pattern = str(STAGED / "r_*" / "submissions" / "*" / "*.md")
    for p in glob.iglob(pattern, recursive=False):
        pth = pathlib.Path(p)
        sub = pth.parts[-4]
        created_id = pth.parts[-2]
        cap = pth.stem
        meta, body = read_fm_body(pth)
        yield {
            "sub": sub,
            "created_id": created_id,
            "post_id": created_id.split("_", 1)[1],
            "created_key": created_id.split("_", 1)[0],
            "capture": cap,
            "capture_ts": meta.get("capture_ts", ""),
            "title": meta.get("title", ""),
            "author": meta.get("author", ""),
            "created_utc": int(float(meta.get("created_utc", "0"))),
            "permalink": meta.get("permalink", ""),
            "url": meta.get("url", ""),
            "ups": meta.get("ups", "0"),
            "upvote_ratio": meta.get("upvote_ratio", ""),
            "num_comments": meta.get("num_comments", "0"),
            "flair": meta.get("link_flair_text", ""),
            "over_18": meta.get("over_18", "false"),
            "is_self": meta.get("is_self", "false"),
            "domain": meta.get("domain", ""),
            "body": body,
        }

def latest_by_post(items):
    d = {}
    for it in items:
        k = (it["sub"], it["post_id"])
        v = d.get(k)
        if not v or it["capture"] > v["capture"]:
            d[k] = it
    return list(d.values())

def ensure_dir(p): pathlib.Path(p).mkdir(parents=True, exist_ok=True)
def write(p, s):
    ensure_dir(pathlib.Path(p).parent)
    with open(p, "w", encoding="utf-8") as f: f.write(s)

def fmt_iso_minutes(ts: int) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime("%Y-%m-%d %H:%M")

def fmt_iso_seconds(ts: int) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime("%Y-%m-%d %H:%M:%S UTC")

def build():
    if DOCS.exists():
        for child in DOCS.iterdir():
            if child.is_dir(): shutil.rmtree(child)
            else: child.unlink()
    ensure_dir(DOCS)

    items = list(iter_captures())
    if not items:
        write(DOCS / "index.md", "# Archive\n\n_(no data yet)_\n")
        return

    subs = sorted(set(x["sub"] for x in items))
    latest_changes = sorted(items, key=lambda x: (x["capture"], x["sub"]), reverse=True)[:RECENT_N]
    latest_per_post = latest_by_post(items)

    home = ["# Archive", "", "## Subreddits", ""]
    for s in subs:
        home.append(f"- [{s}]({s}/index.md)")
    home += ["", "## Latest changes", ""]
    for it in latest_changes:
        title = it["title"] or it["created_id"]
        ts = it["capture_ts"]
        href = f'posts/{it["sub"]}/{it["created_id"]}.md'  # from /index.md to /posts/...
        home.append(f'- `{it["sub"]}` `{ts}` [{title}]({href})')
    write(DOCS / "index.md", "\n".join(home) + "\n")

    by_sub_all = {}
    for it in items:
        by_sub_all.setdefault(it["sub"], []).append(it)

    for s, arr in by_sub_all.items():
        arr_sorted = sorted(arr, key=lambda x: x["capture"], reverse=True)[:RECENT_N]
        lines = [f"# {s}", "", "[Full archive](archive.md)", "", "## Latest changes", ""]
        for it in arr_sorted:
            title = it["title"] or it["created_id"]
            href = f'../posts/{it["sub"]}/{it["created_id"]}.md'  # from /r_sub/ to /posts/...
            lines.append(f'- `{it["capture_ts"]}` [{title}]({href})')
        write(DOCS / s / "index.md", "\n".join(lines) + "\n")

    by_sub_latest = {}
    for it in latest_per_post:
        by_sub_latest.setdefault(it["sub"], []).append(it)

    for s, arr in by_sub_latest.items():
        arr_sorted = sorted(arr, key=lambda x: (x["created_key"], x["post_id"]), reverse=True)
        t = [
            f"# {s} • Archive",
            "",
            "| Created (UTC) | ID | Title | Author | Ups | Ratio | Comments | Flair | NSFW | Self | Domain |",
            "|---:|---|---|---|---:|---:|---:|---|---|---|---|",
        ]
        for it in arr_sorted:
            title = (it["title"] or it["created_id"]).replace("|", "\\|")
            href = f'../posts/{it["sub"]}/{it["created_id"]}.md'  # from /r_sub/archive.md to /posts/...
            t.append(
                f'| {fmt_iso_minutes(it["created_utc"])} | `{it["post_id"]}` | [{title}]({href}) | '
                f'{it["author"]} | {it["ups"]} | {it["upvote_ratio"]} | {it["num_comments"]} | '
                f'{it["flair"]} | {it["over_18"]} | {it["is_self"]} | {it["domain"]} |'
            )
        write(DOCS / s / "archive.md", "\n".join(t) + "\n")

    latest_map = {(it["sub"], it["post_id"]): it for it in latest_per_post}
    for (_, _), it in latest_map.items():
        title = it["title"] or it["created_id"]
        lines = [
            f"# {title}",
            "",
            "- Metadata:",
            f"  - Subreddit: {it['sub']}",
            f"  - Author: {it['author']}",
            f"  - Created: {fmt_iso_seconds(it['created_utc'])}",
            f"  - Permalink: {it['permalink']}",
        ]
        if it["url"]:
            lines.append(f"  - URL: {it['url']}")
        lines.append(f"  - Ups: {it['ups']} | Ratio: {it['upvote_ratio']} | Comments: {it['num_comments']}")
        if it["flair"]:
            lines.append(f"  - Flair: {it['flair']}")
        lines.append("")
        lines.append(it["body"] if it["body"].strip() else "_(no selftext)_")
        write(DOCS / "posts" / it["sub"] / f"{it['created_id']}.md", "\n".join(lines) + "\n")

if __name__ == "__main__":
    build()
