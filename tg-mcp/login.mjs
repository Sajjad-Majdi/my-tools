// One-time login for tg-mcp. The account owner runs this (login.cmd) and types only phone, code and 2FA.
// api_id/api_hash are read from config.json. Nothing typed here is printed back or logged. Writes session.txt.
import readline from "node:readline";
import { loadConfig, saveSession, makeClient } from "./src/tg.mjs";
import { pauseDaemon, resumeDaemon } from "./src/client.mjs";

const cfg = loadConfig();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (s) => {
  if (!muted || s.includes("\n")) rl.output.write(muted ? "\n" : s);
  else rl.output.write("*");
};
const ask = (q, hide = false) =>
  new Promise((res) => {
    rl.question(q, (a) => {
      muted = false;
      res(a.trim());
    });
    muted = hide;
  });

console.log("\n  Telegram login for Claude (tg-mcp)\n");

// api_id/api_hash come only from config.json (Telegram Desktop's public pair). Nothing to type here.
if (!cfg.apiId || !/^[0-9a-f]{32}$/i.test(String(cfg.apiHash || ""))) {
  console.log("  config.json has no valid apiId/apiHash. Ask Claude to fix config.json, then run login again.");
  rl.close();
  process.exit(1);
}

// The daemon must close its socket while we log in (two clients on one account from two IPs = AUTH_KEY_DUPLICATED).
// If no daemon runs, nothing happens here (it is never started from login).
const daemonPaused = await pauseDaemon().then(() => true, () => false);
if (daemonPaused) console.log("  tg daemon paused for the login.");

const client = makeClient(cfg, "");
try {
  console.log("\n  Connecting to Telegram ...");
  await client.start({
    phoneNumber: () => ask("  Phone number (e.g. +98912...): "),
    phoneCode: () => ask("  Code Telegram sent to your Telegram app: "),
    password: () => ask("  Two-step verification password (if set): ", true),
    onError: (e) => {
      const m = String(e.errorMessage || e.message);
      console.log("  Error: " + m);
      // Telegram asked us to wait: stop at once, never retry in a loop.
      if (e.seconds || /FLOOD|PHONE_NUMBER_BANNED|API_ID/.test(m)) {
        if (e.seconds) console.log(`  Telegram asks to wait ${e.seconds} s (~${Math.ceil(e.seconds / 60)} min). Try login again after that.`);
        return true;
      }
      return false;
    },
  });
  const me = await client.getMe();
  const fresh = client.session.save();
  // Close this socket BEFORE writing session.txt: the tg-mcp owner switches to a new session.txt on its next call, and two
  // sockets on one key at once (from different Cloudflare IPs) make Telegram revoke it (AUTH_KEY_DUPLICATED).
  await client.disconnect().catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  saveSession(fresh);
  console.log(`\n  Done. Logged in as ${[me.firstName, me.lastName].filter(Boolean).join(" ")}${me.username ? " (@" + me.username + ")" : ""}.`);
  console.log("  You can close this window. Claude picks up the new login by itself (no restart).\n");
} catch (e) {
  console.log("\n  Login failed: " + (e.errorMessage || e.message));
}
await client.disconnect().catch(() => {});
if (daemonPaused) await resumeDaemon().catch(() => {}); // daemon reconnects with the new session.txt
rl.close();
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
