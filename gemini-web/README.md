# gemini-web

The Gemini web app (gemini.google.com) from the command line with your own Google account: ask (with files), generate images, video and music, Deep Research, list models and quotas. Uses the unofficial `gemini_webapi` library (reverse-engineered web API) with your browser cookies. Chats are sent as temporary chats.

## Requirements
- Python 3.10+ (built on 3.14).
- A Google account signed in to gemini.google.com in a normal browser (to copy cookies from).
- Package `gemini_webapi==2.1.1` (pulls curl_cffi, pydantic, loguru, orjson).
- Only if Google is blocked in your country: an HTTP proxy, e.g. `http://127.0.0.1:10808`.

## Setup for an agent
1. `cd <this folder>` then `python -m venv .venv`
2. `.venv\Scripts\python.exe -m pip install gemini_webapi==2.1.1`
3. Create `cookies.json` in this folder (git-ignored): a flat JSON object `{ "cookie name": "value", ... }` with all `*.google.com` cookies of a browser signed in to Gemini. It must contain `__Secure-1PSID` and `__Secure-1PSIDTS`. Get them from browser dev tools (Application > Cookies), a cookie-export extension, or any tool that reads your browser cookies. Never print or paste them into chat.
   - Optional automation: `grab_cookies.py` (run by `gweb.py refresh-cookies`, and automatically when `cookies.json` is missing) copies them through the "Browser Bridge" Chrome extension. It needs `bridge_path` and `bridge_profile` in the config (below). Without them it stops with a message; just write `cookies.json` by hand.
4. If you need a proxy or custom output folders: copy `config.example.json` to `config.local.json` (private, git-ignored) and keep only the keys you need.
5. Test: `.venv\Scripts\python.exe gweb.py status` (prints models and quotas).

## Configuration
Each key can be an environment variable (wins) or a key in `config.local.json` (use `/` or `\\` in paths):

| Key / env var | Meaning | Default |
|---|---|---|
| `proxy` / `GWEB_PROXY` | HTTP proxy URL | none (direct) |
| `out_dir` / `GWEB_OUT_DIR` | base folder for saved files | `out/` here (`images`, `videos`, `music`, `research` inside) |
| `out_dirs` | object with per-command folders: `image`, `video`, `music`, `research`, `ask` | from `out_dir` |
| `bridge_path` / `BROWSER_BRIDGE_PATH` | folder of the Browser Bridge (`bb.py`), only for `grab_cookies.py` | none |
| `bridge_profile` / `BROWSER_BRIDGE_PROFILE` | Chrome profile name in the Browser Bridge | none |

Secrets: `cookies.json`, the auto-created `cookie_cache/` and `config.local.json` are all git-ignored.

## Usage
```
.venv\Scripts\python.exe gweb.py ask "Summarize this" -f report.pdf --model flash
.venv\Scripts\python.exe gweb.py image "a red teapot, studio light" --out D:\pics
.venv\Scripts\python.exe gweb.py video "a paper boat on a river" -f start.jpg
.venv\Scripts\python.exe gweb.py music "calm piano" --longer
.venv\Scripts\python.exe gweb.py research "history of the astrolabe"
```
Saved files are printed as `SAVED <path>`; exit code 1 means nothing was produced.

## Notes
- Cookies expire; when calls fail with auth errors, refresh `cookies.json`. If Google shows a CAPTCHA/IP block, solve it once in your browser and re-export all cookies.
- Image, video and music need the matching Gemini plan/quota (check `status`). Deep Research takes 5-15 minutes (`--timeout` default 1200 s).
- Unofficial API: it can break when Google changes the site, and heavy use may put the account at risk of limits.
