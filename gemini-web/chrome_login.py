"""Browser-profile login for gweb: sign in to Google once in a Chrome window, then get fresh cookies by itself.

  login()                    shows Chrome (own profile folder) at gemini.google.com; waits for sign-in; saves cookies.json
  refresh_from_profile()     starts the same profile headless, reads the google.com cookies over the Chrome DevTools
                             Protocol (CDP), writes cookies.json, closes Chrome. No window, no cookie-database decryption.

Standard library only (a tiny WebSocket client is included). Chrome path, profile folder and proxy come from
config.local.json or env vars: chrome_path / GWEB_CHROME, profile_dir / GWEB_PROFILE_DIR, chrome_proxy / GWEB_CHROME_PROXY.
Cookie values are never printed.
"""
import base64, contextlib, json, os, pathlib, socket, struct, subprocess, sys, threading, time
import urllib.parse, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import config

COOKIES = HERE / "cookies.json"
GEMINI_URL = "https://gemini.google.com/"
NEED = "__Secure-1PSID"
MAX_AGE = 600          # seconds: a cookies.json newer than this is not refreshed again
CREATE_NO_WINDOW = 0x08000000


class LoginError(Exception):
    """Sign-in needed, or the browser could not be used. The message tells the user what to do."""


# ---------------------------------------------------------------- settings
def profile_dir() -> pathlib.Path:
    p = pathlib.Path(str(config.get("profile_dir", "GWEB_PROFILE_DIR", HERE / "browser_profile")))
    return p if p.is_absolute() else HERE / p


def _marker() -> pathlib.Path:
    return profile_dir() / ".gweb_signed_in"


def profile_ready() -> bool:
    """True after `gweb.py login` finished once. Until then the automatic refresh is skipped (no Chrome start)."""
    return _marker().exists()


def find_chrome() -> str:
    c = config.get("chrome_path", "GWEB_CHROME")
    if c:
        if pathlib.Path(str(c)).is_file():
            return str(c)
        raise LoginError(f"chrome_path / GWEB_CHROME points to a missing file: {c}")
    rel = r"Google\Chrome\Application\chrome.exe"
    cands = [os.path.join(os.environ.get(v, ""), rel) for v in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")
             if os.environ.get(v)]
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") as k:
                    cands.append(winreg.QueryValueEx(k, "")[0])
            except OSError:
                pass
    except ImportError:
        pass
    import shutil
    cands += [shutil.which("chrome") or "", shutil.which("google-chrome") or ""]
    for p in cands:
        if p and os.path.isfile(p):
            return p
    raise LoginError("Google Chrome was not found. Install it, or set chrome_path (env GWEB_CHROME) to chrome.exe.")


# ---------------------------------------------------------------- minimal WebSocket + CDP client
class _WS:
    def __init__(self, url: str, timeout: float = 10):
        u = urllib.parse.urlsplit(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=timeout)   # direct, ignores proxy env
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + ("?" + u.query if u.query else "")
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        self.f = self.sock.makefile("rb")
        if b" 101 " not in self.f.readline():
            raise LoginError("Chrome refused the DevTools connection.")
        while self.f.readline() not in (b"\r\n", b""):
            pass

    def _exact(self, n: int) -> bytes:
        b = self.f.read(n)
        if len(b) < n:
            raise LoginError("Chrome closed the DevTools connection.")
        return b

    def send(self, text: str, op: int = 1):
        data = text.encode()
        n = len(data)
        head = bytes([0x80 | op])
        head += bytes([0x80 | n]) if n < 126 else (b"\xfe" + struct.pack(">H", n) if n < 65536 else b"\xff" + struct.pack(">Q", n))
        mask = os.urandom(4)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self, timeout: float) -> str:
        self.sock.settimeout(max(timeout, 0.1))
        msg = b""
        while True:
            h = self._exact(2)
            fin, op, n = h[0] & 0x80, h[0] & 0x0F, h[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._exact(8))[0]
            payload = self._exact(n)
            if op == 8:
                raise LoginError("Chrome closed the DevTools connection.")
            if op == 9:
                self.send(payload.decode("latin-1"), 10)
                continue
            if op in (0, 1, 2):
                msg += payload
                if fin:
                    return msg.decode("utf-8", "replace")

    def close(self):
        with contextlib.suppress(Exception):
            self.sock.close()


