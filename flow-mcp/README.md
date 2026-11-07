# flow-mcp

> **Quick setup:** give your AI agent this line: *Download https://github.com/Sajjad-Majdi/my-tools/releases/download/flow-mcp/flow-mcp.zip, unzip it, and set it up for me by following its README.md.*

MCP server and CLI for Google Flow (flow.google.com: Veo / Omni video, Nano Banana images). It calls Flow's own `batchexecute` RPCs from inside a headless Chrome page that holds your Google login. Generation steps (image/video/edit/upload) are driven through Flow's own composer; the page sends its own reCAPTCHA token.

## Requirements
- Windows 10/11 (the code uses `taskkill`, `curl`, `NUL` and hidden-window flags).
- Python 3.10+ (built and tested on 3.14) and Google Chrome installed (Playwright uses `channel='chrome'`; no browser download).
- A Google account with Flow access. Images were free; video costs credits (see Notes).
- Only if Google/Flow is blocked in your country: Xray-core (`xray.exe`) and 1+ `trojan://` or `vless://` links, or any HTTP proxy.

## Setup for an agent
1. `cd <this folder>` then `python -m venv .venv`
2. `.venv\Scripts\python.exe -m pip install playwright==1.64.1 mcp==2.3.0`
3. Create the logged-in Chrome profile. Easiest: `uv tool install gflow-cli`, then `gflow auth login --profile myname` (a window opens once; sign in to Google and open Flow). Its profile folder is `%LOCALAPPDATA%\ffroliva\gflow-cli\profile_<name>`. If gflow-cli's default profile is the one you want, flow-mcp finds it by itself; otherwise set `profile` (step 4).
4. Copy `config.example.json` to `config.local.json` (private, git-ignored) and keep only the keys you need (see Configuration). With a direct connection and the gflow default profile you need no file at all.
5. Test: `.venv\Scripts\python.exe -I flow.py credits` (first call takes 20-60 s; prints JSON).
6. Register the MCP server (absolute paths):
   - Claude Code: `claude mcp add --scope user flow -- <abs>\.venv\Scripts\python.exe -I <abs>\server.py`
   - Other agents: command `<abs>\.venv\Scripts\python.exe`, args `["-I", "<abs>\server.py"]`.

## Configuration
Every key can be set as an environment variable (wins) or in `config.local.json` (use `/` or `\\` in paths):

| Key / env var | Meaning | Default |
|---|---|---|
| `profile` / `FLOW_PROFILE` | Chrome profile folder signed in to Flow | gflow-cli's default profile, else `state/chrome-profile` |
| `proxy` / `FLOW_PROXY` | `none`, `xray`, or `http://host:port` of your own proxy | `none` |
| `xray_path` / `FLOW_XRAY_PATH` | `xray.exe` (xray mode) | `xray.exe` on PATH |
| `proxy_links_file` / `FLOW_PROXY_LINKS` | file with one `trojan://` or `vless://` link per line (secret) | `proxy_links.txt` here |
| `proxy_order` / `FLOW_PROXY_ORDER` | 0-based link indexes to try, e.g. `[2,0,1]` or `"2,0,1"` | all, in file order |
| `proxy_port` / `FLOW_PROXY_PORT` | local port xray listens on | `10818` |
| `idle_close_s` / `FLOW_IDLE_CLOSE_S` | close Chrome after this many idle seconds | `180` |

Secrets: `config.local.json`, `proxy_links.txt` (or the file `proxy_links_file` points to) and the generated `state/xray.json` are all private and git-ignored. In xray mode a running copy on `proxy_port` is reused.

## Usage
```
.venv\Scripts\python.exe -I flow.py create-project "My video"
.venv\Scripts\python.exe -I flow.py image <project> "a red teapot" --model "Nano Banana Pro" --aspect 16:9
.venv\Scripts\python.exe -I flow.py video <project> "slow pan over a teapot" --model "Omni 1.1 Flash" --seconds 4 --resolution 360p
.venv\Scripts\python.exe -I flow.py download <project> <media> D:\out\clip.mp4
.venv\Scripts\python.exe -I flow.py proxy-stop
```
`flow.py --help` lists all commands (projects, media, upload, upscale, edit, characters, scenes, collections). The MCP server exposes the same set as `flow_*` tools; `flow_models` shows live model keys and credit costs.

## Notes
- Put all media of one video in ONE project; every media call takes the project id.
- Videos cost credits (Omni 1.1 Flash 4 s 360p = 4; Omni edit 10-20); check `credits` first and use `--max-credits` / `max_credits`.
- Chrome cannot open one profile twice: do not run gflow or a second flow call at the same time. The server closes Chrome after the idle time.
- If a submit reply is lost, list the project's media before retrying, or you may be billed twice. `PUBLIC_ERROR_UNUSUAL_ACTIVITY` means Google flagged the browser: stop and wait.
- Flow's UI changes can break the page-driven parts (generate, upload, upscale); plain RPC calls are steadier.
- `dev/` holds RPC-mapping scratch scripts (not needed to run the tool); some read `FLOW_TEST_PROJECT`, `FLOW_TEST_MEDIA`, `FLOW_TEST_OUT` from the environment.
