import os, re, glob, datetime, pathlib
import mkdocs_gen_files

DOCS = mkdocs_gen_files.config["docs_dir"]
ROOT = pathlib.Path(DOCS)
RECENT = int(os.environ.get("GEN_RECENT", "20"))

def iter_posts():
    pattern = str(ROOT / "r_*" / "submissions" / "*" / "*.md")
    for p in glob.iglob(pattern, recursive=False):
        path = pathlib.Path(p)
        sub = path.parts[-4]
        created_id = path.parts[-2]
        capture_name = path.stem
        yield sub, created_id, capture_name, path

def read_title(md_path: pathlib.Path) -> str:
    try:
        with md_path.open("r", encoding="utf-8") as f:
            line = f.readline().rstrip("\n")
            if line != "---":
                return md_path.name
            title = None
            for ln in f:
                l = ln.rstrip("\n")
                if l == "---":
                    break
                if l.startswith("title:"):
                    m = re.match(r'^title:\s*"(.*)"\s*$', l)
                    title = m.group(1) if m else l.split(":",1)[1].strip()
            return title or md_path.name
    except Exception:
        return md_path.name

def write_index(sub_to_posts):
    with mkdocs_gen_files.open("index.md", "w") as f:
        f.write("# Archive Index\n\n")
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
        f.write(f"_generated {now}_\n\n")
        for sub in sorted(sub_to_posts.keys()):
            posts = sorted(sub_to_posts[sub], key=lambda x: x["rel"], reverse=True)
            f.write(f"## {sub}\n\n")
            for item in posts[:RECENT]:
                f.write(f"- [{item['title']}]({item['rel'].as_posix()})\n")
            f.write("\n")

def write_sub_indexes(sub_to_posts):
    for sub, items in sub_to_posts.items():
        dst = pathlib.Path(sub) / "index.md"
        with mkdocs_gen_files.open(dst.as_posix(), "w") as f:
            f.write(f"# {sub}\n\n")
            groups = {}
            for it in items:
                yymmdd = it["created_id"][:6]
                groups.setdefault(yymmdd, []).append(it)
            for key in sorted(groups.keys(), reverse=True):
                f.write(f"## {key}\n\n")
                for it in sorted(groups[key], key=lambda x: x["rel"], reverse=True):
                    f.write(f"- [{it['title']}]({it['rel'].as_posix()})\n")
                f.write("\n")

def main():
    sub_to_posts = {}
    for sub, created_id, capture_name, abs_path in iter_posts():
        rel = abs_path.relative_to(ROOT)
        title = read_title(abs_path)
        sub_to_posts.setdefault(sub, []).append({
            "rel": rel, "title": title, "created_id": created_id, "capture": capture_name,
        })
    write_index(sub_to_posts)
    write_sub_indexes(sub_to_posts)

if __name__ == "__main__":
    main()