class _CDP:
    def __init__(self, ws_url: str):
        self.ws, self.n, self.events = _WS(ws_url), 0, []

    def call(self, method: str, params: dict | None = None, timeout: float = 15):
        self.n += 1
        i = self.n
        self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while True:
            try:
                m = json.loads(self.ws.recv(end - time.time()))
            except socket.timeout:
                raise LoginError(f"Chrome did not answer {method} in time.") from None
            if m.get("id") == i:
                if "error" in m:
                    raise LoginError(f"Chrome DevTools error on {method}: {m['error'].get('message')}")
                return m.get("result", {})
            if "method" in m:
                self.events.append(m["method"])

    def wait_event(self, name: str, timeout: float) -> bool:
        end = time.time() + timeout
        while name not in self.events:
            try:
                m = json.loads(self.ws.recv(end - time.time()))
            except (socket.timeout, LoginError):
                return False
            if "method" in m:
                self.events.append(m["method"])
        return True

    def close(self):
        self.ws.close()


def _http_json(port: int, path: str, timeout: float = 3):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never through a proxy
    with op.open(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
        return json.loads(r.read().decode())


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------- Chrome process
def _launch(headless: bool, port: int, url: str) -> subprocess.Popen:
    prof = profile_dir()
    prof.mkdir(parents=True, exist_ok=True)
    args = [find_chrome(), f"--user-data-dir={prof}", f"--remote-debugging-port={port}", "--remote-allow-origins=*",
            "--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled",
            "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
            "--disable-features=CalculateNativeWinOcclusion"]
    proxy = config.get("chrome_proxy", "GWEB_CHROME_PROXY") or config.get("proxy", "GWEB_PROXY")
    if proxy:
        args.append(f"--proxy-server={proxy}")
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if headless:
        args += ["--headless=new", "--disable-gpu", "--mute-audio"]
        if os.name == "nt":
            si = subprocess.STARTUPINFO()
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            si.wShowWindow = 0   # SW_HIDE
            kw.update(creationflags=CREATE_NO_WINDOW, startupinfo=si)
    return subprocess.Popen(args + [url], **kw)


def _wait_ready(port: int, proc: subprocess.Popen, timeout: float = 30) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            raise LoginError("Chrome closed right away. If the Gemini login window is still open, close it and try "
                             "again (the profile can only be used by one Chrome at a time).")
        try:
            return _http_json(port, "/json/version")
        except Exception:
            time.sleep(0.3)
    raise LoginError("Chrome did not open its DevTools port in time.")


def _get_cookies(port: int) -> list:
    """All cookies of the profile: browser-level Storage.getCookies, else Network.getAllCookies on a page."""
    try:
        cdp = _CDP(_http_json(port, "/json/version")["webSocketDebuggerUrl"])
        try:
            return cdp.call("Storage.getCookies")["cookies"]
        finally:
            cdp.close()
    except (LoginError, KeyError, OSError):
        pass
    pages = [t for t in _http_json(port, "/json/list") if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
    if not pages:
        raise LoginError("Chrome has no page to read cookies from.")
    cdp = _CDP(pages[0]["webSocketDebuggerUrl"])
    try:
        return cdp.call("Network.getAllCookies")["cookies"]
    finally:
        cdp.close()


def _page_urls(port: int) -> list[str]:
    try:
        return [t.get("url", "") for t in _http_json(port, "/json/list") if t.get("type") == "page"]
    except Exception:
        return []


def _close(proc: subprocess.Popen, port: int):
    """Graceful close (flushes cookies to disk), then force if needed."""
    if proc.poll() is None:
        with contextlib.suppress(Exception):
            cdp = _CDP(_http_json(port, "/json/version")["webSocketDebuggerUrl"])
            with contextlib.suppress(Exception):
                cdp.call("Browser.close", timeout=5)
            cdp.close()
        try:
            proc.wait(12)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True,
                               creationflags=CREATE_NO_WINDOW)
            else:
                proc.kill()
            with contextlib.suppress(Exception):
                proc.wait(5)


# ---------------------------------------------------------------- cookies.json
def _to_jar(cookies: list) -> dict:
    g = [c for c in cookies if c.get("domain", "").lstrip(".").endswith("google.com")]
    g.sort(key=lambda c: c["domain"] == ".google.com")   # the ".google.com" copy wins on duplicate names
    return {c["name"]: c["value"] for c in g}


def _write(jar: dict):
    tmp = COOKIES.with_name("cookies.json.tmp")
    tmp.write_text(json.dumps(jar), encoding="utf-8")
    os.replace(tmp, COOKIES)


def cookies_fresh(max_age: float = MAX_AGE) -> bool:
    """cookies.json was written in the last `max_age` seconds and holds the session cookie."""
    try:
        if time.time() - COOKIES.stat().st_mtime > max_age:
            return False
        return bool(json.loads(COOKIES.read_text(encoding="utf-8-sig")).get(NEED))
    except (OSError, ValueError, AttributeError):
        return False


@contextlib.contextmanager
def _lock(timeout: float = 90):
    path = HERE / ".refresh.lock"
    end = time.time() + timeout
    while True:
        try:
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            with contextlib.suppress(OSError):
                if time.time() - path.stat().st_mtime > 120:   # stale
                    path.unlink()
                    continue
            if time.time() > end:
                raise LoginError("Another gweb cookie refresh is still running.") from None
            time.sleep(0.5)
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            path.unlink()


# ---------------------------------------------------------------- public entry points
def refresh_from_profile(force: bool = False) -> dict:
    """Headless Chrome with the login profile -> fresh google.com cookies -> cookies.json. Raises LoginError."""
    with _lock():
        if not force and cookies_fresh():
            return json.loads(COOKIES.read_text(encoding="utf-8-sig"))
        port = _free_port()
        proc = _launch(True, port, "about:blank")
        try:
            _wait_ready(port, proc)
            # open Gemini so Google can rotate the short-lived cookie; a slow or blocked page is not an error
            with contextlib.suppress(Exception):
                pages = [t for t in _http_json(port, "/json/list") if t.get("type") == "page"]
                cdp = _CDP(pages[0]["webSocketDebuggerUrl"])
                try:
                    cdp.call("Page.enable")
                    cdp.call("Page.navigate", {"url": GEMINI_URL})
                    if cdp.wait_event("Page.loadEventFired", 15):
                        time.sleep(1.5)
                finally:
                    cdp.close()
            jar = _to_jar(_get_cookies(port))
        finally:
            _close(proc, port)
    if not jar.get(NEED):
        raise LoginError("The browser profile is not signed in to Google (or the login expired). "
                         "Run once: python gweb.py login")
    _write(jar)
    return jar


def login(timeout: float = 900) -> int:
    """Visible Chrome with the login profile at gemini.google.com. Waits for sign-in, saves cookies, closes Chrome."""
    try:
        port = _free_port()
        proc = _launch(False, port, GEMINI_URL)
    except (LoginError, OSError) as e:
        print(f"gweb login: {e}", file=sys.stderr)
        return 1
    print("A Chrome window opened at gemini.google.com. Sign in to your Google account there.\n"
          "This tool detects the sign-in by itself and closes the window (or press Enter here when you are signed in).")
    pressed = threading.Event()

    def _watch():
        with contextlib.suppress(Exception):
            if sys.stdin.readline():
                pressed.set()
    threading.Thread(target=_watch, daemon=True).start()
    jar, seen_at, end = {}, None, time.time() + timeout
    try:
        _wait_ready(port, proc)
        while time.time() < end and not pressed.is_set() and proc.poll() is None:
            try:
                j = _to_jar(_get_cookies(port))
            except (LoginError, OSError):
                j = {}
            if j.get(NEED):
                jar = j
            on_gemini = any(u.startswith(GEMINI_URL) for u in _page_urls(port))
            if j.get(NEED) and on_gemini:
                if seen_at is None:
                    seen_at = time.time()
                    print("Signed in. Saving in a few seconds...")
                elif time.time() - seen_at >= 6:
                    break
            else:
                seen_at = None
            time.sleep(2)
        with contextlib.suppress(Exception):
            if proc.poll() is None:
                j = _to_jar(_get_cookies(port))
                if j.get(NEED):
                    jar = j
    except LoginError as e:
        print(f"gweb login: {e}", file=sys.stderr)
    finally:
        _close(proc, port)
    if not jar.get(NEED):
        print("gweb login: no Google sign-in was found. Run `python gweb.py login` again and sign in.", file=sys.stderr)
        return 1
    _write(jar)
    _marker().write_text("ok", encoding="utf-8")
    note = "" if jar.get("__Secure-1PSIDTS") else " (warning: __Secure-1PSIDTS is missing; run `python gweb.py refresh-cookies`)"
    print(f"Done. Cookies saved to cookies.json, login kept in {profile_dir().name}/. No need to sign in again{note}.")
    return 0


if __name__ == "__main__":   # python chrome_login.py login | refresh
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "login":
        sys.exit(login())
    if cmd == "refresh":
        try:
            print("OK", len(refresh_from_profile(force=True)), "cookies")
        except LoginError as e:
            print(f"gweb: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        sys.exit("usage: python chrome_login.py login|refresh")
