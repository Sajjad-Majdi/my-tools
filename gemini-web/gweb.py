"""gweb: the whole Gemini web app (gemini.google.com) from the command line, with your own Google account.

Library: gemini_webapi (github HanaokaYuzu/Gemini-API, reverse-engineered web API). Cookies live in cookies.json
(write it by hand, or fill it with grab_cookies.py if you use the Browser Bridge extension). Optional proxy for
countries where Google is blocked. Settings: config.local.json or env vars, see config.example.json and README.md.

  python gweb.py ask "question" [-f file ...] [--model pro|flash|...] [--think] [--json]
        text answer; files may be images, video, audio, PDF, code (eyes and ears)
  python gweb.py image "prompt" [-f ref.jpg ...] [--out DIR]
  python gweb.py video "prompt" [-f ref.jpg] [--out DIR]
  python gweb.py music "prompt" [--vocals] [--longer] [--out DIR]
  python gweb.py research "topic" [--out DIR]          Deep Research report (5-15 min) as .md
  python gweb.py status                                 models + quotas
  python gweb.py refresh-cookies                        copy fresh cookies from your browser (needs Browser Bridge, see README)

Run with .venv/Scripts/python.exe. Saved files are printed as "SAVED <path>". Exit 1 on failure.
"""
import argparse, asyncio, json, os, pathlib, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import config
PROXY = config.get("proxy", "GWEB_PROXY") or None   # e.g. http://127.0.0.1:10808; none = direct
os.environ.setdefault("GEMINI_COOKIE_PATH", str(HERE / "cookie_cache"))
_OUT = pathlib.Path(str(config.get("out_dir", "GWEB_OUT_DIR", HERE / "out")))   # base folder for saved files
DEFAULT_OUT = {"image": str(_OUT / "images"), "video": str(_OUT / "videos"), "music": str(_OUT / "music"),
               "research": str(_OUT / "research"), "ask": str(_OUT)}
# per-command folders from config.local.json "out_dirs": {"image": "...", "video": "...", "music": "...", ...}
_per = config._FILE.get("out_dirs") or {}
DEFAULT_OUT.update({k: str(v) for k, v in _per.items() if k in DEFAULT_OUT})


async def client():
    from gemini_webapi import GeminiClient, set_log_level
    set_log_level("WARNING")
    jar = json.loads((HERE / "cookies.json").read_text(encoding="utf-8"))
    c = GeminiClient(jar["__Secure-1PSID"], jar.get("__Secure-1PSIDTS", ""), proxy=PROXY)
    # all Google cookies, so a solved CAPTCHA in his Chrome (GOOGLE_ABUSE_EXEMPTION) also clears the IP block here
    c.cookies = jar
    await c.init(timeout=600, auto_close=False, auto_refresh=True)
    return c


async def save_all(resp, out: pathlib.Path) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    saved = []
    for img in resp.images:
        saved.append(await img.save(path=str(out)))
    for v in resp.videos:
        r = await v.save(path=str(out))
        saved += list(r.values()) if isinstance(r, dict) else [r]
    for m in resp.media:
        r = await m.save(path=str(out), download_type="audio")
        saved += list(r.values()) if isinstance(r, dict) else [r]
    return [str(p) for p in saved if p]


async def run(a) -> int:
    c = await client()
    try:
        out = pathlib.Path(a.out or DEFAULT_OUT.get(a.cmd, str(HERE / "out")))
        files = [str(pathlib.Path(f).resolve()) for f in (getattr(a, "file", None) or [])]
        if a.cmd == "status":
            for m in c.list_models() or []:
                print("MODEL", getattr(m, "name", m), "|", getattr(m, "display_name", ""))
            print("QUOTAS", json.dumps(c.quotas, ensure_ascii=False, default=str))
            return 0
        if a.cmd == "research":
            r = await c.deep_research(a.prompt, timeout=a.timeout, model=a.model)  # research needs a normal chat (plan + confirm turns)
            out.mkdir(parents=True, exist_ok=True)
            p = out / f"research_{time.strftime('%Y%m%d_%H%M%S')}.md"
            p.write_text(r.text or "", encoding="utf-8")
            print("SAVED", p)
            return 0 if (r.text or "").strip() else 1
        prompt = a.prompt
        if a.cmd == "image":
            prompt = "Generate an image: " + prompt
        elif a.cmd == "video":
            prompt = "Generate a video: " + prompt
        elif a.cmd == "music":
            prompt = "Create music: " + prompt + ("" if a.vocals else ". Instrumental only, no vocals, no singing.")
        chat = c.start_chat(model=a.model) if a.model else c.start_chat()
        kw = {"files": files} if files else {}
        if a.cmd == "ask":
            resp = await c.generate_content(prompt, model=a.model, temporary=True,
                                            extended_thinking=a.think, **kw)
        else:
            # temporary chat = no Personal Intelligence / memory
            resp = await c.generate_content(prompt, model=a.model, chat=chat, temporary=True, **kw)
            if a.cmd == "music" and a.longer and resp.media:
                resp = await c.generate_content("Make it longer.", chat=chat, temporary=True)
        if a.cmd == "ask" and a.json:
            print(json.dumps({"text": resp.text, "thoughts": resp.thoughts}, ensure_ascii=False))
        else:
            print(resp.text or "")
        saved = await save_all(resp, out)
        for p in saved:
            print("SAVED", p)
        want = {"image": "images", "video": "videos", "music": "media"}.get(a.cmd)
        if want and not saved:
            print(f"FAILED: no {a.cmd} in the reply", file=sys.stderr)
            return 1
        return 0
    finally:
        await c.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ["ask", "image", "video", "music", "research"]:
        p = sub.add_parser(name)
        p.add_argument("prompt")
        p.add_argument("--model", default=None, help="model name or alias from `status` (default: account default)")
        p.add_argument("--out", default=None)
        if name in ("ask", "image", "video"):
            p.add_argument("-f", "--file", action="append", help="attach a file (repeatable)")
        if name == "ask":
            p.add_argument("--think", action="store_true", help="extended thinking")
            p.add_argument("--json", action="store_true")
        if name == "music":
            p.add_argument("--vocals", action="store_true")
            p.add_argument("--longer", action="store_true", help="ask for the longer version (~2 min)")
        if name == "research":
            p.add_argument("--timeout", type=float, default=1200)
    sub.add_parser("status").add_argument("--out", default=None)
    sub.add_parser("refresh-cookies")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if a.cmd == "refresh-cookies" or not (HERE / "cookies.json").exists():
        subprocess.run([sys.executable, str(HERE / "grab_cookies.py")], check=True)
        if a.cmd == "refresh-cookies":
            return
    a.model = getattr(a, "model", None)
    sys.exit(asyncio.run(run(a)))


if __name__ == "__main__":
    main()
