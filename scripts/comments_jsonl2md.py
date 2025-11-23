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

def build_tree(rows, link_fullname):
    by_parent={}
    for r in rows:
        pid = r.get("parent_id","")
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
    auth = r.get("author","") or ""
    created = fmt_iso(r.get("created_utc",0))
    score = r.get("score", r.get("ups", 0))
    cid = r.get("id","")
    ups = r.get("ups", "")
    downs = r.get("downs", "")
    is_submitter = r.get("is_submitter", False)
    distinguished = r.get("distinguished", None)
    stickied = r.get("stickied", False)
    archived = r.get("archived", False)
    locked = r.get("locked", False)
    controversiality = r.get("controversiality", 0)
    gilded = r.get("gilded", 0)
    tawards = r.get("total_awards_received", 0)
    aflair = r.get("author_flair_text", "")
    aflair_css = r.get("author_flair_css_class", "")
    aflair_color = r.get("author_flair_text_color", "")
    apremium = r.get("author_premium", False)
    permalink = r.get("permalink","")
    lines = [
        f"{p}- Author: {auth}",
        f"{p}- Created: {created}",
        f"{p}- Score: {score}",
        f"{p}- ID: {cid}",
    ]
    extra = []
    if ups != "": extra.append(f"Ups={ups}")
    if downs != "": extra.append(f"Downs={downs}")
    if is_submitter: extra.append("Submitter=true")
    if distinguished: extra.append(f"Distinguished={distinguished}")
    if stickied: extra.append("Stickied=true")
    if archived: extra.append("Archived=true")
    if locked: extra.append("Locked=true")
    if controversiality: extra.append(f"Controversiality={controversiality}")
    if gilded: extra.append(f"Gilded={gilded}")
    if tawards: extra.append(f"Awards={tawards}")
    if aflair: extra.append(f"Flair={aflair}")
    if aflair_css: extra.append(f"FlairCSS={aflair_css}")
    if aflair_color: extra.append(f"FlairColor={aflair_color}")
    if apremium: extra.append("AuthorPremium=true")
    if permalink: extra.append(f"Permalink={permalink}")
    if extra:
        lines.append(p + "- " + " | ".join(extra))
    return lines

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
    
    files=sorted(in_root.glob("r_*/comments/*/*.jsonl"))
    total=len(files)
    
    for i,f in enumerate(files,1):
        created_id = f.parent.name
        ts_part = created_id.split("_")[0]
        
        if ts_part < cutoff_str:
            continue
            
        cap=f.stem
        sub=f.parts[-4]
        
        rows=load_lines(f)
        flat=flatten_all(rows)
        post_id=created_id.split("_",1)[1]
        link="t3_"+post_id
        roots, by_parent = build_tree(flat, link)
        lines=render_tree(roots, by_parent, 1)
        
        out_dir=out_root/sub/"comments"/created_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file=out_dir/(cap+".md")
        with open(out_file,"w",encoding="utf-8") as w:
            w.write("\n".join(lines).rstrip()+"\n")
        sys.stdout.write(f"[mdc] ({i}/{total}) {f} -> {out_file} roots={len(roots)} total_flat={len(flat)}\n")

if __name__=="__main__":
    main()
