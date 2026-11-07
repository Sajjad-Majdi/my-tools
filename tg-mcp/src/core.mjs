// tg-mcp core: the ONE Telegram connection of this PC (GramJS through the tg-user-relay Worker), its throttle queue,
// the dialogs cache and every tool. Only daemon.mjs loads this module; the MCP server and the CLI are thin clients.
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import tg from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { ROOT, loadConfig, loadSession, saveSession, makeClient } from "./tg.mjs";
import os from "node:os";
import { AUDIO_EXT, PHOTO_EXT, VIDEO_EXT, prepareVideo, prepareVoice, probe } from "./media.mjs";

const { Api } = tg;
export const VERSION = "2.1.0";
const DOWNLOADS = path.join(ROOT, "downloads");
const LOGIN = path.join(ROOT, "login.cmd");
const OFFLINE = process.env.TG_MCP_OFFLINE === "1"; // tests: never touch Telegram
let cfg = loadConfig();

// ---------- logging (daemon.mjs replaces this with its file logger) ----------
let logFn = (line) => console.error(line);
export const setLogger = (fn) => (logFn = fn);
export const log = (msg) => logFn(`[tg] ${msg}`);

// ---------- throttling (official-app api_id: behave like one calm human client) ----------
const GAP_MS = 1100; // min gap between any two Telegram API calls (all calls go through one queue)
const SEND_GAP_MS = 3000; // min gap between two send_message calls
const FLOOD_SLEEP_MAX = 60; // FLOOD_WAIT up to this many seconds: sleep once, then retry; longer: fail and report
const HUNG_MS = 90_000; // a call with no answer for this long frees the queue and counts as a hang
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve();
let queued = 0; // calls waiting in the queue right now
let lastCall = 0;
let lastSend = 0;
let floodUntil = 0; // epoch ms; no call goes out before this
let notes = []; // flood reports, attached to the next tool result
const inCall = new AsyncLocalStorage(); // a call GramJS makes from inside a queued call must not wait for the queue (deadlock)
export const stats = { invokes: 0, hung: 0, floods: 0, reconnects: 0, startedAt: Date.now(), lastOkAt: 0 };

function floodNote(sec, what, slept) {
  stats.floods++;
  const until = when(Math.floor(Date.now() / 1000) + sec);
  const n = slept ? `FLOOD_WAIT ${sec}s on ${what}: slept, then retried` : `FLOOD_WAIT ${sec}s on ${what}: Telegram blocks this until ${until} (Tehran). Not retried.`;
  log(n);
  notes.push(n);
}

function throttle(c) {
  const invoke = c.invoke.bind(c);
  c.invoke = (req, ...rest) => {
    if (inCall.getStore()) return invoke(req, ...rest);
    queued++;
    const run = queue.then(() => inCall.run(true, async () => {
      queued--;
      for (let attempt = 0; ; attempt++) {
        const wait = Math.max(floodUntil - Date.now(), lastCall + GAP_MS - Date.now());
        if (floodUntil - Date.now() > FLOOD_SLEEP_MAX * 1000) {
          throw new Error(`FLOOD_WAIT active: Telegram blocks calls until ${when(Math.floor(floodUntil / 1000))} (Tehran). Wait, do not retry.`);
        }
        if (wait > 0) await sleep(wait);
        lastCall = Date.now();
        stats.invokes++;
        try {
          const r = await invoke(req, ...rest);
          stats.lastOkAt = Date.now();
          return r;
        } catch (e) {
          const sec = e?.seconds;
          if (!sec || !/FLOOD|SLOWMODE/.test(String(e.errorMessage || e.message))) throw e;
          floodUntil = Math.max(floodUntil, Date.now() + sec * 1000);
          const what = req?.className || "request";
          if (sec > FLOOD_SLEEP_MAX || attempt > 0) {
            floodNote(sec, what, false);
            throw e;
          }
          floodNote(sec, what, true);
        }
      }
    }));
    // A call with no answer (dead socket) must not block the queue forever: free it after HUNG_MS and remember the hang.
    let settled = false;
    run.then(() => (settled = true), () => (settled = true));
    const guard = new Promise((r) => setTimeout(() => {
      if (!settled) {
        stats.hung++;
        log(`call ${req?.className || "request"} has no answer after ${HUNG_MS / 1000}s: queue freed, connection will be checked`);
        checkHealth("hung call");
      }
      r();
    }, HUNG_MS).unref());
    queue = Promise.race([run.catch(() => {}), guard]);
    return run;
  };
}

// ---------- connection ----------
let client = null;
let ready = null;
let loadedSession = ""; // session.txt text the current client uses; a change means login ran -> switch to it
let dead = null; // set when Telegram revoked the key: no reconnect with it until session.txt changes
let paused = 0; // epoch ms while login.mjs holds the account (daemon must keep its socket closed)
let lastStartAt = 0;
let startFailures = 0;
let reconnectingSince = 0;
const FATAL = /AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/;
const errText = (e) => String(e?.errorMessage || e?.message || e);
const NOT_LOGGED_IN = `Not logged in. The account owner must run ${LOGIN} once.`;

class BridgeLogger extends Logger {
  constructor() { super(LogLevel.WARN); }
  log(level, message) { logFn(`[gramjs ${level}] ${message}`); }
}

async function dropClient(c) {
  if (!c) return;
  // destroy() also ends GramJS's _updateLoop (disconnect() alone leaves it pinging a closed sender forever).
  await Promise.race([c.destroy().catch(() => {}), sleep(3000)]);
}

function markDead(e) {
  const code = (errText(e).match(FATAL) || ["revoked"])[0];
  dead = `Telegram ended this login (${code}). The account owner must log in again: ${LOGIN}. Nothing reconnects until then.`;
  log(dead);
  const c = client;
  client = null;
  dropClient(c);
}

