import os, sys, glob, pathlib, datetime, shutil, json

STAGED = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/staged")
DOCS = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "docs")
RECENT_N = int(os.environ.get("GEN_RECENT", "64"))
RAW = pathlib.Path(os.environ.get("DATA_ROOT", "data/raw"))

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

def pick_latest_staged_comments_md(staged_root: pathlib.Path, staged_sub: str, created_id: str):
    d = staged_root / staged_sub / "comments" / created_id
    if not d.exists():
        return None
    files = sorted([p for p in d.glob("*.md") if p.is_file()])
    if not files:
        return None
    return files[-1]

def read_text(p: pathlib.Path) -> str:
    with open(p, "r", encoding="utf-8") as f:
        return f.read()

def pick_latest_comments_capture(raw_sub: str, created_id: str):
    d = RAW / raw_sub / "comments" / created_id
    if not d.exists():
        return None
    files = sorted([p for p in d.glob("*.jsonl") if p.is_file()])
    if not files:
        return None
    return files[-1]

def load_comments_jsonl(p: pathlib.Path):
    out = []
    with open(p, "r", encoding="utf-8") as f:
        for ln in f:
            s = ln.strip()
            if not s:
                continue
            try:
                out.append(json.loads(s))
            except Exception:
                continue
    return out

def build_comment_tree(rows, post_id):
    by_id = {}
    children = {}
    roots = []
    for r in rows:
        cid = r.get("id","")
        if not cid:
            continue
        by_id[cid] = r
    for r in rows:
        cid = r.get("id","")
        pid = r.get("parent_id","")
        if not cid:
            continue
        if pid.startswith("t3_"):
            roots.append(cid)
        elif pid.startswith("t1_"):
            parent = pid[3:]
            children.setdefault(parent, []).append(cid)
        else:
            roots.append(cid)
    for k in children:
        children[k].sort(key=lambda x: (float(by_id.get(x,{}).get("created_utc",0)), x))
    roots.sort(key=lambda x: (float(by_id.get(x,{}).get("created_utc",0)), x))
    return by_id, children, roots

def render_comment(by_id, children, cid, depth):
    r = by_id[cid]
    created = int(float(r.get("created_utc", 0)))
    author = r.get("author","")
    score = r.get("score",0)
    ups = r.get("ups",0)
    downs = r.get("downs",0)
    pid = r.get("id","")
    permalink = r.get("permalink","")
    body_text = r.get("body","")
    prefix = ">"*depth + " "
    lines = []
    lines.append(prefix + f"- Author: {author}")
    lines.append(prefix + f"- Created: {fmt_iso_seconds(created)}")
    lines.append(prefix + f"- Score: {score}")
    lines.append(prefix + f"- ID: {pid}")
    lines.append(prefix + f"- Ups={ups} | Downs={downs} | Permalink={permalink}")
    lines.append(">"*depth)
    if body_text:
        for ln in body_text.splitlines():
            lines.append(prefix + ln)
    else:
        lines.append(prefix + "_(no text)_")
    if children.get(cid):
        lines.append("")
        for kid in children.get(cid, []):
            lines.extend(render_comment(by_id, children, kid, depth+1))
            lines.append("")
        while lines and lines[-1]=="":
            lines.pop()
    return lines

def render_comments_block(raw_sub: str, created_id: str, post_id: str):
    latest = pick_latest_comments_capture(raw_sub, created_id)
    if not latest:
        return ""
    rows = load_comments_jsonl(latest)
    if not rows:
        return ""
    by_id, children, roots = build_comment_tree(rows, post_id)
    if not roots:
        return ""
    out = []
    out.append("")
    out.append("---")
    out.append("")
    for i, cid in enumerate(roots):
        out.extend(render_comment(by_id, children, cid, 1))
        if i != len(roots)-1:
            out.append("")
    while out and out[-1]=="":
        out.pop()
    return "\n".join(out)

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
        href = f'posts/{it["sub"]}/{it["created_id"]}.md'
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
            href = f'../posts/{it["sub"]}/{it["created_id"]}.md'
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
            href = f'../posts/{it["sub"]}/{it["created_id"]}.md'
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
            f"- Subreddit: {it['sub']}",
            f"- Author: {it['author']}",
            f"- Created: {fmt_iso_seconds(it['created_utc'])}",
            f"- Permalink: {it['permalink']}",
        ]
        if it["url"]:
            lines.append(f"- URL: {it['url']}")
        lines.append(f"- Ups: {it['ups']} | Ratio: {it['upvote_ratio']} | Comments: {it['num_comments']}")
        if it["flair"]:
            lines.append(f"- Flair: {it['flair']}")
        lines.append("")
        lines.append(it["body"] if it["body"].strip() else "_(no selftext)_")

        cm_md = pick_latest_staged_comments_md(STAGED, it["sub"], it["created_id"])
        if cm_md:
            lines.extend(["", "---", ""])
            lines.append(read_text(cm_md).rstrip())
        else:
            block = render_comments_block(it["sub"], it["created_id"], it["post_id"])
            if block:
                lines.append(block)

        write(DOCS / "posts" / it["sub"] / f"{it['created_id']}.md", "\n".join(lines) + "\n")

if __name__ == "__main__":
    build()
