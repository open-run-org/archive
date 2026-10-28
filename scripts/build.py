import datetime
import hashlib
import html
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys
import time

import media

RAW = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/raw")
CONTENT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "content")
MEDIA = RAW.parent / "media"

GONE = {"[removed]": "Removed", "[ Removed by Reddit ]": "Removed", "[deleted]": "Deleted"}
TAG = re.compile(r"<(?=[A-Za-z/!?])")
EMPTY_LINK = re.compile(r"\]\([\s>]*(?:<[\s>]*>)?[\s>]*(?:\"[^\"\n]*\"|'[^'\n]*')?[\s>]*\)")
EMPTY_REF = re.compile(r"^((?:[ \t]*>)*[ \t]*\[[^\]\n]+\]):(?=[ \t]*(?:<[ \t]*>)?[ \t]*(?:\"[^\"\n]*\"|'[^'\n]*'|\([^)\n]*\))?[ \t]*$)", re.M)
UNSAFE = re.compile("[\x7f-\x9f\u2028\u2029\ufffe\uffff]")
ARCTIC_KEYS = ("_meta", "retrieved_on", "retrieved_utc")
ID = re.compile(r"[a-z0-9]{1,16}")

def esc(s):
    return TAG.sub("&lt;", s)

def unlink(s):
    s = EMPTY_LINK.sub(lambda m: "]\\" + m.group(0)[1:], s)
    return EMPTY_DEST.sub(r"\1&lt;>", EMPTY_REF.sub(r"\1\\:", s))

OPEN = re.compile(r"^( {0,3}(?:(?:[-*+]|\d{1,9}[.)]) {1,4})?)(`{3,}|~{3,})")
ITEM = re.compile(r"^ {0,3}(?:[-*+]|\d{1,9}[.)]) {1,4}")
CLOSE = re.compile(r" {0,3}(`{3,}|~{3,})[ \t]*$")
ATTRS = re.compile(r"\}([ \t#]*)$")
EMPTY_DEST = re.compile(r"(\]\(\s*|\]:\s*)<>")
BARE_URL = re.compile(r"(?<![A-Za-z0-9_/\[<\"'=@&])(?<!\]\()https?://[^\s<>\"'\[\]*，。、！？；：「」『』（）【】《》]+")
SUB_REF = re.compile(r"(?<![A-Za-z0-9_/.\[])/?(r|u)/([A-Za-z0-9_-]{2,21})(?![A-Za-z0-9_/-])")
SPOILER = re.compile(r">!(.+?)(?<!\\)!(?:<|&lt;)")
UNESC = re.compile(r"\\([!-/:-@\[-`{-~])")
PROTECT = re.compile(r"!?\[(?:[^\[\]\\]|\\.|\[(?:[^\[\]\\]|\\.)*\])*\](?:\((?:[^()\s\\]|\\.|\((?:[^()\\]|\\.)*\))*(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)|\[(?:[^\[\]\\]|\\.)*\])|<https?://[^<>\s]*>|^\s*\[[^\]]+\]:.*$")
SUBS = {}
ASSETS = {}
IMG_AUTO = re.compile(r"<(https?://(?:i|preview)\.redd\.it/([a-z0-9]+)\.(?:jpe?g|png|gif|webp)(?:[?#][^<>\s]*)?)>", re.I)
IMG_LINK = re.compile(r"(!?)\[((?:[^\[\]\n\\]|\\.)*)\]\((https?://(?:i|preview)\.redd\.it/([a-z0-9]+)\.(?:jpe?g|png|gif|webp)(?:[?#][^()\s]*)?)\)", re.I)
PLAYER = re.compile(r"<https?://(?:www\.)?reddit\.com/link/[a-z0-9]+/video/([a-z0-9]+)/player/?>", re.I)
MEDIA_REF = re.compile(r"!\[([^\[\]\n]*)\]\((giphy\|)?([A-Za-z0-9]+)(?:\|[A-Za-z0-9_]+)?\)")
IMAGE_MD = re.compile(r"(?<!\\)!\[([^\[\]\n]*)\]\(([^()\s]*)\)")

def sub_link(m):
    kind, name = m.group(1), m.group(2)
    href = f"/{SUBS[name.lower()]}/" if kind == "r" and name.lower() in SUBS else f"https://www.reddit.com/{'r' if kind == 'r' else 'user'}/{name}"
    return f'<a href="{href}">{m.group(0)}</a>'

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
    text = SPOILER.sub(r'<span class="spoiler">\1</span>', text)
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
    return "".join(out)

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

