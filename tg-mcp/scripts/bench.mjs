// Speed check: node scripts/bench.mjs <chat> [limit]. Cold = spawn + connect + first call; warm = next calls.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [chat, limit = "100"] = process.argv.slice(2);
const cwd = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const t0 = Date.now();
const c = new Client({ name: "bench", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["server.mjs"], cwd, stderr: "pipe" }));
const call = async (name, args) => {
  const t = Date.now();
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || "";
  if (r.isError) throw new Error(text);
  return { ms: Date.now() - t, n: JSON.parse(text).length, chars: text.length };
};
const first = await call("read_history", { chat, limit: Number(limit) });
console.log(`cold read_history(${limit}): ${Date.now() - t0} ms total, ${first.n} msgs, ${first.chars} chars`);
for (let i = 1; i <= 3; i++) {
  const r = await call("read_history", { chat, limit: Number(limit) });
  console.log(`warm #${i}: ${r.ms} ms, ${r.n} msgs`);
}
const d = await call("list_dialogs", { limit: 100 });
console.log(`list_dialogs(100): ${d.ms} ms, ${d.chars} chars`);
await c.close();
process.exit(0);
