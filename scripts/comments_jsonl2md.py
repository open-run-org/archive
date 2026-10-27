import os, sys, json, pathlib, argparse, datetime, glob

def fmt_iso(ts):
    try:
        v = int(float(ts or 0))
    except Exception:
        v = 0
    return datetime.datetime.fromtimestamp(v, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

def load_lines(p):
    out=[]
    with open(p,"r",encoding="utf-8") as f:
        for ln in f:
            s=ln.strip()
            if not s: continue
            try:
                out.append(json.loads(s))
            except Exception:
                pass
    return out

def expand_replies(node):
    bag=[]
    rep = node.get("replies")
    if isinstance(rep, dict) and rep.get("kind") and isinstance(rep.get("data"), dict):
        ch = rep["data"].get("children") or []
        for c in ch:
            if not isinstance(c, dict): continue
            if c.get("kind") != "t1":
                continue
            cd = c.get("data") or {}
            bag.append(cd)
            bag.extend(expand_replies(cd))
    return bag

def flatten_all(rows):
    flat=[]
    for r in rows:
        if isinstance(r, dict) and "body" in r and "id" in r:
            flat.append(r)
            flat.extend(expand_replies(r))
        else:
            d = r.get("data") if isinstance(r, dict) else None
            if isinstance(d, dict) and "body" in d:
                flat.append(d)
                flat.extend(expand_replies(d))
    seen=set()
    uniq=[]
    for r in flat:
        name = r.get("name") or ("t1_"+(r.get("id","") or ""))
        if name in seen: continue
        seen.add(name)
        uniq.append(r)
    return uniq

GONE = {"[removed]": "Removed", "[ Removed by Reddit ]": "Removed", "[deleted]": "Deleted"}

def body_of(r):
    return (r.get("body","") or "").strip()

def has_text(r):
    b = body_of(r)
    return bool(b) and b not in GONE

def merge_capture(best, flat):
    current={}
    for r in flat:
        cid = r.get("id","") or ""
        current[cid] = r
        if has_text(r) or cid not in best or not has_text(best[cid]):
            best[cid] = r
    rows={}
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
        pid = stack.pop().get("parent_id","") or ""
        if pid.startswith("t1_") and pid[3:] not in rows and pid[3:] in best:
            rows[pid[3:]] = best[pid[3:]]
            stack.append(rows[pid[3:]])
    return list(rows.values())

def build_tree(rows, link_fullname):
    ids = {"t1_"+(r.get("id","") or "") for r in rows}
    by_parent={}
    for r in rows:
        pid = r.get("parent_id","")
        if pid != link_fullname and pid not in ids:
            pid = link_fullname
        by_parent.setdefault(pid,[]).append(r)
    for k in by_parent:
        by_parent[k].sort(key=lambda x: (x.get("created_utc",0), x.get("id","")))
    roots = by_parent.get(link_fullname,[])
    roots.sort(key=lambda x: (x.get("created_utc",0), x.get("id","")))
    return roots, by_parent

def qprefix(depth):
    return ">"*depth + " "

def meta_lines(r, depth):
    p = qprefix(depth)
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

    head = f"**{auth}** · {created} · +{score}"
    if cid:
        head += f" · `{cid}`"
    if tags:
        head += " · " + " · ".join(f"`{t}`" for t in tags)
    if permalink:
        head += f' · [↗](https://reddit.com{permalink})'

    return [p + head]

def render_one(r, depth):
    lines = []
    lines += meta_lines(r, depth)
    lines.append(">"*depth)
    body = (r.get("body","") or "").splitlines()
    if not body:
        body = ["_(no content)_"]
    bp = qprefix(depth)
    for ln in body:
        lines.append(f"{bp}{ln}")
    return lines

def render_tree(nodes, by_parent, depth):
    out=[]
    for idx, r in enumerate(nodes):
        out += render_one(r, depth)
        child_key = "t1_"+(r.get("id","") or "")
        ch = by_parent.get(child_key, [])
        if ch:
            out.append("")
            out += render_tree(ch, by_parent, depth+1)
        if idx != len(nodes)-1:
            out.append("")
    while out and out[-1]=="":
        out.pop()
    return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("in_root")
    ap.add_argument("out_root")
    ap.add_argument("--days", type=int, default=64)
    args=ap.parse_args()
    
    in_root=pathlib.Path(args.in_root)
    out_root=pathlib.Path(args.out_root)
    
    cutoff_dt = datetime.datetime.now() - datetime.timedelta(days=args.days)
    cutoff_str = cutoff_dt.strftime("%y%m%d%H%M%S")
    
    dirs=sorted(d for d in in_root.glob("r_*/comments/*") if d.is_dir())
    total=len(dirs)

    for i,d in enumerate(dirs,1):
        created_id = d.name
        ts_part = created_id.split("_")[0]

        if ts_part < cutoff_str:
            continue

        sub=d.parts[-3]
        post_id=created_id.split("_",1)[1]
        link="t3_"+post_id
        best={}

        for f in sorted(d.glob("*.jsonl")):
            rows=merge_capture(best, flatten_all(load_lines(f)))
            roots, by_parent = build_tree(rows, link)
            lines=render_tree(roots, by_parent, 1)

            out_dir=out_root/sub/"comments"/created_id
            out_dir.mkdir(parents=True, exist_ok=True)
            out_file=out_dir/(f.stem+".md")
            with open(out_file,"w",encoding="utf-8") as w:
                w.write("\n".join(lines).rstrip()+"\n")
            sys.stdout.write(f"[mdc] ({i}/{total}) {f} -> {out_file} roots={len(roots)} total={len(rows)}\n")

if __name__=="__main__":
    main()
