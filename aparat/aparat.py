"""Upload a video to your own Aparat channel with no browser UI (reverse-engineered from aparat.com/reactupload).

  python aparat.py upload VIDEO --title "..." --descr "..." --tags "a,b,c" [--category 3] [--draft]
  python aparat.py publish VIDEOHASH     (make a saved video public)
  python aparat.py categories
  python aparat.py refresh-cookies      (copy fresh cookies from your Chrome via Browser Bridge; see README)

Flow: api/fa/v1/video/upload/upload_url -> {uploadId, token}; POST 3 MB chunks to <server>/upload with X-Token;
<server>/chunksdone; then api/fa/v1/video/upload/upload/uploadId/<id> with the form. Tags: 3 to 5. Aparat is
inside Iran, so no proxy. Prints "UPLOADED <url>" at the end.
"""
import argparse, json, math, mimetypes, os, pathlib, subprocess, sys, time, uuid
import requests

HERE = pathlib.Path(__file__).resolve().parent
API = "https://www.aparat.com/api/fa/v1/"
CHUNK = 3_000_000
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36"


def session():
    s = requests.Session(); s.trust_env = False
    s.cookies.update(json.loads((HERE / "cookies.json").read_text(encoding="utf-8")))
    s.headers.update({"User-Agent": UA, "isNext": "true", "jsonType": "simple",
                      "Origin": "https://www.aparat.com", "Referer": "https://www.aparat.com/reactupload"})
    return s


def config(s):
    r = s.get(API + "video/upload/upload_config", timeout=30); r.raise_for_status()
    return r.json()["data"]


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True).stdout.strip()
    return round(float(out or 0))


def upload(a):
    s = session()
    cfg = config(s)
    server = cfg["server"]
    path = pathlib.Path(a.video)
    size = path.stat().st_size
    uid = "u" + uuid.uuid4().hex[:20]
    r = s.post(API + "video/upload/upload_url", json={"uploadIds": [uid], "upload_base_url": server, "upload_cnt": 1}, timeout=30)
    r.raise_for_status()
    t = r.json()["data"][0]
    upload_id, token = t["uploadId"], t["token"]
    print(f"IDS --upload-id {upload_id} --uid {uid} --server {server}", flush=True)
    parts = math.ceil(size / CHUNK)
    mime = mimetypes.guess_type(path.name)[0] or "video/mp4"
    up = requests.Session(); up.trust_env = False; up.headers.update({"User-Agent": UA, "X-Token": token})
    t0 = time.time()
    with open(path, "rb") as f:
        for i in range(parts):
            data = f.read(CHUNK)
            fields = {"qqpartindex": i, "qqchunksize": len(data), "qqpartbyteoffset": i * CHUNK, "qqtotalfilesize": size,
                      "qqtype": mime, "qquuid": uid, "qqfilename": path.name, "qqfilepath": path.name, "qqtotalparts": parts}
            for attempt in range(4):
                try:
                    rr = up.post(server + "/upload", data={k: str(v) for k, v in fields.items()},
                                 files={"qqfile": (path.name, data, "application/octet-stream")}, timeout=300)
                    if rr.status_code == 200:
                        break
                    err = f"HTTP {rr.status_code} {rr.text[:200]}"
                except requests.RequestException as e:
                    err = str(e)
                print(f"chunk {i} retry {attempt + 1}: {err}", flush=True); time.sleep(5)
            else:
                sys.exit(f"FAILED: chunk {i} would not upload")
            if i % 5 == 0 or i == parts - 1:
                print(f"chunk {i + 1}/{parts} ok ({(i + 1) * 100 // parts}%, {time.time() - t0:.0f} s)", flush=True)
    rr = up.post(server + "/chunksdone", data={"qquuid": uid, "qqfilename": path.name, "qqtotalfilesize": str(size),
                                               "qqtotalparts": str(parts)}, timeout=3600)
    print("chunksdone", rr.status_code, rr.text[:200], flush=True)
    if rr.status_code != 200:
        sys.exit("FAILED: chunksdone")
    submit(s, a, server, upload_id, uid, duration(path))


def submit(s, a, server, upload_id, uid, dur):
    tags = [x.strip() for x in a.tags.split(",") if x.strip()]
    form = {"title": a.title, "descr": a.descr, "category": str(a.category), "tags": "-".join(tags),
            "comment": "yes", "kids_friendly": "no", "watermark_bool": False, "video_pass": 1 if a.draft else 0,  # 1 = saved, not published
            "youtube_upload": False, "publish_date": int(time.time() * 1000), "upload_base_url": server,
            "uploadId": upload_id, "video": uid, "duration": dur}
    rr = s.post(API + f"video/upload/upload/uploadId/{upload_id}", json=form, timeout=120)
    print("form", rr.status_code, rr.text[:800], flush=True)
    if rr.status_code != 200:
        sys.exit("FAILED: form (retry with: aparat.py form <same args> --upload-id .. --uid .. --server ..)")
    print("UPLOADED", rr.text[:300])


def publish(s, uid):
    """Make an uploaded video public (the edit form with video_pass false)."""
    d = s.get(API + f"video/video/edit/videohash/{uid}", timeout=30).json()["data"]
    form = {"title": d["title"], "descr": d.get("description") or "", "category": str(d["catId"]), "tags": "-".join(d["tags"]),
            "comment": d.get("comment_enable") or "yes", "video_pass": False, "publish_date": None, "kids_friendly": "no", "videohash": uid}
    r = s.post(API + f"video/video/edit/videohash/{uid}", json=form, timeout=60)
    hidden = s.get(API + f"video/video/edit/videohash/{uid}", timeout=30).json()["data"]["isHidden"]
    print("publish", uid, r.status_code, "hidden" if hidden else "PUBLIC", f"https://www.aparat.com/v/{uid}")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("upload"); u.add_argument("video"); u.add_argument("--title", required=True)
    u.add_argument("--descr", default=""); u.add_argument("--tags", required=True); u.add_argument("--category", default=3)
    u.add_argument("--draft", action="store_true", help="save without publishing")
    f = sub.add_parser("form", help="resend only the form for an already uploaded file")
    for x in (u, f):
        if x is f:
            f.add_argument("--title", required=True); f.add_argument("--descr", default=""); f.add_argument("--tags", required=True)
            f.add_argument("--category", default=3); f.add_argument("--draft", action="store_true")
            f.add_argument("--upload-id", required=True); f.add_argument("--uid", required=True); f.add_argument("--server", required=True)
            f.add_argument("--duration", type=int, default=0)
    pb = sub.add_parser("publish"); pb.add_argument("uid")
    sub.add_parser("categories"); sub.add_parser("refresh-cookies")
    a = ap.parse_args()
    if a.cmd == "refresh-cookies" or not (HERE / "cookies.json").exists():
        subprocess.run([sys.executable, str(HERE / "grab_cookies.py")], check=True)
        if a.cmd == "refresh-cookies":
            return
    if a.cmd == "categories":
        for c in config(session())["categories"]:
            print(c["id"], c["name"])
    elif a.cmd == "publish":
        publish(session(), a.uid)
    elif a.cmd == "form":
        submit(session(), a, a.server, a.upload_id, a.uid, a.duration)
    else:
        upload(a)


if __name__ == "__main__":
    main()
