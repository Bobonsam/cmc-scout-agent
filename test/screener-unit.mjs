// Offline unit checks for the deterministic NL parser and risk formula.
// Run: node test/screener-unit.mjs (no network, no CMC credits used).
import assert from "node:assert/strict";
import { calculateRiskScore, naturalLanguageScreen, parseScreeningQuery } from "../src/screener.js";

const parsed = parseScreeningQuery("find mid-cap DeFi tokens with rising volume");
assert.equal(parsed.filters.market_cap_min_usd, 100_000_000);
assert.equal(parsed.filters.market_cap_max_usd, 10_000_000_000);
assert.equal(parsed.filters.volume_change_24h_min_pct, 0);
assert.equal(parsed.filters.categories[0].label, "DeFi");
assert.equal(parsed.api_query.sort, "volume_24h");

const quote = {
  price: 2,
  market_cap: 500_000_000,
  fully_diluted_market_cap: 750_000_000,
  volume_24h: 50_000_000,
  volume_change_24h: 12,
  percent_change_1h: 0.2,
  percent_change_24h: 1,
  percent_change_7d: 2,
  percent_change_30d: 3,
};
const raw = {
  id: 999999,
  name: "Fixture DeFi",
  symbol: "FIX",
  slug: "fixture-defi",
  cmc_rank: 120,
  date_added: "2022-01-01T00:00:00.000Z",
  tags: ["defi"],
  platform: { name: "Ethereum", symbol: "ETH", slug: "ethereum", token_address: "0x0000000000000000000000000000000000000000" },
  num_market_pairs: 250,
  circulating_supply: 250_000_000,
  total_supply: 375_000_000,
  max_supply: 375_000_000,
  quote: [{ symbol: "USD", ...quote }],
};
const risk = calculateRiskScore(raw);
assert.ok(risk.risk_score >= 0 && risk.risk_score <= 100);
assert.equal(risk.components.length, 6);
assert.equal(risk.confidence_pct, 100);

const fakeClient = {
  mode: "unit-test",
  lastCreditCount: 0,
  async listingsLatest({ start, limit }) {
    return start === 1 ? [raw].slice(0, limit) : [];
  },
};
const screened = await naturalLanguageScreen(fakeClient, { query: "find mid-cap DeFi tokens with rising volume", limit: 5, scan_limit: 100 });
assert.equal(screened.candidate_count, 1);
assert.equal(screened.results[0].symbol, "FIX");
assert.ok(screened.results[0].explanation.length >= 3);

console.log("SCREENER UNIT OK — parser, formula, filtering and explanation all pass offline");
