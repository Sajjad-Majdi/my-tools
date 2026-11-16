# vpn-watchdog

Keeps a Windscribe VPN connected on Windows. When the tunnel drops (or is "connected" but passes no traffic), it reconnects by itself through `windscribe-cli`, so nobody has to sit at the PC.

Quick setup prompt for an agent: "Set up vpn-watchdog from this folder: check windscribe-cli path, start it hidden, add the VBS to the Startup folder, confirm the log shows `start`."

## Setup
1. Windscribe desktop app installed and logged in (`windscribe-cli.exe status` must answer).
2. Python 3 (standard library only).
3. Optional `config.json` next to `watchdog.py` (all keys optional): `cli` (path of windscribe-cli.exe), `probe_url`, `check_sec` (30), `fails_before_reconnect` (2), `min_gap_sec` (60), `locations` (list; it rotates through them on each reconnect; empty = last used).
4. Edit the paths in `start-hidden.vbs`, run it once, and copy it into `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` to start with Windows.

## Use
- Log: `watchdog.log` (start, every drop, every reconnect result).
- Stop it: end the `python.exe` process whose command line contains `watchdog.py`. While it runs, a manual disconnect is undone within about a minute.
- Only one copy runs (it holds a local lock port).
