# Browser Bridge

> **Quick setup:** give your AI agent this line: *Download https://github.com/Sajjad-Majdi/my-tools/releases/download/browser-bridge/browser-bridge.zip, unzip it, and set it up for me by following its README.md.*

Lets an AI agent drive the user's real, signed-in Chrome: list/open/close tabs, read page text, click and type with real input events, press shortcuts, take screenshots, run CDP calls. A Chrome extension (one per profile) keeps a WebSocket to a small local relay, `bb.exe`, which is also the command line.

## Requirements

- Windows 10/11 (the relay uses Windows process flags) and Google Chrome 116+.
- Rust toolchain with `rustc` 1.79+ to build the relay (no crates needed). No prebuilt `bb.exe` is in this folder.
- Python 3.9+ only for the optional `bb.py` API. No accounts needed.

## Setup (for an agent)

Install folder used below: `%USERPROFILE%\.browser-bridge` (any folder works; keep `bb.exe`, `bb.py`, `token.txt` together).

1. `mkdir %USERPROFILE%\.browser-bridge` and copy `bb.py` and the `extension\` folder (`bg.js`, `manifest.json`, `config.example.js`) into it.
2. Build the relay: `rustc -O -C strip=symbols --edition 2021 src\main.rs -o %USERPROFILE%\.browser-bridge\bb.exe`
3. Make a random token (PowerShell), save it as `token.txt` next to `bb.exe`, and write the same value into `extension\config.js` (it replaces the placeholder in `config.example.js`; `PORT` stays 8765):
   ```
   $b=New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $t=($b|%{$_.ToString('x2')}) -join ''
   $d="$env:USERPROFILE\.browser-bridge"
   Set-Content -NoNewline -Encoding ascii "$d\token.txt" $t
   Set-Content -Encoding ascii "$d\extension\config.js" "const TOKEN = '$t';`r`nconst PORT = 8765;"
   ```
   Never print the token or commit `token.txt` / `config.js`. It gives full control of the browser.
4. Load the extension (Chrome cannot do this from a script): open `chrome://extensions`, switch on Developer mode, "Load unpacked", choose `%USERPROFILE%\.browser-bridge\extension`. Repeat in every Chrome profile to be controlled. Ask the user to do this and wait.
5. Smoke test: `%USERPROFILE%\.browser-bridge\bb.exe profiles` (starts the relay by itself, hidden) must list the profile; then `bb.exe tabs`. If empty, make sure Chrome is open, wait 10 s, retry once.
6. Optional: shortcut to `bb.exe start` in the Startup folder so the relay runs at login. Optional: add the folder to PATH.
7. Optional: copy a skill/instruction file for the agent describing the commands below.

## Configuration

- `extension\config.js` (git-ignored; create it from `extension\config.example.js`): `TOKEN` (must equal `token.txt`) and `PORT`.
- `token.txt`: read from the folder of `bb.exe`, or its parent folder.
- Port 8765 is hard-coded as `ADDR` in `src/main.rs` and in `_call` in `bb.py`; to change it edit both, rebuild, and set `PORT` in `config.js`.
- `drive.py` is an unrelated Google Drive upload helper; it needs `pip install requests certifi` and OAuth files in `~/.config/google-drive-mcp/` (`tokens.json`, `gcp-oauth.keys.json`, account alias). Skip it unless you have those.
- The profile label is the Chrome account email, or a UUID if none; rename with `bb -p <profile> rename {"name":"work"}`.
- No other personal value is in the code: paths come from the folder of `bb.exe` / `bb.py`. This folder is a source copy; the live install is wherever you put these files.

## Usage

```
bb.exe profiles
bb.exe -p work tabs
bb.exe -p work text {"tab":"github","max":3000}          # tab = id, or part of title/url
bb.exe -p work snapshot {"tab":"github"}                  # elements with refs and coordinates
bb.exe -p work click {"tab":"github","ref":"r12"}         # or {"x":100,"y":200}
bb.exe -p work type {"text":"hello"}                      # also: keys {"chord":"ctrl+a"}, navigate, open, shot {"out":"a.jpg"}
```
Python: `import bb; bb.cmd("text", profile="work", tab="github")`.

## Notes

- Omit `-p` only when exactly one profile is connected; omit `tab` to use the focused tab.
- Chrome shows a "debugging this browser" banner on controlled tabs; that is expected.
- Edited extension files are picked up with `bb.exe -p work update` or by reloading it in `chrome://extensions`.
- Pages that block the debugger (chrome:// pages, some web-store pages) cannot be driven.
