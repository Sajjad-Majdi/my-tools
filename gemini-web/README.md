# gemini-web

> **Quick setup:** give your AI agent this line: *Download https://github.com/Sajjad-Majdi/my-tools/releases/download/gemini-web/gemini-web.zip, unzip it, and set it up for me by following its README.md.*

The Gemini web app (gemini.google.com) from the command line with your own Google account: ask (with files), generate images, video and music, Deep Research, list models and quotas. Uses the unofficial `gemini_webapi` library (reverse-engineered web API) with your browser cookies. Chats are sent as temporary chats.

## Requirements
- Python 3.10+ (built on 3.14).
- Windows with Google Chrome installed.
- A Google account that can use gemini.google.com.
- Package `gemini_webapi==2.1.1` (pulls curl_cffi, pydantic, loguru, orjson). Nothing else to install.
- Only if Google is blocked in your country: an HTTP proxy, e.g. `http://127.0.0.1:10808`.

## Setup for an agent
1. `cd <this folder>` then `python -m venv .venv`
2. `.venv\Scripts\python.exe -m pip install gemini_webapi==2.1.1`
3. Login, one time (the agent runs the command; YOU sign in):
   1. Agent: `.venv\Scripts\python.exe gweb.py login`. A Chrome window opens at gemini.google.com with its own profile (`browser_profile/`, private, git-ignored).
   2. You: sign in to your Google account in that window. When Gemini opens, the tool notices, saves the login and closes the window (or press Enter in the terminal).
   3. From now on every command reads fresh cookies from that profile by itself, using a hidden Chrome, so you stay signed in. Never copy cookies by hand.
   If a command says `not signed in`, repeat steps 1-2.
4. If you need a proxy or custom output folders: copy `config.example.json` to `config.local.json` (private, git-ignored) and keep only the keys you need.
5. Test: `.venv\Scripts\python.exe gweb.py status` (prints models and quotas).

## Configuration
Each key can be an environment variable (wins) or a key in `config.local.json` (use `/` or `\\` in paths):

| Key / env var | Meaning | Default |
|---|---|---|
| `proxy` / `GWEB_PROXY` | HTTP proxy URL for the Gemini API calls | none (direct) |
| `out_dir` / `GWEB_OUT_DIR` | base folder for saved files | `out/` here (`images`, `videos`, `music`, `research` inside) |
| `out_dirs` | object with per-command folders: `image`, `video`, `music`, `research`, `ask` | from `out_dir` |
| `chrome_path` / `GWEB_CHROME` | full path of `chrome.exe` | found automatically in the usual install folders |
| `profile_dir` / `GWEB_PROFILE_DIR` | folder of the Chrome login profile | `browser_profile/` here |
| `chrome_proxy` / `GWEB_CHROME_PROXY` | proxy for Chrome itself | same as `proxy` |

Secrets: `browser_profile/` (your login), `cookies.json` (a cache the tool writes, never edit it), `cookie_cache/` and `config.local.json` are all git-ignored.

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
- `login` is the only manual step. Before each call the tool refreshes `cookies.json` from the profile (at most every 10 minutes), and retries once if Google rejects the cookies. `gweb.py refresh-cookies` forces a refresh.
- If Google shows a CAPTCHA/IP block, solve it once in the login window (run `gweb.py login` again).
- Image, video and music need the matching Gemini plan/quota (check `status`). Deep Research takes 5-15 minutes (`--timeout` default 1200 s).
- Unofficial API: it can break when Google changes the site, and heavy use may put the account at risk of limits.
