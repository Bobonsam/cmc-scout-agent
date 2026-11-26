// CMC Scout Agent — scheduled alert agent (agent-written, 23 Nov 2026).
// One pass: Fear & Greed + top movers; prints formatted alerts to stdout
// and optionally appends them to ALERT_OUTPUT_FILE. Run: `npm run alert`.
// Loop interval from env ALERT_INTERVAL_MINUTES (default 15; 0 = once).
// Uses the same CmcClient as the MCP server, so keyless prototype works
// with no key and the keyed campaign key drops in via CMC_API_KEY.

import { appendFileSync } from "node:fs";
import { CmcClient } from "./cmc-client.js";
import { toolHandlers } from "./mcp-server.js";

const client = new CmcClient();
const INTERVAL_MIN = Number(process.env.ALERT_INTERVAL_MINUTES || 15);
const OUT_FILE = process.env.ALERT_OUTPUT_FILE || "";
// Junk microcaps (+50000% on $0 mcap) are noise, not signals — only alert
// on coins with real market cap. Override with env MIN_MCAP_USD.
const MIN_MCAP_USD = Number(process.env.MIN_MCAP_USD || 1_000_000);

function emit(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  if (OUT_FILE) {
    try {
      appendFileSync(OUT_FILE, stamped + "\n");
    } catch (e) {
      console.error(`alert: cannot write ${OUT_FILE}: ${e.message}`);
    }
  }
}

export async function checkOnce() {
  const mood = await toolHandlers.market_mood({});
  const fg = mood.fear_and_greed;
  emit(`MARKET MOOD — Fear & Greed ${fg.value} (${fg.classification}); BTC dominance ${mood.btc_dominance_pct?.toFixed(1)}%; total mcap $${Number(mood.total_market_cap_usd).toLocaleString("en-US")}`);
  if (fg.value <= 10) emit(`ALERT — Extreme fear (${fg.value}). Historically a contrarian watch zone, not a buy signal.`);
  if (fg.value >= 90) emit(`ALERT — Extreme greed (${fg.value}). Watch for overheating.`);
  const movers = await toolHandlers.top_movers({ limit: 5, direction: "gainers" });
  for (const c of movers.coins) {
    if ((c.change_24h_pct ?? 0) >= 50 && (c.market_cap_usd ?? 0) >= MIN_MCAP_USD) {
      emit(`ALERT — ${c.symbol} +${c.change_24h_pct.toFixed(1)}% in 24h (price $${c.price_usd}, mcap $${Number(c.market_cap_usd).toLocaleString("en-US")})`);
    }
  }
  const losers = await toolHandlers.top_movers({ limit: 5, direction: "losers" });
  for (const c of losers.coins) {
    if ((c.change_24h_pct ?? 0) <= -30 && (c.market_cap_usd ?? 0) >= MIN_MCAP_USD) {
      emit(`ALERT — ${c.symbol} ${c.change_24h_pct.toFixed(1)}% in 24h (price $${c.price_usd})`);
    }
  }
  return { mode: client.mode, fearGreed: fg.value };
}

const isMain = process.argv[1]?.endsWith("alert-agent.js");
if (isMain) {
  console.error(`cmc alert agent starting (mode: ${client.mode}, interval: ${INTERVAL_MIN} min)`);
  await checkOnce();
  if (INTERVAL_MIN > 0) {
    setInterval(() => checkOnce().catch((e) => console.error("alert pass failed:", e.message)), INTERVAL_MIN * 60 * 1000);
  }
}
