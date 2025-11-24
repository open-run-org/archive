import os
import sys
import glob
import pathlib
import shutil
import datetime
import json

STAGED = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/staged")
CONTENT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "content")
RECENT_N = int(os.environ.get("GEN_RECENT", "64"))

def read_fm_body(p: pathlib.Path):
    try:
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
    except Exception:
        return {}, ""

def iter_captures():
    pattern = str(STAGED / "r_*" / "submissions" / "*" / "*.md")
    count = 0
    for p in glob.iglob(pattern, recursive=False):
        pth = pathlib.Path(p)
        sub = pth.parts[-4]
        created_id = pth.parts[-2]
        cap = pth.stem
        meta, body = read_fm_body(pth)
        
        count += 1
        if count % 100 == 0:
            sys.stdout.write(f"\r[Scanning] Found {count} snapshots...")
            sys.stdout.flush()
            
        yield {
            "sub": sub,
            "created_id": created_id,
            "post_id": created_id.split("_", 1)[1],
            "capture": cap,
            "meta": meta,
            "body": body,
            "created_utc": meta.get("created_utc", "0")
        }
    sys.stdout.write(f"\r[Scanning] Found {count} snapshots. Done.\n")

def latest_by_post(items):
    d = {}
    for it in items:
        k = (it["sub"], it["post_id"])
        v = d.get(k)
        if not v or it["capture"] > v["capture"]:
            d[k] = it
    return list(d.values())

def ensure_dir(p):
    pathlib.Path(p).mkdir(parents=True, exist_ok=True)

def write(p, s):
    ensure_dir(pathlib.Path(p).parent)
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)

def pick_latest_staged_comments_md(staged_root: pathlib.Path, staged_sub: str, created_id: str):
    d = staged_root / staged_sub / "comments" / created_id
    if not d.exists():
        return None
    files = sorted([p for p in d.glob("*.md") if p.is_file()])
    return files[-1] if files else None

def read_text(p: pathlib.Path) -> str:
    with open(p, "r", encoding="utf-8") as f:
        return f.read()

def fmt_iso(ts):
    try:
        dt = datetime.datetime.fromtimestamp(int(float(ts)), datetime.timezone.utc)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return "1970-01-01"

def build():
    if CONTENT.exists():
        shutil.rmtree(CONTENT)
    CONTENT.mkdir(parents=True)

    items = list(iter_captures())

    home_fm = "---\ntitle: \"Reddit Archive\"\nsort_by: \"weight\"\n---\n\n# Welcome to the Reddit Archive\n"
    write(CONTENT / "_index.md", home_fm)

    if not items:
        return

    latest_per_post = latest_by_post(items)
    
    by_sub = {}
    for it in latest_per_post:
        by_sub.setdefault(it["sub"], []).append(it)

    written_count = 0
    total_posts = len(latest_per_post)
    
    for s, posts in by_sub.items():
        sub_fm = f"---\ntitle: \"{s}\"\nsort_by: \"date\"\ntransparent: true\n---\n\n# Archive of {s}\n"
        write(CONTENT / s / "_index.md", sub_fm)

        for it in posts:
            m = it["meta"]
            title_raw = m.get("title") or it["created_id"]
            title_json = json.dumps(title_raw, ensure_ascii=False)
            
            try:
                 dt = datetime.datetime.fromtimestamp(int(float(it["created_utc"])), datetime.timezone.utc)
                 date_str = dt.strftime("%Y-%m-%d")
            except:
                 date_str = "1970-01-01"

            lines = ["---"]
            lines.append(f'title: {title_json}')
            lines.append(f'date: {date_str}')
            lines.append("extra:")
            
            for k, v in m.items():
                if k != "title":
                    val_json = json.dumps(v, ensure_ascii=False)
                    lines.append(f'  {k}: {val_json}')

            lines.append(f'  subreddit: "{it["sub"]}"')
            lines.append(f'  post_id: "{it["post_id"]}"')
            lines.append("---\n")

            body_text = it["body"]
            cm_md = pick_latest_staged_comments_md(STAGED, it["sub"], it["created_id"])
            comments_content = ""
            if cm_md:
                comments_content = "\n\n---\n\n" + read_text(cm_md).rstrip()

            full_content = "\n".join(lines) + body_text + comments_content
            write(CONTENT / s / f"{it['created_id']}.md", full_content)
            
            written_count += 1
            if written_count % 100 == 0:
                sys.stdout.write(f"\r[Writing] {written_count}/{total_posts}")
                sys.stdout.flush()

    print(f"\n[Done] Content generated in {CONTENT}")

if __name__ == "__main__":
    build()