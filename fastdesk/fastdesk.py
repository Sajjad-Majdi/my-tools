"""fastdesk: run a whole chain of desktop steps with no model between steps.

Talks to Windows UI Automation in process (Python `uiautomation`), so finding and pressing
an element takes milliseconds. Elements are found by role + name, never by screen position,
so window size and position do not matter, and the real mouse never moves.

  fd windows                       list open windows
  fd view  "<window title part>"   compact element list of one window (role | name | value)
  fd run   <chain name|file.json> [--var key=value ...]

(fd = fd.cmd in this folder; a chain name is looked up in chains/ then examples/)

A chain is a JSON list of steps (or {"about": ..., "steps": [...]}). Every step may carry
"window": "<title part>" (otherwise the last window used) and "optional": true. Steps:
  {"open": "C:/path/app.exe"}                       start the app, or show it from the tray
  {"wait": "<title part>", "timeout": 15}           wait until such a window exists; it becomes current
  {"wait": "<title part>", "new": true}          only a window that was not open when the run began
  {"wait_gone": "<title part>", "timeout": 15}
  {"click": "<name>", "role": "button"}             name: exact match first, then contains
  {"click": null, "role": "button", "index": 0}     unnamed element: Nth unnamed of that role
  {"set": "<name>|null", "role": "textfield", "index": 0, "value": "{url}"}
  {"toggle": "<name>", "role": "checkbox"}
  {"menu": ["<top menu>", "<item>"]}
  {"read": "<regex>"}                               texts of the window (filtered by regex)
  {"hide": "<title part>"}                        IDM progress window: press "hide beside the clock"
  {"minimize_all_except": ["Claude"]}
  {"restore" | "minimize" | "close": "<title part>"}
  {"sleep": 0.5}
{var} in any string is replaced from --var. On a failing step it prints the step, the error,
all window titles and the window's elements, so a model can fix only that step.
Roles: button textfield checkbox radio option(list item) listitem combobox menuitem menubutton
tab tabitem statictext text link treeitem document group window.
"""
import ctypes, json, os, re, subprocess, sys, threading, time
from ctypes import wintypes
import uiautomation as auto

auto.SetGlobalSearchTimeout(0)          # never let the library sleep-retry on its own
HERE = os.path.dirname(os.path.abspath(__file__))
U32 = ctypes.windll.user32
U32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

ROLE = {"button": "ButtonControl", "textfield": "EditControl", "edit": "EditControl",
        "checkbox": "CheckBoxControl", "radio": "RadioButtonControl",
        "option": "ListItemControl", "listitem": "ListItemControl", "combobox": "ComboBoxControl",
        "menuitem": "MenuItemControl", "menubutton": "SplitButtonControl", "tab": "TabControl",
        "tabitem": "TabItemControl", "statictext": "TextControl", "text": "TextControl",
        "link": "HyperlinkControl", "treeitem": "TreeItemControl", "document": "DocumentControl",
        "group": "GroupControl", "window": "WindowControl", "list": "ListControl"}
ROLE_BACK = {v: k for k, v in ROLE.items() if k not in ("edit", "listitem", "text")}


# ---------- windows (plain Win32: fast) ----------
def windows():
    out = []
    def cb(h, _):
        if U32.IsWindowVisible(h) and not U32.GetWindow(h, 4):   # visible, no owner = top level
            n = U32.GetWindowTextLengthW(h)
            if n:
                b = ctypes.create_unicode_buffer(n + 1)
                U32.GetWindowTextW(h, b, n + 1)
                cloaked = ctypes.c_int(0)
                ctypes.windll.dwmapi.DwmGetWindowAttribute(h, 14, ctypes.byref(cloaked), 4)
                tool = U32.GetWindowLongW(h, -20) & 0x80          # WS_EX_TOOLWINDOW
                if not cloaked.value and not tool and b.value != "Program Manager":
                    out.append({"hwnd": h, "title": b.value, "minimized": bool(U32.IsIconic(h))})
        return True
    U32.EnumWindows(ENUM(cb), 0)
    # owned dialogs (IDM dialogs are owned by the main window): add visible ones too
    def cb2(h, _):
        if U32.IsWindowVisible(h) and U32.GetWindow(h, 4) and h not in [w["hwnd"] for w in out]:
            n = U32.GetWindowTextLengthW(h)
            if n:
                b = ctypes.create_unicode_buffer(n + 1)
                U32.GetWindowTextW(h, b, n + 1)
                out.append({"hwnd": h, "title": b.value, "minimized": bool(U32.IsIconic(h))})
        return True
    U32.EnumWindows(ENUM(cb2), 0)
    return out


def find_window(part, skip=()):
    part = part.lower()
    for w in windows():
        if part in w["title"].lower() and w["hwnd"] not in skip:
            return w
    return None


# ---------- elements (UI Automation in process) ----------
def walk(ctrl, max_depth=25):
    for c, _d in auto.WalkControl(ctrl, includeTop=False, maxDepth=max_depth):
        yield c


def role_of(c):
    return ROLE_BACK.get(c.ControlTypeName, c.ControlTypeName.replace("Control", "").lower())


