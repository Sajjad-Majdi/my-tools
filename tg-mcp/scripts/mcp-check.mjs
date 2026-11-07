// Starts server.mjs like Claude Code does and calls tools. Usage: node scripts/mcp-check.mjs [tool] [jsonArgs]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t0 = Date.now();
const transport = new StdioClientTransport({ command: process.execPath, args: ["server.mjs"], cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), stderr: "pipe" });
const c = new Client({ name: "check", version: "1" });
await c.connect(transport);
console.log("started in", Date.now() - t0, "ms");
const { tools } = await c.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const [tool, args] = process.argv.slice(2);
if (tool) {
  const t1 = Date.now();
  const r = await c.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} });
  const text = r.content?.[0]?.text || "";
  console.log(`${tool}: ${Date.now() - t1} ms, ${text.length} chars, error=${!!r.isError}`);
  console.log(text.slice(0, 1500));
}
await c.close();
process.exit(0);
