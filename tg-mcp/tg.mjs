#!/usr/bin/env node
// tg: command-line client of the tg-mcp daemon for every agent and script on this PC. JSON output, exit code 1 on error.
//   tg status                      daemon + connection state (starts the daemon if needed)
//   tg dialogs [query] [--limit 30] [--unread] [--type user|bot|group|channel] [--all] [--refresh]
//   tg history <chat> [--limit 30] [--offset-id N] [--min-id N] [--since 2026-10-01] [--oldest-first]
//   tg search <query> [--chat c] [--limit 20] [--since d]
//   tg unread [--max-chats 20] [--per-chat 10] [--muted]
//   tg download <chat> <message_id> [--dir folder]
//   tg read <chat> [--max-id N]           mark as read
//   tg send <chat> <text...> [--reply-to N]   (never to real people without the user's OK; same for the next four)
//   tg send-file <chat> <path> [--caption "..."] [--as auto|photo|document|video|audio|voice] [--reply-to N]
//   tg forward <from_chat> <id[,id...]> <to_chat> [--copy]   --copy = without "Forwarded from"
//   tg edit <chat> <message_id> <text...>     edit one of the user's own messages
//   tg press <chat> <message_id> <button...>  press a bot button (text, part of it, "row,col" or index)
//   tg buttons <chat> <message_id>            list the buttons of a message
//   tg archive <chat> | tg unarchive <chat>   (archive, never delete)
//   tg folders | tg folder <name> <chat,chat,...> | tg folder-remove <name>   chat folders (100 chats each; more = "<name> ۱", "۲" ...)
//   tg cleanup [--dry] [--no-open]           opens the clean-up page where the USER deletes chats themselves (agents never press it)
//   tg call <tool> '<json args>'         raw tool call
//   tg log [--n 40]                      tail the daemon log
//   tg start | tg stop | tg restart | tg pause | tg resume
//   --compact  one-line JSON    --ascii (or env TG_ASCII=1)  non-ASCII as \uXXXX: Persian survives any console code page
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "./src/tg.mjs";
import { call, ensureDaemon, health, stop, pauseDaemon, resumeDaemon, cleanupTicket, PORT } from "./src/client.mjs";
import { spawn } from "node:child_process";

const { values: o, positionals: p } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    limit: { type: "string" }, "offset-id": { type: "string" }, "min-id": { type: "string" }, since: { type: "string" },
    "oldest-first": { type: "boolean" }, unread: { type: "boolean" }, type: { type: "string" }, refresh: { type: "boolean" }, all: { type: "boolean" },
    chat: { type: "string" }, "max-chats": { type: "string" }, "per-chat": { type: "string" }, muted: { type: "boolean" },
    dir: { type: "string" }, "max-id": { type: "string" }, "reply-to": { type: "string" }, n: { type: "string" },
    caption: { type: "string" }, as: { type: "string" }, copy: { type: "boolean" }, dry: { type: "boolean" }, "no-open": { type: "boolean" },
    compact: { type: "boolean" }, ascii: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
const num = (v) => (v === undefined ? undefined : Number(v));
// Windows PowerShell 5.1 decodes a child's stdout with the console code page (often 437/720), which turns UTF-8
// Persian into garbage; \uXXXX escapes are plain ASCII and ConvertFrom-Json restores the text exactly.
const ascii = o.ascii || process.env.TG_ASCII === "1";
const esc = (s) => (ascii ? s.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : s);
const out = (x) => process.stdout.write(esc(o.compact ? JSON.stringify(x) : JSON.stringify(x, null, 2)) + "\n");
const die = (msg, code = 1) => { out({ ok: false, error: msg }); process.exit(code); };
const [cmd, ...rest] = p;

