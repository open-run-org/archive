import os, glob, pathlib, datetime
import mkdocs_gen_files

CFG = mkdocs_gen_files.config
ROOT = pathlib.Path(CFG["config_file_path"]).parent
STAGED = ROOT / "data" / "staged"
DOCS = pathlib.Path(CFG["docs_dir"])
RECENT_N = int(os.environ.get("GEN_RECENT", "64"))

def read_frontmatter_and_body(p: pathlib.Path):
    with p.open("r", encoding="utf-8") as f:
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
        meta, _ = read_frontmatter_and_body(pth)
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
            "staged_path": pth,
        }

def latest_by_post(items):
    latest = {}
    for it in items:
        k = (it["sub"], it["post_id"])
        prev = latest.get(k)
        if not prev or it["capture"] > prev["capture"]:
            latest[k] = it
    return list(latest.values())

items = list(iter_captures())
subs = sorted(set(x["sub"] for x in items))
latest_changes = sorted(items, key=lambda x: (x["capture"], x["sub"]), reverse=True)[:RECENT_N]
latest_per_post = latest_by_post(items)

def post_href(it):
    return f'posts/{it["sub"]}/{it["created_id"]}.md'

def write_home():
    with mkdocs_gen_files.open("index.md", "w") as f:
        f.write("# Archive\n\n")
        f.write("## Subreddits\n\n")
        for s in sorted(subs):
            f.write(f"- [{s}]({s}/index.md)\n")
        f.write("\n")
        f.write("## Latest changes\n\n")
        for it in latest_changes:
            title = it["title"] or it["created_id"]
            ts = it["capture_ts"]
            f.write(f"- `{it['sub']}` `{ts}` [{title}]({post_href(it)})\n")

def write_sub_indexes():
    by_sub = {}
    for it in items:
        by_sub.setdefault(it["sub"], []).append(it)
    for s, arr in by_sub.items():
        arr_sorted = sorted(arr, key=lambda x: x["capture"], reverse=True)[:RECENT_N]
        with mkdocs_gen_files.open(f"{s}/index.md", "w") as f:
            f.write(f"# {s}\n\n")
            f.write(f"[Full archive]({s}/archive.md)\n\n")
            f.write("## Latest changes\n\n")
            for it in arr_sorted:
                title = it["title"] or it["created_id"]
                f.write(f"- `{it['capture_ts']}` [{title}]({post_href(it)})\n")

def write_archive_pages():
    by_sub = {}
    for it in latest_per_post:
        by_sub.setdefault(it["sub"], []).append(it)
    for s, arr in by_sub.items():
        arr_sorted = sorted(arr, key=lambda x: (x["created_key"], x["post_id"]), reverse=True)
        with mkdocs_gen_files.open(f"{s}/archive.md", "w") as f:
            f.write(f"# {s} • Archive\n\n")
            f.write('<script>document.addEventListener("DOMContentLoaded",function(){document.querySelectorAll("table thead th").forEach(function(th){th.addEventListener("click",function(){const t=th.closest("table");const i=[...th.parentNode.children].indexOf(th);const asc=th.dataset.asc!=="true";[...t.tBodies[0].rows].sort((a,b)=>{const A=a.cells[i].innerText,B=b.cells[i].innerText;return asc?A.localeCompare(B,undefined,{numeric:true}):B.localeCompare(A,undefined,{numeric:true})}).forEach(tr=>t.tBodies[0].appendChild(tr));th.dataset.asc=asc;});});});</script>\n')
            f.write("| Created (UTC) | ID | Title | Author | Ups | Ratio | Comments | Flair | NSFW | Self | Domain |\n")
            f.write("|---:|---|---|---|---:|---:|---:|---|---|---|---|\n")
            for it in arr_sorted:
                created_iso = datetime.datetime.utcfromtimestamp(it["created_utc"]).strftime("%Y-%m-%d %H:%M")
                title = (it["title"] or it["created_id"]).replace("|", "\\|")
                f.write(f"| {created_iso} | `{it['post_id']}` | [{title}]({post_href(it)}) | {it['author']} | {it['ups']} | {it['upvote_ratio']} | {it['num_comments']} | {it['flair']} | {it['over_18']} | {it['is_self']} | {it['domain']} |\n")

def write_post_pages():
    for it in latest_per_post:
        meta, body = read_frontmatter_and_body(it["staged_path"])
        created_iso = datetime.datetime.utcfromtimestamp(it["created_utc"]).strftime("%Y-%m-%d %H:%M:%S UTC")
        with mkdocs_gen_files.open(f"posts/{it['sub']}/{it['created_id']}.md", "w") as f:
            f.write(f"# {it['title'] or it['created_id']}\n\n")
            f.write("- Metadata:\n")
            f.write(f"  - Subreddit: {it['sub']}\n")
            f.write(f"  - Author: {it['author']}\n")
            f.write(f"  - Created: {created_iso}\n")
            f.write(f"  - Permalink: {it['permalink']}\n")
            if it["url"]:
                f.write(f"  - URL: {it['url']}\n")
            f.write(f"  - Ups: {it['ups']} | Ratio: {it['upvote_ratio']} | Comments: {it['num_comments']}\n")
            if it["flair"]:
                f.write(f"  - Flair: {it['flair']}\n")
            f.write("\n")
            f.write(body if body else "_(no selftext)_\n")

write_home()
write_sub_indexes()
write_archive_pages()
write_post_pages()
