import argparse
import collections
import concurrent.futures
import datetime
import hashlib
import hmac
import http.client
import json
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

PUBLIC = "https://assets.open-run.org"
UA = "open-run-archive media (+https://archive.open-run.org)"
DIRECT = re.compile(r"https?://i\.redd\.it/([a-z0-9]+)\.(jpe?g|png|gif|webp)", re.I)
REF = re.compile(r"https?://(?:i|preview)\.redd\.it/([a-z0-9]+)\.(jpe?g|png|gif|webp)(?![a-z0-9])", re.I)
VIDEO = re.compile(r"https?://(?:v|packaged-media)\.redd\.it/([a-z0-9]+)/", re.I)
MID = re.compile(r"[a-z0-9]+")
MIME = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "mp4": "video/mp4"}
EXT = {"image/jpg": "jpg", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
TAKEDOWN = ("copyright_takedown", "content_takedown")
IMAGE_MAX = 100 * 2**20
VIDEO_MAX = 2 * 2**30
RETRY = (429, 500, 502, 503, 504)

class Fail(Exception):
    pass

class UploadFail(Fail):
    pass

class Broken(Fail):
    pass

def image(mid, ext, w=None, h=None, caption="", link=""):
    return {"id": mid, "kind": "image", "src": f"https://i.redd.it/{mid}.{ext.lower()}", "w": w, "h": h, "caption": caption, "link": link}

def video(mid, mpd, w=None, h=None, fallback=""):
    return {"id": mid, "kind": "video", "src": mpd, "w": w, "h": h, "caption": "", "link": "", "fallback": fallback}

def dig(d, *keys):
    for k in keys:
        if isinstance(d, dict):
            d = d.get(k)
        elif isinstance(d, list) and isinstance(k, int) and -len(d) <= k < len(d):
            d = d[k]
        else:
            return None
    return d

def from_meta(mid, v, caption="", link=""):
    if not isinstance(v, dict) or v.get("status") != "valid" or not MID.fullmatch(mid or ""):
        return None
    s = v.get("s") if isinstance(v.get("s"), dict) else {}
    if v.get("e") == "Image":
        m = REF.match(s.get("u") or "")
        ext = m.group(2) if m else EXT.get((v.get("m") or "").lower())
        return image(mid, ext, s.get("x"), s.get("y"), caption, link) if ext else None
    if v.get("e") == "AnimatedImage":
        m = DIRECT.fullmatch(s.get("gif") or "")
        return image(mid, m.group(2), s.get("x"), s.get("y"), caption, link) if m else None
    if v.get("e") == "RedditVideo":
        mpd = (v.get("dashUrl") or "").split("?")[0]
        return video(mid, mpd, v.get("x"), v.get("y")) if mpd.startswith("https://v.redd.it/") else None
    return None

def reddit_video(p):
    rv = dig(p, "secure_media", "reddit_video") or dig(p, "media", "reddit_video")
    if not isinstance(rv, dict) or rv.get("transcoding_status", "completed") != "completed":
        return None
    fallback = (rv.get("fallback_url") or "").split("?")[0]
    for k in ("fallback_url", "dash_url", "hls_url", "scrubber_media_url"):
        m = VIDEO.match(rv.get(k) or "")
        if m:
            fallback = fallback if fallback.startswith(f"https://v.redd.it/{m.group(1)}/") else ""
            return video(m.group(1), f"https://v.redd.it/{m.group(1)}/DASHPlaylist.mpd", rv.get("width"), rv.get("height"), fallback)
    return None

def capture_media(p, nested=False):
    found = []
    m = DIRECT.fullmatch(p.get("url") or "")
    if m:
        src = dig(p, "preview", "images", 0, "source") or {}
        found.append(image(m.group(1), m.group(2), src.get("width"), src.get("height")))
    meta = p.get("media_metadata") if isinstance(p.get("media_metadata"), dict) else {}
    for g in dig(p, "gallery_data", "items") or []:
        if isinstance(g, dict):
            it = from_meta(str(g.get("media_id") or ""), meta.get(g.get("media_id")), g.get("caption") or "", g.get("outbound_url") or "")
            found.append(it)
    found += [from_meta(mid, v) for mid, v in meta.items()]
    found.append(reddit_video(p))
    found += [image(m.group(1), m.group(2)) for m in REF.finditer(p.get("selftext") or "")]
    if not nested:
        for parent in (p.get("crosspost_parent_list") or [])[:1]:
            if isinstance(parent, dict):
                found += capture_media(parent, True)
    return [it for it in found if it]

def post_media(caps):
    out, seen = [], set()
    for p in reversed(caps):
        if isinstance(p, dict):
            for it in capture_media(p):
                if it["id"] not in seen:
                    seen.add(it["id"])
                    out.append(it)
    return out

def comment_media(c):
    meta = c.get("media_metadata") if isinstance(c.get("media_metadata"), dict) else {}
    found = [from_meta(mid, v) for mid, v in meta.items()]
    found += [image(m.group(1), m.group(2)) for m in REF.finditer(c.get("body") or "")]
    return [it for it in found if it]

def comments_of(obj):
    stack = [obj]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            if "body" in x and "id" in x:
                yield x
            stack.extend(v for v in x.values() if isinstance(v, (dict, list)))
        elif isinstance(x, list):
            stack.extend(x)

def heads(d):
    out = []
    for f in sorted(d.glob("*.jsonl")):
        try:
            with f.open(encoding="utf-8") as fh:
                row = json.loads(fh.readline())
        except (OSError, ValueError):
            continue
        if isinstance(row, dict):
            out.append(row)
    return out

def collect(root):
    found = {}
    for sub_dir in sorted(p for p in root.glob("r_*") if p.is_dir()):
        for d in sorted(p for p in (sub_dir / "submissions").glob("*_*") if p.is_dir()):
            caps = heads(d)
            if any(c.get("removed_by_category") in TAKEDOWN for c in caps):
                continue
            items = post_media(caps)
            for f in sorted((sub_dir / "comments" / d.name).glob("*.jsonl")):
                text = f.read_text(encoding="utf-8", errors="replace")
                if "redd.it/" not in text:
                    continue
                for ln in text.splitlines():
                    try:
                        row = json.loads(ln)
                    except ValueError:
                        continue
                    for c in comments_of(row):
                        items += comment_media(c)
            for it in items:
                found.setdefault(it["id"], (sub_dir.name, d.name, it))
    return found

def load_manifest(mdir):
    rows = {}
    for f in sorted(pathlib.Path(mdir).glob("*.jsonl")):
        for ln in f.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(ln)
            except ValueError:
                continue
            if isinstance(r, dict) and r.get("id"):
                rows[r["id"]] = r
    return rows

def sniff(b):
    if b[:3] == b"\xff\xd8\xff":
        return "jpg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    return None

def dims(b, ext):
    try:
        if ext == "png":
            return struct.unpack(">II", b[16:24])
        if ext == "gif":
            return struct.unpack("<HH", b[6:10])
        if ext == "webp":
            if b[12:16] == b"VP8 ":
                w, h = struct.unpack("<HH", b[26:30])
                return w & 0x3FFF, h & 0x3FFF
            if b[12:16] == b"VP8L":
                bits = int.from_bytes(b[21:25], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            if b[12:16] == b"VP8X":
                return int.from_bytes(b[24:27], "little") + 1, int.from_bytes(b[27:30], "little") + 1
        if ext == "jpg":
            i = 2
            while i + 9 < len(b):
                if b[i] != 0xFF:
                    i += 1
                    continue
                marker = b[i + 1]
                if marker == 0xFF:
                    i += 1
                    continue
                if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", b[i + 5:i + 9])
                    return w, h
                i += 2 + int.from_bytes(b[i + 2:i + 4], "big")
    except struct.error:
        pass
    return None

def gone(code, body):
    return code in (404, 410) or (code == 403 and b"access denied" in (body or b"").lower())

def get(url, limit, dest=None):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                if dest is None:
                    data = r.read(limit + 1)
                    if len(data) > limit:
                        raise Broken("too large")
                    return 200, data, r.geturl()
                size = 0
                with open(dest, "wb") as w:
                    while chunk := r.read(2**20):
                        size += len(chunk)
                        if size > limit:
                            raise Broken("too large")
                        w.write(chunk)
                return 200, b"", r.geturl()
        except urllib.error.HTTPError as e:
            body = e.read(4096)
            if e.code not in RETRY or attempt == 3:
                return e.code, body, url
            wait = e.headers.get("Retry-After") or ""
            time.sleep(min(int(wait), 60) if wait.isdigit() else 2 ** attempt * 5)
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            if attempt == 3:
                raise Fail(f"download: {e}")
            time.sleep(2 ** attempt * 5)
    raise Fail("download: retries exhausted")

def sha256_file(p):
    h, size = hashlib.sha256(), 0
    with open(p, "rb") as f:
        while chunk := f.read(2**20):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size

def put(env, key, body, ctype):
    digest, size = sha256_file(body) if isinstance(body, pathlib.Path) else (hashlib.sha256(body).hexdigest(), len(body))
    endpoint = env["R2_ENDPOINT"].rstrip("/")
    path = "/" + urllib.parse.quote(f"{env['R2_BUCKET']}/{key}", safe="/-_.~")
    for attempt in range(4):
        now = datetime.datetime.now(datetime.timezone.utc)
        amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        headers = {"cache-control": "public, max-age=31536000, immutable", "content-type": ctype, "host": urllib.parse.urlsplit(endpoint).netloc, "x-amz-content-sha256": digest, "x-amz-date": amz}
        names = ";".join(sorted(headers))
        canonical = "\n".join(["PUT", path, "", "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), names, digest])
        scope = f"{day}/auto/s3/aws4_request"
        k = ("AWS4" + env["R2_SECRET_ACCESS_KEY"]).encode()
        for part in (day, "auto", "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, f"AWS4-HMAC-SHA256\n{amz}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}".encode(), hashlib.sha256).hexdigest()
        headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={env['R2_ACCESS_KEY_ID']}/{scope}, SignedHeaders={names}, Signature={sig}"
        headers["content-length"] = str(size)
        data = body.open("rb") if isinstance(body, pathlib.Path) else body
        try:
            with urllib.request.urlopen(urllib.request.Request(endpoint + path, data=data, method="PUT", headers=headers), timeout=600) as r:
                r.read()
            return digest, size
        except urllib.error.HTTPError as e:
            if e.code not in RETRY or attempt == 3:
                raise UploadFail(f"upload {key}: http {e.code} {e.read(300)!r}")
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            if attempt == 3:
                raise UploadFail(f"upload {key}: {e}")
        finally:
            if data is not body:
                data.close()
        time.sleep(2 ** attempt * 5)
    raise UploadFail(f"upload {key}: retries exhausted")

def tracks(text, base):
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise Broken("mpd: unexpected doctype")
    best = {}
    for aset in ET.fromstring(text).iter():
        if not aset.tag.endswith("AdaptationSet"):
            continue
        for rep in aset:
            if not rep.tag.endswith("Representation"):
                continue
            kind = aset.get("contentType") or (rep.get("mimeType") or aset.get("mimeType") or "").split("/")[0]
            url = next((el.text.strip() for el in rep if el.tag.endswith("BaseURL") and (el.text or "").strip()), None)
            if kind not in ("video", "audio") or not url:
                continue
            bw = int(rep.get("bandwidth") or 0)
            if kind not in best or bw > best[kind]["bw"]:
                best[kind] = {"bw": bw, "url": urllib.parse.urljoin(base, url), "w": int(rep.get("width") or 0) or None, "h": int(rep.get("height") or 0) or None}
    return best

def archive(env, sub, created_id, it, tmp):
    base = f"archive/{sub}/{created_id.split('_', 1)[1]}/{it['id']}"
    row = {"id": it["id"], "post": created_id, "src": it["src"]}
    if it["kind"] == "image":
        code, data, final = get(it["src"], IMAGE_MAX)
        if code != 200:
            if gone(code, data):
                return dict(row, status=code)
            raise Fail(f"http {code}")
        if final != it["src"]:
            return dict(row, status="redirect")
        ext = sniff(data)
        if not ext:
            raise (Broken if data[:4] and b"<" not in data[:64] else Fail)("not an image")
        w, h = (it["w"], it["h"]) if it["w"] and it["h"] else dims(data, ext) or (None, None)
        digest, size = put(env, f"{base}.{ext}", data, MIME[ext])
        return dict(row, key=f"{base}.{ext}", type=MIME[ext], bytes=size, sha256=digest, w=w, h=h)
    code, data, _ = get(it["src"], 2**20)
    if code != 200:
        if gone(code, data):
            return dict(row, status=code)
        raise Fail(f"mpd http {code}")
    try:
        found = tracks(data.decode("utf-8", "replace"), it["src"])
    except (ET.ParseError, ValueError) as e:
        raise Broken(f"mpd: {e}")
    if "video" not in found:
        raise Broken("mpd: no video track")
    picks = [(found["video"]["url"], found["video"]["w"] or it["w"], found["video"]["h"] or it["h"])]
    if it.get("fallback") and (it["h"] or 0) > (picks[0][2] or 0):
        picks.insert(0, (it["fallback"], it["w"], it["h"]))
    work = pathlib.Path(tempfile.mkdtemp(dir=tmp))
    try:
        for url, w, h in picks:
            code, data, _ = get(url, VIDEO_MAX, work / "v.mp4")
            if code == 200:
                break
        else:
            if gone(code, data):
                return dict(row, status=code)
            raise Fail(f"video http {code}")
        cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(work / "v.mp4")]
        maps = ["-map", "0:v:0"]
        if "audio" in found:
            code, data, _ = get(found["audio"]["url"], VIDEO_MAX, work / "a.mp4")
            if code == 200:
                cmd += ["-i", str(work / "a.mp4")]
                maps += ["-map", "1:a:0"]
            elif not gone(code, data):
                raise Fail(f"audio http {code}")
        out = work / "out.mp4"
        r = subprocess.run(cmd + maps + ["-c", "copy", "-movflags", "+faststart", str(out)], capture_output=True, text=True, timeout=900)
        if r.returncode != 0 or not out.exists():
            raise Broken(f"ffmpeg: {r.stderr.strip()[-300:]}")
        digest, size = put(env, f"{base}.mp4", out, "video/mp4")
        return dict(row, key=f"{base}.mp4", type="video/mp4", bytes=size, sha256=digest, w=w, h=h)
    finally:
        shutil.rmtree(work, ignore_errors=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="data/raw")
    ap.add_argument("--manifest")
    ap.add_argument("--limit", type=int, default=2000)
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    env = {k: os.environ.get(k, "") for k in ("R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")}
    if not all(env.values()):
        print("[media] R2 credentials not set, skipping", file=sys.stderr)
        return 0
    mdir = pathlib.Path(args.manifest) if args.manifest else pathlib.Path(args.root).parent / "media"
    done = load_manifest(mdir)
    found = collect(pathlib.Path(args.root))
    pending = sorted((v for k, v in found.items() if k not in done), key=lambda x: x[1], reverse=True)
    if not shutil.which("ffmpeg"):
        waiting = sum(1 for p in pending if p[2]["kind"] == "video")
        pending = [p for p in pending if p[2]["kind"] != "video"]
        if waiting:
            print(f"[media] ffmpeg not found, {waiting} videos left for later", file=sys.stderr)
    batch = pending[:args.limit]
    print(f"[media] known={len(found)} recorded={len(done)} pending={len(pending)} batch={len(batch)}", file=sys.stderr)
    mdir.mkdir(parents=True, exist_ok=True)
    for f in mdir.glob("*.jsonl"):
        if f.stat().st_size and not f.read_bytes().endswith(b"\n"):
            with f.open("a", encoding="utf-8") as w:
                w.write("\n")
    n = collections.Counter()
    streak, stopped = 0, False
    with tempfile.TemporaryDirectory() as tmp, concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
        jobs = {pool.submit(archive, env, sub, cid, it, tmp): (sub, cid, it) for sub, cid, it in batch}
        try:
            for fut in concurrent.futures.as_completed(jobs):
                sub, cid, it = jobs[fut]
                if fut.cancelled():
                    continue
                try:
                    row = fut.result()
                except Broken as e:
                    row = {"id": it["id"], "post": cid, "src": it["src"], "status": "failed", "reason": str(e)[:200]}
                except Exception as e:
                    n["failed"] += 1
                    n["upload_failed"] += isinstance(e, UploadFail)
                    print(f"[media] {it['src']}: {e}", file=sys.stderr)
                    streak += 1
                    if streak >= 25 and not stopped:
                        stopped = True
                        print("[media] 25 failures in a row, stopping", file=sys.stderr)
                        for f in jobs:
                            f.cancel()
                    continue
                streak = 0
                row["at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                with (mdir / f"{sub}.jsonl").open("a", encoding="utf-8") as w:
                    w.write(json.dumps(row, ensure_ascii=False) + "\n")
                n["stored" if "key" in row else "broken" if row["status"] == "failed" else "gone"] += 1
                n["bytes"] += row.get("bytes", 0)
        except BaseException:
            pool.shutdown(wait=False, cancel_futures=True)
            raise
    print(f"[media] stored={n['stored']} gone={n['gone']} broken={n['broken']} failed={n['failed']} uploaded={n['bytes'] / 2**20:.1f} MiB", file=sys.stderr)
    return 1 if n["upload_failed"] or stopped else 0

if __name__ == "__main__":
    sys.exit(main())
