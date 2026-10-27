import datetime
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys
import time

RAW = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw")
CONTENT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "content")

GONE = {"[removed]": "Removed", "[ Removed by Reddit ]": "Removed", "[deleted]": "Deleted"}
TAG = re.compile(r"<(?=[A-Za-z/!?])")
EMPTY_LINK = re.compile(r"\]\([\s>]*(?:<[\s>]*>)?[\s>]*(?:\"[^\"\n]*\"|'[^'\n]*')?[\s>]*\)")
EMPTY_REF = re.compile(r"^((?:[ \t]*>)*[ \t]*\[[^\]\n]+\]):(?=[ \t]*(?:<[ \t]*>)?[ \t]*(?:\"[^\"\n]*\"|'[^'\n]*'|\([^)\n]*\))?[ \t]*$)", re.M)
UNSAFE = re.compile("[\x7f-\x9f\u2028\u2029\ufffe\uffff]")
ARCTIC_KEYS = ("_meta", "retrieved_on", "retrieved_utc")

def esc(s):
    return TAG.sub("&lt;", s)

def unlink(s):
    s = EMPTY_LINK.sub(lambda m: "]\\" + m.group(0)[1:], s)
    return EMPTY_REF.sub(r"\1\\:", s)

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
BARE_URL = re.compile(r"(?<![A-Za-z0-9_/\[<\"'=@&])(?<!\]\()https?://[^\s<>\"'\[\]*，。、！？；：「」『』（）【】《》]+")
SUB_REF = re.compile(r"(?<![A-Za-z0-9_/.\[])/?(r|u)/([A-Za-z0-9_-]{2,21})(?![A-Za-z0-9_/-])")
SPOILER = re.compile(r">!(.+?)!(?:<|&lt;)")
UNESC = re.compile(r"\\([!-/:-@\[-`{-~])")
PROTECT = re.compile(r"!?\[(?:[^\[\]\\]|\\.|\[(?:[^\[\]\\]|\\.)*\])*\](?:\((?:[^()\s\\]|\\.|\((?:[^()\\]|\\.)*\))*(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)|\[(?:[^\[\]\\]|\\.)*\])|<https?://[^<>\s]*>|^\s*\[[^\]]+\]:.*$")
SUBS = {}

def sub_link(m):
    kind, name = m.group(1), m.group(2)
    if kind == "r" and name.lower() in SUBS:
        return f"[{m.group(0)}](/{SUBS[name.lower()]}/)"
    return f"[{m.group(0)}](https://www.reddit.com/{'r' if kind == 'r' else 'user'}/{name})"

def trim_url(u):
    while u:
        if u[-1] in ".,;:!?~_\\" and not (u[-1] == ";" and re.search(r"&#?\w+;$", u)):
            u = u[:-1]
        elif u[-1] == ")" and u.count(")") > u.count("("):
            u = u[:-1]
        else:
            return u
    return u

def plain(text):
    out, last = [], 0
    for m in BARE_URL.finditer(text):
        raw = trim_url(m.group(0))
        if len(raw) <= len("https://"):
            continue
        out.append(SUB_REF.sub(sub_link, text[last:m.start()]))
        url = UNESC.sub(r"\1", raw).replace("&amp;", "&")
        out.append(raw if re.search(r"[\s<>]", url) else "<" + url + ">")
        last = m.start() + len(raw)
    out.append(SUB_REF.sub(sub_link, text[last:]))
    return SPOILER.sub(r'<span class="spoiler">\1</span>', "".join(out))

def inline(text):
    out, last = [], 0
    for m in PROTECT.finditer(text):
        out.append(plain(text[last:m.start()]))
        out.append(m.group(0))
        last = m.end()
    out.append(plain(text[last:]))
    return "".join(out)

def code_spans(line):
    runs = [(m.start(), m.end()) for m in re.finditer(r"`+", line)]
    spans, i = [], 0
    while i < len(runs):
        n = runs[i][1] - runs[i][0]
        j = next((k for k in range(i + 1, len(runs)) if runs[k][1] - runs[k][0] == n), None)
        if j is None:
            i += 1
            continue
        spans.append((runs[i][0], runs[j][1]))
        i = j + 1
    return spans

