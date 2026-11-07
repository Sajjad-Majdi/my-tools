// Offline check of the daemon design: NEVER touches Telegram (TG_MCP_OFFLINE=1, own port). Usage: node scripts/owner-check.mjs
// Checks: daemon auto-start (hidden), health, key auth, validation, offline error, deadline/timeout, second daemon exits,
// MCP server (server.mjs) forwards to the same daemon, CLI tg.mjs works, stop frees the port.
import { spawnSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 47699;
process.env.TG_MCP_OFFLINE = "1";
process.env.TG_MCP_PORT = String(PORT);
const { call, ensureDaemon, health, stop, ensureKey } = await import("../src/client.mjs");
let fails = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " - " + info : ""}`); if (!ok) fails++; };
const tg = (...a) => spawnSync(process.execPath, [path.join(ROOT, "tg.mjs"), ...a], { cwd: ROOT, encoding: "utf8", env: process.env, windowsHide: true });

try { await stop(); await new Promise((r) => setTimeout(r, 800)); } catch {}

// 1. auto-start + health
let t0 = Date.now();
const h = await ensureDaemon();
check("daemon auto-start + health", h.ok && h.role === "daemon" && h.offline === true, `${Date.now() - t0} ms, pid ${h.pid}`);

// 2. key auth
const bad = await new Promise((res) => {
  const req = http.request({ host: "127.0.0.1", port: PORT, path: "/health", headers: { "x-tg-key": "wrong" } }, (r) => res(r.statusCode));
  req.on("error", () => res("err")); req.end();
});
check("wrong key -> 401", bad === 401, String(bad));

// 3. validation + offline error
let r = await call("read_history", { limit: 5 });
check("validation error", !r.ok && r.code === "VALIDATION", r.error);
r = await call("read_history", { chat: "me", limit: 5 });
check("offline: no Telegram contact, clean error", !r.ok && r.code === "OFFLINE", r.error);
r = await call("nope", {});
check("unknown tool", !r.ok && r.code === "VALIDATION", r.error);

// 4. second daemon exits by itself
const second = spawn(process.execPath, [path.join(ROOT, "daemon.mjs")], { cwd: ROOT, env: process.env, stdio: "ignore", windowsHide: true });
const code = await new Promise((res) => { second.on("exit", res); setTimeout(() => res("timeout"), 8000); });
check("second daemon exits (port taken)", code === 0, `exit ${code}`);
const h2 = await health();
check("first daemon still the owner", h2.pid === h.pid);

// 5. MCP server forwards to the daemon
t0 = Date.now();
const c = new Client({ name: "check", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["server.mjs"], cwd: ROOT, env: process.env, stderr: "pipe" }));
const { tools } = await c.listTools();
check("MCP lists 15 tools", tools.length === 15, tools.map((t) => t.name).join(","));
const mr = await c.callTool({ name: "list_dialogs", arguments: { limit: 2 } });
check("MCP call reaches the daemon (offline error back)", mr.isError === true && /offline/.test(mr.content[0].text), `${Date.now() - t0} ms total`);
await c.close();

// 6. CLI
const s = tg("status", "--compact");
check("tg status", s.status === 0 && JSON.parse(s.stdout).pid === h.pid, s.stdout.trim().slice(0, 80));
const d = tg("dialogs", "--limit", "2", "--compact");
check("tg dialogs -> exit 1 with JSON error offline", d.status === 1 && JSON.parse(d.stdout).code === "OFFLINE");
const lg = tg("log", "--n", "5");
check("tg log tails daemon.log", lg.status === 0 && /daemon .* up on/.test(fs.readFileSync(path.join(ROOT, "logs", "daemon.log"), "utf8")));

// 7. stop frees the port
const st = tg("stop", "--compact");
await new Promise((r) => setTimeout(r, 1000));
let gone = false;
try { await health(1000); } catch (e) { gone = e.code === "ECONNREFUSED"; }
check("tg stop -> port free", st.status === 0 && gone);
check("key file exists and is gitignored", fs.existsSync(path.join(ROOT, "daemon.key")) && /daemon\.key/.test(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")));

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
