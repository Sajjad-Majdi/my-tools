# FastDesk

Lets an agent operate Windows desktop apps through UI Automation. It lists windows, prints a window's elements (role, name, value), and runs a whole JSON "chain" of steps (open, wait, click, set text, toggle, menu, read, minimize, close) in one command with no model call between steps. Elements are found by role and name, never by pixel position, and the real mouse never moves.

## Requirements

- Windows 10 or 11, Python 3.9+ (3.13 tested), internet access for `pip` once.
- Python package `uiautomation` (pulls in `comtypes`). No accounts.
- The target app must run at the same privilege level: a normal process cannot drive an elevated (administrator) window.

## Setup (for an agent)

Run from this folder (`fastdesk`). The launcher `fd.cmd` hard-requires a virtual environment named `.venv` beside it.

1. `python -m venv .venv`
2. `.venv\Scripts\python.exe -m pip install uiautomation`
3. Smoke test: `fd.cmd windows` must list the open windows; then `fd.cmd view "<part of one window title>"` must print `role | name | value` rows.
4. Optional: add this folder to the user PATH so `fd` works in any shell (PowerShell: `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';<full path to this folder>', 'User')`, then open a new shell; avoid `setx`, it truncates long PATHs). `fd.cmd` locates itself with `%~dp0`, so the folder can live anywhere.
5. Optional demo (opens Windows Calculator, English UI only): `fd.cmd run calc-multiply`. Ask the owner first.
6. Tell the agent that uses it: run `view` to learn element names, put the steps in a chain file, then `run` it; on a failure the output names the failing step, all window titles and the window's elements, so only that step needs fixing.

## Configuration

- No config file, secret or personal value in the code. A chain name given to `fd run` is looked up in `chains\` (your own chains) and then in `examples\`; any path ending in `.json` also works.
- `examples\idm-download.json` and `examples\idm-add-download.json` are samples for Internet Download Manager: they hard-code the default `C:/Program Files (x86)/Internet Download Manager/IDMan.exe` and the Persian IDM window texts. Change the `open` path and the button/window names for your install and language, or ignore them (the `idmdl` tool is the better way to drive IDM).
- `chains\calc-multiply.json` uses English Calculator button names ("One", "Multiply by", ...); change them for another Windows language.
- Chain files are read as UTF-8 and output is UTF-8, so Persian or other non-ASCII names work.

## Usage

```
fd.cmd windows
fd.cmd view "Notepad"            (add --all to include non-interactive elements)
fd.cmd run calc-multiply
fd.cmd run C:\path\my-chain.json --var url=https://example.com/file.zip
```
Step shapes (full list in the docstring at the top of `fastdesk.py`):
`{"open":"notepad.exe"}`, `{"wait":"Notepad","timeout":10}`, `{"set":null,"role":"textfield","index":0,"value":"{url}"}`, `{"click":"Save","role":"button"}`, `{"read":"regex"}`, `{"close":"Notepad"}`.

## Notes

- Window and element titles are matched by case-insensitive "contains"; element names match exactly first, then by "contains".
- `open` starts the program with `subprocess.Popen` using the exact string given, so give a full path or a name on PATH.
- UWP and some custom-drawn apps expose few elements; `view --all` shows what is there.
- Do not run steps that spend money, send messages or delete data unless the owner asked for exactly that.
