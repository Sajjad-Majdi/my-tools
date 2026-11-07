import { loadConfig, makeClient } from "../src/tg.mjs";
import tg from "telegram";
const cfg = loadConfig();
const c = makeClient(cfg, "", { apiId: 1, apiHash: "00000000000000000000000000000000" });
const t0 = Date.now();
try {
  await c.connect();
  console.log("connected (auth key made) in", Date.now() - t0, "ms; dc", c.session.dcId, c.session.serverAddress);
  const t1 = Date.now();
  try { const r = await c.invoke(new tg.Api.help.GetNearestDc()); console.log("nearestDc", r.country, r.thisDc, r.nearestDc, Date.now()-t1, "ms"); }
  catch (e) { console.log("rpc answer:", e.errorMessage || e.message, Date.now()-t1, "ms"); }
} catch (e) { console.log("FAIL", e.message || e); }
await c.destroy().catch(()=>{});
process.exit(0);
