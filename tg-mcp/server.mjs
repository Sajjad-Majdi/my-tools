// tg-mcp: stdio MCP server for the user's own Telegram account. Since 2026-10-26 this is a THIN client: the one Telegram
// connection of this PC lives in daemon.mjs (src/core.mjs); every Claude session's copy of this server forwards tool calls
// to it over 127.0.0.1 and starts it when it is not running. stdout belongs to the MCP protocol: logs go to stderr.
console.log = console.info = console.debug = (...a) => console.error(...a);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, VERSION } from "./src/core.mjs";
import { call, ensureDaemon, PORT } from "./src/client.mjs";

const server = new McpServer({ name: "tg", version: VERSION });

for (const [name, t] of Object.entries(TOOLS)) {
  server.registerTool(name, { description: t.description, inputSchema: t.shape }, async (args) => {
    let r;
    try {
      r = await call(name, args ?? {}, { timeoutMs: t.deadline + 30_000 });
    } catch (e) {
      const hint = t.mayHaveSent && e.code !== "ECONNREFUSED" && e.code !== "ENODAEMON" ? " The message MAY have been sent: read the chat before any retry." : "";
      return { isError: true, content: [{ type: "text", text: `tg daemon (127.0.0.1:${PORT}) unreachable: ${e.message}.${hint}` }] };
    }
    const extra = r.notes?.length ? [{ type: "text", text: JSON.stringify({ notes: r.notes }) }] : [];
    if (!r.ok) return { isError: true, content: [{ type: "text", text: r.error }, ...extra] };
    return { content: [{ type: "text", text: JSON.stringify(r.data) }, ...extra] };
  });
}

// Start (or find) the daemon right away so the connection is warm before the first tool call; never block MCP startup on it.
ensureDaemon().then(
  (h) => console.error(`[tg-mcp] daemon pid ${h.pid} on 127.0.0.1:${PORT}, connected=${h.connected}`),
  (e) => console.error(`[tg-mcp] daemon not reachable yet: ${e.message}`),
);
await server.connect(new StdioServerTransport());
process.stdin.on("close", () => process.exit(0));