def find(root, name, role, index):
    ctype = ROLE.get(role, role) if role else None
    idx = index or 0
    exact, part, unnamed = [], [], []
    for c in walk(root):
        if ctype and c.ControlTypeName != ctype:
            continue
        n = (c.Name or "").strip()
        if name is None:
            if not n:
                unnamed.append(c)
                if len(unnamed) > idx:
                    return unnamed[idx]
        elif n == name:
            exact.append(c)
            if len(exact) > idx:
                return exact[idx]
        elif name.lower() in n.lower():
            part.append(c)
    return part[idx] if name is not None and len(part) > idx else None


import queue
JOBS = queue.Queue()


def _worker():
    # one COM-initialised thread for presses, so a modal dialog that blocks Invoke
    # never blocks the chain, and no thread or COM setup is paid per click
    with auto.UIAutomationInitializerInThread():
        while True:
            fn, ev = JOBS.get()
            try:
                fn()
            finally:
                ev.set()


threading.Thread(target=_worker, daemon=True).start()


def press(c):
    """Press without moving the mouse and without blocking on a modal dialog it opens."""
    h = c.NativeWindowHandle
    if h and c.ControlTypeName == "ButtonControl":
        U32.PostMessageW(h, 0x00F5, 0, 0)            # BM_CLICK, returns at once
        return
    done = {}
    def go():
        try:
            for get, act in (("GetInvokePattern", "Invoke"), ("GetTogglePattern", "Toggle"),
                             ("GetSelectionItemPattern", "Select"),
                             ("GetLegacyIAccessiblePattern", "DoDefaultAction")):
                try:
                    p = getattr(c, get)()
                    if p:
                        getattr(p, act)(waitTime=0)   # the library sleeps 0.5 s by default
                        done["ok"] = act
                        return
                except Exception:
                    continue
            done["err"] = "no invoke/toggle/select/default action"
        except Exception as ex:
            done["err"] = str(ex)
    ev = threading.Event()
    JOBS.put((go, ev))
    ev.wait(0.6)                                  # a modal dialog keeps Invoke busy: move on
    if "err" in done:
        raise StepError(done["err"])


def elements_of(root, interactive=True):
    rows = []
    for c in walk(root):
        r, n = role_of(c), (c.Name or "").strip()
        if interactive and r in ("pane", "custom", "image", "separator", "scrollbar", "thumb",
                                 "titlebar", "statictext", "group", "toolbar", "header", "headeritem"):
            continue
        v = ""
        try:
            vp = c.GetValuePattern() if r in ("textfield", "combobox", "document") else None
            v = vp.Value if vp else ""
        except Exception:
            pass
        rows.append(f"{r} | {n or None}" + (f" | value={v[:40]}" if v else ""))
    return rows


def sub(x, vars_):
    if isinstance(x, str):
        return re.sub(r"\{(\w+)\}", lambda m: vars_.get(m.group(1), m.group(0)), x)
    if isinstance(x, list):
        return [sub(i, vars_) for i in x]
    if isinstance(x, dict):
        return {k: sub(v, vars_) for k, v in x.items()}
    return x


class StepError(Exception):
    pass


def ctrl_of(w):
    return auto.ControlFromHandle(w["hwnd"])


