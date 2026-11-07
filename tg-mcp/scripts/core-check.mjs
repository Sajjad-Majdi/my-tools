// Offline unit check of src/core.mjs robustness (TG_MCP_OFFLINE=1, no Telegram, no daemon). Usage: node scripts/core-check.mjs
// Proves the two fixes for the 2026-10-20/21 hangs: (1) a tool call gets a hard deadline instead of waiting forever,
// (2) a client whose GramJS sender is "disconnected, not reconnecting" (zombie) is replaced before the next call.
process.env.TG_MCP_OFFLINE = "1";
const core = await import("../src/core.mjs");
const lines = [];
core.setLogger((l) => lines.push(l));
let fails = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " - " + info : ""}`); if (!ok) fails++; };

// 1. deadline: a tool that never answers fails with TIMEOUT after its deadline (here 300 ms), and asks for a health check
const t = core.TOOLS.read_history;
const realRun = t.run, realDeadline = t.deadline;
t.run = () => new Promise(() => {});
t.deadline = 300;
let t0 = Date.now();
let r = await core.runTool("read_history", { chat: "me" });
check("deadline -> TIMEOUT", !r.ok && r.code === "TIMEOUT", `${Date.now() - t0} ms: ${r.error}`);
t.run = realRun; t.deadline = realDeadline;

// send_message timeout carries the "MAY have been sent" warning
const s = core.TOOLS.send_message;
const sRun = s.run, sDl = s.deadline;
s.run = () => new Promise(() => {});
s.deadline = 200;
r = await core.runTool("send_message", { chat: "me", text: "x" });
check("send_message timeout warns 'MAY have been sent'", r.code === "TIMEOUT" && /MAY have been sent/.test(r.error));
s.run = sRun; s.deadline = sDl;

// 2. zombie sender: fake client whose sender is disconnected and not reconnecting -> tgc() restarts the client
let destroyed = 0;
const fake = { _sender: { isReconnecting: false, isConnected: () => false }, session: { dcId: 2, save: () => "" }, destroy: async () => { destroyed++; } };
core.__test.setClient(fake);
check("fake sender state = disconnected", core.__test.senderState(fake) === "disconnected");
lines.length = 0;
let err;
try { await core.__test.tgc(); } catch (e) { err = e; }
check("tgc() drops the zombie and reconnects", destroyed === 1 && lines.some((l) => /sender disconnected before a tool call/.test(l)), lines.join(" | "));
check("offline: the reconnect fails cleanly (no Telegram)", /offline test mode/.test(String(err?.message)));

// 3. watchdog: reconnecting for too long -> restart; connected -> nothing
const stuck = { _sender: { isReconnecting: true, isConnected: () => false }, session: { dcId: 2 }, destroy: async () => { destroyed++; } };
core.__test.setClient(stuck);
lines.length = 0;
core.__test.checkHealth("test");
check("watchdog tolerates a fresh GramJS reconnect", !lines.some((l) => /connecting/.test(l)), lines.join(" | "));
const live = { _sender: { isReconnecting: false, isConnected: () => true }, session: { dcId: 2 }, destroy: async () => { destroyed++; } };
core.__test.setClient(live);
lines.length = 0;
core.__test.checkHealth("test");
check("watchdog leaves a connected client alone", lines.length === 0 && core.__test.state().client === live);

// 4. status() is plain data
const st = core.status();
check("status()", st.version === core.VERSION && typeof st.uptime_s === "number" && st.sender === "connected", JSON.stringify(st).slice(0, 120));

// 5. buttons: listed in messages, found by exact text, unique part, "row,col" or flat index; ambiguity is an error
const kb = { replyMarkup: { rows: [
  { buttons: [{ text: "360p · ۲۷ مگابایت", className: "KeyboardButtonCallback" }, { text: "720p · ۱۵۳ مگابایت", className: "KeyboardButtonCallback" }] },
  { buttons: [{ text: "دانلود مستقیم", className: "KeyboardButtonUrl", url: "https://x" }] },
] } };
const fb = core.__test.findButton;
check("buttons listed", JSON.stringify(core.__test.buttons(kb)) === JSON.stringify([["360p · ۲۷ مگابایت", "720p · ۱۵۳ مگابایت"], ["دانلود مستقیم"]]));
check("button by part", fb(kb, "720p").j === 1 && fb(kb, "دانلود").i === 1);
check("button by row,col and index", fb(kb, "1,0").b.url === "https://x" && fb(kb, "1").j === 1);
let bErr = "";
try { fb(kb, "مگابایت"); } catch (e) { bErr = e.message; }
check("ambiguous button is an error", /matches 2 buttons/.test(bErr), bErr);
try { fb({}, "x"); bErr = ""; } catch (e) { bErr = e.message; }
check("no buttons is an error", /no buttons/.test(bErr));

// 6. the new sending tools validate and carry the "MAY have been sent" flag
r = await core.runTool("send_file", { chat: "me", path: "C:/no/such/file.bin" });
check("send_file: missing file is a clear error", !r.ok && /ENOENT|no such file/i.test(r.error), r.error);
r = await core.runTool("forward_messages", { from_chat: "me", message_ids: [], to_chat: "me" });
check("forward_messages: empty ids rejected", !r.ok && r.code === "VALIDATION");
check("sending tools flagged mayHaveSent", ["send_message", "send_file", "forward_messages", "press_button"].every((n) => core.TOOLS[n].mayHaveSent));

console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