def reddit(text):
    lines, fence = [], None
    for ln in text.split("\n"):
        m = FENCE.match(ln)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not ln[m.end():].strip():
                fence = None
            lines.append(ln)
            continue
        if m and not (m.group(1)[0] == "`" and "`" in ln[m.end():]):
            fence = m.group(1)
            lines.append(ln)
            continue
        if ln.startswith(("    ", "\t")):
            lines.append(ln)
            continue
        out, last = [], 0
        for a, b in code_spans(ln):
            out.append(inline(ln[last:a]))
            out.append(ln[a:b])
            last = b
        out.append(inline(ln[last:]))
        lines.append("".join(out))
    if fence:
        lines.append(fence)
    return "\n".join(lines)

def user_md(text):
    return unlink(reddit(esc(text)))

def utc(ts):
    return datetime.datetime.fromtimestamp(int(float(ts or 0)), datetime.timezone.utc)

def fmt_iso(ts):
    try:
        return utc(ts).strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return utc(0).strftime("%Y-%m-%d %H:%M:%S UTC")

def capture_time(p):
    return datetime.datetime.strptime(p.name.split("_", 1)[0], "%y%m%d%H%M%S").replace(tzinfo=datetime.timezone.utc)

def yaml_value(v):
    return UNSAFE.sub(lambda m: "\\u%04x" % ord(m.group()), json.dumps("" if v is None else v, ensure_ascii=False))

def load_lines(p):
    out = []
    with open(p, "r", encoding="utf-8") as f:
        for ln in f:
            s = ln.strip()
            if not s:
                continue
            try:
                out.append(json.loads(s))
            except Exception:
                print(f"[build] bad line in {p}", file=sys.stderr)
    return out

def expand_replies(node):
    bag = []
    rep = node.get("replies")
    if isinstance(rep, dict) and isinstance(rep.get("data"), dict):
        for c in rep["data"].get("children") or []:
            if isinstance(c, dict) and c.get("kind") == "t1":
                cd = c.get("data") or {}
                bag.append(cd)
                bag.extend(expand_replies(cd))
    return bag

def flatten_all(rows):
    flat = []
    for r in rows:
        if isinstance(r, dict) and "body" in r and "id" in r:
            flat.append(r)
            flat.extend(expand_replies(r))
        else:
            d = r.get("data") if isinstance(r, dict) else None
            if isinstance(d, dict) and "body" in d:
                flat.append(d)
                flat.extend(expand_replies(d))
    seen = set()
    uniq = []
    for r in flat:
        name = r.get("name") or ("t1_" + (r.get("id", "") or ""))
        if name in seen:
            continue
        seen.add(name)
        uniq.append(r)
    return uniq

def body_of(r):
    return (r.get("body", "") or "").strip()

def has_text(r):
    b = body_of(r)
    return bool(b) and b not in GONE

def merge_capture(best, flat):
    current = {}
    for r in flat:
        cid = r.get("id", "") or ""
        current[cid] = r
        if has_text(r) or cid not in best or not has_text(best[cid]):
            best[cid] = r
    rows = {}
    for cid, r in current.items():
        b = best[cid]
        if has_text(r) or not has_text(b):
            rows[cid] = r
        else:
            rows[cid] = dict(b, archive_state=GONE.get(body_of(r), "Gone"))
    for cid, b in best.items():
        if cid not in rows and has_text(b):
            rows[cid] = dict(b, archive_state="Gone")
    stack = list(rows.values())
    while stack:
        pid = stack.pop().get("parent_id", "") or ""
        if pid.startswith("t1_") and pid[3:] not in rows and pid[3:] in best:
            rows[pid[3:]] = best[pid[3:]]
            stack.append(rows[pid[3:]])
    return list(rows.values())

def build_tree(rows, link_fullname):
    ids = {"t1_" + (r.get("id", "") or "") for r in rows}
    by_parent = {}
    for r in rows:
        pid = r.get("parent_id", "")
        if pid != link_fullname and pid not in ids:
            pid = link_fullname
        by_parent.setdefault(pid, []).append(r)
    for k in by_parent:
        by_parent[k].sort(key=lambda x: (x.get("created_utc", 0), x.get("id", "")))
    return by_parent.get(link_fullname, []), by_parent

def chip(s):
    return " ".join(str(s).replace("`", "").split())

