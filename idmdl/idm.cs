// idm: drive Internet Download Manager in milliseconds, without its user interface.
//   idm add <url> <folder> <name>                start one download now; its progress window is hidden at once
//   idm queue <folder> <url> [<url> ...] [--start]   add all links at once (IDM's clipboard-list dialog) into the agent queue (IDM_QUEUE)
//   idm start                                    start the agent queue
//   idm remove <row name>                        remove a row from IDM's list
//   idm stop <text>                              stop one download whose name/url contains <text>
//   idm stopq                                    stop the agent queue
//   idm stopall                                  stop every download
//   idm status [text] [--all]                    current state (default: running, queued and the last 5)
//   idm watch [text] [seconds]                   print status every N seconds (default 5) until nothing runs
//   idm hide                                     hide every IDM window that is on the desktop
// Every command ends with no IDM window on the desktop.
// Build: see README.md (csc.exe of .NET Framework 4 with the WPF UI Automation references).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;
using System.Windows.Automation;

class Idm
{
    // Settings: environment variable first, then the file idm.config beside idm.exe (lines "NAME=value", # for comments).
    //   IDM_EXE       path of IDMan.exe (default: HKCU\Software\DownloadManager\ExePath, else the default install path)
    //   IDM_QUEUE     name of the IDM queue the tool may use (default "Agent Queue"; create it once in IDM's Scheduler)
    //   IDM_QUEUE_ID  that queue's id: the queueID value IDM writes into each of its items in the registry (default 3)
    //   IDM_MOVE_CMD  WM_COMMAND id of the menu item "Move to queue > <your queue>" (default 10038)
    static string Cfg(string n)
    {
        var v = Environment.GetEnvironmentVariable(n);
        if (!string.IsNullOrEmpty(v)) return v;
        try
        {
            var f = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "idm.config");
            if (File.Exists(f))
                foreach (var line in File.ReadAllLines(f, Encoding.UTF8))
                {
                    var t = line.Trim(); if (t.Length == 0 || t[0] == '#' || t[0] == ';') continue;
                    var i = t.IndexOf('='); if (i <= 0 || t.Substring(0, i).Trim() != n) continue;
                    var x = t.Substring(i + 1).Trim(); if (x.Length > 0) return x;
                }
        }
        catch { }
        return null;
    }
    static string ResolveExe()
    {
        var e = Cfg("IDM_EXE"); if (e != null) return e;
        try { using (var k = Registry.CurrentUser.OpenSubKey(@"Software\DownloadManager")) { var p = k == null ? null : k.GetValue("ExePath") as string; if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p; } } catch { }
        return @"C:\Program Files (x86)\Internet Download Manager\IDMan.exe";
    }
    static readonly string Exe = ResolveExe();
    const int WM_COMMAND = 0x111, WM_CLOSE = 0x10, BM_CLICK = 0xF5;
    const int CMD_START_QUEUE = 10247, CMD_STOP_QUEUE = 10450, CMD_STOP_ALL = 32779;   // ids from IDM's main menu

    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);

    class Win { public IntPtr H; public string Title; public bool Visible; }

    static HashSet<uint> Pids()
    {
        var s = new HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("IDMan")) s.Add((uint)p.Id);
        return s;
    }

    static string Text(IntPtr h) { var b = new StringBuilder(512); GetWindowText(h, b, 512); return b.ToString(); }

    static List<Win> Windows()
    {
        var pids = Pids(); var r = new List<Win>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pids.Contains(pid))
            {
                var c = new StringBuilder(64); GetClassName(h, c, 64);
                var t = Text(h);
                if (c.ToString() == "#32770" && t.Length > 0) r.Add(new Win { H = h, Title = t, Visible = IsWindowVisible(h) });
            }
            return true;
        }, IntPtr.Zero);
        return r;
    }

    static IntPtr MainWin() { var w = Windows().FirstOrDefault(x => x.Title.StartsWith("Internet Download Manager")); return w == null ? IntPtr.Zero : w.H; }
    static bool IsProgress(Win w) { return !w.Title.StartsWith("Internet Download Manager") && FindButton(w.H, "ايست", "ادامه") != IntPtr.Zero; }

    static IntPtr FindButton(IntPtr parent, params string[] names)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(parent, delegate (IntPtr h, IntPtr l)
        {
            var c = new StringBuilder(64); GetClassName(h, c, 64);
            if (c.ToString() == "Button" && names.Contains(Text(h).Trim())) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Rule: no IDM window may stay on the desktop. SW_HIDE = IDM's "hide beside the clock".
    static int HideAll(HashSet<IntPtr> keep)
    {
        int n = 0;
        foreach (var w in Windows()) if (w.Visible && (keep == null || !keep.Contains(w.H))) { ShowWindow(w.H, 0); n++; }
        return n;
    }

    static void Launch(string args)
    {
        var psi = new ProcessStartInfo(Exe, args); psi.UseShellExecute = false;
        Process.Start(psi).WaitForExit(5000);
    }


    // ---------- agent queue: several files go ONLY to the queue named IDM_QUEUE ----------
    static readonly int CMD_MOVE_TO_QUEUE = int.Parse(Cfg("IDM_MOVE_CMD") ?? "10038");   // list context menu «به صف منتقل شود» > the agent queue
    const int CMD_REMOVE = 32775, CMD_SCHEDULER = 32801;
    static readonly string QUEUE = Cfg("IDM_QUEUE") ?? "Agent Queue";
    static readonly int QUEUE_ID = int.Parse(Cfg("IDM_QUEUE_ID") ?? "3");
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint k, byte a, uint f);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string t);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr d, int id);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr SendMessageSB(IntPtr h, int m, IntPtr w, StringBuilder l);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, UIntPtr n, uint t, uint pr);
    [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr a, byte[] b, UIntPtr n, out UIntPtr w);
    [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr a, UIntPtr n, uint t);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    // Run `act` while the main window is shown but fully transparent (UI Automation needs a shown window;
    // the user must never see an IDM window). The window is hidden again afterwards.
    static void WithInvisibleMain(Action<IntPtr> act)
    {
        var h = MainWin(); if (h == IntPtr.Zero) { Launch(""); Thread.Sleep(800); h = MainWin(); }
        int ex = GetWindowLong(h, -20);
        try
        {
            SetWindowLong(h, -20, ex | 0x80000); SetLayeredWindowAttributes(h, 0, 1, 2);
            SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x15); ShowWindow(h, 4); Thread.Sleep(450);
            act(h);
        }
        finally { ShowWindow(h, 0); SetLayeredWindowAttributes(h, 0, 255, 2); SetWindowLong(h, -20, ex); }
    }

    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, UIntPtr n, out UIntPtr r);

    // Row names straight from the list view (LVM_GETITEMTEXT in IDM's 32-bit memory); works while hidden.
    static List<string> ListRows(IntPtr h)
    {
        var r = new List<string>();
        var lv = FindWindowEx(h, IntPtr.Zero, "SysListView32", null);
        int count = (int)SendMessage(lv, 0x1004, IntPtr.Zero, IntPtr.Zero);
        uint pid; GetWindowThreadProcessId(lv, out pid);
        var pr = OpenProcess(0x1F0FFF, false, pid); var mem = VirtualAllocEx(pr, IntPtr.Zero, (UIntPtr)1200, 0x3000, 4);
        for (int i = 0; i < count; i++)
        {
            var it = new byte[60]; BitConverter.GetBytes(1).CopyTo(it, 0); BitConverter.GetBytes((int)mem + 64).CopyTo(it, 20); BitConverter.GetBytes(512).CopyTo(it, 24);
            UIntPtr n; WriteProcessMemory(pr, mem, it, (UIntPtr)60, out n);
            SendMessage(lv, 0x1073, (IntPtr)i, mem);
            var buf = new byte[1024]; ReadProcessMemory(pr, (IntPtr)((long)mem + 64), buf, (UIntPtr)1024, out n);
            var t = Encoding.Unicode.GetString(buf); int z = t.IndexOf('\0'); r.Add(z >= 0 ? t.Substring(0, z) : t);
        }
        VirtualFreeEx(pr, mem, UIntPtr.Zero, 0x8000); CloseHandle(pr);
        return r;
    }

    // UIA Select fails on IDM's list, so select through LVM_SETITEMSTATE in IDM's own (32-bit) memory.
    static void SelectRow(IntPtr h, int idx)
    {
        var lv = FindWindowEx(h, IntPtr.Zero, "SysListView32", null);
        uint pid; GetWindowThreadProcessId(lv, out pid);
        var pr = OpenProcess(0x1F0FFF, false, pid); var mem = VirtualAllocEx(pr, IntPtr.Zero, (UIntPtr)64, 0x3000, 4);
        foreach (var p in new[] { new[] { -1, 0 }, new[] { idx, 3 } })
        {
            var b = new byte[60]; BitConverter.GetBytes(8).CopyTo(b, 0); BitConverter.GetBytes(p[1]).CopyTo(b, 12); BitConverter.GetBytes(3).CopyTo(b, 16);
            UIntPtr w; WriteProcessMemory(pr, mem, b, (UIntPtr)60, out w);
            SendMessage(lv, 0x102B, (IntPtr)p[0], mem);
        }
        VirtualFreeEx(pr, mem, UIntPtr.Zero, 0x8000); CloseHandle(pr);
    }

    static bool RowCommand(string rowName, int cmd)
    {
        bool ok = false;
        WithInvisibleMain(h =>
        {
            var rows = ListRows(h); int i = rows.FindIndex(x => x == rowName);
            if (i < 0) i = rows.FindIndex(x => x.IndexOf(rowName, StringComparison.OrdinalIgnoreCase) >= 0);
            if (i < 0) { Console.WriteLine("rows seen: " + rows.Count + " " + string.Join(" | ", rows.Take(12))); return; }
            SelectRow(h, i); Thread.Sleep(150); SendMessage(h, WM_COMMAND, (IntPtr)cmd, IntPtr.Zero); Thread.Sleep(400); ok = true;
        });
        return ok;
    }

    // Scheduler dialog, kept off-screen: select the agent queue, press a button (1232 start, 1233 stop), close (1079).
    static bool AgentQueue(string buttonId)
    {
        var m = MainWin(); if (m == IntPtr.Zero) { Launch(""); Thread.Sleep(800); m = MainWin(); }
        Win sch = Windows().FirstOrDefault(w => w.Title.Contains("زمان بند"));
        if (sch == null) { PostMessage(m, WM_COMMAND, (IntPtr)CMD_SCHEDULER, IntPtr.Zero); for (int i = 0; i < 40 && sch == null; i++) { Thread.Sleep(50); sch = Windows().FirstOrDefault(w => w.Title.Contains("زمان بند")); } }
        if (sch == null) return false;
        SetWindowPos(sch.H, IntPtr.Zero, -32000, -32000, 0, 0, 0x15); ShowWindow(sch.H, 4); Thread.Sleep(350);
        var root = AutomationElement.FromHandle(sch.H);
        var q = root.FindFirst(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TreeItem), new PropertyCondition(AutomationElement.NameProperty, QUEUE)));
        if (q == null) { Console.WriteLine("queue «" + QUEUE + "» not found in IDM"); return false; }
        ((SelectionItemPattern)q.GetCurrentPattern(SelectionItemPattern.Pattern)).Select(); Thread.Sleep(300);
        foreach (var id in new[] { buttonId, "1079" })
        {
            var b = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, id));
            if (b != null) PostMessage((IntPtr)b.Current.NativeWindowHandle, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
            Thread.Sleep(350);
        }
        return true;
    }


    // ---------- bulk add: IDM's own «add list of links from the clipboard» dialog (menu 34036), driven off-screen ----------
    const int CMD_ADD_FROM_CLIPBOARD = 34036;
    static readonly bool DBG = Environment.GetEnvironmentVariable("IDM_DEBUG") == "1";
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
    static void SetClipboard(string text)
    {
        var t = new Thread(() => System.Windows.Forms.Clipboard.SetText(text)); t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
    }
    static Win WaitWin(string part, int ms)
    {
        for (int i = 0; i < ms / 50; i++) { var w = Windows().FirstOrDefault(x => x.Title.Contains(part)); if (w != null) return w; Thread.Sleep(50); }
        return null;
    }
    static IntPtr Btn(AutomationElement root, string automationId)
    {
        var b = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
        return b == null ? IntPtr.Zero : (IntPtr)b.Current.NativeWindowHandle;
    }
    // Adds every url to IDM's list (main queue) in one dialog round trip. Returns the new registry ids.
    static List<int> BulkAdd(string folder, IEnumerable<string> urls)
    {
        var m = MainWin(); if (m == IntPtr.Zero) { Launch(""); Thread.Sleep(800); m = MainWin(); }
        Directory.CreateDirectory(folder);
        var idsBefore = new HashSet<int>(Items().Select(i => i.Id));
        // 2026-11-04: a dialog left over from a failed run stays hidden and was picked again by every later run
        // (0 rows added, forever). Close every old one first, and only drive a dialog that is NEW.
        foreach (var old in Windows().Where(x => x.Title.Contains("حافظه ويندوز"))) PostMessage(old.H, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(300);
        var oldH = new HashSet<IntPtr>(Windows().Select(x => x.H));
        SetClipboard(string.Join("\r\n", urls));
        PostMessage(m, WM_COMMAND, (IntPtr)CMD_ADD_FROM_CLIPBOARD, IntPtr.Zero);
        Win d = null;
        for (int i = 0; i < 160 && d == null; i++) { d = Windows().FirstOrDefault(x => x.Title.Contains("حافظه ويندوز") && !oldH.Contains(x.H)); if (d == null) Thread.Sleep(50); }
        if (d == null) { Console.WriteLine("clipboard dialog did not open"); return new List<int>(); }
        SetWindowPos(d.H, IntPtr.Zero, -32000, -32000, 0, 0, 0x15);
        var root = AutomationElement.FromHandle(d.H);
        // 2026-11-04 fix: wait until IDM has listed every link and finished checking file types; clicking OK earlier
        // raises «در حال اضافه کردن...» and nothing is added. Then pick «all files in one folder» (the default radio
        // sorts files into category folders) and set that folder.
        var lvEl = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, "SysListView32"));
        var lv = lvEl == null ? IntPtr.Zero : (IntPtr)lvEl.Current.NativeWindowHandle;
        for (int i = 0; i < 300 && lv != IntPtr.Zero && (int)SendMessage(lv, 0x1004, IntPtr.Zero, IntPtr.Zero) < urls.Count(); i++) Thread.Sleep(50);
        Thread.Sleep(2000);
        // radio 1359 = «همه فايلها در يک مسير» (1357 = by file type, the default; 1358 = one group). Its path box is a
        // direct child Edit of the dialog, enabled only after the radio is on. Found with Win32 ids (UIA gives no names here).
        SendMessage(GetDlgItem(d.H, 1359), BM_CLICK, IntPtr.Zero, IntPtr.Zero); Thread.Sleep(250);
        bool set = false;
        for (IntPtr e = FindWindowEx(d.H, IntPtr.Zero, "Edit", null); e != IntPtr.Zero; e = FindWindowEx(d.H, e, "Edit", null))
        {
            var sb = new StringBuilder(1024); SendMessageSB(e, 0x000D, (IntPtr)1024, sb);
            if (DBG) Console.WriteLine("edit [" + sb + "] enabled=" + IsWindowEnabled(e));
            if (sb.ToString().Contains("\\") && IsWindowEnabled(e))
            {
                SendMessage(e, 0x000C, IntPtr.Zero, folder.TrimEnd((char)92) + "\\");
                var chk = new StringBuilder(1024); SendMessageSB(e, 0x000D, (IntPtr)1024, chk); set = chk.ToString().StartsWith(folder.TrimEnd((char)92)); break;
            }
        }
        if (!set) { Console.WriteLine("could not set the save folder; cancelled, nothing added"); PostMessage(d.H, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); return new List<int>(); }
        SendMessage(Btn(root, "1353"), BM_CLICK, IntPtr.Zero, IntPtr.Zero); Thread.Sleep(300);         // «علامت گذاري همه»
        PostMessage(Btn(root, "1"), BM_CLICK, IntPtr.Zero, IntPtr.Zero);                                // «تأييد»
        for (int i = 0; i < 300 && Windows().Any(w => w.H == d.H); i++)
        {
            Thread.Sleep(100);
            if (i == 299) { Console.WriteLine("dialog still open after 30 s; closed it"); PostMessage(d.H, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
        }
        var before = idsBefore;
        for (int i = 0; i < 50; i++) { if (Items().Any(x => !before.Contains(x.Id))) break; Thread.Sleep(100); }   // registry lags a little
        Thread.Sleep(300);
        return Items().Select(i => i.Id).Where(i => !idsBefore.Contains(i)).ToList();
    }
    // Select the last n rows of the list (IDM appends new rows at the end), then one WM_COMMAND.
    static bool LastRowsCommand(int n, int cmd)
    {
        bool ok = false;
        WithInvisibleMain(h =>
        {
            var rows = ListRows(h); if (rows.Count < n) { Console.WriteLine("list has only " + rows.Count + " rows"); return; }
            SelectRows(h, Enumerable.Range(rows.Count - n, n).ToList()); Thread.Sleep(150);
            SendMessage(h, WM_COMMAND, (IntPtr)cmd, IntPtr.Zero); Thread.Sleep(400); ok = true;
        });
        return ok;
    }
    static void SelectRows(IntPtr h, List<int> idxs)
    {
        var lv = FindWindowEx(h, IntPtr.Zero, "SysListView32", null);
        uint pid; GetWindowThreadProcessId(lv, out pid);
        var pr = OpenProcess(0x1F0FFF, false, pid); var mem = VirtualAllocEx(pr, IntPtr.Zero, (UIntPtr)64, 0x3000, 4);
        var all = new List<int[]> { new[] { -1, 0 } }; all.AddRange(idxs.Select(i => new[] { i, 3 }));
        foreach (var p in all)
        {
            var b = new byte[60]; BitConverter.GetBytes(8).CopyTo(b, 0); BitConverter.GetBytes(p[1]).CopyTo(b, 12); BitConverter.GetBytes(3).CopyTo(b, 16);
            UIntPtr w; WriteProcessMemory(pr, mem, b, (UIntPtr)60, out w); SendMessage(lv, 0x102B, (IntPtr)p[0], mem);
        }
        VirtualFreeEx(pr, mem, UIntPtr.Zero, 0x8000); CloseHandle(pr);
    }

    static int NewestId() { var r = Registry.CurrentUser.OpenSubKey(@"Software\DownloadManager"); int m = 0; foreach (var n in r.GetSubKeyNames()) { int i; if (int.TryParse(n, out i) && i > m) m = i; } return m; }

    static string Q(string s) { return "\"" + s + "\""; }

    static readonly string MapFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "names.tsv");
    static void Remember(string url, string name) { try { File.AppendAllText(MapFile, url + "\t" + name + "\n", Encoding.UTF8); } catch { } }
    static List<string> NamesFor(string t)
    {
        var r = new List<string> { t };
        if (File.Exists(MapFile))
            foreach (var line in File.ReadAllLines(MapFile, Encoding.UTF8))
            {
                var p = line.Split('\t'); if (p.Length < 2) continue;
                if (p[0].IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0 || p[1].IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0)
                    r.Add(Path.GetFileNameWithoutExtension(p[1]));
            }
        return r;
    }

    // ---------- status from IDM's registry + its live per-item log ----------
    class Item { public int Id; public string Name, Url, State, Msg, Dir; public double Bytes, Size, Speed; public int Queue; }

    static ulong U64(object v)
    {
        var b = v as byte[]; if (b != null && b.Length >= 8) return BitConverter.ToUInt64(b, 0);
        if (v is int) return (ulong)(int)v;
        return 0;
    }

    static string Fix(string s)   // IDM stores Persian as Windows-1256 bytes read as Windows-1252
    {
        if (string.IsNullOrEmpty(s)) return "";
        try { return Encoding.GetEncoding(1256).GetString(Encoding.GetEncoding(1252).GetBytes(s)); } catch { return s; }
    }

    static List<Item> Items()
    {
        var r = new List<Item>();
        var root = Registry.CurrentUser.OpenSubKey(@"Software\DownloadManager");
        var queued = new HashSet<int>();
        var qk = root.OpenSubKey("Queue");
        if (qk != null) foreach (var t in (Convert.ToString(qk.GetValue("Queue")) ?? "").Split(' ')) { int q; if (int.TryParse(t, out q)) queued.Add(q); }
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        foreach (var name in root.GetSubKeyNames())
        {
            int id; if (!int.TryParse(name, out id)) continue;
            var k = root.OpenSubKey(name); var url = k.GetValue("Url0") as string; if (url == null) continue;
            var it = new Item { Id = id, Url = url };
            var lf = k.GetValue("LocalFileName") as string; var fn = k.GetValue("FileName") as string;
            it.Name = (lf != null && !lf.Contains(@"\DwnlData\")) ? Path.GetFileName(lf) : (fn ?? "").Split('?')[0];
            it.Size = U64(k.GetValue("FileSize")); it.Bytes = U64(k.GetValue("Downloaded"));
            int st = Convert.ToInt32(k.GetValue("Status") ?? -1);
            it.Msg = Fix(k.GetValue("lastResult") as string);
            it.Queue = queued.Contains(id) ? 1 : (Convert.ToInt32(k.GetValue("queueID") ?? 0) == QUEUE_ID ? 3 : 0);   // marker 3 = the agent queue
            bool live = false;
            var tmp = k.GetValue("LocalPath") as string;
            if (tmp != null && tmp.Contains(@"\IDM\DwnlData\") && Directory.Exists(tmp))
            {
                var log = Directory.GetFiles(tmp, "*.log").FirstOrDefault();
                if (log != null)
                {
                    string last = null; bool ended = false, fresh = false;
                    try
                    {
                        using (var fs = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                        {
                            long start = Math.Max(0, fs.Length - 4096); fs.Seek(start, SeekOrigin.Begin);
                            var txt = new StreamReader(fs, Encoding.Default).ReadToEnd();
                            var ms = Regex.Matches(txt, @"time (\d+), speed (\d+), downl (\d+) Bytes");
                            if (ms.Count > 0)
                            {
                                last = ms[ms.Count - 1].Value;
                                // anything written after the last progress line (e.g. "Cancel by user") means it ended
                                var after = txt.Substring(ms[ms.Count - 1].Index + ms[ms.Count - 1].Length);
                                if (after.Contains("Cancel by user") || after.Contains("Download complete")) ended = true;
                            }
                            else if ((DateTime.Now - File.GetLastWriteTime(log)).TotalSeconds < 5 && !txt.Contains("Cancel")) fresh = true;
                        }
                    }
                    catch { }
                    if (last != null)
                    {
                        var m = Regex.Match(last, @"time (\d+), speed (\d+), downl (\d+)");
                        it.Bytes = Math.Max(it.Bytes, double.Parse(m.Groups[3].Value));
                        if (!ended && now - long.Parse(m.Groups[1].Value) <= 6) { live = true; it.Speed = double.Parse(m.Groups[2].Value); }
                    }
                    if (fresh) live = true;
                }
            }
            bool full = it.Size > 0 && it.Bytes >= it.Size;
            it.State = live ? "running" : (full || st == 3) ? "done" : it.Bytes > 0 ? "stopped" : (it.Queue > 0 ? "queued" : "new");
            r.Add(it);
        }
        return r.OrderBy(x => x.Id).ToList();
    }

    static bool Hit(Item i, string t) { return string.IsNullOrEmpty(t) || i.Name.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0 || i.Url.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0; }

    static void PrintStatus(string text, bool all)
    {
        var items = Items();
        var show = items.Where(i => Hit(i, text)).ToList();
        if (!all && string.IsNullOrEmpty(text))
        {
            var tail = items.Skip(Math.Max(0, items.Count - 5));
            show = items.Where(i => i.State == "running" || i.State == "queued").Union(tail).OrderBy(i => i.Id).ToList();
        }
        foreach (var i in show)
        {
            string pct = i.Size > 0 ? (100 * i.Bytes / i.Size).ToString("0.0") + "%" : "?";
            string eta = (i.State == "running" && i.Speed > 0 && i.Size > 0) ? TimeSpan.FromSeconds((int)((i.Size - i.Bytes) / i.Speed)).ToString() : "";
            Console.WriteLine(string.Format("{0,4} {1,-8} {2,6} {3,8:0.0}/{4,-8:0.0}MB {5,6} {6,8} {7}{8}",
                i.Id, i.State, pct, i.Bytes / 1048576, i.Size / 1048576,
                i.State == "running" ? (i.Speed / 1048576).ToString("0.00") + "MB/s" : "", eta, i.Name,
                i.State == "running" || i.State == "done" ? "" : (i.Msg.Length > 0 ? "  (" + i.Msg + ")" : "")));
        }
    }

    // ---------- commands ----------
    static int Main(string[] a)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (a.Length == 0) { Console.WriteLine("usage: idm add|queue|start|stop|stopq|stopall|status|watch|hide ... (see idm.cs)"); return 2; }
        var sw = Stopwatch.StartNew();
        var keep = new HashSet<IntPtr>();
        int rc = 0;
        switch (a[0])
        {
            case "add":
            {
                if (a.Length < 4) { Console.WriteLine("idm add <url> <folder> <name>"); return 2; }
                var before = new HashSet<IntPtr>(Windows().Select(w => w.H));
                Directory.CreateDirectory(a[2]);
                var psi = new ProcessStartInfo(Exe, "/d " + Q(a[1]) + " /p " + Q(a[2]) + " /f " + Q(a[3]) + " /n"); psi.UseShellExecute = false;
                Process.Start(psi); Remember(a[1], a[3]);
                bool hidden = false;
                while (sw.Elapsed.TotalSeconds < 20 && !hidden)
                {
                    foreach (var w in Windows()) if (w.Visible && !before.Contains(w.H) && !w.Title.StartsWith("Internet Download Manager")) { ShowWindow(w.H, 0); hidden = true; }
                    if (!hidden) Thread.Sleep(20);
                }
                Console.WriteLine(hidden ? "started, progress window hidden" : "started, no progress window seen (check: idm status)");
                break;
            }
            case "queue":
            {
                // idm queue <folder> <url> [<url> ...] [--start]
                var urls = a.Skip(2).Where(x => x != "--start").ToList();
                if (a.Length < 3 || urls.Count == 0) { Console.WriteLine("idm queue <folder> <url> [<url> ...] [--start]"); return 2; }
                var ids = BulkAdd(a[1], urls);
                bool moved = ids.Count > 0 && LastRowsCommand(ids.Count, CMD_MOVE_TO_QUEUE);
                var inQueue = Items().Where(i => ids.Contains(i.Id)).Count(i => i.Queue == 3);
                Console.WriteLine("added " + ids.Count + " of " + urls.Count + ", " + inQueue + " in " + QUEUE + ": " + string.Join(", ", Items().Where(i => ids.Contains(i.Id)).Select(i => i.Name)));
                if (inQueue < ids.Count) { Console.WriteLine("NOT all rows moved to the queue; nothing started"); break; }
                if (a.Contains("--start") && moved) goto case "start";
                break;
            }
            case "start":
                Console.WriteLine(AgentQueue("1232") ? QUEUE + " started" : "start failed"); break;
            case "stopq":
                Console.WriteLine(AgentQueue("1233") ? QUEUE + " stopped" : "stop failed"); break;
            case "remove":
                if (a.Length < 2) { Console.WriteLine("idm remove <row name>"); return 2; }
                Console.WriteLine(RowCommand(a[1], CMD_REMOVE) ? "removed " + a[1] : "row not found: " + a[1]); break;
            case "stopall":
            {
                var m = MainWin(); if (m == IntPtr.Zero) { Console.WriteLine("IDM is not running"); return 1; }
                PostMessage(m, WM_COMMAND, (IntPtr)CMD_STOP_ALL, IntPtr.Zero); Console.WriteLine("all stopped");
                break;
            }
            case "stop":
            {
                if (a.Length < 2) { Console.WriteLine("idm stop <text>"); return 2; }
                string t = a[1];
                var hits = Items().Where(i => Hit(i, t)).ToList();
                var item = hits.LastOrDefault(i => i.State == "running") ?? hits.LastOrDefault();
                // 1) its own progress window (hidden or not) that still has a Stop button: press it, then close it
                var names = NamesFor(t);
                var pw = Windows().FirstOrDefault(w => FindButton(w.H, "ايست") != IntPtr.Zero
                         && names.Any(nm => w.Title.IndexOf(nm, StringComparison.OrdinalIgnoreCase) >= 0));
                if (pw != null)
                {
                    var b = FindButton(pw.H, "ايست");
                    if (b != IntPtr.Zero) PostMessage(b, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                    Thread.Sleep(300);
                    PostMessage(pw.H, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                    Console.WriteLine("stopped: " + pw.Title);
                }
                else if (item != null && item.State == "running")
                {   // 2) a queue item has no progress window; the agent queue runs one file at a time, so stop the queue
                    AgentQueue("1233");
                    Console.WriteLine("stopped " + QUEUE + " (it was downloading " + item.Name + ")");
                }
                else { Console.WriteLine("no running download matches: " + t); rc = 1; }
                break;
            }
            case "status":
                PrintStatus(a.Length > 1 && a[1] != "--all" ? a[1] : "", a.Contains("--all"));
                break;
            case "watch":
            {
                string t = a.Length > 1 ? a[1] : ""; int every = a.Length > 2 ? int.Parse(a[2]) : 5;
                while (true)
                {
                    Console.WriteLine("-- " + DateTime.Now.ToString("HH:mm:ss"));
                    PrintStatus(t, false);
                    if (!Items().Any(i => i.State == "running" && Hit(i, t))) break;
                    Thread.Sleep(every * 1000);
                }
                break;
            }
            case "hide":
                break;
            default:
                Console.WriteLine("unknown command " + a[0]); return 2;
        }
        Thread.Sleep(a[0] == "status" || a[0] == "watch" ? 0 : 150);
        int h = HideAll(null);
        if (h > 0) Console.WriteLine("hid " + h + " IDM window(s)");
        Console.WriteLine("(" + sw.ElapsedMilliseconds + " ms)");
        return rc;
    }
}