function start(why = "") {
  const old = client;
  client = null;
  dead = null;
  dialogsAt = 0; // keep the old cache (titles, hashes are stable); refresh lazily, so a reconnect costs no getDialogs calls
  reconnectingSince = 0;
  lastStartAt = Date.now();
  loadedSession = loadSession();
  log(`connecting${why ? " (" + why + ")" : ""}`);
  ready = (async () => {
    if (old) await dropClient(old); // never two sockets on one key
    if (OFFLINE) throw new Error("offline test mode: no Telegram connection");
    cfg = loadConfig(); // re-read: login may have run after this process started
    const s = loadedSession;
    if (!s || !cfg.apiId || !cfg.apiHash) throw new Error(NOT_LOGGED_IN);
    const c = makeClient(cfg, s, { floodSleepThreshold: 0 }); // FLOOD_WAIT is handled by throttle() above
    c._log = new BridgeLogger(); // GramJS WARN/ERROR lines (reconnects, closed sockets) go to our log; set before connect() creates the sender
    throttle(c);
    const t0 = Date.now();
    try {
      await withDeadline(c.connect(), 60_000, "connect");
      if (!(await withDeadline(c.checkAuthorization(), 60_000, "checkAuthorization"))) throw new Error("AUTH_KEY_UNREGISTERED (session is not authorized)");
    } catch (e) {
      await dropClient(c);
      throw e;
    }
    client = c;
    startFailures = 0;
    stats.reconnects++;
    log(`connected in ${Date.now() - t0} ms (dc ${c.session.dcId})`);
    const now = c.session.save();
    if (now && now !== s) {
      saveSession(now);
      loadedSession = now;
    }
    if (!dialogs) warmDialogs().catch(() => {}); // first connect only: fill the chat cache (4 getDialogs calls)
    return c;
  })();
  ready.catch((e) => {
    startFailures++;
    log(`connect failed: ${errText(e)}`);
    if (FATAL.test(errText(e)) && !dead) markDead(e);
  });
}

// Zombie detection: GramJS gives up after connectionRetries, leaves the sender "not connected, not reconnecting", and from
// then on every request waits forever (seen 2026-10-20: send_message ran 26 min with no answer). We restart the client.
function senderState(c) {
  const s = c?._sender;
  if (!s) return "none";
  if (s.isReconnecting) return "reconnecting";
  return s.isConnected() ? "connected" : "disconnected";
}

export function checkHealth(why = "watchdog") {
  if (paused || dead || OFFLINE) return;
  if (loadSession() !== loadedSession && loadedSession !== "") return start("session.txt changed"); // login wrote a new session
  if (!client) {
    // connect failed earlier (network): retry with backoff, but never hammer the relay; NOT_LOGGED_IN waits for session.txt
    if (ready && startFailures && loadSession()) {
      const backoff = Math.min(300_000, 10_000 * 2 ** Math.min(startFailures - 1, 5));
      if (Date.now() - lastStartAt > backoff) start(`retry after ${startFailures} failure(s)`);
    }
    return;
  }
  const st = senderState(client);
  if (st === "reconnecting") {
    reconnectingSince ||= Date.now();
    if (Date.now() - reconnectingSince > 120_000) start("GramJS reconnecting for >120 s");
    return;
  }
  reconnectingSince = 0;
  if (st !== "connected") start(`sender ${st} (${why})`);
}

async function tgc() {
  if (paused) throw new Error("Paused: Telegram login is running on this PC. Finish login.cmd, then retry.");
  if (!ready) start("first call");
  else if (loadSession() !== loadedSession) start("session.txt changed"); // login wrote a new session: drop the old client, use the new one
  if (dead) throw new Error(dead);
  let c;
  try {
    c = await ready;
  } catch (e) {
    if (FATAL.test(errText(e))) {
      if (!dead) markDead(e);
      throw new Error(dead);
    }
    if (errText(e) === NOT_LOGGED_IN || OFFLINE) throw e;
    start("retry on tool call"); // network may have come back
    c = await ready;
  }
  if (senderState(c) === "disconnected") {
    start("sender disconnected before a tool call");
    c = await ready;
  }
  return c;
}

// login.mjs calls this before it logs in: our socket must be closed while a second client uses the account, or Telegram
// sees the key from two IPs and revokes it. resume() (or a changed session.txt, or 15 min) reconnects.
export async function pause() {
  paused = Date.now();
  const c = client;
  client = null;
  ready = null;
  log("paused for login: socket closed");
  await dropClient(c);
}

export function resume(why = "resume") {
  if (!paused) return;
  paused = 0;
  start(why);
}

export function status() {
  return {
    version: VERSION,
    pid: process.pid,
    offline: OFFLINE,
    connected: !!client && senderState(client) === "connected",
    sender: client ? senderState(client) : "none",
    dead: dead || undefined,
    paused: paused ? when(Math.floor(paused / 1000)) : undefined,
    loggedIn: !!loadSession(),
    dc: client?.session?.dcId,
    queued,
    floodUntil: floodUntil > Date.now() ? when(Math.floor(floodUntil / 1000)) : undefined,
    dialogsCached: dialogs ? dialogs.length : 0,
    dialogsAge_s: dialogs ? Math.round((Date.now() - dialogsAt) / 1000) : undefined,
    uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
    invokes: stats.invokes,
    hung: stats.hung,
    floods: stats.floods,
    connects: stats.reconnects,
    lastOk: stats.lastOkAt ? when(Math.floor(stats.lastOkAt / 1000)) : undefined,
  };
}

export function init() {
  if (OFFLINE) {
    log("offline test mode: Telegram is never contacted");
    return;
  }
  start("daemon start");
  const t = setInterval(() => checkHealth(), 30_000);
  t.unref();
  const p = setInterval(() => { if (paused && Date.now() - paused > 15 * 60_000) resume("pause expired after 15 min"); }, 30_000);
  p.unref();
}

export async function shutdown() {
  const c = client;
  client = null;
  await dropClient(c); // close the Telegram socket before the port is freed
}

// ---------- dialogs cache (titles, unread counts, entity hashes) ----------
let dialogs = null;
let dialogsAt = 0;
let dialogsLoading = null;
const DIALOGS_FRESH_MS = 20_000; // list_dialogs/get_unread reuse a cache younger than this (messages.getDialogs is flood-limited)

async function warmDialogs(force = false) {
  if (!force && dialogs && Date.now() - dialogsAt < DIALOGS_FRESH_MS) return dialogs;
  if (dialogsLoading) return dialogsLoading; // two parallel tool calls share one fetch
  dialogsLoading = (async () => {
    const c = await tgc();
    const d = await c.getDialogs({ limit: 400 });
    dialogs = d;
    dialogsAt = Date.now();
    return d;
  })();
  try {
    return await dialogsLoading;
  } finally {
    dialogsLoading = null;
  }
}

const norm = (s) => (s || "").toLowerCase().replace(/[\u200c\u200f\u200e]/g, "").replace(/ي/g, "ی").replace(/ك/g, "ک").trim();