def no_attrs(ln):
    return ATTRS.sub(r"&#125;\1", ln)

def blocks(text, fn):
    lines, fence, col, item = [], None, 0, 0
    for ln in re.sub(r"\r\n?", "\n", text).split("\n"):
        ind = len(ln) - len(ln.lstrip(" "))
        if fence:
            if ln.strip() and ind < col:
                fence = None
            else:
                m = CLOSE.match(ln[col:])
                if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                    fence = None
                lines.append(ln)
                continue
        im = ITEM.match(ln)
        if im:
            item = im.end()
        elif ln.strip() and ind < item:
            item = 0
        base = item if item and ind >= item and not im else 0
        m = OPEN.match(ln[base:])
        if m and not (m.group(2)[0] == "`" and "`" in ln[base + m.end():]):
            fence = m.group(2)
            col = base + (len(m.group(1)) if ITEM.match(m.group(1)) else 0)
            lines.append(ln)
            continue
        lines.append(ln if ln.startswith("\t") or ind - (item if item and ind >= item else 0) >= 4 else fn(ln))
    if fence:
        lines.append(" " * col + fence)
    return "\n".join(lines)

def line_md(ln):
    out, last = [], 0
    for a, b in code_spans(ln):
        out.append(inline(ln[last:a]))
        out.append(ln[a:b])
        last = b
    out.append(inline(ln[last:]))
    return no_attrs("".join(out))

def reddit(text):
    return blocks(text, line_md)

def user_md(text):
    if text.strip() in GONE:
        return text.strip().replace("[", "\\[").replace("]", "\\]")
    return unlink(reddit(esc(text)))

def asset(mid):
    r = ASSETS.get(mid)
    return r if r and r.get("key") else None

def media_tag(r):
    url = html.escape(f"{media.PUBLIC}/{r['key']}")
    size = f' width="{int(r["w"])}" height="{int(r["h"])}"' if r.get("w") and r.get("h") else ""
    if str(r.get("type", "")).startswith("video/"):
        return f'<video controls preload="metadata" playsinline src="{url}"{size}></video>'
    return f'<a href="{url}"><img src="{url}" alt="" loading="lazy" decoding="async"{size}></a>'

def embed(md, used, meta=None):
    def swap(mid, fallback):
        r = asset(mid)
        if not r:
            return fallback
        used.add(mid)
        return media_tag(r)
    def link(m):
        r = asset(m.group(4))
        text = UNESC.sub(r"\1", m.group(2)).strip()
        if not r:
            return m.group(0)
        used.add(m.group(4))
        same = re.match(r"https?://(?:i|preview)\.redd\.it/" + re.escape(m.group(4)) + r"\.", text, re.I)
        return media_tag(r) if m.group(1) or not text or same else f"[{m.group(2)}]({media.PUBLIC}/{r['key']})"
    def ref(m):
        alt, mid = m.group(1) or "image", m.group(3)
        if m.group(2):
            return f"[{alt}](https://giphy.com/gifs/{mid})"
        it = media.from_meta(mid, (meta or {}).get(mid))
        return swap(mid, f"[{alt}]({it['src']})" if it else f"_({alt})_")
    def text(s):
        s = PLAYER.sub(lambda m: swap(m.group(1), m.group(0)), s)
        s = IMG_AUTO.sub(lambda m: swap(m.group(2), m.group(0)), s)
        s = MEDIA_REF.sub(ref, IMG_LINK.sub(link, s))
        return IMAGE_MD.sub(lambda m: f"[{m.group(1) or 'image'}]({m.group(2)})" if re.match(r"https?://", m.group(2)) else f"_({m.group(1) or 'image'})_", s)
    def line(ln):
        out, last = [], 0
        for a, b in code_spans(ln):
            out += [text(ln[last:a]), ln[a:b]]
            last = b
        return "".join(out) + text(ln[last:])
    return blocks(md, line)

def media_block(items):
    figs = []
    for it in items:
        cap = html.escape(it.get("caption") or "")
        link = it.get("link") or ""
        if re.fullmatch(r"https?://[^\s\"'<>]+", link):
            a = f'<a href="{html.escape(link)}" rel="nofollow noopener" target="_blank">{html.escape(link)}</a>'
            cap = f"{cap} · {a}" if cap and it.get("caption") != link else a
        figs.append(f"<figure>{media_tag(asset(it['id']))}" + (f"<figcaption>{cap}</figcaption>" if cap else "") + "</figure>")
    return f'<div class="media" data-pagefind-ignore>{"".join(figs)}</div>' if figs else ""

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

