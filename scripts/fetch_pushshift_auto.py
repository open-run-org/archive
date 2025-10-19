import os, sys, argparse, subprocess, pathlib, re, datetime, shutil

DEF_SUBS_MAGNET = os.environ.get("AT_MONTHLY_SUBS_MAGNET", "magnet:?xt=urn:btih:30dee5f0406da7a353aff6a8caa2d54fd01f2ca1")
DEF_COMMENTS_MAGNET = os.environ.get("AT_MONTHLY_COMMENTS_MAGNET", "magnet:?xt=urn:btih:30dee5f0406da7a353aff6a8caa2d54fd01f2ca1")
DEF_TRACKERS = os.environ.get("AT_TRACKERS", "udp://tracker.opentrackr.org:1337/announce,udp://tracker.torrent.eu.org:451/announce,udp://open.stealth.si:80/announce,udp://explodie.org:6969/announce")

def month_iter(since, until):
    y1,m1=map(int,since.split("-")); y2,m2=map(int,until.split("-"))
    d=datetime.date(y1,m1,1); e=datetime.date(y2,m2,1)
    while d<=e:
        yield f"{d.year:04d}-{d.month:02d}"
        d=(d.replace(day=28)+datetime.timedelta(days=4)).replace(day=1)

def bdecode(data, i=0):
    def read_int(j):
        k=data.index(b'e', j)
        v=int(data[j:k])
        return v, k+1
    if data[i:i+1]==b'i':
        v, j = read_int(i+1)
        return v, j
    if data[i:i+1]==b'l':
        out=[]; j=i+1
        while data[j:j+1]!=b'e':
            v,j=bdecode(data,j)
            out.append(v)
        return out, j+1
    if data[i:i+1]==b'd':
        out={}; j=i+1
        while data[j:j+1]!=b'e':
            k,j=bdecode(data,j)
            v,j=bdecode(data,j)
            out[k]=v
        return out, j+1
    if data[i:i+1].isdigit():
        k=i
        while data[k:k+1]!=b':':
            k+=1
        ln=int(data[i:k]); j=k+1
        s=data[j:j+ln]
        return s, j+ln
    raise ValueError("bad bencode")

def read_torrent_files(tpath):
    raw=pathlib.Path(tpath).read_bytes()
    tor,_=bdecode(raw,0)
    info=tor[b'info']
    files=info.get(b'files')
    if files is None:
        name=info[b'name'].decode('utf-8','ignore')
        length=info[b'length']
        return [(1, f"./{name}", length)]
    out=[]
    idx=1
    for f in files:
        length=f[b'length']
        parts=[p.decode('utf-8','ignore') for p in f[b'path']]
        path="./"+"/".join(parts)
        out.append((idx, path, length))
        idx+=1
    return out

def magnet_to_torrent(magnet, out_dir, trackers):
    pathlib.Path(out_dir).mkdir(parents=True, exist_ok=True)
    cmd = [
        "aria2c",
        "--bt-metadata-only=true",
        "--bt-save-metadata=true",
        "--disable-ipv6=true",
        "--enable-dht=true",
        "--dht-listen-port=6914",
        "--listen-port=6922",
    ]
    if trackers:
        cmd += ["--bt-tracker", trackers]
    cmd += ["-d", out_dir, magnet]
    subprocess.check_call(cmd)
    ih = magnet.split("btih:", 1)[1].split("&", 1)[0].lower()
    tpath = os.path.join(out_dir, ih + ".torrent")
    if not os.path.exists(tpath):
        raise RuntimeError("torrent not saved")
    return ih, tpath

def build_index(files, kind):
    idx_by_month={}
    avail=set()
    if kind=="subs":
        pat=re.compile(r"(?i)/submissions/rs_(\d{4}-\d{2})\.")
    else:
        pat=re.compile(r"(?i)/comments/rc_(\d{4}-\d{2})\.")
    for idx, path, _ in files:
        p=path.replace("\\","/").lower()
        m=pat.search(p)
        if not m: continue
        mon=m.group(1)
        avail.add(mon)
        idx_by_month.setdefault(mon, []).append(str(idx))
    return avail, idx_by_month

def existing_months(base_dir, kind):
    have=set()
    root=os.path.join(base_dir, "submissions" if kind=="subs" else "comments")
    if not os.path.isdir(root):
        return have
    for fn in os.listdir(root):
        s=fn.lower()
        m=re.search(r"(rs|rc)_(\d{4}-\d{2})\.(ndjson|json)$", s)
        if m: have.add(m.group(2))
    return have

def select_csv_for_pending(idx_by_month, months):
    sel=[]
    for m in months:
        sel+=idx_by_month.get(m,[])
    return ",".join(sorted(set(sel), key=lambda x:int(x)))