def meta_line(r):
    auth = r.get("author", "") or "[deleted]"
    created = fmt_iso(r.get("created_utc", 0)).replace(":00 UTC", " UTC")
    score = r.get("score", r.get("ups", 0))
    cid = r.get("id", "") or ""
    permalink = r.get("permalink", "") or ""
    tags = []
    if r.get("archive_state"):
        tags.append(r["archive_state"])
    if r.get("is_submitter", False):
        tags.append("OP")
    if r.get("distinguished") == "moderator":
        tags.append("Mod")
    elif r.get("distinguished"):
        tags.append(str(r.get("distinguished")))
    if r.get("stickied", False):
        tags.append("Stickied")
    if r.get("locked", False):
        tags.append("Locked")
    if r.get("archived", False):
        tags.append("Archived")
    flair = r.get("author_flair_text", "") or ""
    if flair:
        tags.append(flair)
    tags = [t for t in map(chip, tags) if t]
    shown = f"+{score}" if isinstance(score, (int, float)) and score >= 0 else str(score)
    head = f"**{auth}** · {created} · {shown}"
    if cid:
        head += f" · `{cid}`"
    if tags:
        head += " · " + " · ".join(f"`{t}`" for t in tags)
    if permalink:
        head += f" · [↗](https://reddit.com{permalink})"
    return head

def render_tree(nodes, by_parent):
    out = []
    for r in nodes:
        body = user_md(re.sub(r"(?m)^\t", "  ", r.get("body", "") or "")).strip("\n") or "_(no content)_"
        out += ['<div class="c">', "", meta_line(r), "", body, ""]
        out += render_tree(by_parent.get("t1_" + (r.get("id", "") or ""), []), by_parent)
        out += ["</div>", ""]
    return out

def render_comments(d, post_id):
    caps = sorted(d.glob("*.jsonl")) if d.is_dir() else []
    if not caps:
        return "", 0
    loaded = [flatten_all(load_lines(f)) for f in caps]
    live = [i for i, flat in enumerate(loaded) if flat and not any(k in flat[0] for k in ARCTIC_KEYS)]
    last = live[-1] if live else len(loaded) - 1
    best = {}
    for i, flat in enumerate(loaded):
        if i != last:
            merge_capture(best, flat)
    rows = merge_capture(best, loaded[last])
    roots, by_parent = build_tree(rows, "t3_" + post_id)
    if not roots:
        return "", len(caps)
    head = ['<div class="comments" data-pagefind-ignore>', "", f'<h2 class="comments-title">Comments / 评论 · {len(rows)}</h2>', ""]
    return "\n".join(head + render_tree(roots, by_parent) + ["</div>"]), len(caps)

def clean_html(html):
    s = re.sub(r"<!-- SC_O(?:FF|N) -->", "", html)
    s = re.sub(r'^\s*<div class="md">\s*', "", s)
    return re.sub(r"\s*</div>\s*$", "", s)

def pandoc(html):
    s = clean_html(html)
    if not s:
        return ""
    return subprocess.run(["pandoc", "-f", "html", "-t", "gfm"], input=s, capture_output=True, text=True, check=True).stdout

def post_text(d):
    s = (d.get("selftext") or "").strip()
    return bool(s) and s not in GONE

def post_state(d):
    meta = d.get("_meta") if isinstance(d.get("_meta"), dict) else {}
    kind = d.get("removed_by_category") or meta.get("removal_type")
    if kind in ("deleted", "author"):
        return "Deleted"
    if kind:
        return "Removed"
    if meta.get("was_deleted_later"):
        return "Deleted"
    return GONE.get((d.get("selftext") or "").strip(), "")

def load_post(d):
    caps = []
    for f in sorted(d.glob("*.jsonl")):
        rows = load_lines(f)
        if rows and isinstance(rows[0], dict):
            caps.append((f, rows[0]))
    return caps