def merge_capture(best, flat, since=None):
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
            rows[cid] = b if since is not None and ts_of(b) > since else dict(b, archive_state="Gone")
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
        by_parent[k].sort(key=lambda x: (-num_score(x), -ts_of(x), x.get("id", "") or ""))
    return by_parent.get(link_fullname, []), by_parent

def chip(s):
    return " ".join(str(s).replace("`", "").split())

def hue(name):
    return int(hashlib.sha1(name.lower().encode()).hexdigest()[:6], 16) % 360

def initial(name):
    return next((ch for ch in name if ch.isalnum()), "?").upper()

def user_html(name, op=False):
    text = html.escape(name or "[deleted]")
    if name in ("", "[deleted]"):
        return f'<b class="user gone">{text}</b>'
    return f'<b class="user{" op" if op else ""}" style="--h:{hue(name)}" data-i="{initial(name)}">{text}</b>'

def ts_of(r):
    try:
        return int(float(r.get("created_utc") or 0))
    except (TypeError, ValueError):
        return 0

def num_score(r):
    s = r.get("score", r.get("ups", 0))
    return int(s) if isinstance(s, (int, float)) and not isinstance(s, bool) else 0

def tag(text, kind=""):
    return f'<span class="tag{" " + kind if kind else ""}">{html.escape(text)}</span>'

def score_html(r):
    s = r.get("score", r.get("ups", 0))
    if r.get("score_hidden") or not isinstance(s, (int, float)) or isinstance(s, bool):
        return '<span class="score" title="Score hidden">?</span>'
    s = int(s)
    hot = " hot" if abs(s) >= 100 else ""
    if s < 0:
        return f'<span class="score down{hot}">▼ {-s}</span>'
    return f'<span class="score{" up" if s else ""}{hot}">▲ {s}</span>'

def meta_html(r, pid):
    tags = []
    if r.get("is_submitter"):
        tags.append(tag("OP", "op"))
    if r.get("distinguished") == "moderator":
        tags.append(tag("Mod", "mod"))
    elif r.get("distinguished"):
        tags.append(tag(str(r["distinguished"])))
    if r.get("stickied"):
        tags.append(tag("Stickied"))
    if r.get("locked"):
        tags.append(tag("Locked"))
    if r.get("archive_state"):
        tags.append(tag(r["archive_state"], "state"))
    flair = chip(r.get("author_flair_text", "") or "")
    if flair:
        tags.append(tag(flair, "flair"))
    cid = r.get("id", "") or ""
    when = utc(ts_of(r)).strftime("%Y-%m-%d %H:%M UTC")
    if ID.fullmatch(cid) and ID.fullmatch(pid):
        when = f'<a class="when" href="https://reddit.com/comments/{pid}/_/{cid}/">{when}</a>'
    else:
        when = f'<span class="when">{when}</span>'
    return f'<div class="meta">{score_html(r)}{user_html(r.get("author", "") or "[deleted]", bool(r.get("is_submitter")))}{"".join(tags)}{when}</div>'

def render_tree(nodes, by_parent, pid):
    out = []
    for r in nodes:
        kids = by_parent.get("t1_" + (r.get("id", "") or ""), [])
        body = embed(user_md(re.sub(r"(?m)^\t", "  ", r.get("body", "") or "")), set(), r.get("media_metadata") if isinstance(r.get("media_metadata"), dict) else None).strip("\n") or "_(no content)_"
        out += [f'<div class="c{" folded" if kids else ""}">', "", meta_html(r, pid), "", body, ""]
        out += render_tree(kids, by_parent, pid)
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
    rows = merge_capture(best, loaded[last], capture_time(caps[last]).timestamp() if live else None)
    roots, by_parent = build_tree(rows, "t3_" + post_id)
    if not roots:
        return "", len(caps)
    head = ['<div class="comments" data-pagefind-ignore>', "", f'<div class="comments-head"><h2>Comments / 评论 · {len(rows)}</h2></div>', ""]
    return "\n".join(head + render_tree(roots, by_parent, post_id) + ["</div>"]), len(caps)

def clean_html(markup):
    s = re.sub(r"<!-- SC_O(?:FF|N) -->", "", markup)
    s = re.sub(r'^\s*<div class="md">\s*', "", s)
    return re.sub(r"\s*</div>\s*$", "", s)

