// Thin client of the tg-mcp daemon (used by server.mjs, tg.mjs and login.mjs). Local HTTP on 127.0.0.1 with a key file.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT, loadConfig } from "./tg.mjs";

export const KEY_FILE = path.join(ROOT, "daemon.key");
export const DAEMON = path.join(ROOT, "daemon.mjs");
export const PORT = Number(process.env.TG_MCP_PORT) || Number(loadConfig().ownerPort) || 47613;

// The key only proves "same user on this PC": random, gitignored, created by whoever needs it first.
export function ensureKey() {
  try {
    const k = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(k)) return k;
  } catch {}
  const k = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
  return k;
}

function request(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: p, method,
        headers: { "x-tg-key": ensureKey(), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) },
      },
      (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          if (res.statusCode === 401) return reject(Object.assign(new Error("daemon refused the key: daemon.key changed after it started. End the node.exe daemon.mjs process (Task Manager), then retry"), { code: "EAUTH" }));
          try {
            resolve(JSON.parse(b));
          } catch {
            reject(Object.assign(new Error(`daemon answered ${res.statusCode}`), { code: "EBADANSWER" }));
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("daemon did not answer in time"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(data);
  });
}

export const health = (timeoutMs = 3000) => request("GET", "/health", undefined, timeoutMs);

// Starts daemon.mjs hidden and detached (no window, survives this process). A second start exits by itself (port busy).
export function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: ROOT,
    env: { ...process.env },
  });
  child.unref();
  return child.pid;
}

export async function ensureDaemon({ spawnIfMissing = true, waitMs = 10_000 } = {}) {
  try {
    return await health();
  } catch (e) {
    if (e.code !== "ECONNREFUSED" || !spawnIfMissing) throw e;
  }
  spawnDaemon();
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      return await health();
    } catch (e) {
      if (e.code !== "ECONNREFUSED") throw e;
    }
  }
  throw Object.assign(new Error(`tg daemon did not start on 127.0.0.1:${PORT} within ${waitMs / 1000} s (see logs/daemon.log)`), { code: "ENODAEMON" });
}

// Calls one tool. Returns the daemon's { ok, data | error, code, notes, ms, invokes }.
export async function call(tool, args = {}, { timeoutMs = 20 * 60_000, spawnIfMissing = true } = {}) {
  await ensureDaemon({ spawnIfMissing });
  return request("POST", "/call", { tool, args }, timeoutMs);
}

export const stop = () => request("POST", "/stop", {}, 10_000);
// A 12 h link to the clean-up page, where the user deletes chats themselves (dry: the page can never delete anything).
export const cleanupTicket = (dry = false) => request("POST", "/cleanup/ticket", { dry }, 10_000);
export const pauseDaemon = () => request("POST", "/pause", {}, 10_000);
export const resumeDaemon = () => request("POST", "/resume", {}, 10_000);
