// Live end-to-end feature evidence — run manually, not as part of npm test,
// to keep CMC call usage deliberate and modest.
// Run: npm run test:features
// Calls: 2 listings pages for the screener + 1 quotes call for risk scores.
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { toolHandlers } from "../src/mcp-server.js";

const query = "find mid-cap DeFi tokens with rising volume";
const screened = await toolHandlers.natural_language_screener({ query, limit: 5, scan_limit: 200 });
assert.equal(screened.parsed_filters.market_cap_min_usd, 100_000_000);
assert.equal(screened.parsed_filters.market_cap_max_usd, 10_000_000_000);
assert.ok(screened.scanned_count > 0, "screener scanned live CMC listings");
assert.ok(screened.candidate_count > 0, "screener found at least one live candidate for the evidence query");
assert.ok(screened.results[0].explanation.length >= 3, "first screener result is explained");

const risk = await toolHandlers.risk_score({ symbols: "BTC,ETH" });
assert.equal(risk.results.length, 2, "risk_score returns BTC and ETH");
for (const result of risk.results) {
  assert.ok(result.risk_score >= 0 && result.risk_score <= 100, `${result.symbol} score is in range`);
  assert.equal(result.components.length, 6, `${result.symbol} has all six traceable components`);
}

mkdirSync(new URL("../examples", import.meta.url), { recursive: true });
writeFileSync(new URL("../examples/nl-screener-live.json", import.meta.url), JSON.stringify({ input: { query, limit: 5, scan_limit: 200 }, output: screened }, null, 2) + "\n");
writeFileSync(new URL("../examples/risk-score-live.json", import.meta.url), JSON.stringify({ input: { symbols: "BTC,ETH" }, output: risk }, null, 2) + "\n");

console.log(`FEATURES LIVE OK — screener candidates: ${screened.candidate_count}; risk: ${risk.results.map((r) => `${r.symbol}=${r.risk_score}`).join(", ")}; mode=${screened.mode}`);
console.log("Evidence written to examples/nl-screener-live.json and examples/risk-score-live.json");