def pandoc(markup):
    s = clean_html(markup)
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
    markup = best.get("selftext_html")
    body = unlink(blocks(pandoc(markup), no_attrs)) if markup else user_md(best.get("selftext") or "")
    used = set()
    body = embed(body, used, best.get("media_metadata") if isinstance(best.get("media_metadata"), dict) else None)
    block = media_block([it for it in media.post_media([c[1] for c in caps]) if asset(it["id"]) and it["id"] not in used])
    if block:
        body = f"{body.rstrip()}\n\n{block}" if best.get("is_self") and body.strip() else f"{block}\n\n{body}"
    created = int(float(best.get("created_utc") or last.get("created_utc") or 0))
    permalink = best.get("permalink") or ""
    edited = best.get("edited")
    author = next((c[1]["author"] for c in reversed(caps) if c[1].get("author") not in (None, "", "[deleted]")), "[deleted]")
    comments_dir = RAW / sub / "comments" / created_id
    comments, comment_caps = render_comments(comments_dir, post_id)
    extra = {
        "author": author,
        "author_hue": hue(author) if author != "[deleted]" else 0,
        "author_initial": initial(author) if author != "[deleted]" else "",
        "subreddit": sub,
        "sub_label": label(sub),
        "post_id": post_id,
        "permalink": f"https://reddit.com{permalink}" if permalink else "",
        "url": best.get("url") or "",
        "domain": best.get("domain") or "",
        "ups": best.get("ups", best.get("score", 0)),
        "vote": ("up hot" if num_score(best) >= 100 else "up") if num_score(best) > 0 else "",
        "upvote_ratio": best.get("upvote_ratio"),
        "upvote_pct": f"{round(best['upvote_ratio'] * 100)}%" if isinstance(best.get("upvote_ratio"), (int, float)) else "",
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
    text = (body + "\n" if body else "") + ("\n" + comments + "\n" if comments else "")
    return created, best.get("title") or created_id, extra, text

def page(title, created, extra, text):
    lines = ["---", f"title: {yaml_value(title)}", f"date: {utc(created).isoformat()}", "extra:"]
    lines += [f"  {k}: {yaml_value(v)}" for k, v in extra.items()]
    return "\n".join(lines + ["---", "", text])

def neighbours(seq):
    before = cur = None
    for item in seq:
        if cur is not None:
            yield before, cur, item
            before = cur
        cur = item
    if cur is not None:
        yield before, cur, None

def label(sub):
    return "r/" + sub[2:]

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
        "label": label(sub),
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
    ASSETS.update(media.load_manifest(MEDIA))
    for sub_dir in sorted(p for p in RAW.glob("r_*") if p.is_dir()):
        sub = sub_dir.name
        created = []
        dirs = sorted(p for p in (sub_dir / "submissions").glob("*") if p.is_dir())
        rendered = ((d.name, out) for d in dirs if (out := render_post(sub, d)) is not None)
        for older, (name, (ts, title, extra, text)), newer in neighbours(rendered):
            extra["newer"] = f"{sub}/{newer[0]}.md" if newer else ""
            extra["newer_title"] = newer[1][1] if newer else ""
            extra["older"] = f"{sub}/{older[0]}.md" if older else ""
            extra["older_title"] = older[1][1] if older else ""
            created.append(ts)
            write(CONTENT / sub / f"{name}.md", page(title, ts, extra, text))
        if not created:
            continue
        write(CONTENT / sub / "_index.md", front({"title": label(sub), "sort_by": "date", "transparent": True}))
        counts = {}
        for c in created:
            counts[utc(c).year] = counts.get(utc(c).year, 0) + 1
        years = [{"year": y, "count": n, "path": f"{sub}/archive/{y}/_index.md"} for y, n in sorted(counts.items(), reverse=True)]
        write(CONTENT / sub / "archive" / "_index.md", front({"title": f"{label(sub)} Archive", "template": "archive.html"}, {"section_path": f"{sub}/_index.md", "year": 0, "years": years}))
        for y in years:
            write(CONTENT / sub / "archive" / str(y["year"]) / "_index.md", front({"title": f"{label(sub)} {y['year']}", "template": "archive.html"}, {"section_path": f"{sub}/_index.md", "year": y["year"], "years": years}))
        subs.append(stats(sub, created, now))
        print(f"[build] {sub} posts={len(created)}")
    subs.sort(key=lambda x: x["name"].lower())
    write(CONTENT / "_index.md", front({"title": "Reddit Archive", "sort_by": "date", "template": "index.html"}, {"subs": subs}))
    write(CONTENT / "search" / "_index.md", front({"title": "Search / 搜索", "template": "search.html"}))

if __name__ == "__main__":
    build()