def run(chain, vars_):
    cur, results, times, t0 = None, [], [], time.perf_counter()
    before = {w["hwnd"] for w in windows()}   # for {"wait": ..., "new": true}
    for i, step in enumerate(chain):
        step = sub(step, vars_)
        ts = time.perf_counter()
        kind = next(iter(step))
        try:
            if "window" in step and not any(k in step for k in ("wait", "wait_gone")):
                w = find_window(step["window"])
                if not w:
                    raise StepError(f"window not found: {step['window']}")
                cur = w
            if "open" in step:
                subprocess.Popen([step["open"]])
                time.sleep(step.get("settle", 0.3))
            elif "wait" in step or "wait_gone" in step:
                part, gone = step.get("wait") or step.get("wait_gone"), "wait_gone" in step
                end = time.time() + step.get("timeout", 15)
                while True:
                    w = find_window(part, before if step.get("new") else ())
                    if (w is None) == gone:
                        if w:
                            cur = w
                        break
                    if time.time() > end:
                        raise StepError(f"timeout waiting for window {'gone: ' if gone else ''}{part}")
                    time.sleep(0.05)
            elif any(k in step for k in ("click", "set", "toggle")):
                if not cur:
                    raise StepError("no current window")
                verb = next(k for k in ("click", "set", "toggle") if k in step)
                end = time.time() + step.get("timeout", 3)
                while True:
                    c = find(ctrl_of(cur), step.get(verb), step.get("role"), step.get("index"))
                    if c is not None:
                        break
                    if time.time() > end:
                        raise StepError(f"no element role={step.get('role')} name={step.get(verb)} index={step.get('index')}")
                    time.sleep(0.05)
                if verb == "set":
                    vp = c.GetValuePattern()
                    if not vp:
                        raise StepError("element takes no value")
                    vp.SetValue(str(step["value"]), waitTime=0)
                elif verb == "toggle":
                    c.GetTogglePattern().Toggle(waitTime=0)
                else:
                    press(c)
            elif "menu" in step:
                top, item = step["menu"]
                m = find(ctrl_of(cur), top, "menuitem", None)
                if not m:
                    raise StepError(f"no menu {top}")
                m.GetExpandCollapsePattern().Expand(waitTime=0)
                end, it = time.time() + 2, None
                while it is None and time.time() < end:
                    it = find(auto.GetRootControl(), item, "menuitem", None)
                    time.sleep(0.05)
                if not it:
                    raise StepError(f"menu item not found: {item}")
                press(it)
            elif "hide" in step:
                # IDM-style "hide beside the clock" title-bar button, left of Minimize
                w = find_window(step["hide"])
                if not w:
                    raise StepError(f"window not found: {step['hide']}")
                h, how = w["hwnd"], None
                b = find(ctrl_of(w), step.get("button", "کنار ساعت"), "button", None)
                if b is not None:
                    press(b); how = "uia button"
                else:
                    mn = find(ctrl_of(w), "Minimize", "button", None)
                    if mn is not None:
                        r = mn.BoundingRectangle
                        x, y = r.left - (r.right - r.left) // 2, (r.top + r.bottom) // 2
                        lp = (y & 0xFFFF) << 16 | (x & 0xFFFF)
                        ht = U32.SendMessageW(h, 0x0084, 0, lp)          # WM_NCHITTEST
                        U32.PostMessageW(h, 0x00A1, ht, lp)              # WM_NCLBUTTONDOWN
                        U32.PostMessageW(h, 0x00A2, ht, lp)              # WM_NCLBUTTONUP
                        how = f"title-bar click ht={ht}"
                end = time.time() + 1.0
                while U32.IsWindowVisible(h) and time.time() < end:
                    time.sleep(0.05)
                if U32.IsWindowVisible(h):
                    U32.ShowWindow(h, 0); how = (how or "") + " -> SW_HIDE fallback"
                results.append({"step": i, "hide": how})
            elif "read" in step:
                rx, texts = re.compile(step["read"] or "."), []
                for c in walk(ctrl_of(cur)):
                    t = (c.Name or "").strip()
                    if t and rx.search(t) and t not in texts:
                        texts.append(t)
                results.append({"step": i, "title": cur["title"], "texts": texts[:60]})
            elif "minimize_all_except" in step:
                keep = [k.lower() for k in step["minimize_all_except"]]
                for w in windows():
                    if not w["minimized"] and not any(k in w["title"].lower() for k in keep):
                        U32.ShowWindowAsync(w["hwnd"], 6)       # SW_MINIMIZE
            elif any(k in step for k in ("restore", "minimize", "close")):
                verb = next(k for k in ("restore", "minimize", "close") if k in step)
                w = find_window(step[verb])
                if not w:
                    raise StepError(f"window not found: {step[verb]}")
                if verb == "close":
                    U32.PostMessageW(w["hwnd"], 0x0010, 0, 0)  # WM_CLOSE = the title-bar X
                else:
                    U32.ShowWindowAsync(w["hwnd"], 9 if verb == "restore" else 6)
            elif "sleep" in step:
                time.sleep(step["sleep"])
            else:
                raise StepError("unknown step")
        except StepError as ex:
            if step.get("optional"):
                continue
            print(json.dumps({"ok": False, "failed_step": i, "step": step, "error": str(ex),
                              "window": cur and cur["title"],
                              "windows": [w["title"] for w in windows()],
                              "elements": elements_of(ctrl_of(cur))[:80] if cur else [],
                              "results": results, "secs": round(time.perf_counter() - t0, 2)},
                             ensure_ascii=False, indent=1))
            return 1
        times.append(f"{i}:{kind}={time.perf_counter() - ts:.2f}")
    print(json.dumps({"ok": True, "results": results, "secs": round(time.perf_counter() - t0, 2),
                      "step_secs": " ".join(times)}, ensure_ascii=False, indent=1))
    return 0


def main(argv):
    if not argv or argv[0] not in ("windows", "view", "run"):
        print(__doc__)
        return 0
    if argv[0] == "windows":
        for w in windows():
            print(w["hwnd"], "min" if w["minimized"] else "   ", w["title"])
    elif argv[0] == "view":
        w = find_window(argv[1])
        if not w:
            print("window not found; open windows:", [x["title"] for x in windows()])
            return 1
        print("window:", w["title"])
        print("\n".join(elements_of(ctrl_of(w), interactive="--all" not in argv)))
    else:
        src = argv[1]
        path = src
        if not src.endswith(".json"):
            for d in ("chains", "examples"):
                path = os.path.join(HERE, d, src + ".json")
                if os.path.exists(path):
                    break
        chain = json.load(open(path, encoding="utf-8-sig"))
        vars_ = dict(argv[i + 1].split("=", 1) for i, a in enumerate(argv) if a == "--var")
        return run(chain["steps"] if isinstance(chain, dict) else chain, vars_)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
