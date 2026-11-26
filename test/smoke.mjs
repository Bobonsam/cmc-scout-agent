// Smoke test — calls every tool handler live against the keyless CMC API
// (no key needed) and checks the response shapes. Run: `npm test`.
// Writes one real example response to examples/ for the submission.
import { writeFileSync, mkdirSync } from "node:fs";
import { toolHandlers } from "../src/mcp-server.js";
import { checkOnce } from "../src/alert-agent.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
  console.log(`  ok — ${msg}`);
};

const quote = await toolHandlers.coin_quote({ symbols: "BTC,ETH" });
assert(quote.coins.length === 2, "coin_quote returns BTC + ETH");
assert(typeof quote.coins[0].price_usd === "number" && quote.coins[0].price_usd > 0, `BTC price is a positive number ($${quote.coins[0].price_usd})`);
assert(quote.mode === "keyless", "client runs in keyless mode without a key");

const movers = await toolHandlers.top_movers({ limit: 3, direction: "gainers" });
assert(movers.coins.length === 3, "top_movers returns 3 gainers");
assert(movers.coins[0].change_24h_pct >= movers.coins[1].change_24h_pct, "gainers sorted desc by 24h change");

const fresh = await toolHandlers.new_listings({ limit: 3 });
assert(fresh.coins.length === 3, "new_listings returns 3 coins");
assert(fresh.source.includes("date_added"), `new_listings flags the keyless stand-in source (${fresh.source})`);

const mood = await toolHandlers.market_mood({});
assert(typeof mood.fear_and_greed.value === "number", `market_mood has Fear & Greed value (${mood.fear_and_greed.value} = ${mood.fear_and_greed.classification})`);
assert(typeof mood.btc_dominance_pct === "number", "market_mood has BTC dominance");

// DEX: discover a real pool address from search instead of hardcoding one.
import { CmcClient } from "../src/cmc-client.js";
const client = new CmcClient();
const search = await client.dexSearch("WBNB");
const first = Array.isArray(search) ? search[0] : search?.results?.[0] ?? search?.data?.[0];
console.log("  dex search sample:", JSON.stringify(first)?.slice(0, 300));

const alert = await checkOnce();
assert(typeof alert.fearGreed === "number", "alert agent pass runs");

mkdirSync(new URL("../examples", import.meta.url), { recursive: true });
writeFileSync(new URL("../examples/market-mood-live.json", import.meta.url), JSON.stringify(mood, null, 2) + "\n");
writeFileSync(new URL("../examples/coin-quote-live.json", import.meta.url), JSON.stringify(quote, null, 2) + "\n");
console.log("\nSMOKE OK — examples written to examples/ (real keyless responses, no key inside)");
