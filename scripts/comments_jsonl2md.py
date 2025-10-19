import os, sys, json, pathlib, argparse, datetime

def fmt_iso(ts):
    return datetime.datetime.fromtimestamp(int(float(ts)), datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

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

def build_tree(rows, link_fullname):
    children={}
    roots=[]
    for r in rows:
        pid=r.get("parent_id","")
        if pid==link_fullname:
            roots.append(r)
        else:
            children.setdefault(pid,[]).append(r)
    for k in children:
        children[k].sort(key=lambda x: x.get("created_utc",0))
    roots.sort(key=lambda x: x.get("created_utc",0))
    return roots, children

def render_comment(r, idx, depth):
    a=r.get("author","")
    b=r.get("body","") or ""
    t=fmt_iso(r.get("created_utc",0))
    s=r.get("score","")
    cid=r.get("id","")
    head=[f"Comment {idx}","","- Author: "+a,"- Created: "+t,"- Score: "+str(s),f"- ID: {cid}",""]
    body=[("> " * depth)+ln if ln else "" for ln in b.splitlines()]
    return "\n".join(head+body)+("\n" if body and body[-1] else "\n")

def render_tree(roots, children, depth=1, start_idx=1, acc=None):
    if acc is None: acc=[]
    i=start_idx
    for r in roots:
        acc.append(render_comment(r, i, depth))
        i+=1
        ch=children.get("t1_"+r.get("id",""),[])
        if ch:
            render_tree(ch, children, depth+1, 1, acc)
    return acc

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("in_root")
    ap.add_argument("out_root")
    args=ap.parse_args()
    in_root=pathlib.Path(args.in_root)
    out_root=pathlib.Path(args.out_root)
    files=sorted(in_root.glob("r_*/comments/*/*.jsonl"))
    for f in files:
        sub=f.parts[-4]
        created_id=f.parts[-2]
        cap=f.stem
        rows=load_lines(f)
        link="t3_"+created_id.split("_",1)[1]
        roots, children = build_tree(rows, link)
        lines=[]
        idx=1
        for r in roots:
            lines.append(render_comment(r, idx, 1))
            idx+=1
            ch=children.get("t1_"+r.get("id",""),[])
            if ch:
                lines.extend(render_tree(ch, children, 2, 1))
        out_dir=out_root/sub/"comments"/created_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file=out_dir/(cap+".md")
        with open(out_file,"w",encoding="utf-8") as w:
            w.write("\n".join(lines).rstrip()+"\n")
        sys.stdout.write(f"[cmd] {f} -> {out_file}\n")

if __name__=="__main__":
    main()
