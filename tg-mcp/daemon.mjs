// tg-mcp daemon: the one process on this PC that holds the user's Telegram connection (src/core.mjs).
// Clients (server.mjs for Claude/MCP, tg.mjs CLI for every other agent and script) talk to it on 127.0.0.1:PORT with the
// key in daemon.key. Start hidden at login (start-daemon.vbs); any client also starts it on demand. Logs: logs/daemon.log.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT } from "./src/tg.mjs";
import { ensureKey, PORT } from "./src/client.mjs";

// ---------- file log (never secrets: tool names, timings, errors, GramJS warnings) ----------
const LOGS = path.join(ROOT, "logs");
const LOG = path.join(LOGS, "daemon.log");
const LOG_MAX = 2 * 1024 * 1024;
fs.mkdirSync(LOGS, { recursive: true });
const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function writeLog(line) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, LOG + ".1"); // keep one old file
    fs.appendFileSync(LOG, `${stamp.format(new Date())} ${line}\n`);
  } catch {}
}
const fmtArgs = (a) => a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
console.log = console.info = console.debug = (...a) => writeLog("[stdout] " + fmtArgs(a)); // GramJS prints some errors with console.*
console.error = console.warn = (...a) => writeLog("[stderr] " + fmtArgs(a));
process.on("uncaughtException", (e) => writeLog("[uncaught] " + (e?.stack || e)));
process.on("unhandledRejection", (e) => writeLog("[unhandled] " + (e?.stack || e)));

const KEY = ensureKey();
const core = await import("./src/core.mjs");
core.setLogger(writeLog);

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
}

// ---------- clean-up page: the user deletes chats himself/herself. Agents never call /cleanup/delete. ----------
// `tg cleanup` asks for a ticket (needs the key) and opens /cleanup?t=<ticket> in his browser. Each page load gets its own
// CSRF token. Data, status, delete and stop answer only to the page: right Host, the ticket, the CSRF header, and for
// POSTs Origin = this server + Sec-Fetch-Site: same-origin (set by the browser). A dry ticket can never delete.
const crypto = await import("node:crypto");
const PAGE = path.join(ROOT, "src", "cleanup.html");
const ORIGIN = `http://127.0.0.1:${PORT}`;
const tickets = new Map(); // ticket -> { dry, exp, csrf: Set }
const rnd = () => crypto.randomBytes(24).toString("hex");

function pageGuard(req, url, post) {
  if (req.headers.host !== `127.0.0.1:${PORT}`) return "bad host";
  const t = tickets.get(url.searchParams.get("t") || "");
  if (!t || t.exp < Date.now()) return "the link expired: run tg cleanup again";
  if (url.pathname === "/cleanup") return { t };
  if (!t.csrf.has(req.headers["x-csrf"] || "")) return "bad csrf token: reload the page";
  if (post && (req.headers.origin !== ORIGIN || req.headers["sec-fetch-site"] !== "same-origin")) return "not from the page";
  return { t };
}

async function onCleanup(req, res, url) {
  const post = req.method === "POST";
  if (url.pathname === "/cleanup/ticket") { // the CLI (key holder) asks for a page link; this deletes nothing
    if (req.headers["x-tg-key"] !== KEY || !post) return send(res, 401, { ok: false, error: "bad key" });
    let body = "";
    for await (const d of req) body += d;
    const dry = !!JSON.parse(body || "{}").dry;
    const t = rnd();
    tickets.set(t, { dry, exp: Date.now() + 12 * 3600_000, csrf: new Set() });
    writeLog(`cleanup page link made${dry ? " (dry run)" : ""}`);
    return send(res, 200, { ok: true, url: `${ORIGIN}/cleanup?t=${t}`, dry });
  }
  const g = pageGuard(req, url, post);
  if (typeof g === "string") return send(res, 403, { ok: false, error: g });
  const { t } = g;
  try {
    if (url.pathname === "/cleanup" && !post) {
      const csrf = rnd();
      t.csrf.add(csrf);
      const html = fs.readFileSync(PAGE, "utf8").replace("__CSRF__", csrf).replace("__DRY__", t.dry ? "1" : "0");
      return res.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      }).end(html);
    }
    if (url.pathname === "/cleanup/data" && !post) return send(res, 200, { ok: true, dry: t.dry, ...(await core.cleanupData(url.searchParams.get("refresh") === "1")) });
    if (url.pathname === "/cleanup/status" && !post) return send(res, 200, { ok: true, ...core.cleanupStatus() });
    if (url.pathname === "/cleanup/delete" && post) {
      if (!/^application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, { ok: false, error: "json only" });
      let body = "";
      for await (const d of req) body += d;
      return send(res, 200, { ok: true, ...core.cleanupStart(JSON.parse(body || "{}").ids, t.dry) });
    }
    if (url.pathname === "/cleanup/stop" && post) return send(res, 200, { ok: true, ...core.cleanupStop() });
    send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    send(res, 200, { ok: false, error: String(e?.message || e) });
  }
}

let stopping = false;
async function onRequest(req, res) {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === "/cleanup" || url.pathname.startsWith("/cleanup/")) return onCleanup(req, res, url);
  if (req.headers["x-tg-key"] !== KEY) return send(res, 401, { ok: false, error: "bad key" });
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, role: "daemon", ...core.status() });
  if (req.method !== "POST") return send(res, 404, { ok: false, error: "not found" });
  let body = "";
  req.setEncoding("utf8");
  for await (const d of req) body += d;
  try {
    if (req.url === "/call") {
      const { tool, args } = JSON.parse(body || "{}");
      return send(res, 200, await core.runTool(tool, args || {}));
    }
    if (req.url === "/pause") {
      await core.pause();
      return send(res, 200, { ok: true, ...core.status() });
    }
    if (req.url === "/resume") {
      core.resume("resume requested");
      return send(res, 200, { ok: true, ...core.status() });
    }
    if (req.url === "/stop") {
      send(res, 200, { ok: true, stopping: true });
      return bye("stop requested");
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    send(res, 200, { ok: false, error: String(e?.message || e), code: "ERROR" });
  }
}

const srv = http.createServer(onRequest);
srv.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    writeLog(`another daemon owns 127.0.0.1:${PORT}; this copy (pid ${process.pid}) exits`);
    process.exit(0);
  }
  writeLog("listen error: " + e.message);
  process.exit(1);
});
srv.listen(PORT, "127.0.0.1", () => {
  writeLog(`daemon ${core.VERSION} up on 127.0.0.1:${PORT} (pid ${process.pid}, node ${process.version})`);
  core.init();
});

async function bye(why) {
  if (stopping) return;
  stopping = true;
  writeLog(`stopping (${why})`);
  srv.close();
  try {
    await Promise.race([core.shutdown(), new Promise((r) => setTimeout(r, 4000))]); // Telegram socket closed before the port is freed
  } catch {}
  writeLog("stopped");
  process.exit(0);
}
process.on("SIGTERM", () => bye("SIGTERM"));
process.on("SIGINT", () => bye("SIGINT"));
process.on("SIGHUP", () => bye("SIGHUP"));