def run_aria_select(torrent_path, out_dir, select_csv, concurrency, log_level="info", summary=2, chunk_size=0):
    if not select_csv:
        return
    parts=[x for x in select_csv.split(",") if x]
    groups=[parts] if chunk_size<=0 else [parts[i:i+chunk_size] for i in range(0,len(parts),chunk_size)]
    extra=os.environ.get("ARIA2_OPTS","").strip()
    for g in groups:
        sel=",".join(g)
        cmd=[
            "aria2c",
            "-j",str(concurrency),
            "-x",str(concurrency),
            "-s",str(concurrency),
            "-c",
            "--summary-interval",str(summary),
            "--console-log-level",str(log_level),
            "--show-console-readout=true",
            "--allow-overwrite=true",
            "--always-resume=true",
            "--max-tries=0",
            "--retry-wait=10",
            "--disable-ipv6=true",
            "--dht-listen-port=6914",
            "--listen-port=6922",
            "--select-file",sel,
            "-d",out_dir,
            torrent_path
        ]
        if extra:
            cmd=cmd[:-2]+extra.split()+cmd[-2:]
        subprocess.check_call(cmd)

def move_and_rename(out_dir, kind):
    if kind=="subs":
        glob_root=pathlib.Path(out_dir)/"reddit"/"submissions"
        target_root=pathlib.Path(out_dir)/"submissions"
        prefix="RS_"
    else:
        glob_root=pathlib.Path(out_dir)/"reddit"/"comments"
        target_root=pathlib.Path(out_dir)/"comments"
        prefix="RC_"
    if not glob_root.exists():
        return
    for z in glob_root.rglob(f"{prefix}*.zst"):
        subprocess.run(["zstd","-d","--force","--rm",str(z)],check=False)
    moved=False
    for f in glob_root.rglob(f"{prefix}*"):
        if f.suffix:
            continue
        name=f.name
        mon=re.sub(r"^([A-Za-z]+)_","",name).split(".",1)[0]
        dst=target_root/(f"{prefix}{mon}.ndjson")
        if not target_root.exists():
            target_root.mkdir(parents=True, exist_ok=True)
        try:
            if dst.exists():
                f.unlink()
            else:
                shutil.move(str(f), str(dst))
                moved=True
        except Exception:
            pass
    try:
        if glob_root.exists() and not any(glob_root.rglob("*")):
            shutil.rmtree(glob_root.parent)
        if target_root.exists() and not any(target_root.rglob("*")) and not moved:
            shutil.rmtree(target_root)
    except Exception:
        pass

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="data/pushshift")
    ap.add_argument("--since", default="2021-01")
    ap.add_argument("--until", default=datetime.date.today().strftime("%Y-%m"))
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--subs-magnet", default=DEF_SUBS_MAGNET)
    ap.add_argument("--comments-magnet", default=DEF_COMMENTS_MAGNET)
    ap.add_argument("--trackers", default=DEF_TRACKERS)
    ap.add_argument("--which", choices=["subs","comments","both"], default="both")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--chunk-size", type=int, default=0)
    ap.add_argument("--aria-log-level", default="info")
    ap.add_argument("--aria-summary", type=int, default=2)
    args=ap.parse_args()

    pathlib.Path(args.out_dir).mkdir(parents=True, exist_ok=True)
    want=list(month_iter(args.since,args.until))

    plan={}
    if args.which in ("subs","both"):
        ih, tpath = magnet_to_torrent(args.subs_magnet, args.out_dir, args.trackers)
        files = read_torrent_files(tpath)
        avail, idx_by_month = build_index(files, "subs")
        have = existing_months(args.out_dir, "subs")
        inter=[m for m in want if m in avail]
        pending=[m for m in inter if m not in have]
        if args.verbose:
            if avail: sys.stderr.write(f"[auto][subs] available {min(avail)}..{max(avail)} ({len(avail)})\n")
            sys.stderr.write(f"[auto][subs] want {len(inter)} months, have {len(have)}, pending {len(pending)}\n")
        if pending:
            plan.setdefault(ih, {"tpath":tpath, "sel": []})
            plan[ih]["sel"].append(select_csv_for_pending(idx_by_month, pending))

    if args.which in ("comments","both"):
        ih, tpath = magnet_to_torrent(args.comments_magnet, args.out_dir, args.trackers)
        files = read_torrent_files(tpath)
        avail, idx_by_month = build_index(files, "comments")
        have = existing_months(args.out_dir, "comments")
        inter=[m for m in want if m in avail]
        pending=[m for m in inter if m not in have]
        if args.verbose:
            if avail: sys.stderr.write(f"[auto][comments] available {min(avail)}..{max(avail)} ({len(avail)})\n")
            sys.stderr.write(f"[auto][comments] want {len(inter)} months, have {len(have)}, pending {len(pending)}\n")
        if pending:
            plan.setdefault(ih, {"tpath":tpath, "sel": []})
            plan[ih]["sel"].append(select_csv_for_pending(idx_by_month, pending))

    nothing=True
    for ih, cfg in plan.items():
        sel_csv=",".join([s for s in cfg["sel"] if s])
        if not sel_csv: continue
        nothing=False
        run_aria_select(cfg["tpath"], args.out_dir, sel_csv, args.concurrency, args.aria_log_level, args.aria_summary, args.chunk_size)

    if nothing:
        sys.stderr.write("[auto] nothing to fetch; all requested months already present or not available\n")

    if args.which in ("subs","both"):
        move_and_rename(args.out_dir, "subs")
    if args.which in ("comments","both"):
        move_and_rename(args.out_dir, "comments")

if __name__=="__main__":
    main()