// Full scan of every dialog (main + archive), paged by GramJS (100 per messages.getDialogs, each throttled ~1.1 s).
// Kept separately, so the quick 400-dialog cache stays small; reused for ALL_FRESH_MS unless refresh is asked.
let allDialogs = null;
let allAt = 0;
const ALL_FRESH_MS = 10 * 60_000;

async function scanAllDialogs(force = false) {
  if (!force && allDialogs && Date.now() - allAt < ALL_FRESH_MS) return allDialogs;
  const c = await tgc();
  const d = await c.getDialogs({}); // no limit = every page
  allDialogs = d;
  allAt = Date.now();
  return d;
}

function fromCache(pred) {
  return (dialogs && dialogs.find(pred)) || (allDialogs && allDialogs.find(pred)) || undefined;
}

async function resolveChat(chat) {
  const c = await tgc();
  const v = String(chat).trim();
  if (/^(me|self|saved)$/i.test(v)) return c.getInputEntity("me");
  if (/^-?\d+$/.test(v)) {
    // 1) GramJS session cache (filled by every response) -> no network; 2) our dialogs cache; 3) refresh dialogs once
    try {
      return c.session.getInputEntity(tg.helpers.returnBigInt(v));
    } catch {}
    let hit = fromCache((x) => String(x.id) === v);
    if (!hit) {
      await warmDialogs(true);
      hit = fromCache((x) => String(x.id) === v);
    }
    if (hit) return hit.inputEntity;
    return c.getInputEntity(tg.helpers.returnBigInt(v)); // last try (bots, users seen elsewhere); throws a clear error
  }
  const uname = v.includes("t.me/") ? v.replace(/^https?:\/\/t\.me\//, "").replace(/^@/, "") : v.startsWith("@") ? v.slice(1) : null;
  if (uname) {
    const hit = fromCache((d) => norm(d.entity?.username) === norm(uname));
    if (hit) return hit.inputEntity;
    return c.getInputEntity(uname); // contacts.resolveUsername (flood-limited: only for explicit @ / t.me)
  }
  const ds = await warmDialogs();
  const q = norm(v);
  const exact = ds.filter((d) => norm(d.title) === q || norm(d.entity?.username) === q);
  const part = exact.length ? exact : ds.filter((d) => norm(d.title).includes(q));
  if (part.length === 1) return part[0].inputEntity;
  if (part.length > 1) {
    throw new Error(`"${v}" matches ${part.length} chats: ` + part.slice(0, 8).map((d) => `${d.title} (${d.id})`).join("; ") + ". Pass the id.");
  }
  if (/^[a-zA-Z][\w]{3,}$/.test(v)) {
    try {
      return await c.getInputEntity(v); // maybe a public username typed without @
    } catch {}
  }
  throw new Error(`No chat matches "${v}". Use list_dialogs with query.`);
}

// ---------- compact output ----------
const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
export const when = (unix) => (unix ? fmt.format(new Date(unix * 1000)) : undefined);

function nameOf(e) {
  if (!e) return undefined;
  if (e.title) return e.title;
  const n = [e.firstName, e.lastName].filter(Boolean).join(" ");
  return n || (e.username ? "@" + e.username : String(e.id));
}

function kind(d) {
  if (d.isUser) return d.entity?.bot ? "bot" : "user";
  if (d.isChannel) return d.entity?.megagroup ? "group" : "channel";
  return "group";
}

function media(m) {
  if (!m.media) return undefined;
  const o = { type: m.media.className.replace(/^MessageMedia/, "").toLowerCase() };
  if (m.photo) o.type = "photo";
  const doc = m.document;
  if (doc) {
    o.size = Number(doc.size);
    o.mime = doc.mimeType;
    for (const a of doc.attributes || []) {
      if (a.fileName) o.name = a.fileName;
      if (a.className === "DocumentAttributeAudio") { o.type = a.voice ? "voice" : "audio"; o.sec = a.duration; }
      if (a.className === "DocumentAttributeVideo") { o.type = a.roundMessage ? "round" : "video"; o.sec = Math.round(a.duration); o.w = a.w; o.h = a.h; }
      if (a.className === "DocumentAttributeSticker") { o.type = "sticker"; o.alt = a.alt; }
    }
    if (doc.thumbs?.length) o.preview = true;
  }
  if (m.media.webpage?.url) { o.type = "link"; o.url = m.media.webpage.url; }
  return o;
}

function buttons(m) {
  const rows = m.replyMarkup?.rows;
  return rows?.length ? rows.map((r) => r.buttons.map((b) => b.text)) : undefined;
}

// button = text (exact, else unique part), "row,col" (0-based) or a flat index (0-based)
function findButton(m, button) {
  const flat = (m.replyMarkup?.rows || []).flatMap((r, i) => r.buttons.map((b, j) => ({ b, i, j })));
  if (!flat.length) throw new Error("That message has no buttons.");
  const v = String(button).trim();
  const q = norm(v);
  const rc = v.match(/^(\d+)\s*[,:]\s*(\d+)$/);
  let hit;
  if (rc) hit = flat.find((x) => x.i === +rc[1] && x.j === +rc[2]);
  else if (/^\d+$/.test(v) && !flat.some((x) => norm(x.b.text) === q)) hit = flat[+v];
  else {
    const exact = flat.filter((x) => norm(x.b.text) === q);
    const part = exact.length ? exact : flat.filter((x) => norm(x.b.text).includes(q));
    if (part.length > 1) throw new Error(`"${v}" matches ${part.length} buttons: ${part.map((x) => `[${x.i},${x.j}] ${x.b.text}`).join(" | ")}. Be exact or pass "row,col".`);
    hit = part[0];
  }
  if (!hit) throw new Error(`No button "${v}". Buttons: ${flat.map((x) => `[${x.i},${x.j}] ${x.b.text}`).join(" | ")}`);
  return hit;
}

async function sendSlot() { // reserve a slot, so parallel sends also keep the gap
  const at = Math.max(Date.now(), lastSend + SEND_GAP_MS);
  lastSend = at;
  await sleep(at - Date.now());
}

function msg(m, withChat = false) {
  const o = { id: m.id, date: when(m.date) };
  if (withChat) o.chat = nameOf(m.chat) ?? String(m.chatId);
  if (withChat) o.chat_id = String(m.chatId);
  if (m.out) o.out = true;
  else if (m.sender) o.from = nameOf(m.sender);
  if (m.fwdFrom) o.fwd = m.fwdFrom.fromName || "forwarded";
  if (m.replyTo?.replyToMsgId) o.reply_to = m.replyTo.replyToMsgId;
  if (m.message) o.text = m.message;
  const md = media(m);
  if (md) o.media = md;
  if (m.action) o.action = m.action.className.replace(/^MessageAction/, "");
  if (m.editDate) o.edited = true;
  const b = buttons(m);
  if (b) o.buttons = b;
  return o;
}

function dialog(d) {
  const o = { id: String(d.id), title: d.title || nameOf(d.entity), type: kind(d) };
  if (d.entity?.username) o.username = d.entity.username;
  if (d.isUser) { // flags for clean-ups: deleted account, saved contact, bot
    if (d.entity?.deleted) o.deleted = true;
    if (d.entity?.contact) o.contact = true;
    if (d.entity?.bot) o.bot = true;
  }
  if (d.unreadCount) o.unread = d.unreadCount;
  if (d.unreadMentionsCount) o.mentions = d.unreadMentionsCount;
  if (d.pinned) o.pinned = true;
  if (d.archived) o.archived = true;
  if (d.dialog?.notifySettings?.muteUntil > Date.now() / 1000) o.muted = true;
  if (d.message) {
    const t = d.message.message || (d.message.media ? `[${media(d.message)?.type}]` : "");
    o.last = { date: when(d.message.date), text: t.length > 120 ? t.slice(0, 120) + "…" : t };
    if (d.message.out) o.last.out = true;
  }
  return o;
}

const sinceUnix = (s) => {
  if (!s) return 0;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00+03:30" : s);
  if (isNaN(d)) throw new Error(`Bad date "${s}". Use YYYY-MM-DD or ISO.`);
  return Math.floor(d.getTime() / 1000);
};

function withDeadline(p, ms, label) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`), { code: "TIMEOUT" })), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// ---------- chat folders (dialog filters) ----------
const FOLDER_MAX = 100; // included chats per folder for a non-premium account (dialog_filters_chats_limit_default)
const FA = "۰۱۲۳۴۵۶۷۸۹";
const partNo = (name, n) => (/[؀-ۿ]/.test(name) ? String(n).replace(/\d/g, (d) => FA[d]) : String(n));
const isPartOf = (title, name) => title.startsWith(name + " ") && /^[\d۰-۹]+$/.test(title.slice(name.length + 1));

async function getFolders() {
  const c = await tgc();
  const r = await c.invoke(new Api.messages.GetDialogFilters());
  return (r.filters || r).filter((f) => f.className === "DialogFilter");
}

// ---------- tools ----------
// Each tool: { description, shape (zod raw shape, also used by the MCP server), deadline (ms), run(args) }.
const chatArg = z.string().describe('Chat: numeric id (from list_dialogs), @username, t.me link, "me" for Saved Messages, or part of the chat title');

export const TOOLS = {
  list_dialogs: {
    description: "List the user's Telegram chats, newest first, with unread counts and the last message. Use query to find a chat by title or username. Normally the newest 400 chats; all: true scans every chat incl. archived (paged, ~1.1 s per 100 chats, cached 10 min). User chats carry deleted / contact / bot flags.",
    shape: {
      limit: z.number().int().min(1).max(100000).optional().describe("Max chats (default 30; with all: every chat unless limited)"),
      query: z.string().optional().describe("Filter by title/username (substring)"),
      unread_only: z.boolean().optional(),
      type: z.enum(["user", "bot", "group", "channel"]).optional(),
      all: z.boolean().optional().describe("Scan every dialog (main + archive), not only the newest 400"),
      refresh: z.boolean().optional().describe("Force a fresh fetch (default: reuse a cache younger than 20 s, or 10 min with all)"),
    },
    deadline: 10 * 60_000,
    async run({ limit, query, unread_only, type, all, refresh }) {
      limit ??= all ? 100000 : 30;
      const ds = all ? await scanAllDialogs(!!refresh) : await warmDialogs(!!refresh);
      const q = norm(query);
      let out = ds.filter((d) => !q || norm(d.title).includes(q) || norm(d.entity?.username).includes(q));
      if (unread_only) out = out.filter((d) => d.unreadCount > 0);
      if (type) out = out.filter((d) => kind(d) === type);
      return out.slice(0, limit).map(dialog);
    },
  },
  read_history: {
    description: "Read messages of one chat, newest first. Page older with offset_id (= smallest id you got). since filters by date (Tehran time).",
    shape: {
      chat: chatArg,
      limit: z.number().int().min(1).max(200).optional().describe("Max messages (default 30, max 200 per call; page with offset_id)"),
      offset_id: z.number().int().optional().describe("Return messages older than this id"),
      min_id: z.number().int().optional().describe("Only messages newer than this id"),
      since: z.string().optional().describe("Only messages on/after this date: YYYY-MM-DD or ISO"),
      oldest_first: z.boolean().optional().describe("Return in chronological order"),
    },
    deadline: 120_000,
    async run({ chat, limit = 30, offset_id, min_id, since, oldest_first }) {
      const c = await tgc();
      const peer = await resolveChat(chat);
      const from = sinceUnix(since);
      const out = [];
      limit = Math.min(limit, 200);
      // Newest first, so "since" only stops early; never fetch more than limit (100 per request).
      for await (const m of c.iterMessages(peer, { limit, offsetId: offset_id || 0, minId: min_id || 0 })) {
        if (from && m.date < from) break;
        out.push(msg(m));
        if (out.length >= limit) break;
      }
      if (oldest_first) out.reverse();
      return out;
    },
  },
  search_messages: {
    description: "Search message text in one chat (chat given) or across all chats (no chat).",
    shape: {
      query: z.string().min(1),
      chat: chatArg.optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 20)"),
      since: z.string().optional().describe("Only on/after this date: YYYY-MM-DD or ISO"),
    },
    deadline: 120_000,
    async run({ query, chat, limit = 20, since }) {
      const c = await tgc();
      const from = sinceUnix(since);
      const peer = chat ? await resolveChat(chat) : undefined;
      const ms = await c.getMessages(peer, { search: query, limit });
      return ms.filter((m) => !from || m.date >= from).map((m) => msg(m, !chat));
    },
  },
  get_unread: {
    description: "Chats with unread messages and their unread messages (oldest first). Does not mark them read. Costs ~1.1 s per chat.",
    shape: {
      max_chats: z.number().int().min(1).max(100).optional().describe("Default 20"),
      per_chat: z.number().int().min(1).max(100).optional().describe("Max messages per chat (default 10)"),
      include_muted: z.boolean().optional().describe("Default false: skip muted chats and channels"),
    },
    deadline: 300_000,
    async run({ max_chats = 20, per_chat = 10, include_muted = false }) {
      const c = await tgc();
      const ds = (await warmDialogs(true)).filter((d) => d.unreadCount > 0 && !d.archived);
      const pick = ds.filter((d) => include_muted || !(d.dialog?.notifySettings?.muteUntil > Date.now() / 1000)).slice(0, max_chats);
      const res = [];
      for (const d of pick) { // sequential: the queue serializes them anyway, and one hang must not block them all
        const n = Math.min(d.unreadCount, per_chat);
        const ms = await c.getMessages(d.inputEntity, { limit: n });
        const o = { ...dialog(d), messages: ms.reverse().map((m) => msg(m)) };
        delete o.last;
        res.push(o);
      }
      return { chats_with_unread: ds.length, shown: res };
    },
  },
  download_media: {
    description: "Download the photo/video/file of one message to a local folder. Returns the file path.",
    shape: {
      chat: chatArg,
      message_id: z.number().int(),
      dir: z.string().optional().describe("Target folder (default tg-mcp/downloads)"),
    },
    deadline: 15 * 60_000,
    async run({ chat, message_id, dir }) {
      const c = await tgc();
      const peer = await resolveChat(chat);
      const [m] = await c.getMessages(peer, { ids: [message_id] });
      if (!m || !m.media) throw new Error("That message has no media.");
      const folder = dir || DOWNLOADS;
      fs.mkdirSync(folder, { recursive: true });
      const md = media(m);
      const ext = md.name ? "" : md.type === "photo" ? ".jpg" : md.mime ? "." + md.mime.split("/")[1].replace("quicktime", "mov").replace("mpeg", "mp3") : "";
      const file = path.join(folder, md.name || `${String(m.chatId).replace("-", "")}_${m.id}${ext}`);
      const t0 = Date.now();
      await c.downloadMedia(m, { outputFile: file });
      const size = fs.statSync(file).size;
      return { path: file, size, ms: Date.now() - t0, type: md.type };
    },
  },
  mark_read: {
    description: "Mark a chat as read (up to max_id, or all).",
    shape: { chat: chatArg, max_id: z.number().int().optional() },
    deadline: 60_000,
    async run({ chat, max_id }) {
      const c = await tgc();
      const peer = await resolveChat(chat);
      await c.markAsRead(peer, max_id);
      dialogsAt = 0;
      return { ok: true };
    },
  },
  send_message: {
    description:
      "Send a text message from the user's own Telegram account. NEVER send to real people (anyone except Saved Messages \"me\" or the user's own bots) without the user's explicit approval for that exact message.",
    shape: {
      chat: chatArg,
      text: z.string().min(1),
      reply_to: z.number().int().optional(),
    },
    deadline: 90_000,
    mayHaveSent: true,
    async run({ chat, text, reply_to }) {
      const c = await tgc();
      const peer = await resolveChat(chat);
      await sendSlot();
      const m = await c.sendMessage(peer, { message: text, replyTo: reply_to });
      return { id: m.id, date: when(m.date) };
    },
  },
  send_file: {
    description:
      "Send a local file from the user's own Telegram account: video (real duration, size and preview; made streamable, converted to H.264 when Telegram could not play it), photo, audio, voice note, or any document (markdown, PDF, zip, ...) with its file name. Optional caption (over 1024 chars it follows as a reply message). NEVER send to real people (anyone except Saved Messages \"me\" or the user's own bots) without the user's explicit approval for that exact file and caption.",
    shape: {
      chat: chatArg,
      path: z.string().min(1).describe("Absolute path of a local file (max 2 GB)"),
      caption: z.string().optional(),
      as: z.enum(["auto", "photo", "document", "video", "audio", "voice"]).optional()
        .describe("auto (default): by file type (.jpg/.png = photo, video files = video, music = audio, rest = document); document: always as a plain file, no compression; voice: any audio as a voice note"),
      reply_to: z.number().int().optional(),
    },
    deadline: 30 * 60_000,
    mayHaveSent: true,
    async run({ chat, path: file, caption, as = "auto", reply_to }) {
      const st = fs.statSync(file); // a missing file fails here with a clear ENOENT
      if (!st.isFile()) throw new Error(`Not a file: ${file}`);
      if (st.size > 2000 * 1024 * 1024) throw new Error("The file is over Telegram's 2 GB limit.");
      const kind = as !== "auto" ? as
        : PHOTO_EXT.test(file) && st.size <= 10 * 1024 * 1024 ? "photo"
        : VIDEO_EXT.test(file) ? "video" : AUDIO_EXT.test(file) ? "audio" : "document";
      if (kind === "photo" && st.size > 10 * 1024 * 1024) throw new Error('Photos must be under 10 MB; send it with as: "document".');
      const c = await tgc();
      const peer = await resolveChat(chat);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-send-"));
      const info = { kind };
      try {
        // file parts go straight to the home-DC socket (RelayClient.getSender), not through the throttle queue
        const opts = { file, workers: 4, forceDocument: kind === "document" };
        if (kind === "video") {
          const p = await prepareVideo(file, tmp);
          opts.file = p.file;
          if (p.meta.w) {
            opts.attributes = [new Api.DocumentAttributeVideo({ duration: p.meta.duration, w: p.meta.w, h: p.meta.h, supportsStreaming: true })];
            opts.supportsStreaming = true;
            opts.thumb = p.thumb;
          }
          Object.assign(info, { duration: Math.round(p.meta.duration), w: p.meta.w, h: p.meta.h, codec: p.meta.vcodec, prepared: p.did, preview: !!p.thumb });
        } else if (kind === "voice") {
          const p = await prepareVoice(file, tmp);
          opts.file = p.file;
          opts.voiceNote = true;
          opts.attributes = [new Api.DocumentAttributeAudio({ voice: true, duration: Math.round(p.meta.duration) })];
          Object.assign(info, { duration: Math.round(p.meta.duration), prepared: p.did });
        } else if (kind === "audio") {
          const m = await probe(file).catch(() => null);
          if (m) {
            opts.attributes = [new Api.DocumentAttributeAudio({ duration: Math.round(m.duration), title: m.title, performer: m.artist }),
              new Api.DocumentAttributeFilename({ fileName: path.basename(file) })];
            info.duration = Math.round(m.duration);
          }
        }
        const long = caption && caption.length > 1024; // Telegram's caption limit (non-premium)
        await sendSlot();
        const t0 = Date.now();
        let m;
        try {
          m = await c.sendFile(peer, { ...opts, caption: long ? undefined : caption, replyTo: reply_to });
        } catch (e) {
          if (kind !== "photo" || !/PHOTO_|IMAGE_PROCESS/.test(errText(e))) throw e;
          m = await c.sendFile(peer, { file, workers: 4, forceDocument: true, caption: long ? undefined : caption, replyTo: reply_to });
          info.note = `Telegram refused it as a photo (${errText(e)}); sent as a file`;
        }
        info.upload_ms = Date.now() - t0;
        if (long) {
          await sendSlot();
          info.caption_msg = (await c.sendMessage(peer, { message: caption, replyTo: m.id })).id;
        }
        return { id: m.id, date: when(m.date), size: fs.statSync(opts.file).size, ...info, media: media(m) };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  press_button: {
    description:
      "Press a button under a message: inline bot buttons (callback), URL buttons, reply-keyboard buttons. Without `button` it only lists the buttons. A callback press returns the bot's answer (toast/alert text, url); the bot's new or edited messages then show in read_history. A URL button only returns its URL (nothing is opened). A reply-keyboard button sends its text as a message. Press only buttons of the user's own bots or Saved Messages without asking; anything else needs his OK.",
    shape: {
      chat: chatArg,
      message_id: z.number().int(),
      button: z.string().optional().describe('Button text (exact or a unique part), "row,col" (0-based) or flat index (0-based). Omit to list the buttons.'),
    },
    deadline: 90_000,
    mayHaveSent: true,
    async run({ chat, message_id, button }) {
      const c = await tgc();
      const peer = await resolveChat(chat);
      const [m] = await c.getMessages(peer, { ids: [message_id] });
      if (!m) throw new Error("Message not found.");
      if (button === undefined) {
        return (m.replyMarkup?.rows || []).map((r, i) => r.buttons.map((b, j) => ({
          pos: `${i},${j}`, text: b.text, kind: b.className.replace(/^KeyboardButton/, "") || "Text",
        })));
      }
      const { b, i, j } = findButton(m, button);
      const pressed = { pressed: b.text, pos: `${i},${j}` };
      if (b.className === "KeyboardButtonCallback") {
        try {
          const r = await c.invoke(new Api.messages.GetBotCallbackAnswer({ peer, msgId: message_id, data: b.data }));
          return { ...pressed, answer: r.message || undefined, alert: r.alert || undefined, url: r.url || undefined };
        } catch (e) {
          // the press reached the bot; it just did not answer the callback in time (it may still act on it)
          if (/BOT_RESPONSE_TIMEOUT/.test(errText(e))) return { ...pressed, note: "The bot did not answer the press in time; check read_history." };
          throw e;
        }
      }
      if (b.className === "KeyboardButtonUrl" || b.className === "KeyboardButtonUrlAuth") return { ...pressed, url: b.url, note: "URL button: nothing was opened." };
      if (b.className === "KeyboardButton") { // reply keyboard: pressing it = sending its text
        await sendSlot();
        const s = await c.sendMessage(peer, { message: b.text });
        return { ...pressed, sent: { id: s.id, date: when(s.date) } };
      }
      throw new Error(`Button "${b.text}" is a ${b.className}; only callback, URL and reply-keyboard buttons are supported.`);
    },
  },
  forward_messages: {
    description:
      "Forward messages from one chat to another. copy: true sends them without the \"Forwarded from\" header. NEVER forward to real people (anyone except \"me\" or the user's own bots) without the user's explicit approval.",
    shape: {
      from_chat: chatArg,
      message_ids: z.array(z.number().int()).min(1).max(100),
      to_chat: chatArg,
      copy: z.boolean().optional().describe("Hide the original author (default false)"),
    },
    deadline: 120_000,
    mayHaveSent: true,
    async run({ from_chat, message_ids, to_chat, copy = false }) {
      const c = await tgc();
      const fromPeer = await resolveChat(from_chat);
      const toPeer = await resolveChat(to_chat);
      await sendSlot();
      // raw request: GramJS forwardMessages() returned empty objects for the new messages (2026-10-26 live test)
      const r = await c.invoke(new Api.messages.ForwardMessages({
        fromPeer, toPeer, id: message_ids, dropAuthor: copy, randomId: message_ids.map(() => tg.helpers.generateRandomBigInt()),
      }));
      const got = (r.updates || []).filter((u) => u.message?.id).map((u) => ({ id: u.message.id, date: when(u.message.date) }));
      return { forwarded: got, count: got.length };
    },
  },
  edit_message: {
    description:
      "Edit the text (or the caption) of one of the user's own messages. In a chat with real people this needs the user's OK, like sending.",
    shape: { chat: chatArg, message_id: z.number().int(), text: z.string().min(1) },
    deadline: 60_000,
    async run({ chat, message_id, text }) {
      const c = await tgc();
      const peer = await resolveChat(chat);
      const m = await c.editMessage(peer, { message: message_id, text });
      return { id: m.id, edited: when(m.editDate || m.date) };
    },
  },
  list_folders: {
    description: "List the user's Telegram chat folders (id, title, number of chats).",
    shape: {},
    deadline: 60_000,
    async run() {
      return (await getFolders()).map((f) => ({ id: f.id, title: f.title, chats: f.includePeers.length, pinned: f.pinnedPeers.length }));
    },
  },
  folder_set: {
    description:
      `Create or update a chat folder holding exactly these chats (it only groups chats; nothing is moved or deleted). Telegram allows ${FOLDER_MAX} chats per folder (non-premium), so more chats are split into "<name> ۱", "<name> ۲", ...; leftover parts of an earlier, longer run are removed. Folder titles: at most 12 characters; at most 10 folders per account.`,
    shape: {
      name: z.string().min(1).max(12).describe("Folder title (max 12 characters, incl. the part number when split)"),
      chats: z.array(chatArg).min(1).max(2000),
    },
    deadline: 10 * 60_000,
    async run({ name, chats }) {
      const c = await tgc();
      const peers = [];
      const seen = new Set();
      for (const ch of chats) {
        const p = await resolveChat(ch);
        const key = JSON.stringify(p, (k, v) => (typeof v === "bigint" ? String(v) : v));
        if (!seen.has(key)) { seen.add(key); peers.push(p); }
      }
      const parts = [];
      for (let i = 0; i < peers.length; i += FOLDER_MAX) parts.push(peers.slice(i, i + FOLDER_MAX));
      const titles = parts.length === 1 ? [name] : parts.map((_, i) => `${name} ${partNo(name, i + 1)}`);
      const long = titles.find((t) => t.length > 12);
      if (long) throw new Error(`Folder title "${long}" is over 12 characters; use a shorter name.`);
      const existing = await getFolders();
      const used = new Set(existing.map((f) => f.id));
      const done = [];
      for (let i = 0; i < parts.length; i++) {
        let id = existing.find((f) => f.title === titles[i])?.id;
        if (!id) { id = 2; while (used.has(id)) id++; used.add(id); } // ids 0 and 1 are Telegram's own
        await c.invoke(new Api.messages.UpdateDialogFilter({
          id, filter: new Api.DialogFilter({ id, title: titles[i], pinnedPeers: [], includePeers: parts[i], excludePeers: [] }),
        }));
        done.push({ id, title: titles[i], chats: parts[i].length });
      }
      const stale = existing.filter((f) => !titles.includes(f.title) && isPartOf(f.title, name));
      for (const f of stale) await c.invoke(new Api.messages.UpdateDialogFilter({ id: f.id }));
      return { folders: done, removed_old_parts: stale.map((f) => f.title), chats: peers.length };
    },
  },
  folder_remove: {
    description: "Remove a chat folder (and its split parts \"<name> ۱\", \"<name> ۲\", ...). Only the folder goes; its chats stay untouched.",
    shape: { name: z.string().min(1) },
    deadline: 60_000,
    async run({ name }) {
      const c = await tgc();
      const hit = (await getFolders()).filter((f) => f.title === name || isPartOf(f.title, name));
      for (const f of hit) await c.invoke(new Api.messages.UpdateDialogFilter({ id: f.id }));
      return { removed: hit.map((f) => f.title) };
    },
  },
  archive_chat: {
    description: "Archive a chat, or move it back to the main list with archived: false. Rule: archive chats, never delete them.",
    shape: { chat: chatArg, archived: z.boolean().optional().describe("Default true; false = unarchive") },
    deadline: 60_000,
    async run({ chat, archived = true }) {
      const c = await tgc();
      const peer = await resolveChat(chat);
      await c.invoke(new Api.folders.EditPeerFolders({ folderPeers: [new Api.InputFolderPeer({ peer, folderId: archived ? 1 : 0 })] }));
      dialogsAt = 0; // the cached "archived" flags are stale now
      return { ok: true, archived };
    },
  },
};

export const schemaOf = (name) => z.object(TOOLS[name].shape);

// ---------- clean-up page backend (2026-10-26) ----------
// The user deletes chats HIMSELF on the local page (daemon.mjs /cleanup). Agents never delete: there is no MCP tool and no
// CLI command for it, and the page's endpoint checks a per-load CSRF token + same-origin headers (see daemon.mjs).
const DAY = 86400;
const DELETE_GAP_MS = 6000; // bulk calls hit FLOOD_WAIT on 2026-10-26: one chat per ~6 s
const CRYPTO = /crypto|coin|token|wallet|\bton\b|usdt|btc|bitcoin|\beth\b|airdrop|swap|trad(e|ing)|nft|min(e|ing)|farm|\btap|hamster|notcoin|blum|lotter|\bbet|casino|earn|invest|signal|pump|binance|bybit|okx|tron|solana|کریپتو|ارز|بیت.?کوین|ترید|ایردراپ/i;
const signupOnly = new Map(); // dialog id -> history is only "joined Telegram"; cached for the daemon's life

function readPreselect() {
  try {
    return fs.readFileSync(path.join(ROOT, "cleanup-preselect.txt"), "utf8").split(/[\s,]+/).filter(Boolean);
  } catch {
    return [];
  }
}

export async function cleanupData(refresh = false) {
  const ds = await scanAllDialogs(refresh);
  const c = await tgc();
  for (const d of ds) { // "joined Telegram" only: the last message is ContactSignUp and nothing older exists
    if (!d.isUser || d.entity?.bot || d.entity?.deleted || d.entity?.self) continue;
    if (d.message?.action?.className !== "MessageActionContactSignUp" || signupOnly.has(String(d.id))) continue;
    const ms = await c.getMessages(d.inputEntity, { limit: 2 });
    signupOnly.set(String(d.id), ms.length <= 1);
  }
  const pre = new Set(readPreselect());
  const now = Date.now() / 1000;
  const rows = ds.filter((d) => !d.entity?.self).map((d) => {
    const id = String(d.id);
    const type = kind(d);
    const last = d.message?.date || 0;
    const name = d.title || nameOf(d.entity) || id;
    const sec = d.isUser && d.entity?.deleted ? "deleted" : signupOnly.get(id) ? "joined" : type === "bot" ? "bots"
      : type === "user" && last && now - last > 365 * DAY ? "old" : "other";
    const tags = [];
    if (d.entity?.contact) tags.push("مخاطب");
    if (type === "bot" && CRYPTO.test(`${name} ${d.entity?.username || ""}`)) tags.push("کریپتو");
    if (type === "bot" && (!last || now - last > 180 * DAY)) tags.push("بی‌استفاده");
    if (type === "group") tags.push("گروه");
    if (type === "channel") tags.push("کانال");
    const m = d.message;
    const act = m?.action?.className.replace(/^MessageAction/, "");
    const text = !m ? "" : m.message || (act === "ContactSignUp" ? "به تلگرام پیوست" : act || (m.media ? `[${media(m)?.type}]` : ""));
    return { id, sec, name, username: d.entity?.username, type, archived: !!d.archived, date: when(last), text: text.slice(0, 90), tags, pre: pre.has(id) };
  });
  return { rows, scanned_at: when(Math.floor(allAt / 1000)) };
}

const job = { running: false, dry: false, total: 0, done: 0, ok: 0, fail: 0, waitUntil: 0, current: "", stop: false, results: [] };
const stoppableSleep = async (ms) => { const end = Date.now() + ms; while (!job.stop && Date.now() < end) await sleep(Math.min(500, end - Date.now())); };

export function cleanupStatus() {
  const wait = Math.max(0, job.waitUntil - Date.now());
  return { running: job.running, dry: job.dry, total: job.total, done: job.done, succeeded: job.ok, failed: job.fail, current: job.current,
    stopped: job.stop, wait_s: wait ? Math.ceil(wait / 1000) : 0, results: job.results };
}

async function removeOne(d) {
  const c = await tgc();
  if (d.isChannel) { // channels and supergroups: leave
    await c.invoke(new Api.channels.LeaveChannel({ channel: d.inputEntity }));
    return "left";
  }
  if (d.isGroup) { // basic group: leave, then remove the chat from the list below
    try {
      await c.invoke(new Api.messages.DeleteChatUser({ chatId: d.entity.id, userId: new Api.InputUserSelf(), revokeHistory: false }));
    } catch (e) {
      if (!/USER_NOT_PARTICIPANT|CHAT_ID_INVALID|PEER_ID_INVALID/.test(errText(e))) throw e;
    }
  }
  // private chat or bot (or the basic group just left): delete the history for the user only (revoke: false), page by page
  for (let i = 0; i < 50; i++) {
    const r = await c.invoke(new Api.messages.DeleteHistory({ peer: d.inputEntity, maxId: 0, justClear: false, revoke: false }));
    if (!r.offset) break;
  }
  return d.isGroup ? "left" : "deleted";
}

async function runJob(ids) {
  const byId = new Map((allDialogs || []).map((d) => [String(d.id), d]));
  for (let i = 0; i < ids.length && !job.stop; i++) {
    const id = ids[i];
    const d = byId.get(id);
    const name = d ? d.title || nameOf(d.entity) || id : id;
    job.current = name;
    if (!d) {
      job.fail++;
      job.results.push({ id, name, ok: false, error: "not in the chat list (reload the page)" });
    } else {
      for (;;) {
        try {
          const what = job.dry ? "dry run" : await removeOne(d);
          job.ok++;
          job.results.push({ id, name, ok: true, what });
          break;
        } catch (e) {
          const text = errText(e);
          const wait = Math.max(floodUntil - Date.now(), (e?.seconds || 0) * 1000);
          if (/FLOOD|SLOWMODE/.test(text) && wait > 0 && !job.stop) { // wait it out, then retry the same chat
            job.waitUntil = Date.now() + wait + 1000;
            log(`cleanup: FLOOD_WAIT ${Math.ceil(wait / 1000)} s, waiting`);
            await stoppableSleep(wait + 1000);
            job.waitUntil = 0;
            continue;
          }
          job.fail++;
          job.results.push({ id, name, ok: false, error: text.slice(0, 160) });
          break;
        }
      }
    }
    job.done++;
    if (i < ids.length - 1 && !job.stop) await stoppableSleep(job.dry ? 300 : DELETE_GAP_MS);
  }
}

// Called only by daemon.mjs for the page's confirmed «حذف» request.
export function cleanupStart(ids, dry) {
  if (job.running) throw new Error("A clean-up is already running.");
  ids = [...new Set((ids || []).map(String))].filter((x) => /^-?\d+$/.test(x)).slice(0, 2000);
  if (!ids.length) throw new Error("No chats selected.");
  Object.assign(job, { running: true, dry: !!dry, total: ids.length, done: 0, ok: 0, fail: 0, waitUntil: 0, current: "", stop: false, results: [] });
  log(`cleanup started from the page: ${ids.length} chat(s)${dry ? " (DRY RUN, nothing is deleted)" : ""}`);
  runJob(ids)
    .catch((e) => log(`cleanup error: ${errText(e)}`))
    .finally(() => {
      job.running = false;
      job.current = "";
      dialogsAt = 0;
      allAt = 0; // the chat lists changed
      log(`cleanup finished: ${job.ok} ok, ${job.fail} failed${job.stop ? ", stopped" : ""}${job.dry ? " (dry run)" : ""}`);
    });
  return cleanupStatus();
}

export function cleanupStop() {
  if (job.running) job.stop = true;
  return cleanupStatus();
}

// Offline tests only (scripts/core-check.mjs): inject a fake client to exercise the zombie/deadline paths without Telegram.
export const __test = OFFLINE
  ? {
      setClient(fake) { client = fake; ready = Promise.resolve(fake); loadedSession = loadSession(); dead = null; },
      tgc, checkHealth, senderState, findButton, buttons, state: () => ({ client, dead, paused, startFailures }),
    }
  : undefined;

// Runs one tool with validation and a deadline. Returns { ok, data | error, code?, notes?, ms, invokes }.
export async function runTool(name, args = {}) {
  const t0 = Date.now();
  const inv0 = stats.invokes;
  const tool = TOOLS[name];
  const done = (r) => {
    const n = notes.splice(0);
    const out = { ...r, ms: Date.now() - t0, invokes: stats.invokes - inv0 };
    if (n.length) out.notes = n;
    log(`${name} ${out.ok ? "ok" : "FAIL " + (out.code || "")} ${out.ms} ms, ${out.invokes} api call(s)${out.ok ? "" : ": " + out.error}`);
    return out;
  };
  if (!tool) return done({ ok: false, error: `Unknown tool ${name}`, code: "VALIDATION" });
  let a;
  try {
    a = schemaOf(name).parse(args ?? {});
  } catch (e) {
    return done({ ok: false, error: "Bad arguments: " + (e.issues?.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") || errText(e)), code: "VALIDATION" });
  }
  try {
    const data = await withDeadline(tool.run(a), tool.deadline, name);
    return done({ ok: true, data });
  } catch (e) {
    const text = errText(e);
    if (FATAL.test(text) && !dead) markDead(e);
    let code = e?.code === "TIMEOUT" ? "TIMEOUT" : FATAL.test(text) ? "FATAL" : /FLOOD/.test(text) ? "FLOOD" : OFFLINE ? "OFFLINE" : paused ? "PAUSED" : text === NOT_LOGGED_IN ? "NOT_LOGGED_IN" : "ERROR";
    let error = dead && FATAL.test(text) ? dead : text;
    if (code === "TIMEOUT") {
      checkHealth("tool deadline");
      if (tool.mayHaveSent) error += ". The message MAY have been sent: read the chat before any retry.";
    }
    return done({ ok: false, error, code });
  }
}
