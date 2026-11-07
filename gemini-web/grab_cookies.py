"""Copy your Google cookies for gemini.google.com from Chrome (Browser Bridge extension, CDP) into cookies.json.
Values are never printed."""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import config
_bridge, P = config.get("bridge_path", "BROWSER_BRIDGE_PATH"), config.get("bridge_profile", "BROWSER_BRIDGE_PROFILE")
if not (_bridge and P):
    sys.exit("grab_cookies.py needs the Browser Bridge extension: set bridge_path and bridge_profile in config.local.json "
             "(or env BROWSER_BRIDGE_PATH / BROWSER_BRIDGE_PROFILE). Without it, write cookies.json by hand (see README.md).")
sys.path.insert(0, str(_bridge)); import bb
r = bb.cmd("cdp", profile=P, tab="gemini.google", method="Network.getCookies",
           params={"urls": ["https://gemini.google.com", "https://www.google.com", "https://accounts.google.com"]})
cookies = r.get("cookies", r) if isinstance(r, dict) else r
jar = {c["name"]: c["value"] for c in cookies if c.get("domain", "").endswith("google.com")}
need = ["__Secure-1PSID", "__Secure-1PSIDTS"]
print({k: (k in jar) for k in need}, "total", len(jar))
out = pathlib.Path(__file__).with_name("cookies.json")
out.write_text(json.dumps(jar), encoding="utf-8")
print("saved", out)