if (!cmd || o.help) {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  const head = src.slice(0, src.findIndex((l) => !l.startsWith("//"))); // the comment block at the top is the help
  process.stdout.write(head.map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
  process.exit(cmd ? 0 : 1);
}

async function tool(name, args) {
  const r = await call(name, args);
  if (!r.ok) {
    out({ ok: false, error: r.error, code: r.code, notes: r.notes });
    process.exit(1);
  }
  out(o.compact ? r.data : { ...(r.notes ? { notes: r.notes } : {}), ms: r.ms, api_calls: r.invokes, data: r.data });
}

try {
  switch (cmd) {
    case "status": out(await ensureDaemon()); break;
    case "start": out(await ensureDaemon()); break;
    case "stop": {
      try { out(await stop()); } catch (e) { if (e.code === "ECONNREFUSED") out({ ok: true, running: false }); else throw e; }
      break;
    }
    case "restart": {
      try { await stop(); } catch {}
      for (let i = 0; i < 25; i++) { // wait until the port is free
        try { await health(500); await new Promise((r) => setTimeout(r, 200)); } catch { break; }
      }
      out(await ensureDaemon());
      break;
    }
    case "pause": out(await pauseDaemon()); break;
    case "resume": out(await resumeDaemon()); break;
    case "dialogs": await tool("list_dialogs", { query: rest[0], limit: num(o.limit), unread_only: o.unread, type: o.type, all: o.all, refresh: o.refresh }); break;
    case "history": {
      if (!rest[0]) die("usage: tg history <chat> [--limit N] [--offset-id N] [--min-id N] [--since d] [--oldest-first]");
      await tool("read_history", { chat: rest[0], limit: num(o.limit), offset_id: num(o["offset-id"]), min_id: num(o["min-id"]), since: o.since, oldest_first: o["oldest-first"] });
      break;
    }
    case "search": {
      if (!rest[0]) die("usage: tg search <query> [--chat c] [--limit N] [--since d]");
      await tool("search_messages", { query: rest.join(" "), chat: o.chat, limit: num(o.limit), since: o.since });
      break;
    }
    case "unread": await tool("get_unread", { max_chats: num(o["max-chats"]), per_chat: num(o["per-chat"]), include_muted: o.muted }); break;
    case "download": {
      if (!rest[0] || !rest[1]) die("usage: tg download <chat> <message_id> [--dir folder]");
      await tool("download_media", { chat: rest[0], message_id: Number(rest[1]), dir: o.dir });
      break;
    }
    case "read": {
      if (!rest[0]) die("usage: tg read <chat> [--max-id N]");
      await tool("mark_read", { chat: rest[0], max_id: num(o["max-id"]) });
      break;
    }
    case "send": {
      if (!rest[0] || !rest[1]) die("usage: tg send <chat> <text...> [--reply-to N]");
      await tool("send_message", { chat: rest[0], text: rest.slice(1).join(" "), reply_to: num(o["reply-to"]) });
      break;
    }
    case "send-file": {
      if (!rest[0] || !rest[1]) die('usage: tg send-file <chat> <path> [--caption "..."] [--as auto|photo|document|video|audio|voice] [--reply-to N]');
      await tool("send_file", { chat: rest[0], path: path.resolve(rest[1]), caption: o.caption, as: o.as, reply_to: num(o["reply-to"]) });
      break;
    }
    case "forward": {
      if (!rest[0] || !rest[1] || !rest[2]) die("usage: tg forward <from_chat> <id[,id...]> <to_chat> [--copy]");
      await tool("forward_messages", { from_chat: rest[0], message_ids: rest[1].split(",").map(Number), to_chat: rest[2], copy: o.copy });
      break;
    }
    case "edit": {
      if (!rest[0] || !rest[1] || !rest[2]) die("usage: tg edit <chat> <message_id> <text...>");
      await tool("edit_message", { chat: rest[0], message_id: Number(rest[1]), text: rest.slice(2).join(" ") });
      break;
    }
    case "press": {
      if (!rest[0] || !rest[1] || !rest[2]) die("usage: tg press <chat> <message_id> <button text | row,col | index>");
      await tool("press_button", { chat: rest[0], message_id: Number(rest[1]), button: rest.slice(2).join(" ") });
      break;
    }
    case "buttons": {
      if (!rest[0] || !rest[1]) die("usage: tg buttons <chat> <message_id>");
      await tool("press_button", { chat: rest[0], message_id: Number(rest[1]) });
      break;
    }
    case "cleanup": { // a link to the page where the USER deletes chats themselves; agents never press its button
      await ensureDaemon();
      const r = await cleanupTicket(!!o.dry);
      out(r);
      if (r.ok && !o["no-open"]) spawn("cmd.exe", ["/c", "start", "", r.url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      break;
    }
    case "folders": await tool("list_folders", {}); break;
    case "folder": {
      if (!rest[0] || !rest[1]) die("usage: tg folder <name> <chat,chat,...>");
      await tool("folder_set", { name: rest[0], chats: rest.slice(1).join(",").split(",").map((s) => s.trim()).filter(Boolean) });
      break;
    }
    case "folder-remove": {
      if (!rest[0]) die("usage: tg folder-remove <name>");
      await tool("folder_remove", { name: rest.join(" ") });
      break;
    }
    case "archive":
    case "unarchive": {
      if (!rest[0]) die(`usage: tg ${cmd} <chat>`);
      await tool("archive_chat", { chat: rest[0], archived: cmd === "archive" });
      break;
    }
    case "call": {
      if (!rest[0]) die("usage: tg call <tool> '<json>'");
      await tool(rest[0], rest[1] ? JSON.parse(rest[1]) : {});
      break;
    }
    case "log": {
      const f = path.join(ROOT, "logs", "daemon.log");
      const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trimEnd().split("\n") : [];
      process.stdout.write(lines.slice(-(num(o.n) || 40)).join("\n") + "\n");
      break;
    }
    default: die(`unknown command "${cmd}" (tg --help)`);
  }
} catch (e) {
  die(e.code === "ECONNREFUSED" ? `tg daemon is not running on 127.0.0.1:${PORT} (tg start)` : e.message || String(e));
}
