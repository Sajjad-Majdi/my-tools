"""Copy your aparat.com cookies from Chrome (Browser Bridge extension, CDP) into cookies.json. Values are never printed."""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import config
_bridge, P = config.get("bridge_path", "BROWSER_BRIDGE_PATH"), config.get("bridge_profile", "BROWSER_BRIDGE_PROFILE")
if not (_bridge and P):
    sys.exit("grab_cookies.py needs the Browser Bridge extension: set bridge_path and bridge_profile in config.local.json "
             "(or env BROWSER_BRIDGE_PATH / BROWSER_BRIDGE_PROFILE). Without it, write cookies.json by hand (see README.md).")
sys.path.insert(0, str(_bridge)); import bb
tabs = bb.cmd("tabs", profile=P)
tab = next(t["id"] for t in tabs if t["url"].startswith("http"))
r = bb.cmd("cdp", profile=P, tab=tab, method="Network.getCookies", params={"urls": ["https://www.aparat.com", "https://aparat.com"]})
jar = {c["name"]: c["value"] for c in r["cookies"] if "aparat.com" in c["domain"]}
print("AuthV1" in jar, len(jar))
pathlib.Path(__file__).with_name("cookies.json").write_text(json.dumps(jar), encoding="utf-8")
