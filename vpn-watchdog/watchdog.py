"""Keep a Windscribe VPN connected: reconnect by itself when it drops.

Every CHECK_SEC seconds it reads `windscribe-cli status` and probes one HTTPS URL.
If the VPN is not connected, or the probe fails FAILS_BEFORE_RECONNECT times in a row,
it runs `windscribe-cli connect` (optionally with a location from config.json).
Only one copy runs (lock port). Log: watchdog.log next to this file.
"""
import json, os, socket, subprocess, sys, time, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = {
    "cli": r"C:\Program Files\Windscribe\windscribe-cli.exe",
    "probe_url": "https://www.google.com/generate_204",
    "check_sec": 30,
    "fails_before_reconnect": 2,
    "min_gap_sec": 60,
    "locations": [],          # e.g. ["best"] or city names; empty = last used
    "lock_port": 49731,
}
try:
    CFG.update(json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8")))
except FileNotFoundError:
    pass

LOG = os.path.join(HERE, "watchdog.log")
NOWIN = 0x08000000  # CREATE_NO_WINDOW


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    # keep the log small
    try:
        if os.path.getsize(LOG) > 1_000_000:
            lines = open(LOG, encoding="utf-8").readlines()[-2000:]
            open(LOG, "w", encoding="utf-8").writelines(lines)
    except OSError:
        pass


def cli(*args, timeout=90):
    try:
        r = subprocess.run([CFG["cli"], *args], capture_output=True, text=True,
                           timeout=timeout, creationflags=NOWIN)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:  # noqa: BLE001
        return f"cli error: {e}"


def connected():
    out = cli("status", timeout=30)
    for line in out.splitlines():
        if line.lower().startswith("connect state"):
            return "connected:" in line.lower(), line.strip()
    return False, out.strip()[:120]


def probe():
    try:
        urllib.request.urlopen(CFG["probe_url"], timeout=10)
        return True
    except Exception:  # noqa: BLE001
        return False


def main():
    lock = socket.socket()
    try:
        lock.bind(("127.0.0.1", CFG["lock_port"]))
    except OSError:
        sys.exit(0)  # another copy is running
    log("start")
    fails, last_fix, loc_i = 0, 0.0, 0
    while True:
        ok_state, state = connected()
        ok_net = probe() if ok_state else False
        fails = 0 if (ok_state and ok_net) else fails + 1
        if fails >= CFG["fails_before_reconnect"] and time.time() - last_fix > CFG["min_gap_sec"]:
            locs = CFG["locations"]
            args = ["connect"] + ([locs[loc_i % len(locs)]] if locs else [])
            log(f"down ({state}; net={ok_net}) -> {' '.join(args)}")
            if ok_state:  # connected but no traffic: reconnect cleanly
                cli("disconnect")
            out = cli(*args)
            last_fix = time.time()
            loc_i += 1
            time.sleep(10)
            ok_state, state = connected()
            log(f"after reconnect: {state}; net={probe()} | {out.strip()[-120:]}")
            fails = 0
        time.sleep(CFG["check_sec"])


if __name__ == "__main__":
    main()
