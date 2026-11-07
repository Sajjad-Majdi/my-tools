"""Python API for Browser Bridge 2. The relay and CLI are bb.exe (Rust, src/main.rs):
  bb.exe profiles | bb.exe [-p PROFILE] TYPE [JSON] | bb.exe start
"""
import json, socket, subprocess, sys
from pathlib import Path

HERE = Path(__file__).parent
EXE = str(HERE / "bb.exe")
TOKEN = (HERE / "token.txt").read_text().strip()


def _call(profile, command, timeout=90):
    """One relay round trip over a raw socket (about 2 ms). bb.exe starts the relay when it is down."""
    try:
        s = socket.create_connection(("127.0.0.1", 8765), timeout=2)
    except OSError:
        subprocess.run([EXE, "start"])
        for _ in range(100):
            try:
                s = socket.create_connection(("127.0.0.1", 8765), timeout=2); break
            except OSError:
                import time; time.sleep(0.02)
        else:
            raise RuntimeError("relay did not start")
    with s:
        s.settimeout(timeout + 10)
        lines = [TOKEN, profile or "", str(timeout), json.dumps(command, ensure_ascii=False), ""]
        s.sendall(chr(10).join(lines).encode())
        return json.loads(s.makefile("rb").readline())


def profiles():
    return _call("!profiles", {})


def cmd(type, profile=None, **fields):
    """Python API: bb.cmd("text", profile="work", tab="colab", tail=1). Raises on error, returns the result."""
    reply = _call(profile, {"type": type, **fields}, fields.get("timeout", 90))
    if "error" in reply:
        raise RuntimeError(reply["error"])
    return reply["result"]


def js(expr, profile=None, tab=None):
    """Read-only evaluation. Wrap multi-statement code in an IIFE and write the Python side as a raw string."""
    return cmd("eval", profile=profile, tab=tab, expr=expr)["value"]


def paste(text, profile=None, tab=None, replace=True):
    return cmd("batch", profile=profile, tab=tab, steps=paste_steps(text, replace))


def set_clipboard(text):
    """Windows clipboard through a UTF-8 file; piping stdin to PowerShell mangles non-ASCII text."""
    import subprocess, tempfile
    path = Path(tempfile.gettempdir()) / "bb_clip.txt"
    path.write_text(text, encoding="utf-8")
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '{path}')"], check=True)


def chord(key, code, vk, commands):
    base = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": 2}
    return [{"type": "cdp", "method": "Input.dispatchKeyEvent", "params": {**base, "type": "rawKeyDown", "commands": commands}},
            {"type": "cdp", "method": "Input.dispatchKeyEvent", "params": {**base, "type": "keyUp"}}]


def paste_steps(text, replace=True):
    """Real paste into the focused editor. Monaco auto-indents typed or insertText newlines; paste does not."""
    set_clipboard(text)
    return (chord("a", "KeyA", 65, ["selectAll"]) if replace else []) + chord("v", "KeyV", 86, ["paste"])


def main():
    # The CLI lives in bb.exe now (starts in milliseconds); this forwards for old habits.
    sys.exit(subprocess.run([EXE, *sys.argv[1:]]).returncode)


if __name__ == "__main__":
    main()
