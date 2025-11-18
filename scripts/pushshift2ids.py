import sys, argparse, glob, json, gzip, io

def norm_sub(s):
    s=s.strip().lower()
    if s.startswith("r/"): s=s[2:]
    if s.startswith("r_"): s=s[2:]
    return s

def open_any(p):
    if p.endswith(".gz"): return gzip.open(p,"rt",encoding="utf-8",errors="ignore")
    return open(p,"r",encoding="utf-8",errors="ignore")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--sub", required=True)
    ap.add_argument("--in-glob", required=True)
    args=ap.parse_args()
    target=norm_sub(args.sub)
    paths=sorted(glob.glob(args.in_glob))
    found=0
    for p in paths:
        with open_any(p) as f:
            for ln in f:
                ln=ln.strip()
                if not ln: continue
                try:
                    o=json.loads(ln)
                except Exception:
                    continue
                s=o.get("subreddit","") or o.get("subreddit_name_prefixed","")
                ss=norm_sub(s.replace("r/",""))
                if ss!=target: continue
                iid=o.get("id","")
                cu=o.get("created_utc",0)
                if iid and cu:
                    sys.stdout.write(f"{iid}\t{int(float(cu))}\n")
                    found+=1
    sys.stderr.write(f"[ids] {target} {found}\n")

if __name__=="__main__":
    main()
