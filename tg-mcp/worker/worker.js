// Relay for your own Telegram user client (tg-mcp) on filtered networks.
//
// 1. /<SECRET>/<dc>/apiws  ->  wss://<dc>.web.telegram.org/apiws (MTProto over WebSocket).
//    The upstream response is returned as is, so Cloudflare pipes the socket with no Worker CPU per frame.
// 2. /<SECRET>/my  sets a gate cookie, then every other path is a reverse proxy of my.telegram.org
//    (to create the api_id/api_hash without a VPN).
// Anything without the secret gets 404, so this is not an open proxy.

const DCS = new Set(["pluto", "venus", "aurora", "vesta", "flora"]);
const GATE = "tgr_gate";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/");
    const secret = env.RELAY_SECRET;
    if (!secret) return new Response("not configured", { status: 500 });

    if (parts[1] === secret) {
      const what = parts[2] || "";
      const dc = what.replace(/-1$/, "");
      if (DCS.has(dc) && parts[3] === "apiws" && parts.length === 4) {
        if (req.headers.get("Upgrade") !== "websocket") return new Response("ws only", { status: 426 });
        const headers = new Headers(req.headers);
        headers.delete("host");
        headers.set("Origin", "https://web.telegram.org");
        return fetch(`https://${what}.web.telegram.org/apiws`, { headers });
      }
      if (what === "my") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": `${GATE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
          },
        });
      }
      return new Response("not found", { status: 404 });
    }

    const cookies = req.headers.get("Cookie") || "";
    if (!cookies.split(/;\s*/).includes(`${GATE}=${secret}`)) return new Response("not found", { status: 404 });
    return proxyMy(req, url, cookies);
  },
};

async function proxyMy(req, url, cookies) {
  const target = "https://my.telegram.org" + url.pathname + url.search;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("Cookie", cookies.split(/;\s*/).filter((c) => !c.startsWith(GATE + "=")).join("; "));
  for (const h of ["Origin", "Referer"]) {
    const v = headers.get(h);
    if (v) headers.set(h, v.replace(url.origin, "https://my.telegram.org"));
  }
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
  const out = new Headers(res.headers);
  const loc = out.get("Location");
  if (loc) out.set("Location", loc.replace("https://my.telegram.org", url.origin));
  out.delete("Set-Cookie");
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    out.append("Set-Cookie", c.replace(/;\s*domain=[^;]*/i, ""));
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