def render_post(sub, d):
    caps = load_post(d)
    if not caps:
        print(f"[build] no readable capture in {d}", file=sys.stderr)
        return None
    created_id = d.name
    post_id = created_id.split("_", 1)[1]
    last = caps[-1][1]
    path, best = next((c for c in reversed(caps) if post_text(c[1])), caps[-1])
    html = best.get("selftext_html")
    body = unlink(pandoc(html)) if html else user_md(best.get("selftext") or "")
    created = int(float(best.get("created_utc") or last.get("created_utc") or 0))
    permalink = best.get("permalink") or ""
    edited = best.get("edited")
    author = next((c[1]["author"] for c in reversed(caps) if c[1].get("author") not in (None, "", "[deleted]")), "[deleted]")
    comments_dir = RAW / sub / "comments" / created_id
    comments, comment_caps = render_comments(comments_dir, post_id)
    extra = {
        "author": author,
        "subreddit": sub,
        "post_id": post_id,
        "permalink": f"https://reddit.com{permalink}" if permalink else "",
        "url": best.get("url") or "",
        "domain": best.get("domain") or "",
        "ups": best.get("ups", best.get("score", 0)),
        "upvote_ratio": best.get("upvote_ratio"),
        "num_comments": best.get("num_comments", 0),
        "link_flair_text": best.get("link_flair_text") or "",
        "over_18": bool(best.get("over_18")),
        "is_self": bool(best.get("is_self")),
        "state": post_state(last),
        "edited": fmt_iso(edited) if isinstance(edited, (int, float)) and not isinstance(edited, bool) and edited else "",
        "source": "Arctic Shift" if any(k in best for k in ARCTIC_KEYS) else "Reddit API",
        "captured": capture_time(path).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "versions": len(caps),
        "raw": f"data/raw/{d.relative_to(RAW).as_posix()}",
        "raw_comments": f"data/raw/{comments_dir.relative_to(RAW).as_posix()}" if comment_caps else "",
    }
    lines = ["---", f"title: {yaml_value(best.get('title') or created_id)}", f"date: {utc(created).isoformat()}", "extra:"]
    lines += [f"  {k}: {yaml_value(v)}" for k, v in extra.items()]
    lines.append("---\n")
    text = "\n".join(lines) + "\n" + (body + "\n" if body else "")
    if comments:
        text += "\n" + comments + "\n"
    return created, text

def write(p, s):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s.encode("utf-16", "surrogatepass").decode("utf-16", "replace"), encoding="utf-8")

def front(fields, extra=None):
    lines = ["---"] + [f"{k}: {yaml_value(v)}" for k, v in fields.items()]
    if extra:
        lines.append("extra:")
        lines += [f"  {k}: {yaml_value(v)}" for k, v in extra.items()]
    return "\n".join(lines + ["---", ""])

def stats(sub, created, now):
    width = 28 * 86400
    points = [0] * 13
    for c in created:
        k = int((now - c) // width)
        if 0 <= k < 13:
            points[12 - k] += 1
    top = max(points)
    last = max(created)
    days = (now - last) / 86400
    return {
        "name": sub,
        "path": f"{sub}/_index.md",
        "count": len(created),
        "last_date": utc(last).strftime("%Y-%m-%d"),
        "status": "active" if days < 7 else "quiet" if days < 30 else "archived",
        "trend": [math.ceil(p / top * 20) if top else 0 for p in points],
    }

def build():
    if CONTENT.exists():
        shutil.rmtree(CONTENT)
    now = time.time()
    subs = []
    SUBS.update({p.name[2:].lower(): p.name for p in RAW.glob("r_*") if p.is_dir()})
    for sub_dir in sorted(p for p in RAW.glob("r_*") if p.is_dir()):
        sub = sub_dir.name
        created = []
        for d in sorted(p for p in (sub_dir / "submissions").glob("*") if p.is_dir()):
            out = render_post(sub, d)
            if out is None:
                continue
            created.append(out[0])
            write(CONTENT / sub / f"{d.name}.md", out[1])
        if not created:
            continue
        write(CONTENT / sub / "_index.md", front({"title": sub, "sort_by": "date", "transparent": True}))
        counts = {}
        for c in created:
            counts[utc(c).year] = counts.get(utc(c).year, 0) + 1
        years = [{"year": y, "count": n, "path": f"{sub}/archive/{y}/_index.md"} for y, n in sorted(counts.items(), reverse=True)]
        write(CONTENT / sub / "archive" / "_index.md", front({"title": f"{sub} Archive", "template": "archive.html"}, {"section_path": f"{sub}/_index.md", "year": 0, "years": years}))
        for y in years:
            write(CONTENT / sub / "archive" / str(y["year"]) / "_index.md", front({"title": f"{sub} {y['year']}", "template": "archive.html"}, {"section_path": f"{sub}/_index.md", "year": y["year"], "years": years}))
        subs.append(stats(sub, created, now))
        print(f"[build] {sub} posts={len(created)}")
    subs.sort(key=lambda x: x["name"].lower())
    write(CONTENT / "_index.md", front({"title": "Reddit Archive", "sort_by": "date", "template": "index.html"}, {"subs": subs}))
    write(CONTENT / "search" / "_index.md", front({"title": "Search / 搜索", "template": "search.html"}))

if __name__ == "__main__":
    build()
